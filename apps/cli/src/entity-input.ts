import { RepositoryFormatError, parseYamlMapping, parseYamlValue } from "@gitpm/repository-format";

const MAX_IMPORT_BYTES = 10 * 1_048_576;
const MAX_IMPORT_ROWS = 10_000;
const MAX_IMPORT_COLUMNS = 100;

function assertImportSize(text: string, source: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new RepositoryFormatError("IMPORT_SIZE_LIMIT", "Import file exceeds the 10 MiB limit", source);
  }
}

export function parseEntityMapping(text: string, source: string): Readonly<Record<string, unknown>> {
  return parseYamlMapping(text, source);
}

function csvRows(text: string, source: string): string[][] {
  assertImportSize(text, source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  const finishField = (): void => { row.push(field); field = ""; afterQuote = false; };
  const finishRow = (): void => {
    finishField();
    if (row.some((value) => value !== "") || rows.length > 0) rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new RepositoryFormatError("IMPORT_ROW_LIMIT", `Import exceeds ${MAX_IMPORT_ROWS} data rows`, source);
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; afterQuote = true; }
      } else field += character;
      continue;
    }
    if (afterQuote && ![",", "\r", "\n"].includes(character)) {
      throw new RepositoryFormatError("CSV_SYNTAX", `Unexpected character after closing quote at offset ${index}`, source);
    }
    if (character === '"') {
      if (field !== "") throw new RepositoryFormatError("CSV_SYNTAX", `Unexpected quote at offset ${index}`, source);
      quoted = true;
    } else if (character === ",") finishField();
    else if (character === "\n") finishRow();
    else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      finishRow();
    } else field += character;
    if (row.length > MAX_IMPORT_COLUMNS) throw new RepositoryFormatError("IMPORT_COLUMN_LIMIT", `Import exceeds ${MAX_IMPORT_COLUMNS} columns`, source);
  }
  if (quoted) throw new RepositoryFormatError("CSV_SYNTAX", "Unterminated quoted field", source);
  if (field !== "" || row.length > 0) finishRow();
  return rows;
}

function coerceCsvValue(key: string, value: string, source: string, row: number): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (["weekly_capacity_hours", "estimate_hours"].includes(key)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) throw new RepositoryFormatError("CSV_VALUE_INVALID", `Row ${row} field ${key} must be a number`, source);
    return parsed;
  }
  if (["members", "assignees", "depends_on", "labels", "milestone_order", "task_order", "working_weekdays", "holidays"].includes(key)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed;
    } catch {
      throw new RepositoryFormatError("CSV_VALUE_INVALID", `Row ${row} field ${key} must be a JSON array`, source);
    }
  }
  return trimmed;
}

export function parseCsvEntities(text: string, source: string): readonly Readonly<Record<string, unknown>>[] {
  const rows = csvRows(text.replace(/^\uFEFF/u, ""), source);
  const header = rows[0]?.map((value) => value.trim());
  if (header === undefined || header.length === 0 || header.some((value) => value === "")) {
    throw new RepositoryFormatError("CSV_HEADER_INVALID", "CSV header is required and cannot contain empty names", source);
  }
  if (new Set(header).size !== header.length) throw new RepositoryFormatError("CSV_HEADER_INVALID", "CSV header contains duplicate names", source);
  return rows.slice(1).filter((row) => row.some((value) => value.trim() !== "")).map((row, index) => {
    if (row.length !== header.length) {
      throw new RepositoryFormatError("CSV_ROW_INVALID", `Row ${index + 2} has ${row.length} fields; expected ${header.length}`, source);
    }
    const result: Record<string, unknown> = {};
    for (let column = 0; column < header.length; column += 1) {
      const value = coerceCsvValue(header[column]!, row[column]!, source, index + 2);
      if (value !== undefined) result[header[column]!] = value;
    }
    return result;
  });
}

export function parseYamlEntities(text: string, source: string): readonly Readonly<Record<string, unknown>>[] {
  assertImportSize(text, source);
  const value = parseYamlValue(text, source);
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new RepositoryFormatError("IMPORT_ROOT_TYPE", "YAML import root must be an array of mappings", source);
  }
  if (value.length > MAX_IMPORT_ROWS) throw new RepositoryFormatError("IMPORT_ROW_LIMIT", `Import exceeds ${MAX_IMPORT_ROWS} data rows`, source);
  return value as readonly Readonly<Record<string, unknown>>[];
}

export function parseJsonLinesEntities(text: string, source: string): readonly Readonly<Record<string, unknown>>[] {
  assertImportSize(text, source);
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_IMPORT_ROWS) throw new RepositoryFormatError("IMPORT_ROW_LIMIT", `Import exceeds ${MAX_IMPORT_ROWS} data rows`, source);
  return lines.map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new RepositoryFormatError("JSONL_SYNTAX", `Invalid JSON on line ${index + 1}`, source); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RepositoryFormatError("IMPORT_ROOT_TYPE", `JSONL line ${index + 1} must be an object`, source);
    }
    return value as Readonly<Record<string, unknown>>;
  });
}
