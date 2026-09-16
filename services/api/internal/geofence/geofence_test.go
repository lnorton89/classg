package geofence

import "testing"

// A simple square, roughly 100m on a side at mid-latitudes -- the shape a
// property boundary actually looks like.
func square() Boundary {
	return Boundary{
		BoundaryID: "b1", Name: "square",
		Points: []LatLon{
			{Lat: 47.6000, Lon: -122.3300},
			{Lat: 47.6000, Lon: -122.3290},
			{Lat: 47.6010, Lon: -122.3290},
			{Lat: 47.6010, Lon: -122.3300},
		},
	}
}

func TestContainsInsideAndOutside(t *testing.T) {
	sq := square()

	if !sq.Contains(47.6005, -122.3295) {
		t.Error("centre of the square reported outside")
	}
	if sq.Contains(47.6100, -122.3295) {
		t.Error("a point well north of the square reported inside")
	}
	if sq.Contains(47.6005, -122.3400) {
		t.Error("a point well west of the square reported inside")
	}
}

// A concave polygon (an L-shape) is the case a naive "bounding box" check
// would get wrong but ray casting gets right -- this is why Contains does not
// just compare against min/max lat and lon.
func TestContainsConcavePolygon(t *testing.T) {
	l := Boundary{
		BoundaryID: "b2", Name: "L-shape",
		Points: []LatLon{
			{Lat: 0, Lon: 0},
			{Lat: 0, Lon: 2},
			{Lat: 1, Lon: 2},
			{Lat: 1, Lon: 1},
			{Lat: 2, Lon: 1},
			{Lat: 2, Lon: 0},
		},
	}
	// Inside the notch cut out of the L -- within the bounding box, but
	// outside the actual shape.
	if l.Contains(1.5, 1.5) {
		t.Error("a point in the L's notch reported inside")
	}
	// Inside the L itself.
	if !l.Contains(0.5, 0.5) {
		t.Error("a point in the L's body reported outside")
	}
}

func TestValidateRejectsBadBoundaries(t *testing.T) {
	for _, c := range []struct {
		name string
		b    Boundary
	}{
		{"no name", Boundary{Points: []LatLon{{0, 0}, {0, 1}, {1, 1}}}},
		{"too few points", Boundary{Name: "x", Points: []LatLon{{0, 0}, {0, 1}}}},
		{"latitude out of range", Boundary{Name: "x", Points: []LatLon{{91, 0}, {0, 1}, {1, 1}}}},
		{"longitude out of range", Boundary{Name: "x", Points: []LatLon{{0, 181}, {0, 1}, {1, 1}}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if err := c.b.Validate(); err == nil {
				t.Fatal("accepted an invalid boundary")
			}
		})
	}

	valid := square()
	if err := valid.Validate(); err != nil {
		t.Fatalf("rejected a valid boundary: %v", err)
	}
}
