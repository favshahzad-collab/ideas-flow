import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseSpreadsheet } from "./spreadsheet";

/**
 * These cover the swap from xlsx (SheetJS) to exceljs. The shape the importer
 * relies on — rows keyed by header, every key present, values trimmed strings
 * — has to survive the change, so each case builds a real workbook and reads
 * it back through the parser.
 */

async function workbookBuffer(
  rows: (string | number | Date | null)[][]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Users");
  rows.forEach((row) => sheet.addRow(row));
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

describe("parseSpreadsheet — xlsx", () => {
  it("keys each row by its header", async () => {
    const buffer = await workbookBuffer([
      ["email", "firstName", "department"],
      ["maria.chen@example.com", "Maria", "Finance"],
      ["omar.haddad@example.com", "Omar", "Internal Audit"],
    ]);

    const rows = await parseSpreadsheet(buffer, "users.xlsx");

    expect(rows).toEqual([
      {
        email: "maria.chen@example.com",
        firstName: "Maria",
        department: "Finance",
      },
      {
        email: "omar.haddad@example.com",
        firstName: "Omar",
        department: "Internal Audit",
      },
    ]);
  });

  it("gives every row the same keys, blank where a cell is missing", async () => {
    const buffer = await workbookBuffer([
      ["email", "firstName", "department"],
      ["priya.nair@example.com", "Priya", null],
    ]);

    const [row] = await parseSpreadsheet(buffer, "users.xlsx");

    expect(Object.keys(row).sort()).toEqual([
      "department",
      "email",
      "firstName",
    ]);
    expect(row.department).toBe("");
  });

  it("trims surrounding whitespace", async () => {
    const buffer = await workbookBuffer([
      ["email", "firstName"],
      ["  tom.becker@example.com  ", "  Tom  "],
    ]);

    const [row] = await parseSpreadsheet(buffer, "users.xlsx");

    expect(row.email).toBe("tom.becker@example.com");
    expect(row.firstName).toBe("Tom");
  });

  it("stringifies numbers so a numeric employee id is not lost", async () => {
    const buffer = await workbookBuffer([
      ["employeeId", "firstName"],
      [4071, "Maria"],
    ]);

    const [row] = await parseSpreadsheet(buffer, "users.xlsx");

    expect(row.employeeId).toBe("4071");
  });

  it("skips blank rows used as spacing", async () => {
    const buffer = await workbookBuffer([
      ["email"],
      ["maria.chen@example.com"],
      [null],
      ["omar.haddad@example.com"],
    ]);

    const rows = await parseSpreadsheet(buffer, "users.xlsx");

    expect(rows).toHaveLength(2);
  });

  it("returns nothing for a header-only sheet", async () => {
    const buffer = await workbookBuffer([["email", "firstName"]]);
    expect(await parseSpreadsheet(buffer, "users.xlsx")).toEqual([]);
  });
});

describe("parseSpreadsheet — csv", () => {
  it("still routes csv through the csv parser", async () => {
    const csv = Buffer.from("email,firstName\nmaria.chen@example.com,Maria\n");
    const rows = await parseSpreadsheet(csv, "users.csv");

    expect(rows).toEqual([
      { email: "maria.chen@example.com", firstName: "Maria" },
    ]);
  });
});

describe("parseSpreadsheet — refusals", () => {
  it("explains why .xls is no longer accepted", async () => {
    await expect(
      parseSpreadsheet(Buffer.from("anything"), "users.xls")
    ).rejects.toThrow(/save it as \.xlsx/i);
  });

  it("rejects an unrelated extension", async () => {
    await expect(
      parseSpreadsheet(Buffer.from("anything"), "users.pdf")
    ).rejects.toThrow(/Upload a \.csv or \.xlsx file/i);
  });

  it("rejects bytes that are not a workbook rather than throwing raw", async () => {
    await expect(
      parseSpreadsheet(Buffer.from("not a spreadsheet at all"), "users.xlsx")
    ).rejects.toThrow(/could not be read as a spreadsheet/i);
  });
});
