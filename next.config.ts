import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Uploads go to Supabase Storage first; server actions only receive small payloads.
  serverExternalPackages: ["xlsx"],
};

export default nextConfig;
