import { describe, expect, it } from "vitest";
import { prepareUpload } from "./validate";
import { codes, context, fixture } from "@/tests/helpers/upload";

const caseFiles = () =>
  ["calendar", "current_inventory", "distributor_master", "sku_master", "weekly_sales"].map((f) => fixture(`data/case/${f}.csv`));

const empty = () =>
  context({
    caseDataMode: true,
    knownSkuIds: new Set(),
    knownDistributorIds: new Set(),
    knownSupplierIds: new Set(),
    latestCommittedWeek: null,
    lastAsOf: null,
  });

describe("UP-13 case-data mode", () => {
  const p = prepareUpload(caseFiles(), empty());
  const rows = (k: string) => p.staging.filter((s) => s.kind === k).map((s) => s.row);

  it("case files load with no errors", () => {
    expect(p.report.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(p.report.kinds.sort()).toEqual(["case_calendar", "case_distributor_master", "case_inventory", "case_sku_master", "case_weekly_sales"]);
  });

  it("maps per C-011: 15 SKUs, 4 suppliers, ALL distributor, 240 sales rows, 15 stock rows", () => {
    expect(rows("sku")).toHaveLength(15);
    expect(rows("supplier").map((r) => r.id)).toEqual(["DIST001", "DIST002", "DIST003", "DIST004"]);
    expect(rows("distributor").map((r) => r.id)).toEqual(["ALL"]);
    expect(rows("sales")).toHaveLength(240);
    expect(rows("sales").every((r) => r.distributor_id === "ALL" && r.returns_units === 0)).toBe(true);
    expect(rows("stock")).toHaveLength(15);
  });

  it("reads perishability and the supplier column", () => {
    const almond = rows("sku").find((r) => r.id === "SKU004")!;
    expect(almond).toMatchObject({ perishable: true, std_qty: 150, supplier_id: "DIST002", lead_time_wks: null, moq: null, shelf_life_wks: null });
    expect(rows("sku").filter((r) => r.perishable).map((r) => r.id)).toEqual(["SKU004", "SKU007", "SKU011"]);
  });

  it("reads the Monday case stock date as Sunday 18 Oct 23:59 IST (C-003)", () => {
    expect(p.report.asOf).toBe("2026-10-18T23:59:00+05:30");
    expect(new Set(rows("stock").map((r) => r.as_of_ts))).toEqual(new Set(["2026-10-18T23:59:00+05:30"]));
  });

  it("turns month flags into merged festival events", () => {
    expect(rows("festival").map((r) => [r.start_date, r.end_date])).toEqual([
      ["2025-03-01", "2025-03-31"],
      ["2025-10-01", "2025-11-30"],
      ["2026-03-01", "2026-03-31"],
      ["2026-10-01", "2026-11-30"],
    ]);
    expect(rows("festival").every((r) => r.uplift_pct === 25 && r.preload_wks === 3)).toBe(true);
  });

  it("warns that DIST003 and DIST004 are outside the footprint, and shows the banner", () => {
    const w = p.report.issues.filter((i) => i.code === "outside_footprint").map((i) => i.message);
    expect(w).toHaveLength(2);
    expect(w.join(" ")).toMatch(/DIST003.*Karnataka/);
    expect(w.join(" ")).toMatch(/DIST004.*Gujarat/);
    expect(p.report.banner).toMatch(/top-3 distributor view is hidden/);
  });

  it("covers W27–W42 as new weeks", () => {
    expect(p.report.newWeeks[0]).toBe("2026-W27");
    expect(p.report.newWeeks.at(-1)).toBe("2026-W42");
    expect(p.report.newWeeks).toHaveLength(16);
  });

  it("case files are refused outside case-data mode", () => {
    const r = prepareUpload(caseFiles(), { ...empty(), caseDataMode: false }).report;
    expect(new Set(codes(r.issues, "error"))).toEqual(new Set(["case_file_outside_case_mode"]));
  });
});
