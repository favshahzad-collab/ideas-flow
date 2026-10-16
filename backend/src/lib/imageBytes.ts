import { errors } from "./errors";

/**
 * Is this actually a PNG or a JPEG, and a sane one?
 *
 * pdf-lib decodes images in pure JavaScript, on the one thread that serves
 * every request. Handed bytes that only claim to be a PNG it does not fail
 * fast: a chunk header declaring a length that runs past the end of the
 * buffer, or an IHDR claiming 60,000 x 60,000 pixels, sends the decoder into
 * work that is measured in minutes or never finishes at all - and while it is
 * in there, nothing else in the application runs. Every signature on every
 * memo comes from a request body, so that is a denial of service any signed-in
 * account can cause by pasting a bad data URL.
 *
 * So the bytes are walked here first, structurally, before any decoder sees
 * them. This walk is bounded by construction: it only ever moves forward, each
 * step is checked against the length of the buffer, and the number of steps is
 * capped. It is not a decoder and deliberately does not decode - it reads
 * headers and lengths and refuses anything that does not add up.
 *
 * The other half of the fix is telling the caller WHICH format it is, so the
 * embed happens once against the right decoder. The old code tried `embedPng`
 * and fell back to `embedJpg` in a catch, which handed malformed bytes to both
 * of them.
 */

export type ImageKind = "png" | "jpeg";

/**
 * The bytes a `data:image/png;base64,` or `data:image/jpeg;base64,` URI
 * carries, or null when the string is not one. How a picture travels inside
 * a memo body: the body is then complete in itself, and drawing it needs no
 * store and no network.
 */
export function bytesOfImageDataUri(src: string): Buffer | null {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  return match ? Buffer.from(match[1], "base64") : null;
}

/**
 * Two megabytes is far more than a signature ever is - the canvas produces a
 * few tens of kilobytes - and far less than an image worth spending a second
 * of the event loop on.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Per side. A signature is drawn a few hundred pixels across; the cap is here
 * because decode cost is width x height, so it is the dimensions rather than
 * the file size that decide how long the thread is held.
 */
export const MAX_IMAGE_PIXELS = 4096;

/** No real image needs this many. It bounds the walk below. */
const MAX_PNG_CHUNKS = 1024;
const MAX_JPEG_SEGMENTS = 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG says 1, 2, 4, 8 or 16; anything else is not a PNG. */
const PNG_BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);
/** Greyscale, truecolour, indexed, greyscale+alpha, truecolour+alpha. */
const PNG_COLOUR_TYPES = new Set([0, 2, 3, 4, 6]);

/**
 * JPEG frame headers. Every one of them carries the image dimensions in the
 * same place, which is the only reason to list them.
 */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Says what is wrong, in the caller's words.
 *
 * Built per call rather than kept in the module, because the noun and the
 * advice differ between call sites - a signer can draw again, an
 * administrator has to upload a different logo - and a shared mutable would
 * be one interleaved call away from telling the wrong person the wrong thing.
 */
type Refuse = (why: string) => never;

const refuser =
  (what: string, advice: string): Refuse =>
  (why: string): never => {
    throw errors.badRequest(`${what} ${why}${advice ? ` ${advice}` : ""}`);
  };

function checkDimensions(refuse: Refuse, width: number, height: number): void {
  if (width < 1 || height < 1) {
    refuse("has no width or height.");
  }
  if (width > MAX_IMAGE_PIXELS || height > MAX_IMAGE_PIXELS) {
    refuse(
      `is ${width} by ${height} pixels, and the largest accepted is ` +
        `${MAX_IMAGE_PIXELS} on a side.`
    );
  }
}

function walkPng(bytes: Buffer, refuse: Refuse): void {
  let offset = PNG_MAGIC.length;
  let chunks = 0;
  let sawHeader = false;
  let sawEnd = false;

  while (offset + 8 <= bytes.length) {
    if (++chunks > MAX_PNG_CHUNKS) {
      refuse("has more chunks than any real image, so it was not read.");
    }

    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);

    /*
     * The check the decoder does not do early enough. A chunk that claims
     * more bytes than exist is the shape of the malformed input this guard
     * is here for, and `offset + 12 + length` cannot overflow within the
     * range a Buffer can hold.
     */
    if (offset + 12 + length > bytes.length) {
      refuse(`declares a ${type} chunk longer than the file itself.`);
    }

    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) {
        refuse("does not begin with a PNG header.");
      }
      sawHeader = true;
      checkDimensions(
        refuse,
        bytes.readUInt32BE(offset + 8),
        bytes.readUInt32BE(offset + 12)
      );
      if (!PNG_BIT_DEPTHS.has(bytes[offset + 16])) {
        refuse("declares a bit depth PNG does not have.");
      }
      if (!PNG_COLOUR_TYPES.has(bytes[offset + 17])) {
        refuse("declares a colour type PNG does not have.");
      }
    }

    if (type === "IEND") {
      sawEnd = true;
      break;
    }

    offset += 12 + length;
  }

  if (!sawHeader) refuse("does not begin with a PNG header.");
  if (!sawEnd) refuse("is a PNG that stops before it ends.");
}

function walkJpeg(bytes: Buffer, refuse: Refuse): void {
  let offset = 2;
  let segments = 0;
  let sawFrame = false;

  while (offset + 1 < bytes.length) {
    if (++segments > MAX_JPEG_SEGMENTS) {
      refuse("has more segments than any real image, so it was not read.");
    }

    if (bytes[offset] !== 0xff) {
      refuse("is a JPEG whose segments do not line up.");
    }

    // Fill bytes are legal padding before a marker.
    let marker = bytes[offset + 1];
    let markerAt = offset + 1;
    while (marker === 0xff && markerAt + 1 < bytes.length) {
      markerAt += 1;
      marker = bytes[markerAt]!;
    }

    // Markers that carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset = markerAt + 1;
      continue;
    }

    if (markerAt + 3 >= bytes.length) {
      refuse("is a JPEG that stops in the middle of a segment.");
    }

    const length = bytes.readUInt16BE(markerAt + 1);
    if (length < 2 || markerAt + 1 + length > bytes.length) {
      refuse("declares a JPEG segment longer than the file itself.");
    }

    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 7) refuse("has a JPEG frame header with no dimensions.");
      sawFrame = true;
      checkDimensions(
        refuse,
        bytes.readUInt16BE(markerAt + 6),
        bytes.readUInt16BE(markerAt + 4)
      );
    }

    /*
     * Everything after the start of scan is entropy-coded data rather than
     * segments, so there is nothing further to walk. By this point the frame
     * header has already been read, which is what decides the decode cost.
     */
    if (marker === 0xda) break;

    offset = markerAt + 1 + length;
  }

  if (!sawFrame) refuse("is a JPEG with no image in it.");
}

/**
 * Refuse anything that is not a well-formed PNG or JPEG, and say which it is.
 *
 * @param what How to name it in the message, e.g. "The signature image".
 * @param whatToDo A sentence telling the reader how to fix it, appended to
 *   whatever the refusal says was wrong.
 */
export function assertEmbeddableImage(
  bytes: Buffer,
  what = "The signature image",
  whatToDo = ""
): ImageKind {
  const refuse = refuser(what, whatToDo);

  if (bytes.length === 0) refuse("is empty.");
  if (bytes.length > MAX_IMAGE_BYTES) {
    refuse(`is ${Math.round(bytes.length / 1024)} KB, and the largest accepted is ` +
        `${MAX_IMAGE_BYTES / 1024} KB.`
    );
  }

  if (bytes.length > PNG_MAGIC.length && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    walkPng(bytes, refuse);
    return "png";
  }

  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    walkJpeg(bytes, refuse);
    return "jpeg";
  }

  return refuse("is not a PNG or a JPEG.");
}
