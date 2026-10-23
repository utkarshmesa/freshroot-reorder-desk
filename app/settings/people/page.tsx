import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { invitePerson, savePerson } from "../actions";
import { Flash, SettingsNav, type SearchParams } from "../ui";

const ROLES = ["uploader", "planner", "procurement", "admin", "viewer"] as const;

type Person = { user_id: string; name: string; email: string; roles: string[]; is_owner: boolean; backup_for: string | null; backup_from: string | null; backup_to: string | null };

export default async function PeoplePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const { data } = await (await userClient()).from("app_user").select("*").order("name");
  const people = (data ?? []) as Person[];
  const editable = can(session, "settings.editPeople");

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="people" />
      <Flash searchParams={searchParams} />
      <p className="muted">
        Five roles: uploader (Priya; IT backup), planner (Raghav; Deepa backup), procurement (read-only here; works in Zoho), admin (IT; Deepa for mode, holdout
        and deadlines), viewer (CEO). Backup dates route alerts to the backup while someone is away.
      </p>
      {!editable && <p className="muted">You can see your own entry. The IT admin manages people.</p>}
      {people.map((p) =>
        editable ? (
          <form key={p.user_id} action={savePerson} className="card grid">
            <input type="hidden" name="user_id" value={p.user_id} />
            <label>
              Name
              <input name="name" defaultValue={p.name} required />
            </label>
            <label>
              Email
              <input value={p.email} readOnly />
            </label>
            <fieldset style={{ border: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 10 }}>
              <legend className="muted" style={{ fontSize: 13 }}>
                Roles {p.is_owner && <span className="badge">owner</span>}
              </legend>
              {ROLES.map((r) => (
                <label key={r} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" name={`role_${r}`} defaultChecked={p.roles.includes(r)} /> {r}
                </label>
              ))}
            </fieldset>
            <label>
              Backup for
              <input name="backup_for" defaultValue={p.backup_for ?? ""} placeholder="e.g. planner" />
            </label>
            <label>
              From
              <input name="backup_from" type="date" defaultValue={p.backup_from ?? ""} />
            </label>
            <label>
              To
              <input name="backup_to" type="date" defaultValue={p.backup_to ?? ""} />
            </label>
            <div className="row">
              <button>Save</button>
            </div>
          </form>
        ) : (
          <div key={p.user_id} className="card">
            <strong>{p.name}</strong> <span className="muted">{p.email}</span> · {p.roles.join(", ")}
          </div>
        ),
      )}
      {editable && (
        <>
          <h2>Invite someone</h2>
          <form action={invitePerson} className="card grid">
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Name
              <input name="name" required />
            </label>
            <fieldset style={{ border: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 10 }}>
              <legend className="muted" style={{ fontSize: 13 }}>
                Roles
              </legend>
              {ROLES.map((r) => (
                <label key={r} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" name={`role_${r}`} /> {r}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <button className="primary">Send invite</button>
            </div>
          </form>
        </>
      )}
    </Shell>
  );
}
