import "server-only";
// Send to procurement (ARCHITECTURE §4.1): planner button and the Tuesday 12:00 cron. Service-role client;
// callers check the planner role first. Shadow mode writes draft_po rows only and never builds a Zoho writer.
// Live mode, per supplier: pending-draft block (C-023) → changed-PO hold (C-025) → "creating" row →
// adopt by reference or create → read back (must be a draft, ZO-14) → created.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PoLine } from "@/lib/engine/types";
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
  /** Tries to get the send lease before giving up (the cron waits for a planner's send to finish). */
  lockTries?: number;
};

export type SendResult = {
  /** file = C-039 Zoho failsafe: per-supplier PO sheets instead of Zoho drafts. */
  mode: "live" | "shadow" | "file";
  sent: Array<{ supplierId: string; reference: string; lines: number; units: number }>;
  waiting: Array<{ supplierId: string; queued: number }>;
  alreadySent: string[];
  skippedPending: string[];
  held: Array<{ supplierId: string; skuIds: string[] }>;
  noSupplier: string[];
  /** A create was attempted earlier but Zoho doesn't show the draft yet: never created twice; alerted. */
  unconfirmed: string[];
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
/** The PO date is the IST calendar date (a send at 01:00 IST is that day, not the previous UTC day). */
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
/** Zoho writes "2026-10-20T10:00:00+0530"; Date.parse needs "+05:30". */
const parseZohoTime = (t: string) => Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

export async function sendToProcurement(db: SupabaseClient, runId: string, opts: SendOptions = {}): Promise<SendResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const { data: claimed, error: claimError } = await db.rpc("claim_send", { p_run_id: runId });
    if (claimError) throw new Error(claimError.message);
    if (claimed) break;
    if (attempt >= (opts.lockTries ?? 1)) throw new Error("A send for this week is already in progress. Try again in a few minutes.");
    await sleep(10_000);
  }
  try {
    return await send(db, runId, opts);
  } finally {
    await db.rpc("release_send", { p_run_id: runId });
  }
}

async function send(db: SupabaseClient, runId: string, opts: SendOptions): Promise<SendResult> {
  const now = opts.now ?? new Date();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = (await must(db.from("run").select("id, iso_week, mode, source, status, superseded_by, zoho_read").eq("id", runId).single(), "run")) as unknown as { iso_week: string; mode: string; source: string; status: string; superseded_by: string | null; zoho_read: { read_at?: string; po_lines?: PoLine[] } | null };
  if (run.superseded_by || !["ready", "llm", "done"].includes(run.status)) throw new Error(`This run can't be sent (status ${run.status}).`);
  const appMode = (await must(db.from("app_mode").select("mode").single(), "app mode")) as unknown as { mode: string };
  // C-039: a live week run from files sends PO sheets, never Zoho drafts. In shadow nothing changes.
  const effective = effectiveMode(opts.envMode ?? process.env.APP_MODE, appMode.mode, run.mode);
  const mode: SendResult["mode"] = effective === "live" && run.source === "file" ? "file" : effective;
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
  const result: SendResult = { mode, sent: [], waiting: plan.waiting, alreadySent: [...plan.alreadySent], skippedPending: [], held: [], noSupplier: plan.noSupplier, unconfirmed: [] };
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

  if (mode === "file") return sendSheets(db, runId, week, plan.ready, requested, markSent, result);

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
  const writer = ZohoDraftWriter.forMode("live", http);
  const readAt = run.zoho_read?.read_at ?? null;
  const mondayLines = run.zoho_read?.po_lines ?? [];

  for (const s of plan.ready) {
    const reference = draftReference(week, s.supplierId);
    const vendorId = vendorOf.get(s.supplierId);
    if (!vendorId || s.lines.some((l) => !itemOf.get(l.skuId))) {
      result.noSupplier.push(...s.lines.map((l) => l.skuId));
      continue;
    }
    const pos = await vendorPos(http, vendorId);

    // C-023: an un-issued system draft from an earlier week holds this supplier for the whole week.
    // An unknown Zoho status on an earlier system PO counts as pending (fail closed).
    let pending = pos.some((p) => p.reference_number?.startsWith("FR-") && p.reference_number !== reference && (poStatus(p.status) === "draft" || poStatus(p.status) === null));
    if (!pending) {
      const earlier = await must(
        db.from("draft_po").select("zoho_po_id").eq("supplier_id", s.supplierId).eq("mode", "live").eq("status", "created").neq("iso_week", week).not("zoho_po_id", "is", null),
        "earlier drafts",
      );
      for (const d of earlier) {
        const po = await readPo(http, d.zoho_po_id as string);
        if (po && (poStatus(po.status) === "draft" || poStatus(po.status) === null)) pending = true;
      }
      // An earlier file-mode sheet not yet placed holds the supplier too (review M5b #3).
      const sheets = await must(db.from("draft_po").select("id").eq("supplier_id", s.supplierId).eq("mode", "file").eq("status", "created").neq("iso_week", week), "unplaced sheets");
      if (sheets.length) pending = true;
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
      // No timestamp (or one we can't read) counts as changed: holding a line can only order less.
      const changed = pos.filter((p) => {
        if (poStatus(p.status) === "draft" || p.reference_number === reference) return false;
        const t = p.last_modified_time ? parseZohoTime(p.last_modified_time) : NaN;
        return !Number.isFinite(t) || t > since;
      });
      const touched = new Set<string>();
      const skuOfItem = new Map([...itemOf.entries()].filter(([, v]) => v).map(([k, v]) => [v as string, k]));
      // Stress test F3: only a change that moves the position holds a line: a new or newly issued PO, a
      // changed ordered quantity, or a cancelled/closed/deleted one. A receipt alone (received qty) doesn't.
      const monday = new Map<string, number>();
      for (const l of mondayLines) monday.set(`${l.poId}|${l.skuId}`, (monday.get(`${l.poId}|${l.skuId}`) ?? 0) + l.ordered);
      for (const p of changed) {
        const po = await readPo(http, p.purchaseorder_id);
        const st = po ? poStatus(po.status) : "cancelled";
        const gone = st === "cancelled" || st === "closed";
        const now = new Map<string, number>();
        const openNow = new Map<string, number>();
        for (const l of po?.line_items ?? []) {
          const sku = skuOfItem.get(l.item_id);
          if (!sku) continue;
          now.set(sku, (now.get(sku) ?? 0) + Number(l.quantity));
          openNow.set(sku, (openNow.get(sku) ?? 0) + Math.max(0, Number(l.quantity) - Number(l.quantity_received ?? 0)));
        }
        const counts = st === "open" || st === "partially_received" || st === "billed";
        const skus = new Set([...now.keys(), ...mondayLines.filter((l) => l.poId === p.purchaseorder_id).map((l) => l.skuId)]);
        for (const sku of skus) {
          const was = monday.get(`${p.purchaseorder_id}|${sku}`);
          // A PO not in Monday's read moves the position only if it now has quantity on order (review M5b #5:
          // a fully received PO later billed changes nothing).
          const appeared = was === undefined && counts && (openNow.get(sku) ?? 0) > 0;
          if (gone ? was !== undefined : appeared || (was !== undefined && was !== (now.get(sku) ?? 0))) touched.add(sku);
        }
      }
      const held = lines.filter((l) => touched.has(l.skuId));
      if (held.length) {
        await must(db.from("recommendation").update({ line_state: "held_changed" }).in("id", held.map((l) => l.recId)).in("line_state", [...SENDABLE]).select("id"), "hold lines");
        result.held.push({ supplierId: s.supplierId, skuIds: held.map((l) => l.skuId) });
        await db.from("alert").upsert(
          { kind: "lines_held", dedupe_key: `lines_held:${week}:${s.supplierId}`, run_id: runId, payload: { supplier: s.supplierId, skus: held.map((l) => l.skuId), message: `A PO for ${held.map((l) => l.skuId).join(", ")} (${s.supplierId}) was created or changed in Zoho since Monday, so those lines were held back from this week's draft and come back next Monday.` } },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
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

    // Adopt an existing PO with this reference (the vendor list is paginated; search may lag a create).
    const lookup = async () => pos.find((p) => p.reference_number === reference)?.purchaseorder_id ?? (await findByReference(http, reference))?.purchaseorder_id ?? null;
    let poId = await lookup();
    if (!poId) {
      await sleep(5000);
      poId = (await findByReference(http, reference))?.purchaseorder_id ?? null;
    }
    if (!poId) {
      // One create attempt per draft row, ever (ZO-04): an earlier send may have POSTed and lost the answer.
      const claim = await must(db.from("draft_po").update({ create_attempted_at: now.toISOString() }).eq("id", draftId).is("create_attempted_at", null).select("id"), "claim create");
      if (claim.length === 1) {
        const payload = draftPayload({ vendorId, reference, date: istDate(now), lines: lines.map((l) => ({ itemId: itemOf.get(l.skuId)!, qty: l.qty })) });
        try {
          poId = (await writer.createDraft(payload)).purchaseorder_id;
        } catch {
          await sleep(5000);
          poId = (await findByReference(http, reference))?.purchaseorder_id ?? null;
        }
      }
      if (!poId) {
        await db.from("alert").upsert(
          { kind: "draft_unconfirmed", dedupe_key: `draft_unconfirmed:${week}:${s.supplierId}`, run_id: runId, payload: { supplier: s.supplierId, message: `A draft ${reference} was requested but Zoho doesn't show it yet. The system won't create it again. Check Zoho: if it exists, the next Send adopts it; if not, IT resets the draft row (RUNBOOK).` } },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        );
        result.unconfirmed.push(s.supplierId);
        continue;
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

/**
 * C-039 file mode, live: one PO sheet per supplier per week (draft_po mode 'file', status 'created' until
 * procurement confirms it placed). An earlier week's sheet still unplaced holds the supplier, like a pending
 * Zoho draft (C-023). No Zoho call is made; procurement and the planner are told the sheets are ready.
 */
async function sendSheets(
  db: SupabaseClient,
  runId: string,
  week: string,
  ready: Array<{ supplierId: string; lines: SendLine[] }>,
  requested: (ls: SendLine[]) => unknown,
  markSent: (ls: SendLine[]) => Promise<unknown>,
  result: SendResult,
): Promise<SendResult> {
  for (const s of ready) {
    const reference = draftReference(week, s.supplierId);
    // Earlier sheets not placed, or earlier Zoho drafts unissued at their last read-back (review M5b #3).
    const earlier = await must(db.from("draft_po").select("reference").eq("supplier_id", s.supplierId).in("mode", ["live", "file"]).eq("status", "created").neq("iso_week", week), "earlier orders");
    if (earlier.length) {
      const { error } = await db.from("draft_po").insert({ run_id: runId, supplier_id: s.supplierId, iso_week: week, mode: "file", reference, status: "skipped_pending", requested_lines: requested(s.lines) });
      if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`skipped sheet: ${error.message}`);
      await must(db.from("recommendation").update({ line_state: "blocked_pending" }).in("id", s.lines.map((l) => l.recId)).in("line_state", [...SENDABLE]).select("id"), "block lines");
      await db.from("alert").upsert(
        { kind: "pending_draft", dedupe_key: `pending_draft:${week}:${s.supplierId}`, run_id: runId, payload: { supplier: s.supplierId, message: `Confirm or cancel the earlier PO sheet ${earlier[0]!.reference} for ${s.supplierId} first; this week's lines for it wait until next Monday.` } },
        { onConflict: "dedupe_key" },
      );
      result.skippedPending.push(s.supplierId);
      continue;
    }
    const { error } = await db.from("draft_po").insert({ run_id: runId, supplier_id: s.supplierId, iso_week: week, mode: "file", reference, status: "created", requested_lines: requested(s.lines) });
    if (error?.code === UNIQUE_VIOLATION) {
      result.alreadySent.push(s.supplierId);
      continue;
    }
    if (error) throw new Error(`PO sheet: ${error.message}`);
    await markSent(s.lines);
    result.sent.push({ supplierId: s.supplierId, reference, lines: s.lines.length, units: s.lines.reduce((a, l) => a + l.qty, 0) });
  }
  if (result.sent.length) {
    await db.from("alert").upsert(
      {
        kind: "po_sheets_ready",
        dedupe_key: `po_sheets_ready:${runId}:${result.sent.map((x) => x.supplierId).join(",")}`,
        run_id: runId,
        payload: { message: `Zoho failsafe: PO sheets are ready on the Review desk for ${result.sent.map((x) => x.reference).join(", ")}. Download each, place the order with the supplier, then press Placed.` },
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }
  return result;
}
