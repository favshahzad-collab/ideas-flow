import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { findSignatoryLines } from "./signatoryLines";

/**
 * A memo laid out the way the Word ones are: a header naming the preparer,
 * a sentence mentioning an approver, and at the foot a ruled signature strip
 * with each signatory's name under their line, in columns.
 */
async function wordMemo(options: { splitName?: boolean } = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([595, 842]);

  page.drawText("From:", { x: 60, y: 760, size: 10, font: bold });
  page.drawText("Aamir Raza", { x: 140, y: 760, size: 10, font });
  page.drawText("As discussed with Areeb Khan, the allowance is revised.", { x: 60, y: 700, size: 10, font });

  // The strip: a rule, and the name centred under it, three columns.
  const columns: [string, number][] = [["Aamir Raza", 90], ["Areeb Khan", 260], ["Kazim Zaidi", 430]];
  for (const [name, x] of columns) {
    page.drawLine({ start: { x, y: 130 }, end: { x: x + 120, y: 130 } });
    if (options.splitName && name === "Kazim Zaidi") {
      // Word often emits one word per run.
      page.drawText("Kazim", { x: x + 25, y: 115, size: 9, font: bold });
      page.drawText("Zaidi", { x: x + 25 + bold.widthOfTextAtSize("Kazim ", 9), y: 115, size: 9, font: bold });
    } else {
      page.drawText(name, { x: x + 25, y: 115, size: 9, font: bold });
    }
    page.drawText("Approver", { x: x + 25, y: 104, size: 7, font });
  }
  return Buffer.from(await pdf.save());
}

const people = [
  { key: "aamir", name: "Aamir Raza" },
  { key: "areeb", name: "Areeb Khan" },
  { key: "kazim", name: "Kazim Zaidi" },
];

describe("finding each signatory's line on an attached PDF", () => {
  it("puts a line above each printed name in the signature strip", async () => {
    const slots = await findSignatoryLines(await wordMemo(), people);

    expect(slots?.map((slot) => slot.key).sort()).toEqual(["aamir", "areeb", "kazim"]);
    for (const slot of slots!) {
      expect(slot).toMatchObject({ page: 1, height: 40, detected: true });
      // Above the name (baseline 115 from the bottom = 727 from the top),
      // resting on the rule at 130 from the bottom (712 from the top).
      expect(slot.y + slot.height).toBeGreaterThan(700);
      expect(slot.y + slot.height).toBeLessThan(727);
    }
  });

  it("centres the line on the name it belongs to", async () => {
    const slots = await findSignatoryLines(await wordMemo(), people);
    const areeb = slots!.find((slot) => slot.key === "areeb")!;
    const centre = areeb.x + areeb.width / 2;
    expect(centre).toBeGreaterThan(260 + 25);
    expect(centre).toBeLessThan(260 + 25 + 60);
  });

  it("takes the signature strip, not the From: line at the top", async () => {
    const slots = await findSignatoryLines(await wordMemo(), people);
    const aamir = slots!.find((slot) => slot.key === "aamir")!;
    expect(aamir.y).toBeGreaterThan(600);
  });

  it("does not treat a name mentioned in a sentence as a line", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([595, 842]).drawText("As discussed with Areeb Khan, the allowance is revised.", { x: 60, y: 700, size: 10, font });
    expect(await findSignatoryLines(Buffer.from(await pdf.save()), people)).toBeNull();
  });

  it("joins a name Word printed one word at a time", async () => {
    const slots = await findSignatoryLines(await wordMemo({ splitName: true }), people);
    expect(slots?.some((slot) => slot.key === "kazim")).toBe(true);
  });

  it("ignores case and spacing in the name", async () => {
    const slots = await findSignatoryLines(await wordMemo(), [{ key: "areeb", name: "  AREEB   khan " }]);
    expect(slots?.map((slot) => slot.key)).toEqual(["areeb"]);
  });

  it("gives no line to two signatories who share a name", async () => {
    const slots = await findSignatoryLines(await wordMemo(), [
      { key: "areeb-1", name: "Areeb Khan" },
      { key: "areeb-2", name: "Areeb Khan" },
      { key: "kazim", name: "Kazim Zaidi" },
    ]);
    expect(slots?.map((slot) => slot.key)).toEqual(["kazim"]);
  });

  it("finds nothing for somebody whose name is not printed", async () => {
    const slots = await findSignatoryLines(await wordMemo(), [{ key: "reham", name: "Reham Nawaz" }]);
    expect(slots).toBeNull();
  });

  it("finds nothing on a scanned PDF, which has no text", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    expect(await findSignatoryLines(Buffer.from(await pdf.save()), people)).toBeNull();
  });

  it("never throws on a file it cannot read", async () => {
    expect(await findSignatoryLines(Buffer.from("not a pdf at all"), people)).toBeNull();
  });
});

describe("a tight signature strip", () => {
  /** Names in columns `spacing` points apart, on one row. */
  async function strip(spacing: number, names: string[]): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.addPage([595, 842]);
    names.forEach((name, index) => page.drawText(name, { x: 40 + index * spacing, y: 115, size: 9, font }));
    return Buffer.from(await pdf.save());
  }

  it("gives neighbouring columns a line each, split between them, not lost", async () => {
    const slots = (await findSignatoryLines(await strip(120, ["Aamir Raza", "Areeb Khan", "Kazim Zaidi", "Reham Nawaz"]), [
      ...people,
      { key: "reham", name: "Reham Nawaz" },
    ]))!;

    expect(slots.map((slot) => slot.key)).toEqual(["aamir", "areeb", "kazim", "reham"]);
    const ordered = [...slots].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ordered.length; i += 1) {
      // No two lines touch, and each is still wide enough to sign on.
      const [previous, current] = [ordered[i - 1], ordered[i]]
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width);
      expect(current.width).toBeGreaterThanOrEqual(60);
    }
  });

  it("gives up on names stacked one above the other", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const page = pdf.addPage([595, 842]);
    page.drawText("Aamir Raza", { x: 60, y: 130, size: 9, font });
    page.drawText("Areeb Khan", { x: 60, y: 118, size: 9, font });
    expect(await findSignatoryLines(Buffer.from(await pdf.save()), people)).toBeNull();
  });
});
