import { afterEach, describe, expect, it, vi } from 'vitest'

import { isPMTilesArchive, noTilesStyle, vectorReachable, vectorStyle } from './style'

const PMTILES_MAGIC = new TextEncoder().encode('PMTiles')

function respond(init: { ok: boolean; body?: Uint8Array }): Response {
  return {
    ok: init.ok,
    arrayBuffer: () => Promise.resolve((init.body ?? new Uint8Array()).buffer),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isPMTilesArchive', () => {
  it('distinguishes an archive from a hosted style URL', () => {
    expect(isPMTilesArchive('/tiles/basemap.pmtiles')).toBe(true)
    expect(isPMTilesArchive('  /tiles/BASEMAP.PMTiles  ')).toBe(true)
    expect(isPMTilesArchive('https://tiles.openfreemap.org/styles/liberty')).toBe(false)
    expect(isPMTilesArchive('')).toBe(false)
  })
})

describe('vectorReachable', () => {
  it('accepts an archive that starts with the PMTiles magic', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(respond({ ok: true, body: PMTILES_MAGIC })),
    )
    await expect(vectorReachable('/basemap.pmtiles')).resolves.toBe(true)
  })

  // The failure this probe exists for: an SPA server answers an unknown path
  // with index.html and HTTP 200, so "the request succeeded" proves nothing.
  it('rejects an SPA HTML fallback served at 200', async () => {
    const html = new TextEncoder().encode('<!doctype ')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ ok: true, body: html })))
    await expect(vectorReachable('/basemap.pmtiles')).resolves.toBe(false)
  })

  it('requests only the first bytes of an archive', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond({ ok: true, body: PMTILES_MAGIC }))
    vi.stubGlobal('fetch', fetchMock)
    await vectorReachable('/basemap.pmtiles')

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Range).toBe('bytes=0-6')
  })

  it('takes a hosted style URL at its status code and reads no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ ok: true })))
    await expect(vectorReachable('https://tiles.openfreemap.org/styles/liberty')).resolves.toBe(
      true,
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond({ ok: false })))
    await expect(vectorReachable('https://tiles.openfreemap.org/styles/liberty')).resolves.toBe(
      false,
    )
  })

  it('is false rather than throwing when the network is gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(vectorReachable('/basemap.pmtiles')).resolves.toBe(false)
  })

  it('is false for no configured source at all', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(vectorReachable('   ')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('vectorStyle', () => {
  it('reads the archive through the pmtiles protocol', () => {
    const style = vectorStyle('dark', '/tiles/basemap.pmtiles')
    const source = style.sources.protomaps
    expect(source).toMatchObject({ type: 'vector', url: 'pmtiles:///tiles/basemap.pmtiles' })
  })

  // Every label needs a font stack fetched from somewhere, which is the exact
  // dependency a local archive exists to remove. Same rule noTilesStyle follows.
  it('needs no glyphs and no sprite, like the no-basemap style', () => {
    const style = vectorStyle('dark', '/tiles/basemap.pmtiles')
    expect(style.glyphs).toBeUndefined()
    expect(style.sprite).toBeUndefined()
    expect(noTilesStyle('dark').glyphs).toBeUndefined()

    for (const layer of style.layers) {
      expect(layer.type).not.toBe('symbol')
    }
  })

  it('keeps the range rings, so orientation survives a missing layer', () => {
    const style = vectorStyle('light', '/basemap.pmtiles')
    expect(style.sources.rings).toBeDefined()
    const ids = style.layers.map((layer) => layer.id)
    expect(ids).toContain('ring-circles')
    expect(ids).toContain('ring-spokes')
  })

  it('draws the basemap under the rings', () => {
    const ids = vectorStyle('dark', '/basemap.pmtiles').layers.map((layer) => layer.id)
    expect(ids.indexOf('water')).toBeLessThan(ids.indexOf('ring-circles'))
    expect(ids.indexOf('roads-major')).toBeLessThan(ids.indexOf('ring-circles'))
  })

  // Every source-layer below was read out of a real Protomaps extract with
  // `go-pmtiles tile`, not taken from the schema docs. The first version of
  // this style passed a typecheck and every other test here while drawing
  // arterials as hairlines and ferry routes as roads, because nothing compared
  // it against actual tile data.
  it('names only source-layers that a Protomaps basemap archive contains', () => {
    const present = new Set([
      'boundaries',
      'buildings',
      'earth',
      'landuse',
      'places',
      'pois',
      'roads',
      'water',
    ])
    const used = vectorStyle('dark', '/basemap.pmtiles')
      .layers.map((layer) => ('source-layer' in layer ? layer['source-layer'] : undefined))
      .filter((name): name is string => name !== undefined)

    expect(used.length).toBeGreaterThan(0)
    for (const name of used) {
      expect(present).toContain(name)
    }
  })

  it('splits roads by the kinds the tiles actually use', () => {
    const layers = vectorStyle('dark', '/basemap.pmtiles').layers
    const kindsOf = (id: string) => {
      const layer = layers.find((l) => l.id === id)
      return JSON.stringify(layer && 'filter' in layer ? layer.filter : null)
    }

    // major_road is a kind of its own; treating only `highway` as major left
    // every arterial hairline-thin.
    expect(kindsOf('roads-major')).toContain('major_road')
    expect(kindsOf('roads-major')).toContain('highway')

    // And the minor layer must enumerate, not negate: `kind != highway` is also
    // true of ferry, rail, path and aeroway.
    const minor = kindsOf('roads-minor')
    expect(minor).toContain('minor_road')
    for (const notARoad of ['ferry', 'rail', 'path', 'aeroway']) {
      expect(minor).not.toContain(notARoad)
    }
  })
})
