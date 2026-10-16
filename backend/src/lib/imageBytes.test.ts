import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { solidPng } from "../test/png";
import {
  assertEmbeddableImage,
  bytesOfImageDataUri,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
} from "./imageBytes";

/**
 * The check that stands between a request body and pdf-lib's decoder.
 *
 * Every signature on every memo arrives as bytes from a client, and pdf-lib
 * decodes them in JavaScript on the thread that serves everybody. Bytes that
 * merely claim to be a PNG do not make that decoder fail - they make it work,
 * for as long as the header tells it to. So the cases worth being exact about
 * are all the ones where the file lies about its own size.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  // The CRC is not checked - this is a structural walk, not a decoder - so
  // four zero bytes stand in for it.
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function ihdr(width: number, height: number, depth = 8, colour = 6): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = colour;
  return chunk("IHDR", data);
}

const png = (...parts: Buffer[]): Buffer =>
  Buffer.concat([Buffer.from(PNG_MAGIC), ...parts, chunk("IEND", Buffer.alloc(0))]);

const goodPng = () => png(ihdr(120, 40), chunk("IDAT", Buffer.alloc(16)));

/** A minimal baseline JPEG: SOI, a frame header, a start of scan. */
function jpeg(width = 120, height = 40): Buffer {
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // one component
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, sos, Buffer.alloc(8)]);
}

const refusal = (bytes: Buffer): string => {
  try {
    assertEmbeddableImage(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

describe("what it lets through", () => {
  it("accepts a PNG and says so", () => {
    expect(assertEmbeddableImage(goodPng())).toBe("png");
  });

  it("accepts a JPEG and says so", () => {
    expect(assertEmbeddableImage(jpeg())).toBe("jpeg");
  });

  it("accepts a PNG pdf-lib itself can embed", async () => {
    /*
     * The one test here that is not about the walk: it proves the walk agrees
     * with the decoder it is guarding, rather than being right about a format
     * of its own invention.
     */
    const doc = await PDFDocument.create();
    const real = solidPng(360, 120);

    expect(assertEmbeddableImage(real)).toBe("png");
    await expect(doc.embedPng(new Uint8Array(real))).resolves.toBeTruthy();
  });
});

describe("what it refuses", () => {
  it("refuses nothing at all", () => {
    expect(refusal(Buffer.alloc(0))).toMatch(/is empty/);
  });

  it("refuses bytes that are neither format", () => {
    expect(refusal(Buffer.from("%PDF-1.7\n"))).toMatch(/not a PNG or a JPEG/);
  });

  it("refuses a PNG chunk that claims more bytes than the file has", () => {
    // The shape of the attack. The header says the chunk runs to 4 GB; the
    // file is 60 bytes. A decoder that trusts the header reads for a long
    // time before it finds out.
    const lying = Buffer.concat([
      Buffer.from(PNG_MAGIC),
      ihdr(120, 40),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("IDAT", "latin1"),
      Buffer.alloc(8),
    ]);

    expect(refusal(lying)).toMatch(/longer than the file itself/);
  });

  it("refuses a PNG that never ends", () => {
    const truncated = Buffer.concat([
      Buffer.from(PNG_MAGIC),
      ihdr(120, 40),
      chunk("IDAT", Buffer.alloc(16)),
    ]);

    expect(refusal(truncated)).toMatch(/stops before it ends/);
  });

  it("refuses a PNG that does not start with its header", () => {
    const headerless = Buffer.concat([
      Buffer.from(PNG_MAGIC),
      chunk("IDAT", Buffer.alloc(16)),
      chunk("IEND", Buffer.alloc(0)),
    ]);

    expect(refusal(headerless)).toMatch(/does not begin with a PNG header/);
  });

  it("refuses a PNG claiming more pixels than any signature has", () => {
    const enormous = png(ihdr(60_000, 60_000));

    // Not a size problem - those bytes are tiny. It is the decode cost the
    // header would commit the thread to.
    expect(enormous.length).toBeLessThan(200);
    expect(refusal(enormous)).toMatch(/largest accepted is/);
  });

  it("refuses a PNG with no pixels in it", () => {
    expect(refusal(png(ihdr(0, 40)))).toMatch(/no width or height/);
  });

  it("refuses a bit depth PNG does not have", () => {
    expect(refusal(png(ihdr(10, 10, 7)))).toMatch(/bit depth/);
  });

  it("refuses a colour type PNG does not have", () => {
    expect(refusal(png(ihdr(10, 10, 8, 5)))).toMatch(/colour type/);
  });

  it("refuses a file too large to be a signature", () => {
    const huge = Buffer.concat([
      Buffer.from(PNG_MAGIC),
      Buffer.alloc(MAX_IMAGE_BYTES + 1),
    ]);

    expect(refusal(huge)).toMatch(/largest accepted is/);
  });

  it("refuses a JPEG segment that claims more bytes than the file has", () => {
    const lying = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff, 0x00, 0x00]);

    expect(refusal(lying)).toMatch(/longer than the file itself/);
  });

  it("refuses a JPEG claiming more pixels than any signature has", () => {
    expect(refusal(jpeg(60_000, 60_000))).toMatch(/largest accepted is/);
  });

  it("refuses a JPEG with no image in it", () => {
    const empty = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    expect(refusal(empty)).toMatch(/no image in it/);
  });

  it("refuses a JPEG whose markers do not line up", () => {
    const rubbish = Buffer.from([0xff, 0xd8, 0x41, 0x42, 0x43, 0x44]);

    expect(refusal(rubbish)).toMatch(/do not line up/);
  });
});

describe("the walk itself", () => {
  it("finishes on bytes designed to make it loop", () => {
    /*
     * Every chunk is zero-length, so an unbounded walk over this advances
     * eight bytes at a time through a megabyte - and a walk with a bug in it
     * does not advance at all. Either way the cap ends it.
     */
    const zeros = Buffer.concat([
      Buffer.from(PNG_MAGIC),
      ihdr(10, 10),
      ...Array.from({ length: 5000 }, () => chunk("tEXt", Buffer.alloc(0))),
    ]);

    const started = Date.now();
    expect(refusal(zeros)).toMatch(/more chunks than any real image/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("names the thing it refused, so the message means something", () => {
    try {
      assertEmbeddableImage(Buffer.from("not an image"), "The organisation logo");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/^The organisation logo /);
    }
  });

  it("refuses with a 400, because the bytes came from a request", () => {
    try {
      assertEmbeddableImage(Buffer.from("not an image"));
      throw new Error("should have refused");
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it("caps the sides at something a signature never reaches", () => {
    expect(MAX_IMAGE_PIXELS).toBeGreaterThanOrEqual(1024);
  });
});

describe("bytes carried in a data uri", () => {
  it("decodes a PNG or a JPEG data uri to the bytes it carries", () => {
    const bytes = goodPng();

    expect(bytesOfImageDataUri(`data:image/png;base64,${bytes.toString("base64")}`)).toEqual(bytes);
    expect(bytesOfImageDataUri(`data:image/jpeg;base64,${jpeg().toString("base64")}`)).toEqual(jpeg());
  });

  it("is null for anything that is not one", () => {
    const b64 = goodPng().toString("base64");

    expect(bytesOfImageDataUri("https://example.com/a.png")).toBeNull();
    expect(bytesOfImageDataUri(`data:image/gif;base64,${b64}`)).toBeNull();
    expect(bytesOfImageDataUri(`data:text/plain;base64,${b64}`)).toBeNull();
    expect(bytesOfImageDataUri(`data:image/png,${b64}`)).toBeNull();
    expect(bytesOfImageDataUri(`data:image/png;base64,${b64}<script>`)).toBeNull();
    expect(bytesOfImageDataUri("")).toBeNull();
  });
});
