/**
 * A cell that starts with one of these is a formula to Excel, LibreOffice and
 * Google Sheets, and this file is built from text people typed - a memo
 * title, a comment, a name. A title of `=HYPERLINK("https://...","Open")` or
 * `@SUM(1+1)*cmd|' /C calc'!A0` would run when an auditor opened the export.
 * Tab and carriage return are on the list because some spreadsheets skip
 * them and read the formula behind.
 */
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Put a leading apostrophe in front, which every spreadsheet reads as "this
 * is text" and does not display. The cell reads as typed; it just never runs.
 * This is OWASP's advice for CSV injection. The one cost is that a CSV reader
 * which is not a spreadsheet sees the apostrophe - acceptable for an export
 * that exists to be opened in one.
 */
function neutraliseFormula(str: string): string {
  return FORMULA_TRIGGERS.has(str.charAt(0)) ? `'${str}` : str;
}

function escapeCsvField(value: string | number | null | undefined): string {
  const str = neutraliseFormula(
    value === null || value === undefined ? "" : String(value)
  );

  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function buildCsv(headers: string[], rows: string[][]): string {
  const headerLine = headers.map(escapeCsvField).join(",");
  const dataLines = rows.map((row) => row.map(escapeCsvField).join(","));

  return `\uFEFF${[headerLine, ...dataLines].join("\r\n")}`;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const content = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      continue;
    } else if (char === "\n") {
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim());

  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? "").trim();
    });
    return record;
  });
}
