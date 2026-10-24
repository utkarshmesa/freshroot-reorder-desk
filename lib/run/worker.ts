import "server-only";
// The weekly run as a resumable state machine (ARCHITECTURE §4, BUILD_PLAN §8). Each call claims the run
// with a row lease, does the remaining steps, and releases it. Safe to call from the commit trigger and the
// cron at once. Steps: queued → readback → zoho_read → mapping → engine → ready → (Claude) → done.
// The queue is visible at "ready" with template reasons; checked Claude text replaces them afterwards and the
// LLM never blocks the run (ARCHITECTURE §4, §6).
//
// Read-back comes first (review M3, finding 6): a draft seen pending holds its supplier back for the week
// (C-023b) even if it's issued a moment later, and anything issued by then is in the PO read that follows.
// Every step's result is stored on the run, so a cut-short invocation resumes where it stopped.
// Case-data mode skips Zoho (the W43 reference assumes no open POs).
import type { SupabaseClient } from "@supabase/supabase-js";
import { runEngine } from "@/lib/engine";
import type { PoLine, Receipt, Recommendation } from "@/lib/engine/types";
import { productionLlm } from "@/lib/llm/client";
import { explainBrief, explainCard, type LlmCall } from "@/lib/llm/explain";
import { briefFacts, cardFacts } from "@/lib/llm/facts";
import { reasonTemplate } from "@/lib/llm/template";
import { deadlineFor } from "@/lib/cron/schedule";
import { productionZoho, type ZohoFactory } from "@/lib/zoho/client";
import { ZohoApiError, ZohoAuthError, ZohoBudgetError, ZohoDataError, type ZohoHttp } from "@/lib/zoho/http";
import { mappingCheck, readback, type RequestedLine } from "@/lib/zoho/map";
import { readForRun, readPo } from "@/lib/zoho/reader";
import { settleAfterSave } from "./carryover";
import { loadEngineInput, type RunRow } from "./load";

export type ProcessResult = { runId: string; status: string; claimed: boolean; error?: string };
/** llm: undefined = the production client (null without a key); null = templates only. */
/** llmBudgetMs: time step 7 may spend on Claude per invocation; past it, the remaining cards keep their template. */
export type ProcessOptions = { caseDataMode: boolean; now?: Date; zoho?: ZohoFactory; llm?: LlmCall | null; llmBudgetMs?: number };

/** Well inside the route's 300 s, leaving room for the earlier steps and the brief. */
const LLM_BUDGET_MS = 150_000;

/** After this many claims without finishing (errors or timeouts), a run is blocked and the admin alerted. */
export const MAX_ATTEMPTS = 3;
/** Zoho calls allowed per run (BUILD_PLAN §9), across all steps and invocations. */
export const RUN_CALL_BUDGET = 300;
/** A Zoho outage is retried on this many claims (the 5-minute cron: about 30 minutes) before the run blocks (F8). */
export const ZOHO_OUTAGE_ATTEMPTS = 7;
/** Longer than the route's maxDuration (300 s), so a live worker never loses its lease. */
const LEASE_SECONDS = 420;

type ZohoReadDoc = {
  skipped?: "case_data";
  /** C-039: the position came from an uploaded open-PO file, not the Zoho API. */
  source?: "file";
  file?: { names: string[]; uploadedBy: string; summary: { openLines: number; openUnits: number; pos: number } };
  read_at?: string;
  calls?: number;
  po_lines?: PoLine[];
  receipts?: Receipt[];
  items?: Record<string, { unit?: string; status?: string }>;
  vendors?: Record<string, { status?: string }>;
  blocked?: Record<string, string>;
  pending_suppliers?: string[];
};

function lineState(r: Recommendation, pendingSuppliers: ReadonlySet<string>): string | null {
  if (r.holdout || r.action === "blocked") return null;
  // C-023b: a supplier with an un-issued system draft at run time gets no new draft this week.
  if (r.action === "reorder" && r.qty > 0 && r.supplierId && pendingSuppliers.has(r.supplierId)) return "blocked_pending";
  if (r.triage === "auto") return r.spotCheck ? "queued" : "auto";
  if (r.triage === "queue") return "queued";
  return null;
}

/** D1..D3 → distributor names for one card; null in case-data mode (names hidden). */
function namesFor(r: Recommendation, distributorNames: ReadonlyMap<string, string> | null): Record<string, string> | null {
  if (!distributorNames) return null;
  const { distributorIds } = cardFacts(r);
  return Object.fromEntries(distributorIds.map((id, i) => [`D${i + 1}`, distributorNames.get(id) ?? id]));
}

export function toRow(runId: string, r: Recommendation, pendingSuppliers: ReadonlySet<string> = new Set(), distributorNames: ReadonlyMap<string, string> | null = null) {
  const state = lineState(r, pendingSuppliers);
  const { skuId, action, qty, cover, coverAfter, flags, topDistributors, triage, assumed, holdout, daysToStockout, spotCheck, ...inputs } = r;
  return {
    run_id: runId,
    sku_id: skuId,
    action,
    qty,
    cover,
    cover_after: coverAfter,
    flags,
    top_distributors: topDistributors,
    triage,
    line_state: state,
    final_qty: state === "auto" ? qty : null, // auto lines are settled at the engine's quantity
    reason_text: reasonTemplate(cardFacts(r).facts, namesFor(r, distributorNames)),
    reason_source: "template",
    inputs,
    assumed,
    holdout,
    days_to_stockout: daysToStockout,
    spot_check: spotCheck,
  };
}

/** A saved recommendation row back to the engine shape (inputs holds every field toRow didn't lift out). */
export function recFromRow(row: Record<string, unknown>): Recommendation {
  return {
    ...(row.inputs as object),
    skuId: row.sku_id,
    action: row.action,
    qty: row.qty,
    cover: row.cover === null ? null : Number(row.cover),
    coverAfter: row.cover_after === null ? null : Number(row.cover_after),
    flags: row.flags,
    topDistributors: row.top_distributors,
    triage: row.triage,
    assumed: row.assumed,
    holdout: row.holdout,
    daysToStockout: row.days_to_stockout === null ? null : Number(row.days_to_stockout),
    spotCheck: row.spot_check,
  } as Recommendation;
}

/** C-039: say on the desk that this week's position came from a file, and what the file held. */
function fileNote(doc: ZohoReadDoc): string[] {
  if (doc.source !== "file" || !doc.file) return [];
  const f = doc.file;
  return [`Zoho failsafe: open POs from ${f.names.join(" + ")} (uploaded by ${f.uploadedBy}): ${f.summary.openLines} open lines, ${f.summary.openUnits} units on order across ${f.summary.pos} POs.`];
}

/** Calls at most `limit` at a time (ARCHITECTURE §6: concurrency 5). */
async function pool<T>(items: T[], limit: number, f: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await f(items[next++]!);
  }));
}

/** Supabase result → data, or throw: a failed read must never look like "no rows" (review M3, finding 2). */
async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

async function block(db: SupabaseClient, runId: string, reason: string, message: string) {
  await db.from("run").update({ status: "blocked", error: { reason, message } }).eq("id", runId);
  await db.from("alert").upsert({ kind: "run_blocked", dedupe_key: `run_blocked:${runId}`, run_id: runId, payload: { reason, message } }, { onConflict: "dedupe_key" });
}

/** Zoho failures block the whole run (BUILD_PLAN §8.1: auth failure or outage blocks the run and alerts). */
function zohoBlockReason(e: unknown): [string, string] | null {
  if (e instanceof ZohoAuthError) return ["zoho_auth", e.message];
  if (e instanceof ZohoBudgetError) return ["zoho_budget", e.message];
  if (e instanceof ZohoDataError) return ["zoho_unexpected", e.message];
  if (e instanceof ZohoApiError) return ["zoho_unavailable", `Zoho didn't respond properly: ${e.message}`];
  return null;
}

export async function processRun(db: SupabaseClient, runId: string, opts: ProcessOptions): Promise<ProcessResult> {
  const { data: claimed, error: claimError } = await db.rpc("claim_run", { p_run_id: runId, p_seconds: LEASE_SECONDS });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) {
    const { data } = await db.from("run").select("status").eq("id", runId).single();
    return { runId, status: data?.status ?? "unknown", claimed: false };
  }
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const factory = opts.zoho ?? productionZoho;
  let http: ZohoHttp | null = null;
  let callBase = 0;
  let doc: ZohoReadDoc = {};
  const callsSoFar = () => callBase + (http ? (http as ZohoHttp).callCount : 0);
  const zohoFor = (): ZohoHttp | null => {
    if (!http) {
      callBase = doc.calls ?? 0;
      http = factory(db, RUN_CALL_BUDGET - callBase);
    }
    return http;
  };
  /** Moves the run on, only if it's still the current run for its week. False = superseded: stop. */
  const advance = async (patch: Record<string, unknown>): Promise<boolean> => {
    const rows = await must(db.from("run").update(patch).eq("id", runId).is("superseded_by", null).select("id"), "run update");
    return rows.length === 1;
  };

  try {
    const row = await must(db.from("run").select("id, iso_week, rule_version_id, mode, spot_check_seed, status, step_attempts, zoho_read, superseded_by, error").eq("id", runId).single(), "run");
    if (!row) throw new Error("run not found");
    const run = row as unknown as RunRow & { step_attempts: number; zoho_read: ZohoReadDoc | null; superseded_by: string | null; error: { reason?: string } | null };
    if (run.superseded_by) return { runId, status: "superseded", claimed: true };
    doc = run.zoho_read ?? {};
    let status = run.status;
    // claim_run counts every claim; one that never finished (error or timeout) leaves the count up.
    // Step 7 (Claude) never blocks: its claims don't count toward the attempt limit.
    const zohoOutage = run.error?.reason === "zoho_unavailable";
    if (zohoOutage && run.step_attempts > ZOHO_OUTAGE_ATTEMPTS) {
      await block(db, runId, "zoho_unavailable", `Zoho didn't respond for about 30 minutes (${ZOHO_OUTAGE_ATTEMPTS} tries). Retry the run once Zoho is back.`);
      return { runId, status: "blocked", claimed: true };
    }
    if (run.step_attempts > MAX_ATTEMPTS && status !== "ready" && !zohoOutage) {
      await block(db, runId, "step_failed", `The run didn't finish after ${MAX_ATTEMPTS} attempts (errors or timeouts).`);
      return { runId, status: "blocked", claimed: true };
    }

    if (status === "queued") {
      if (opts.caseDataMode) {
        doc = { skipped: "case_data", read_at: now };
        if (!(await advance({ status: "engine", zoho_read: doc }))) return { runId, status: "superseded", claimed: true };
        status = "engine";
      } else if (!zohoFor()) {
        await block(db, runId, "zoho_not_connected", "Zoho isn't configured in this environment (ZOHO_* settings), so open POs and receipts can't be read. The run is blocked (fail closed).");
        return { runId, status: "blocked", claimed: true };
      } else {
        status = "readback";
      }
    }

    // 1. Read back earlier system drafts by Zoho id (§8.3, D11): issued / edited / deleted, logged once.
    if (status === "readback") {
      const drafts = await must(
        db.from("draft_po").select("id, supplier_id, iso_week, reference, zoho_po_id, status, requested_lines, issued_lines").eq("mode", "live").eq("status", "created").not("zoho_po_id", "is", null),
        "drafts",
      );
      const pending = new Set<string>();
      for (const d of drafts) {
        const z = zohoFor();
        if (!z) throw new Error("Zoho client unavailable for draft read-back");
        const rb = readback(await readPo(z, d.zoho_po_id as string), (d.requested_lines ?? []) as RequestedLine[]);
        const patch: Record<string, unknown> = { last_read_at: now };
        if (rb.status === "deleted") patch.status = "deleted";
        else {
          if (rb.changed) patch.issued_lines = rb.lines;
          // This week's own draft (a same-week correction) isn't an "earlier" pending draft (stress test F4).
          if (rb.pending && d.iso_week !== run.iso_week) pending.add(d.supplier_id as string);
          else {
            patch.status = rb.status;
            patch.issued_at = now; // first seen issued at this read-back
          }
        }
        // Only the first worker to see this change records it (status still 'created').
        const updated = await must(db.from("draft_po").update(patch).eq("id", d.id).eq("status", "created").select("id"), "draft update");
        const linesChanged = rb.status !== "deleted" && rb.changed && JSON.stringify(rb.lines) !== JSON.stringify(d.issued_lines ?? null);
        if (updated.length === 1 && (rb.status === "deleted" || linesChanged)) {
          await must(
            db.from("change_log").insert({
              entity: "draft_po",
              entity_id: d.reference as string,
              field: "procurement",
              old: d.requested_lines,
              new: rb.status === "deleted" ? null : rb.lines,
              by_label: "Zoho read-back",
              reason: rb.status === "deleted" ? "Procurement rejection: draft deleted in Zoho" : "Procurement override: draft quantities changed in Zoho",
            }),
            "change_log",
          );
        }
      }
      doc = { ...doc, pending_suppliers: [...pending].sort(), calls: callsSoFar() };
      if (!(await advance({ status: "zoho_read", zoho_read: doc }))) return { runId, status: "superseded", claimed: true };
      status = "zoho_read";
    }

    // 2. Read Zoho (§8.1): open POs and receipts since Monday, items, vendors.
    if (status === "zoho_read") {
      const z = zohoFor();
      if (!z) throw new Error("Zoho client unavailable");
      // Active SKUs only; an item shared by two active SKUs is blocked in the mapping check.
      const skus = await must(db.from("sku").select("id, zoho_item_id").eq("status", "active").not("zoho_item_id", "is", null), "skus");
      const counts = new Map<string, number>();
      for (const s of skus) counts.set(s.zoho_item_id as string, (counts.get(s.zoho_item_id as string) ?? 0) + 1);
      const itemToSku = new Map(skus.filter((s) => counts.get(s.zoho_item_id as string) === 1).map((s) => [s.zoho_item_id as string, s.id as string]));
      const read = await readForRun(z, { runWeek: run.iso_week, itemToSku, now: () => nowDate });
      doc = {
        ...doc,
        read_at: read.readAt,
        calls: callsSoFar(),
        po_lines: read.poLines,
        receipts: read.receipts,
        items: Object.fromEntries(Object.entries(read.items).map(([k, v]) => [k, { unit: v.unit, status: v.status }])),
        vendors: Object.fromEntries(Object.entries(read.vendors).map(([k, v]) => [k, { status: v.status }])),
      };
      if (!(await advance({ status: "mapping", zoho_read: doc }))) return { runId, status: "superseded", claimed: true };
      status = "mapping";
    }

    // 3. Mapping check (§8.2): no active Zoho item/vendor, a unit mismatch (A4) or a shared item → blocked.
    if (status === "mapping") {
      const [skus, suppliers] = await Promise.all([must(db.from("sku").select("id, status, uom, zoho_item_id, supplier_id"), "skus"), must(db.from("supplier").select("id, zoho_vendor_id"), "suppliers")]);
      const vendorOf = new Map(suppliers.map((s) => [s.id as string, (s.zoho_vendor_id as string | null) ?? null]));
      const blocked = mappingCheck(
        skus.map((s) => ({
          id: s.id as string,
          status: s.status as string,
          uom: (s.uom as string | null) ?? null,
          zohoItemId: (s.zoho_item_id as string | null) ?? null,
          supplierId: (s.supplier_id as string | null) ?? null,
          zohoVendorId: s.supplier_id ? (vendorOf.get(s.supplier_id as string) ?? null) : null,
        })),
        new Map(Object.entries(doc.items ?? {}).map(([id, v]) => [id, { item_id: id, ...v }])),
        new Map(Object.entries(doc.vendors ?? {}).map(([id, v]) => [id, { contact_id: id, ...v }])),
      );
      doc = { ...doc, blocked };
      if (!(await advance({ status: "engine", zoho_read: doc }))) return { runId, status: "superseded", claimed: true };
      status = "engine";
    }

    // 4–6. Engine and triage (pure), then save.
    if (status === "engine") {
      const input = await loadEngineInput(db, run as RunRow, {
        caseDataMode: opts.caseDataMode,
        poLines: doc.po_lines ?? [],
        receipts: doc.receipts ?? [],
        blocked: doc.blocked ?? {},
      });
      // A missing stock file blocks the whole run (CLAUDE.md: fail closed), not just every SKU.
      if (Object.keys(input.onHand).length === 0) {
        await block(db, runId, "no_stock_snapshot", `No stock snapshot for the Sunday before ${run.iso_week}.`);
        return { runId, status: "blocked", claimed: true };
      }
      const out = runEngine(input);
      const current = await must(db.from("run").select("id").eq("id", runId).is("superseded_by", null), "run");
      if (current.length !== 1) return { runId, status: "superseded", claimed: true };
      const pending = new Set(doc.pending_suppliers ?? []);
      const names = await distributorNames(db, opts.caseDataMode);
      await must(db.from("recommendation").delete().eq("run_id", runId).select("id"), "clear recommendations");
      await must(db.from("recommendation").insert(out.recommendations.map((r) => toRow(runId, r, pending, names))).select("id"), "save recommendations");
      await settleAfterSave(db, runId, run.iso_week);
      status = (await advance({ status: "ready", ready_at: now, notes: fileNote(doc).concat(out.notes), error: null })) ? "ready" : "superseded";
      for (const year of out.missingFestivalYears) {
        await db.from("alert").upsert(
          { kind: "festival_missing", dedupe_key: `festival_missing:${year}`, run_id: runId, payload: { year, message: `No festival dates are entered for ${year}, and this week's orders reach into it. Add them in Settings → Festivals & holds.` } },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
      }
      // C-024: ready after the decision deadline → the rule applies at the next noon firing; tell Deepa.
      const deadline = deadlineFor(run.iso_week, input.rules.deadline);
      if (status === "ready" && nowDate.getTime() > deadline.getTime()) {
        await db.from("alert").upsert(
          { kind: "run_ready_late", dedupe_key: `run_ready_late:${runId}`, run_id: runId, payload: { week: run.iso_week, message: `The ${run.iso_week} queue was ready after the decision deadline; the Tuesday rule will apply at the next 12:00 IST.` } },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
      }
    }

    // 7. Claude (§8.7): a reason per card Raghav sees, and the weekly brief. Checked numbers or template.
    if (status === "ready") {
      status = await claudeStep(db, runId, run.iso_week, run.mode, opts, advance);
    }
    return { runId, status, claimed: true };
  } catch (e) {
    // Keep the calls spent, so a retry gets only what's left of the run's budget (review M3, finding 8).
    if (http) await db.from("run").update({ zoho_read: { ...doc, calls: callsSoFar() } }).eq("id", runId);
    const zohoBlock = zohoBlockReason(e);
    // F8: an outage (5xx/429 after back-off) is retried by the next cron cycles before the week is blocked.
    if (zohoBlock && zohoBlock[0] === "zoho_unavailable") {
      const { data } = await db.from("run").select("step_attempts").eq("id", runId).single();
      if ((data?.step_attempts ?? 0) < ZOHO_OUTAGE_ATTEMPTS) {
        await db.from("run").update({ error: { reason: "zoho_unavailable", message: `${zohoBlock[1]} Retrying every 5 minutes.` } }).eq("id", runId);
        return { runId, status: "retrying", claimed: true, error: zohoBlock[1] };
      }
    }
    if (zohoBlock) {
      await block(db, runId, zohoBlock[0], zohoBlock[1]);
      return { runId, status: "blocked", claimed: true, error: zohoBlock[1] };
    }
    const message = e instanceof Error ? e.message : String(e);
    const { data } = await db.from("run").select("step_attempts").eq("id", runId).single();
    if ((data?.step_attempts ?? 0) >= MAX_ATTEMPTS) {
      await block(db, runId, "step_failed", `The run failed ${MAX_ATTEMPTS} times: ${message}`);
      return { runId, status: "blocked", claimed: true, error: message };
    }
    await db.from("run").update({ error: { reason: "step_failed", message } }).eq("id", runId);
    throw e;
  } finally {
    await db.rpc("release_run", { p_run_id: runId });
  }
}

/**
 * Step 7 (§8.7): a reason per card Raghav sees, and the weekly brief, with checked numbers or template text.
 * Never blocks the run: past its time budget the remaining cards keep their template; on any error the brief
 * falls back to the template and the run is still marked done (the queue already works with template text).
 */
async function claudeStep(
  db: SupabaseClient,
  runId: string,
  isoWeek: string,
  mode: "shadow" | "live",
  opts: ProcessOptions,
  advance: (patch: Record<string, unknown>) => Promise<boolean>,
): Promise<string> {
  const started = Date.now();
  const budget = opts.llmBudgetMs ?? LLM_BUDGET_MS;
  let llm = opts.llm === undefined ? productionLlm() : opts.llm;
  let recs: Array<{ id: number; rec: Recommendation; lineState: string | null; source: string }> = [];
  try {
    const names = await distributorNames(db, opts.caseDataMode);
    const rows = await must(db.from("recommendation").select("*").eq("run_id", runId), "recommendations");
    recs = rows.map((r) => ({ id: r.id as number, rec: recFromRow(r), lineState: (r.line_state as string | null) ?? null, source: r.reason_source as string }));
    const toExplain = recs.filter((r) => r.lineState === "queued" && !r.rec.holdout && r.source !== "llm");
    let fellBack = 0;
    await pool(toExplain, 5, async (r) => {
      if (Date.now() - started > budget) {
        fellBack++;
        return; // out of time: the template stays
      }
      const out = await explainCard(cardFacts(r.rec).facts, llm, namesFor(r.rec, names));
      if (out.source === "llm") await must(db.from("recommendation").update({ reason_text: out.text, reason_source: "llm" }).eq("id", r.id).select("id"), "reason");
      else fellBack++;
    });
    // §10: most reasons falling back means the LLM is down, slow or drifting; info to IT, never a blocker.
    if (llm && toExplain.length && fellBack / toExplain.length > 0.5) {
      await db.from("alert").upsert(
        { kind: "llm_fallback", dedupe_key: `llm_fallback:${runId}`, run_id: runId, payload: { message: `${fellBack} of ${toExplain.length} card reasons fell back to template text this run.` } },
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      );
    }
  } catch {
    llm = null; // something failed: finish with templates
  }
  try {
    const brief = await explainBrief(briefFacts(isoWeek, mode, recs.map((r) => ({ rec: r.rec, lineState: r.lineState }))), Date.now() - started > budget ? null : llm);
    await db.from("brief").upsert({ run_id: runId, text: brief.text, source: brief.source, checked: brief.source === "llm" }, { onConflict: "run_id" });
  } catch {
    // no brief this time; the next weekly run writes one
  }
  return (await advance({ status: "done" })) ? "done" : "superseded";
}

async function distributorNames(db: SupabaseClient, caseDataMode: boolean): Promise<Map<string, string> | null> {
  if (caseDataMode) return null; // case data: distributor names hidden (C-011)
  const rows = await must(db.from("distributor").select("id, name"), "distributors");
  return new Map(rows.map((d) => [d.id as string, d.name as string]));
}

/** Safety net: process every run that isn't finished (called by the cron route). */
export async function processPendingRuns(db: SupabaseClient, opts: ProcessOptions): Promise<ProcessResult[]> {
  const { data, error } = await db.from("run").select("id").is("superseded_by", null).in("status", ["queued", "readback", "zoho_read", "mapping", "engine", "ready"]);
  if (error) throw new Error(error.message);
  const out: ProcessResult[] = [];
  for (const r of data ?? []) {
    // One failing run must not stop the others.
    try {
      out.push(await processRun(db, r.id as string, opts));
    } catch (e) {
      out.push({ runId: r.id as string, status: "error", claimed: true, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
