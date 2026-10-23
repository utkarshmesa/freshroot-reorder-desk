import Link from "next/link";
import type { Report } from "@/lib/upload/types";

const LEVEL_LABEL = { error: "Fix", confirm: "Confirm", warning: "Note", info: "Info" } as const;

/** The validation report shown before commit (BUILD_PLAN §7). Red blocks the commit; yellow needs a confirm. */
export function ReportView({ report, confirmed, onToggle }: { report: Report; confirmed?: Set<string>; onToggle?: (code: string) => void }) {
  const weeks = report.newWeeks.length ? `New weeks ${report.newWeeks[0]}${report.newWeeks.length > 1 ? `–${report.newWeeks.at(-1)}` : ""}` : null;
  return (
    <div>
      {report.banner && <div className="banner info">{report.banner}</div>}
      <p className="row">
        <span className="badge">{report.errors} to fix</span>
        <span className="badge">{report.confirms} to confirm</span>
        <span className="badge">{report.warnings} notes</span>
        {report.asOf && <span className="muted">Stock as at {report.asOf.replace("T", " ").slice(0, 16)} IST</span>}
        {weeks && <span className="muted">{weeks}</span>}
        {report.restatedWeeks.length > 0 && <span className="muted">Corrects {report.restatedWeeks.join(", ")}</span>}
      </p>
      <p className="muted">Rows: {Object.entries(report.counts).map(([k, n]) => `${k} ${n}`).join(" · ") || "none"}</p>
      {report.issues.length === 0 && <div className="banner ok">No problems found.</div>}
      {report.issues.map((i, n) => (
        <div key={n} className={`issue ${i.level}`}>
          <span className="lvl">{LEVEL_LABEL[i.level]}</span>
          <span style={{ flex: 1 }}>
            {i.file && (
              <strong>
                {i.file}
                {i.row ? ` row ${i.row}` : ""}:{" "}
              </strong>
            )}
            {i.message} {i.link && <Link href={i.link}>What to do</Link>}
          </span>
          {i.level === "confirm" && onToggle && (
            <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={confirmed?.has(i.code) ?? false} onChange={() => onToggle(i.code)} /> Confirm
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
