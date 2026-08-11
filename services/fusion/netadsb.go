package fusion

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// Network ADS-B: manned traffic from somebody else's receivers.
//
// The SDR gives this unit its own ADS-B, which is strictly better -- it proves
// what this antenna can hear, it works with no uplink, and it has no third
// party in the path. This feed exists for the units that have no SDR fitted,
// and for the terrain shadow every ground-level receiver has. Class D never
// contributes confidence (DefaultWeights pins it at 0.00); it exists to explain
// detections away, and an explanation sourced over the internet suppresses just
// as well as one sourced from an antenna.
//
// It is off by default. A detector that silently phones home is not the same
// product as one that does not, and which one you have should be a decision,
// not a default.

const (
	// api.adsb.lol is community-run and free, with no key. The base URL is
	// configurable because adsb.fi and airplanes.live serve a compatible
	// /v2/point response, and because a re-implementation of this API is the
	// obvious thing to put in front of a fleet of units.
	NetADSBDefaultBaseURL = "https://api.adsb.lol"

	// 10s is a deliberate under-use of what the service permits. Contacts exist
	// to suppress detections over a 60s window (ContactExpireAfter), so a
	// faster poll buys nothing but load on a volunteer-funded service and rows
	// in the API's database.
	NetADSBDefaultInterval = 10 * time.Second

	// Nautical miles, matching the upstream path parameter.
	NetADSBDefaultRadiusNM = 25
	NetADSBMaxRadiusNM     = 250

	NetADSBDefaultSensorID = "net-adsb-0"
	NetADSBDefaultTimeout  = 10 * time.Second

	// A busy approach path can put several hundred aircraft inside 250 nm, and
	// every one becomes a detection that the API stores and the map draws. The
	// cap is a backstop against a misconfigured radius quietly turning the
	// database into an airline tracker; exceeding it is logged, never silent.
	NetADSBDefaultMaxAircraft = 250
)

// NetADSBConfig configures the network ADS-B feed.
type NetADSBConfig struct {
	BaseURL  string
	Lat, Lon float64
	RadiusNM int
	Interval time.Duration
	Timeout  time.Duration
	SensorID string
	// MaxAge drops aircraft whose last position fix is older than this.
	// Defaults to ContactExpireAfter: anything staler is about to be reaped
	// on arrival, so forwarding it is pure churn.
	MaxAge      time.Duration
	MaxAircraft int
}

func (c *NetADSBConfig) applyDefaults() {
	if strings.TrimSpace(c.BaseURL) == "" {
		c.BaseURL = NetADSBDefaultBaseURL
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if c.RadiusNM <= 0 {
		c.RadiusNM = NetADSBDefaultRadiusNM
	}
	if c.Interval <= 0 {
		c.Interval = NetADSBDefaultInterval
	}
	if c.Timeout <= 0 {
		c.Timeout = NetADSBDefaultTimeout
	}
	if strings.TrimSpace(c.SensorID) == "" {
		c.SensorID = NetADSBDefaultSensorID
	}
	if c.MaxAge <= 0 {
		c.MaxAge = ContactExpireAfter
	}
	if c.MaxAircraft <= 0 {
		c.MaxAircraft = NetADSBDefaultMaxAircraft
	}
}

func (c NetADSBConfig) validate() error {
	if c.RadiusNM > NetADSBMaxRadiusNM {
		return fmt.Errorf("radius %d nm exceeds the %d nm maximum", c.RadiusNM, NetADSBMaxRadiusNM)
	}
	if c.Lat < -90 || c.Lat > 90 || c.Lon < -180 || c.Lon > 180 {
		return fmt.Errorf("receiver position %.4f,%.4f is out of range", c.Lat, c.Lon)
	}
	// Same rule the sensors follow for aircraft positions: 0,0 means "not
	// configured", not the Gulf of Guinea. Without this the feed would happily
	// poll for traffic 5000 km from the nearest land and report a quiet sky.
	if c.Lat == 0 && c.Lon == 0 {
		return errors.New("receiver position is unset (0,0); set the latitude and longitude of this unit")
	}
	return nil
}

// NetADSBFeed polls a v2/point ADS-B aggregator and emits Class D detections.
//
// It emits the same wire format a sensor does, on the same topics, so
// everything downstream -- fusion's contact correlation, the API's storage, the
// map -- treats it identically to a radio. The one thing that must stay
// distinguishable is where it came from, which is what sensor_kind "net" is
// for.
type NetADSBFeed struct {
	cfg    NetADSBConfig
	client *http.Client
	now    func() time.Time
	newID  func() string
}

func NewNetADSBFeed(cfg NetADSBConfig) (*NetADSBFeed, error) {
	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &NetADSBFeed{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.Timeout},
		now:    func() time.Time { return time.Now().UTC() },
		newID:  NewULID,
	}, nil
}

func (f *NetADSBFeed) SensorID() string        { return f.cfg.SensorID }
func (f *NetADSBFeed) Interval() time.Duration { return f.cfg.Interval }

func (f *NetADSBFeed) endpoint() string {
	return fmt.Sprintf("%s/v2/point/%g/%g/%d", f.cfg.BaseURL, f.cfg.Lat, f.cfg.Lon, f.cfg.RadiusNM)
}

// netAircraft is the subset of the v2/point response this project uses.
//
// Deliberately partial. The upstream adds fields freely, and decoding into a
// narrow struct means a new one cannot break the feed.
type netAircraft struct {
	Hex      string      `json:"hex"`
	Flight   string      `json:"flight"`
	AltBaro  netAltitude `json:"alt_baro"`
	Lat      *float64    `json:"lat"`
	Lon      *float64    `json:"lon"`
	GroundSp *float64    `json:"gs"`
	Track    *float64    `json:"track"`
	// Seconds since this aircraft was last heard from at all, and since its
	// last position fix. Both are relative to the response, not to us.
	Seen    *float64 `json:"seen"`
	SeenPos *float64 `json:"seen_pos"`
}

type netPointResponse struct {
	Aircraft []netAircraft `json:"ac"`
}

// netAltitude decodes alt_baro, which is a number in feet OR the string
// "ground". A plain *int would make every aircraft on a taxiway a decode error.
type netAltitude struct {
	Feet     *int
	OnGround bool
}

func (a *netAltitude) UnmarshalJSON(b []byte) error {
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "null" || trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, `"`) {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		a.OnGround = strings.EqualFold(strings.TrimSpace(s), "ground")
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	n := int(math.Round(f))
	a.Feet = &n
	return nil
}

// netDetection is the on-the-wire Detection.
//
// A separate type from Detection on purpose. Detection is a decoding target
// with non-omitempty pointers, so marshalling one emits `"freq_hz": null` --
// which detection.schema.json rejects, because freq_hz is an integer and not
// nullable. Encoding through a type built for the schema means what this feed
// publishes is valid by construction rather than by hope.
type netDetection struct {
	SchemaVersion  string `json:"schema_version"`
	DetectionID    string `json:"detection_id"`
	TS             string `json:"ts"`
	SensorID       string `json:"sensor_id"`
	SensorKind     string `json:"sensor_kind"`
	DetectionClass string `json:"detection_class"`

	Position   *netPosition   `json:"position,omitempty"`
	Kinematics *netKinematics `json:"kinematics,omitempty"`
	ADSB       *netADSB       `json:"adsb"`
}

type netPosition struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type netKinematics struct {
	SpeedMPS *float64 `json:"speed_mps,omitempty"`
	TrackDeg *float64 `json:"track_deg,omitempty"`
}

type netADSB struct {
	ICAO     string `json:"icao"`
	Callsign string `json:"callsign,omitempty"`
	AltFt    *int   `json:"alt_ft,omitempty"`
}

// Poll fetches once and returns detection payloads ready to publish, plus how
// many aircraft the response held before filtering.
func (f *NetADSBFeed) Poll(ctx context.Context) (payloads [][]byte, total int, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.endpoint(), nil)
	if err != nil {
		return nil, 0, err
	}
	// Community aggregators ask clients to identify themselves so they can
	// contact whoever is generating unusual load instead of blocking a subnet.
	req.Header.Set("User-Agent", "classg/1.0 (+https://github.com/lnorton89/classg)")
	req.Header.Set("Accept", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Bounded read: an error page is not a reason to buffer a megabyte.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return nil, 0, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(snippet)))
	}

	var decoded netPointResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&decoded); err != nil {
		return nil, 0, fmt.Errorf("decode response: %w", err)
	}

	now := f.now()
	payloads = make([][]byte, 0, len(decoded.Aircraft))
	for _, ac := range decoded.Aircraft {
		if len(payloads) >= f.cfg.MaxAircraft {
			break
		}
		d, ok := f.convert(ac, now)
		if !ok {
			continue
		}
		body, err := json.Marshal(d)
		if err != nil {
			return nil, len(decoded.Aircraft), err
		}
		payloads = append(payloads, body)
	}
	return payloads, len(decoded.Aircraft), nil
}

func (f *NetADSBFeed) convert(ac netAircraft, now time.Time) (netDetection, bool) {
	icao := strings.ToUpper(strings.TrimSpace(ac.Hex))
	if icao == "" {
		return netDetection{}, false
	}
	// An aircraft sitting on a taxiway is not airspace context. Near an
	// airport it is most of the response, it can never be confused with a
	// drone in flight, and every one of them is a row in the database and a
	// symbol on the map.
	if ac.AltBaro.OnGround {
		return netDetection{}, false
	}

	// Age comes from the response but the clock does not. The upstream `now`
	// field would be the obvious timestamp source and is the wrong one: it is
	// their clock, and any skew against ours lands directly in contact expiry,
	// which is the mechanism that decides how long a real detection stays
	// suppressed. Local time minus a reported age keeps expiry on our clock.
	age := 0.0
	if ac.SeenPos != nil {
		age = *ac.SeenPos
	} else if ac.Seen != nil {
		age = *ac.Seen
	}
	if age < 0 {
		age = 0
	}
	if time.Duration(age*float64(time.Second)) > f.cfg.MaxAge {
		return netDetection{}, false
	}
	ts := now.Add(-time.Duration(age * float64(time.Second)))

	d := netDetection{
		SchemaVersion:  "1.0",
		DetectionID:    f.newID(),
		TS:             ts.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		SensorID:       f.cfg.SensorID,
		SensorKind:     "net",
		DetectionClass: ClassADSB,
		ADSB: &netADSB{
			ICAO:     icao,
			Callsign: strings.TrimSpace(ac.Flight),
			AltFt:    ac.AltBaro.Feet,
		},
	}

	if ac.Lat != nil && ac.Lon != nil && !(*ac.Lat == 0 && *ac.Lon == 0) {
		d.Position = &netPosition{Lat: *ac.Lat, Lon: *ac.Lon}
	}

	var k netKinematics
	if ac.GroundSp != nil && *ac.GroundSp >= 0 {
		// Knots to m/s. Ground speed, not airspeed -- which is the one that
		// matters for correlating against a track's measured motion.
		mps := *ac.GroundSp * 0.514444
		k.SpeedMPS = &mps
	}
	if ac.Track != nil {
		// The schema excludes 360 rather than folding it, so a heading reported
		// as exactly 360 would fail validation on the way out.
		deg := math.Mod(*ac.Track, 360)
		if deg < 0 {
			deg += 360
		}
		k.TrackDeg = &deg
	}
	if k.SpeedMPS != nil || k.TrackDeg != nil {
		d.Kinematics = &k
	}

	return d, true
}

// NetADSBStatus is what the feed reports about itself on the heartbeat topic.
type NetADSBStatus struct {
	Healthy   bool
	Aircraft  int
	Total     int
	Failures  int
	LastError string
}

// Run polls on the configured interval until ctx is cancelled.
//
// `emit` receives one detection payload at a time; `status` receives the
// outcome of every poll, successful or not. Neither is called concurrently.
//
// There is no return value and no fatal path on purpose. An uplink that comes
// and goes is the expected condition for this source, not an error -- ADR-0003
// applies to a feed exactly as it applies to a radio, and the operator-visible
// degraded state is the heartbeat, not a crash.
func (f *NetADSBFeed) Run(ctx context.Context, emit func(body []byte), status func(NetADSBStatus)) {
	ticker := time.NewTicker(f.cfg.Interval)
	defer ticker.Stop()

	failures := 0
	poll := func() {
		payloads, total, err := f.Poll(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			failures++
			status(NetADSBStatus{Healthy: false, Failures: failures, LastError: err.Error()})
			return
		}
		failures = 0
		for _, body := range payloads {
			emit(body)
		}
		status(NetADSBStatus{Healthy: true, Aircraft: len(payloads), Total: total})
	}

	// Poll immediately. Waiting a full interval for the first result would
	// leave a fresh start with no airspace context for exactly as long as the
	// interval, which is the window a detection is most likely to arrive in.
	poll()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			poll()
		}
	}
}
