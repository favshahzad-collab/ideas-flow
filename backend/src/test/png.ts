import zlib from "node:zlib";

/**
 * A signature image with a shape.
 *
 * Every signature fixture in this suite was a 1x1 PNG, which is the one shape
 * that can be stretched into any box without the result looking wrong. So the
 * tests over signature placement all drew a square into a rectangle and
 * agreed with themselves, and the question of whether a person's signature
 * keeps its proportions on the page was one no fixture could ask.
 *
 * A real signature is wide and short - a scan is commonly three or four times
 * as wide as it is tall - and the box it is dropped into is not necessarily
 * the same shape. That difference is the whole subject, so it has to be
 * expressible.
 *
 * Written by hand rather than pulled from a library: the suite needs an image
 * of a stated size, and nothing else about it matters.
 */
export function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    // The CRC covers the type as well as the body, so they are checksummed
    // together and then written together.
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // truecolour, no alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte then three channels a pixel, per row. All zero, which is
  // filter "none" over black.
  const row = Buffer.alloc(1 + width * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The same thing as the data url a signature pad or an upload would send. */
export const solidPngDataUrl = (width: number, height: number): string =>
  `data:image/png;base64,${solidPng(width, height).toString("base64")}`;
