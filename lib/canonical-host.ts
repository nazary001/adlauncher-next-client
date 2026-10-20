// Every Vercel deployment keeps its own URL for ever (…-<hash>-tools-8865s-projects.vercel.app) and
// that URL always serves THAT build. Opened from a bookmark, the browser history or the Vercel
// dashboard, it shows an old launcher as if it were the live one (owner 20.10 on the GLO-02 build of
// 08.10: no Team logins, "но обнова выкачена"). So a production page opened on a vercel.app host is
// sent to the team's real site (ADL_SELF_ORIGIN). Builds from here on do this; older deployment URLs
// still show their own old build.
//
// Pure and import-free: proxy.ts applies it, `node --test` covers it.

export type CanonicalInput = {
  /** The request's Host header. */
  host: string | null | undefined;
  pathname: string;
  search: string;
  method: string;
  /** ADL_SELF_ORIGIN — the team's real site. */
  selfOrigin: string | null | undefined;
  /** VERCEL_ENV — only "production" redirects (previews keep their own URL). */
  vercelEnv: string | null | undefined;
};

const hostOnly = (h: string): string => h.trim().toLowerCase().replace(/:\d+$/, "");

/**
 * Where a page request should go instead, or null to serve it here. Only GET / HEAD page loads on a
 * vercel.app host of a production build, and only when the real site is another host — APIs (Vercel
 * Cron, the queue's self-kicks, Blob callbacks), framework files and POSTs are never touched.
 */
export function canonicalRedirectUrl(input: CanonicalInput): string | null {
  if (input.vercelEnv !== "production") return null;
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  const path = input.pathname || "/";
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/_next/")) return null;
  const host = hostOnly(String(input.host ?? ""));
  if (!host.endsWith(".vercel.app")) return null;
  let origin: URL;
  try {
    origin = new URL(String(input.selfOrigin ?? "").trim());
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  if (hostOnly(origin.host) === host) return null;
  return `${origin.origin}${path}${input.search ?? ""}`;
}
