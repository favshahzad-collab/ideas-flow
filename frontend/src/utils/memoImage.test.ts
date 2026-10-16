import { describe, expect, it } from 'vitest'

import { MEMO_BODY_LIMITS } from '../types/memo'
import {
  dataUriBytes,
  fitWithin,
  imageSize,
  isImageDataUri,
  pictureRoom,
  shareFor,
  tooLargePicture,
} from './memoImage'

/**
 * The arithmetic behind a picture in a memo: how heavy it is, how it is
 * scaled, how much of the column it takes, and when there is no room for
 * another. Pure, and tested as such; drawing a file smaller needs a browser
 * and is proven in one.
 */

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/** Base64 for `count` zero bytes, without building them. */
const zeros = (count: number): string => {
  const whole = 'AAAA'.repeat(Math.floor(count / 3))
  const tail = count % 3 === 1 ? 'AA==' : count % 3 === 2 ? 'AAA=' : ''
  return whole + tail
}

/** A PNG's opening: the signature and a real header; only the header is read. */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = 8
  bytes[25] = 2
  return `data:image/png;base64,${toBase64(bytes)}`
}

/** A JPEG's opening: SOI, an APP0 segment to step over, then a frame header. */
function jpeg(width: number, height: number): string {
  const bytes = new Uint8Array(2 + 18 + 11 + 8)
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0)
  const sof = 20
  bytes[sof] = 0xff
  bytes[sof + 1] = 0xc0
  const view = new DataView(bytes.buffer)
  view.setUint16(sof + 2, 9)
  bytes[sof + 4] = 8
  view.setUint16(sof + 5, height)
  view.setUint16(sof + 7, width)
  bytes[sof + 9] = 1
  return `data:image/jpeg;base64,${toBase64(bytes)}`
}

describe('what a picture weighs', () => {
  it('counts the bytes a data uri carries, padding and all', () => {
    expect(dataUriBytes(`data:image/png;base64,${zeros(300)}`)).toBe(300)
    expect(dataUriBytes(`data:image/jpeg;base64,${zeros(301)}`)).toBe(301)
    expect(dataUriBytes(`data:image/png;base64,${zeros(302)}`)).toBe(302)
  })

  it('weighs nothing that is not a picture the memo can carry', () => {
    expect(dataUriBytes('https://example.com/a.png')).toBe(0)
    expect(dataUriBytes('data:image/gif;base64,AAAA')).toBe(0)
    expect(isImageDataUri('data:image/png;base64,AAAA')).toBe(true)
    expect(isImageDataUri('data:image/svg+xml;base64,AAAA')).toBe(false)
  })
})

describe('reading a picture’s size from its header', () => {
  it('reads a PNG', () => {
    expect(imageSize(png(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('reads a JPEG, stepping over the segments before the frame', () => {
    expect(imageSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 })
  })

  it('gives up on what it cannot read', () => {
    expect(imageSize('data:image/png;base64,AAAA')).toBeNull()
    expect(imageSize('https://example.com/a.png')).toBeNull()
    expect(imageSize(`data:image/jpeg;base64,${toBase64(new Uint8Array([0xff, 0xd8, 0, 0]))}`)).toBeNull()
  })
})

describe('scaling', () => {
  it('leaves a picture that fits alone', () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900, scale: 1 })
  })

  it('brings the longest side down to the limit and keeps the proportions', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200, scale: 0.4 })
    expect(fitWithin(1000, 3200)).toEqual({ width: 500, height: 1600, scale: 0.5 })
  })

  it('takes the share of the column the renderer would give it', () => {
    // 400 pixels is 300 points; the column is 508.88.
    expect(shareFor(400, 508.88)).toBe(0.59)
    expect(shareFor(2000, 508.88)).toBe(1)
    expect(shareFor(40, 508.88)).toBe(0.2)
  })
})

describe('room for another picture', () => {
  const picture = (bytes: number) => ({
    type: 'image' as const,
    attrs: { src: `data:image/png;base64,${zeros(bytes)}` },
  })

  it('says yes while there is room', () => {
    expect(pictureRoom([picture(1000)], { count: 1, bytes: 1000 })).toBeNull()
  })

  it('refuses one picture too many, saying how many that would be', () => {
    const existing = Array.from({ length: MEMO_BODY_LIMITS.images }, () => picture(10))

    expect(pictureRoom(existing, { count: 1, bytes: 10 })).toBe(
      `That would make ${MEMO_BODY_LIMITS.images + 1} pictures; a memo can carry ${MEMO_BODY_LIMITS.images}. Attach the rest as supporting documents instead.`,
    )
  })

  it('refuses pictures that together weigh too much', () => {
    const heavy = picture(MEMO_BODY_LIMITS.imageBytes - 1000)
    const existing = [heavy, heavy, heavy]

    expect(pictureRoom(existing, { count: 1, bytes: MEMO_BODY_LIMITS.imageBytes - 1000 })).toMatch(
      /^The pictures would come to \d+ KB together; a memo can carry 1465 KB of pictures\./,
    )
  })

  it('refuses a single picture over the limit in the words the server uses', () => {
    expect(tooLargePicture(600_000)).toBe(
      'That picture is 586 KB; a memo picture can be 391 KB. Attach it as a supporting document instead.',
    )
  })
})
