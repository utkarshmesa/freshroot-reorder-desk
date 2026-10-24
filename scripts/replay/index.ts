// Day-45 replay runner (REPLAY_SPEC). Reads files from a folder, writes results.json + report.md.
//
//   npm run replay -- --dir path/to/export [--out replay-out/name] [--warmup 13]
//
// Files are recognised by their headers, as in the app's upload:
//   sales (sales_weekly format, or the case weekly_sales), sku_master (or case sku_master),
//   receipts_history (iso_week, sku_id, received_units), stock_history (iso_week, sku_id, on_hand_units)
//   or the case current_inventory (one snapshot), calendar (case festival months), distributor_master.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DistributorInput, EventInput, SalesRow, SkuInput } from "@/lib/engine/types";
import { compareWeeks, prevWeek, weekOfDate, type IsoWeek } from "@/lib/isoweek";
import { replayAll, weekSpan, type SkuData } from "@/lib/replay/replay";
import { renderReport } from "@/lib/replay/report";
import { DEFAULT_RULES } from "@/lib/rules/defaults";
import { detectKind } from "@/lib/upload/detect";
import { parseFile } from "@/lib/upload/parse";
import type { ParsedTable } from "@/lib/upload/types";
import { prepareUpload } from "@/lib/upload/validate";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dir = arg("dir");
if (!dir) {
  console.error("Usage: npm run replay -- --dir <folder with the export files> [--out <folder>] [--warmup 13]");
  process.exit(1);
}
const outDir = arg("out", path.join("replay-out", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")))!;
const warmupWks = Number(arg("warmup", "13"));

const tables: ParsedTable[] = readdirSync(dir)
  .filter((f) => /\.(csv|xlsx)$/i.test(f))
  .map((f) => parseFile(f, new Uint8Array(readFileSync(path.join(dir, f)))));
const has = (t: ParsedTable, cols: string[]) => cols.every((c) => t.headers.includes(c));
const num = (v: string | undefined) => Number(String(v ?? "").replace(/,/g, ""));

// App-format and case-format files go through the app's own parser/validator (same mapping, C-011).
const known = tables.filter((t) => detectKind(t.headers) !== null);
const caseMode = known.some((t) => detectKind(t.headers)!.startsWith("case_"));
const { staging, report } = prepareUpload(
  known.map((t) => ({ name: t.name, hash: t.name, table: t })),
  {
    caseDataMode: caseMode,
    knownSkuIds: new Set(),
    knownDistributorIds: new Set(),
    knownSupplierIds: new Set(),
    committedHashes: new Set(),
    latestCommittedWeek: null,
    lastAsOf: null,
    previousWeekNetUnits: null,
    rules: { restatementWindowWks: 9999, volumeChangeConfirmPct: 1e9, festivalUpliftPct: DEFAULT_RULES.festivalUpliftPct, festivalPreloadWks: DEFAULT_RULES.festivalPreloadWks },
  },
);
const fatal = report.issues.filter((i) => i.level === "error" && !["unknown_sku", "unknown_distributor", "unknown_supplier"].includes(i.code));
if (fatal.length) {
  console.error("The export files have errors:\n" + fatal.map((i) => `- ${i.file ?? ""} ${i.message}`).join("\n"));
  process.exit(1);
}
const rows = (k: string) => staging.filter((s) => s.kind === k).map((s) => s.row);

const skus: SkuInput[] = rows("sku").map((r) => ({
  id: String(r.id),
  name: String(r.name),
  category: (r.category as string) ?? null,
  status: (r.status as "active" | "inactive") ?? "active",
  firstSaleWeek: (r.first_sale_week as string) ?? null,
  launchEstimateWk: (r.launch_estimate_wk as number) ?? null,
  stdQty: Number(r.std_qty),
  moq: (r.moq as number) ?? null,
  packSize: (r.pack_size as number) ?? null,
  leadTimeWks: (r.lead_time_wks as number) ?? null,
  shelfLifeWks: (r.shelf_life_wks as number) ?? null,
  perishable: Boolean(r.perishable),
  unitCostInr: (r.unit_cost_inr as number) ?? null,
  supplierId: (r.supplier_id as string) ?? null,
}));
const sales: SalesRow[] = rows("sales").map((r) => ({ skuId: String(r.sku_id), distributorId: String(r.distributor_id), week: String(r.iso_week), shipped: Number(r.shipped_units), returns: Number(r.returns_units) }));
const distributors: DistributorInput[] = [
  ...rows("distributor").map((r) => ({ id: String(r.id), status: (r.status as "active" | "inactive") ?? "active", startWeek: (r.start_week as string) ?? null, endWeek: (r.end_week as string) ?? null })),
];
const events: EventInput[] = rows("festival").map((r) => ({
  type: "festival",
  startDate: String(r.start_date),
  endDate: String(r.end_date),
  skuIds: [],
  distributorIds: [],
  upliftPct: Number(r.uplift_pct),
  preloadWks: Number(r.preload_wks),
}));

// Replay-only files.
const receipts = new Map<string, Partial<Record<IsoWeek, number>>>();
const stockHistory = new Map<string, Partial<Record<IsoWeek, number>>>();
let receiptsFile = false;
let stockFile: "history" | "snapshot" | null = null;
for (const t of tables) {
  if (has(t, ["iso_week", "sku_id", "received_units"])) {
    receiptsFile = true;
    for (const r of t.rows) (receipts.get(r.sku_id!) ?? receipts.set(r.sku_id!, {}).get(r.sku_id!)!)[r.iso_week!] = num(r.received_units);
  } else if (has(t, ["iso_week", "sku_id", "on_hand_units"])) {
    stockFile = "history";
    for (const r of t.rows) (stockHistory.get(r.sku_id!) ?? stockHistory.set(r.sku_id!, {}).get(r.sku_id!)!)[r.iso_week!] = num(r.on_hand_units);
  }
}
// Case data: the one inventory snapshot (staged as Sunday close, C-003) becomes a one-row stock history.
for (const r of rows("stock")) {
  if (stockFile === "history") break;
  stockFile = "snapshot";
  const week = weekOfDate(String(r.as_of_ts).slice(0, 10));
  (stockHistory.get(String(r.sku_id)) ?? stockHistory.set(String(r.sku_id), {}).get(String(r.sku_id))!)[week] = Number(r.on_hand_units);
}

const allWeeks = [...new Set(sales.map((s) => s.week))].sort(compareWeeks);
if (allWeeks.length === 0) {
  console.error("No sales rows found.");
  process.exit(1);
}
const weeks = weekSpan(allWeeks[0]!, allWeeks.at(-1)!);
const data: SkuData[] = skus.map((s) => ({ sku: s, sales: sales.filter((x) => x.skuId === s.id), receipts: receipts.get(s.id) ?? {}, stockHistory: stockHistory.get(s.id) ?? {} }));
if (!distributors.length) distributors.push({ id: "ALL", status: "active", startWeek: null, endWeek: null });

const base = { rules: DEFAULT_RULES, weeks, events, distributors, warmupWks };
const t0 = Date.now();
const main = replayAll(data, { ...base, reading: "any", infeasible: "skip" });
const readings = [main, replayAll(data, { ...base, reading: "share", infeasible: "skip" }), replayAll(data, { ...base, reading: "literal", infeasible: "skip" })];
const moq = replayAll(data, { ...base, reading: "any", infeasible: "moq" });

// Method QA over every simulated arm.
const arms = [...readings, moq].flatMap((s) => s.skus.flatMap((x) => [x.actual, x.rules])).filter((a) => a !== null);
// opening + receipts = sold + written off + closing, for every simulated arm.
const conservation = arms.every((a) => Math.abs(a.opening + a.received - a.sold - a.writeOff - a.closingOnHand) < 1e-6);
const qa = {
  conservation,
  negativeStock: arms.some((a) => a.closingOnHand < 0),
  weeksContiguous: weeks.length === allWeeks.length || weeks.every((w, i) => i === 0 || prevWeek(w) === weeks[i - 1]),
  hasW53: weeks.some((w) => w.endsWith("W53")),
};

const dataNote = [
  `${skus.length} SKUs, sales ${weeks[0]} to ${weeks.at(-1)} (${weeks.length} weeks)${caseMode ? ", case-study data" : ""}.`,
  receiptsFile ? "Receipts history: yes." : "Receipts history: **none**, so the actual arm assumes no receipts during the replay.",
  stockFile === "history" ? "Weekly stock history: yes." : stockFile === "snapshot" ? "Stock: one snapshot only, rebuilt for the other weeks (D20)." : "Stock: **none**, so the actual arm can't be simulated.",
  `Run in ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
].join(" ");
const title = caseMode ? "Replay smoke test: case data (NOT the day-45 gate)" : "Day-45 gate: 3-year replay";
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "report.md"), renderReport({ title, dataNote, main, readings, moq, qa }));
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ dataNote, qa, main, readings: readings.map((r) => ({ reading: r.reading, rules: r.rules, actual: r.actual })), moq: { rules: moq.rules } }, null, 2));
console.log(`${main.verdict.result}: ${main.verdict.reasons.join(" ")}`);
console.log(`Wrote ${path.join(outDir, "report.md")}`);
