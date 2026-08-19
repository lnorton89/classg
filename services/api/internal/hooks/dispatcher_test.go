package hooks

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type memStore struct {
	mu         sync.Mutex
	rules      []Rule
	deliveries []Delivery
}

func (m *memStore) ListHookRules(context.Context) ([]Rule, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Rule(nil), m.rules...), nil
}

func (m *memStore) PutHookRule(_ context.Context, r Rule) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.rules {
		if m.rules[i].RuleID == r.RuleID {
			m.rules[i] = r
			return nil
		}
	}
	m.rules = append(m.rules, r)
	return nil
}

func (m *memStore) MarkHookRuleFired(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.rules {
		if m.rules[i].RuleID == id {
			m.rules[i].FireCount++
			t := at
			m.rules[i].LastFiredAt = &t
			return nil
		}
	}
	return errors.New("no such rule")
}

func (m *memStore) PutHookDelivery(_ context.Context, d Delivery) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deliveries = append(m.deliveries, d)
	return nil
}

func (m *memStore) delivered() []Delivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Delivery
	for _, d := range m.deliveries {
		if d.Status == DeliveryDelivered {
			out = append(out, d)
		}
	}
	return out
}

func (m *memStore) byStatus(status string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, d := range m.deliveries {
		if d.Status == status {
			n++
		}
	}
	return n
}

var base = time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

// testClock is readable from dispatch workers while the test advances it.
// A bare time.Time variable races, which is the same contract Dispatcher.Now
// documents for real callers.
type testClock struct{ nanos atomic.Int64 }

func newClock(t time.Time) *testClock {
	c := &testClock{}
	c.set(t)
	return c
}
func (c *testClock) set(t time.Time) { c.nanos.Store(t.UnixNano()) }
func (c *testClock) now() time.Time  { return time.Unix(0, c.nanos.Load()).UTC() }
func (c *testClock) advance(d time.Duration) {
	c.nanos.Add(int64(d))
}

func newDispatcher(t *testing.T, store *memStore, clock *testClock) (*Dispatcher, context.CancelFunc) {
	t.Helper()
	// atomic, not a bare counter: NewID is called from every dispatch worker.
	var n atomic.Int64
	d := &Dispatcher{
		Store: store,
		// AllowPrivate: the test server is on 127.0.0.1, which the SSRF guard
		// blocks by design. The guard itself is tested separately.
		Webhook:  Webhook{AllowPrivate: true},
		Now:      clock.now,
		NewID:    func() string { return fmt.Sprintf("d%d", n.Add(1)) },
		Attempts: 2,
	}
	ctx, cancel := context.WithCancel(context.Background())
	go d.Run(ctx)
	return d, cancel
}

func webhookRule(url string) Rule {
	return Rule{
		RuleID: "r1", Name: "test rule", Enabled: true,
		Event: EventTrackConfirmed, Action: ActionWebhook,
		Config: map[string]any{"url": url}, CooldownS: 300,
	}
}

func trackEvent(subject string, at time.Time) Event {
	return Event{
		Name: EventTrackConfirmed, Subject: subject, At: at,
		Payload:    map[string]any{"track_id": subject},
		Confidence: 0.9, IsDrone: true,
	}
}

// waitFor polls, because delivery is deliberately asynchronous.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAMatchingEventReachesTheWebhook(t *testing.T) {
	var got struct {
		sync.Mutex
		bodies []string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		got.Lock()
		got.bodies = append(got.bodies, string(buf))
		got.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))

	waitFor(t, "the webhook to be called", func() bool {
		got.Lock()
		defer got.Unlock()
		return len(got.bodies) == 1
	})
	waitFor(t, "the delivery to be recorded", func() bool { return len(store.delivered()) == 1 })

	del := store.delivered()[0]
	if del.ResponseCode != 200 || del.Attempts != 1 {
		t.Fatalf("delivery %+v", del)
	}
}

// The behaviour that separates an alerting system from a nuisance: one aircraft
// is one alert, and a DIFFERENT aircraft is not suppressed by it.
func TestCooldownIsPerSubjectNotPerRule(t *testing.T) {
	var calls struct {
		sync.Mutex
		n int
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Lock()
		calls.n++
		calls.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	// The same aircraft, seen twenty times in two seconds.
	for i := 0; i < 20; i++ {
		d.Fire(trackEvent("track-1", base))
	}
	waitFor(t, "the first alert", func() bool {
		calls.Lock()
		defer calls.Unlock()
		return calls.n >= 1
	})
	waitFor(t, "the rest to be suppressed", func() bool {
		return store.byStatus(DeliverySuppressed) == 19
	})

	calls.Lock()
	n := calls.n
	calls.Unlock()
	if n != 1 {
		t.Fatalf("one aircraft produced %d alerts, want 1", n)
	}

	// A different aircraft, immediately. Must NOT be suppressed -- going silent
	// for the second drone is the failure that matters.
	d.Fire(trackEvent("track-2", base))
	waitFor(t, "the second aircraft to alert", func() bool {
		calls.Lock()
		defer calls.Unlock()
		return calls.n == 2
	})
}

// After the cooldown, the same aircraft alerts again.
func TestCooldownExpires(t *testing.T) {
	var calls struct {
		sync.Mutex
		n int
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Lock()
		calls.n++
		calls.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the first alert", func() bool {
		calls.Lock()
		defer calls.Unlock()
		return calls.n == 1
	})

	clock.advance(6 * time.Minute) // cooldown is 5
	d.Fire(trackEvent("track-1", clock.now()))
	waitFor(t, "the alert to repeat after the cooldown", func() bool {
		calls.Lock()
		defer calls.Unlock()
		return calls.n == 2
	})
}

// The contract with ingest: Fire never blocks. Detections come off a socket
// with a high-water mark, and a slow webhook must not become backpressure on
// the thing that sees drones.
func TestFireNeverBlocks(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-block
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(block)

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	done := make(chan struct{})
	go func() {
		// Far more than the queue holds, against a target that never answers.
		for i := 0; i < queueDepth*4; i++ {
			d.Fire(trackEvent(fmt.Sprintf("track-%d", i), base))
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Fire blocked; a slow webhook is backpressuring detection ingest")
	}

	// And the overflow was counted rather than silently lost.
	if d.Dropped() == 0 {
		t.Fatal("the queue overflowed but Dropped() is zero -- a silent drop in an alerting system looks exactly like nothing happening")
	}
}

func TestConditionsNarrowWhatFires(t *testing.T) {
	cases := []struct {
		name string
		rule Rule
		ev   Event
		want bool
	}{
		{
			name: "confidence below the floor",
			rule: Rule{Enabled: true, Event: EventTrackConfirmed, MinConfidence: 0.8},
			ev:   Event{Name: EventTrackConfirmed, Confidence: 0.5},
			want: false,
		},
		{
			name: "confidence at the floor",
			rule: Rule{Enabled: true, Event: EventTrackConfirmed, MinConfidence: 0.8},
			ev:   Event{Name: EventTrackConfirmed, Confidence: 0.8},
			want: true,
		},
		{
			name: "manned traffic excluded",
			rule: Rule{Enabled: true, Event: EventTrackConfirmed, OnlyDrones: true},
			ev:   Event{Name: EventTrackConfirmed, IsDrone: false},
			want: false,
		},
		{
			name: "wrong class",
			rule: Rule{Enabled: true, Event: EventDetection, Classes: []string{"A", "B"}},
			ev:   Event{Name: EventDetection, Class: "D"},
			want: false,
		},
		{
			name: "right class",
			rule: Rule{Enabled: true, Event: EventDetection, Classes: []string{"A", "B"}},
			ev:   Event{Name: EventDetection, Class: "B"},
			want: true,
		},
		{
			name: "wrong sensor",
			rule: Rule{Enabled: true, Event: EventDetection, SensorKinds: []string{"wifi"}},
			ev:   Event{Name: EventDetection, SensorKind: "sdr"},
			want: false,
		},
		{
			name: "disabled rule never matches",
			rule: Rule{Enabled: false, Event: EventTrackConfirmed},
			ev:   Event{Name: EventTrackConfirmed},
			want: false,
		},
		{
			name: "different event",
			rule: Rule{Enabled: true, Event: EventTrackConfirmed},
			ev:   Event{Name: EventTrackClosed},
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.rule.Matches(c.ev); got != c.want {
				t.Fatalf("Matches = %v, want %v", got, c.want)
			}
		})
	}
}

// A 5xx is worth retrying; a 4xx is the target saying the request is wrong, and
// retrying an unchanged request against it is pure noise.
func TestRetriesOn5xxButNotOn4xx(t *testing.T) {
	var hits struct {
		sync.Mutex
		n int
	}
	code := http.StatusInternalServerError
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Lock()
		hits.n++
		hits.Unlock()
		w.WriteHeader(code)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the retries to finish", func() bool { return store.byStatus(DeliveryFailed) == 1 })

	hits.Lock()
	got5xx := hits.n
	hits.n = 0
	hits.Unlock()
	if got5xx != 2 { // Attempts: 2
		t.Fatalf("a 500 was attempted %d times, want 2", got5xx)
	}

	code = http.StatusBadRequest
	d.Fire(trackEvent("track-2", base))
	waitFor(t, "the 4xx to be recorded", func() bool { return store.byStatus(DeliveryFailed) == 2 })

	hits.Lock()
	got4xx := hits.n
	hits.Unlock()
	if got4xx != 1 {
		t.Fatalf("a 400 was attempted %d times, want 1 -- retrying an unchanged request is noise", got4xx)
	}
}

// A rule that has never fired is usually a rule whose conditions match nothing,
// and that is invisible until someone needs the alert.
func TestFiringIsRecordedOnTheRule(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the rule to be updated", func() bool {
		rules, _ := store.ListHookRules(context.Background())
		return len(rules) > 0 && rules[0].FireCount == 1
	})

	rules, _ := store.ListHookRules(context.Background())
	if rules[0].LastFiredAt == nil || !rules[0].LastFiredAt.Equal(base) {
		t.Fatalf("LastFiredAt = %v", rules[0].LastFiredAt)
	}
}

// The SSRF guard. An admin who can point a hook at the metadata service can
// read it through this box, and "only admins configure hooks" is not an answer.
func TestWebhookRefusesInternalTargets(t *testing.T) {
	w := Webhook{}
	for _, raw := range []string{
		"http://127.0.0.1:8081/api/v1/admin/users",
		"http://localhost/",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://[::1]/",
		"http://0.0.0.0/",
	} {
		if err := w.Validate(Rule{Config: map[string]any{"url": raw}}); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}

	// Non-HTTP schemes, which would otherwise reach file:// and gopher://.
	for _, raw := range []string{"file:///etc/passwd", "gopher://x/", "ftp://x/", ""} {
		if err := w.Validate(Rule{Config: map[string]any{"url": raw}}); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}

	// And the escape hatch works, for a genuinely local Home Assistant.
	allow := Webhook{AllowPrivate: true}
	if err := allow.Validate(Rule{Config: map[string]any{"url": "http://192.168.1.50/api/webhook/x"}}); err != nil {
		t.Errorf("AllowPrivate did not allow a LAN target: %v", err)
	}
}

// Secrets are write-only. An admin can set a token and cannot read it back.
func TestSecretsAreStrippedOnRead(t *testing.T) {
	r := Rule{Config: map[string]any{
		"url":           "https://example.com/hook",
		"authorization": "Bearer super-secret-value",
		"password":      "hunter2",
	}}
	clean := r.Redacted()

	if got := clean.Config["authorization"]; got == "Bearer super-secret-value" {
		t.Fatal("the authorization header came back in full")
	}
	if got := clean.Config["password"]; got == "hunter2" {
		t.Fatal("the password came back in full")
	}
	// Present-but-hidden, so the UI can tell a configured hook from an
	// unconfigured one.
	if clean.Config["authorization"] == nil {
		t.Fatal("the field vanished; the UI cannot show that a token is set")
	}
	if clean.Config["url"] != "https://example.com/hook" {
		t.Fatal("a non-secret field was redacted")
	}
	// The original is untouched, or the dispatcher would send "••••••••".
	if r.Config["authorization"] != "Bearer super-secret-value" {
		t.Fatal("Redacted mutated the original rule")
	}
}

// A CRLF in an admin-supplied subject would let whoever wrote the rule add
// Bcc: to every alert this box ever sends.
func TestEmailSubjectCannotInjectHeaders(t *testing.T) {
	got := sanitiseHeader("Alert\r\nBcc: attacker@example.com")
	if got == "Alert\r\nBcc: attacker@example.com" {
		t.Fatal("CRLF survived")
	}
	for _, r := range got {
		if r == '\r' || r == '\n' {
			t.Fatalf("a newline survived in %q", got)
		}
	}
}

func TestValidateRejectsBadRules(t *testing.T) {
	for _, c := range []struct {
		name string
		rule Rule
	}{
		{"no name", Rule{Event: EventTrackConfirmed, Action: ActionWebhook}},
		{"unknown event", Rule{Name: "x", Event: "drone.landed", Action: ActionWebhook}},
		{"unknown action", Rule{Name: "x", Event: EventTrackConfirmed, Action: "carrier-pigeon"}},
		{"confidence out of range", Rule{Name: "x", Event: EventTrackConfirmed, Action: ActionWebhook, MinConfidence: 1.5}},
		{"negative cooldown", Rule{Name: "x", Event: EventTrackConfirmed, Action: ActionWebhook, CooldownS: -1}},
		{"bad class", Rule{Name: "x", Event: EventDetection, Action: ActionWebhook, Classes: []string{"Z"}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := c.rule
			if err := r.Validate(); err == nil {
				t.Fatal("accepted an invalid rule")
			}
		})
	}

	// Zero cooldown becomes the default rather than "no cooldown". A rule with
	// no cooldown on a per-detection event sends thousands of messages, and
	// nobody means that.
	r := Rule{Name: "x", Event: EventDetection, Action: ActionWebhook, CooldownS: 0}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	if r.CooldownS != DefaultCooldownS {
		t.Fatalf("cooldown defaulted to %d, want %d", r.CooldownS, DefaultCooldownS)
	}
}

func TestUnknownActionIsRecordedNotPanicked(t *testing.T) {
	store := &memStore{rules: []Rule{{
		RuleID: "r1", Name: "broken", Enabled: true,
		Event: EventTrackConfirmed, Action: "carrier-pigeon", CooldownS: 60,
	}}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the failure to be recorded", func() bool { return store.byStatus(DeliveryFailed) == 1 })
}

func TestSMTPValidationRefusesJunk(t *testing.T) {
	s := SMTP{Host: "smtp.example.com", From: "classg@example.com"}
	if err := s.Validate(Rule{Config: map[string]any{"to": "not-an-address"}}); err == nil {
		t.Error("accepted a malformed recipient")
	}
	if err := s.Validate(Rule{Config: map[string]any{}}); err == nil {
		t.Error("accepted a rule with no recipient")
	}
	if err := s.Validate(Rule{Config: map[string]any{"to": "a@example.com, b@example.com"}}); err != nil {
		t.Errorf("rejected a valid recipient list: %v", err)
	}

	// An unconfigured server says so rather than failing at send time.
	var unset SMTP
	err := unset.Validate(Rule{Config: map[string]any{"to": "a@example.com"}})
	if err == nil || !errors.Is(err, ErrBadConfig) {
		t.Errorf("an unconfigured SMTP server accepted a rule: %v", err)
	}
}

// A webhook that was down for the ~14 s the retries took must not buy itself
// the full cooldown of silence: the failure releases the slot, and the next
// event for the same subject alerts as soon as the target recovers.
func TestFailedDeliveryDoesNotArmTheCooldown(t *testing.T) {
	var healthy atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if healthy.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the delivery to fail", func() bool { return store.byStatus(DeliveryFailed) == 1 })

	// The target recovers. Well inside the 300 s cooldown, the same subject
	// fires again -- and must be DELIVERED, not suppressed.
	healthy.Store(true)
	clock.advance(30 * time.Second)
	d.Fire(trackEvent("track-1", clock.now()))
	waitFor(t, "the retry after recovery to deliver", func() bool { return len(store.delivered()) == 1 })
	if got := store.byStatus(DeliverySuppressed); got != 0 {
		t.Fatalf("%d events were suppressed behind a FAILED delivery", got)
	}
}

// Events Fire already accepted are delivered during shutdown rather than
// dropped on the floor -- a drop at exactly the moment of a restart is the
// silent-failure shape this package exists to avoid.
func TestQueuedAlertsAreDrainedAtShutdown(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	var n atomic.Int64
	d := &Dispatcher{
		Store:    store,
		Webhook:  Webhook{AllowPrivate: true},
		Now:      newClock(base).now,
		NewID:    func() string { return fmt.Sprintf("d%d", n.Add(1)) },
		Attempts: 1,
	}
	d.init()
	// Queue directly, then run with an already-cancelled context: everything
	// must flow through the drain path, not the workers.
	d.queue <- trackEvent("track-1", base)
	d.queue <- trackEvent("track-2", base)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan struct{})
	go func() { d.Run(ctx); close(done) }()

	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("Run did not return; the drain deadline is not working")
	}
	if calls.Load() != 2 {
		t.Fatalf("drain delivered %d of 2 queued alerts", calls.Load())
	}
}

// The rule cache must not outlive an admin edit: InvalidateRules makes the
// next event see the change immediately rather than after rulesTTL.
func TestInvalidateRulesTakesEffectImmediately(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	store := &memStore{rules: []Rule{webhookRule(srv.URL)}}
	clock := newClock(base)
	d, cancel := newDispatcher(t, store, clock)
	defer cancel()

	d.Fire(trackEvent("track-1", base))
	waitFor(t, "the first alert", func() bool { return calls.Load() == 1 })

	// The admin disables the rule. Without invalidation the cached copy would
	// keep firing for up to rulesTTL.
	store.mu.Lock()
	store.rules[0].Enabled = false
	store.mu.Unlock()
	d.InvalidateRules()

	d.Fire(trackEvent("track-2", base))
	// Deliveries are asynchronous, so "nothing happened" needs a moment to be
	// observable rather than merely unobserved.
	time.Sleep(150 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("a disabled rule fired %d extra times through a stale cache", calls.Load()-1)
	}
}

// The transport really dials the vetted address: a URL whose hostname cannot
// resolve at all still reaches the server the pin points at. This is the
// mechanism that closes the DNS-rebinding gap -- what is dialled is what was
// checked, whatever the zone answers the second time.
func TestPinnedClientDialsTheVettedIP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}

	client := Webhook{}.pinnedClient(net.ParseIP("127.0.0.1"))
	resp, err := client.Get("http://pinned-target.invalid:" + u.Port() + "/")
	if err != nil {
		t.Fatalf("pinned dial failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}
