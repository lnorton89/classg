package httpapi

import (
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/classg/api/internal/apierr"
	"github.com/classg/api/internal/model"
	"github.com/classg/api/internal/store"
)

// handleExportTrack writes one track's flight path as a file.
//
// Redaction happens once, at the top, against the same
// cfg.ExposeOperatorLocation every other read path uses. An export is a new way
// out of the unit and the pilot's ground position is the field that must not
// take it by accident -- so the redacted track is what the formatters see, and
// none of them can reach the original.
func (s *Server) handleExportTrack(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("track_id")

	t, err := s.store.GetTrack(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, apierr.NotFound("no track with id "+id))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("loading track failed"))
		return
	}
	track := t.Redact(s.cfg.ExposeOperatorLocation)

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "geojson"
	}

	var (
		body        []byte
		contentType string
		ext         string
	)
	switch format {
	case "geojson":
		body, err = trackGeoJSON(track)
		contentType, ext = "application/geo+json", "geojson"
	case "csv":
		body, err = trackCSV(track)
		contentType, ext = "text/csv; charset=utf-8", "csv"
	case "kml":
		body, err = trackKML(track)
		contentType, ext = "application/vnd.google-earth.kml+xml", "kml"
	default:
		fail(w, apierr.InvalidParameter("format", "must be geojson, csv or kml"))
		return
	}
	if err != nil {
		fail(w, apierr.Internal("rendering the export failed"))
		return
	}

	w.Header().Set("Content-Type", contentType)
	// Names the unit and the track, because these land in a downloads folder
	// next to a dozen others and "export.csv" is not a filename anybody can
	// use a week later.
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", "classg-"+safeFilename(track.TrackID)+"."+ext))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// safeFilename keeps a track id usable in a Content-Disposition header. Track
// ids are ULIDs today, but they arrive from fusion over the bus and a quote or
// a slash in one would either break the header or escape the filename.
func safeFilename(id string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, id)
	if clean == "" {
		return "track"
	}
	return clean
}

// --------------------------------------------------------------------------
// GeoJSON

type geoFeature struct {
	Type       string         `json:"type"`
	Geometry   any            `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

func trackGeoJSON(t model.Track) ([]byte, error) {
	features := []geoFeature{}

	// A LineString needs two points. One position is a Point, and none at all
	// still exports -- the metadata is the useful part of a track that never
	// got a position fix, and an empty file would look like an export failure.
	coords := make([][]float64, 0, len(t.History))
	for _, p := range t.History {
		coords = append(coords, position3D(p))
	}
	switch {
	case len(coords) >= 2:
		features = append(features, geoFeature{
			Type:       "Feature",
			Geometry:   map[string]any{"type": "LineString", "coordinates": coords},
			Properties: trackProperties(t),
		})
	case len(coords) == 1:
		features = append(features, geoFeature{
			Type:       "Feature",
			Geometry:   map[string]any{"type": "Point", "coordinates": coords[0]},
			Properties: trackProperties(t),
		})
	default:
		features = append(features, geoFeature{
			Type:       "Feature",
			Geometry:   nil,
			Properties: trackProperties(t),
		})
	}

	// Only ever present when the gate above let it through.
	if t.Operator != nil {
		features = append(features, geoFeature{
			Type: "Feature",
			Geometry: map[string]any{
				"type":        "Point",
				"coordinates": []float64{t.Operator.Lon, t.Operator.Lat},
			},
			Properties: map[string]any{"kind": "operator", "track_id": t.TrackID},
		})
	}

	return json.MarshalIndent(map[string]any{
		"type":     "FeatureCollection",
		"features": features,
	}, "", "  ")
}

// position3D is GeoJSON's lon, lat, altitude order -- the reverse of how every
// other part of this system writes a coordinate, and the single most common way
// to produce an export that plots in the sea.
func position3D(p model.Position) []float64 {
	if p.AltGeodeticM != nil {
		return []float64{p.Lon, p.Lat, *p.AltGeodeticM}
	}
	return []float64{p.Lon, p.Lat}
}

func trackProperties(t model.Track) map[string]any {
	props := map[string]any{
		"track_id":        t.TrackID,
		"state":           t.State,
		"first_seen":      t.FirstSeen.UTC().Format("2006-01-02T15:04:05.000Z"),
		"last_seen":       t.LastSeen.UTC().Format("2006-01-02T15:04:05.000Z"),
		"detection_count": t.DetectionCount,
		"confidence":      t.Confidence,
		"adsb_correlated": t.ADSBCorrelated,
	}
	if t.Identity.Serial != "" {
		props["serial"] = t.Identity.Serial
	}
	if len(t.Identity.MACs) > 0 {
		props["macs"] = t.Identity.MACs
	}
	if t.Identity.Vendor != "" {
		props["vendor"] = t.Identity.Vendor
	}
	if t.Identity.OperatorID != "" {
		props["operator_id"] = t.Identity.OperatorID
	}
	return props
}

// --------------------------------------------------------------------------
// CSV

func trackCSV(t model.Track) ([]byte, error) {
	var b strings.Builder
	cw := csv.NewWriter(&b)

	header := []string{"track_id", "at", "lat", "lon", "alt_geodetic_m", "height_agl_m", "speed_mps", "track_deg"}
	if err := cw.Write(header); err != nil {
		return nil, err
	}
	for _, p := range t.History {
		if err := cw.Write([]string{
			t.TrackID,
			p.At.UTC().Format("2006-01-02T15:04:05.000Z"),
			strconv.FormatFloat(p.Lat, 'f', -1, 64),
			strconv.FormatFloat(p.Lon, 'f', -1, 64),
			optFloat(p.AltGeodeticM),
			optFloat(p.HeightAGLM),
			optFloat(p.SpeedMPS),
			optFloat(p.TrackDeg),
		}); err != nil {
			return nil, err
		}
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

// optFloat writes an absent measurement as an empty field rather than as 0.
// A spreadsheet averaging a column of altitudes must not be handed zeros for
// the fixes that never carried one.
func optFloat(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}

// --------------------------------------------------------------------------
// KML

type kmlDoc struct {
	XMLName   xml.Name `xml:"kml"`
	NS        string   `xml:"xmlns,attr"`
	Placemark []kmlPlacemark
}

type kmlPlacemark struct {
	XMLName     xml.Name    `xml:"Placemark"`
	Name        string      `xml:"name"`
	Description string      `xml:"description"`
	LineString  *kmlLine    `xml:"LineString,omitempty"`
	Point       *kmlPointEl `xml:"Point,omitempty"`
}

type kmlLine struct {
	AltitudeMode string `xml:"altitudeMode"`
	Tessellate   int    `xml:"tessellate"`
	Coordinates  string `xml:"coordinates"`
}

type kmlPointEl struct {
	Coordinates string `xml:"coordinates"`
}

func trackKML(t model.Track) ([]byte, error) {
	doc := kmlDoc{NS: "http://www.opengis.net/kml/2.2"}

	if len(t.History) > 0 {
		coords := make([]string, 0, len(t.History))
		for _, p := range t.History {
			alt := 0.0
			if p.AltGeodeticM != nil {
				alt = *p.AltGeodeticM
			}
			coords = append(coords, fmt.Sprintf("%g,%g,%g", p.Lon, p.Lat, alt))
		}
		doc.Placemark = append(doc.Placemark, kmlPlacemark{
			Name:        trackLabel(t),
			Description: fmt.Sprintf("ClassG track %s, %d detections", t.TrackID, t.DetectionCount),
			LineString: &kmlLine{
				// absolute so the path draws at its recorded altitude rather
				// than being flattened onto the terrain.
				AltitudeMode: "absolute",
				Tessellate:   1,
				Coordinates:  strings.Join(coords, "\n"),
			},
		})
	}

	if t.Operator != nil {
		doc.Placemark = append(doc.Placemark, kmlPlacemark{
			Name:        "Operator",
			Description: "Reported operator ground position",
			Point:       &kmlPointEl{Coordinates: fmt.Sprintf("%g,%g,0", t.Operator.Lon, t.Operator.Lat)},
		})
	}

	body, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), body...), nil
}

func trackLabel(t model.Track) string {
	if t.Identity.Serial != "" {
		return t.Identity.Serial
	}
	return t.TrackID
}
