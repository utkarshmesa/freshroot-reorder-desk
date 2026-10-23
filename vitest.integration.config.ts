import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Needs a local Supabase: `npx supabase start` then `npx supabase db reset`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
