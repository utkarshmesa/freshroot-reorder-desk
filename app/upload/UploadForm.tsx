"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReportView } from "@/components/ReportView";
import { browserClient } from "@/lib/db/browser";
import type { Report } from "@/lib/upload/types";
import { confirmAndCommit, validateUpload } from "./actions";

type State =
  | { step: "pick" }
  | { step: "checking" }
  | { step: "report"; uploadId: string; report: Report }
  | { step: "committing"; uploadId: string; report: Report }
  | { step: "done"; message: string };

export function UploadForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ step: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());

  async function onCheck(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const files = Array.from((e.currentTarget.elements.namedItem("files") as HTMLInputElement).files ?? []);
    if (files.length === 0) return setError("Choose the files to upload.");
    setState({ step: "checking" });
    const batch = crypto.randomUUID();
    const storage = browserClient().storage.from("uploads");
    const paths: string[] = [];
    for (const f of files) {
      const p = `${userId}/${batch}/${f.name}`;
      const { error: err } = await storage.upload(p, f, { upsert: false });
      if (err) {
        setState({ step: "pick" });
        return setError(`Couldn't upload ${f.name}: ${err.message}`);
      }
      paths.push(p);
    }
    const res = await validateUpload(paths);
    if (!res.ok) {
      setState({ step: "pick" });
      return setError(res.error);
    }
    setConfirmed(new Set());
    setState({ step: "report", uploadId: res.uploadId, report: res.report });
    router.refresh();
  }

  async function onCommit() {
    if (state.step !== "report") return;
    setError(null);
    setState({ step: "committing", uploadId: state.uploadId, report: state.report });
    const res = await confirmAndCommit(state.uploadId, [...confirmed]);
    if (!res.ok) {
      setError(res.error);
      return setState({ step: "report", uploadId: state.uploadId, report: state.report });
    }
    const r = res.result;
    const corrected = r.restated_weeks.length ? ` Corrected ${r.restated_weeks.join(", ")} (logged).` : "";
    setState({
      step: "done",
      message: r.run_week
        ? `Committed. The ${r.run_week} run is queued${r.superseded_run ? "; it replaces the earlier run for that week" : ""}.${corrected}`
        : `Committed.${corrected}`,
    });
    router.refresh();
  }

  const toggle = (c: string) => setConfirmed((s) => (s.has(c) ? new Set([...s].filter((x) => x !== c)) : new Set([...s, c])));
  const report = state.step === "report" || state.step === "committing" ? state.report : null;
  const needed = report?.issues.filter((i) => i.level === "confirm").map((i) => i.code) ?? [];
  const canCommit = state.step === "report" && report !== null && report.errors === 0 && needed.every((c) => confirmed.has(c));

  return (
    <div className="card">
      {error && <div className="banner bad">{error}</div>}
      {(state.step === "pick" || state.step === "checking") && (
        <form onSubmit={onCheck} className="row">
          <input type="file" name="files" multiple accept=".csv,.xlsx" aria-label="Files to upload" />
          <button className="primary" disabled={state.step === "checking"}>
            {state.step === "checking" ? "Checking…" : "Check files"}
          </button>
        </form>
      )}
      {report && (
        <>
          <ReportView report={report} confirmed={confirmed} onToggle={toggle} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={onCommit} disabled={!canCommit}>
              {state.step === "committing" ? "Committing…" : "Commit"}
            </button>
            <button onClick={() => setState({ step: "pick" })}>Start again</button>
            {report.errors > 0 && <span className="err">Fix the red items and upload again. Nothing has been saved.</span>}
          </div>
        </>
      )}
      {state.step === "done" && (
        <div>
          <div className="banner ok">{state.message}</div>
          <button onClick={() => setState({ step: "pick" })}>Upload more</button>
        </div>
      )}
    </div>
  );
}
