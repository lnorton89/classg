import { describe, expect, it } from 'vitest'

import {
  polylinePoints,
  projectPath,
  simplifyPath,
  type PathShape,
  type Point,
} from './path-shape'

const BOX = { width: 72, height: 28, padding: 3 }
const CENTRE: Point = { x: 36, y: 14 }

/** Non-null assertions are banned in this codebase, so failures throw here. */
function at(shape: PathShape | null, index: number): Point {
  const point = shape?.path[index]
  if (!point) throw new Error(`projectPath produced no point ${index}`)
  return point
}

describe('simplifyPath', () => {
  it('leaves a short path alone', () => {
    const points = [1, 2, 3]
    expect(simplifyPath(points, 64)).toBe(points)
  })

  it('decimates a long path and always keeps the last point', () => {
    const points = Array.from({ length: 4096 }, (_, i) => i)
    const kept = simplifyPath(points, 64)
    expect(kept.length).toBeLessThanOrEqual(64)
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(4095)
  })

  it('keeps the path in flight order', () => {
    const kept = simplifyPath(
      Array.from({ length: 500 }, (_, i) => i),
      16,
    )
    expect([...kept].sort((a, b) => a - b)).toEqual(kept)
  })
})

describe('projectPath', () => {
  it('is null for fewer than two points', () => {
    // A single dot in a column headed "Path" reads as a rendering fault.
    expect(projectPath([], BOX)).toBeNull()
    expect(projectPath([{ lat: 51.5, lon: -0.1 }], BOX)).toBeNull()
  })

  it('centres on the receiver when there is one', () => {
    const receiver = { lat: 51.5, lon: -0.1 }
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.51, lon: -0.09 },
      ],
      { ...BOX, receiver },
    )
    expect(shape?.receiver).toEqual(CENTRE)
    // The point AT the receiver lands dead centre, which is what makes two
    // thumbnails of the same aircraft comparable by extent.
    expect(at(shape, 0)).toEqual(CENTRE)
  })

  it('bbox-fits when no receiver is configured', () => {
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.51, lon: -0.09 },
      ],
      BOX,
    )
    expect(shape?.receiver).toBeNull()
    const first = at(shape, 0)
    const last = at(shape, 1)
    expect((first.x + last.x) / 2).toBeCloseTo(CENTRE.x, 5)
    expect((first.y + last.y) / 2).toBeCloseTo(CENTRE.y, 5)
  })

  it('keeps north up: a northward leg moves UP the SVG', () => {
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.52, lon: -0.1 },
      ],
      BOX,
    )
    expect(at(shape, 1).y).toBeLessThan(at(shape, 0).y)
  })

  it('uses one scale for both axes, so the shape is not stretched to fill the box', () => {
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.5, lon: -0.05 },
      ],
      BOX,
    )
    expect(Math.abs(at(shape, 1).y - at(shape, 0).y)).toBeCloseTo(0, 5)
    // Fits the SHORTER dimension minus padding, because the scale is shared —
    // stretching it to the full 72 px width would make an east-west leg look
    // longer than an identical north-south one.
    expect(Math.abs(at(shape, 1).x - at(shape, 0).x)).toBeCloseTo(
      BOX.height - 2 * BOX.padding,
      5,
    )
  })

  it('collapses a stationary contact to the centre rather than dividing by zero', () => {
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.5, lon: -0.1 },
      ],
      BOX,
    )
    expect(shape?.path).toEqual([CENTRE, CENTRE])
  })

  it('places the operator inside the same projection', () => {
    const shape = projectPath(
      [
        { lat: 51.5, lon: -0.1 },
        { lat: 51.52, lon: -0.1 },
      ],
      { ...BOX, operator: { lat: 51.5, lon: -0.1 } },
    )
    expect(shape?.operator).toEqual(at(shape, 0))
  })
})

describe('polylinePoints', () => {
  it('renders an SVG points attribute rounded to a tenth of a pixel', () => {
    expect(
      polylinePoints([
        { x: 1.234, y: 5.678 },
        { x: 10, y: 20 },
      ]),
    ).toBe('1.2,5.7 10,20')
  })
})
