import { describe, expect, it } from 'vitest'
import {
  MAX_SIGNATURE_HEIGHT_PDF,
  MAX_SIGNATURE_WIDTH_PDF,
  MIN_SIGNATURE_HEIGHT_PDF,
  MIN_SIGNATURE_WIDTH_PDF,
  SIGNATURE_HEIGHT_PDF,
  SIGNATURE_WIDTH_PDF,
  clickToPdfPlacement,
  pdfPlacementToScreen,
  resizePdfPlacement,
  screenRectToPdfPlacement,
} from './pdfCoordinates'

/** A4 at 72dpi, rendered at 1.5x. */
const PDF_W = 595
const PDF_H = 842
const DISP_W = 892.5
const DISP_H = 1263

describe('clickToPdfPlacement', () => {
  it('centres the box on the click', () => {
    const p = clickToPdfPlacement(DISP_W / 2, DISP_H / 2, DISP_W, DISP_H, PDF_W, PDF_H)

    expect(p.signatureX + p.signatureWidth / 2).toBeCloseTo(PDF_W / 2, 6)
    expect(p.signatureY + p.signatureHeight / 2).toBeCloseTo(PDF_H / 2, 6)
    expect(p.signatureWidth).toBe(SIGNATURE_WIDTH_PDF)
    expect(p.signatureHeight).toBe(SIGNATURE_HEIGHT_PDF)
  })

  it('keeps the box on the page when clicked at a corner', () => {
    for (const [x, y] of [
      [0, 0],
      [DISP_W, DISP_H],
      [0, DISP_H],
      [DISP_W, 0],
    ]) {
      const p = clickToPdfPlacement(x, y, DISP_W, DISP_H, PDF_W, PDF_H)

      expect(p.signatureX).toBeGreaterThanOrEqual(0)
      expect(p.signatureY).toBeGreaterThanOrEqual(0)
      expect(p.signatureX + p.signatureWidth).toBeLessThanOrEqual(PDF_W)
      expect(p.signatureY + p.signatureHeight).toBeLessThanOrEqual(PDF_H)
    }
  })
})

describe('pdfPlacementToScreen', () => {
  it('round-trips a click back to the point it came from', () => {
    const clickX = 300
    const clickY = 500
    const placement = clickToPdfPlacement(clickX, clickY, DISP_W, DISP_H, PDF_W, PDF_H)
    const screen = pdfPlacementToScreen(placement, DISP_W, DISP_H, PDF_W, PDF_H)

    expect(screen.left + screen.width / 2).toBeCloseTo(clickX, 6)
    expect(screen.top + screen.height / 2).toBeCloseTo(clickY, 6)
  })
})

describe('screenRectToPdfPlacement', () => {
  it('scales a drawn rectangle into PDF points', () => {
    const p = screenRectToPdfPlacement(0, 0, DISP_W / 2, DISP_H / 4, DISP_W, DISP_H, PDF_W, PDF_H, 3)

    expect(p.page).toBe(3)
    expect(p.signatureX).toBeCloseTo(0, 6)
    expect(p.signatureY).toBeCloseTo(0, 6)
    expect(p.signatureWidth).toBeCloseTo(PDF_W / 2, 6)
    expect(p.signatureHeight).toBeCloseTo(PDF_H / 4, 6)
  })

  it('clamps a rectangle dragged past the page edge', () => {
    const p = screenRectToPdfPlacement(
      DISP_W - 20, DISP_H - 20, 400, 400,
      DISP_W, DISP_H, PDF_W, PDF_H, 1,
    )

    expect(p.signatureX + p.signatureWidth).toBeLessThanOrEqual(PDF_W + 1e-9)
    expect(p.signatureY + p.signatureHeight).toBeLessThanOrEqual(PDF_H + 1e-9)
  })
})

describe('resizePdfPlacement', () => {
  const base = {
    page: 1,
    signatureX: 200,
    signatureY: 300,
    signatureWidth: SIGNATURE_WIDTH_PDF,
    signatureHeight: SIGNATURE_HEIGHT_PDF,
  }

  it('anchors the opposite corner when dragging `se`', () => {
    const next = resizePdfPlacement(base, 'se', 400, 400, PDF_W, PDF_H)

    expect(next.signatureX).toBeCloseTo(base.signatureX, 6)
    expect(next.signatureY).toBeCloseTo(base.signatureY, 6)
  })

  it('anchors the opposite corner when dragging `nw`', () => {
    const next = resizePdfPlacement(base, 'nw', 150, 250, PDF_W, PDF_H)

    expect(next.signatureX + next.signatureWidth).toBeCloseTo(
      base.signatureX + base.signatureWidth,
      6,
    )
    expect(next.signatureY + next.signatureHeight).toBeCloseTo(
      base.signatureY + base.signatureHeight,
      6,
    )
  })

  it('preserves aspect ratio by default so a signature is never stretched', () => {
    const aspect = base.signatureWidth / base.signatureHeight

    for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
      const next = resizePdfPlacement(base, handle, 480, 620, PDF_W, PDF_H)
      expect(next.signatureWidth / next.signatureHeight).toBeCloseTo(aspect, 6)
    }
  })

  it('lets the box stretch when the aspect lock is off', () => {
    const next = resizePdfPlacement(base, 'se', 400, 700, PDF_W, PDF_H, false)

    expect(next.signatureWidth / next.signatureHeight).not.toBeCloseTo(
      base.signatureWidth / base.signatureHeight,
      2,
    )
  })

  it('never shrinks below the minimum, however far the pointer is dragged', () => {
    for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
      const next = resizePdfPlacement(base, handle, base.signatureX, base.signatureY, PDF_W, PDF_H)

      expect(next.signatureWidth).toBeGreaterThanOrEqual(MIN_SIGNATURE_WIDTH_PDF - 1e-9)
      expect(next.signatureHeight).toBeGreaterThanOrEqual(MIN_SIGNATURE_HEIGHT_PDF - 1e-9)
    }
  })

  it('never grows past the maximum or off the page', () => {
    for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
      const next = resizePdfPlacement(base, handle, 5000, 5000, PDF_W, PDF_H, false)

      expect(next.signatureWidth).toBeLessThanOrEqual(MAX_SIGNATURE_WIDTH_PDF + 1e-9)
      expect(next.signatureHeight).toBeLessThanOrEqual(MAX_SIGNATURE_HEIGHT_PDF + 1e-9)
      expect(next.signatureX).toBeGreaterThanOrEqual(0)
      expect(next.signatureY).toBeGreaterThanOrEqual(0)
      expect(next.signatureX + next.signatureWidth).toBeLessThanOrEqual(PDF_W + 1e-9)
      expect(next.signatureY + next.signatureHeight).toBeLessThanOrEqual(PDF_H + 1e-9)
    }
  })

  it('keeps the page number it was given', () => {
    expect(resizePdfPlacement({ ...base, page: 7 }, 'se', 400, 400, PDF_W, PDF_H).page).toBe(7)
  })

  it('falls back to the default aspect when the box has no height', () => {
    const flat = { ...base, signatureHeight: 0 }
    const next = resizePdfPlacement(flat, 'se', 400, 400, PDF_W, PDF_H)

    expect(next.signatureWidth / next.signatureHeight).toBeCloseTo(
      SIGNATURE_WIDTH_PDF / SIGNATURE_HEIGHT_PDF,
      6,
    )
  })
})
