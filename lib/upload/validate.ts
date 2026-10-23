// Validation before commit (BUILD_PLAN §7). Pure: the caller supplies parsed files and context,
// and gets back a report plus the staging rows that commit_upload() will apply all-or-nothing.
import { addWeeks, compareWeeks, isValidWeek, mondayOf, nextWeek, weekOfDate, weekRange } from "@/lib/isoweek";
import { detectKind, SHAPES } from "./detect";
import type { FileKind, InputFile, Issue, PreparedUpload, Report, StagingKind, StagingRow, UploadContext } from "./types";
import { parseAsOf, parseBool, parseDecimal, parseOptionalUnits, parseUnits } from "./values";

const LINK = {
  rejected: "/instructions#what-to-do-when",
  unknownId: "/instructions#what-to-do-when",
  uploader: "/instructions#uploader-priya",
  assumptions: "/instructions#assumptions",
};

export const CASE_DISTRIBUTOR_ID = "ALL";
const FOOTPRINT = new Set(["maharashtra", "goa"]);

type Ctx = {
  issues: Issue[];
  staging: StagingRow[];
  file: string;
};

function issue(c: Ctx, level: Issue["level"], code: string, message: string, row?: number, link = LINK.rejected) {
  c.issues.push({ level, code, message, file: c.file, row, link });
}

function stage(c: Ctx, kind: StagingKind, row: StagingRow["row"]) {
  c.staging.push({ kind, row });
}

// ---------- per-kind row mappers ----------

function units(c: Ctx, raw: string | undefined, field: string, row: number): number | null {
  const p = parseUnits(raw ?? "");
  if (!p.ok) {
    issue(c, "error", p.code, `${field}: ${p.message}`, row);
    return null;
  }
  return p.value;
}

function week(c: Ctx, raw: string | undefined, row: number): string | null {
  const w = (raw ?? "").trim();
  if (!isValidWeek(w)) {
    issue(c, "error", "invalid_week", `"${w}" is not a valid ISO week (YYYY-Www; only some years have W53)`, row);
    return null;
  }
  return w;
}

function mapSales(c: Ctx, rows: Array<Record<string, string>>, caseMode: boolean) {
  rows.forEach((r, i) => {
    const n = i + 1;
    const sku = (r.sku_id ?? "").trim();
    if (!sku) issue(c, "error", "missing_value", "sku_id is empty", n);
    const w = week(c, caseMode ? r.week : r.iso_week, n);
    const shipped = units(c, caseMode ? r.units_sold : r.shipped_units, caseMode ? "units_sold" : "shipped_units", n);
    const returns = caseMode ? 0 : units(c, r.returns_units, "returns_units", n);
    const ordered = caseMode ? { ok: true as const, value: null } : parseOptionalUnits(r.ordered_units);
    if (!ordered.ok) issue(c, "error", ordered.code, `ordered_units: ${ordered.message}`, n);
    const dist = caseMode ? CASE_DISTRIBUTOR_ID : (r.distributor_id ?? "").trim();
    if (!dist) issue(c, "error", "missing_value", "distributor_id is empty", n);
    if (sku && dist && w !== null && shipped !== null && returns !== null && ordered.ok) {
      stage(c, "sales", { sku_id: sku, distributor_id: dist, iso_week: w, shipped_units: shipped, returns_units: returns, ordered_units: ordered.value });
    }
  });
}

function mapStock(c: Ctx, rows: Array<Record<string, string>>, caseMode: boolean): string | null {
  const asOfs = new Set<string>();
  const locations = new Set<string>();
  rows.forEach((r, i) => {
    const n = i + 1;
    const sku = (r.sku_id ?? "").trim();
    if (!sku) issue(c, "error", "missing_value", "sku_id is empty", n);
    const onHand = units(c, r.units_on_hand ?? r.on_hand_units, caseMode ? "units_on_hand" : "on_hand_units", n);
    let asOf: string | null = null;
    if (caseMode) {
      // C-003: the case file is dated Monday; read it as SAP close the Sunday before.
      const d = (r.as_of_date ?? "").trim();
      try {
        const wk = weekOfDate(d);
        if (mondayOf(wk) !== d) issue(c, "error", "case_as_of_not_monday", `Case inventory date ${d} is not a Monday`, n);
        else asOf = `${new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)}T23:59:00+05:30`;
      } catch {
        issue(c, "error", "bad_as_of", `"${d}" is not a date`, n);
      }
      locations.add((r.location ?? "").trim());
    } else {
      const p = parseAsOf(r.as_of_ts ?? "");
      if (!p.ok) issue(c, "error", p.code, p.message, n, LINK.uploader);
      else asOf = p.value;
    }
    if (asOf) asOfs.add(asOf);
    if (sku && onHand !== null && asOf) stage(c, "stock", { sku_id: sku, as_of_ts: asOf, on_hand_units: onHand });
  });
  if (asOfs.size > 1) issue(c, "error", "mixed_as_of", `The stock file has ${asOfs.size} different as-of times; it must be one Sunday 23:59 snapshot`);
  if (locations.size > 1) issue(c, "error", "multiple_locations", "More than one warehouse location; multi-warehouse is not supported yet (deferred, BUILD_PLAN §14)");
  return asOfs.size === 1 ? [...asOfs][0]! : null;
}

function mapSkuMaster(c: Ctx, rows: Array<Record<string, string>>, caseMode: boolean) {
  rows.forEach((r, i) => {
    const n = i + 1;
    const id = ((caseMode ? r.sku_id : r.id) ?? "").trim();
    const name = ((caseMode ? r.sku_name : r.name) ?? "").trim();
    if (!id || !name) issue(c, "error", "missing_value", "SKU id and name are required", n);
    const std = units(c, caseMode ? r.standard_reorder_qty : r.std_qty, caseMode ? "standard_reorder_qty" : "std_qty", n);
    if (std === 0) issue(c, "error", "zero_std_qty", "Standard reorder quantity must be above 0", n);
    let perishable: boolean | null = null;
    if (caseMode) {
      const p = (r.perishability ?? "").trim().toLowerCase();
      if (p === "high") perishable = true;
      else if (p === "low") perishable = false;
      else issue(c, "error", "bad_perishability", `Perishability "${r.perishability}" must be High or Low`, n);
    } else {
      const p = parseBool(r.perishable);
      if (!p.ok) issue(c, "error", p.code, `perishable: ${p.message}`, n);
      else perishable = p.value;
    }
    const opt = (k: string) => {
      const p = parseDecimal(r[k]);
      if (!p.ok) issue(c, "error", p.code, `${k}: ${p.message}`, n);
      return p.ok ? p.value : null;
    };
    const optInt = (k: string) => {
      const p = parseOptionalUnits(r[k]);
      if (!p.ok) issue(c, "error", p.code, `${k}: ${p.message}`, n);
      return p.ok ? p.value : null;
    };
    const status = (r.status ?? "active").trim().toLowerCase() || "active";
    if (!["active", "inactive"].includes(status)) issue(c, "error", "bad_status", `status "${r.status}" must be active or inactive`, n);
    const firstSale = (r.first_sale_week ?? "").trim();
    if (firstSale && !isValidWeek(firstSale)) issue(c, "error", "invalid_week", `first_sale_week "${firstSale}" is not a valid ISO week`, n);
    if (!id || !name || std === null || perishable === null) return;
    stage(c, "sku", {
      id,
      name,
      category: (r.category ?? "").trim() || null,
      status,
      first_sale_week: firstSale || null,
      launch_estimate_wk: caseMode ? null : opt("launch_estimate_wk"),
      std_qty: std,
      moq: caseMode ? null : optInt("moq"),
      pack_size: caseMode ? null : optInt("pack_size"),
      uom: ((caseMode ? r.unit_of_measure : r.uom) ?? "").trim() || null,
      lead_time_wks: caseMode ? null : opt("lead_time_wks"),
      shelf_life_wks: caseMode ? null : opt("shelf_life_wks"),
      perishable,
      unit_cost_inr: caseMode ? null : opt("unit_cost_inr"),
      supplier_id: ((caseMode ? r.distributor_id : r.supplier_id) ?? "").trim(),
      zoho_item_id: caseMode ? null : (r.zoho_item_id ?? "").trim() || null,
    });
  });
}

function mapDistributorMaster(c: Ctx, rows: Array<Record<string, string>>, caseMode: boolean) {
  rows.forEach((r, i) => {
    const n = i + 1;
    const id = ((caseMode ? r.distributor_id : r.id) ?? "").trim();
    const name = ((caseMode ? r.distributor_name : r.name) ?? "").trim();
    if (!id || !name) {
      issue(c, "error", "missing_value", "id and name are required", n);
      return;
    }
    const region = (r.region ?? "").trim();
    if (caseMode) {
      // C-011: case "distributors" map one per SKU and behave like suppliers.
      stage(c, "supplier", { id, name });
      if (region && !FOOTPRINT.has(region.toLowerCase())) {
        issue(c, "warning", "outside_footprint", `${id} (${name}) is in ${region}, outside the stated Maharashtra/Goa footprint`, n);
      }
      return;
    }
    const status = (r.status ?? "active").trim().toLowerCase() || "active";
    if (!["active", "inactive"].includes(status)) issue(c, "error", "bad_status", `status "${r.status}" must be active or inactive`, n);
    for (const k of ["start_week", "end_week"]) {
      const v = (r[k] ?? "").trim();
      if (v && !isValidWeek(v)) issue(c, "error", "invalid_week", `${k} "${v}" is not a valid ISO week`, n);
    }
    stage(c, "distributor", { id, name, region: region || null, status, start_week: (r.start_week ?? "").trim() || null, end_week: (r.end_week ?? "").trim() || null });
  });
}

function mapCalendar(c: Ctx, rows: Array<Record<string, string>>, rules: UploadContext["rules"]) {
  // C-004: festival month flags become dated festival events; consecutive months merge.
  const months: Array<{ y: number; m: number }> = [];
  rows.forEach((r, i) => {
    const flag = (r.is_festival_month ?? "").trim().toUpperCase();
    if (!["TRUE", "FALSE"].includes(flag)) issue(c, "error", "not_a_boolean", `Is_Festival_Month "${r.is_festival_month}" must be TRUE or FALSE`, i + 1);
    const y = Number(r.year);
    const m = Number(r.month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) issue(c, "error", "bad_month", `Year/Month "${r.year}/${r.month}" is not valid`, i + 1);
    else if (flag === "TRUE") months.push({ y, m });
  });
  months.sort((a, b) => a.y * 12 + a.m - (b.y * 12 + b.m));
  const spans: Array<{ start: { y: number; m: number }; end: { y: number; m: number } }> = [];
  for (const mo of months) {
    const last = spans.at(-1);
    if (last && last.end.y * 12 + last.end.m + 1 === mo.y * 12 + mo.m) last.end = mo;
    else spans.push({ start: mo, end: mo });
  }
  for (const s of spans) {
    const start = `${s.start.y}-${String(s.start.m).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(s.end.y, s.end.m, 0)).toISOString().slice(0, 10);
    stage(c, "festival", { start_date: start, end_date: end, uplift_pct: rules.festivalUpliftPct, preload_wks: rules.festivalPreloadWks, reason: "Case calendar festival month flag" });
  }
}

// ---------- cross-file checks ----------

function sum<T>(xs: T[], f: (x: T) => number) {
  return xs.reduce((a, x) => a + f(x), 0);
}

export function prepareUpload(files: InputFile[], ctx: UploadContext): PreparedUpload {
  const issues: Issue[] = [];
  const staging: StagingRow[] = [];
  const kinds: FileKind[] = [];
  let asOf: string | null = null;
  const seenHashes = new Set<string>();

  for (const f of files) {
    const c: Ctx = { issues, staging, file: f.name };
    if (ctx.committedHashes.has(f.hash) || seenHashes.has(f.hash)) {
      issue(c, "error", "duplicate_hash", "This exact file has already been uploaded");
      continue;
    }
    seenHashes.add(f.hash);
    const kind = detectKind(f.table.headers);
    if (!kind) {
      issue(c, "error", "unknown_file_type", `Can't tell what this file is from its headers (${f.table.headers.join(", ") || "none"}). Use the saved SAP layouts.`, undefined, LINK.uploader);
      continue;
    }
    if (SHAPES[kind].caseOnly && !ctx.caseDataMode) {
      issue(c, "error", "case_file_outside_case_mode", "This is a case-study file; it is only accepted in case-data mode");
      continue;
    }
    if (kinds.includes(kind)) {
      issue(c, "error", "duplicate_kind", `Two ${kind} files in one upload`);
      continue;
    }
    kinds.push(kind);
    if (f.table.rows.length === 0) issue(c, "error", "empty_file", "The file has no data rows");
    switch (kind) {
      case "sales_weekly":
      case "case_weekly_sales":
        mapSales(c, f.table.rows, kind === "case_weekly_sales");
        break;
      case "stock_snapshot":
      case "case_inventory":
        asOf = mapStock(c, f.table.rows, kind === "case_inventory");
        break;
      case "sku_master":
      case "case_sku_master":
        mapSkuMaster(c, f.table.rows, kind === "case_sku_master");
        break;
      case "distributor_master":
      case "case_distributor_master":
        mapDistributorMaster(c, f.table.rows, kind === "case_distributor_master");
        break;
      case "case_calendar":
        mapCalendar(c, f.table.rows, ctx.rules);
        break;
    }
  }

  const g: Ctx = { issues, staging, file: "" };
  const rowsOf = (k: StagingKind) => staging.filter((s) => s.kind === k).map((s) => s.row);
  const sales = rowsOf("sales");
  const stock = rowsOf("stock");

  // Case-data mode always has the synthetic "ALL" distributor (C-011).
  if (ctx.caseDataMode && sales.length > 0 && !ctx.knownDistributorIds.has(CASE_DISTRIBUTOR_ID)) {
    staging.push({ kind: "distributor", row: { id: CASE_DISTRIBUTOR_ID, name: "All distributors (case data)", region: null, status: "active", start_week: null, end_week: null } });
  }

  // Unknown IDs: known in the DB or added by a master in this same upload (UP-08).
  const skuIds = new Set([...ctx.knownSkuIds, ...rowsOf("sku").map((r) => String(r.id))]);
  const distIds = new Set([...ctx.knownDistributorIds, ...rowsOf("distributor").map((r) => String(r.id))]);
  const supplierIds = new Set([...ctx.knownSupplierIds, ...rowsOf("supplier").map((r) => String(r.id))]);
  const unknown = (ids: string[], known: Set<string>, code: string, what: string) => {
    const missing = [...new Set(ids.filter((id) => !known.has(id)))].sort();
    if (missing.length) {
      g.issues.push({ level: "error", code, message: `Unknown ${what}: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ` and ${missing.length - 20} more` : ""}. Add or fix: add them in Settings, or correct the code in the file.`, link: LINK.unknownId });
    }
  };
  unknown([...sales.map((r) => String(r.sku_id)), ...stock.map((r) => String(r.sku_id))], skuIds, "unknown_sku", "SKU");
  unknown(sales.map((r) => String(r.distributor_id)), distIds, "unknown_distributor", "distributor");
  unknown(rowsOf("sku").map((r) => String(r.supplier_id)).filter(Boolean), supplierIds, "unknown_supplier", "supplier");

  // Duplicate rows.
  const dupes = (rows: StagingRow["row"][], key: (r: StagingRow["row"]) => string, what: string) => {
    const seen = new Set<string>();
    const d = new Set<string>();
    for (const r of rows) {
      const k = key(r);
      if (seen.has(k)) d.add(k);
      seen.add(k);
    }
    if (d.size) g.issues.push({ level: "error", code: "duplicate_row", message: `Duplicate ${what}: ${[...d].slice(0, 10).join(", ")}`, link: LINK.rejected });
  };
  dupes(sales, (r) => `${r.sku_id}/${r.distributor_id}/${r.iso_week}`, "sales rows (SKU/distributor/week)");
  dupes(stock, (r) => String(r.sku_id), "stock rows for SKU");

  // Weeks: new weeks must continue without gaps; older weeks are restatements within the window (D14).
  const weeks = [...new Set(sales.map((r) => String(r.iso_week)))].sort(compareWeeks);
  const latest = ctx.latestCommittedWeek;
  const newWeeks = latest ? weeks.filter((w) => compareWeeks(w, latest) > 0) : weeks;
  const oldWeeks = latest ? weeks.filter((w) => compareWeeks(w, latest) <= 0) : [];
  if (newWeeks.length) {
    const from = latest ? nextWeek(latest) : newWeeks[0]!;
    const expected = weekRange(from, newWeeks.at(-1)!);
    const missing = expected.filter((w) => !newWeeks.includes(w));
    if (missing.length) g.issues.push({ level: "error", code: "missing_week", message: `Missing week${missing.length > 1 ? "s" : ""} ${missing.join(", ")}: weeks must follow on without gaps`, link: LINK.rejected });
  }
  const restatedWeeks: string[] = [];
  if (latest) {
    const oldest = addWeeks(latest, -(ctx.rules.restatementWindowWks - 1));
    const locked = oldWeeks.filter((w) => compareWeeks(w, oldest) < 0);
    if (locked.length) g.issues.push({ level: "error", code: "restatement_locked", message: `Weeks older than ${ctx.rules.restatementWindowWks} weeks can't be corrected: ${locked.join(", ")}`, link: LINK.rejected });
    restatedWeeks.push(...oldWeeks.filter((w) => compareWeeks(w, oldest) >= 0));
    if (restatedWeeks.length) g.issues.push({ level: "warning", code: "restatement", message: `Corrects already-loaded week${restatedWeeks.length > 1 ? "s" : ""} ${restatedWeeks.join(", ")}. The change is logged.` });
  }

  // Volume change vs last week (±40% needs a confirm).
  if (newWeeks.length && ctx.previousWeekNetUnits && ctx.previousWeekNetUnits > 0) {
    const first = newWeeks[0]!;
    const net = sum(sales.filter((r) => r.iso_week === first), (r) => Number(r.shipped_units) - Number(r.returns_units));
    const pct = ((net - ctx.previousWeekNetUnits) / ctx.previousWeekNetUnits) * 100;
    if (Math.abs(pct) > ctx.rules.volumeChangeConfirmPct) {
      g.issues.push({ level: "confirm", code: "volume_change", message: `Total net units in ${first} changed ${pct > 0 ? "+" : ""}${pct.toFixed(0)}% vs ${latest} (${net} vs ${ctx.previousWeekNetUnits}). Confirm this is real before committing.` });
    }
  }

  // Stock as-of: older rejected, equal = correction of the current week (C-023d).
  if (asOf) {
    if (ctx.lastAsOf && Date.parse(asOf) < Date.parse(ctx.lastAsOf)) {
      g.issues.push({ level: "error", code: "stale_as_of", message: `Stock as-of ${asOf} is older than the last committed snapshot (${ctx.lastAsOf})`, link: LINK.rejected });
    } else if (ctx.lastAsOf && Date.parse(asOf) === Date.parse(ctx.lastAsOf)) {
      g.issues.push({ level: "warning", code: "stock_correction", message: `Same as-of as the last snapshot (${asOf}): this corrects the current week and re-runs it` });
    }
    // The snapshot's week must have sales loaded (already, or in this upload).
    const stockWeek = weekOfDate(asOf.slice(0, 10));
    const haveSales = weeks.includes(stockWeek) || (latest !== null && compareWeeks(latest, stockWeek) >= 0);
    if (!haveSales) g.issues.push({ level: "error", code: "stock_without_sales", message: `Stock is as at the end of ${stockWeek}, but sales for ${stockWeek} aren't loaded. Upload sales_weekly for ${stockWeek} too.`, link: LINK.uploader });
    // Active SKUs missing from the stock file are blocked from ordering in the run (fail closed per SKU).
    const inFile = new Set(stock.map((r) => String(r.sku_id)));
    const activeSkus = new Set([...(ctx.activeSkuIds ?? ctx.knownSkuIds), ...rowsOf("sku").filter((r) => r.status !== "inactive").map((r) => String(r.id))]);
    const missingStock = [...activeSkus].filter((s) => !inFile.has(s)).sort();
    if (missingStock.length) g.issues.push({ level: "warning", code: "stock_missing_sku", message: `No stock row for ${missingStock.length} SKU(s): ${missingStock.slice(0, 20).join(", ")}. They will be blocked from ordering this week.` });
  }

  // A weekly upload with sales but no stock can't start a run; say so (not an error: sales can be loaded early).
  if (sales.length && !stock.length && newWeeks.length) {
    g.issues.push({ level: "info", code: "no_stock_file", message: "No stock file: sales are loaded, but the weekly run starts only when the Sunday stock snapshot is committed." });
  }

  const banner = ctx.caseDataMode
    ? "Case-data mode: case files accepted as they are. No distributor detail (all sales = \"ALL\"), so the top-3 distributor view is hidden. The case stock date (Monday) is read as SAP close the Sunday before. Missing lead time / MOQ / shelf life / cost use the assumed defaults."
    : null;

  const count = (l: Issue["level"]) => issues.filter((i) => i.level === l).length;
  const counts: Partial<Record<StagingKind, number>> = {};
  for (const s of staging) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const report: Report = {
    issues,
    errors: count("error"),
    confirms: count("confirm"),
    unconfirmed: count("confirm"),
    warnings: count("warning"),
    kinds,
    newWeeks,
    restatedWeeks,
    asOf,
    banner,
    counts,
  };
  return { report, staging, hashes: files.map((f) => f.hash), files: files.map((f) => f.name) };
}
