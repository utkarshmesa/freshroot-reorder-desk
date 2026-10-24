import "server-only";
// After the queue is saved, before the desk sees it (stress test F4, F7; ARCHITECTURE §4.2):
//  - a same-week correction keeps Raghav's decisions where the SKU's action and quantity are unchanged;
//  - suppliers already drafted this week keep what was sent; their other lines wait for next week (no update
//    scope, so a sent draft can't change), and planner + procurement are told what the correction changed;
//  - every supplier held by an earlier unissued draft is alerted each week, not only once.
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = { id: number; sku_id: string; action: string; qty: number; line_state: string | null; final_qty: number | null; inputs: { supplierId?: string | null } };
type Decision = { recommendation_id: number; status: string; final_qty: number | null; reason_code: string | null; note: string | null; by: string; at: string };

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

const DECIDED = new Set(["approved", "changed", "rejected"]);

export async function settleAfterSave(db: SupabaseClient, runId: string, isoWeek: string): Promise<void> {
  const fresh = (await must(db.from("recommendation").select("id, sku_id, action, qty, line_state, final_qty, inputs").eq("run_id", runId), "recommendations")) as Row[];
  const supplierOf = (r: Row) => r.inputs?.supplierId ?? null;

  // F7: a supplier held by an earlier unissued draft, every week it happens.
  for (const s of [...new Set(fresh.filter((r) => r.line_state === "blocked_pending").map(supplierOf))].filter(Boolean) as string[]) {
    await db.from("alert").upsert(
      { kind: "supplier_blocked", dedupe_key: `supplier_blocked:${isoWeek}:${s}`, run_id: runId, payload: { supplier: s, message: `${s} still has an unissued system draft from an earlier week, so its lines wait again this week. Procurement: issue or delete it.` } },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }

  const replaced = (await must(db.from("run").select("id").eq("superseded_by", runId), "replaced run")) as Array<{ id: string }>;
  if (!replaced.length) return;
  const old = (await must(db.from("recommendation").select("id, sku_id, action, qty, line_state, final_qty, inputs").eq("run_id", replaced[0]!.id), "old recommendations")) as Row[];
  const oldBySku = new Map(old.map((r) => [r.sku_id, r]));
  const decisions = (await must(
    db.from("decision").select("recommendation_id, status, final_qty, reason_code, note, by, at").in("recommendation_id", old.map((r) => r.id)).neq("status", "reapproved").order("at", { ascending: false }),
    "old decisions",
  )) as Decision[];
  const latestDecision = new Map<number, Decision>();
  for (const d of decisions) if (!latestDecision.has(d.recommendation_id)) latestDecision.set(d.recommendation_id, d);
  const drafted = new Set(
    ((await must(db.from("draft_po").select("supplier_id").eq("iso_week", isoWeek).neq("status", "creating"), "drafts")) as Array<{ supplier_id: string }>).map((d) => d.supplier_id),
  );

  const changesForSent: Array<{ supplier: string; sku: string; sent: number; now: number }> = [];
  for (const r of fresh) {
    const was = oldBySku.get(r.sku_id);
    const supplier = supplierOf(r);
    if (supplier && drafted.has(supplier)) {
      // Already drafted: what was sent stays; anything else waits for next Monday.
      const sentQty = was?.line_state === "sent" ? (was.final_qty ?? 0) : 0;
      if (r.line_state !== null || sentQty > 0) {
        await must(db.from("recommendation").update(sentQty > 0 ? { line_state: "sent", final_qty: sentQty } : { line_state: "rolled", final_qty: 0 }).eq("id", r.id).select("id"), "drafted supplier line");
      }
      if (r.action === "reorder" && r.qty !== sentQty) changesForSent.push({ supplier, sku: r.sku_id, sent: sentQty, now: r.qty });
      continue;
    }
    if (r.line_state !== "queued" || !was || !DECIDED.has(was.line_state ?? "") || was.action !== r.action || was.qty !== r.qty) continue;
    const d = latestDecision.get(was.id);
    await must(db.from("recommendation").update({ line_state: was.line_state, final_qty: was.final_qty }).eq("id", r.id).eq("line_state", "queued").select("id"), "carry over");
    if (d) {
      await must(
        db.from("decision").insert({ recommendation_id: r.id, status: d.status, final_qty: d.final_qty, reason_code: d.reason_code, note: `Carried over from the replaced run${d.note ? `: ${d.note}` : ""}`, by: d.by }).select("id"),
        "carry decision",
      );
    }
  }

  if (changesForSent.length) {
    const lines = changesForSent.map((c) => `${c.supplier} ${c.sku}: sent ${c.sent}, corrected data says ${c.now}`).join("; ");
    await db.from("alert").upsert(
      { kind: "correction_after_send", dedupe_key: `correction_after_send:${runId}`, run_id: runId, payload: { week: isoWeek, message: `This week's data was corrected after drafts were sent. Sent drafts can't be changed by the system; procurement may edit them in Zoho. ${lines}.` } },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }
}
