import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Proxy buffers request bodies (default 10MB); raise it so any proxied route can accept
    // larger payloads. /api/launch (the big video upload) is also excluded from the proxy.
    proxyClientMaxBodySize: "30mb",
  },
};

export default nextConfig;
