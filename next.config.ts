import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploads go to Supabase Storage first; server actions only receive small payloads.
  serverExternalPackages: ["xlsx"],
  // The Instructions screen reads docs/INSTRUCTIONS.md at request time; ship it with that function.
  outputFileTracingIncludes: { "/instructions": ["./docs/INSTRUCTIONS.md"] },
};

export default nextConfig;
