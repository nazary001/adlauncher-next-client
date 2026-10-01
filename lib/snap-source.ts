// Snapchat cloner — the READ side, pure: Snap's envelopes for ONE live campaign (campaign → ad
// squads → ads → creatives → media) folded into the clone SOURCE the board drafts from
// (snapCloneDraft in lib/snap-launch.ts maps it onto the launcher's vocabulary). Structural only —
// no vocabulary, no network, no runtime imports — so `node --test tests/snap-source.test.ts` loads it
// straight off Node's type stripping. Shapes probed read-only on a real launcher campaign
// 01.10.2026: the media object carries `download_link` — a public, un-signed storage URL of the
// ORIGINAL file (HTTP 200 without auth, Content-Length = file_size_in_bytes) — which is what lets a
// clone re-host a creative on ANOTHER ad account; on the same account the media id is simply reused.

export type SnapSourceMedia = {
  id: string;
  accountId: string;
  /** "" = a media type the launcher cannot carry (lens, …). */
  kind: "video" | "image" | "";
  /** The buyer's file name ("clip.mp4"), else Snap's stored one. */
  name: string;
  /** Snap's stored file name ("e02b114d-….mp4") — the extension a bare display name lacks. */
  fileName: string;
  /** Public https link to the original file ("" when Snap gave none). */
  downloadUrl: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  /** Seconds, one decimal; null for an image. */
  durationSec: number | null;
  ready: boolean;
};

export type SnapSourceAd = {
  adId: string;
  adName: string;
  adStatus: string;
  squadId: string;
  /** Snap's moderation verdict on the ad: APPROVED / PENDING / REJECTED ("" unknown). */
  review: string;
  reviewReasons: string[];
  creativeId: string;
  /** WEB_VIEW is what the launcher builds; "" = the creative could not be read. */
  creativeType: string;
  headline: string;
  brandName: string;
  cta: string;
  profileId: string;
  /** The ad's web-view URL as it runs (with the source's utm tags). */
  url: string;
  media: SnapSourceMedia | null;
  /** Why the media is missing ("" when it is there). */
  mediaError: string;
};

export type SnapSourceSquad = {
  id: string;
  name: string;
  status: string;
  deliveryConstraint: string;
  dailyBudgetMicro: number | null;
  lifetimeBudgetMicro: number | null;
  bidStrategy: string;
  bidMicro: number | null;
  goal: string;
  pixelId: string;
  /** ISO-2, upper-cased, in Snap's order, deduped. */
  countries: string[];
  /** A geo entry narrows a country (region / metro / postal code) — the clone targets whole countries. */
  subCountryGeo: boolean;
  minAge: string;
  maxAge: string;
  gender: string;
  languages: string[];
  /** os_type of every device entry (Snap's spelling: ANDROID / iOS / WEB). */
  deviceOs: string[];
  /** A device entry also narrows OS version / make / carrier / connection. */
  deviceDetails: boolean;
  /** Targeting keys beyond geo / age / devices (interests, segments, locations, …) — not carried. */
  extraTargeting: string[];
};

export type SnapCloneSource = {
  campaignId: string;
  name: string;
  adAccountId: string;
  status: string;
  delivery: string[];
  createdAt: string;
  /** objective_v2_type (AWARENESS_AND_ENGAGEMENT / SALES / TRAFFIC / …). */
  objective: string;
  /** Snap stamped the objective itself (the launcher sent none). */
  objectiveAuto: boolean;
  /** The ad squad the clone copies: the one carrying the most ads. */
  squad: SnapSourceSquad | null;
  squadCount: number;
  /** Ads under the OTHER ad squads (not cloned — the launcher builds one ad squad per campaign). */
  otherSquadAds: number;
  /** The leading squad's ads in the card's "#N" order. */
  ads: SnapSourceAd[];
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The SUCCESS entities of one Snap envelope `{<plural>:[{sub_request_status, <singular>:{…}}]}`. */
export function snapEnvelopeEntities(body: unknown, plural: string): Rec[] {
  const singular = plural === "media" ? "media" : plural.replace(/s$/, "");
  return list(rec(body)[plural])
    .map(rec)
    .filter((item) => !item.sub_request_status || str(item.sub_request_status).toUpperCase() === "SUCCESS")
    .map((item) => rec(item[singular]))
    .filter((e) => str(e.id));
}

export function parseSnapSourceMedia(m: Rec): SnapSourceMedia {
  const type = str(m.type).toUpperCase();
  const meta = rec(type === "IMAGE" ? m.image_metadata : m.video_metadata);
  const link = str(m.download_link);
  const duration = num(m.duration_in_seconds);
  return {
    id: str(m.id),
    accountId: str(m.ad_account_id),
    kind: type === "VIDEO" ? "video" : type === "IMAGE" ? "image" : "",
    name: str(m.name) || str(m.file_name),
    fileName: str(m.file_name),
    // https on Snap; a loopback http link only ever comes from the local mock (the wave refuses it on prod).
    downloadUrl: /^https:\/\/\S+$/i.test(link) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/\S*$/i.test(link) ? link : "",
    sizeBytes: num(m.file_size_in_bytes),
    width: num(meta.width_px),
    height: num(meta.height_px),
    durationSec: type === "IMAGE" || duration == null ? null : Math.round(duration * 10) / 10,
    ready: str(m.media_status).toUpperCase() === "READY",
  };
}

/** Snap's own targeting defaults / flags — present on every ad squad, nothing a clone loses. */
const TARGETING_KNOWN = new Set(["geos", "demographics", "devices", "regulated_content", "enable_targeting_expansion", "auto_expansion_options"]);

function parseSquad(q: Rec): SnapSourceSquad {
  const t = rec(q.targeting);
  const geos = list(t.geos).map(rec);
  const countries = [...new Set(geos.map((g) => str(g.country_code).toUpperCase()).filter(Boolean))];
  const subCountryGeo = geos.some((g) => Object.keys(g).some((k) => k !== "country_code" && k !== "operation" && list(g[k]).length + (typeof g[k] === "string" && g[k] ? 1 : 0) > 0));
  const demo = rec(list(t.demographics)[0]);
  const devices = list(t.devices).map(rec);
  return {
    id: str(q.id),
    name: str(q.name),
    status: str(q.status),
    deliveryConstraint: str(q.delivery_constraint),
    dailyBudgetMicro: num(q.daily_budget_micro),
    lifetimeBudgetMicro: num(q.lifetime_budget_micro),
    bidStrategy: str(q.bid_strategy),
    bidMicro: num(q.bid_micro),
    goal: str(q.optimization_goal),
    pixelId: str(q.pixel_id),
    countries,
    subCountryGeo,
    minAge: str(demo.min_age),
    maxAge: str(demo.max_age),
    gender: str(demo.gender),
    languages: list(demo.languages).map(str).filter(Boolean),
    deviceOs: [...new Set(devices.map((d) => str(d.os_type)).filter(Boolean))],
    deviceDetails: devices.some((d) => Object.keys(d).some((k) => k !== "os_type" && k !== "operation" && d[k] != null && d[k] !== "")),
    extraTargeting: Object.keys(t).filter((k) => !TARGETING_KNOWN.has(k) && (list(t[k]).length > 0 || (t[k] && typeof t[k] === "object" && !Array.isArray(t[k])))),
  };
}

/** "#N" at the end of a launcher ad name = the creative's place on the card (1-based); null otherwise. */
const adNumber = (name: string): number | null => {
  const m = /\s#(\d{1,3})$/.exec(name);
  return m ? Number(m[1]) : null;
};

export function buildSnapCloneSource(input: {
  campaign: Rec;
  squads: Rec[];
  ads: Rec[];
  creatives: Map<string, Rec>;
  /** media id → entity, or `{ error }` when it could not be read. */
  media: Map<string, Rec | { error: string }>;
}): SnapCloneSource {
  const c = input.campaign;
  const objective = rec(c.objective_v2_properties);
  const adsBySquad = new Map<string, Rec[]>();
  for (const a of input.ads) {
    const sq = str(a.ad_squad_id);
    adsBySquad.set(sq, [...(adsBySquad.get(sq) ?? []), a]);
  }
  // The squad the clone copies: the one with the most ads (ties → the older one) — a launcher
  // campaign has exactly one; a campaign reshaped in Ads Manager may carry more.
  const squads = [...input.squads].sort((x, y) => {
    const d = (adsBySquad.get(str(y.id))?.length ?? 0) - (adsBySquad.get(str(x.id))?.length ?? 0);
    return d !== 0 ? d : str(x.created_at).localeCompare(str(y.created_at));
  });
  const lead = squads[0] ?? null;
  const leadAds = lead ? (adsBySquad.get(str(lead.id)) ?? []) : [];
  const ordered = leadAds
    .map((a, i) => ({ a, n: adNumber(str(a.name)), at: str(a.created_at), i }))
    .sort((x, y) => {
      if (x.n != null && y.n != null) return x.n - y.n;
      if (x.n != null) return -1;
      if (y.n != null) return 1;
      return x.at.localeCompare(y.at) || x.i - y.i;
    })
    .map((x) => x.a);
  const ads: SnapSourceAd[] = ordered.map((a) => {
    const creativeId = str(a.creative_id);
    const cr = input.creatives.get(creativeId);
    const crRec = rec(cr);
    const mediaId = str(crRec.top_snap_media_id);
    const m = mediaId ? input.media.get(mediaId) : undefined;
    const mediaErr = m && "error" in m ? str((m as { error: unknown }).error) : "";
    const media = m && !("error" in m) ? parseSnapSourceMedia(m as Rec) : null;
    return {
      adId: str(a.id),
      adName: str(a.name),
      adStatus: str(a.status),
      squadId: str(a.ad_squad_id),
      review: str(a.review_status).toUpperCase(),
      reviewReasons: list(a.review_status_reasons).map(str).filter(Boolean),
      creativeId,
      creativeType: str(crRec.type).toUpperCase(),
      headline: str(crRec.headline),
      brandName: str(crRec.brand_name),
      cta: str(crRec.call_to_action),
      profileId: str(rec(crRec.profile_properties).profile_id),
      url: str(rec(crRec.web_view_properties).url),
      media,
      mediaError: !cr ? `creative ${creativeId} could not be read` : media ? "" : mediaErr || (mediaId ? `media ${mediaId} could not be read` : "the creative carries no top-snap media"),
    };
  });
  return {
    campaignId: str(c.id),
    name: str(c.name),
    adAccountId: str(c.ad_account_id),
    status: str(c.status),
    delivery: list(c.delivery_status).map(str).filter(Boolean),
    createdAt: str(c.created_at),
    objective: str(objective.objective_v2_type).toUpperCase(),
    objectiveAuto: objective.is_auto_generated === true,
    squad: lead ? parseSquad(lead) : null,
    squadCount: input.squads.length,
    otherSquadAds: input.ads.length - leadAds.length,
    ads,
  };
}
