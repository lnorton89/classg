package hooks

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Store is the persistence hooks need.
//
// Method names match internal/store's rather than being shortened, so the
// application's Store satisfies this without an adapter -- the alternative was
// a wrapper type whose only job was renaming three methods.
type Store interface {
	ListHookRules(ctx context.Context) ([]Rule, error)
	// MarkHookRuleFired bumps fire_count and stamps last_fired_at as a
	// targeted update, not a document rewrite. Dispatch workers call it
	// concurrently with each other and with admin edits; writing back a whole
	// rule read at handle time lost increments and clobbered edits.
	MarkHookRuleFired(ctx context.Context, ruleID string, at time.Time) error
	PutHookDelivery(ctx context.Context, d Delivery) error
}

// Dispatcher turns events into deliveries.
//
// The contract with the rest of the system is one sentence: Fire never blocks
// and never fails. Detections arrive off a ZMQ socket with a high-water mark,
// and an SMTP server taking thirty seconds to answer must not become
// backpressure on the thing that sees drones.
type Dispatcher struct {
	Store   Store
	Webhook Webhook
	SMTP    SMTP
	// Now is injected so tests do not sleep through cooldowns. Same
	// concurrency requirement as NewID: dispatch workers call it, so an
	// injected clock must be safe to read while the test advances it.
	Now func() time.Time
	// NewID mints delivery ids. Called from several dispatch goroutines at
	// once, so an injected implementation must be safe for concurrent use --
	// the default is, and a naive counter in a test is not.
	NewID func() string

	// Attempts is how many times a failed delivery is retried. Retries are
	// bounded and short: an alert delivered twenty minutes late is not an
	// alert, so this gives up and records the failure rather than queueing
	// forever.
	Attempts int

	queue chan Event
	// cooldown keys on (ruleID, subject) rather than ruleID alone. One aircraft
	// generates detections several times a second; keying on the rule would
	// either flood on the first drone or go silent for the second, and going
	// silent for the second is the failure that matters.
	mu       sync.Mutex
	cooldown map[string]time.Time

	// rules caches the rule list. handle() runs for every event -- several a
	// second during a busy pass -- and re-reading meant a SELECT plus a JSON
	// decode of every rule per event on the single shared connection, for a
	// list that changes only when an admin edits it. Invalidated by the admin
	// write path (InvalidateRules) and refreshed on a short TTL as
	// belt-and-braces against a missed invalidation.
	rulesMu       sync.Mutex
	rules         []Rule
	rulesLoadedAt time.Time

	// Dropped counts events discarded because the queue was full. Exposed on
	// /metrics: a silent drop in an alerting system is the worst possible
	// failure, because it looks exactly like nothing happening.
	dropped uint64

	wg   sync.WaitGroup
	once sync.Once
}

const (
	// queueDepth bounds memory. Sized for a burst of detections during a busy
	// pass, not for an outage: past this the answer is to drop and count.
	queueDepth = 512
	// workers dispatch concurrently. Small: these are network calls to a
	// handful of endpoints, and more would mostly be a way to hammer someone
	// else's webhook.
	workers = 4
	// rulesTTL bounds how stale the cached rule list can get if an
	// invalidation is ever missed. Thirty seconds of a deleted rule still
	// firing is tolerable; per-event re-reads were not.
	rulesTTL = 30 * time.Second
	// drainTimeout bounds how long shutdown spends delivering alerts that were
	// already queued when the context was cancelled.
	drainTimeout = 5 * time.Second
)

func (d *Dispatcher) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *Dispatcher) attempts() int {
	if d.Attempts > 0 {
		return d.Attempts
	}
	return 3
}

// Run starts the workers and blocks until ctx is done, then drains what was
// already queued.
func (d *Dispatcher) Run(ctx context.Context) {
	d.init()
	for i := 0; i < workers; i++ {
		d.wg.Add(1)
		go d.worker(ctx)
	}
	<-ctx.Done()
	d.wg.Wait()
	d.drain()
}

// drain delivers events that Fire had already accepted when shutdown began.
// An alert this system took responsibility for and then dropped because
// systemd got there first is a silent drop -- the failure /metrics exists to
// make loud. The deadline is short: a restart must not hang behind a webhook
// that stopped answering. (One in-flight attempt can still run to its own
// 30 s bound; the deadline stops retries and further events, not the socket.)
func (d *Dispatcher) drain() {
	ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case e := <-d.queue:
			d.handle(ctx, e)
		default:
			return
		}
	}
}

// InvalidateRules drops the cached rule list. The admin write path calls this
// after every create, update or delete so a changed rule takes effect on the
// next event rather than after rulesTTL.
func (d *Dispatcher) InvalidateRules() {
	d.rulesMu.Lock()
	d.rulesLoadedAt = time.Time{}
	d.rulesMu.Unlock()
}

func (d *Dispatcher) loadRules(ctx context.Context) ([]Rule, error) {
	d.rulesMu.Lock()
	defer d.rulesMu.Unlock()
	if !d.rulesLoadedAt.IsZero() && d.now().Sub(d.rulesLoadedAt) < rulesTTL {
		return d.rules, nil
	}
	rules, err := d.Store.ListHookRules(ctx)
	if err != nil {
		return nil, err
	}
	d.rules = rules
	d.rulesLoadedAt = d.now()
	return rules, nil
}

func (d *Dispatcher) init() {
	d.once.Do(func() {
		d.queue = make(chan Event, queueDepth)
		d.cooldown = map[string]time.Time{}
	})
}

// Fire offers an event for dispatch. Never blocks.
//
// A full queue drops and counts, which is ADR-0002's rule applied one layer up:
// the alternative is that a slow webhook becomes backpressure on detection
// ingest, and a detector that stops detecting because an alert was slow has its
// priorities exactly backwards.
func (d *Dispatcher) Fire(e Event) {
	d.init()
	select {
	case d.queue <- e:
	default:
		d.mu.Lock()
		d.dropped++
		n := d.dropped
		d.mu.Unlock()
		// Logged every time, not sampled: this should never happen, and if it
		// is happening the log volume is the least of the problems.
		slog.Warn("hook queue full; event dropped",
			"event", e.Name, "subject", e.Subject, "dropped_total", n)
	}
}

// Dropped is the count for /metrics.
func (d *Dispatcher) Dropped() uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.dropped
}

func (d *Dispatcher) worker(ctx context.Context) {
	defer d.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-d.queue:
			d.handle(ctx, e)
		}
	}
}

func (d *Dispatcher) handle(ctx context.Context, e Event) {
	rules, err := d.loadRules(ctx)
	if err != nil {
		slog.Error("reading hook rules failed", "err", err)
		return
	}
	for _, rule := range rules {
		if !rule.Matches(e) {
			continue
		}
		if d.suppressed(rule, e) {
			// Recorded rather than dropped silently. "Why did I not get an
			// alert" is a question an operator will ask, and this is the
			// answer.
			d.record(ctx, Delivery{
				DeliveryID: d.newID(),
				RuleID:     rule.RuleID,
				RuleName:   rule.Name,
				Event:      e.Name,
				Subject:    e.Subject,
				Status:     DeliverySuppressed,
				CreatedAt:  d.now(),
			})
			continue
		}
		d.deliver(ctx, rule, e)
	}
}

// suppressed reports whether this rule already fired for this subject
// recently, and claims the cooldown slot if not. Claiming here rather than
// after delivery is what stops two workers holding the same subject from
// alerting twice -- but the claim is provisional: a delivery that FAILS
// releases it (see deliver), because three failed attempts against a webhook
// that was down for ~14 s must not buy the full cooldown of silence for a
// drone that is still overhead.
func (d *Dispatcher) suppressed(rule Rule, e Event) bool {
	key := cooldownKey(rule, e)
	now := d.now()

	d.mu.Lock()
	defer d.mu.Unlock()

	if until, ok := d.cooldown[key]; ok && now.Before(until) {
		return true
	}
	d.cooldown[key] = now.Add(time.Duration(rule.CooldownS) * time.Second)

	// Sweep while we hold the lock. Without this the map grows one entry per
	// distinct aircraft forever, which on a box that runs for months is a leak
	// with an obvious shape.
	if len(d.cooldown) > 4096 {
		for k, until := range d.cooldown {
			if now.After(until) {
				delete(d.cooldown, k)
			}
		}
	}
	return false
}

func cooldownKey(rule Rule, e Event) string {
	return rule.RuleID + "\x00" + e.Subject
}

// release gives back the cooldown slot suppressed() claimed. Called only on a
// failed delivery: no re-arm race is possible, because any other event for
// this (rule, subject) was suppressed by the very claim being released.
func (d *Dispatcher) release(rule Rule, e Event) {
	d.mu.Lock()
	delete(d.cooldown, cooldownKey(rule, e))
	d.mu.Unlock()
}

func (d *Dispatcher) deliver(ctx context.Context, rule Rule, e Event) {
	del := Delivery{
		DeliveryID: d.newID(),
		RuleID:     rule.RuleID,
		RuleName:   rule.Name,
		Event:      e.Name,
		Subject:    e.Subject,
		Status:     DeliveryPending,
		CreatedAt:  d.now(),
	}

	var action Action
	switch rule.Action {
	case ActionWebhook:
		action = d.Webhook
	case ActionEmail:
		action = d.SMTP
	default:
		del.Status, del.Error = DeliveryFailed, "unknown action "+rule.Action
		d.record(ctx, del)
		d.release(rule, e)
		return
	}

	var lastErr error
	var code int
	for attempt := 1; attempt <= d.attempts(); attempt++ {
		del.Attempts = attempt

		// Each attempt gets its own bounded context, and it is derived from
		// Background rather than the caller's: an alert that is worth sending
		// is worth finishing even if whatever produced the event has moved on.
		attemptCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		code, lastErr = action.Deliver(attemptCtx, rule, e)
		cancel()

		if lastErr == nil {
			at := d.now()
			del.Status, del.CompletedAt, del.ResponseCode = DeliveryDelivered, &at, code
			d.record(ctx, del)
			d.markFired(ctx, rule, at)
			return
		}
		// A 4xx is the target saying "this request is wrong". Retrying an
		// unchanged request against it is pure noise; 408 and 429 are the two
		// that genuinely mean "try again".
		if code >= 400 && code < 500 && code != 408 && code != 429 {
			break
		}
		if attempt < d.attempts() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff(attempt)):
			}
		}
	}

	at := d.now()
	del.Status, del.CompletedAt, del.ResponseCode = DeliveryFailed, &at, code
	del.Error = lastErr.Error()
	slog.Warn("hook delivery failed",
		"rule", rule.Name, "event", e.Name, "attempts", del.Attempts, "err", lastErr)
	d.record(ctx, del)
	// Failure must not arm the cooldown: a webhook that was down for the ~14 s
	// the retries took used to buy itself the full cooldown of guaranteed
	// silence for this subject -- a transient blip converted into a missed
	// drone. The next event for this subject gets to try again.
	d.release(rule, e)
}

// backoff is 2s, 4s, 8s. Deliberately short: an alert delivered twenty minutes
// late is not an alert, so this gives up and says so rather than retrying into
// irrelevance.
func backoff(attempt int) time.Duration {
	return time.Duration(1<<attempt) * time.Second
}

func (d *Dispatcher) markFired(ctx context.Context, rule Rule, at time.Time) {
	if err := d.Store.MarkHookRuleFired(ctx, rule.RuleID, at); err != nil {
		// Bookkeeping. The alert was delivered; failing loudly here would
		// misreport a success.
		slog.Warn("recording a hook firing failed", "rule", rule.Name, "err", err)
	}
}

func (d *Dispatcher) record(ctx context.Context, del Delivery) {
	if err := d.Store.PutHookDelivery(ctx, del); err != nil {
		slog.Warn("recording a hook delivery failed", "err", err)
	}
}

func (d *Dispatcher) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	return time.Now().UTC().Format("20060102T150405.000000000")
}

// Test delivers one event through a single rule, ignoring cooldown.
//
// This is what the "send a test" button calls. It bypasses the cooldown on
// purpose -- a test that silently did nothing because the rule fired ten
// minutes ago would be worse than no test button.
func (d *Dispatcher) Test(ctx context.Context, rule Rule) (int, error) {
	e := Event{
		Name:    rule.Event,
		Subject: "test",
		At:      d.now(),
		Payload: map[string]any{
			"test": true,
			"note": "This is a test from ClassG. No aircraft was detected.",
		},
	}
	switch rule.Action {
	case ActionWebhook:
		return d.Webhook.Deliver(ctx, rule, e)
	case ActionEmail:
		return d.SMTP.Deliver(ctx, rule, e)
	default:
		return 0, ErrUnknownAction
	}
}

// ValidateRule checks a rule's action config against the configured backends.
func (d *Dispatcher) ValidateRule(rule Rule) error {
	switch rule.Action {
	case ActionWebhook:
		return d.Webhook.Validate(rule)
	case ActionEmail:
		return d.SMTP.Validate(rule)
	default:
		return ErrUnknownAction
	}
}
