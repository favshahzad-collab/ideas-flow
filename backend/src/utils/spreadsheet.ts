import ExcelJS from "exceljs";
import { errors } from "../lib/errors";
import { parseCsv } from "./csv";

/**
 * Parses an uploaded user-import file into rows keyed by header.
 *
 * Uses exceljs rather than xlsx (SheetJS): the latter carries two unfixed high
 * advisories — prototype pollution and a ReDoS — and this function runs on
 * bytes an administrator uploaded, so that parser sat directly on an input
 * path. exceljs reads the OOXML .xlsx format only, which is why the legacy
 * binary .xls format is now refused with an explanation rather than parsed.
 */

/** A user import is a staff list, not a data warehouse. */
export const MAX_IMPORT_ROWS = 10_000;

/**
 * exceljs hands back a typed value per cell — a Date, a formula object, rich
 * text, a hyperlink — where the old parser produced an already-formatted
 * string. Flatten each to the text a person would have seen in the sheet.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result);
    if ("error" in value) return "";
    return "";
  }
  return String(value);
}

export async function parseSpreadsheet(
  buffer: Buffer,
  filename: string
): Promise<Record<string, string>[]> {
  const lowerName = filename.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    return parseCsv(buffer.toString("utf-8"));
  }

  if (lowerName.endsWith(".xls")) {
    throw errors.badRequest(
      "The legacy .xls format is no longer supported. Open the file in Excel and save it as .xlsx, or export it as .csv."
    );
  }

  if (!lowerName.endsWith(".xlsx")) {
    throw errors.badRequest(
      "Unsupported file type. Upload a .csv or .xlsx file."
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw errors.badRequest(
      "That file could not be read as a spreadsheet. Check it is a valid .xlsx file."
    );
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber] = cellToString(cell.value).trim();
  });

  if (headers.filter(Boolean).length === 0) return [];

  // A 2 MB upload limit bounds the compressed bytes, not what they expand to,
  // so cap the rows rather than trusting the archive.
  if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
    throw errors.badRequest(
      `That file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`
    );
  }

  const rows: Record<string, string>[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const record: Record<string, string> = {};
    let hasValue = false;

    for (let columnNumber = 1; columnNumber < headers.length; columnNumber++) {
      const header = headers[columnNumber];
      if (!header) continue;

      // Missing cells become "" rather than being absent, so every row has the
      // same shape regardless of where the author stopped typing.
      const text = cellToString(row.getCell(columnNumber).value).trim();
      record[header] = text;
      if (text) hasValue = true;
    }

    // Blank rows between blocks are formatting, not data.
    if (hasValue) rows.push(record);
  }

  return rows;
}
