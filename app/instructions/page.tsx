// Instructions (BUILD_PLAN §10.5): docs/INSTRUCTIONS.md with every ⚙ value read live from the current rules,
// the same source the engine uses, so this page can't disagree with what the system does. Every role sees it;
// "How this works" in every header links here, and assumed tags and validation errors link to its sections.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Shell } from "@/components/Shell";
import { requireScreen } from "@/lib/auth/me";
import { userClient } from "@/lib/db/server";
import { renderInstructions } from "@/lib/instructions/render";
import { DEFAULT_RULES } from "@/lib/rules/defaults";

export const dynamic = "force-dynamic"; // a rule change shows at once

const day = (ts: string) => new Date(ts).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export default async function Page() {
  const session = await requireScreen("instructions");
  const markdown = readFileSync(path.join(process.cwd(), "docs", "INSTRUCTIONS.md"), "utf8");
  const { data: current } = await (await userClient()).from("rule_version").select("id, params, reason, created_at").eq("is_current", true).maybeSingle();
  const { html, errors } = renderInstructions(markdown, current?.params ?? DEFAULT_RULES);

  return (
    <Shell session={session} current="instructions">
      {current ? (
        <p className="small muted">
          Values marked <span className="gear">⚙</span> come from rules version {current.id as number}, in use since {day(current.created_at as string)} ({current.reason as string}).
        </p>
      ) : (
        <div className="banner bad">The current rules couldn&apos;t be read, so ⚙ values show the original defaults. Tell IT.</div>
      )}
      {errors.length > 0 && <div className="banner bad">Some ⚙ values couldn&apos;t be read from the rules ({errors.join(", ")}); they show the original default. Tell IT.</div>}
      <article className="instructions" dangerouslySetInnerHTML={{ __html: html }} />
    </Shell>
  );
}
