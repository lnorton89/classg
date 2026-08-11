package fusion

import (
	"strings"
	"testing"
	"time"
)

// Shaped like the published export: quoted fields, lower-case hex, columns we
// do not use interleaved with the ones we do, and rows that name nothing.
const sampleAircraftCSV = `"icao24","registration","manufacturericao","manufacturername","model","typecode","serialnumber","icaoaircrafttype","operator","owner","categoryDescription"
"a1b2c3","N512UP","CESSNA","Cessna","208B Grand Caravan","C208","208B1234","L1T","UPS Airlines","United Parcel Service","Light (< 15500 lbs)"
"c0ffee","G-ABCD","AIRBUS","Airbus","A320-214","A320","1234","L2J","British Airways","BA plc","Large (75000 to 300000 lbs)"
"0000ff","","","","","","","","","",""
"4ca1b2","EI-DYX","BOEING","Boeing","737-8AS","B738","33333","L2J","Ryanair","Ryanair DAC","Large (75000 to 300000 lbs)"
`

func loadSample(t *testing.T) *AircraftDB {
	t.Helper()
	db, err := ReadAircraftDB(strings.NewReader(sampleAircraftCSV))
	if err != nil {
		t.Fatalf("read database: %v", err)
	}
	return db
}

func TestAircraftDBLookup(t *testing.T) {
	db := loadSample(t)

	// The all-empty row names nothing, so it is not worth a map entry.
	if db.Len() != 3 {
		t.Fatalf("loaded %d aircraft, want 3", db.Len())
	}

	info, ok := db.Lookup("A1B2C3")
	if !ok {
		t.Fatal("upper-case lookup missed a lower-case row")
	}
	if info.Registration != "N512UP" || info.TypeCode != "C208" {
		t.Errorf("got %+v, want N512UP / C208", info)
	}
	if info.Model != "208B Grand Caravan" || info.Operator != "UPS Airlines" {
		t.Errorf("got %+v", info)
	}
}

// dump1090, the aggregators and the database all disagree about case and
// zero-padding, which is exactly why the key is the parsed value.
func TestAircraftDBLookupNormalisesAddresses(t *testing.T) {
	db := loadSample(t)
	for _, form := range []string{"a1b2c3", "A1B2C3", " a1b2c3 ", "0a1b2c3"[1:]} {
		if _, ok := db.Lookup(form); !ok {
			t.Errorf("lookup(%q) missed", form)
		}
	}
	for _, form := range []string{"", "~a1b2c3", "zzzzzz", "a1b2c3d4"} {
		if _, ok := db.Lookup(form); ok {
			t.Errorf("lookup(%q) should not resolve", form)
		}
	}
	if _, ok := db.Lookup("ffffff"); ok {
		t.Error("an address not in the file must miss")
	}
}

// The export has reordered and renamed columns between releases. Reading by
// name means a shuffled file still works; a positional reader would return the
// manufacturer as the registration and never say so.
func TestAircraftDBReadsColumnsByName(t *testing.T) {
	shuffled := `"registration","typecode","icao24","model"
"D-EFGH","C172","3c1234","172S Skyhawk"
`
	db, err := ReadAircraftDB(strings.NewReader(shuffled))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	info, ok := db.Lookup("3C1234")
	if !ok {
		t.Fatal("lookup missed")
	}
	if info.Registration != "D-EFGH" || info.TypeCode != "C172" {
		t.Errorf("got %+v, want D-EFGH / C172", info)
	}
}

// The header and rows below are copied verbatim from the published export
// (opensky-network.org/datasets/metadata/aircraftDatabase.csv), not written
// from memory. The first version of this loader bound one column per field and
// chose `operator` -- which is blank on essentially every general-aviation row,
// while `owner` carries the name. It would have shown nothing for most
// aircraft and looked like it was working.
const realOpenSkyExport = `"icao24","registration","manufacturericao","manufacturername","model","typecode","serialnumber","linenumber","icaoaircrafttype","operator","operatorcallsign","operatoricao","operatoriata","owner","testreg","registered","reguntil","status","built","firstflightdate","seatconfiguration","engines","modes","adsb","acars","notes","categoryDescription"
"","","","","","","","","","","","","","","","","","","","","","","false","false","false","",""
"aa3487","N757F","RAYTHEON","Raytheon Aircraft Company","A36","BE36","E-3121","","L1P","","","","","Vintage Aircraft Llc","","","2027-01-31","","","","","","false","false","false","",""
"391927","F-GGJH","ROBIN","Robin","DR.400 160 Chevalier","DR40","1795","","L1P","","","","","Private","","","","","","","","","false","false","false","",""
"4ca1b2","EI-DYX","BOEING","Boeing","737-8AS","B738","33333","","L2J","Ryanair","RYANAIR","RYR","FR","Ryanair DAC","","","","","","","","","false","false","false","",""
`

func TestAircraftDBAgainstTheRealExport(t *testing.T) {
	db, err := ReadAircraftDB(strings.NewReader(realOpenSkyExport))
	if err != nil {
		t.Fatalf("the published export must load: %v", err)
	}
	// The blank row carries no address and is skipped.
	if db.Len() != 3 {
		t.Fatalf("loaded %d, want 3", db.Len())
	}

	// operator is empty here and owner is not, which is the common case.
	ga, ok := db.Lookup("aa3487")
	if !ok {
		t.Fatal("lookup missed")
	}
	if ga.Operator != "Vintage Aircraft Llc" {
		t.Errorf("operator %q: should fall through an empty column to owner", ga.Operator)
	}
	if ga.Registration != "N757F" || ga.TypeCode != "BE36" || ga.Model != "A36" {
		t.Errorf("got %+v", ga)
	}

	// And where operator IS populated it must win over owner, not the reverse.
	airliner, ok := db.Lookup("4CA1B2")
	if !ok {
		t.Fatal("lookup missed")
	}
	if airliner.Operator != "Ryanair" {
		t.Errorf("operator %q, want Ryanair (owner is 'Ryanair DAC')", airliner.Operator)
	}
}

func TestAircraftDBRejectsWrongFile(t *testing.T) {
	_, err := ReadAircraftDB(strings.NewReader("alpha,beta\n1,2\n"))
	if err == nil {
		t.Fatal("a CSV with no icao24 column should not load as an aircraft database")
	}
}

// A nil database has to behave like an absent one, because that is the default
// and it must never be a nil-pointer panic on the ingest path.
func TestAircraftDBNilIsUsable(t *testing.T) {
	var db *AircraftDB
	if _, ok := db.Lookup("a1b2c3"); ok {
		t.Error("a nil database resolved something")
	}
	if db.Len() != 0 {
		t.Error("a nil database has no length")
	}
}

func TestContactStoreEnrichesFromAircraftDB(t *testing.T) {
	store := NewContactStore()
	store.UseAircraftDB(loadSample(t))

	adsb := func(icao string) Detection {
		var d Detection
		d.SchemaVersion = "1.0"
		d.DetectionClass = ClassADSB
		d.SensorID = "sdr-0"
		d.SensorKind = "sdr"
		d.TS = time.Now().UTC()
		d.ADSB = &struct {
			ICAO     string `json:"icao"`
			Callsign string `json:"callsign"`
			AltFt    *int   `json:"alt_ft"`
		}{ICAO: icao}
		return d
	}

	contact, isNew := store.Observe(adsb("4ca1b2"))
	if !isNew || contact == nil {
		t.Fatal("expected a new contact")
	}
	if contact.Aircraft == nil {
		t.Fatal("expected registry metadata")
	}
	if contact.Aircraft.Registration != "EI-DYX" || contact.Aircraft.TypeCode != "B738" {
		t.Errorf("got %+v, want EI-DYX / B738", contact.Aircraft)
	}

	// An address the database has never heard of still makes a contact. The
	// enrichment is a bonus, not a gate.
	unknown, isNew := store.Observe(adsb("abcdef"))
	if !isNew || unknown == nil {
		t.Fatal("an unknown address must still produce a contact")
	}
	if unknown.Aircraft != nil {
		t.Errorf("expected no metadata, got %+v", unknown.Aircraft)
	}
}
