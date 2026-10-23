import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import type { RuleParams } from "@/lib/rules/defaults";
import { getPath, RULE_FIELDS } from "@/lib/rules/form";
import { publishRules } from "../actions";
import { Flash, ReadOnlyNote, SettingsNav, type SearchParams } from "../ui";

const ist = (ts: string) => new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export default async function RulesPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const db = await userClient();
  const [{ data: cur }, { data: versions }, { data: names }] = await Promise.all([
    db.rpc("current_rules"),
    db.from("rule_version").select("id, reason, created_at, created_by, is_current").order("id", { ascending: false }).limit(20),
    db.from("app_user").select("user_id, name"),
  ]);
  const params = (cur as { params: RuleParams } | null)?.params;
  const editable = can(session, "settings.publishRules");
  const who = (id: string | null) => (id ? (names ?? []).find((n) => n.user_id === id)?.name ?? "someone" : "system");

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="rules" />
      <Flash searchParams={searchParams} />
      <ReadOnlyNote session={session} action="settings.publishRules" />
      <p className="muted">
        Raghav&apos;s rules. A change needs a reason, is logged, and applies from the <strong>next</strong> run (D12). Deepa reviews the log monthly; outcomes are
        reported per rule version.
      </p>
      {params && (
        <form action={publishRules} className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Value</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {RULE_FIELDS.map((f) => (
                  <tr key={f.path}>
                    <td>
                      <label htmlFor={f.path} style={{ color: "inherit", fontSize: "inherit" }}>
                        {f.label}
                      </label>
                    </td>
                    <td>
                      {editable ? (
                        <input id={f.path} name={f.path} type="number" step="any" min={f.min} max={f.max} defaultValue={String(getPath(params, f.path))} style={{ width: 110 }} />
                      ) : (
                        String(getPath(params, f.path))
                      )}
                    </td>
                    <td className="muted">{f.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="row" style={{ marginTop: 12 }}>
              <input name="reason" placeholder="Reason for the change (required)" required style={{ flex: 1, minWidth: 240 }} aria-label="Reason" />
              <button className="primary">Publish new version</button>
            </div>
          )}
        </form>
      )}
      <h2>Versions</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>When</th>
              <th>By</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {(versions ?? []).map((v) => (
              <tr key={v.id}>
                <td>
                  v{v.id} {v.is_current && <span className="badge">current</span>}
                </td>
                <td>{ist(v.created_at)}</td>
                <td>{who(v.created_by)}</td>
                <td>{v.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
