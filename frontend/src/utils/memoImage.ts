import type { MemoBlockNode } from '../types/memo'
import { MEMO_BODY_LIMITS } from '../types/memo'

/**
 * Pictures for a memo: what may go in, and getting one ready to.
 *
 * A picture travels inside the body as a data URI, so the body's size is the
 * memo's size and the server bounds it hard (`MEMO_BODY_LIMITS`). Most of
 * what a person has to hand is a photograph from a phone - several thousand
 * pixels across, several megabytes - and a memo needs neither. So a picture
 * is made ready before it is offered: scaled to fit the longest side the
 * page can use, and re-encoded only when that was needed. What still does
 * not fit is refused with its size, and the advice every other limit gives:
 * attach it as a supporting document instead.
 *
 * The pure parts are here to be tested; `prepareImage` needs a browser.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const

/**
 * The longest side a memo picture keeps, in pixels.
 *
 * The text column is 508.88 points - about 680 pixels at 96 to the inch and
 * twice that on a sharp screen or a printer. 1600 keeps a photograph crisp
 * on the page at a fraction of its size from the camera.
 */
export const MAX_SIDE = 1600

/** JPEG quality when a picture has to be re-encoded. */
const JPEG_QUALITY = 0.85

const DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/

export const isImageDataUri = (src: string): boolean => DATA_URI.test(src)

/** How many bytes a data URI carries: four characters to three bytes, less the padding. */
export function dataUriBytes(src: string): number {
  const match = DATA_URI.exec(src)
  if (!match) return 0
  const data = match[2]!
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

/** The size a picture is scaled to so that neither side exceeds `max`. */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_SIDE,
): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height, scale: 1 }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`

/** The refusal for a picture over the limit, in the same words the server uses. */
export const tooLargePicture = (bytes: number): string =>
  `That picture is ${kb(bytes)}; a memo picture can be ${kb(MEMO_BODY_LIMITS.imageBytes)}. Attach it as a supporting document instead.`

export const WRONG_KIND =
  'Only a PNG or a JPEG can go in a memo. Save the picture as one of those first.'

export const IN_A_TABLE =
  'A picture cannot go inside a table. Put the caret below the table and add it there.'

export const countPictures = (blocks: MemoBlockNode[]): number =>
  blocks.filter(block => block.type === 'image').length

export const pictureBytes = (blocks: MemoBlockNode[]): number =>
  blocks.reduce(
    (total, block) => total + (block.type === 'image' ? dataUriBytes(block.attrs.src) : 0),
    0,
  )

/**
 * Why more pictures cannot go in, or null when they can: `adding` more
 * pictures weighing `bytes` to a body that already holds `existing`.
 */
export function pictureRoom(
  existing: MemoBlockNode[],
  adding: { count: number; bytes: number },
): string | null {
  const count = countPictures(existing) + adding.count
  if (count > MEMO_BODY_LIMITS.images) {
    return `That would make ${count} pictures; a memo can carry ${MEMO_BODY_LIMITS.images}. Attach the rest as supporting documents instead.`
  }
  const bytes = pictureBytes(existing) + adding.bytes
  if (bytes > MEMO_BODY_LIMITS.imageTotalBytes) {
    return `The pictures would come to ${kb(bytes)} together; a memo can carry ${kb(MEMO_BODY_LIMITS.imageTotalBytes)} of pictures. Attach some as supporting documents instead.`
  }
  return null
}

/**
 * The pixel size a data URI's picture declares, read from its header.
 *
 * Read rather than measured so it is known synchronously, before any
 * picture is loaded: a pasted picture is sized at the paste. A PNG keeps it
 * in the first chunk; a JPEG in whichever frame segment comes first.
 */
export function imageSize(src: string): { width: number; height: number } | null {
  const match = DATA_URI.exec(src)
  if (!match) return null

  // Only the head is needed; a JPEG's frame header sits within a few
  // kilobytes, after the thumbnails and profiles cameras write first.
  const head = match[2]!.slice(0, 96_000)
  const bytes = Uint8Array.from(atob(head.slice(0, head.length - (head.length % 4))), c =>
    c.charCodeAt(0),
  )
  const at = (index: number): number => bytes[index] ?? 0
  const u16 = (index: number): number => (at(index) << 8) | at(index + 1)
  const u32 = (index: number): number =>
    ((at(index) << 24) | (at(index + 1) << 16) | (at(index + 2) << 8) | at(index + 3)) >>> 0

  if (match[1] === 'png') {
    if (bytes.length < 24) return null
    const width = u32(16)
    const height = u32(20)
    return width > 0 && height > 0 ? { width, height } : null
  }

  let offset = 2
  while (offset + 9 < bytes.length) {
    if (at(offset) !== 0xff) return null
    const marker = at(offset + 1)
    if (marker === 0xff) {
      offset += 1
      continue
    }
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      const height = u16(offset + 5)
      const width = u16(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + u16(offset + 2)
  }
  return null
}

/**
 * The share of the text column a picture takes when nobody has sized it:
 * its own width at 96 pixels to the inch (0.75 points a pixel), never more
 * than the column, and never so small it cannot be seen. The same rule the
 * renderer applies, worked out here so the screen and the page agree.
 */
export function shareFor(widthPx: number, textWidth: number): number {
  const share = (widthPx * 0.75) / textWidth
  return Math.min(1, Math.max(0.2, Number(share.toFixed(2))))
}

export type PreparedImage =
  | { src: string; width: number; height: number; refusal?: undefined }
  | { refusal: string; src?: undefined }

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'))
    reader.readAsDataURL(blob)
  })

const toBlob = (canvas: HTMLCanvasElement, type: string): Promise<Blob | null> =>
  new Promise(resolve => canvas.toBlob(resolve, type, JPEG_QUALITY))

/**
 * A file as the data URI a memo carries, resized if it needs to be.
 *
 * A picture already small enough is taken as it is - its bytes, not a
 * re-encoding of them, so nothing is lost for no reason. One too large on a
 * side is drawn smaller; one still too heavy as a PNG (a photograph saved
 * as one) is tried as a JPEG, which is what a photograph should have been.
 * Then it is either within the limit or refused with its size.
 */
export async function prepareImage(file: Blob & { type: string }): Promise<PreparedImage> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { refusal: WRONG_KIND }

  const bitmap = await createImageBitmap(file)
  try {
    const fitted = fitWithin(bitmap.width, bitmap.height)

    if (fitted.scale === 1 && file.size <= MEMO_BODY_LIMITS.imageBytes) {
      return { src: await readAsDataUrl(file), width: bitmap.width, height: bitmap.height }
    }

    const canvas = document.createElement('canvas')
    canvas.width = fitted.width
    canvas.height = fitted.height
    const context = canvas.getContext('2d')
    if (!context) return { refusal: 'The picture could not be drawn; try a different one.' }
    context.drawImage(bitmap, 0, 0, fitted.width, fitted.height)

    let blob = await toBlob(canvas, file.type)
    if (blob && blob.size > MEMO_BODY_LIMITS.imageBytes && file.type === 'image/png') {
      blob = await toBlob(canvas, 'image/jpeg')
    }
    if (!blob) return { refusal: 'The picture could not be drawn; try a different one.' }
    if (blob.size > MEMO_BODY_LIMITS.imageBytes) return { refusal: tooLargePicture(blob.size) }

    return { src: await readAsDataUrl(blob), width: fitted.width, height: fitted.height }
  } finally {
    bitmap.close()
  }
}
