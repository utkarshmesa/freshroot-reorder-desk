// Outcomes (BUILD_PLAN §10.4, ARCHITECTURE §8): the weekly brief, pilot vs manual, order speed, decisions,
// rule versions. Success is fewer stockout weeks and lower write-offs than manual planning, with orders
// issued within 2 working days; activity counts are not success.
import { Shell } from "@/components/Shell";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { rejectionAlarm } from "@/lib/cron/schedule";
import { mondayOf, sundayOf } from "@/lib/isoweek";
import { agreement, manualOrders, pilotVsManual, shadowComparison, workingDaysBetween, type GroupWeek, type PlacedLine } from "@/lib/outcomes";
import type { RuleParams } from "@/lib/rules/defaults";

const pct = (x: number | null) => (x === null ? "–" : `${(Math.round(x * 1000) / 10).toFixed(1)}%`);
const day = (ts: string) => new Date(ts).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export default async function Page() {
  const session = await requireScreen("outcomes");
  const db = await userClient();
  const { data: runs } = await db.from("run").select("id, iso_week, upload_id, status, mode, zoho_read").is("superseded_by", null).order("iso_week", { ascending: false }).limit(26);
  const runIds = (runs ?? []).map((r) => r.id as string);
  const latest = runs?.[0];

  const [brief, recs, drafts, decisions, versions, uploads, rules] = await Promise.all([
    latest ? db.from("brief").select("text, source").eq("run_id", latest.id).maybeSingle() : Promise.resolve({ data: null }),
    runIds.length ? db.from("recommendation").select("id, run_id, sku_id, action, qty, holdout, spot_check, inputs").in("run_id", runIds) : Promise.resolve({ data: [] }),
    db.from("draft_po").select("reference, run_id, mode, status, created_at, issued_at").eq("mode", "live").order("created_at", { ascending: false }).limit(200),
    db.from("decision").select("status, final_qty, reason_code, note, at, recommendation(sku_id, qty, spot_check, run_id)").order("at", { ascending: false }).limit(200),
    db.from("rule_version").select("id, reason, is_current, created_at").order("id", { ascending: false }),
    db.from("upload").select("id, committed_at").eq("status", "committed"),
    db.from("rule_version").select("params").eq("is_current", true).maybeSingle(),
  ]);
  const weekOf = new Map((runs ?? []).map((r) => [r.id as string, r.iso_week as string]));
  const modeOf = new Map((runs ?? []).map((r) => [r.id as string, r.mode as string]));

  // Pilot vs manual (C-031 B; lost sales unknown without ordered_units, so the empty shelf decides). Live weeks
  // only: in shadow Raghav plans every SKU, so the groups don't differ yet (stress test F6).
  const rows: GroupWeek[] = ((recs.data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => modeOf.get(r.run_id as string) === "live")
    .map((r) => {
      const i = r.inputs as { onHand: number | null; a12: number };
      return { skuId: r.sku_id as string, week: weekOf.get(r.run_id as string) ?? "", holdout: r.holdout as boolean, onHand: i.onHand ?? NaN, lostUnits: null, rawA12: i.a12 };
    })
    .filter((r) => Number.isFinite(r.onHand));
  const pvm = pilotVsManual(rows);

  // Order speed: Monday commit → issued in Zoho, working days (live drafts only).
  const committed = new Map(((uploads.data ?? []) as Array<{ id: string; committed_at: string | null }>).map((u) => [u.id, u.committed_at]));
  const runUpload = new Map((runs ?? []).map((r) => [r.id as string, r.upload_id as string | null]));
  const speed = ((drafts.data ?? []) as Array<{ reference: string; run_id: string; status: string; created_at: string; issued_at: string | null }>).map((d) => {
    const from = committed.get(runUpload.get(d.run_id) ?? "") ?? d.created_at;
    return { ...d, days: d.issued_at ? workingDaysBetween(from, d.issued_at) : null };
  });
  const issued = speed.filter((s) => s.days !== null);
  const withinSla = issued.filter((s) => s.days! <= 2).length;

  const decs = (decisions.data ?? []) as unknown as Array<{ status: string; final_qty: number | null; reason_code: string | null; note: string | null; at: string; recommendation: { sku_id: string; qty: number; spot_check: boolean; run_id: string } | null }>;
  // F6: unit-weighted, current shadow runs only (C-018).
  const agree = agreement(
    decs
      .filter((d) => d.recommendation && weekOf.has(d.recommendation.run_id) && modeOf.get(d.recommendation.run_id) === "shadow")
      .map((d) => ({ status: d.status, units: d.recommendation!.qty })),
  );

  // C-038: per shadow week, the system's own recommendation vs what Raghav actually ordered (non-system POs dated
  // that week, as later Monday reads of Zoho show them).
  const placed = (runs ?? []).flatMap((r) => (r.zoho_read as { po_lines?: PlacedLine[] } | null)?.po_lines ?? []);
  const shadowWeeks = (runs ?? [])
    .filter((r) => r.mode === "shadow")
    .map((r) => {
      const manual = manualOrders(placed, mondayOf(r.iso_week as string), sundayOf(r.iso_week as string));
      const rowsW = ((recs.data ?? []) as Array<Record<string, unknown>>)
        .filter((x) => x.run_id === r.id && !x.holdout)
        .map((x) => ({ skuId: x.sku_id as string, system: x.action === "reorder" ? (x.qty as number) : 0, manual: manual.get(x.sku_id as string) ?? 0 }));
      return { week: r.iso_week as string, ...shadowComparison(rowsW) };
    });
  const params = (rules.data?.params ?? null) as RuleParams | null;
  const rejection = rejectionAlarm(
    decs.filter((d) => d.status !== "reapproved").map((d) => ({ state: d.status, units: d.recommendation?.qty ?? 0 })),
    params?.rejectionAlarm ?? { lowPct: 5, highPct: 40 },
  );
  const spot = decs.filter((d) => d.recommendation?.spot_check && d.status !== "reapproved");

  return (
    <Shell session={session} current="outcomes">
      <h1>Outcomes</h1>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>This week&apos;s brief{latest ? ` · ${latest.iso_week}` : ""}</h2>
        {brief.data ? (
          <p>
            {brief.data.text} <span className="muted small">({brief.data.source === "llm" ? "AI-written, numbers checked" : "standard text"})</span>
          </p>
        ) : (
          <p className="muted">No brief yet: it is written when the run finishes.</p>
        )}
      </section>

      <h2>Pilot vs manual</h2>
      <p className="small muted">
        Stockout week: the Sunday shelf is empty, or sales were lost (C-031). Low cover (under a week on the shelf) is a warning, not a stockout. Same weeks, same definitions for both groups. Live
        weeks only: in shadow Raghav plans every SKU. With 15 SKUs the manual group is about 3 SKUs, so read this as a check, not proof (STRESS_TEST_STEP4 P2); the
        statistical test is pending (C-019).
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>SKU-weeks</th>
              <th>Stockout weeks</th>
              <th>Rate</th>
              <th>Low-cover weeks</th>
              <th>Write-offs</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Pilot (rules)", pvm.pilot],
                ["Manual (holdout)", pvm.manual],
              ] as const
            ).map(([label, g]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{g.skuWeeks}</td>
                <td>{g.stockoutWeeks}</td>
                <td>{g.skuWeeks ? pct(g.rate) : "–"}</td>
                <td>{g.lowCoverWeeks}</td>
                <td className="muted">not available (C-014)</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Shadow: the system against Raghav&apos;s actual orders</h2>
      <p className="small muted">
        For each shadow week: the system&apos;s recommendation for every SKU (before any review) against the purchase orders Raghav and procurement actually placed that
        week, as the next Monday read of Zoho shows them. A PO placed and fully received before the next Monday isn&apos;t seen. This is the main evidence for the
        go-live gate (C-037, C-038).
      </p>
      {shadowWeeks.length === 0 ? (
        <p className="muted">No shadow weeks yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th>Same call (order or not)</th>
                <th>Units: system / Raghav</th>
                <th>System only</th>
                <th>Raghav only</th>
              </tr>
            </thead>
            <tbody>
              {shadowWeeks.map((w) => (
                <tr key={w.week}>
                  <td>{w.week}</td>
                  <td>
                    {w.sameDecision} of {w.skuWeeks}
                    {w.sameDecisionPct === null ? "" : ` (${w.sameDecisionPct}%)`}
                  </td>
                  <td>
                    {w.systemUnits.toLocaleString("en-IN")} / {w.manualUnits.toLocaleString("en-IN")}
                  </td>
                  <td className="small">{w.systemOnly.join(", ") || "–"}</td>
                  <td className="small">{w.manualOnly.join(", ") || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Order speed</h2>
      <p className="small muted">Monday upload to draft issued in Zoho, in working days. Target: within 2. Live drafts only.</p>
      <p>
        {issued.length ? `${withinSla} of ${issued.length} issued drafts within 2 working days.` : "No live drafts issued yet."}{" "}
        {speed.filter((s) => s.status === "created").length ? `${speed.filter((s) => s.status === "created").length} still waiting to be issued.` : ""}
      </p>

      <h2>Decisions</h2>
      <div className="stats">
        <div className="stat">
          <b>{agree.pct === null ? "–" : `${agree.pct}%`}</b>
          <span>of reviewed units approved as recommended in shadow weeks ({agree.approved.toLocaleString("en-IN")} of {agree.decided.toLocaleString("en-IN")})</span>
        </div>
        <div className="stat">
          <b>{rejection.ratePct === null ? "–" : `${rejection.ratePct}%`}</b>
          <span>
            rejected, by units{rejection.level ? (rejection.level === "low" ? " · below 5%: are cards being rubber-stamped?" : " · above 40%: rules may be off") : ""}
          </span>
        </div>
        <div className="stat">
          <b>{spot.length}</b>
          <span>spot-checks reviewed ({spot.filter((d) => d.status === "rejected").length} rejected)</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Week</th>
              <th>SKU</th>
              <th>Decision</th>
              <th>Qty (rules → final)</th>
              <th>Reason / note</th>
            </tr>
          </thead>
          <tbody>
            {decs.slice(0, 50).map((d, i) => (
              <tr key={i}>
                <td>{day(d.at)}</td>
                <td>{weekOf.get(d.recommendation?.run_id ?? "") ?? ""}</td>
                <td>{d.recommendation?.sku_id}</td>
                <td>{d.status}</td>
                <td>
                  {d.recommendation?.qty ?? "–"} → {d.final_qty ?? "–"}
                </td>
                <td className="small">{[d.reason_code, d.note].filter(Boolean).join(": ")}</td>
              </tr>
            ))}
            {decs.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No decisions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Rule versions</h2>
      <ul className="small">
        {(versions.data ?? []).map((v) => (
          <li key={v.id as number}>
            v{v.id as number} · {day(v.created_at as string)} · {v.reason as string}
            {v.is_current ? " (current)" : ""}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
