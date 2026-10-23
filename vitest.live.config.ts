import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// ZO-13: the Zoho TEST-org scope check. Opt-in: set ZOHO_LIVE=1, then `npm run test:zoho-live` (reads .env.local).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["tests/live/**/*.live.test.ts"], environment: "node", fileParallelism: false, testTimeout: 60_000, env: loadEnvLocal() },
});

function loadEnvLocal(): Record<string, string> {
  try {
    const lines = readFileSync(".env.local", "utf8").split(/\r?\n/);
    return Object.fromEntries(
      lines
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\s+#.*$/, "")]),
    );
  } catch {
    return {};
  }
}
