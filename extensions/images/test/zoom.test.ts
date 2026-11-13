import { expect, it } from 'vitest'
import { clampPan, FIT, MAX_SCALE, toggleAt, zoomAt } from '../src/zoom.ts'

// An 800×600 image fitted on a 1000×800 stage.
const bounds = { width: 800, height: 600, stageWidth: 1000, stageHeight: 800 }

it('zooms in where you click, and back out to fit', () => {
  const zoomed = toggleAt(FIT, { x: 200, y: 100 }, bounds)
  expect(zoomed.scale).toBe(2.5)
  // The point clicked stays under the cursor: 200 = x + 2.5 × (200 − 0) / 1 … so x = 200 − 500.
  expect(zoomed).toEqual({ scale: 2.5, x: -300, y: -150 })
  expect(toggleAt(zoomed, { x: 0, y: 0 }, bounds)).toEqual(FIT)
})

it('keeps the image on the stage, and its scale between fitted and the most', () => {
  expect(zoomAt(FIT, 100, { x: 0, y: 0 }, bounds).scale).toBe(MAX_SCALE)
  expect(zoomAt({ scale: 2, x: 0, y: 0 }, 0.2, { x: 0, y: 0 }, bounds)).toEqual(FIT)
  // At 2×, the image is 1600×1200: it may pan 300 either way across, 200 up or down.
  expect(clampPan({ scale: 2, x: 999, y: -999 }, bounds)).toEqual({ scale: 2, x: 300, y: -200 })
  // Still smaller than the stage: centred.
  expect(clampPan({ scale: 1.1, x: 50, y: 50 }, bounds)).toEqual({ scale: 1.1, x: 0, y: 0 })
})
