import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { avRailEnabled } from "@/lib/av-launch";
import { AvApiError, avApiConfigured, avCreateRedirectPath, avPutMappings } from "@/lib/av-api";
import { AV_PATH_RE, avRedirectCatalog, avSites, invalidateAvRedirects, resolveAvDestination } from "@/lib/av-destination";
import { avChatUrl } from "@/lib/av-link";

export const runtime = "nodejs";
// The target goes through the destination resolver, whose slowest verdict (a subdomain that has to
// be asked whether it is a chat host) is bounded by 29 s on top of the ActiveView API calls.
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Surface an ActiveView API failure with its own mapped status (5xx stays 5xx, everything else is a
 *  502 — the buyer can't fix ActiveView's config). */
function surfaceAv(e: unknown): NextResponse {
  const err = e as AvApiError;
  const status = err instanceof AvApiError ? (err.status >= 500 ? err.status : 502) : 502;
  return NextResponse.json({ ok: false, error: err.message ?? String(e) }, { status });
}

/**
 * POST /api/av/redirect-paths  — body { domainId, path, targetUrl }
 *
 * Creates a NEW redirect path on one of AV's redirect domains, pointing 100% at a target ARTICLE of
 * the same site: AV then merges our tracking params into that article and can re-weight targets in
 * ActiveView without touching the ad. Two API calls — POST …/path (creates the path with the
 * article as its fallback) then PUT …/mappings (the 100% weight). A path is only creatable while its
 * domain is LIVE (resolves + answers); today the redirect domain is not, so the card offers this
 * only when the domain is live.
 *
 * If the mapping PUT fails after the path was created, the path exists (with its fallback) and we
 * say so (502 + `created`) rather than pretend it didn't happen.
 */
export async function POST(req: Request) {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!avRailEnabled()) return bad("av_rail_disabled", 404);
  if (!avApiConfigured()) return bad("av_not_configured — AV_API_KEY is not set on the server", 500);

  let domainId = "";
  let path = "";
  let targetUrl = "";
  try {
    const j = (await req.json()) as { domainId?: unknown; path?: unknown; targetUrl?: unknown };
    domainId = String(j.domainId ?? "").trim();
    path = String(j.path ?? "").trim().toLowerCase().replace(/^\/+/, "");
    targetUrl = String(j.targetUrl ?? "").trim();
  } catch {
    return bad("bad_json");
  }
  if (!domainId) return bad("domain_required — pick a redirect domain");
  // The slug the buyer types: lower-case letters/digits/dashes, 2–60 chars, no leading slash (we add
  // it) — the same shape lib/av-destination validates a picked path against.
  if (!AV_PATH_RE.test(path)) {
    return bad("path_invalid — a redirect path is lower-case letters, digits and dashes (2–60 chars), no leading slash");
  }
  // A chat is never a target here — said by its address alone, before its host is asked anything.
  if (avChatUrl(targetUrl).ok) return bad("target_invalid — the redirect target must be an article, not a chat");

  // The domain must be one of OUR redirect domains (a domain of a site this API key reaches) and it
  // must be LIVE — a path on a domain whose activation is unfinished would never route.
  let sites;
  try {
    sites = await avSites();
  } catch (e) {
    return surfaceAv(e);
  }
  let catalog;
  try {
    catalog = await avRedirectCatalog(sites);
  } catch (e) {
    return surfaceAv(e);
  }
  const rd = catalog.find((r) => r.domainId === domainId);
  if (!rd) return bad("domain_unknown — that redirect domain is not one of ours");
  if (!rd.live) return bad(`redirect_not_live — ${rd.liveReason ?? `${rd.domain} is not live yet — finish the Redirect activation in ActiveView`}`);
  const fullPath = `/${path}`;
  if (rd.paths.some((p) => p.path === fullPath)) {
    return bad(`redirect_path_exists — ${rd.domain}${fullPath} already exists`);
  }

  // The target must resolve as an ARTICLE of the SAME site as the redirect domain (a redirect path
  // pointing at another site — or at a redirect path, or at a chat — is not a thing AV can weight
  // for us: its mappings were only ever read as articles).
  const target = await resolveAvDestination(targetUrl);
  if (!target.ok) return bad(`target_invalid — ${target.error}`, target.status);
  if (target.kind !== "article") {
    return bad(`target_invalid — the redirect target must be an article, not a ${target.kind === "chat" ? "chat" : "redirect path"}`);
  }
  if (target.site !== rd.site) {
    return bad(`target_invalid — the target must be an article of ${rd.site} (the redirect domain's site)`);
  }

  // 1) create the path (the article rides along as its fallback URL).
  let created;
  try {
    created = await avCreateRedirectPath(domainId, { path: fullPath, fallback: target.base });
  } catch (e) {
    return surfaceAv(e);
  }
  if (!created.id) {
    return NextResponse.json({ ok: false, error: "av_upstream — ActiveView created no path id" }, { status: 502 });
  }
  const createdPath = created.path || fullPath;
  const url = `https://${rd.domain}${createdPath}`;

  // 2) set the single 100% mapping to the article. If THIS fails, the path already exists with its
  // fallback — report it (502 + created) so the buyer knows the path is there and only the weight
  // needs setting in ActiveView, instead of retrying a create that would 400 (path_exists).
  try {
    const mappings = await avPutMappings(created.id, [{ url: target.base, percentage: 100 }]);
    invalidateAvRedirects(); // a new path now exists — drop the redirect list cache
    return NextResponse.json({ ok: true, path: { id: created.id, path: createdPath, url, mappings } });
  } catch (e) {
    invalidateAvRedirects(); // the path exists even though its weight didn't stick
    const err = e as AvApiError;
    return NextResponse.json(
      {
        ok: false,
        error: `redirect_mappings_failed — ${rd.domain}${createdPath} was created with its fallback, but setting the 100% mapping failed (${err.message ?? String(e)}); set the weight in ActiveView`,
        created: { id: created.id, url },
      },
      { status: 502 },
    );
  }
}
