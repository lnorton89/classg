// Package geofence is a named polygon on the ground and a test for whether a
// point falls inside it.
//
// It exists for one reason: an alert rule that should only fire for a drone
// over your own property, not every aircraft the sensors see. The boundary
// itself is drawn by an operator on the map (services/ui) and stored here;
// internal/hooks is the only consumer of the containment test.
//
// Planar point-in-polygon, deliberately. A property boundary spans metres to
// a few hundred metres -- far below where the earth's curvature would change
// the answer -- so the accuracy a geodesic library buys is not worth the
// dependency.
package geofence

import (
	"errors"
	"fmt"
	"time"
)

// LatLon is one vertex.
type LatLon struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// Boundary is a closed polygon an operator drew on the map. The first and
// last point are implicitly connected -- Points does not repeat the first
// vertex to close the ring, the way GeoJSON would.
type Boundary struct {
	BoundaryID string    `json:"boundary_id"`
	Name       string    `json:"name"`
	Points     []LatLon  `json:"points"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// MinPoints is the fewest vertices that make a polygon at all. Two points is
// a line, and a line contains no area for a track to be inside of.
const MinPoints = 3

// Validate checks a boundary before it is stored.
func (b *Boundary) Validate() error {
	if len(b.Name) == 0 {
		return errors.New("a boundary needs a name")
	}
	if len(b.Points) < MinPoints {
		return fmt.Errorf("a boundary needs at least %d points, got %d", MinPoints, len(b.Points))
	}
	for i, p := range b.Points {
		if p.Lat < -90 || p.Lat > 90 {
			return fmt.Errorf("point %d: latitude %v is out of range", i, p.Lat)
		}
		if p.Lon < -180 || p.Lon > 180 {
			return fmt.Errorf("point %d: longitude %v is out of range", i, p.Lon)
		}
	}
	return nil
}

// Contains reports whether (lat, lon) falls inside the boundary, using the
// standard ray-casting algorithm: count how many times a ray from the point
// out to longitude +infinity crosses an edge of the polygon: odd is inside,
// even is outside.
//
// A point exactly on an edge or vertex can legitimately come back either way
// -- that ambiguity is inherent to the algorithm, not a bug in it, and it
// only matters here in the width of a GPS fix's own error margin.
func (b Boundary) Contains(lat, lon float64) bool {
	inside := false
	n := len(b.Points)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		pi, pj := b.Points[i], b.Points[j]
		// Does the edge (pi, pj) straddle the ray's latitude?
		if (pi.Lat > lat) != (pj.Lat > lat) {
			// Longitude where that edge crosses this latitude.
			crossLon := pj.Lon + (lat-pj.Lat)/(pi.Lat-pj.Lat)*(pi.Lon-pj.Lon)
			if lon < crossLon {
				inside = !inside
			}
		}
	}
	return inside
}
