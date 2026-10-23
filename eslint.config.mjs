import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Module boundaries from docs/ARCHITECTURE.md §2.1.
const pureForbidden = [
  { group: ["@/lib/zoho*", "@/lib/llm*", "@/lib/db*", "@/lib/run*", "@/lib/upload/server*", "@supabase/*", "next/*", "server-only"], message: "Pure module: no I/O imports (ARCHITECTURE §2.1)." },
];

export default [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "docs/stress-test/**", "playwright-report/**", "supabase/.temp/**"] },
  {
    files: ["lib/engine/**/*.ts", "lib/isoweek/**/*.ts", "lib/outcomes/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: pureForbidden }] },
  },
  {
    files: ["lib/upload/**/*.ts"],
    ignores: ["lib/upload/server.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["@/lib/zoho*", "@/lib/llm*", "@/lib/db*", "@supabase/*"], message: "Upload parsing/validation is pure (ARCHITECTURE §2.1)." }] }] },
  },
  {
    files: ["lib/llm/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["@/lib/zoho*"], message: "lib/llm must not import lib/zoho." }] }] },
  },
];
