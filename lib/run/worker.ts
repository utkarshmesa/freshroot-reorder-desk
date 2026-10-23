import "server-only";
// The weekly run as a resumable state machine (ARCHITECTURE §4, BUILD_PLAN §8). Each call claims the run
// with a row lease, does the remaining steps, and releases it. Safe to call from the commit trigger and the
// cron at once. Steps: queued → (read Zoho) → mapping → readback → engine → ready.
// Every step's result is stored on the run, so a cut-short invocation resumes where it stopped.
// Case-data mode skips Zoho (the W43 reference assumes no open POs).
import type { SupabaseClient } from "@supabase/supabase-js";
import { runEngine } from "@/lib/engine";
import type { PoLine, Receipt, Recommendation } from "@/lib/engine/types";
import { ZohoApiError, ZohoAuthError, ZohoBudgetError, type ZohoHttp } from "@/lib/zoho/http";
import { productionZoho, type ZohoFactory } from "@/lib/zoho/client";
import { mappingCheck, readback, type RequestedLine } from "@/lib/zoho/map";
import { readForRun, readPo } from "@/lib/zoho/reader";
import { loadEngineInput, type RunRow } from "./load";

export type ProcessResult = { runId: string; status: string; claimed: boolean; error?: string };
export type ProcessOptions = { caseDataMode: boolean; now?: Date; zoho?: ZohoFactory };

/** After this many failed attempts a run is blocked and the admin alerted, instead of retrying forever. */
export const MAX_ATTEMPTS = 3;
/** Zoho calls allowed per run (BUILD_PLAN §9), across all steps. */
export const RUN_CALL_BUDGET = 300;

type ZohoReadDoc = {
  skipped?: "case_data";
  read_at: string;
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

export function toRow(runId: string, r: Recommendation, pendingSuppliers: ReadonlySet<string> = new Set()) {
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
    line_state: lineState(r, pendingSuppliers),
    inputs,
    assumed,
    holdout,
    days_to_stockout: daysToStockout,
    spot_check: spotCheck,
  };
}

async function block(db: SupabaseClient, runId: string, reason: string, message: string) {
  await db.from("run").update({ status: "blocked", error: { reason, message } }).eq("id", runId);
  await db.from("alert").upsert({ kind: "run_blocked", dedupe_key: `run_blocked:${runId}`, run_id: runId, payload: { reason, message } }, { onConflict: "dedupe_key" });
}

/** Zoho failures block the whole run (BUILD_PLAN §8.1: auth failure or outage blocks the run and alerts). */
function zohoBlockReason(e: unknown): [string, string] | null {
  if (e instanceof ZohoAuthError) return ["zoho_auth", e.message];
  if (e instanceof ZohoBudgetError) return ["zoho_budget", e.message];
  if (e instanceof ZohoApiError) return ["zoho_unavailable", `Zoho didn't respond properly: ${e.message}`];
  return null;
}

async function setStatus(db: SupabaseClient, runId: string, patch: Record<string, unknown>) {
  const { error } = await db.from("run").update(patch).eq("id", runId).is("superseded_by", null);
  if (error) throw new Error(error.message);
}

export async function processRun(db: SupabaseClient, runId: string, opts: ProcessOptions): Promise<ProcessResult> {
  const { data: claimed, error: claimError } = await db.rpc("claim_run", { p_run_id: runId });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) {
    const { data } = await db.from("run").select("status").eq("id", runId).single();
    return { runId, status: data?.status ?? "unknown", claimed: false };
  }
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const factory = opts.zoho ?? productionZoho;
  let http: ZohoHttp | null = null;
  let callBase = 0; // calls already spent by earlier invocations of this run
  try {
    const { data: run, error } = await db.from("run").select("id, iso_week, rule_version_id, mode, spot_check_seed, status, step_attempts, zoho_read").eq("id", runId).single();
    if (error || !run) throw new Error(error?.message ?? "run not found");
    let status = (run as RunRow).status;
    let doc = (run.zoho_read ?? null) as ZohoReadDoc | null;
    const zohoFor = (): ZohoHttp | null => {
      if (!http) {
        callBase = doc?.calls ?? 0;
        http = factory(db, RUN_CALL_BUDGET - callBase);
      }
      return http;
    };
    const callsSoFar = () => callBase + (http ? (http as ZohoHttp).callCount : 0);

    // 1. Read Zoho (§8.1).
    if (status === "queued") {
      if (opts.caseDataMode) {
        doc = { skipped: "case_data", read_at: now };
        await setStatus(db, runId, { status: "engine", zoho_read: doc });
        status = "engine";
      } else {
        const z = zohoFor();
        if (!z) {
          await block(db, runId, "zoho_not_connected", "Zoho isn't configured in this environment (ZOHO_* settings), so open POs and receipts can't be read. The run is blocked (fail closed).");
          return { runId, status: "blocked", claimed: true };
        }
        const { data: skus } = await db.from("sku").select("id, zoho_item_id").not("zoho_item_id", "is", null);
        const itemToSku = new Map((skus ?? []).map((s) => [s.zoho_item_id as string, s.id as string]));
        const read = await readForRun(z, { runWeek: (run as RunRow).iso_week, today: now.slice(0, 10), itemToSku, now: () => nowDate });
        doc = {
          read_at: read.readAt,
          calls: callsSoFar(),
          po_lines: read.poLines,
          receipts: read.receipts,
          items: Object.fromEntries(Object.entries(read.items).map(([k, v]) => [k, { unit: v.unit, status: v.status }])),
          vendors: Object.fromEntries(Object.entries(read.vendors).map(([k, v]) => [k, { status: v.status }])),
        };
        await setStatus(db, runId, { status: "mapping", zoho_read: doc });
        status = "mapping";
      }
    }

    // 2. Mapping check (§8.2): SKUs without an active Zoho item/vendor, or with a unit mismatch, are blocked.
    if (status === "mapping") {
      const [{ data: skus }, { data: suppliers }] = await Promise.all([db.from("sku").select("id, status, uom, zoho_item_id, supplier_id"), db.from("supplier").select("id, zoho_vendor_id")]);
      const vendorOf = new Map((suppliers ?? []).map((s) => [s.id as string, (s.zoho_vendor_id as string | null) ?? null]));
      const blocked = mappingCheck(
        (skus ?? []).map((s) => ({
          id: s.id as string,
          status: s.status as string,
          uom: (s.uom as string | null) ?? null,
          zohoItemId: (s.zoho_item_id as string | null) ?? null,
          supplierId: (s.supplier_id as string | null) ?? null,
          zohoVendorId: s.supplier_id ? (vendorOf.get(s.supplier_id as string) ?? null) : null,
        })),
        new Map(Object.entries(doc?.items ?? {}).map(([id, v]) => [id, { item_id: id, ...v }])),
        new Map(Object.entries(doc?.vendors ?? {}).map(([id, v]) => [id, { contact_id: id, ...v }])),
      );
      doc = { ...doc!, blocked };
      await setStatus(db, runId, { status: "readback", zoho_read: doc });
      status = "readback";
    }

    // 3. Read back earlier system drafts by Zoho id (§8.3, D11): issued / edited / deleted, logged.
    if (status === "readback") {
      const { data: drafts } = await db.from("draft_po").select("id, supplier_id, reference, zoho_po_id, status, requested_lines").eq("mode", "live").eq("status", "created").not("zoho_po_id", "is", null);
      const pending = new Set<string>();
      const z = (drafts ?? []).length ? zohoFor() : null;
      if ((drafts ?? []).length && !z) throw new Error("Zoho client unavailable for draft read-back");
      for (const d of drafts ?? []) {
        const rb = readback(await readPo(z!, d.zoho_po_id as string), (d.requested_lines ?? []) as RequestedLine[]);
        const patch: Record<string, unknown> = { last_read_at: now };
        if (rb.status === "deleted") {
          patch.status = "deleted";
        } else {
          if (rb.changed) patch.issued_lines = rb.lines;
          if (rb.pending) pending.add(d.supplier_id as string);
          else {
            patch.status = rb.status;
            patch.issued_at = now; // first seen issued at this read-back
          }
        }
        const { error: e } = await db.from("draft_po").update(patch).eq("id", d.id);
        if (e) throw new Error(e.message);
        if (rb.status === "deleted" || rb.status === "edited" || (rb.status === "created" && rb.changed)) {
          await db.from("change_log").insert({
            entity: "draft_po",
            entity_id: d.reference as string,
            field: "procurement",
            old: d.requested_lines,
            new: rb.status === "deleted" ? null : rb.lines,
            by_label: "Zoho read-back",
            reason: rb.status === "deleted" ? "Procurement rejection: draft deleted in Zoho" : "Procurement override: draft quantities changed in Zoho",
          });
        }
      }
      doc = { ...doc!, pending_suppliers: [...pending].sort(), calls: http ? callsSoFar() : (doc?.calls ?? 0) };
      await setStatus(db, runId, { status: "engine", zoho_read: doc });
      status = "engine";
    }

    // 4–6. Engine and triage (pure), then save.
    if (status === "engine") {
      const input = await loadEngineInput(db, run as RunRow, {
        caseDataMode: opts.caseDataMode,
        poLines: doc?.po_lines ?? [],
        receipts: doc?.receipts ?? [],
        blocked: doc?.blocked ?? {},
      });
      // A missing stock file blocks the whole run (CLAUDE.md: fail closed), not just every SKU.
      if (Object.keys(input.onHand).length === 0) {
        await block(db, runId, "no_stock_snapshot", `No stock snapshot for the Sunday before ${(run as RunRow).iso_week}.`);
        return { runId, status: "blocked", claimed: true };
      }
      const out = runEngine(input);
      const current = await db.from("run").select("id").eq("id", runId).is("superseded_by", null).maybeSingle();
      if (!current.data) return { runId, status: "superseded", claimed: true };
      const pending = new Set(doc?.pending_suppliers ?? []);
      const del = await db.from("recommendation").delete().eq("run_id", runId);
      if (del.error) throw new Error(del.error.message);
      const ins = await db.from("recommendation").insert(out.recommendations.map((r) => toRow(runId, r, pending)));
      if (ins.error) throw new Error(ins.error.message);
      const done = await db.from("run").update({ status: "ready", ready_at: now, notes: out.notes, error: null }).eq("id", runId).is("superseded_by", null).select("id");
      status = done.data?.length ? "ready" : "superseded";
    }
    return { runId, status, claimed: true };
  } catch (e) {
    const zohoBlock = zohoBlockReason(e);
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

/** Safety net: process every run that isn't finished (called by the cron route). */
export async function processPendingRuns(db: SupabaseClient, opts: ProcessOptions): Promise<ProcessResult[]> {
  const { data, error } = await db.from("run").select("id").is("superseded_by", null).in("status", ["queued", "mapping", "readback", "engine"]);
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
