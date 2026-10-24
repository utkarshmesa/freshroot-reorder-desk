import "server-only";
// Send to procurement (ARCHITECTURE §4.1): planner button and the Tuesday 12:00 cron. Service-role client;
// callers check the planner role first. Shadow mode writes draft_po rows only and never builds a Zoho writer.
// Live mode, per supplier: pending-draft block (C-023) → changed-PO hold (C-025) → "creating" row →
// adopt by reference or create → read back (must be a draft, ZO-14) → created.
import type { SupabaseClient } from "@supabase/supabase-js";
import { productionZoho, type ZohoFactory } from "@/lib/zoho/client";
import type { ZohoHttp } from "@/lib/zoho/http";
import { poStatus } from "@/lib/zoho/map";
import { readPo } from "@/lib/zoho/reader";
import { draftPayload, findByReference, vendorPos, ZohoDraftWriter } from "@/lib/zoho/writer";
import { draftReference, effectiveMode, planSend, SENDABLE, type SendLine } from "./plan";

export const SEND_CALL_BUDGET = 300;

export type SendOptions = {
  now?: Date;
  zoho?: ZohoFactory;
  /** Defaults to process.env.APP_MODE. */
  envMode?: string;
  sleep?: (ms: number) => Promise<void>;
};

export type SendResult = {
  mode: "live" | "shadow";
  sent: Array<{ supplierId: string; reference: string; lines: number; units: number }>;
  waiting: Array<{ supplierId: string; queued: number }>;
  alreadySent: string[];
  skippedPending: string[];
  held: Array<{ supplierId: string; skuIds: string[] }>;
  noSupplier: string[];
  /** Set when the send stopped early; the run may be blocked (ZO-14). */
  stopped?: string;
};

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  if (data === null || data === undefined) throw new Error(`${what}: not found`);
  return data as T;
}

const UNIQUE_VIOLATION = "23505";
/** Zoho writes "2026-10-20T10:00:00+0530"; Date.parse needs "+05:30". */
const parseZohoTime = (t: string) => Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

export async function sendToProcurement(db: SupabaseClient, runId: string, opts: SendOptions = {}): Promise<SendResult> {
  const { data: claimed, error: claimError } = await db.rpc("claim_send", { p_run_id: runId });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) throw new Error("A send for this week is already in progress. Try again in a few minutes.");
  try {
    return await send(db, runId, opts);
  } finally {
    await db.rpc("release_send", { p_run_id: runId });
  }
}

async function send(db: SupabaseClient, runId: string, opts: SendOptions): Promise<SendResult> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = (await must(db.from("run").select("id, iso_week, mode, status, superseded_by, zoho_read").eq("id", runId).single(), "run")) as unknown as { iso_week: string; mode: string; status: string; superseded_by: string | null; zoho_read: { read_at?: string } | null };
  if (run.superseded_by || !["ready", "llm", "done"].includes(run.status)) throw new Error(`This run can't be sent (status ${run.status}).`);
  const appMode = (await must(db.from("app_mode").select("mode").single(), "app mode")) as unknown as { mode: string };
  const mode = effectiveMode(opts.envMode ?? process.env.APP_MODE, appMode.mode, run.mode);
  const week = run.iso_week;

  const rows = await must(db.from("recommendation").select("id, sku_id, line_state, final_qty, inputs").eq("run_id", runId).not("line_state", "is", null), "lines");
  const lines: SendLine[] = rows.map((r) => ({
    recId: r.id as number,
    skuId: r.sku_id as string,
    supplierId: ((r.inputs as { supplierId?: string | null }).supplierId ?? null) as string | null,
    state: r.line_state as SendLine["state"],
    qty: (r.final_qty as number | null) ?? 0,
  }));
  // A row still "creating" is a send that stopped part-way: resume it (adopt by reference), don't skip it.
  const drafted = await must(db.from("draft_po").select("supplier_id").eq("iso_week", week).eq("mode", mode).neq("status", "creating"), "drafts");
  const plan = planSend(lines, new Set(drafted.map((d) => d.supplier_id as string)));
  const result: SendResult = { mode, sent: [], waiting: plan.waiting, alreadySent: [...plan.alreadySent], skippedPending: [], held: [], noSupplier: plan.noSupplier };
  if (!plan.ready.length) return result;

  const skuIds = [...new Set(plan.ready.flatMap((s) => s.lines.map((l) => l.skuId)))];
  const [skus, suppliers] = await Promise.all([
    must(db.from("sku").select("id, zoho_item_id").in("id", skuIds), "skus"),
    must(db.from("supplier").select("id, zoho_vendor_id").in("id", plan.ready.map((s) => s.supplierId)), "suppliers"),
  ]);
  const itemOf = new Map(skus.map((s) => [s.id as string, (s.zoho_item_id as string | null) ?? null]));
  const vendorOf = new Map(suppliers.map((s) => [s.id as string, (s.zoho_vendor_id as string | null) ?? null]));
  const requested = (ls: SendLine[]) => ls.map((l) => ({ sku_id: l.skuId, item_id: itemOf.get(l.skuId) ?? null, qty: l.qty }));
  const markSent = async (ls: SendLine[]) =>
    must(db.from("recommendation").update({ line_state: "sent" }).in("id", ls.map((l) => l.recId)).in("line_state", [...SENDABLE]).select("id"), "mark sent");

  if (mode === "shadow") {
    // ST-04: no Zoho client exists on this path.
    for (const s of plan.ready) {
      const reference = draftReference(week, s.supplierId);
      const { error } = await db.from("draft_po").insert({ run_id: runId, supplier_id: s.supplierId, iso_week: week, mode, reference, status: "shadow", requested_lines: requested(s.lines) });
      if (error?.code === UNIQUE_VIOLATION) {
        result.alreadySent.push(s.supplierId);
        continue;
      }
      if (error) throw new Error(`shadow draft: ${error.message}`);
      await markSent(s.lines);
      result.sent.push({ supplierId: s.supplierId, reference, lines: s.lines.length, units: s.lines.reduce((a, l) => a + l.qty, 0) });
    }
    return result;
  }

  const http: ZohoHttp | null = (opts.zoho ?? productionZoho)(db, SEND_CALL_BUDGET);
  if (!http) throw new Error("Zoho isn't configured in this environment, so live drafts can't be created (fail closed).");
  const writer = ZohoDraftWriter.forMode(mode, http);
  const readAt = run.zoho_read?.read_at ?? null;

  for (const s of plan.ready) {
    const reference = draftReference(week, s.supplierId);
    const vendorId = vendorOf.get(s.supplierId);
    if (!vendorId || s.lines.some((l) => !itemOf.get(l.skuId))) {
      result.noSupplier.push(...s.lines.map((l) => l.skuId));
      continue;
    }
    const pos = await vendorPos(http, vendorId);

    // C-023: an un-issued system draft from an earlier week holds this supplier for the whole week.
    let pending = pos.some((p) => p.reference_number?.startsWith("FR-") && p.reference_number !== reference && poStatus(p.status) === "draft");
    if (!pending) {
      const earlier = await must(
        db.from("draft_po").select("zoho_po_id").eq("supplier_id", s.supplierId).eq("mode", "live").eq("status", "created").neq("iso_week", week).not("zoho_po_id", "is", null),
        "earlier drafts",
      );
      for (const d of earlier) {
        const po = await readPo(http, d.zoho_po_id as string);
        if (po && poStatus(po.status) === "draft") pending = true;
      }
    }
    if (pending) {
      const { error } = await db.from("draft_po").insert({ run_id: runId, supplier_id: s.supplierId, iso_week: week, mode, reference, status: "skipped_pending", requested_lines: requested(s.lines) });
      if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`skipped draft: ${error.message}`);
      await must(db.from("recommendation").update({ line_state: "blocked_pending" }).in("id", s.lines.map((l) => l.recId)).in("line_state", [...SENDABLE]).select("id"), "block lines");
      await db.from("alert").upsert(
        { kind: "pending_draft", dedupe_key: `pending_draft:${week}:${s.supplierId}`, run_id: runId, payload: { supplier: s.supplierId, message: `Issue or delete the pending draft for ${s.supplierId} first; this week's lines for it wait until next Monday.` } },
        { onConflict: "dedupe_key" },
      );
      result.skippedPending.push(s.supplierId);
      continue;
    }

    // C-025: a PO for one of these SKUs created or changed in Zoho since Monday's read → hold that line.
    let lines = s.lines;
    if (readAt) {
      const since = Date.parse(readAt);
      const changed = pos.filter((p) => poStatus(p.status) !== "draft" && p.reference_number !== reference && p.last_modified_time && parseZohoTime(p.last_modified_time) > since);
      const touched = new Set<string>();
      const skuOfItem = new Map([...itemOf.entries()].filter(([, v]) => v).map(([k, v]) => [v as string, k]));
      for (const p of changed) {
        const po = await readPo(http, p.purchaseorder_id);
        for (const l of po?.line_items ?? []) if (skuOfItem.has(l.item_id)) touched.add(skuOfItem.get(l.item_id)!);
      }
      const held = lines.filter((l) => touched.has(l.skuId));
      if (held.length) {
        await must(db.from("recommendation").update({ line_state: "held_changed" }).in("id", held.map((l) => l.recId)).in("line_state", [...SENDABLE]).select("id"), "hold lines");
        result.held.push({ supplierId: s.supplierId, skuIds: held.map((l) => l.skuId) });
        lines = lines.filter((l) => !touched.has(l.skuId));
      }
    }
    if (!lines.length) continue;

    // "creating" first, so a crash anywhere after this is resumed by adopting the reference, never re-created.
    let draftId: string;
    const ins = await db.from("draft_po").insert({ run_id: runId, supplier_id: s.supplierId, iso_week: week, mode, reference, status: "creating", requested_lines: requested(lines) }).select("id").single();
    if (ins.error?.code === UNIQUE_VIOLATION) {
      const existing = (await must(db.from("draft_po").select("id, status").eq("supplier_id", s.supplierId).eq("iso_week", week).eq("mode", "live").single(), "existing draft")) as unknown as { id: string; status: string };
      if (existing.status !== "creating") {
        result.alreadySent.push(s.supplierId);
        continue;
      }
      draftId = existing.id;
    } else if (ins.error) throw new Error(`draft: ${ins.error.message}`);
    else draftId = ins.data.id as string;

    let found = await findByReference(http, reference);
    if (!found) {
      await sleep(5000); // search can lag behind a create
      found = await findByReference(http, reference);
    }
    let poId = found?.purchaseorder_id ?? null;
    if (!poId) {
      const payload = draftPayload({ vendorId, reference, date: now.toISOString().slice(0, 10), lines: lines.map((l) => ({ itemId: itemOf.get(l.skuId)!, qty: l.qty })) });
      try {
        poId = (await writer.createDraft(payload)).purchaseorder_id;
      } catch (e) {
        // The create may have happened with the response lost (ZO-04): look again before giving up.
        await sleep(5000);
        poId = (await findByReference(http, reference))?.purchaseorder_id ?? null;
        if (!poId) throw e;
      }
    }

    const po = await readPo(http, poId);
    if (!po || poStatus(po.status) !== "draft") {
      // ZO-14: what we created isn't a draft. Record it so read-back follows it, stop, block the run, alert.
      await db.from("draft_po").update({ zoho_po_id: poId, status: "created" }).eq("id", draftId);
      const message = `Zoho returned ${reference} as "${po?.status ?? "missing"}", not a draft. Sending stopped; check the Zoho scopes.`;
      await db.from("run").update({ status: "blocked", error: { reason: "zoho_not_draft", message } }).eq("id", runId);
      await db.from("alert").upsert({ kind: "run_blocked", dedupe_key: `zoho_not_draft:${runId}`, run_id: runId, payload: { reason: "zoho_not_draft", message } }, { onConflict: "dedupe_key" });
      result.stopped = message;
      return result;
    }
    await must(db.from("draft_po").update({ zoho_po_id: poId, status: "created", last_read_at: now.toISOString() }).eq("id", draftId).eq("status", "creating").select("id"), "draft created");
    await markSent(lines);
    result.sent.push({ supplierId: s.supplierId, reference, lines: lines.length, units: lines.reduce((a, l) => a + l.qty, 0) });
  }
  return result;
}
