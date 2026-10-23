import { Shell } from "@/components/Shell";
import { can } from "@/lib/auth/access";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { saveSupplier } from "../actions";
import { Flash, ReadOnlyNote, SettingsNav, type SearchParams } from "../ui";

export default async function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireScreen("settings");
  const { data } = await (await userClient()).from("supplier").select("id, name, zoho_vendor_id").order("id");
  const editable = can(session, "settings.editMaster");

  return (
    <Shell session={session} current="settings">
      <h1>Settings</h1>
      <SettingsNav current="suppliers" />
      <Flash searchParams={searchParams} />
      <ReadOnlyNote session={session} action="settings.editMaster" />
      <p className="muted">Each supplier needs its Zoho vendor id; without it, that supplier&apos;s SKUs are blocked from ordering. One system draft per supplier per week.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Zoho vendor id</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                {editable ? (
                  <td colSpan={4}>
                    <form action={saveSupplier} className="row">
                      <input name="id" defaultValue={s.id} readOnly size={10} aria-label="Supplier id" />
                      <input name="name" defaultValue={s.name} required aria-label="Name" />
                      <input name="zoho_vendor_id" defaultValue={s.zoho_vendor_id ?? ""} placeholder="not mapped" aria-label="Zoho vendor id" />
                      <button>Save</button>
                    </form>
                  </td>
                ) : (
                  <>
                    <td>{s.id}</td>
                    <td>{s.name}</td>
                    <td>{s.zoho_vendor_id ?? <span className="err">not mapped</span>}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <h2>Add supplier</h2>
          <form action={saveSupplier} className="card row">
            <input name="id" placeholder="Supplier id" required aria-label="Supplier id" />
            <input name="name" placeholder="Name" required aria-label="Name" />
            <input name="zoho_vendor_id" placeholder="Zoho vendor id" aria-label="Zoho vendor id" />
            <button className="primary">Add</button>
          </form>
        </>
      )}
    </Shell>
  );
}
