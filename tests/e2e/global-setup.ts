import { execSync } from "node:child_process";

// Start every e2e run from migrations + seed (local only). The dev server keeps running.
export default function setup() {
  execSync("npx supabase db reset --local --yes", { stdio: "inherit" });
}
