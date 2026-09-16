// A dependency-free fake of the Snapchat Marketing API (+ its OAuth host + the business host) for
// the Snap-rail route smoke (_e2e/_adl_snap_smoke.mts). Point the app at it with
//   SNAP_API_BASE=http://127.0.0.1:3198/v1  SNAP_AUTH_BASE=http://127.0.0.1:3198
//   SNAP_BUSINESS_API_BASE=http://127.0.0.1:3198/business/v1
//   SNAP_CLIENT_ID=x SNAP_CLIENT_SECRET=x SNAP_REFRESH_TOKEN=x  (any non-empty values)
// It mirrors the documented contract (docs read 16.09.2026): batch envelopes
// {campaigns:[…]} → {request_status, campaigns:[{sub_request_status, campaign}]}, errors as HTTP
// 4xx with request_status:"ERROR" + display_message/debug_message, media PENDING_UPLOAD → READY,
// Public Profile REQUIRED on creatives, whole-object campaign PUT.
//
//   node _e2e/_snap_mock.mjs            # PORT 3198, MEDIA_DELAY_MS 1500
// Test hooks: GET /__mock/state, POST /__mock/reset, GET /__mock/media/sample.(mp4|jpg).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3198);
const MEDIA_DELAY_MS = Number(process.env.MEDIA_DELAY_MS || 1500);

const ORG = { id: "org-mock-1", name: "GlobeCoders (mock)", type: "ENTERPRISE" };
const ACCOUNTS = [
  { id: "acct-mock-a", name: "GC Snap USD 1", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organization_id: ORG.id },
  { id: "acct-mock-b", name: "GC Snap USD 2", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organization_id: ORG.id },
];
const PIXELS = {
  "acct-mock-a": [{ id: "px-mock-a1", name: "GC Pixel A", status: "ACTIVE" }],
  "acct-mock-b": [
    { id: "px-mock-b1", name: "GC Pixel B1", status: "ACTIVE" },
    { id: "px-mock-b2", name: "GC Pixel B2", status: "ACTIVE" },
  ],
};
const PROFILES = [{ id: "prof-mock-1", display_name: "GC (mock)", profile_type: "PUBLIC_PROFILE", organization_id: ORG.id }];
const STRATEGIES = new Set(["AUTO_BID", "LOWEST_COST_WITH_MAX_BID", "TARGET_COST"]);
const GOALS = new Set(["PIXEL_PURCHASE", "PIXEL_PAGE_VIEW", "LANDING_PAGE_VIEW", "SWIPES", "IMPRESSIONS"]);
const SAMPLE_BYTES = Buffer.alloc(4096, 7);

const fresh = () => ({ media: new Map(), campaigns: new Map(), adsquads: new Map(), creatives: new Map(), ads: new Map(), tokens: 0, uploads: 0 });
let state = fresh();

const send = (res, status, obj) => {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const err = (res, status, msg, code = "E1000") => send(res, status, { request_status: "ERROR", request_id: randomUUID(), display_message: msg, debug_message: msg, error_code: code });
const okOne = (res, key, singular, entity) => send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), [key]: [{ sub_request_status: "SUCCESS", [singular]: entity }] });
const okMany = (res, key, singular, entities) => send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), [key]: entities.map((e) => ({ sub_request_status: "SUCCESS", [singular]: e })) });
const readRaw = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
const readJson = async (req) => { try { return JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { return {}; } };
const first = (body, key) => (Array.isArray(body?.[key]) ? body[key][0] ?? {} : {});
const str = (v) => (v == null ? "" : String(v));
const isoOk = (v) => !Number.isNaN(Date.parse(str(v)));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";
  console.log(`${new Date().toISOString()} ${method} ${req.url}`);

  // ---- hooks ----
  if (path === "/__mock/state" && method === "GET") {
    return send(res, 200, {
      uploads: state.uploads,
      tokens: state.tokens,
      media: [...state.media.values()],
      campaigns: [...state.campaigns.values()],
      adsquads: [...state.adsquads.values()],
      creatives: [...state.creatives.values()],
      ads: [...state.ads.values()],
    });
  }
  if (path === "/__mock/reset" && method === "POST") {
    state = fresh();
    return send(res, 200, { ok: true });
  }
  if (path.startsWith("/__mock/media/") && method === "GET") {
    const mp4 = path.endsWith(".mp4");
    res.writeHead(200, { "content-type": mp4 ? "video/mp4" : "image/jpeg", "content-length": SAMPLE_BYTES.length });
    return res.end(SAMPLE_BYTES);
  }

  // ---- OAuth host ----
  if (path === "/login/oauth2/access_token" && method === "POST") {
    const form = new URLSearchParams((await readRaw(req)).toString("utf8"));
    const grant = form.get("grant_type");
    if (!form.get("client_id") || !form.get("client_secret")) return send(res, 400, { error: "invalid_client" });
    if (grant === "refresh_token" && form.get("refresh_token")) {
      state.tokens += 1;
      return send(res, 200, { access_token: `mock-access-${state.tokens}`, expires_in: 3600, token_type: "Bearer", refresh_token: form.get("refresh_token"), scope: "snapchat-marketing-api" });
    }
    if (grant === "authorization_code" && form.get("code")) {
      state.tokens += 1;
      return send(res, 200, { access_token: `mock-access-${state.tokens}`, expires_in: 3600, token_type: "Bearer", refresh_token: "mock-refresh-from-code", scope: "snapchat-marketing-api" });
    }
    return send(res, 400, { error: "invalid_grant" });
  }
  if (path === "/login/oauth2/authorize" && method === "GET") {
    return send(res, 200, { note: "mock consent page", redirect: `${url.searchParams.get("redirect_uri")}?code=mock-code&state=${url.searchParams.get("state")}` });
  }

  // ---- everything else needs the bearer ----
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return err(res, 401, "Unauthorized", "E401");

  // ---- business host ----
  let m = path.match(/^\/business\/v1\/organizations\/([^/]+)\/public_profiles$/);
  if (m && method === "GET") {
    if (m[1] !== ORG.id) return err(res, 404, "organization not found", "E404");
    return send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), public_profiles: PROFILES.map((p) => ({ sub_request_status: "SUCCESS", public_profile: p })), paging: {} });
  }

  // ---- ads host: reads ----
  if (path === "/v1/me/organizations" && method === "GET") {
    const withAccounts = url.searchParams.get("with_ad_accounts") === "true";
    return send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), organizations: [{ sub_request_status: "SUCCESS", organization: { ...ORG, ...(withAccounts ? { ad_accounts: ACCOUNTS } : {}) } }] });
  }
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/pixels$/);
  if (m && method === "GET") {
    if (!PIXELS[m[1]]) return err(res, 404, "ad account not found", "E404");
    return okMany(res, "pixels", "pixel", PIXELS[m[1]]);
  }
  m = path.match(/^\/v1\/media\/([^/]+)$/);
  if (m && method === "GET") {
    const media = state.media.get(m[1]);
    if (!media) return err(res, 404, "media not found", "E404");
    if (media.media_status !== "READY" && media.uploaded_at && Date.now() - media.uploaded_at >= MEDIA_DELAY_MS) media.media_status = "READY";
    return okOne(res, "media", "media", media);
  }
  m = path.match(/^\/v1\/campaigns\/([^/]+)$/);
  if (m && method === "GET") {
    const c = state.campaigns.get(m[1]);
    return c ? okOne(res, "campaigns", "campaign", c) : err(res, 404, "campaign not found", "E404");
  }

  // ---- media ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/media$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "media");
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (body.type !== "VIDEO" && body.type !== "IMAGE") return err(res, 400, "media.type must be VIDEO or IMAGE");
    if (!str(body.name)) return err(res, 400, "media.name is required");
    const media = { id: `media-${randomUUID()}`, ad_account_id: m[1], name: body.name, type: body.type, media_status: "PENDING_UPLOAD", uploaded_at: null, bytes: 0, created_at: new Date().toISOString() };
    state.media.set(media.id, media);
    return okOne(res, "media", "media", media);
  }
  m = path.match(/^\/v1\/media\/([^/]+)\/upload$/);
  if (m && method === "POST") {
    const media = state.media.get(m[1]);
    if (!media) return err(res, 404, "media not found", "E404");
    if (!/multipart\/form-data/i.test(req.headers["content-type"] || "")) return err(res, 400, "upload must be multipart/form-data with a `file` field");
    const raw = await readRaw(req);
    if (raw.length === 0) return err(res, 400, "empty upload");
    media.bytes = raw.length;
    media.uploaded_at = Date.now();
    state.uploads += 1;
    return okOne(res, "media", "media", media);
  }

  // ---- campaigns ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/campaigns$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "campaigns");
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (!str(body.name)) return err(res, 400, "campaign.name is required");
    if (str(body.name).length > 375) return err(res, 400, "campaign.name must be at most 375 characters");
    if (body.ad_account_id !== m[1]) return err(res, 400, "campaign.ad_account_id must match the path");
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "campaign.status must be ACTIVE or PAUSED");
    if (!isoOk(body.start_time)) return err(res, 400, "campaign.start_time must be ISO-8601");
    const c = { id: `cmp-${randomUUID()}`, ...body, buy_model: body.buy_model || "AUCTION", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    state.campaigns.set(c.id, c);
    return okOne(res, "campaigns", "campaign", c);
  }
  if (m && method === "PUT") {
    const body = first(await readJson(req), "campaigns");
    const c = state.campaigns.get(str(body.id));
    if (!c) return err(res, 404, "campaign not found", "E404");
    for (const k of ["name", "ad_account_id", "status", "start_time"]) if (body[k] === undefined) return err(res, 400, `campaign.${k} is required on update (whole object)`);
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "campaign.status must be ACTIVE or PAUSED");
    Object.assign(c, body, { updated_at: new Date().toISOString() });
    return okOne(res, "campaigns", "campaign", c);
  }

  // ---- ad squads ----
  m = path.match(/^\/v1\/campaigns\/([^/]+)\/adsquads$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "adsquads");
    const c = state.campaigns.get(m[1]);
    if (!c) return err(res, 404, "campaign not found", "E404");
    if (str(body.name).includes("FAIL-ADSQUAD")) return err(res, 400, "Ad Squad refused by the mock (FAIL-ADSQUAD): daily_budget_micro below the account minimum");
    if (!str(body.name)) return err(res, 400, "adsquad.name is required");
    if (body.type !== "SNAP_ADS") return err(res, 400, "adsquad.type must be SNAP_ADS");
    if (!(Number(body.daily_budget_micro) >= 5_000_000)) return err(res, 400, "daily_budget_micro must be at least 5000000");
    if (!STRATEGIES.has(body.bid_strategy)) return err(res, 400, `bid_strategy must be one of ${[...STRATEGIES].join(", ")}`);
    if (body.bid_strategy !== "AUTO_BID" && !(Number(body.bid_micro) >= 10_000)) return err(res, 400, "bid_micro is required for this bid_strategy (min 10000)");
    if (body.bid_strategy === "AUTO_BID" && body.bid_micro != null) return err(res, 400, "bid_micro is not allowed with AUTO_BID");
    if (!GOALS.has(body.optimization_goal)) return err(res, 400, "unknown optimization_goal");
    if (!Array.isArray(body.targeting?.geos) || body.targeting.geos.length === 0) return err(res, 400, "targeting.geos must name at least one country");
    if (String(body.optimization_goal).startsWith("PIXEL_")) {
      const px = PIXELS[c.ad_account_id] || [];
      if (!body.pixel_id || !px.some((p) => p.id === body.pixel_id)) return err(res, 400, "pixel_id is required for a PIXEL_* optimization_goal and must belong to the ad account");
    }
    const sq = { id: `sq-${randomUUID()}`, ...body, campaign_id: c.id, created_at: new Date().toISOString() };
    state.adsquads.set(sq.id, sq);
    return okOne(res, "adsquads", "adsquad", sq);
  }

  // ---- creatives ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/creatives$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "creatives");
    if (str(body.name).includes("FAIL-NET")) return req.socket.destroy(); // the AMBIGUOUS path: no answer at all
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (body.type !== "WEB_VIEW") return err(res, 400, "creative.type must be WEB_VIEW");
    const headline = str(body.headline);
    if (!headline || headline.length > 34) return err(res, 400, "headline is required and at most 34 characters");
    if (str(body.brand_name).length > 32) return err(res, 400, "brand_name must be at most 32 characters");
    if (!PROFILES.some((p) => p.id === body.profile_properties?.profile_id)) return err(res, 400, "profile_properties.profile_id is required (a Public Profile of the organization)");
    const media = state.media.get(str(body.top_snap_media_id));
    if (!media) return err(res, 400, "top_snap_media_id not found");
    if (media.media_status !== "READY") return err(res, 400, "top_snap_media_id is not READY yet");
    if (!/^https:\/\//.test(str(body.web_view_properties?.url))) return err(res, 400, "web_view_properties.url must be https");
    const cr = { id: `cr-${randomUUID()}`, ...body, review_status: "PENDING_REVIEW", packaging_status: "PENDING", created_at: new Date().toISOString() };
    state.creatives.set(cr.id, cr);
    return okOne(res, "creatives", "creative", cr);
  }

  // ---- ads ----
  m = path.match(/^\/v1\/adsquads\/([^/]+)\/ads$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "ads");
    if (!state.adsquads.has(m[1])) return err(res, 404, "ad squad not found", "E404");
    if (!state.creatives.has(str(body.creative_id))) return err(res, 400, "creative_id not found");
    if (body.type !== "REMOTE_WEBPAGE") return err(res, 400, "ad.type must be REMOTE_WEBPAGE");
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "ad.status must be ACTIVE or PAUSED");
    const ad = { id: `ad-${randomUUID()}`, ...body, ad_squad_id: m[1], review_status: "PENDING", created_at: new Date().toISOString() };
    state.ads.set(ad.id, ad);
    return okOne(res, "ads", "ad", ad);
  }

  return err(res, 404, `no route for ${method} ${path}`, "E404");
});

server.listen(PORT, () => {
  console.log(`snapchat MOCK on http://127.0.0.1:${PORT}  (accounts=${ACCOUNTS.length}, MEDIA_DELAY_MS=${MEDIA_DELAY_MS})`);
});
