import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Needs Docker + the local Supabase (`npx supabase start`). The global setup resets the database.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/mocks/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    environment: "node",
    // Never call the real Claude API from tests, even if a key is set in the shell.
    env: { ANTHROPIC_API_KEY: "" },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
