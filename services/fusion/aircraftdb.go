package fusion

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Offline aircraft metadata, from the OpenSky Network's aircraft database.
//
// ADS-B carries a 24-bit ICAO address and, sometimes, a callsign. "A1B2C3" is
// not something an operator can act on; "N512UP, a Cessna 208" is. OpenSky
// publishes the mapping as a CSV under CC-BY, which makes this the rare
// enrichment that needs no service at all -- download once, read at startup,
// works forever with the uplink unplugged. There is no API call here on
// purpose: the live OpenSky REST API is credit-metered and would give the same
// answers for a field that never changes.
//
// Absent by default. Nothing degrades without it; contacts simply keep the
// hex address they already had.

// AircraftInfo is what the database knows about one airframe.
type AircraftInfo struct {
	Registration string `json:"registration,omitempty"`
	// ICAO type designator, e.g. "B738". Terse but unambiguous.
	TypeCode string `json:"type_code,omitempty"`
	Model    string `json:"model,omitempty"`
	Operator string `json:"operator,omitempty"`
}

func (a AircraftInfo) empty() bool {
	return a.Registration == "" && a.TypeCode == "" && a.Model == "" && a.Operator == ""
}

// AircraftDB is an in-memory ICAO address index.
//
// Sized for a Pi, within reason. The full database is around half a million
// rows; model, type code and operator repeat heavily across them and are
// interned, registration does not and is not. Expect tens of megabytes
// resident -- the row count is logged at load so it can be checked against the
// process rather than guessed at. A unit that cannot spare it should ship a
// filtered CSV; the loader neither knows nor cares how the file was produced.
type AircraftDB struct {
	byICAO map[uint32]AircraftInfo
}

// Column names as OpenSky publishes them. Looked up by name rather than by
// position because the export has gained and reordered columns between
// releases, and a positional reader would silently index the wrong field
// rather than fail.
var aircraftColumns = map[string][]string{
	"registration": {"registration", "reg"},
	"typecode":     {"typecode", "icaoaircrafttype"},
	"model":        {"model"},
	"operator":     {"operator", "operatorcallsign", "owner"},
}

var errNoICAOColumn = errors.New("no icao24 column: this does not look like an OpenSky aircraft database export")

// LoadAircraftDB reads an OpenSky aircraft database CSV.
func LoadAircraftDB(path string) (*AircraftDB, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return ReadAircraftDB(file)
}

func ReadAircraftDB(r io.Reader) (*AircraftDB, error) {
	reader := csv.NewReader(r)
	// The export is not uniformly quoted and row width drifts between
	// releases. Neither is a reason to reject a file whose icao24 column is
	// perfectly readable.
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true

	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	index := map[string]int{}
	icaoAt := -1
	for i, raw := range header {
		name := strings.ToLower(strings.Trim(strings.TrimSpace(raw), `'"`))
		if name == "icao24" {
			icaoAt = i
			continue
		}
		for field, aliases := range aircraftColumns {
			if _, taken := index[field]; taken {
				continue
			}
			for _, alias := range aliases {
				if name == alias {
					index[field] = i
					break
				}
			}
		}
	}
	if icaoAt < 0 {
		return nil, errNoICAOColumn
	}

	db := &AircraftDB{byICAO: make(map[uint32]AircraftInfo)}
	intern := map[string]string{}
	pool := func(s string) string {
		if s == "" {
			return ""
		}
		if existing, ok := intern[s]; ok {
			return existing
		}
		intern[s] = s
		return s
	}
	at := func(row []string, field string) string {
		i, ok := index[field]
		if !ok || i >= len(row) {
			return ""
		}
		return strings.Trim(strings.TrimSpace(row[i]), `'"`)
	}

	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// One malformed line in half a million is not a reason to have no
			// aircraft names at all.
			if errors.Is(err, csv.ErrFieldCount) {
				continue
			}
			return nil, fmt.Errorf("read row: %w", err)
		}
		if icaoAt >= len(row) {
			continue
		}
		key, ok := parseICAO24(strings.Trim(strings.TrimSpace(row[icaoAt]), `'"`))
		if !ok {
			continue
		}
		info := AircraftInfo{
			Registration: at(row, "registration"),
			TypeCode:     pool(at(row, "typecode")),
			Model:        pool(at(row, "model")),
			Operator:     pool(at(row, "operator")),
		}
		// A row that names nothing costs memory and answers no question.
		if info.empty() {
			continue
		}
		db.byICAO[key] = info
	}
	return db, nil
}

// Lookup resolves a 24-bit ICAO address in any case, with or without padding.
func (db *AircraftDB) Lookup(icao string) (AircraftInfo, bool) {
	if db == nil {
		return AircraftInfo{}, false
	}
	key, ok := parseICAO24(icao)
	if !ok {
		return AircraftInfo{}, false
	}
	info, ok := db.byICAO[key]
	return info, ok
}

func (db *AircraftDB) Len() int {
	if db == nil {
		return 0
	}
	return len(db.byICAO)
}

// parseICAO24 turns a hex address into a comparable key.
//
// Keyed on the parsed value rather than the string so "a1b2c3", "A1B2C3" and
// "0A1B2C" all resolve. dump1090 and the aggregators disagree about case, and
// the database is lower-case, so string keys would silently miss.
func parseICAO24(s string) (uint32, bool) {
	s = strings.TrimSpace(s)
	// A leading ~ marks a non-ICAO address (TIS-B, ADS-R). Those are real
	// aircraft but the address is not an airframe identifier, so it can never
	// appear in a registration database.
	if s == "" || strings.HasPrefix(s, "~") || len(s) > 6 {
		return 0, false
	}
	var value uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			value = value<<4 | uint32(c-'0')
		case c >= 'a' && c <= 'f':
			value = value<<4 | uint32(c-'a'+10)
		case c >= 'A' && c <= 'F':
			value = value<<4 | uint32(c-'A'+10)
		default:
			return 0, false
		}
	}
	return value, true
}
