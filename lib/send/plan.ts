// Send to procurement, pure part (ARCHITECTURE §4.1, C-015). One draft per supplier per week, created only
// when nothing for that supplier is still waiting for Raghav (we can't update a draft once created).
import type { LineState } from "@/lib/engine/deadline";

export type SendLine = { recId: number; skuId: string; supplierId: string | null; state: LineState; qty: number };
export type ReadySupplier = { supplierId: string; lines: SendLine[] };
export type SendPlan = { ready: ReadySupplier[]; waiting: Array<{ supplierId: string; queued: number }>; alreadySent: string[]; noSupplier: string[] };

/** States whose quantity goes into the supplier's draft. */
export const SENDABLE: ReadonlySet<LineState> = new Set(["auto", "approved", "changed", "deadline_auto"]);

export function planSend(lines: SendLine[], draftedThisWeek: ReadonlySet<string>): SendPlan {
  const bySupplier = new Map<string, SendLine[]>();
  const noSupplier: string[] = [];
  for (const l of lines) {
    if (!l.supplierId) {
      if (SENDABLE.has(l.state) && l.qty > 0) noSupplier.push(l.skuId);
      continue;
    }
    bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), l]);
  }
  const plan: SendPlan = { ready: [], waiting: [], alreadySent: [], noSupplier: noSupplier.sort() };
  for (const [supplierId, ls] of [...bySupplier.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sendable = ls.filter((l) => SENDABLE.has(l.state) && l.qty > 0).sort((a, b) => a.recId - b.recId);
    const queued = ls.filter((l) => l.state === "queued").length;
    if (draftedThisWeek.has(supplierId)) {
      if (sendable.length) plan.alreadySent.push(supplierId);
      continue;
    }
    if (queued) plan.waiting.push({ supplierId, queued });
    else if (sendable.length) plan.ready.push({ supplierId, lines: sendable });
  }
  return plan;
}

/**
 * Writes reach Zoho only when all three agree: the deployment (APP_MODE env), Deepa's switch (app_mode) and
 * the mode stamped on this week's run. Anything else is shadow (fail closed).
 */
export function effectiveMode(envMode: string | undefined, appMode: string, runMode: string): "live" | "shadow" {
  return envMode === "live" && appMode === "live" && runMode === "live" ? "live" : "shadow";
}

export const draftReference = (isoWeek: string, supplierId: string) => `FR-${isoWeek}-${supplierId}`;
