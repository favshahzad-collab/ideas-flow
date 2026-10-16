import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cropInkFromCanvas } from './inkCrop'

/**
 * Trimming a signature out of the transparent canvas somebody drew on. Two
 * numbers here end up stamped onto a legal document: the box the ink is
 * cropped to, and the position that box is reported at. Crop too tight and a
 * signature loses its tail; report the position in the wrong unit and the
 * signature lands somewhere else on the page than where the person drew it.
 *
 * jsdom has no canvas, so both canvases are fakes: the source one is handed
 * in, and the output one is intercepted at `document.createElement` because
 * the function makes it itself.
 */

interface Pixel {
  x: number
  y: number
  /** Defaults to fully opaque; a low value is an antialiased stroke edge. */
  alpha?: number
}

/**
 * An ImageData-shaped object. `tint` fills the three colour bytes of every
 * pixel, ink or not, so a test can prove the crop reads alpha and not one of
 * the channels sitting next to it in the quad.
 */
function imageDataFor(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
  tint: number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      data[at] = tint
      data[at + 1] = tint
      data[at + 2] = tint
      data[at + 3] = alphaAt(x, y)
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as ImageData
}

interface SourceOptions {
  /** Device pixels. */
  width?: number
  height?: number
  /** CSS pixels the canvas occupies on screen; width / this is the DPR. */
  offsetWidth?: number
  ink?: Pixel[]
  hasContext?: boolean
  /** Colour written into R, G and B of every pixel, painted or not. */
  tint?: number
}

function sourceCanvas({
  width = 100,
  height = 50,
  offsetWidth = width,
  ink = [],
  hasContext = true,
  tint = 0,
}: SourceOptions = {}) {
  const alphaAt = (x: number, y: number) => {
    const hit = ink.find(pixel => pixel.x === x && pixel.y === y)
    return hit ? (hit.alpha ?? 255) : 0
  }

  const context = {
    getImageData: vi.fn((sx: number, sy: number, sw: number, sh: number) =>
      imageDataFor(sw, sh, (x, y) => alphaAt(sx + x, sy + y), tint),
    ),
    putImageData: vi.fn(),
  }

  const canvas = {
    width,
    height,
    offsetWidth,
    getContext: vi.fn(() => (hasContext ? context : null)),
  }

  return { canvas: canvas as unknown as HTMLCanvasElement, context }
}

/**
 * Stands in for the canvas the crop allocates for its output. Every other tag
 * still goes to the real jsdom implementation, so nothing else in the test
 * environment is disturbed.
 */
function interceptOutputCanvas({ hasContext = true } = {}) {
  /**
   * Every step the crop takes on its output canvas, in the order it took it.
   * Sizing a canvas clears it and reading it back is a snapshot, so the final
   * width/height alone cannot tell a correct sequence from a blank PNG.
   */
  const steps: string[] = []
  let width = -1
  let height = -1

  const context = {
    putImageData: vi.fn(() => {
      steps.push('putImageData')
    }),
  }
  const output = {
    get width() {
      return width
    },
    set width(value: number) {
      width = value
      steps.push(`width=${value}`)
    },
    get height() {
      return height
    },
    set height(value: number) {
      height = value
      steps.push(`height=${value}`)
    },
    getContext: vi.fn(() => (hasContext ? context : null)),
    toDataURL: vi.fn(() => {
      steps.push('toDataURL')
      return 'data:image/png;base64,CROPPED'
    }),
  }

  const createReal = document.createElement.bind(document)
  const createElement = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tag: string, options?: ElementCreationOptions) =>
      tag === 'canvas'
        ? (output as unknown as HTMLCanvasElement)
        : createReal(tag, options)) as typeof document.createElement)

  return { output, context, createElement, steps }
}

let out: ReturnType<typeof interceptOutputCanvas>

beforeEach(() => {
  out = interceptOutputCanvas()
})

describe('cropInkFromCanvas', () => {
  it('returns nothing for a canvas nobody has drawn on', () => {
    const { canvas } = sourceCanvas({ ink: [] })

    // Null is the signal the caller uses to say "you have not signed yet". A
    // 1x1 transparent PNG instead would sail through submission as a
    // signature that shows nothing on the document.
    expect(cropInkFromCanvas(canvas)).toBeNull()
    // ...and no canvas was allocated to hold that nothing.
    expect(out.createElement).not.toHaveBeenCalledWith('canvas')
  })

  it('wraps a single dot of ink in the requested padding', () => {
    const { canvas, context } = sourceCanvas({ ink: [{ x: 50, y: 25 }] })

    const cropped = cropInkFromCanvas(canvas, 8)

    // One pixel plus 8 either side is 17 across, anchored 8 up and left of it.
    expect(cropped).toEqual({
      dataUrl: 'data:image/png;base64,CROPPED',
      left: 42,
      top: 17,
      width: 17,
      height: 17,
    })
    expect(out.output.width).toBe(17)
    expect(out.output.height).toBe(17)
    // Sizing a canvas clears it and toDataURL is a snapshot, so the order is
    // the behaviour: size, paint, then read. Any other order exports a blank
    // PNG that still has the right dimensions and the right shape of result.
    expect(out.steps).toEqual(['width=17', 'height=17', 'putImageData', 'toDataURL'])
    expect(context.getImageData).toHaveBeenLastCalledWith(42, 17, 17, 17)
    // The pixels painted are the cropped region, not the whole source canvas
    // dumped at 0,0 - which would place the ink back where it started and
    // clip everything below and right of the crop box.
    expect(out.context.putImageData).toHaveBeenCalledWith(
      expect.objectContaining({ width: 17, height: 17 }),
      0,
      0,
    )
  })

  it('pads by 8 CSS pixels when the caller does not say', () => {
    const { canvas } = sourceCanvas({ ink: [{ x: 50, y: 25 }] })

    // Every caller in the app takes this default. A signature cropped flush
    // to its own ink has no room for the descender on a "g" once the box is
    // scaled onto the page.
    expect(cropInkFromCanvas(canvas)).toMatchObject({
      left: 42,
      top: 17,
      width: 17,
      height: 17,
    })
  })

  it('exports PNG, the only format that keeps the paper behind the ink', () => {
    const { canvas } = sourceCanvas({ ink: [{ x: 50, y: 25 }] })

    cropInkFromCanvas(canvas)

    // JPEG has no alpha, so the transparent surround would flatten to a black
    // rectangle stamped across the document under the signature.
    expect(out.output.toDataURL).toHaveBeenCalledWith('image/png')
  })

  it('clamps the padding at the top-left corner instead of asking for pixels off the canvas', () => {
    const { canvas, context } = sourceCanvas({ ink: [{ x: 0, y: 0 }] })

    const cropped = cropInkFromCanvas(canvas, 8)

    // Unclamped this would be (-8, -8): a negative origin either throws in
    // the browser or silently returns transparent rows, and the reported
    // position would push the signature off the top of the page.
    expect(context.getImageData).toHaveBeenLastCalledWith(0, 0, 9, 9)
    expect(cropped).toMatchObject({ left: 0, top: 0, width: 9, height: 9 })
  })

  it('clamps the padding at the bottom-right corner', () => {
    const { canvas, context } = sourceCanvas({ width: 100, height: 50, ink: [{ x: 99, y: 49 }] })

    const cropped = cropInkFromCanvas(canvas, 8)!

    // The crop must stay inside the canvas it came from, or the signature box
    // reported to the PDF hangs past the edge of the page. Asserting only
    // that left + width lands on 100 is satisfied by giving up and returning
    // the whole canvas (0 + 100), which would stamp the entire signing
    // surface onto the document instead of the ink.
    expect(cropped).toMatchObject({ left: 91, top: 41, width: 9, height: 9 })
    expect(context.getImageData).toHaveBeenLastCalledWith(91, 41, 9, 9)
  })

  it('clamps on all four sides when the padding is wider than the canvas', () => {
    const { canvas, context } = sourceCanvas({ width: 100, height: 50, ink: [{ x: 50, y: 25 }] })

    const cropped = cropInkFromCanvas(canvas, 500)

    // Both clamps have to hold at once. Unclamped this asks for
    // (-450, -475, 1001, 1001): in a real browser the rows outside the
    // canvas come back transparent, so the "signature" would be a mostly
    // empty image a thousand pixels across, reported at a negative origin.
    expect(cropped).toMatchObject({ left: 0, top: 0, width: 100, height: 50 })
    expect(context.getImageData).toHaveBeenLastCalledWith(0, 0, 100, 50)
  })

  it('reports the box in CSS pixels, so a retina canvas is not double size', () => {
    // 200 device pixels shown across 100 CSS pixels is a DPR of 2.
    const { canvas } = sourceCanvas({
      width: 200,
      height: 120,
      offsetWidth: 100,
      ink: [{ x: 100, y: 60 }],
    })

    const cropped = cropInkFromCanvas(canvas, 8)!

    // Padding scales with the DPR too - 8 CSS pixels is 16 device pixels -
    // so the box is 33 device pixels, reported as 16.5 CSS pixels.
    expect(cropped).toMatchObject({ left: 42, top: 22, width: 16.5, height: 16.5 })
    // The exported image keeps full device resolution; halving it here as
    // well would print a blurry signature.
    expect(out.output.width).toBe(33)
    expect(out.output.height).toBe(33)
  })

  it('keeps every mark, not just the last stroke', () => {
    const { canvas } = sourceCanvas({
      ink: [
        { x: 10, y: 10 },
        { x: 80, y: 40 },
      ],
    })

    const cropped = cropInkFromCanvas(canvas, 2)!

    // A signature with a separate dot on the "i", or a crossed "t", must come
    // out whole. A box around only one mark loses part of somebody's name.
    expect(cropped).toMatchObject({ left: 8, top: 8, width: 75, height: 35 })
  })

  it('counts a barely-visible antialiased edge as ink', () => {
    const { canvas } = sourceCanvas({
      ink: [
        { x: 50, y: 25 },
        { x: 60, y: 25, alpha: 1 },
      ],
    })

    const cropped = cropInkFromCanvas(canvas, 0)!

    // Stroke edges are drawn at low alpha. Treating anything under a
    // threshold as empty would shave the soft outside off every letter.
    expect(cropped).toMatchObject({ left: 50, top: 25, width: 11, height: 1 })
  })

  it('finds the ink by its alpha channel and not by its colour', () => {
    // Every pixel on this canvas is white; only one of them has actually been
    // painted. A signature canvas really does look like this - the ink is
    // dark on a transparent ground, and the untouched pixels still carry
    // whatever colour bytes the buffer was left with.
    const { canvas } = sourceCanvas({ tint: 255, ink: [{ x: 50, y: 25 }] })

    // Reading any byte of the quad but the fourth finds "ink" in all 5000
    // pixels, and the crop becomes the whole signing surface: a grey
    // rectangle the width of the box, stamped over the document.
    expect(cropInkFromCanvas(canvas, 0)).toMatchObject({
      left: 50,
      top: 25,
      width: 1,
      height: 1,
    })
  })

  it('crops to the ink exactly when no padding is asked for', () => {
    const { canvas } = sourceCanvas({ ink: [{ x: 50, y: 25 }] })

    expect(cropInkFromCanvas(canvas, 0)).toMatchObject({
      left: 50,
      top: 25,
      width: 1,
      height: 1,
    })
  })

  it('returns nothing for a canvas with no area, without asking it for pixels', () => {
    const { canvas, context } = sourceCanvas({ width: 0, height: 0, offsetWidth: 0 })

    expect(cropInkFromCanvas(canvas)).toBeNull()
    // getImageData on a zero-width region throws IndexSizeError in a real
    // browser, which would surface as a broken Confirm rather than "no ink".
    expect(context.getImageData).not.toHaveBeenCalled()
  })

  it('returns nothing when the canvas has no 2d context', () => {
    const { canvas } = sourceCanvas({ ink: [{ x: 50, y: 25 }], hasContext: false })

    // Happens when the browser has run out of canvas contexts. Better a
    // "please sign" than a thrown error inside the submit handler.
    expect(cropInkFromCanvas(canvas)).toBeNull()
    // And it gives up before allocating a second canvas, which is the last
    // thing to do when the browser has just refused to give you a context.
    expect(out.createElement).not.toHaveBeenCalledWith('canvas')
  })

  it('returns nothing when the output canvas has no 2d context', () => {
    out.createElement.mockRestore()
    out = interceptOutputCanvas({ hasContext: false })
    const { canvas } = sourceCanvas({ ink: [{ x: 50, y: 25 }] })

    // Without this guard the caller would get a dataUrl read off a canvas
    // that was never painted - a blank signature on a signed document.
    expect(cropInkFromCanvas(canvas)).toBeNull()
    // Bailing out is only half of it: nothing may be exported either, or a
    // later change that returned the url anyway would still look correct.
    expect(out.output.toDataURL).not.toHaveBeenCalled()
    expect(out.steps).not.toContain('putImageData')
  })

  it('does not report a zero-sized signature for a canvas that has not been laid out', () => {
    // offsetWidth is 0 for a canvas inside a hidden or not-yet-measured
    // container. `width / 0` is Infinity, and `Infinity || 1` keeps it, so
    // the `|| 1` guard never fires for the case it was written for.
    const { canvas } = sourceCanvas({ offsetWidth: 0, ink: [{ x: 50, y: 25 }] })

    const cropped = cropInkFromCanvas(canvas)

    // Today this returns width: 0, height: 0 with a full-canvas dataUrl - an
    // invisible signature placed at the origin. Either answer below is safe;
    // a zero-sized box is not.
    expect(cropped === null || cropped.width > 0).toBe(true)
  })
})
