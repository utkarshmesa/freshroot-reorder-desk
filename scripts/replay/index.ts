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
import { compareWeeks, weekOfDate, type IsoWeek } from "@/lib/isoweek";
import { readReplayFiles } from "@/lib/replay/files";
import { replayAll, robustVerdict, weekSpan, type SkuData } from "@/lib/replay/replay";
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
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const dir = arg("dir") ?? fail("Usage: npm run replay -- --dir <folder with the export files> [--out <folder>] [--warmup 13]");
const outDir = arg("out", path.join("replay-out", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")))!;
const warmupWks = Number(arg("warmup", "13"));

const tables: ParsedTable[] = readdirSync(dir)
  .filter((f) => /\.(csv|xlsx)$/i.test(f))
  .map((f) => parseFile(f, new Uint8Array(readFileSync(path.join(dir, f)))));

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
const fatal = report.issues.filter((i) => i.level === "error" && !["unknown_sku", "unknown_distributor", "unknown_supplier", "missing_week"].includes(i.code));
if (fatal.length) fail("The export files have errors:\n" + fatal.map((i) => `- ${i.file ?? ""} ${i.message}`).join("\n"));
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
const ordered = new Map<string, Partial<Record<IsoWeek, number>>>();
for (const r of rows("sales")) {
  if (r.ordered_units === null || r.ordered_units === undefined) continue;
  const m = ordered.get(String(r.sku_id)) ?? ordered.set(String(r.sku_id), {}).get(String(r.sku_id))!;
  m[String(r.iso_week)] = (m[String(r.iso_week)] ?? 0) + Number(r.ordered_units);
}
const distributors: DistributorInput[] = rows("distributor").map((r) => ({ id: String(r.id), status: (r.status as "active" | "inactive") ?? "active", startWeek: (r.start_week as string) ?? null, endWeek: (r.end_week as string) ?? null }));
if (!distributors.length) distributors.push({ id: "ALL", status: "active", startWeek: null, endWeek: null });
const events: EventInput[] = rows("festival").map((r) => ({ type: "festival", startDate: String(r.start_date), endDate: String(r.end_date), skuIds: [], distributorIds: [], upliftPct: Number(r.uplift_pct), preloadWks: Number(r.preload_wks) }));

const files = readReplayFiles(tables);
if (files.errors.length) fail("The replay files have errors:\n" + files.errors.map((e) => `- ${e}`).join("\n"));
// Case data: the one inventory snapshot (staged as Sunday close, C-003) becomes a one-row stock history.
let stockKind: "history" | "snapshot" | null = files.stockFile ? "history" : null;
if (!files.stockFile) {
  for (const r of rows("stock")) {
    stockKind = "snapshot";
    const m = files.stockHistory.get(String(r.sku_id)) ?? files.stockHistory.set(String(r.sku_id), {}).get(String(r.sku_id))!;
    m[weekOfDate(String(r.as_of_ts).slice(0, 10))] = Number(r.on_hand_units);
  }
}

const allWeeks = [...new Set(sales.map((s) => s.week))].sort(compareWeeks);
if (allWeeks.length === 0) fail("No sales rows found.");
const weeks = weekSpan(allWeeks[0]!, allWeeks.at(-1)!);
const present = new Set(allWeeks);
const missingWeeks = weeks.filter((w) => !present.has(w));
const data: SkuData[] = skus.map((s) => ({
  sku: s,
  sales: sales.filter((x) => x.skuId === s.id),
  receipts: files.receipts.get(s.id) ?? {},
  stockHistory: files.stockHistory.get(s.id) ?? {},
  ordered: ordered.get(s.id),
}));

const base = { rules: DEFAULT_RULES, weeks, events, distributors, warmupWks, receiptsKnown: files.receiptsFile, missingWeeks };
const t0 = Date.now();
const main = replayAll(data, { ...base, reading: "any", infeasible: "skip" });
const late = replayAll(data, { ...base, reading: "any", infeasible: "skip", leadTimeExtraWks: 1 });
const readings = [main, replayAll(data, { ...base, reading: "share", infeasible: "skip" }), replayAll(data, { ...base, reading: "literal", infeasible: "skip" })];
const moq = replayAll(data, { ...base, reading: "any", infeasible: "moq" });
const verdict = robustVerdict(main, late);

// Method QA. Conservation is a regression guard for the simulator (it holds by construction when the code is right).
const arms = [main, late, ...readings.slice(1), moq].flatMap((s) => s.skus.flatMap((x) => [x.actual, x.rules])).filter((a) => a !== null);
const span53 = weeks.filter((w) => w.endsWith("W53"));
const qa = {
  conservation: arms.every((a) => Math.abs(a.opening + a.received - a.sold - a.writeOff - a.closingOnHand) < 1e-6),
  missingWeeks,
  w53: span53.length === 0 ? "none in this period" : span53.every((w) => present.has(w)) ? `present (${span53.join(", ")})` : `MISSING (${span53.filter((w) => !present.has(w)).join(", ")})`,
  stockRebuilt: main.skus.filter((s) => s.stockSource === "rebuilt").length,
};

const dataNote = [
  `${skus.length} SKUs, sales ${weeks[0]} to ${weeks.at(-1)} (${weeks.length} weeks)${caseMode ? ", case-study data" : ""}.`,
  files.receiptsFile ? "Receipts history: yes." : "Receipts history: **none**, so no verdict is possible.",
  stockKind === "history" ? "Weekly stock history: yes." : stockKind === "snapshot" ? "Stock: one snapshot only, rebuilt for the other weeks (D20)." : "Stock: **none**, so the actual arm can't be simulated.",
  ordered.size ? "Ordered units supplied: used as demand." : "Ordered units not supplied: demand is imputed in empty-shelf weeks.",
  `Run in ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
].join(" ");
const title = caseMode ? "Replay smoke test: case data (NOT the day-45 gate)" : "Day-45 gate: 3-year replay";
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "report.md"), renderReport({ title, dataNote, main, late, verdict, readings, moq, qa }));
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ dataNote, verdict, qa, main, late: { rules: late.rules, verdict: late.verdict }, readings: readings.map((r) => ({ reading: r.reading, rules: r.rules, actual: r.actual })), moq: { rules: moq.rules } }, null, 2));
console.log(`${verdict.result}: ${verdict.reasons.join(" ")}`);
console.log(`Wrote ${path.join(outDir, "report.md")}`);
