import { Shell } from "@/components/Shell";
import { requireScreen } from "@/lib/auth/me";
import { caseDataMode, userClient } from "@/lib/db/server";
import { UploadForm } from "./UploadForm";
import { kickPendingWork } from "@/lib/run/kick";

const ist = (ts: string, dateOnly = false) =>
  dateOnly ? new Date(ts).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) : new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export default async function UploadPage() {
  const session = await requireScreen("upload");
  await kickPendingWork(); // free-plan safety net (C-042)
  const db = await userClient();
  const { data: history } = await db
    .from("upload")
    .select("id, files, status, created_at, weeks, as_of_ts, case_data")
    .order("created_at", { ascending: false })
    .limit(20);
  const { data: runs } = await db.from("run").select("iso_week, status").is("superseded_by", null).order("created_at", { ascending: false }).limit(1);
  const lastRun = runs?.[0];

  return (
    <Shell session={session} current="upload">
      <h1>Upload</h1>
      <p className="muted">
        Monday by 08:30: this week&apos;s <strong>sales_weekly</strong> and <strong>stock_snapshot</strong> (stock as at Sunday 23:59). Master files only when
        they change. Upload the SAP export directly or as .xlsx; don&apos;t re-save it as CSV from Excel.
      </p>
      {caseDataMode() && <div className="banner info">Case-data mode is on in this environment: the case-study files are accepted as they are.</div>}
      {lastRun && (
        <p className="muted">
          Latest run: <strong>{lastRun.iso_week}</strong> ({lastRun.status})
        </p>
      )}
      {session.roles.includes("uploader") ? <UploadForm userId={session.userId} /> : <p className="muted">Your role can see upload history but not upload.</p>}

      <h2>History</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Files</th>
              <th>Weeks</th>
              <th>Stock as at</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(history ?? []).map((u) => (
              <tr key={u.id}>
                <td>{ist(u.created_at)}</td>
                <td>{u.files.join(", ")}</td>
                <td>{u.weeks.length ? `${u.weeks[0]}${u.weeks.length > 1 ? `–${u.weeks.at(-1)}` : ""}` : "—"}</td>
                <td>{u.as_of_ts ? ist(u.as_of_ts, true) : "—"}</td>
                <td>
                  {u.status}
                  {u.case_data ? " (case data)" : ""}
                </td>
              </tr>
            ))}
            {(history ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No uploads yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
