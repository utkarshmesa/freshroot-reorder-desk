import Link from "next/link";
import { can, type Action } from "@/lib/auth/access";
import type { Session } from "@/lib/auth/me";

const TABS = [
  ["skus", "SKUs"],
  ["distributors", "Distributors"],
  ["suppliers", "Suppliers"],
  ["rules", "Rules"],
  ["calendar", "Festivals & holds"],
  ["holdout", "Holdout"],
  ["people", "People"],
  ["mode", "Shadow / live"],
] as const;

export type Tab = (typeof TABS)[number][0];
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export function SettingsNav({ current }: { current: Tab }) {
  return (
    <nav className="subnav" aria-label="Settings sections">
      {TABS.map(([t, label]) => (
        <Link key={t} href={`/settings/${t}`} aria-current={t === current ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

export async function Flash({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = one(sp.error);
  const saved = one(sp.saved);
  if (error) return <div className="banner bad">{error}</div>;
  if (saved) return <div className="banner ok">Saved: {saved}</div>;
  return null;
}

export function ReadOnlyNote({ session, action }: { session: Session; action: Action }) {
  if (can(session, action)) return null;
  return <p className="muted">Read-only for your role.</p>;
}

export function Assumed({ children }: { children: React.ReactNode }) {
  return (
    <Link className="badge assumed" href="/instructions#assumptions" title="Not in the SKU master: the system uses the default. Ask Raghav to set the real value.">
      assumed {children}
    </Link>
  );
}
