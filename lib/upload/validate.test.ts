import { describe, expect, it } from "vitest";
import { prepareUpload } from "./validate";
import { codes, context, csv, fixture } from "@/tests/helpers/upload";

const F = "tests/fixtures/upload/";

describe("UP-01 duplicate file rejected", () => {
  it("rejects a file whose hash was committed before", () => {
    const a = fixture(F + "sales_w44.csv");
    const dup = fixture(F + "sales_w44_dup.csv");
    expect(dup.hash).toBe(a.hash);
    const r = prepareUpload([dup], context({ committedHashes: new Set([a.hash]) })).report;
    expect(codes(r.issues, "error")).toContain("duplicate_hash");
  });

  it("rejects the same file twice in one upload", () => {
    const r = prepareUpload([fixture(F + "sales_w44.csv"), fixture(F + "sales_w44_dup.csv")], context()).report;
    expect(codes(r.issues, "error")).toContain("duplicate_hash");
  });
});

describe("UP-02 stock as-of", () => {
  it("older than the last run → stale_as_of", () => {
    const r = prepareUpload([fixture(F + "stock_old_asof.csv")], context()).report;
    expect(codes(r.issues, "error")).toContain("stale_as_of");
  });

  it("equal to the last run → accepted as a correction (C-023d)", () => {
    const r = prepareUpload([fixture(F + "stock_same_asof.csv")], context({ knownSkuIds: new Set(["SKU001"]) })).report;
    expect(r.errors).toBe(0);
    expect(codes(r.issues, "warning")).toContain("stock_correction");
  });

  it("a Monday-morning export is rejected with a precise message", () => {
    const r = prepareUpload([fixture(F + "stock_monday_morning.csv")], context()).report;
    const e = r.issues.find((i) => i.code === "as_of_not_sunday_close");
    expect(e?.level).toBe("error");
    expect(e?.message).toContain("Sunday 2026-10-25");
  });
});

describe("UP-03 missing week rejected", () => {
  it("names the missing week", () => {
    const r = prepareUpload([fixture(F + "sales_gap_w46.csv")], context()).report;
    const e = r.issues.find((i) => i.code === "missing_week");
    expect(e?.message).toContain("2026-W45");
  });

  it("a first new week that skips ahead of the last committed week is missing weeks too", () => {
    const r = prepareUpload([csv("s.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W45,SKU001,D001,1,0\n")], context()).report;
    expect(r.issues.find((i) => i.code === "missing_week")?.message).toContain("2026-W44");
  });
});

describe("UP-05 numbers in context", () => {
  it('stages "1,200" and "1,20,000" as numbers', () => {
    const p = prepareUpload([fixture(F + "sales_thousands.csv")], context());
    expect(p.report.errors).toBe(0);
    expect(p.staging.filter((s) => s.kind === "sales").map((s) => s.row.shipped_units)).toEqual([1200, 120000]);
  });
});

describe("UP-06 partial set not committed", () => {
  it("a valid sales file plus an invalid stock file has errors, so nothing can commit", () => {
    const r = prepareUpload([fixture(F + "partial_set/sales_w43.csv"), fixture(F + "partial_set/stock_w43.csv")], context({ latestCommittedWeek: "2026-W42" })).report;
    expect(codes(r.issues, "error")).toContain("negative_value");
    expect(r.errors).toBeGreaterThan(0);
  });
});

describe("UP-07 restatement window", () => {
  it("W40 after W43 is accepted and listed", () => {
    const r = prepareUpload([fixture(F + "restate_w40.csv")], context()).report;
    expect(r.errors).toBe(0);
    expect(r.restatedWeeks).toEqual(["2026-W40"]);
    expect(codes(r.issues, "warning")).toContain("restatement");
  });

  it("W30 after W43 is locked (older than 12 weeks)", () => {
    const r = prepareUpload([fixture(F + "restate_w30.csv")], context()).report;
    expect(codes(r.issues, "error")).toContain("restatement_locked");
  });

  it("the window boundary is exactly 12 weeks: W32 ok, W31 locked", () => {
    const mk = (w: string) => csv(`r${w}.csv`, `iso_week,sku_id,distributor_id,shipped_units,returns_units\n${w},SKU001,D001,1,0\n`);
    expect(prepareUpload([mk("2026-W32")], context()).report.errors).toBe(0);
    expect(codes(prepareUpload([mk("2026-W31")], context()).report.issues)).toContain("restatement_locked");
  });
});

describe("UP-08 unknown IDs prompt add-or-fix", () => {
  it("lists unknown SKUs and distributors with a link", () => {
    const r = prepareUpload([fixture(F + "unknown_ids.csv")], context()).report;
    const sku = r.issues.find((i) => i.code === "unknown_sku")!;
    expect(sku.message).toMatch(/SKU999/);
    expect(sku.message).toMatch(/Add or fix/);
    expect(sku.link).toBe("/instructions#what-to-do-when");
    expect(codes(r.issues, "error")).toContain("unknown_distributor");
  });

  it("a SKU added by a master in the same upload is known", () => {
    const master = csv("sku.csv", "id,name,std_qty,perishable,supplier_id\nSKU999,New,10,false,SUP1\n");
    const dist = csv("d.csv", "id,name\nD999,New distributor\n");
    const r = prepareUpload([master, dist, fixture(F + "unknown_ids.csv")], context()).report;
    expect(r.errors).toBe(0);
  });
});

describe("UP-09 W52 → W53 → W01 across three uploads", () => {
  const up = (w: string, latest: string) =>
    prepareUpload([fixture(`${F}w52_w53_w01/sales_${w}.csv`)], context({ latestCommittedWeek: latest })).report;

  it("each week follows on with no missing-week error", () => {
    expect(up("2026-W52", "2026-W51").errors).toBe(0);
    expect(up("2026-W53", "2026-W52").errors).toBe(0);
    expect(up("2027-W01", "2026-W53").errors).toBe(0);
  });

  it("skipping W53 is a missing week", () => {
    expect(up("2027-W01", "2026-W52").issues.find((i) => i.code === "missing_week")?.message).toContain("2026-W53");
  });

  it("2027-W53 does not exist", () => {
    const r = prepareUpload([csv("x.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2027-W53,SKU001,D001,1,0\n")], context()).report;
    expect(codes(r.issues, "error")).toContain("invalid_week");
  });

  it("the 12-week restatement window counts across the year end", () => {
    // Latest 2027-W02 → oldest correctable week is 2026-W44 (W44…W53 = 10 weeks, plus W01, W02).
    const mk = (w: string) => csv(`r${w}.csv`, `iso_week,sku_id,distributor_id,shipped_units,returns_units\n${w},SKU001,D001,1,0\n`);
    expect(prepareUpload([mk("2026-W44")], context({ latestCommittedWeek: "2027-W02" })).report.errors).toBe(0);
    expect(codes(prepareUpload([mk("2026-W43")], context({ latestCommittedWeek: "2027-W02" })).report.issues)).toContain("restatement_locked");
  });
});

describe("UP-10 to UP-12", () => {
  it("UP-10 volume change over ±40% needs a confirm", () => {
    const p = prepareUpload([fixture(F + "sales_w44.csv")], context({ previousWeekNetUnits: 500 }));
    expect(codes(p.report.issues, "confirm")).toEqual(["volume_change"]);
    expect(p.report.unconfirmed).toBe(1);
    const small = prepareUpload([fixture(F + "sales_w44.csv")], context({ previousWeekNetUnits: 1200 }));
    expect(small.report.confirms).toBe(0);
  });

  it("UP-11 negatives rejected", () => {
    const r = prepareUpload([csv("n.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W44,SKU001,D001,-5,0\n")], context()).report;
    expect(codes(r.issues, "error")).toContain("negative_value");
  });

  it("UP-12 type is detected from headers, not the file name; unknown headers are rejected", () => {
    const r = prepareUpload([csv("stock.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W44,SKU001,D001,5,0\n")], context()).report;
    expect(r.kinds).toEqual(["sales_weekly"]);
    const bad = prepareUpload([csv("sales.csv", "week,sku,qty\n2026-W44,SKU001,5\n")], context()).report;
    expect(codes(bad.issues, "error")).toEqual(["unknown_file_type"]);
  });

  it("stock for a week without sales is rejected", () => {
    // Sales are loaded to W43; a snapshot at the end of W44 (Sun 1 Nov) needs W44 sales.
    const r = prepareUpload([csv("s.csv", "as_of_ts,sku_id,on_hand_units\n2026-11-01,SKU001,10\n")], context()).report;
    expect(r.issues.find((i) => i.code === "stock_without_sales")?.message).toContain("2026-W44");
    const ok = prepareUpload([csv("s.csv", "as_of_ts,sku_id,on_hand_units\n2026-10-25,SKU001,10\n")], context({ lastAsOf: "2026-10-18T23:59:00+05:30" })).report;
    expect(codes(ok.issues, "error")).not.toContain("stock_without_sales");
  });

  it("active SKUs missing from the stock file are warned (blocked per SKU in the run)", () => {
    const r = prepareUpload(
      [csv("sales.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W44,SKU001,D001,5,0\n"), csv("s.csv", "as_of_ts,sku_id,on_hand_units\n2026-11-01,SKU001,10\n")],
      context(),
    ).report;
    expect(r.errors).toBe(0);
    expect(r.issues.find((i) => i.code === "stock_missing_sku")?.message).toContain("SKU002");
  });

  it("duplicate rows are rejected", () => {
    const r = prepareUpload([csv("d.csv", "iso_week,sku_id,distributor_id,shipped_units,returns_units\n2026-W44,SKU001,D001,5,0\n2026-W44,SKU001,D001,6,0\n")], context()).report;
    expect(codes(r.issues, "error")).toContain("duplicate_row");
  });
});
