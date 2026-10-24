import "server-only";
// Everything the review desk shows for the current week, read with the user's own client (RLS applies).
import { deadlineFor } from "@/lib/cron/schedule";
import { userClient } from "@/lib/db/server";
import type { Recommendation } from "@/lib/engine/types";
import type { RuleParams } from "@/lib/rules/defaults";
import { recFromRow } from "@/lib/run/worker";
import { effectiveMode, planSend, type SendLine } from "@/lib/send/plan";

export type DeskLine = {
  id: number;
  rec: Recommendation;
  lineState: string | null;
  finalQty: number | null;
  reason: string | null;
  reasonSource: "llm" | "template" | null;
  decision: { status: string; finalQty: number | null; reasonCode: string | null; note: string | null; at: string } | null;
};
export type DeskDraft = { id: string; supplierId: string; reference: string; mode: string; status: string; createdAt: string; issuedAt: string | null; needsReapproval: boolean; units: number };
export type Desk = {
  run: { id: string; isoWeek: string; status: string; mode: string; source: string; sendMode: string; error: { reason?: string; message?: string } | null; readAt: string | null; deadline: Date; deadlineAppliedAt: string | null; notes: string[] };
  lines: DeskLine[];
  drafts: DeskDraft[];
  reasonCodes: Array<{ code: string; label: string }>;
  supplierNames: Record<string, string>;
  plan: ReturnType<typeof planSend>;
};

export async function loadDesk(): Promise<Desk | null> {
  const db = await userClient();
  const { data: runs } = await db
    .from("run")
    .select("id, iso_week, status, mode, source, error, zoho_read, deadline_applied_at, notes, rule_version_id")
    .is("superseded_by", null)
    .order("iso_week", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  const r = runs?.[0];
  if (!r) return null;

  const [recs, drafts, codes, suppliers, rules, appMode] = await Promise.all([
    db.from("recommendation").select("*, decision(status, final_qty, reason_code, note, at)").eq("run_id", r.id),
    db.from("draft_po").select("id, supplier_id, reference, mode, status, created_at, issued_at, needs_reapproval, requested_lines").eq("iso_week", r.iso_week).order("supplier_id"),
    db.from("reason_code").select("code, label").eq("active", true).order("sort"),
    db.from("supplier").select("id, name"),
    db.from("rule_version").select("params").eq("id", r.rule_version_id).single(),
    db.from("app_mode").select("mode").maybeSingle(),
  ]);

  const lines: DeskLine[] = (recs.data ?? []).map((row) => {
    const ds = ((row.decision ?? []) as Array<{ status: string; final_qty: number | null; reason_code: string | null; note: string | null; at: string }>).filter((d) => d.status !== "reapproved").sort((a, b) => b.at.localeCompare(a.at));
    const d = ds[0];
    return {
      id: row.id as number,
      rec: recFromRow(row),
      lineState: (row.line_state as string | null) ?? null,
      finalQty: (row.final_qty as number | null) ?? null,
      reason: (row.reason_text as string | null) ?? null,
      reasonSource: (row.reason_source as DeskLine["reasonSource"]) ?? null,
      decision: d ? { status: d.status, finalQty: d.final_qty, reasonCode: d.reason_code, note: d.note, at: d.at } : null,
    };
  });
  const sendLines: SendLine[] = lines
    .filter((l) => l.lineState)
    .map((l) => ({ recId: l.id, skuId: l.rec.skuId, supplierId: l.rec.supplierId, state: l.lineState as SendLine["state"], qty: l.finalQty ?? 0 }));
  const runMode = r.mode as string;
  // The mode a Send would write in, exactly as the send decides it (live + file source = PO sheets, C-039).
  const effective = effectiveMode(process.env.APP_MODE, (appMode.data?.mode as string) ?? "shadow", runMode);
  const draftMode = effective === "live" && r.source === "file" ? "file" : effective;
  const params = (rules.data?.params ?? null) as RuleParams | null;

  return {
    run: {
      id: r.id as string,
      isoWeek: r.iso_week as string,
      status: r.status as string,
      mode: runMode,
      source: (r.source as string) ?? "zoho",
      sendMode: draftMode,
      error: (r.error as Desk["run"]["error"]) ?? null,
      readAt: ((r.zoho_read as { read_at?: string } | null)?.read_at ?? null) as string | null,
      deadline: deadlineFor(r.iso_week as string, params?.deadline ?? { weekday: "TUE", timeIST: "12:00" }),
      deadlineAppliedAt: (r.deadline_applied_at as string | null) ?? null,
      notes: (r.notes as string[] | null) ?? [],
    },
    lines,
    drafts: (drafts.data ?? []).map((d) => ({
      id: d.id as string,
      supplierId: d.supplier_id as string,
      reference: d.reference as string,
      mode: d.mode as string,
      status: d.status as string,
      createdAt: d.created_at as string,
      issuedAt: (d.issued_at as string | null) ?? null,
      needsReapproval: d.needs_reapproval as boolean,
      units: ((d.requested_lines ?? []) as Array<{ qty: number }>).reduce((a, x) => a + x.qty, 0),
    })),
    reasonCodes: (codes.data ?? []) as Array<{ code: string; label: string }>,
    supplierNames: Object.fromEntries((suppliers.data ?? []).map((s) => [s.id as string, (s.name as string) ?? (s.id as string)])),
    // Count drafts in the mode a Send would use, exactly as the send does (review M5, finding 10).
    plan: planSend(
      sendLines,
      new Set(
        (drafts.data ?? [])
          .filter((d) => d.status !== "creating" && d.mode === draftMode)
          .map((d) => d.supplier_id as string),
      ),
    ),
  };
}
