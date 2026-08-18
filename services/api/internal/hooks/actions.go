package hooks

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"time"
)

// Action delivers one event.
type Action interface {
	// Deliver returns a response code where one exists (HTTP), or 0.
	Deliver(ctx context.Context, rule Rule, e Event) (int, error)
	// Validate checks a rule's config before it is stored, so a broken hook is
	// rejected at configuration time rather than discovered at 3am when the
	// alert it was meant to send does not arrive.
	Validate(rule Rule) error
}

// --- webhook ---------------------------------------------------------------

// Webhook POSTs JSON.
type Webhook struct {
	Client *http.Client
	// AllowPrivate disables the SSRF guard. Off by default; an operator whose
	// webhook target genuinely is on the LAN (Home Assistant, a local MQTT
	// bridge) turns it on knowingly.
	AllowPrivate bool
}

func (w Webhook) client() *http.Client {
	if w.Client != nil {
		return w.Client
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		// No redirects. A target that 302s to 169.254.169.254 would walk
		// straight past the SSRF check performed on the original URL.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("webhook targets may not redirect")
		},
	}
}

func (w Webhook) Validate(rule Rule) error {
	raw := rule.ConfigString("url")
	if raw == "" {
		return fmt.Errorf("%w: a webhook needs a url", ErrBadConfig)
	}
	return w.checkURL(raw)
}

// checkURL is the SSRF guard.
//
// An admin who can point a hook at http://169.254.169.254/ can read a cloud
// metadata service through this box, and one pointed at 127.0.0.1:8081 can
// drive the API as whatever the API trusts. "Only admins can configure hooks"
// is not an answer -- the whole point of the admin/operator split is that admin
// is a role, not a person who can be assumed careful.
func (w Webhook) checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: %s is not a URL", ErrBadConfig, raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: webhook URLs must be http or https, not %q", ErrBadConfig, u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%w: no host in %s", ErrBadConfig, raw)
	}
	if w.AllowPrivate {
		return nil
	}

	// Resolve rather than pattern-match the string: "localhost", "127.1", and a
	// name whose A record is 10.0.0.1 are all the same problem, and only the
	// first two look like it.
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("%w: cannot resolve %s", ErrBadConfig, host)
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return fmt.Errorf(
				"%w: %s resolves to %s, which is a loopback, link-local or private address. "+
					"Set hooks.allow_private_targets if that is deliberate",
				ErrBadConfig, host, ip)
		}
	}
	return nil
}

func isBlockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsInterfaceLocalMulticast()
}

func (w Webhook) Deliver(ctx context.Context, rule Rule, e Event) (int, error) {
	raw := rule.ConfigString("url")
	if err := w.checkURL(raw); err != nil {
		// Re-checked at delivery, not only at configuration: DNS can change
		// under a name that was public when the rule was written.
		return 0, err
	}

	body, err := MarshalPayload(e, rule)
	if err != nil {
		return 0, fmt.Errorf("building the payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, raw, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "classg-hooks/1")
	// A custom Authorization header, if the target needs one.
	if auth := rule.ConfigString("authorization"); auth != "" {
		req.Header.Set("Authorization", auth)
	}

	resp, err := w.client().Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, nil
	}
	return resp.StatusCode, fmt.Errorf("the target answered %s", resp.Status)
}

// --- email -----------------------------------------------------------------

// SMTP sends mail.
//
// Server credentials are process configuration, not rule configuration. Putting
// them per-rule would mean the same password copied into every rule and
// re-entered on every edit, and a database holding several copies of it.
type SMTP struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	// StartTLS upgrades a plaintext connection. Most submission servers on 587
	// want this; 465 is implicit TLS and does not.
	StartTLS bool
	// Implicit is TLS from the first byte (port 465).
	Implicit bool
}

func (s SMTP) Configured() bool { return s.Host != "" && s.From != "" }

func (s SMTP) Validate(rule Rule) error {
	if !s.Configured() {
		return fmt.Errorf("%w: no SMTP server is configured on this unit (CLASSG_SMTP_HOST)", ErrBadConfig)
	}
	to := rule.ConfigString("to")
	if to == "" {
		return fmt.Errorf("%w: an email action needs a recipient", ErrBadConfig)
	}
	for _, addr := range splitRecipients(to) {
		if _, err := mail.ParseAddress(addr); err != nil {
			return fmt.Errorf("%w: %q is not an email address", ErrBadConfig, addr)
		}
	}
	return nil
}

func splitRecipients(to string) []string {
	parts := strings.FieldsFunc(to, func(r rune) bool { return r == ',' || r == ';' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (s SMTP) Deliver(ctx context.Context, rule Rule, e Event) (int, error) {
	if err := s.Validate(rule); err != nil {
		return 0, err
	}
	recipients := splitRecipients(rule.ConfigString("to"))
	msg := s.compose(rule, e, recipients)

	addr := net.JoinHostPort(s.Host, fmt.Sprint(s.port()))
	// The context bounds dialling; net/smtp itself has no context support, so
	// the deadline is applied to the connection rather than to each command.
	d := net.Dialer{Timeout: 20 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return 0, fmt.Errorf("connecting to %s: %w", addr, err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	if s.Implicit {
		conn = tls.Client(conn, &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12})
	}

	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return 0, err
	}
	defer func() { _ = c.Quit() }()

	if s.StartTLS && !s.Implicit {
		if err := c.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
			return 0, fmt.Errorf("STARTTLS: %w", err)
		}
	}
	if s.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", s.Username, s.Password, s.Host)); err != nil {
			return 0, fmt.Errorf("SMTP auth: %w", err)
		}
	}
	if err := c.Mail(s.From); err != nil {
		return 0, err
	}
	for _, to := range recipients {
		if err := c.Rcpt(to); err != nil {
			return 0, fmt.Errorf("recipient %s: %w", to, err)
		}
	}
	wc, err := c.Data()
	if err != nil {
		return 0, err
	}
	if _, err := wc.Write(msg); err != nil {
		_ = wc.Close()
		return 0, err
	}
	if err := wc.Close(); err != nil {
		return 0, err
	}
	return 0, nil
}

func (s SMTP) port() int {
	if s.Port > 0 {
		return s.Port
	}
	if s.Implicit {
		return 465
	}
	return 587
}

// compose builds the message.
//
// Plain text, deliberately. An alert is read on a phone at an awkward moment,
// often through a notification preview that strips HTML anyway, and a plain
// body cannot render a tracking pixel or a link that is not what it says.
func (s SMTP) compose(rule Rule, e Event, to []string) []byte {
	subject := rule.ConfigString("subject")
	if subject == "" {
		subject = "ClassG: " + e.Name
	}

	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", s.From)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(to, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", sanitiseHeader(subject))
	fmt.Fprintf(&b, "Date: %s\r\n", e.At.UTC().Format(time.RFC1123Z))
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("\r\n")

	fmt.Fprintf(&b, "%s\r\n", e.Name)
	fmt.Fprintf(&b, "at %s\r\n", e.At.UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "rule: %s\r\n\r\n", rule.Name)
	for _, k := range sortedKeys(e.Payload) {
		fmt.Fprintf(&b, "  %s: %v\r\n", k, e.Payload[k])
	}
	b.WriteString("\r\nThis is an energy/identity observation from a passive receiver.\r\n")
	b.WriteString("ClassG never transmits.\r\n")
	return []byte(b.String())
}

// sanitiseHeader stops a newline in a rule's subject from injecting headers.
//
// The subject is admin-supplied, which is not the same as trustworthy: a CRLF
// in it would let whoever wrote the rule add Bcc: to every alert this box ever
// sends.
func sanitiseHeader(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
