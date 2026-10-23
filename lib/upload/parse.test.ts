import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { detectKind } from "./detect";
import { parseCsv, parseXlsx } from "./parse";
import { parseAsOf, parseUnits } from "./values";
import { fixture } from "@/tests/helpers/upload";

describe("UP-04 leading-zero SKU IDs preserved", () => {
  it("CSV keeps 00123 as text", () => {
    const t = fixture("tests/fixtures/upload/sku_leading_zero.csv").table;
    expect(t.rows[0]!.id).toBe("00123");
  });

  it("XLSX keeps 00123 whether stored as text or as a zero-padded number", () => {
    const ws = XLSX.utils.aoa_to_sheet([["id", "name", "std_qty", "perishable", "supplier_id"], ["00123", "Text cell", 100, "false", "SUP1"]]);
    // A numeric cell 456 formatted "00000" shows as 00456 in Excel.
    XLSX.utils.sheet_add_aoa(ws, [[{ t: "n", v: 456, z: "00000" }, "Formatted number", 100, "false", "SUP1"]], { origin: -1 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const t = parseXlsx("sku.xlsx", bytes);
    expect(t.rows.map((r) => r.id)).toEqual(["00123", "00456"]);
    expect(detectKind(t.headers)).toBe("sku_master");
  });

  it("strips a UTF-8 BOM and normalises header case", () => {
    const t = parseCsv("x.csv", "﻿ISO_Week, SKU_ID ,distributor_id,shipped_units,returns_units\n2026-W44,0007,D1,1,0\n");
    expect(t.headers).toEqual(["iso_week", "sku_id", "distributor_id", "shipped_units", "returns_units"]);
    expect(t.rows[0]!.sku_id).toBe("0007");
  });
});

describe("UP-05 strict numbers", () => {
  it.each([
    ["1,200", 1200],
    ["1,20,000", 120000],
    ["12,345,678", 12345678],
    ["1200", 1200],
    ["1200.0", 1200],
    [" 75 ", 75],
    ["0", 0],
  ])("%s → %d", (raw, value) => {
    expect(parseUnits(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["1.5", "not_an_integer"],
    ["12a", "not_a_number"],
    ["1,2,3", "not_a_number"],
    ["-3", "negative_value"],
    ["", "missing_value"],
    ["N/A", "not_a_number"],
  ])("%s → %s", (raw, code) => {
    const p = parseUnits(raw);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe(code);
  });
});

describe("stock as-of (D15)", () => {
  it("accepts Sunday 23:59 IST in its usual forms", () => {
    for (const raw of ["2026-10-18T23:59:00+05:30", "2026-10-18 23:59", "2026-10-18", "2026-10-18T18:29:00Z"]) {
      expect(parseAsOf(raw)).toEqual({ ok: true, value: "2026-10-18T23:59:00+05:30" });
    }
  });

  it("rejects a Monday-morning export and says exactly what to re-export", () => {
    const p = parseAsOf("2026-10-19T08:00:00+05:30");
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.code).toBe("as_of_not_sunday_close");
      expect(p.message).toContain("Sunday 2026-10-18");
    }
  });

  it("rejects non-dates", () => {
    expect(parseAsOf("18/10/2026").ok).toBe(false);
    expect(parseAsOf("2026-02-30").ok).toBe(false);
  });
});
