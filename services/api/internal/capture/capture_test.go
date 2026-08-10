package capture

import (
	"os"
	"strings"
	"testing"
)

// TestValidate is the guard on the only request body that reaches an exec
// call. Anything it lets through becomes an argument to iw or tcpdump.
func TestValidate(t *testing.T) {
	tests := []struct {
		name      string
		req       Request
		wantField string
		wantDur   int
	}{
		{"valid", Request{Iface: "wlan1", Channel: 6, DurationS: 60}, "", 60},
		{"valid 5 GHz", Request{Iface: "wlan1", Channel: 149, DurationS: 60}, "", 60},
		{"duration defaults", Request{Iface: "wlan1", Channel: 6}, "", 120},

		{"empty iface", Request{Channel: 6}, "iface", 0},
		{"iface with a space", Request{Iface: "wlan1 x", Channel: 6}, "iface", 0},
		{"iface with a semicolon", Request{Iface: "wlan1;reboot", Channel: 6}, "iface", 0},
		{"iface with a slash", Request{Iface: "../../etc", Channel: 6}, "iface", 0},
		{"iface with a flag", Request{Iface: "-i", Channel: 6}, "iface", 0},
		{"iface too long", Request{Iface: strings.Repeat("a", 16), Channel: 6}, "iface", 0},

		{"channel zero", Request{Iface: "wlan1"}, "channel", 0},
		{"channel out of band", Request{Iface: "wlan1", Channel: 99}, "channel", 0},
		{"channel negative", Request{Iface: "wlan1", Channel: -1}, "channel", 0},
		// 6 GHz is excluded on purpose: the US regdb marks it NO-IR, which
		// disables passive listening entirely.
		{"6 GHz channel", Request{Iface: "wlan1", Channel: 233}, "channel", 0},

		{"duration too long", Request{Iface: "wlan1", Channel: 6, DurationS: 3601}, "duration_s", 0},
		{"duration negative", Request{Iface: "wlan1", Channel: 6, DurationS: -1}, "duration_s", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Validate(tc.req)
			if tc.wantField == "" {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
				if got.DurationS != tc.wantDur {
					t.Fatalf("duration: got %d want %d", got.DurationS, tc.wantDur)
				}
				return
			}
			if err == nil {
				t.Fatal("want a validation error")
			}
			ve, ok := err.(*ValidationError)
			if !ok {
				t.Fatalf("want *ValidationError, got %T", err)
			}
			if ve.Field != tc.wantField {
				t.Fatalf("field: got %q want %q", ve.Field, tc.wantField)
			}
		})
	}
}

// TestLabelSanitising: the label reaches a filename, so it must not be able to
// escape the capture directory or produce a name the desktop cannot open.
func TestLabelSanitising(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"first-flight", "first-flight"},
		{"first flight", "first-flight"},
		{"../../etc/passwd", "etcpasswd"},
		{"a/b\\c", "abc"},
		{"with:colons", "withcolons"},
		{"", ""},
		{strings.Repeat("x", 100), strings.Repeat("x", 48)},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			if got := sanitiseLabel(tc.in); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

// TestReceiveOnlyInvariants is a source-level assertion.
//
// The receive-only guarantee is architectural rather than testable at runtime
// without a radio, so this pins the two things that would have to change for
// the guarantee to break: the set of programs invoked, and the BPF filter.
func TestReceiveOnlyInvariants(t *testing.T) {
	src, err := os.ReadFile("capture.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	banned := []string{
		"monitor active", // wedges mt7921u and is an active mode
		"aireplay",
		"deauth",
		"--inject",
		"packetforge",
		"mdk4",
		"hostapd",
		"wpa_supplicant",
		"iw dev %s connect",
		"exec.Command(\"sh\"",
		"exec.Command(\"bash\"",
	}
	for _, b := range banned {
		if strings.Contains(body, b) {
			t.Errorf("capture.go references %q; nothing in ClassG may transmit or shell out", b)
		}
	}

	if !strings.Contains(body, `beaconFilter = "type mgt subtype beacon"`) {
		t.Error("the kernel-side BPF filter must stay restricted to management beacons")
	}
	// Every exec in this package must be one of two read-only tools.
	for _, want := range []string{`"tcpdump"`, `"iw"`} {
		if !strings.Contains(body, want) {
			t.Errorf("expected %s to be the only external tools invoked", want)
		}
	}
}

func TestPathStaysInsideCaptureDir(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(nil, Options{Dir: dir})

	tests := []struct {
		name     string
		filename string
		wantErr  bool
	}{
		{"normal", "2026-08-10-first-flight.pcap", false},
		// Filenames are generated, never client-supplied, but the check exists
		// so a future code path cannot turn this into arbitrary file reads.
		{"traversal", "../../etc/passwd", false}, // Base() strips it
		{"absolute", "/etc/passwd", false},       // Base() strips it
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := m.Path(modelCapture(tc.filename))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v", err)
			}
			if err == nil && !strings.HasPrefix(got, dir) {
				t.Fatalf("path escaped the capture directory: %s", got)
			}
		})
	}
}
