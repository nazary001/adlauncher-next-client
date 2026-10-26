// DE Postback (pb.gctracking.xyz) — the tracking link every VC launch points its ad at (owner ask 26.10:
// "интегрируй это в наш лаунчер в VC партнера для гло 1 команды при запусках").
//
// How it works (the service's docs, 26.10): we send the landingpage link exactly as VC prints it and get
// back a tracking link on the link domain (trackwow3.xyz):
//   https://trackwow3.xyz/r/<link_id>?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}
// That URL goes into the ad AS IS — Meta fills the macros. A click is logged (campaign, ad set, ad,
// placement, fbclid) and 302'd to the landingpage with `click_id=<our click id>` (everything Meta appends,
// fbclid included, passes through untouched — VC's own CAPI Purchase still matches by it). DE posts its
// conversions back by click_id, and GET /api/v1/pb/revenue splits the revenue per campaign / ad set / ad.
// The create call is idempotent per landingpage link (201 new / 200 the same link again), so the route
// asks on every launch. The token reads the revenue too — server env only (VC_PB_TOKEN), never sent to
// a browser.
// Dependency-free, so `node --test` runs it bare; the fetch is injectable.

export const VC_PB_DEFAULT_BASE = "https://pb.gctracking.xyz";
/** The Meta macros the tracking link must carry — without them a click lands with no campaign. */
export const VC_PB_MACROS = ["{{campaign.id}}", "{{adset.id}}", "{{ad.id}}"] as const;

export type VcPbConfig = { base: string; token: string };

/** The service config from env: VC_PB_TOKEN (required — none = off) and VC_PB_BASE (the bench's mock). */
export function vcPbConfig(env: Record<string, string | undefined> = process.env): VcPbConfig | null {
  const token = String(env.VC_PB_TOKEN ?? "").trim();
  if (!token) return null;
  const base = (String(env.VC_PB_BASE ?? "").trim() || VC_PB_DEFAULT_BASE).replace(/\/+$/, "");
  return { base, token };
}

/** The tracking link's own label (the service keeps the FIRST one sent for a landingpage): "VC · <quiz-slug>-<id>". */
export function vcPbLinkName(landingUrl: string): string {
  let tail = "";
  try {
    tail = new URL(landingUrl).pathname.replace(/^\/coa\//, "").replace(/\/+$/, "");
  } catch {
    /* the route only ever passes a validated link */
  }
  return `VC · ${tail || "landingpage"}`;
}

export type VcPbLink = { linkId: string; trackingUrl: string; created: boolean };
/** `status` = the HTTP status the launch route answers with: 400 a config verdict, 502 the service. */
export type VcPbResult = { ok: true; link: VcPbLink } | { ok: false; error: string; status: number };

export type VcPbOptions = {
  fetch?: typeof fetch;
  /** Per attempt. */
  timeoutMs?: number;
  /** Pause before the one retry of a 5xx / network error. */
  retryDelayMs?: number;
};

const sameUrl = (a: string, b: string): boolean => {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return false;
  }
};

/** Read a 200/201 answer: a usable tracking link for exactly `target`, or why not. */
function linkOf(body: unknown, target: string, created: boolean): VcPbResult {
  const bad = (why: string): VcPbResult => ({ ok: false, status: 502, error: `pb_link_invalid — DE Postback answered without a usable tracking link (${why})` });
  const o = (body ?? {}) as { status?: unknown; link?: Record<string, unknown> };
  if (o.status !== "OK" || !o.link || typeof o.link !== "object") return bad("no link in the answer");
  const linkId = String(o.link.link_id ?? "").trim();
  const trackingUrl = String(o.link.tracking_url ?? "").trim();
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(linkId)) return bad("no link_id");
  let u: URL;
  try {
    u = new URL(trackingUrl);
  } catch {
    return bad("tracking_url is not a link");
  }
  if (u.protocol !== "https:") return bad("tracking_url is not https");
  if (!u.pathname.split("/").includes(linkId)) return bad("tracking_url is not this link's");
  const missing = VC_PB_MACROS.filter((m) => !trackingUrl.includes(m));
  if (missing.length) return bad(`tracking_url lacks ${missing.join(", ")}`);
  const echoed = String(o.link.target_url ?? "");
  if (echoed && !sameUrl(echoed, target)) {
    return { ok: false, status: 502, error: `pb_link_mismatch — DE Postback returned a link to ${echoed}, not ${target}` };
  }
  return { ok: true, link: { linkId, trackingUrl, created } };
}

/**
 * Make (or find — the service answers the same link again) the DE Postback tracking link for a VC
 * landingpage. One retry for a 5xx / network error / timeout; a refusal (400) or a rejected token
 * (401/403) is final. The verdict's error is `code — text`, the launch route's refusal as is.
 */
export async function vcPbEnsureLink(cfg: VcPbConfig, target: string, name: string, opts: VcPbOptions = {}): Promise<VcPbResult> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retryDelayMs = opts.retryDelayMs ?? 750;
  const host = (() => {
    try {
      return new URL(cfg.base).host;
    } catch {
      return cfg.base;
    }
  })();
  let last: VcPbResult = { ok: false, status: 502, error: `pb_unreachable — DE Postback (${host}) did not answer` };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${cfg.base}/api/v1/pb/links`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ url: target, name }),
        signal: ctl.signal,
        cache: "no-store",
      });
      text = await res.text();
    } catch (e) {
      const why = ctl.signal.aborted
        ? `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`
        : String((e as Error)?.message ?? e);
      last = { ok: false, status: 502, error: `pb_unreachable — DE Postback (${host}) did not answer: ${why}` };
      continue;
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON — judged below */
    }
    const said = String((body as { error?: unknown } | null)?.error ?? "").trim() || text.slice(0, 160).trim() || res.statusText;
    if (res.status === 200 || res.status === 201) return linkOf(body, target, res.status === 201);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 400, error: `pb_token_rejected — DE Postback refused the server's token (VC_PB_TOKEN): ${said}` };
    }
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, status: 400, error: `pb_link_refused — DE Postback refused the landingpage link: ${said}` };
    }
    last = { ok: false, status: 502, error: `pb_failed — HTTP ${res.status} from DE Postback (${host}): ${said}` };
  }
  return last;
}
