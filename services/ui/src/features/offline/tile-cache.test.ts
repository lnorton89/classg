import { describe, expect, it } from 'vitest'

import { isCacheableTileResponse } from './tile-cache'

function tile(
  status: number,
  headers: Record<string, string> = { 'Content-Type': 'image/jpeg' },
): Response {
  return new Response(status === 204 ? null : 'jpeg bytes', { status, headers })
}

describe('isCacheableTileResponse', () => {
  it('keeps a real tile', () => {
    expect(isCacheableTileResponse(tile(200))).toBe(true)
  })

  it('keeps a tile served from nginx or Esri with ordinary cache headers', () => {
    const response = tile(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=15552000',
      'X-ClassG-Basemap': 'Esri World Imagery (cached)',
    })
    expect(isCacheableTileResponse(response)).toBe(true)
  })

  /*
   * The whole reason this function exists. nginx's @empty_tile answers 200, so
   * status alone cannot tell it apart from imagery — and cached once, it is a
   * permanent hole in the map.
   */
  it('refuses nginx’s offline placeholder despite its 200', () => {
    const response = tile(200, {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store',
      'X-ClassG-Basemap': 'offline fallback',
    })
    expect(isCacheableTileResponse(response)).toBe(false)
  })

  it('refuses it on the header alone, if the no-store is ever dropped', () => {
    expect(isCacheableTileResponse(tile(200, { 'X-ClassG-Basemap': 'offline fallback' }))).toBe(
      false,
    )
  })

  it('refuses anything marked no-store, whatever served it', () => {
    expect(isCacheableTileResponse(tile(200, { 'Cache-Control': 'private, no-store' }))).toBe(
      false,
    )
  })

  it('refuses partial and error responses', () => {
    expect(isCacheableTileResponse(tile(206))).toBe(false)
    expect(isCacheableTileResponse(tile(404))).toBe(false)
    expect(isCacheableTileResponse(tile(500))).toBe(false)
  })
})
