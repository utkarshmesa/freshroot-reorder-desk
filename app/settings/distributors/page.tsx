import Link from "next/link";
import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { saveDistributor } from "../actions";
import { Flash, ReadOnlyNote, SettingsNav, type SearchParams } from "../ui";

type Dist = { id: string; name: string; region: string | null; status: string; start_week: string | null; end_week: string | null };

export default async function DistributorsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const sp = await searchParams;
  const { data } = await (await userClient()).from("distributor").select("*").order("id");
  const rows = (data ?? []) as Dist[];
  const editable = can(session, "settings.editMaster");
  const editId = typeof sp.edit === "string" ? sp.edit : null;
  const editing: Partial<Dist> | null = editId === "new" ? { status: "active" } : rows.find((r) => r.id === editId) ?? null;

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="distributors" />
      <Flash searchParams={searchParams} />
      <ReadOnlyNote session={session} action="settings.editMaster" />
      <p className="muted">
        New distributor: set the start week; their first 4 weeks are ignored and weeks 5–12 stay out of the high-demand check. Leaving: set inactive with an
        end week; their history is excluded from then on.
      </p>
      {editable && (
        <p>
          <Link className="button" href="/settings/distributors?edit=new">
            Add distributor
          </Link>
        </p>
      )}
      {editable && editing && (
        <form action={saveDistributor} className="card grid" key={editId ?? "new"}>
          <label>
            Id
            <input name="id" defaultValue={editing.id} readOnly={editId !== "new"} required />
          </label>
          <label>
            Name
            <input name="name" defaultValue={editing.name} required />
          </label>
          <label>
            Region
            <input name="region" defaultValue={editing.region ?? ""} />
          </label>
          <label>
            Status
            <select name="status" defaultValue={editing.status}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </label>
          <label>
            Start week
            <input name="start_week" defaultValue={editing.start_week ?? ""} placeholder="2026-W45" />
          </label>
          <label>
            End week
            <input name="end_week" defaultValue={editing.end_week ?? ""} placeholder="2026-W52" />
          </label>
          <div className="row">
            <button className="primary">Save</button>
            <Link href="/settings/distributors">Cancel</Link>
          </div>
        </form>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Region</th>
              <th>Status</th>
              <th>Start</th>
              <th>End</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.name}</td>
                <td>{r.region ?? "—"}</td>
                <td>{r.status}</td>
                <td>{r.start_week ?? "—"}</td>
                <td>{r.end_week ?? "—"}</td>
                {editable && (
                  <td>
                    <Link href={`/settings/distributors?edit=${encodeURIComponent(r.id)}`}>Edit</Link>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No distributors yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
