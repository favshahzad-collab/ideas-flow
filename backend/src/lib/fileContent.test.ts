import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { assertSignablePdf, assertSupportingFileContent } from "./fileContent";

/**
 * The upload filter trusts the label; these read the bytes. Every refusal
 * here is a file the old code filed, showed to the chain and kept.
 */

function file(
  originalname: string,
  mimetype: string,
  buffer: Buffer
): Express.Multer.File {
  return {
    fieldname: "supportingFiles",
    originalname,
    encoding: "7bit",
    mimetype,
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

const bytes = (...values: number[]) => Buffer.from(values);

async function realPdf(pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

/** A trailer that names an /Encrypt dictionary is what makes a PDF encrypted. */
const ENCRYPTED_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "5 0 obj << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >> endobj",
    "trailer << /Root 1 0 R /Encrypt 5 0 R >>",
    "%%EOF",
  ].join("\n"),
  "latin1"
);

const NO_PAGES_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n"),
  "latin1"
);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 20, 0);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0);
/** What Windows puts at the front of an .exe. */
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("assertSupportingFileContent", () => {
  it.each([
    ["scan.pdf", "application/pdf", Buffer.from("%PDF-1.7\n")],
    ["receipt.png", "image/png", PNG],
    ["receipt.JPG", "image/jpeg", JPEG],
    ["receipt.jpeg", "image/jpeg", JPEG],
    ["letter.docx", DOCX, ZIP],
    ["letter.doc", "application/msword", OLE],
    ["budget.xlsx", XLSX, ZIP],
    ["budget.xls", "application/vnd.ms-excel", OLE],
    ["notes.txt", "text/plain", Buffer.from("Joining date moved to 1 October.")],
    ["staff.csv", "text/csv", Buffer.from("name,grade\nAyesha,M2\n")],
  ])("accepts a real %s", (name, type, content) => {
    expect(() => assertSupportingFileContent(file(name, type, content))).not.toThrow();
  });

  it("accepts a CSV Excel saved as Windows-1252", () => {
    // "Café" with é as 0xE9 - not UTF-8, and still a perfectly good CSV.
    const cp1252 = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]);
    expect(() =>
      assertSupportingFileContent(file("menu.csv", "text/csv", cp1252))
    ).not.toThrow();
  });

  it("refuses an executable labelled as a PDF", () => {
    expect(() =>
      assertSupportingFileContent(file("invoice.pdf", "application/pdf", EXE))
    ).toThrow('"invoice.pdf" is not a PDF, whatever its name says.');
  });

  it("refuses a PNG that is really a JPEG", () => {
    expect(() =>
      assertSupportingFileContent(file("photo.png", "image/png", JPEG))
    ).toThrow("is not a PNG image");
  });

  it("refuses a .docx that is not a ZIP archive", () => {
    expect(() =>
      assertSupportingFileContent(file("letter.docx", DOCX, OLE))
    ).toThrow("is not a Word document");
  });

  it("refuses a binary file sent as text", () => {
    expect(() =>
      assertSupportingFileContent(file("notes.txt", "text/plain", EXE))
    ).toThrow("is not a text file");
  });

  it("refuses a name that disagrees with the type, even when the bytes match", () => {
    // Real PDF bytes, but it would be downloaded and opened as invoice.exe.
    expect(() =>
      assertSupportingFileContent(
        file("invoice.exe", "application/pdf", Buffer.from("%PDF-1.7\n"))
      )
    ).toThrow('"invoice.exe" was sent as a PDF, but its name does not end in .pdf.');
  });

  it("refuses a name with no extension at all", () => {
    expect(() =>
      assertSupportingFileContent(file("scan", "application/pdf", Buffer.from("%PDF-1.7")))
    ).toThrow("does not end in .pdf");
  });

  it("refuses an empty file", () => {
    expect(() =>
      assertSupportingFileContent(file("empty.txt", "text/plain", Buffer.alloc(0)))
    ).toThrow('"empty.txt" is empty.');
  });

  it("refuses a type that is not on the list", () => {
    expect(() =>
      assertSupportingFileContent(file("page.html", "text/html", Buffer.from("<p>")))
    ).toThrow("is not a type of file that can be attached");
  });

  it("refuses a file too short to carry its signature", () => {
    expect(() =>
      assertSupportingFileContent(file("tiny.png", "image/png", bytes(0x89, 0x50)))
    ).toThrow("is not a PNG image");
  });
});

describe("assertSignablePdf", () => {
  const memo = (buffer: Buffer) => file("memo.pdf", "application/pdf", buffer);

  it("accepts a real PDF", async () => {
    await expect(assertSignablePdf(memo(await realPdf(2)))).resolves.toBeUndefined();
  });

  it("accepts a header a few bytes in, as the specification allows", async () => {
    const shifted = Buffer.concat([Buffer.from("\n\n"), await realPdf()]);
    await expect(assertSignablePdf(memo(shifted))).resolves.toBeUndefined();
  });

  it("refuses a file that is not a PDF at all", async () => {
    await expect(assertSignablePdf(memo(EXE))).rejects.toThrow(
      "The memo file is not a PDF, whatever its name says."
    );
  });

  it("refuses a PDF header too far in to be one", async () => {
    const buried = Buffer.concat([Buffer.alloc(2048, 0x20), await realPdf()]);
    await expect(assertSignablePdf(memo(buried))).rejects.toThrow("is not a PDF");
  });

  it("refuses a password-protected PDF and says so, rather than calling it damaged", async () => {
    await expect(assertSignablePdf(memo(ENCRYPTED_PDF))).rejects.toThrow(
      "The memo PDF is password-protected or encrypted"
    );
  });

  it("refuses a PDF that is damaged past opening", async () => {
    await expect(
      assertSignablePdf(memo(Buffer.from("%PDF-1.4\nnot really a pdf at all")))
    ).rejects.toThrow("The memo PDF is damaged and could not be opened.");
  });

  it("refuses a PDF cut off part-way", async () => {
    const whole = await realPdf();
    await expect(
      assertSignablePdf(memo(whole.subarray(0, 60)))
    ).rejects.toThrow("The memo PDF is damaged");
  });

  it("refuses a PDF with no pages to sign", async () => {
    await expect(assertSignablePdf(memo(NO_PAGES_PDF))).rejects.toThrow(
      "The memo PDF has no pages."
    );
  });

  it("refuses an empty file", async () => {
    await expect(assertSignablePdf(memo(Buffer.alloc(0)))).rejects.toThrow(
      "The memo file is empty."
    );
  });
});
