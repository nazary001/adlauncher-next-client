import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build stamp, inlined into BOTH the client bundle and the server of the same build. A tab
  // whose inlined stamp differs from the one the server answers with is running a STALE bundle
  // (opened before a deploy) — its launch gates are outdated, so the client blocks launching
  // and demands a reload (the 80-error Katya wave, 2026-08-18, came from exactly such a tab).
  env: {
    NEXT_PUBLIC_BUILD_STAMP: new Date().toISOString(),
  },
  experimental: {
    // Proxy buffers request bodies (default 10MB); raise it so any proxied route can accept
    // larger payloads. /api/launch (the big video upload) is also excluded from the proxy.
    proxyClientMaxBodySize: "30mb",
  },
};

export default nextConfig;
