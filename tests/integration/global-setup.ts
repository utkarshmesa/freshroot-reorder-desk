import { execSync } from "node:child_process";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    supabase: { url: string; anonKey: string; serviceKey: string };
  }
}

// Resets the local Supabase (migrations + seed) once per integration run and shares its URL/keys.
export default function setup(project: TestProject) {
  execSync("npx supabase db reset --local --yes", { stdio: "inherit" });
  const raw = execSync("npx supabase status --output json", { encoding: "utf8" });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  project.provide("supabase", { url: status.API_URL!, anonKey: status.ANON_KEY!, serviceKey: status.SERVICE_ROLE_KEY! });
}
