import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build stamp, inlined into BOTH the client bundle and the server of the same build. A tab
  // whose inlined stamp differs from the one the server answers with (GET /api/acct-limit) was
  // opened before a deploy. Since 10.11.2026 such a tab is only OFFERED the update — a small notice,
  // it keeps launching, the new bundle arrives with its next reload; launching locks only when the
  // deploy raised the wire level (lib/build-update WIRE_LEVEL). Before that every deploy locked every
  // open tab until it reloaded (a rule from the 80-error wave of 2026-08-18, sent by a tab whose
  // bundle had none of the new limit gates) — and a reload empties the board.
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
