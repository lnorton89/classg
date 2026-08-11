package fusion

import (
	"strings"
	"sync"
	"time"
)

// ClassADSB is the detection class carrying manned traffic from the SDR sensor.
const ClassADSB = "D"

// ContactExpireAfter bounds how long a contact survives with no further
// messages.
//
// Deliberately far shorter than a track's CloseAfter. Contacts exist to explain
// detections away, so a stale one is actively harmful: it suppresses a real
// aircraft by attributing it to an airliner that left the area minutes ago.
// Forgetting manned traffic too early only costs airspace context on the map;
// remembering it too long costs a detection.
const ContactExpireAfter = 60 * time.Second

// ADSBContact is one manned aircraft, keyed by its ICAO 24-bit address.
//
// Deliberately not a Track. A Track is the assertion that something might be an
// uncrewed aircraft: it carries confidence accumulated from evidence weights and
// is what the map draws as a contact of interest. ADS-B is the opposite kind of
// statement -- a cooperative aircraft announcing itself -- so it gets its own
// type rather than a Track with confidence pinned to zero.
type ADSBContact struct {
	ICAO      string    `json:"icao"`
	Callsign  string    `json:"callsign,omitempty"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	Messages  int       `json:"messages"`

	Current *Position `json:"current,omitempty"`
	// AltFt stays in feet. ADS-B reports feet natively and every consumer
	// displays feet; converting to metres here and back at the edge would only
	// add rounding error. Same reasoning as services/ui/src/lib/units.ts.
	AltFt *int `json:"alt_ft,omitempty"`
}

// ContactStore owns ADS-B contact state.
//
// In-memory only, for the reason TrackStore is: an aircraft remembered across a
// restart is one that has almost certainly flown out of range, and a contact
// that outlives its aircraft suppresses detections it has no business
// explaining.
type ContactStore struct {
	mu          sync.RWMutex
	byICAO      map[string]*ADSBContact
	expireAfter time.Duration
}

func NewContactStore() *ContactStore {
	return NewContactStoreWithExpiry(ContactExpireAfter)
}

func NewContactStoreWithExpiry(expireAfter time.Duration) *ContactStore {
	return &ContactStore{byICAO: map[string]*ADSBContact{}, expireAfter: expireAfter}
}

// Observe folds one Class D detection into the contact for its ICAO address,
// returning that contact and whether it was newly created.
//
// A detection that cannot be keyed returns nil. ADS-B with no ICAO address is
// not a contact: nothing correlates against it and the next message cannot find
// it again, so retaining it would recreate the per-message accumulation this
// store exists to prevent.
func (s *ContactStore) Observe(d Detection) (contact *ADSBContact, isNew bool) {
	if d.DetectionClass != ClassADSB || d.ADSB == nil {
		return nil, false
	}
	// dump1090 is inconsistent about hex case between output formats; without
	// folding it, one aircraft becomes two contacts.
	icao := strings.ToUpper(strings.TrimSpace(d.ADSB.ICAO))
	if icao == "" {
		return nil, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	c, ok := s.byICAO[icao]
	if !ok {
		c = &ADSBContact{ICAO: icao, FirstSeen: d.TS}
		s.byICAO[icao] = c
		isNew = true
	}
	c.Messages++
	// Guarded rather than assigned: ADS-B messages arrive interleaved from
	// several message types and can be delivered out of order, and an older one
	// must not drag LastSeen backwards into premature expiry.
	if d.TS.After(c.LastSeen) {
		c.LastSeen = d.TS
	}
	if d.TS.Before(c.FirstSeen) {
		c.FirstSeen = d.TS
	}
	if callsign := strings.TrimSpace(d.ADSB.Callsign); callsign != "" {
		c.Callsign = callsign
	}
	if d.ADSB.AltFt != nil {
		c.AltFt = d.ADSB.AltFt
	}
	// Position is absent from most ADS-B messages -- identity, velocity and
	// altitude all arrive separately. Keep the last known fix rather than
	// blanking it every time an identity-only message lands.
	if d.Position != nil {
		c.Current = &Position{Lat: d.Position.Lat, Lon: d.Position.Lon, At: d.TS}
	}
	return c, isNew
}

// Reap drops contacts that have gone quiet, returning their ICAO addresses.
// Must be called on a timer: expiry is time-driven, not message-driven.
func (s *ContactStore) Reap(now time.Time) []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	var expired []string
	for icao, c := range s.byICAO {
		if now.Sub(c.LastSeen) > s.expireAfter {
			delete(s.byICAO, icao)
			expired = append(expired, icao)
		}
	}
	return expired
}

func (s *ContactStore) Active() []*ADSBContact {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*ADSBContact, 0, len(s.byICAO))
	for _, c := range s.byICAO {
		out = append(out, c)
	}
	return out
}

func (s *ContactStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byICAO)
}
