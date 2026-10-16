import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  drawnImage,
  drawnText,
  linesOf,
  ruledLine,
} from "../test/pdfText";
import {
  decodeSignatureImage,
  embedSignatureInPdf,
  fitPlacementToPage,
  signoffBlockHeight,
  stampSignature,
  formatSignoffDate,
  type SignoffDetails,
} from "./pdfSignature";
import { solidPng } from "../test/png";

/**
 * Where a signature lands on the page is the whole job: the frontend places it
 * with a top-left origin over a rendered preview, and PDF space counts up from
 * the bottom. Nobody notices a flipped signature until it is on a document
 * somebody has already approved, so the arithmetic is read back out of the
 * saved file rather than trusted.
 */

/** 1x1 transparent PNG. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 1x1 JPEG, 160 bytes - small enough to land in Node's shared buffer pool. */
const JPEG_1X1 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function blankPdf(...sizes: [number, number][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const [width, height] of sizes) {
    doc.addPage([width, height]);
  }
  return Buffer.from(await doc.save());
}

const placement = {
  signaturePage: 1,
  signatureX: 40,
  signatureY: 10,
  signatureWidth: 50,
  signatureHeight: 30,
};

/*
 * A signature the same shape as `placement` - 5:3, as the box is.
 *
 * Every test below that asks where the mark landed used to draw the 1x1 above,
 * which is the one shape that fits any box exactly however the fitting is
 * done. So the numbers they assert were true of a square poured into a
 * rectangle, and stayed true when the image was stretched to fill it. An
 * image with a shape of its own is what lets the placement be read back.
 */
const SIGNATURE_PNG = solidPng(250, 150);

describe("decodeSignatureImage", () => {
  it("decodes raw base64", () => {
    expect(decodeSignatureImage(PNG_1X1)).toEqual(
      Buffer.from(PNG_1X1, "base64")
    );
  });

  it("strips a data-url prefix, whatever image type it names", () => {
    const expected = Buffer.from(PNG_1X1, "base64");

    expect(decodeSignatureImage(`data:image/png;base64,${PNG_1X1}`)).toEqual(
      expected
    );
    expect(decodeSignatureImage(`data:image/jpeg;base64,${PNG_1X1}`)).toEqual(
      expected
    );
  });

  it("leaves a decoded data url starting at the image's own magic bytes", () => {
    // If the prefix survived, base64 would decode it as payload and every
    // byte after it would be shifted.
    expect(
      decodeSignatureImage(`data:image/png;base64,${PNG_1X1}`).subarray(0, 4)
    ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("embedSignatureInPdf", () => {
  it("flips the y axis from the top-left origin the client sends", async () => {
    const pdf = await blankPdf([300, 200]);

    const signed = await embedSignatureInPdf(
      pdf,
      SIGNATURE_PNG,
      placement
    );

    // 200 tall, 10 down from the top, 30 tall: the bottom edge sits at 160.
    expect(drawnImage(signed)).toEqual({ x: 40, y: 160, width: 50, height: 30 });
  });

  it("measures against the page it is signing, not the first one", async () => {
    // A4 portrait then A4 landscape. Using page 1's height for a signature on
    // page 2 would put it 250pt off, which is most of a page.
    const pdf = await blankPdf([595, 842], [842, 595]);

    const signed = await embedSignatureInPdf(pdf, SIGNATURE_PNG, {
      ...placement,
      signaturePage: 2,
    });

    expect(drawnImage(signed).y).toBe(595 - 10 - 30);
  });

  it("keeps the pages it was given", async () => {
    const pdf = await blankPdf([300, 200], [300, 200], [300, 200]);
    const signed = await embedSignatureInPdf(
      pdf,
      SIGNATURE_PNG,
      placement
    );

    expect((await PDFDocument.load(signed)).getPageCount()).toBe(3);
  });

  it("accepts a JPEG signature that starts partway into its ArrayBuffer", async () => {
    /*
     * pdf-lib's JPEG embedder reads `bytes.buffer` without applying
     * `byteOffset`, so an image that does not start at offset 0 had its first
     * two bytes read from whatever shared the buffer - and a perfectly good
     * file was rejected with "SOI not found in JPEG".
     *
     * Node produces that shape by itself: small Buffers are views into a
     * shared 8 KB pool, and one allocated into a part-used pool arrives at a
     * non-zero offset. But only a PART-USED pool does that, and whether the
     * pool is part-used when this line runs depends on every allocation the
     * process happened to make before it. This test used to assert
     * `byteOffset > 0` on the natural allocation and call a zero "fixture is
     * too large to exercise the bug" - which was the wrong diagnosis: the
     * fixture never changed. Changing the test runner changed the order files
     * are loaded in, the pool was untouched, the image landed at offset 0,
     * and the guard fired in CI having passed on every developer machine.
     *
     * So the offset is built rather than hoped for. Same bytes from the same
     * decode path, re-homed at a known offset inside a larger buffer, which
     * is the condition the bug actually needs.
     */
    const decoded = decodeSignatureImage(JPEG_1X1);
    const jpeg = Buffer.allocUnsafe(decoded.byteLength + 8).subarray(8);
    decoded.copy(jpeg);

    expect(jpeg.byteOffset).toBeGreaterThan(0);
    expect(jpeg.buffer.byteLength).toBeGreaterThan(jpeg.byteLength);

    const signed = await embedSignatureInPdf(
      await blankPdf([300, 200]),
      jpeg,
      placement
    );

    // This one keeps the square fixture, because a JPEG of a stated size is
    // more trouble to build than the point is worth - so it is fitted rather
    // than filled: a square in a 50 x 30 box is 30 x 30, centred across the
    // 50, which puts its left edge 10 in from the box at x=40. The subject is
    // that it embedded at all.
    expect(drawnImage(signed)).toEqual({ x: 50, y: 160, width: 30, height: 30 });
  });

  it("rejects a page number below the first page", async () => {
    const pdf = await blankPdf([300, 200]);

    await expect(
      embedSignatureInPdf(pdf, SIGNATURE_PNG, {
        ...placement,
        signaturePage: 0,
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a page number past the last page", async () => {
    const pdf = await blankPdf([300, 200], [300, 200]);

    await expect(
      embedSignatureInPdf(pdf, SIGNATURE_PNG, {
        ...placement,
        signaturePage: 3,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid signature page number.",
    });
  });

  it("signs the last page", async () => {
    const pdf = await blankPdf([300, 200], [300, 400]);

    const signed = await embedSignatureInPdf(pdf, SIGNATURE_PNG, {
      ...placement,
      signaturePage: 2,
    });

    expect(drawnImage(signed).y).toBe(400 - 10 - 30);
  });

  it("fails on something that is neither a PNG nor a JPEG", async () => {
    await expect(
      embedSignatureInPdf(
        await blankPdf([300, 200]),
        Buffer.from("this is not an image at all"),
        placement
      )
    ).rejects.toThrow();
  });
});

/**
 * The placement is a frame, not a shape to be poured into.
 *
 * The signing editor previews the mark with `object-contain`: fitted inside
 * the box, proportions kept, letterboxed where the two disagree. Handing
 * `drawImage` a width and a height fills the box instead, so a signature that
 * is not the box's shape arrives on the memo stretched - and the only place
 * anybody could have noticed is the signed PDF, after it is signed.
 *
 * The box is 50 x 30 throughout, from `placement`.
 */
describe("the shape of the signature", () => {
  const BOX_WIDTH = placement.signatureWidth;
  const BOX_HEIGHT = placement.signatureHeight;

  const stamp = async (signature: Buffer) =>
    drawnImage(await embedSignatureInPdf(await blankPdf([300, 200]), signature, placement));

  it("keeps the proportions of a signature wider than the box it was dropped in", async () => {
    // 4:1 against a box of 5:3. Filling would make it a third taller than it
    // is, which on a name written by hand is the difference between a
    // signature and a smear.
    const drawn = await stamp(solidPng(400, 100));

    expect(drawn.width / drawn.height).toBeCloseTo(4, 5);
    expect(drawn.width).toBeCloseTo(BOX_WIDTH, 5);
    expect(drawn.height).toBeCloseTo(BOX_WIDTH / 4, 5);
  });

  it("keeps the proportions of one taller than the box", async () => {
    const drawn = await stamp(solidPng(100, 400));

    expect(drawn.width / drawn.height).toBeCloseTo(0.25, 5);
    expect(drawn.height).toBeCloseTo(BOX_HEIGHT, 5);
  });

  it("never draws outside the box it was given", async () => {
    for (const signature of [solidPng(400, 100), solidPng(100, 400), solidPng(90, 90)]) {
      const drawn = await stamp(signature);

      expect(drawn.width).toBeLessThanOrEqual(BOX_WIDTH + 1e-6);
      expect(drawn.height).toBeLessThanOrEqual(BOX_HEIGHT + 1e-6);
      expect(drawn.x).toBeGreaterThanOrEqual(placement.signatureX - 1e-6);
      expect(drawn.y).toBeGreaterThanOrEqual(
        200 - placement.signatureY - BOX_HEIGHT - 1e-6
      );
    }
  });

  it("centres what is left over, the way the preview does", async () => {
    // `object-contain` centres on both axes. A signature pinned to a corner of
    // its box instead would sit somewhere other than where it was dropped.
    const drawn = await stamp(solidPng(400, 100));
    const boxBottom = 200 - placement.signatureY - BOX_HEIGHT;

    expect(drawn.x).toBeCloseTo(placement.signatureX + (BOX_WIDTH - drawn.width) / 2, 5);
    expect(drawn.y).toBeCloseTo(boxBottom + (BOX_HEIGHT - drawn.height) / 2, 5);
  });

  it("fills a box that is already the signature's own shape", async () => {
    // The drawn path: ink is cropped to its own bounds and the box is built
    // from that crop, so the two agree and nothing is given up to fitting.
    const drawn = await stamp(solidPng(250, 150));

    expect(drawn).toEqual({
      x: placement.signatureX,
      y: 200 - placement.signatureY - BOX_HEIGHT,
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
    });
  });
});

describe("formatSignoffDate", () => {
  it("writes the date the way the memo will be read", () => {
    expect(formatSignoffDate(new Date(2026, 8, 6, 14, 30))).toBe("06 Sep 2026");
  });

  it("pads a single-digit day and spells the month out", () => {
    // `6/9/2026` is the 6th of September to the person who filed it and the
    // 9th of June to whoever reads it next. The month in words settles it.
    expect(formatSignoffDate(new Date(2026, 5, 9))).toBe("09 Jun 2026");
    expect(formatSignoffDate(new Date(2026, 0, 31))).toBe("31 Jan 2026");
    expect(formatSignoffDate(new Date(2026, 11, 1))).toBe("01 Dec 2026");
  });

  it("says nothing at all for a date that is not one", () => {
    // Rather than printing "NaN NaN NaN" under somebody's signature, on a
    // page that cannot be corrected once it is approved.
    expect(formatSignoffDate(new Date("nonsense"))).toBe("");
  });
});

/**
 * The block is the part a person can read. An approved memo used to come back
 * carrying ink squiggles and nothing else: no name, no post, no date, and
 * nobody reading the filed PDF could say who had signed it or when.
 */
describe("the sign-off block", () => {
  const A4: [number, number] = [595, 842];

  /** The foot of the signature image, in PDF coordinates: 842 - 10 - 30. */
  const IMAGE_BOTTOM = A4[1] - placement.signatureY - placement.signatureHeight;

  const ayesha: SignoffDetails = {
    name: "Ayesha Khan",
    designation: "Manager",
    department: "Finance",
    capacity: "REVIEWER",
    signedAt: new Date(2026, 8, 6, 14, 30),
  };

  const signWith = async (
    signoff?: SignoffDetails,
    overrides: Partial<typeof placement> = {}
  ) =>
    embedSignatureInPdf(
      await blankPdf(A4),
      SIGNATURE_PNG,
      { ...placement, ...overrides },
      signoff
    );

  it("names the signer, their post and the capacity they signed in", async () => {
    expect(linesOf(await signWith(ayesha))).toEqual([
      "Ayesha Khan",
      "Manager, Finance",
      "Reviewer",
    ]);
  });

  it("sits below the mark and lines up with it", async () => {
    const block = drawnText(await signWith(ayesha));

    // Drawn above the image it belongs to, the block would be sitting on the
    // memo's own text - and the last approver's block would be over the
    // previous one's signature.
    expect(block.every((line) => line.y < IMAGE_BOTTOM)).toBe(true);
    expect(block.map((line) => line.x)).toEqual([40, 40, 40]);
  });

  it("rules a line between the mark and the name", async () => {
    const signed = await signWith(ayesha);
    const rule = ruledLine(signed);
    const [name] = drawnText(signed);

    expect(rule).toBeDefined();
    expect(rule!.y).toBeLessThan(IMAGE_BOTTOM);
    expect(rule!.y).toBeGreaterThan(name.y);
    // At least as wide as the mark it closes off, so a signature is not left
    // sitting over a stub of a line.
    expect(rule!.x).toBeGreaterThanOrEqual(
      placement.signatureX + placement.signatureWidth
    );
  });

  it("drops the designation of somebody who has none, closing the block up", async () => {
    const titled = drawnText(await signWith(ayesha));
    const untitled = drawnText(await signWith({ ...ayesha, designation: null }));

    expect(untitled.map((line) => line.text)).toEqual([
      "Ayesha Khan",
      "Finance",
      "Reviewer",
    ]);
    // Same baselines as the titled block: a blank where the designation would
    // have gone reads as a field the system failed to fill in, and pushes the
    // date down onto the text below.
    expect(untitled.map((line) => line.y)).toEqual(titled.map((line) => line.y));
  });

  it("gives up the whole line when there is no post to name at all", async () => {
    const titled = drawnText(await signWith(ayesha));
    const bare = drawnText(
      await signWith({
        name: ayesha.name,
        capacity: "REVIEWER",
        signedAt: ayesha.signedAt,
      })
    );

    expect(bare.map((line) => line.text)).toEqual([
      "Ayesha Khan",
      "Reviewer",
    ]);
    // The date moved up into the empty line rather than leaving a hole in the
    // middle of the block.
    expect(bare[1].y).toBe(titled[1].y);
  });

  it("spells each capacity the way it is spoken", async () => {
    const spoken = {
      REVIEWER: "Reviewer",
      APPROVER: "Approver",
      FINAL_APPROVER: "Final Approver",
    } as const;

    for (const [capacity, label] of Object.entries(spoken)) {
      const signed = await signWith({
        ...ayesha,
        capacity: capacity as SignoffDetails["capacity"],
      });

      // FINAL_APPROVER on a memo tells a reader the database's business, not
      // theirs.
      expect(linesOf(signed)).toContain(label);
    }
  });

  it("draws no date under any signature; the ledger keeps when", async () => {
    const signed = await signWith({ ...ayesha, signedAt: new Date(2019, 0, 2) });

    // The capacity stays on an uploaded file - nothing else on it says in
    // what capacity somebody signed - but the date does not: the audit
    // ledger records when, and a date under the mark read as a system tag.
    expect(linesOf(signed)).toContain("Reviewer");
    expect(linesOf(signed).some((line) => /\d{2} [A-Z][a-z]{2} \d{4}|·/.test(line))).toBe(false);
  });

  it("draws no line at all for a signer with a date and no capacity", async () => {
    // The preparer: their block was name, post and a bare date.
    const signed = await signWith({ ...ayesha, capacity: null });

    expect(linesOf(signed)).toEqual(["Ayesha Khan", "Manager, Finance"]);
    expect(signoffBlockHeight({ ...ayesha, capacity: null })).toBeCloseTo(
      signoffBlockHeight({ name: ayesha.name, designation: ayesha.designation }),
      6
    );
  });

  it("keeps drawing the signature when no sign-off is passed at all", async () => {
    // The preparer's signature is applied without one. It has to keep working
    // exactly as it did, or nobody can submit a document.
    const signed = await embedSignatureInPdf(
      await blankPdf([300, 200]),
      SIGNATURE_PNG,
      placement
    );

    expect(drawnText(signed)).toEqual([]);
    expect(drawnImage(signed)).toEqual({ x: 40, y: 160, width: 50, height: 30 });
  });

  it("draws no block for a signer with no name", async () => {
    // A rule and a job title with nobody's name over them is worse than a
    // bare signature: it looks like a record and identifies no one.
    const signed = await signWith({ name: "   ", designation: "Manager" });

    expect(drawnText(signed)).toEqual([]);
    expect(ruledLine(signed)).toBeUndefined();
  });

  it("collapses whitespace stored inside a name or a department", async () => {
    // Helvetica cannot spell a line break: one left in a stored name reaches
    // the page as "Ayesha?Khan", under a signature, on a document that is
    // approved and cannot be redrawn. A tab or a doubled space is the same
    // story told more quietly.
    const signed = await signWith({
      ...ayesha,
      name: "Ayesha\nKhan",
      department: "Finance\tand  Accounts",
    });

    expect(linesOf(signed)).toEqual([
      "Ayesha Khan",
      "Manager, Finance and Accounts",
      "Reviewer",
    ]);
  });

  it("keeps a name Helvetica cannot spell instead of refusing to sign", async () => {
    // Helvetica encodes WinAnsi and pdf-lib throws on anything outside it.
    // Thrown from here it reaches the approver as "signature image could not
    // be read", sending them off to redraw a signature that was never the
    // problem - and the approval cannot be completed at all.
    const signed = await signWith({ ...ayesha, name: "Ayesha عائشہ Khan" });
    const [name] = linesOf(signed);

    expect(name.startsWith("Ayesha ")).toBe(true);
    expect(name.endsWith(" Khan")).toBe(true);
  });

  it("trims a line too long for the room left beside it", async () => {
    const designation = "Deputy Manager, Procurement and Contracts Administration";

    const signed = await signWith({ ...ayesha, designation }, { signatureX: 430 });
    const [, post] = linesOf(signed);

    // Text drawn past the right edge is not clipped, it is simply absent, and
    // the block quietly stops saying what it was put there to say.
    expect(post.endsWith("...")).toBe(true);
    expect(post.length).toBeLessThan(`${designation}, Finance`.length);
  });

  /*
   * On a memo written in the portal. "Approver · 26 Sep 2026" under a mark
   * whose strip already names the signatory read as the system's tags on a
   * signed document; there the ledger keeps the capacity and the date, and
   * the page shows the signature over the name. An uploaded file, above,
   * keeps its line - nothing else on it says in what capacity anyone signed.
   */
  it("draws nothing under a signature on its own printed line", async () => {
    for (const capacity of ["REVIEWER", "APPROVER", "FINAL_APPROVER"] as const) {
      const signed = await signWith({ ...ayesha, capacity, onOwnLine: true, onTypedMemo: true });

      expect(linesOf(signed)).toEqual([]);
    }
    expect(signoffBlockHeight({ ...ayesha, onOwnLine: true })).toBe(0);
  });

  it("gives a delegate on a typed memo their name, post and principal, but no capacity or date", async () => {
    const signed = await signWith({ ...ayesha, onBehalfOf: "Aamir Raza", onTypedMemo: true });

    expect(linesOf(signed)).toEqual(["Ayesha Khan", "Manager, Finance", "Signed for Aamir Raza"]);
  });
});

describe("signoffBlockHeight", () => {
  const signedAt = new Date(2026, 8, 6);

  it("reserves nothing when there is nothing to say", () => {
    // Not the preparer's case, which this used to claim: documents.service
    // signs WITH a sign-off, and believing otherwise is what left the
    // preparer's own name drawn off the bottom of the page.
    expect(signoffBlockHeight()).toBe(0);
    expect(signoffBlockHeight(null)).toBe(0);
    expect(signoffBlockHeight({ name: "  " })).toBe(0);
  });

  it("grows with every line the block carries", () => {
    const name = signoffBlockHeight({ name: "Ayesha Khan" });
    const withPost = signoffBlockHeight({
      name: "Ayesha Khan",
      department: "Finance",
    });
    const full = signoffBlockHeight({
      name: "Ayesha Khan",
      designation: "Manager",
      department: "Finance",
      capacity: "REVIEWER",
      signedAt,
    });

    expect(name).toBeGreaterThan(0);
    expect(withPost).toBeGreaterThan(name);
    expect(full).toBeGreaterThan(withPost);
  });

  it("measures the same block the signing editor reserves room for", () => {
    /*
     * PINNED TO THE FRONTEND. `frontend/src/utils/pdfCoordinates.ts` carries a
     * `signoffBlockHeight` of its own, asserting these exact numbers, because
     * the editor has to reserve on screen precisely what this file draws on
     * the page.
     *
     * It cannot import this one - separate packages - so the two are held
     * together by a pair of tests instead. If a constant here changes without
     * the same change there, this fails; and it has to, because the failure it
     * prevents is silent: the editor would go on reserving the old height, the
     * approver would place a signature at the foot of a page, and the backend
     * would move it up to fit a block that is no longer that size. Nobody sees
     * that until the approved PDF is opened.
     *
     * The numbers below are RULE_OFFSET 5 + RULE_THICKNESS 0.75, plus
     * LINE_GAP 3.5 and the type size for each line drawn (NAME 9,
     * DETAIL 7.5), plus DESCENDER_TAIL 2.
     */
    expect(signoffBlockHeight({ name: "Kazim Zaidi" })).toBeCloseTo(20.25, 6);

    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", designation: "Deputy Manager" })
    ).toBeCloseTo(31.25, 6);

    // Designation and department share one line, so either alone costs the same.
    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", department: "Finance" })
    ).toBeCloseTo(31.25, 6);

    // As does the capacity; a date alone draws nothing.
    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", capacity: "APPROVER" })
    ).toBeCloseTo(31.25, 6);

    // What an approver with a designation actually gets: name, post, capacity.
    expect(
      signoffBlockHeight({
        name: "Kazim Zaidi",
        designation: "Deputy Manager",
        department: "Finance",
        capacity: "APPROVER",
        signedAt,
      })
    ).toBeCloseTo(42.25, 6);

    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", onBehalfOf: "Aamir Raza" })
    ).toBeCloseTo(31.25, 6);

    // Where the page already names the signer - their printed line, or any
    // attached PDF - nothing is drawn but a delegate's line: OWN_LINE_OFFSET 1,
    // LINE_GAP 3.5, DETAIL 7.5, DESCENDER_TAIL 2.
    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", designation: "Deputy Manager", onOwnLine: true })
    ).toBe(0);
    expect(
      signoffBlockHeight({ name: "Kazim Zaidi", onBehalfOf: "Aamir Raza", onOwnLine: true })
    ).toBeCloseTo(14, 6);
  });

  it("covers every line the block actually draws", async () => {
    // This is the number the caller fits the signature box by. If the block
    // draws below what it declares, a signature placed at the foot of a page
    // puts the names in the margin and off the edge - burned into a document
    // that has been approved and cannot be redrawn.
    const signoff: SignoffDetails = {
      name: "Ayesha Khan",
      designation: "Manager",
      department: "Finance",
      capacity: "FINAL_APPROVER",
      signedAt,
    };

    const signed = await embedSignatureInPdf(
      await blankPdf([595, 842]),
      SIGNATURE_PNG,
      placement,
      signoff
    );

    const imageBottom = 842 - placement.signatureY - placement.signatureHeight;
    const lowest = Math.min(...drawnText(signed).map((line) => line.y));

    expect(imageBottom - lowest).toBeLessThanOrEqual(signoffBlockHeight(signoff));
  });
});

/**
 * Fitting the box to the page.
 *
 * Untested until now, and reached from exactly one of the two places that
 * burn a signature into a document - which is how the preparer's own mark
 * came to be placed by no rule at all.
 */
describe("fitPlacementToPage", () => {
  const A4: [number, number] = [595, 842];
  const words = { unreadablePdf: "Cannot read it." };
  const fit = async (
    input: Partial<typeof placement>,
    signoff?: SignoffDetails | null,
    sizes: [number, number][] = [A4]
  ) =>
    fitPlacementToPage(
      await blankPdf(...sizes),
      { ...placement, ...input },
      signoff,
      words
    );

  /** What documents.service builds for a preparer: no capacity, but a date. */
  const preparerSignoff: SignoffDetails = {
    name: "Maria Santos",
    designation: "HR Manager",
    department: "Human Resources",
    signedAt: new Date(2026, 0, 5),
  };

  it("leaves a box that already fits exactly where it was put", async () => {
    expect(await fit({})).toEqual(placement);
  });

  it("pulls an overhanging box back onto the page", async () => {
    // A fraction over the edge falls out of the viewer's float conversion and
    // is not misuse, so it is corrected rather than refused.
    const fitted = await fit({ signatureX: 594.7, signatureY: 841.2 });

    expect(fitted.signatureX).toBe(595 - placement.signatureWidth);
    expect(fitted.signatureY).toBe(842 - placement.signatureHeight);
  });

  it("refuses a box that shares no area with the page", async () => {
    // There is no honest place to put it, and the alternative is a document
    // that reads as signed with no signature visible anywhere on it.
    await expect(fit({ signatureX: 99999 })).rejects.toMatchObject({
      statusCode: 400,
      message:
        "The signature was placed outside the page. Move it onto the page and sign again.",
    });
  });

  it("keeps room under the signature for the block that names the signer", async () => {
    const bottom = 842 - placement.signatureHeight;
    const fitted = await fit({ signatureY: bottom }, preparerSignoff);

    // Moved up by exactly the block's height, so the names land on the page
    // rather than in the bottom margin and off the edge.
    expect(fitted.signatureY).toBeCloseTo(
      bottom - signoffBlockHeight(preparerSignoff),
      5
    );
    expect(signoffBlockHeight(preparerSignoff)).toBeGreaterThan(0);
  });

  it("reserves nothing when nothing is drawn under the signature", async () => {
    const bottom = 842 - placement.signatureHeight;

    expect((await fit({ signatureY: bottom })).signatureY).toBe(bottom);
  });

  it("narrows a signature wider than the page it is going on", async () => {
    const fitted = await fit({ signatureX: 0, signatureWidth: 9000 });

    expect(fitted.signatureWidth).toBe(595);
    expect(fitted.signatureX).toBe(0);
  });

  it("gives up the image rather than the names on a page too short for both", async () => {
    // Nothing fits, so the block - which is what identifies the signer - is
    // what survives.
    const fitted = await fit({ signatureY: 0 }, preparerSignoff, [[595, 40]]);

    expect(fitted.signatureY).toBe(0);
    expect(fitted.signatureHeight).toBeGreaterThanOrEqual(0);
    expect(fitted.signatureY + fitted.signatureHeight).toBeLessThanOrEqual(40);
  });

  it("refuses a page the document does not have", async () => {
    await expect(fit({ signaturePage: 4 })).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid signature page number.",
    });
  });

  it("answers for an unreadable document in the caller's own words", async () => {
    // An approver can only ask for the file again; a preparer is holding the
    // one they just chose and can go and fix it. Same failure, different
    // sentence, so the words belong to the caller.
    await expect(
      fitPlacementToPage(Buffer.from("not a pdf"), placement, null, {
        unreadablePdf: "Export it again and upload a fresh copy.",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Export it again and upload a fresh copy.",
    });
  });
});

describe("stampSignature", () => {
  it("answers for an unreadable signature image in words", async () => {
    /*
     * This used to reach the signer as a 500, out of pdf-lib's "SOI not found
     * in JPEG" - a plain Error thrown from its second decode attempt - in the
     * middle of legitimate work, with everything they had entered to enter
     * again.
     *
     * Now the bytes are refused before either decoder sees them, so the
     * message says which part was wrong as well as what to do about it. The
     * catch-all below this still stands for whatever pdf-lib throws on bytes
     * that pass the structural walk.
     */
    await expect(
      stampSignature(
        await blankPdf([595, 842]),
        Buffer.from("this is not an image at all", "utf8"),
        placement
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "The signature image is not a PNG or a JPEG. Draw a new signature, or re-upload your saved one.",
    });
  });

  it("refuses a PNG header that lies about its own size", async () => {
    /*
     * The denial of service this guard is really for. pdf-lib decodes in
     * JavaScript on the thread that serves every other request, and a chunk
     * header claiming four gigabytes does not make it fail - it makes it
     * work. Any signed-in account could post this.
     */
    const lying = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from("IHDR", "latin1"),
      (() => {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(120, 0);
        header.writeUInt32BE(40, 4);
        header[8] = 8;
        header[9] = 6;
        return header;
      })(),
      Buffer.alloc(4),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("IDAT", "latin1"),
      Buffer.alloc(8),
    ]);

    await expect(
      stampSignature(await blankPdf([595, 842]), lying, placement)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("longer than the file itself"),
    });
  });

  it("lets a refusal that already has words through unchanged", async () => {
    await expect(
      stampSignature(
        await blankPdf([595, 842]),
        SIGNATURE_PNG,
        { ...placement, signaturePage: 9 }
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Invalid signature page number.",
    });
  });

  it("stamps a good image and hands back the signed bytes", async () => {
    const signed = await stampSignature(
      await blankPdf([595, 842]),
      SIGNATURE_PNG,
      placement,
      { name: "Ayesha Khan", signedAt: new Date(2026, 0, 5) }
    );

    expect(linesOf(signed)).toContain("Ayesha Khan");
  });
});
