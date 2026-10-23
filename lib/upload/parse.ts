// CSV / XLSX → table of strings. IDs stay text, so leading zeros survive (UP-04).
import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ParsedTable } from "./types";

const normaliseHeader = (h: string) => h.replace(/^﻿/, "").trim().toLowerCase();

function toTable(name: string, matrix: string[][]): ParsedTable {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  const [head = [], ...body] = nonEmpty;
  const headers = head.map((h) => normaliseHeader(String(h ?? "")));
  const rows = body.map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()])));
  return { name, headers, rows };
}

export function parseCsv(name: string, text: string): ParsedTable {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ""), { header: false, skipEmptyLines: "greedy", dynamicTyping: false });
  return toTable(name, res.data);
}

export function parseXlsx(name: string, bytes: Uint8Array): ParsedTable {
  const wb = XLSX.read(bytes, { type: "array", cellDates: false, cellText: true });
  const first = wb.SheetNames[0];
  if (!first) return { name, headers: [], rows: [] };
  const sheet = wb.Sheets[first]!;
  // raw:false → the formatted text Excel shows, so "00123" and dates keep their written form.
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", dateNF: "yyyy-mm-dd" });
  return toTable(name, matrix);
}

export function parseFile(name: string, bytes: Uint8Array): ParsedTable {
  return /\.xlsx$/i.test(name) ? parseXlsx(name, bytes) : parseCsv(name, new TextDecoder("utf-8").decode(bytes));
}
