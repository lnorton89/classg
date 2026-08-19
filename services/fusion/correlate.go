package fusion

import (
	"math"
	"time"
)

// ADS-B correlation: the gate that lets a contact explain a track away.
//
// A track flagged ADSBCorrelated is treated downstream as manned traffic --
// the API's isDrone() returns false for it and an only_drones alert rule skips
// it. That makes a FALSE correlation the expensive failure mode: it silences
// the alert for a real drone that happened to fly near an airliner's ground
// path. The gates below are therefore deliberately conservative -- every one
// of them must pass, and a failed altitude comparison vetoes rather than
// abstains. The cheap failure mode -- a genuinely correlated aircraft briefly
// showing as a drone -- costs an operator a glance at the map, not a missed
// detection.
const (
	// adsbMaxFixSkewS bounds how far apart in time the two fixes being
	// compared may be. A track fix and a contact fix from different moments of
	// a 60 m/s aircraft are fixes of different places; 10 s is ~600 m of
	// airliner travel, which the distance gate then has to absorb, so keeping
	// this tight matters more than it looks.
	adsbMaxFixSkew = 10 * time.Second

	// adsbMaxDistanceM is the horizontal gate between the two fixes. Remote ID
	// GNSS is good to tens of metres and ADS-B position to ~10 m; 300 m covers
	// both errors plus the fix skew above without reaching across a traffic
	// pattern.
	adsbMaxDistanceM = 300.0

	// adsbMaxAltDiffM is applied only when both sides report an altitude.
	// The comparison is honest but loose by construction: ADS-B carries
	// pressure altitude and a track carries geodetic, which disagree by the
	// local geoid undulation plus the day's barometric offset -- routinely
	// tens of metres. 150 m absorbs that while still separating a drone at
	// 60 m AGL from an airliner at 900 m on approach.
	adsbMaxAltDiffM = 150.0

	feetToMetres = 0.3048
)

// CorrelateContacts recomputes ADSBCorrelated for every open track against the
// current contact set, returning the tracks whose flag changed so the caller
// can publish them.
//
// Recomputed, not latched: contact.go's own warning applies -- a stale
// correlation "suppresses a real aircraft by attributing it to an airliner
// that left the area minutes ago". When the contact expires or diverges, the
// next pass clears the flag. Call it from the reap tick, after ContactStore
// and TrackStore have both reaped, so an expired contact can never hold a
// track suppressed.
func (s *TrackStore) CorrelateContacts(contacts []*ADSBContact) []*Track {
	s.mu.Lock()
	defer s.mu.Unlock()

	var changed []*Track
	for _, t := range s.all {
		correlated := false
		if t.Current != nil {
			for _, c := range contacts {
				if contactMatchesFix(c, t.Current) {
					correlated = true
					break
				}
			}
		}
		if t.ADSBCorrelated != correlated {
			t.ADSBCorrelated = correlated
			changed = append(changed, t)
		}
	}
	return changed
}

func contactMatchesFix(c *ADSBContact, fix *Position) bool {
	if c == nil || c.Current == nil {
		return false
	}
	skew := c.Current.At.Sub(fix.At)
	if skew < 0 {
		skew = -skew
	}
	if skew > adsbMaxFixSkew {
		return false
	}
	if horizontalDistanceM(fix.Lat, fix.Lon, c.Current.Lat, c.Current.Lon) > adsbMaxDistanceM {
		return false
	}
	if fix.AltGeodeticM != nil && c.AltFt != nil {
		if math.Abs(*fix.AltGeodeticM-float64(*c.AltFt)*feetToMetres) > adsbMaxAltDiffM {
			return false
		}
	}
	return true
}

// horizontalDistanceM is an equirectangular approximation. Exact great-circle
// maths buys nothing at a 300 m gate -- the approximation's error at that
// range is centimetres -- and this runs tracks-times-contacts on every tick.
func horizontalDistanceM(lat1, lon1, lat2, lon2 float64) float64 {
	const earthRadiusM = 6371000.0
	const toRad = math.Pi / 180.0
	dLat := (lat2 - lat1) * toRad
	dLon := (lon2 - lon1) * toRad * math.Cos((lat1+lat2)/2*toRad)
	return earthRadiusM * math.Hypot(dLat, dLon)
}
