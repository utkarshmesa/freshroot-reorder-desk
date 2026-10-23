import Link from "next/link";
import { canSee, SCREEN_ORDER, type Screen } from "@/lib/auth/access";
import type { Session } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { signOut } from "@/app/login/actions";

const LABEL: Record<Screen, string> = { upload: "Upload", review: "Review desk", settings: "Settings", outcomes: "Outcomes", instructions: "Instructions" };

/** Page frame: role-filtered nav, the current mode, and "How this works" on every screen (BUILD_PLAN §10.5). */
export async function Shell({ session, current, children }: { session: Session; current: Screen; children: React.ReactNode }) {
  const db = await userClient();
  const { data: mode } = await db.from("app_mode").select("mode").maybeSingle();
  const m = mode?.mode ?? "shadow";
  return (
    <>
      <header className="top">
        <span className="brand">Freshroots Reorder Desk</span>
        <nav>
          {SCREEN_ORDER.filter((s) => s !== "instructions" && canSee(session, s)).map((s) => (
            <Link key={s} href={`/${s}`} aria-current={s === current ? "page" : undefined}>
              {LABEL[s]}
            </Link>
          ))}
        </nav>
        <div className="right">
          <span className={`badge ${m}`} title="Shadow: no drafts are created in Zoho. Only Deepa can switch.">{m === "live" ? "LIVE" : "Shadow mode"}</span>
          <Link href="/instructions">How this works</Link>
          <span>{session.name}</span>
          <form action={signOut}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
