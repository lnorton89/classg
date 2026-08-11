package fusion

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Terrain elevation, so height_agl_m stops being mostly null.
//
// Remote ID reports geodetic altitude far more reliably than it reports height,
// and geodetic altitude is close to meaningless on its own: 400 m over the
// Columbia river and 400 m over the ridge behind it are the same number and
// very different situations. Subtracting ground elevation is what turns the
// field an operator reads into the one that decides whether a flight is legal.
//
// This is the one enrichment here that is genuinely better offline. Terrain
// does not change, so a self-hosted OpenTopoData with SRTM tiles gives the same
// answers as the public endpoint with no uplink, no rate limit and no third
// party. Point CLASSG_FUSION_TERRAIN_URL at one.

const (
	TerrainDefaultBaseURL = "https://api.opentopodata.org"

	// SRTM 30 m is the widest-coverage free dataset and the one the public
	// instance always has. A self-hosted instance can serve ned10m, eudem25m or
	// anything else; the dataset name is just a path segment.
	TerrainDefaultDataset = "srtm30m"

	// Cache resolution in degrees. 0.0003 deg is ~33 m of latitude, which is
	// the actual resolution of SRTM 30 m -- asking for finer detail than the
	// dataset holds would only multiply cache misses for interpolated values.
	TerrainDefaultGridDeg = 0.0003

	// Bounded so a long deployment cannot grow the resident set without limit.
	// 20k cells at ~33 m covers roughly a 25 km2 patch of sky, far more than
	// one receiver's horizon.
	TerrainDefaultCacheSize = 20_000

	TerrainDefaultTimeout = 10 * time.Second

	// The public instance asks for at most one call per second. Every lookup is
	// cached forever, so this only ever throttles genuinely new ground.
	TerrainDefaultMinInterval = time.Second
)

// TerrainConfig configures the elevation lookup.
type TerrainConfig struct {
	BaseURL string
	Dataset string
	GridDeg float64
	Timeout time.Duration
	// MinInterval rate-limits outbound lookups. Set it to zero for a
	// self-hosted instance, where the only cost is local CPU.
	MinInterval time.Duration
	CacheSize   int

	// GeoidOffsetM corrects the datum mismatch described on ElevationM.
	// Unset means uncorrected, and uncorrected means wrong by the local geoid
	// undulation -- tens of metres in most of the world.
	GeoidOffsetM float64
}

func (c *TerrainConfig) applyDefaults() {
	if strings.TrimSpace(c.BaseURL) == "" {
		c.BaseURL = TerrainDefaultBaseURL
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if strings.TrimSpace(c.Dataset) == "" {
		c.Dataset = TerrainDefaultDataset
	}
	if c.GridDeg <= 0 {
		c.GridDeg = TerrainDefaultGridDeg
	}
	if c.Timeout <= 0 {
		c.Timeout = TerrainDefaultTimeout
	}
	if c.CacheSize <= 0 {
		c.CacheSize = TerrainDefaultCacheSize
	}
	if c.MinInterval < 0 {
		c.MinInterval = 0
	}
}

type gridCell struct{ lat, lon int64 }

// Terrain resolves ground elevation, cached, without ever blocking its caller.
//
// The access pattern here is unusual enough to be worth stating: fusion's
// ingest loop is a single goroutine that must keep up with every sensor on the
// bus, so it cannot make an HTTP call. So Lookup only ever answers from cache,
// and a miss schedules a fetch for next time. A hovering drone re-reports its
// position several times a second and the second detection gets an AGL; a
// drone crossing new ground fast gets AGL a beat late. Both are better than a
// fusion loop that stalls for 200 ms because a tile server is slow.
type Terrain struct {
	cfg    TerrainConfig
	client *http.Client

	mu      sync.RWMutex
	cache   map[gridCell]float64
	order   []gridCell
	pending map[gridCell]struct{}

	requests chan gridCell

	// Counters for the operator-visible degraded state. A terrain service that
	// has been failing for an hour must not look like terrain that happens to
	// be at sea level.
	statsMu   sync.Mutex
	hits      int
	misses    int
	failures  int
	lastError string
}

func NewTerrain(cfg TerrainConfig) *Terrain {
	cfg.applyDefaults()
	return &Terrain{
		cfg:      cfg,
		client:   &http.Client{Timeout: cfg.Timeout},
		cache:    make(map[gridCell]float64),
		pending:  make(map[gridCell]struct{}),
		requests: make(chan gridCell, 256),
	}
}

func (t *Terrain) cell(lat, lon float64) gridCell {
	return gridCell{
		lat: int64(math.Round(lat / t.cfg.GridDeg)),
		lon: int64(math.Round(lon / t.cfg.GridDeg)),
	}
}

func (t *Terrain) cellCentre(c gridCell) (lat, lon float64) {
	return float64(c.lat) * t.cfg.GridDeg, float64(c.lon) * t.cfg.GridDeg
}

// ElevationM returns cached ground elevation in metres, and whether it was
// known. A miss queues a fetch and returns false.
//
// The returned value already has GeoidOffsetM applied, so it is directly
// subtractable from a WGS-84 geodetic altitude. That correction matters: SRTM
// and NED report orthometric height (above the geoid), Remote ID reports
// height above the WGS-84 ellipsoid, and the two differ by the geoid
// undulation -- about -22 m in the Pacific Northwest, and up to 100 m
// elsewhere. Subtracting one from the other without correcting is a silently
// wrong AGL, and wrong in the direction that makes flights look lower than
// they are.
func (t *Terrain) ElevationM(lat, lon float64) (float64, bool) {
	c := t.cell(lat, lon)

	t.mu.RLock()
	elevation, ok := t.cache[c]
	t.mu.RUnlock()
	if ok {
		t.count(&t.hits)
		return elevation + t.cfg.GeoidOffsetM, true
	}

	t.count(&t.misses)
	t.schedule(c)
	return 0, false
}

// HeightAGL returns the height of a geodetic altitude above the ground beneath
// it, along with the ground elevation used.
func (t *Terrain) HeightAGL(lat, lon, altGeodeticM float64) (agl, groundM float64, ok bool) {
	groundM, ok = t.ElevationM(lat, lon)
	if !ok {
		return 0, 0, false
	}
	return altGeodeticM - groundM, groundM, true
}

func (t *Terrain) schedule(c gridCell) {
	t.mu.Lock()
	if _, queued := t.pending[c]; queued {
		t.mu.Unlock()
		return
	}
	t.pending[c] = struct{}{}
	t.mu.Unlock()

	select {
	case t.requests <- c:
	default:
		// Queue full. Drop it and let the next detection from this cell
		// re-request rather than blocking the ingest loop, which is the one
		// thing this whole design exists to avoid.
		t.mu.Lock()
		delete(t.pending, c)
		t.mu.Unlock()
	}
}

func (t *Terrain) count(target *int) {
	t.statsMu.Lock()
	*target++
	t.statsMu.Unlock()
}

func (t *Terrain) store(c gridCell, elevation float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.pending, c)
	if _, exists := t.cache[c]; !exists {
		t.cache[c] = elevation
		t.order = append(t.order, c)
		// FIFO rather than LRU. Eviction should effectively never happen at
		// TerrainDefaultCacheSize, and a real LRU would need bookkeeping on
		// every read -- on the hot path, for a case that does not arise.
		for len(t.order) > t.cfg.CacheSize {
			delete(t.cache, t.order[0])
			t.order = t.order[1:]
		}
	}
}

func (t *Terrain) fail(c gridCell, err error) {
	t.mu.Lock()
	delete(t.pending, c)
	t.mu.Unlock()

	t.statsMu.Lock()
	t.failures++
	t.lastError = err.Error()
	t.statsMu.Unlock()
}

// TerrainStats is a snapshot for logging and health reporting.
type TerrainStats struct {
	Cached    int
	Hits      int
	Misses    int
	Failures  int
	LastError string
}

func (t *Terrain) Stats() TerrainStats {
	t.mu.RLock()
	cached := len(t.cache)
	t.mu.RUnlock()

	t.statsMu.Lock()
	defer t.statsMu.Unlock()
	return TerrainStats{
		Cached:    cached,
		Hits:      t.hits,
		Misses:    t.misses,
		Failures:  t.failures,
		LastError: t.lastError,
	}
}

// Run services queued lookups until ctx is cancelled. One goroutine, one
// request at a time, which is both what the public instance asks for and what
// keeps a burst of new ground from becoming a burst of connections.
func (t *Terrain) Run(ctx context.Context) {
	var last time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case c := <-t.requests:
			if t.cfg.MinInterval > 0 {
				if wait := t.cfg.MinInterval - time.Since(last); wait > 0 {
					select {
					case <-time.After(wait):
					case <-ctx.Done():
						return
					}
				}
			}
			last = time.Now()

			lat, lon := t.cellCentre(c)
			elevation, err := t.fetch(ctx, lat, lon)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				t.fail(c, err)
				slog.Warn("terrain lookup failed", "lat", lat, "lon", lon, "err", err)
				continue
			}
			t.store(c, elevation)
		}
	}
}

type topoResponse struct {
	Status  string `json:"status"`
	Error   string `json:"error"`
	Results []struct {
		Elevation *float64 `json:"elevation"`
	} `json:"results"`
}

var errNoElevation = errors.New("no elevation for this location")

func (t *Terrain) fetch(ctx context.Context, lat, lon float64) (float64, error) {
	url := fmt.Sprintf("%s/v1/%s?locations=%.6f,%.6f", t.cfg.BaseURL, t.cfg.Dataset, lat, lon)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "classg/1.0 (+https://github.com/lnorton89/classg)")
	req.Header.Set("Accept", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var decoded topoResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return 0, fmt.Errorf("decode response: %w", err)
	}
	if decoded.Status != "" && decoded.Status != "OK" {
		return 0, fmt.Errorf("%s: %s", decoded.Status, decoded.Error)
	}
	if len(decoded.Results) == 0 || decoded.Results[0].Elevation == nil {
		// A null elevation is the documented answer for a point outside the
		// dataset -- ocean, or beyond SRTM's 60 degree latitude limit. It is
		// not a failure of the service, so it must not be counted as one, but
		// it is also not an elevation.
		return 0, errNoElevation
	}
	return *decoded.Results[0].Elevation, nil
}
