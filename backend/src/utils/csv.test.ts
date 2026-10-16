import { describe, expect, it } from "vitest";
import { buildCsv, parseCsv } from "./csv";

/**
 * Both halves of the bulk-user path: an administrator downloads a template,
 * fills it in, and uploads it. Names with commas and titles with quotes in
 * them are ordinary, so the round trip is the test that matters - a writer and
 * a reader that disagree lose data quietly rather than failing.
 */

const BOM = "\uFEFF";

describe("buildCsv", () => {
  it("starts with a BOM so Excel reads it as UTF-8", () => {
    // Without it Excel opens the file as the local ANSI code page and every
    // non-ASCII name comes out mangled.
    expect(buildCsv(["name"], [["Ayesha"]]).startsWith(BOM)).toBe(true);
  });

  it("separates rows with CRLF", () => {
    expect(buildCsv(["a", "b"], [["1", "2"]])).toBe(`${BOM}a,b\r\n1,2`);
  });

  it("quotes a field containing a comma", () => {
    expect(buildCsv(["name"], [["Khan, Ayesha"]])).toContain('"Khan, Ayesha"');
  });

  it("quotes a field containing a newline", () => {
    expect(buildCsv(["note"], [["first\nsecond"]])).toContain(
      '"first\nsecond"'
    );
  });

  it("doubles an embedded quote and wraps the field", () => {
    expect(buildCsv(["title"], [['the "final" draft']])).toContain(
      '"the ""final"" draft"'
    );
  });

  it("leaves an ordinary field alone", () => {
    expect(buildCsv(["email"], [["a@b.com"]])).toBe(`${BOM}email\r\na@b.com`);
  });

  it("writes an empty cell for a missing value", () => {
    expect(
      buildCsv(["a", "b", "c"], [[null, undefined, ""] as unknown as string[]])
    ).toBe(`${BOM}a,b,c\r\n,,`);
  });

  it("emits headers alone when there are no rows", () => {
    expect(buildCsv(["a", "b"], [])).toBe(`${BOM}a,b`);
  });
});

describe("parseCsv", () => {
  it("reads a plain file into records keyed by header", () => {
    expect(parseCsv("name,email\nAyesha,a@b.com")).toEqual([
      { name: "Ayesha", email: "a@b.com" },
    ]);
  });

  it("strips a BOM rather than baking it into the first header", () => {
    // A file saved by Excel starts with one, and a header that still
    // carries it does not equal the header the importer is looking for.
    expect(parseCsv(`${BOM}name\nAyesha`)).toEqual([{ name: "Ayesha" }]);
  });

  it("accepts CRLF as well as LF", () => {
    expect(parseCsv("name\r\nAyesha\r\nBilal")).toEqual([
      { name: "Ayesha" },
      { name: "Bilal" },
    ]);
  });

  it("trims whitespace around headers and cells", () => {
    expect(parseCsv(" name , email \n Ayesha , a@b.com ")).toEqual([
      { name: "Ayesha", email: "a@b.com" },
    ]);
  });

  it("keeps a quoted comma inside its field", () => {
    expect(parseCsv('name,role\n"Khan, Ayesha",Reviewer')).toEqual([
      { name: "Khan, Ayesha", role: "Reviewer" },
    ]);
  });

  it("keeps a quoted newline inside its field", () => {
    expect(parseCsv('note\n"first\nsecond"')).toEqual([
      { note: "first\nsecond" },
    ]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(parseCsv('title\n"the ""final"" draft"')).toEqual([
      { title: 'the "final" draft' },
    ]);
  });

  it("skips blank lines instead of yielding empty records", () => {
    // A trailing newline is normal, and a row of empty strings would be
    // offered to the importer as a user with no name.
    expect(parseCsv("name\nAyesha\n\nBilal\n")).toEqual([
      { name: "Ayesha" },
      { name: "Bilal" },
    ]);
  });

  it("fills a short row with empty strings", () => {
    expect(parseCsv("name,email,role\nAyesha,a@b.com")).toEqual([
      { name: "Ayesha", email: "a@b.com", role: "" },
    ]);
  });

  it("drops cells past the last header", () => {
    expect(parseCsv("name\nAyesha,ignored")).toEqual([{ name: "Ayesha" }]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("returns nothing for a header-only file", () => {
    expect(parseCsv("name,email")).toEqual([]);
  });
});

describe("round trip", () => {
  it("survives everything that needs quoting", () => {
    const headers = ["name", "note", "title"];
    const rows = [
      ["Khan, Ayesha", "first\nsecond", 'the "final" draft'],
      ["Bilal", "", "plain"],
    ];

    expect(parseCsv(buildCsv(headers, rows))).toEqual([
      {
        name: "Khan, Ayesha",
        note: "first\nsecond",
        title: 'the "final" draft',
      },
      { name: "Bilal", note: "", title: "plain" },
    ]);
  });
});

describe("formula injection", () => {
  /*
   * The audit export is built from memo titles, comments and names - text
   * anybody signed in can type. Opened in a spreadsheet, a cell starting with
   * one of these runs as a formula on the auditor's machine.
   */
  it.each([
    ['=HYPERLINK("https://evil.example","Open")'],
    ["+1+1"],
    ["-2+3"],
    ["@SUM(1+1)"],
    ["\t=1+1"],
    ["\r=1+1"],
  ])("makes %j read as text", (typed) => {
    const csv = buildCsv(["Comments"], [[typed]]);
    const cell = csv.split("\r\n")[1];
    // Quoted or not, the first character a spreadsheet sees is the apostrophe.
    expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    expect(parseCsv(csv)[0].Comments).toBe(`'${typed}`.trim());
  });

  it("keeps the rest of the cell exactly as typed", () => {
    expect(buildCsv(["t"], [["=1+1"]])).toBe(`${BOM}t\r\n'=1+1`);
  });

  it("still quotes a neutralised cell that needs quoting", () => {
    expect(buildCsv(["t"], [['=SUM(A1,"x")']])).toBe(`${BOM}t\r\n"'=SUM(A1,""x"")"`);
  });

  it("covers the header row too", () => {
    expect(buildCsv(["=cmd"], [])).toBe(`${BOM}'=cmd`);
  });

  it("leaves a trigger character that is not at the front alone", () => {
    expect(buildCsv(["t"], [["Ayesha - approved = yes @ 4pm"]])).toBe(
      `${BOM}t\r\nAyesha - approved = yes @ 4pm`
    );
  });

  it("leaves the ISO timestamps and ids the export is made of alone", () => {
    expect(buildCsv(["d"], [["2026-09-29T10:00:00.000Z"]])).toBe(
      `${BOM}d\r\n2026-09-29T10:00:00.000Z`
    );
  });
});
