// Review desk (BUILD_PLAN §10.2, ARCHITECTURE §4.1): this week's queue, what's settled, send to procurement,
// drafts, blocked and hold lists. Planner decides; procurement and admins see it read-only.
import { Shell } from "@/components/Shell";
import { Flash, type SearchParams } from "@/app/settings/ui";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { caseDataMode, userClient } from "@/lib/db/server";
import { reapprove, retryRun, send } from "./actions";
import { Card, units, wks } from "./Card";
import { loadDesk } from "./data";

export const maxDuration = 300; // Send can make Zoho calls (live mode)

const IST = (d: Date | string) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const STATE_LABEL: Record<string, string> = {
  auto: "Auto-approved",
  approved: "Approved",
  changed: "Changed",
  rejected: "Rejected",
  deadline_auto: "Tuesday rule: ordered",
  rolled: "Tuesday rule: next week",
  sent: "Sent",
  blocked_pending: "Held: earlier draft unissued",
  held_changed: "Held: PO changed since Monday",
};
const RUN_STEP: Record<string, string> = { queued: "waiting to start", readback: "reading back last week's drafts", zoho_read: "reading Zoho", mapping: "checking Zoho mapping", engine: "running the rules" };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("review");
  const canDecide = can(session, "review.decide");
  const desk = await loadDesk();

  if (!desk) {
    return (
      <Shell session={session} current="review">
        <h1>Review desk</h1>
        <Flash searchParams={searchParams} />
        <div className="banner info">No run yet. The queue appears after Monday&apos;s upload is committed.</div>
      </Shell>
    );
  }
  const { run, lines, drafts, plan } = desk;
  let distributorNames: Record<string, string> | null = null;
  if (!caseDataMode()) {
    const { data } = await (await userClient()).from("distributor").select("id, name");
    distributorNames = Object.fromEntries((data ?? []).map((d) => [d.id as string, d.name as string]));
  }

  const visible = lines.filter((l) => !l.rec.holdout);
  const queue = visible.filter((l) => l.lineState === "queued").sort((a, b) => (a.rec.daysToStockout ?? Infinity) - (b.rec.daysToStockout ?? Infinity));
  const settled = visible.filter((l) => l.lineState && l.lineState !== "queued");
  const autoLines = visible.filter((l) => l.lineState === "auto" || (l.lineState === "sent" && l.rec.triage === "auto" && !l.decision));
  const blocked = visible.filter((l) => l.rec.action === "blocked");
  const holdList = visible.filter((l) => l.rec.action === "pause" && l.rec.openPoLines.length > 0);
  const holdout = lines.filter((l) => l.rec.holdout);
  const ready = ["ready", "llm", "done"].includes(run.status);

  return (
    <Shell session={session} current="review">
      <h1>
        Review desk · {run.isoWeek} <span className={`badge ${run.mode}`}>{run.mode === "live" ? "Live run" : "Shadow run"}</span>
      </h1>
      <Flash searchParams={searchParams} />
      {run.status === "blocked" && (
        <div className="banner bad">
          <strong>This week&apos;s run is blocked.</strong> {run.error?.message ?? run.error?.reason ?? ""} Nothing goes to procurement until it&apos;s fixed. <a href="/instructions#what-to-do-when">What to do</a>
        </div>
      )}
      {run.status === "blocked" && can(session, "run.retry") && (
        <form action={retryRun} className="card row">
          <input type="hidden" name="run" value={run.id} />
          <input name="reason" required placeholder="What was fixed (required)" aria-label="What was fixed" style={{ flex: 1, minWidth: 240 }} />
          <button className="primary">Retry run</button>
        </form>
      )}
      {!ready && run.status !== "blocked" && <div className="banner info">The run is in progress ({RUN_STEP[run.status] ?? run.status}). Reload in a minute.</div>}

      {ready && (
        <>
          <p className="muted">
            Position as of {run.readAt ? IST(run.readAt) : "–"} IST. Decide by <strong>{IST(run.deadline)} IST</strong>
            {run.deadlineAppliedAt ? `; the Tuesday rule was applied ${IST(run.deadlineAppliedAt)}.` : "; after that the Tuesday rule decides unreviewed cards."}
          </p>
          {run.notes.map((n) => (
            <p key={n} className="small muted">
              Note: {n}
            </p>
          ))}

          <div className="stats">
            <div className="stat">
              <b>{queue.length}</b>
              <span>waiting for you</span>
            </div>
            <div className="stat">
              <b>{autoLines.length}</b>
              <span>auto-approved ({units(autoLines.reduce((a, l) => a + (l.finalQty ?? l.rec.qty), 0))} units)</span>
            </div>
            <div className="stat">
              <b>{visible.filter((l) => l.rec.action === "pause").length}</b>
              <span>pauses</span>
            </div>
            <div className="stat">
              <b>{blocked.length}</b>
              <span>blocked</span>
            </div>
          </div>

          <section className="card">
            <h2 style={{ marginTop: 0 }}>Send to procurement</h2>
            <p className="small muted">
              A supplier&apos;s draft is created once nothing for it waits on you. {run.mode === "live" ? "Live: drafts are created in Zoho (never issued)." : "Shadow: drafts are recorded here only; nothing reaches Zoho."}
            </p>
            <ul className="small">
              {plan.ready.map((s) => (
                <li key={s.supplierId}>
                  {desk.supplierNames[s.supplierId] ?? s.supplierId}: ready, {s.lines.length} line(s), {units(s.lines.reduce((a, l) => a + l.qty, 0))} units
                </li>
              ))}
              {plan.waiting.map((w) => (
                <li key={w.supplierId}>
                  {desk.supplierNames[w.supplierId] ?? w.supplierId}: {w.queued} card(s) left
                </li>
              ))}
              {plan.noSupplier.length > 0 && <li className="err">No supplier set for {plan.noSupplier.join(", ")}: fix in Settings → SKUs.</li>}
            </ul>
            {canDecide && (
              <form action={send}>
                <input type="hidden" name="run" value={run.id} />
                <button className="primary" disabled={plan.ready.length === 0}>
                  Send {plan.ready.length} supplier draft(s)
                </button>
              </form>
            )}
          </section>

          <h2>Needs your decision ({queue.length})</h2>
          <p className="small muted">Most urgent first (fewest days of shelf stock).</p>
          {queue.length === 0 && <div className="banner ok">Nothing waits on you this week.</div>}
          {queue.map((l) => (
            <Card key={l.id} line={l} canDecide={canDecide} reasonCodes={desk.reasonCodes} distributorNames={distributorNames} />
          ))}

          {drafts.length > 0 && (
            <>
              <h2>Drafts this week</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Supplier</th>
                      <th>Mode</th>
                      <th>Status</th>
                      <th>Units</th>
                      <th>Created</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((d) => (
                      <tr key={d.id}>
                        <td>{d.reference}</td>
                        <td>{desk.supplierNames[d.supplierId] ?? d.supplierId}</td>
                        <td>{d.mode}</td>
                        <td>{d.status === "skipped_pending" ? "Skipped: earlier draft unissued" : d.status}</td>
                        <td>{units(d.units)}</td>
                        <td>{IST(d.createdAt)}</td>
                        <td>
                          {d.needsReapproval && canDecide ? (
                            <form action={reapprove} className="row">
                              <input type="hidden" name="draft" value={d.id} />
                              <button>Re-approve</button>
                            </form>
                          ) : d.needsReapproval ? (
                            "Needs Raghav's re-approval"
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {settled.length > 0 && (
            <>
              <h2>Settled this week ({settled.length})</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Rules said</th>
                      <th>State</th>
                      <th>Final qty</th>
                      <th>Reason / note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settled.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.rec.skuId} {l.rec.name}
                        </td>
                        <td>
                          {l.rec.action} {l.rec.action === "reorder" ? units(l.rec.qty) : ""}
                        </td>
                        <td>{STATE_LABEL[l.lineState!] ?? l.lineState}</td>
                        <td>{units(l.finalQty)}</td>
                        <td className="small">{[l.decision?.reasonCode, l.decision?.note].filter(Boolean).join(": ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {holdList.length > 0 && (
            <>
              <h2>Hold list: open PO lines to defer</h2>
              <p className="small muted">Cover is above the maximum. Procurement may defer these lines; the system never edits a PO.</p>
              <ul className="small">
                {holdList.map((l) => (
                  <li key={l.id}>
                    {l.rec.skuId} {l.rec.name} (cover {wks(l.rec.cover)} wks): {l.rec.openPoLines.map((p) => `${units(p.openQty)} on ${p.poNumber}`).join(", ")}
                  </li>
                ))}
              </ul>
            </>
          )}

          {blocked.length > 0 && (
            <>
              <h2>Blocked ({blocked.length})</h2>
              <ul className="small">
                {blocked.map((l) => (
                  <li key={l.id}>
                    {l.rec.skuId} {l.rec.name}: {l.rec.blockedReason}
                  </li>
                ))}
              </ul>
            </>
          )}

          {holdout.length > 0 && (
            <>
              <h2>Planned manually (holdout, {holdout.length})</h2>
              <p className="small muted">Kept on Raghav&apos;s manual plan to measure the pilot. The system&apos;s recommendations for these are hidden.</p>
              <p className="small">{holdout.map((l) => `${l.rec.skuId} ${l.rec.name}`).join(", ")}</p>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
