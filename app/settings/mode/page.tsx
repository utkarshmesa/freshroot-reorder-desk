import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { setMode } from "../actions";
import { Flash, SettingsNav, type SearchParams } from "../ui";

export default async function ModePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const { data } = await (await userClient()).from("app_mode").select("mode, changed_at").maybeSingle();
  const mode = data?.mode ?? "shadow";
  const ceiling = process.env.APP_MODE === "live" ? "live" : "shadow";
  const editable = can(session, "owner.setMode");

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="mode" />
      <Flash searchParams={searchParams} />
      <div className="card">
        <p>
          Setting: <span className={`badge ${mode}`}>{mode}</span>
          {data?.changed_at && <span className="muted"> since {new Date(data.changed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>}
        </p>
        <p>
          This deployment allows: <span className={`badge ${ceiling}`}>{ceiling === "live" ? "live" : "shadow only"}</span>
        </p>
        <p className="muted">
          In <strong>shadow</strong> mode the system records recommendations and decisions but creates no drafts in Zoho. Drafts are created only when this
          setting, this deployment and the week&apos;s run all say live, so switching takes effect from <strong>next Monday&apos;s run</strong>, never mid-week.
        </p>
      </div>
      {editable ? (
        <form action={setMode} className="card row">
          <select name="mode" defaultValue={mode} aria-label="Mode">
            <option value="shadow">shadow</option>
            <option value="live">live</option>
          </select>
          <input name="reason" placeholder="Reason (required)" required style={{ flex: 1, minWidth: 240 }} aria-label="Reason" />
          <button className="primary">Save</button>
        </form>
      ) : (
        <p className="muted">Only Deepa can switch between shadow and live.</p>
      )}
    </Shell>
  );
}
