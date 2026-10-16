export interface CroppedInk {
  dataUrl: string
  /** CSS pixels relative to the source canvas. */
  left: number
  top: number
  width: number
  height: number
}

/**
 * Crop non-transparent ink from a canvas to a PNG with a transparent background.
 * `left`/`top`/`width`/`height` are in CSS pixels (device pixels divided by DPR).
 */
export function cropInkFromCanvas(
  canvas: HTMLCanvasElement,
  paddingCss = 8,
): CroppedInk | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const { width, height } = canvas
  if (width === 0 || height === 0) return null

  const imageData = ctx.getImageData(0, 0, width, height)
  const { data } = imageData

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha === 0) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  if (maxX < minX || maxY < minY) return null

  /*
   * `|| 1` never fired for the case it was written for.
   *
   * `offsetWidth` is 0 for a canvas inside a hidden or not-yet-measured
   * container, and `width / 0` is Infinity - which is truthy, so the guard
   * waved it through. The crop then came back as a zero-sized box with a
   * full-canvas dataUrl: an invisible signature placed at the origin of the
   * page, which is worse than refusing to crop at all.
   */
  const measured = canvas.offsetWidth
  const dpr =
    measured > 0 && Number.isFinite(width / measured) ? width / measured : 1
  const pad = Math.round(paddingCss * dpr)
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(width - 1, maxX + pad)
  maxY = Math.min(height - 1, maxY + pad)

  const cropWidth = maxX - minX + 1
  const cropHeight = maxY - minY + 1

  const cropped = document.createElement('canvas')
  cropped.width = cropWidth
  cropped.height = cropHeight
  const croppedCtx = cropped.getContext('2d')
  if (!croppedCtx) return null

  croppedCtx.putImageData(ctx.getImageData(minX, minY, cropWidth, cropHeight), 0, 0)

  return {
    dataUrl: cropped.toDataURL('image/png'),
    left: minX / dpr,
    top: minY / dpr,
    width: cropWidth / dpr,
    height: cropHeight / dpr,
  }
}
