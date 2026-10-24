// One queue card (BUILD_PLAN §10.2): action and qty, Claude's (checked) reason, cover gauge, flags,
// assumed values, top distributors, and the decide form for the planner.
import { Assumed } from "@/app/settings/ui";
import { roundHalfEven } from "@/lib/engine/round";
import { decide } from "./actions";
import type { DeskLine } from "./data";

export const units = (x: number | null | undefined) => (x === null || x === undefined ? "–" : Math.round(x).toLocaleString("en-IN"));
export const wks = (x: number | null | undefined) => (x === null || x === undefined ? "–" : roundHalfEven(x, 1).toFixed(1));

const FLAG_LABEL: Record<string, string> = {
  high_demand: "High demand",
  perishable: "Perishable",
  new_sku: "New SKU",
  hold: "Hold",
  infeasible: "Infeasible",
  borderline: "Borderline",
  conflict: "Conflict: stock high, sales rising",
  capped_at_perishable_max: "Capped at perishable max",
  pack_mismatch: "Pack size mismatch",
  short_history: "Short history",
  over_auto_limit: "Over auto-approve limit",
  overdue_po: "Overdue PO lines",
  no_launch_estimate: "No launch estimate",
};

/** Cover now, the target band and cover after the order, on one line. */
export function Gauge({ cover, min, max, after, reorder }: { cover: number | null; min: number; max: number; after: number | null; reorder: boolean }) {
  if (cover === null || !Number.isFinite(cover)) return null;
  const top = Math.max(max * 1.35, (after ?? 0) * 1.1, cover * 1.1, min + 2);
  const W = 600;
  const x = (v: number) => Math.max(2, Math.min(W - 2, (v / top) * W));
  const label = `Cover ${wks(cover)} weeks; target ${min} to ${max} weeks${reorder && after !== null ? `; after order ${wks(after)} weeks` : ""}`;
  return (
    <svg className="gauge" viewBox={`0 0 ${W} 30`} preserveAspectRatio="none" role="img" aria-label={label}>
      <rect x="0" y="5" width={W} height="8" rx="4" fill="var(--line)" />
      <rect x={x(min)} y="5" width={Math.max(0, x(max) - x(min))} height="8" fill="var(--ok-bg)" stroke="var(--accent)" strokeWidth="0.5" />
      {reorder && after !== null && (
        <>
          <line x1={x(cover)} x2={x(after)} y1="9" y2="9" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 3" />
          <rect x={x(after) - 2} y="2" width="4" height="14" rx="1" fill="var(--accent)" />
        </>
      )}
      <rect x={x(cover) - 2} y="1" width="4" height="16" rx="1" fill="var(--text)" />
      {[0, min, max].map((v) => (
        <text key={v} x={x(v)} y="29" fontSize="10" textAnchor={v === 0 ? "start" : "middle"} fill="var(--muted)">
          {v}w
        </text>
      ))}
    </svg>
  );
}

const ACTION_LABEL: Record<string, string> = { reorder: "Reorder", pause: "Pause", none: "No action", blocked: "Blocked" };

export function Card({ line, canDecide, reasonCodes, distributorNames }: { line: DeskLine; canDecide: boolean; reasonCodes: Array<{ code: string; label: string }>; distributorNames: Record<string, string> | null }) {
  const r = line.rec;
  const infeasible = r.flags.includes("infeasible") && r.infeasibleOptions;
  const flags = r.flags.filter((f) => FLAG_LABEL[f]);
  return (
    <article className={`card desk-card ${r.action}`} id={`card-${line.id}`}>
      <div className="row">
        <strong className={`act ${r.action}`}>
          {ACTION_LABEL[r.action]}
          {r.action === "reorder" && !infeasible ? ` ${units(r.qty)}` : ""}
        </strong>
        <span className="name">{r.name}</span>
        <span className="muted small">
          {r.skuId} · supplier {r.supplierId ?? "–"} · {r.daysToStockout === null ? "days to stockout unknown" : `about ${Math.round(r.daysToStockout)} days of shelf stock`}
        </span>
        {r.spotCheck && <span className="badge" title="Auto-approved; shown to you as one of this week's random spot-checks (D9).">Spot-check</span>}
      </div>
      {line.reason && (
        <p className="why">
          {line.reason}{" "}
          <span className="muted small" title={line.reasonSource === "llm" ? "Written by Claude; every number checked against the engine." : "Standard text from the rules."}>
            ({line.reasonSource === "llm" ? "AI-written, numbers checked" : "rule text"})
          </span>
        </p>
      )}
      <Gauge cover={r.cover} min={r.minEff} max={r.max} after={r.coverAfter} reorder={r.action === "reorder" && !infeasible} />
      <div className="row tags">
        {flags.map((f) => (
          <span key={f} className="badge">
            {FLAG_LABEL[f]}
          </span>
        ))}
        {r.assumed.map((a) => (
          <Assumed key={a}>{a.replace("_", " ")}</Assumed>
        ))}
      </div>
      {infeasible && (
        <div className="banner info">
          The order the rules want doesn&apos;t fit under the {r.max}-week perishable maximum. Choose: <strong>order the MOQ of {units(r.infeasibleOptions!.orderMoq.qty)}</strong> (cover {wks(r.infeasibleOptions!.orderMoq.coverAfter)} weeks, above the maximum) or{" "}
          <strong>skip</strong> (about {r.infeasibleOptions!.skip.daysToStockout === null ? "unknown" : Math.round(r.infeasibleOptions!.skip.daysToStockout)} days to stockout).
        </div>
      )}
      {r.openPoLines.some((l) => l.overdue) && (
        <p className="small">
          Overdue:{" "}
          {r.openPoLines
            .filter((l) => l.overdue)
            .map((l) => `${units(l.openQty)} units on ${l.poNumber} (due ${l.expectedDate ?? "?"})`)
            .join("; ")}
        </p>
      )}
      <details>
        <summary className="small muted">Numbers</summary>
        <dl className="facts">
          {(
            [
              ["On hand (Sun 23:59)", units(r.onHand)],
              ["Open PO qty", units(r.openPoQty)],
              ["Receipts since Monday", units(r.receiptsAfterSnapshot)],
              ["Position", units(r.position)],
              ["12-wk avg / wk", wks(r.a12)],
              ["4-wk avg / wk", wks(r.a4)],
              ["Forward demand / wk", wks(r.forwardDemand)],
              ["Cover (wks)", wks(r.cover)],
              ["Band (wks)", `${r.minEff}–${r.max}`],
              ["Lead time (wks)", String(r.leadTimeWks)],
              ["Standard qty / MOQ", `${units(r.stdQty)} / ${units(r.moq)}`],
              ["Cover after (wks)", wks(r.coverAfter)],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {r.topDistributors && r.topDistributors.length > 0 && (
          <p className="small">
            Biggest movers:{" "}
            {r.topDistributors.map((d) => `${distributorNames ? (distributorNames[d.distributorId] ?? d.distributorId) : d.distributorId} ${d.deltaUnits > 0 ? "+" : ""}${units(d.deltaUnits)} (${Math.round(d.pct)}%)`).join(", ")}
          </p>
        )}
      </details>
      {canDecide && (
        <form action={decide} className="decide">
          <input type="hidden" name="id" value={line.id} />
          {infeasible ? (
            <>
              <input type="hidden" name="qty" value={r.infeasibleOptions!.orderMoq.qty} />
              <button className="primary" name="op" value="change">
                Order MOQ {units(r.infeasibleOptions!.orderMoq.qty)}
              </button>
              <button name="op" value="approve">
                Skip this week
              </button>
            </>
          ) : (
            <>
              <button className="primary" name="op" value="approve">
                Approve{r.action === "reorder" ? ` ${units(r.qty)}` : ""}
              </button>
              {r.action === "reorder" && (
                <label className="inline">
                  Qty <input type="number" name="qty" min="1" step="1" defaultValue={r.qty} aria-label={`Changed quantity for ${r.name}`} />
                </label>
              )}
              {r.action === "reorder" && (
                <button name="op" value="change">
                  Approve changed qty
                </button>
              )}
            </>
          )}
          <select name="reason" aria-label={`Reason for ${r.name}`} defaultValue="">
            <option value="">Reason (needed to reject)…</option>
            {reasonCodes.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <input name="note" placeholder="What do you know that the rules don't?" aria-label={`Note for ${r.name}`} />
          <button name="op" value="reject">
            Reject
          </button>
        </form>
      )}
    </article>
  );
}
