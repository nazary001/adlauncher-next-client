// Duplicating already-live campaigns. Buyers arrive from the stats tool via
//   /clone?partner=in&ids=<fbCampaignId>,<fbCampaignId>,...
// We hold ONLY the ids; every real value (name, geo, budget, bid, creatives, targeting) is
// pulled from Facebook by id. Phase 1 ships the UI against mock sources — `loadCloneSources`
// is the single seam the real `/api/clone/sources` fetch drops into later. Kept free of `Date`
// so it stays pure/testable; callers pass today's DD.MM in.

import type { PartnerId } from "./partners";

/** One creative on the source campaign. Clones reuse it by `videoId` (no re-upload). */
export type CloneCreative = {
  videoId: string;
  thumbUrl: string;
};

/** A live campaign pulled from Facebook — the read-only "original" side of a clone row. */
export type CloneSource = {
  campaignId: string;
  name: string;
  countries: string[];
  locales: string[];
  category: string;
  placement: string;
  ageMin: string;
  userOs: "all" | "android";
  /** Daily budget as a display string in major units ("10" / "10,00"). */
  originalBudget: string;
  /** The source's OWN bid in human units, meaning follows bidStrategy: a min-ROAS goal decimal
   *  ("1,20" = 120%) or a $ cap ("0,50"); "" = none (lowest cost) or unknown. Field name predates
   *  the cap case — every consumer renders it through bidKind(bidStrategy). */
  originalRoas: string;
  bidStrategy: string;
  objective: string;
  optimization: "conversions" | "clicks";
  conversionEvent: string;
  /** META ADX | HIGH ADX | #ADX — HIGH ADX reveals the High Offer config. */
  redirectType: string;
  creatives: CloneCreative[];
};

/** Placeholder shape for the High Offer config — finalized in phase 2. */
export type HighOfferConfig = {
  enabled: boolean;
  offerId: string;
  share: string;
};

/** The editable clone config layered on a source. Number of copies is global (settings). */
export type CloneRow = {
  id: string; // local row id (not a FB id)
  source: CloneSource;
  namePrefix: string; // fixed, non-editable prefix: "[DD.MM] (CLONE) - (tier) - "
  name: string; // editable remainder; full name = namePrefix + name
  countries: string[];
  locales: string[];
  category: string;
  placement: string;
  ageMin: string;
  roasGoal: string; // the "Bid" column — ROAS decimal or $ cap, by the SOURCE's bid strategy
  budget: string; // target daily budget, display string
  redirectType: string;
  highOffer: HighOfferConfig;
};

/** One clone to create, sent from the board to /api/clone/run (rows × copies flattened). Client-safe
 *  (no server deps) so both the board and the server builder share the shape. */
export type CloneEdit = {
  campaignId: string; // source FB campaign id to clone from
  name: string;
  budget: string;
  roasGoal: string;
  countries: string[];
  locales: string[];
  category: string;
  placement: string;
  ageMin: string;
  userOs: "all" | "android";
  /** The PICKED fanpage id the clone advertises with (from /api/fanpages; server-validated). */
  pageId: string;
  /** Target ad account (digits). Empty/absent = build in the SOURCE campaign's own account (the
   *  default). When set to a DIFFERENT account, the server re-uploads the source media there
   *  (video by its CDN source URL, image by adimages copy_from) before building the creative. */
  accountId?: string;
  /** The picked pixel of the TARGET account (required for conversion-optimized sources when
   *  accountId is set — the source's pixel usually isn't shared to other accounts). */
  pixelId?: string;
};

/** The account picker's explicit "build each clone in its source's own account" choice. A
 *  SENTINEL, not an id: the buyer must consciously pick it (or a concrete account) — an empty
 *  accountId means "not chosen yet" and blocks Duplicate. */
export const SOURCE_ACCOUNT = "source";

/** Global settings applied to every clone. The fanpage AND the account are EXPLICIT batch-wide
 *  picks — Duplicate stays locked until both are chosen. Account = SOURCE_ACCOUNT keeps every
 *  clone in its source campaign's own account with the source's pixel (media stays in its
 *  library); a concrete account re-uploads media there server-side and the clone optimizes for
 *  the picked pixel of that account. */
export type CloneSettings = {
  /** The PICKED fanpage (id) every clone in the batch advertises with. Empty = not picked yet. */
  pageId: string;
  /** Destination account: "" = NOT CHOSEN (blocks Duplicate), SOURCE_ACCOUNT, or account digits. */
  accountId: string;
  /** Pixel of the target account ("" = none picked; required while a concrete account is set). */
  pixelId: string;
  userOs: "all" | "android";
  copies: number;
};

export function defaultSettings(_partner: PartnerId): CloneSettings {
  return { pageId: "", accountId: "", pixelId: "", userOs: "all", copies: 1 };
}

/**
 * Split a source campaign name into the FIXED clone prefix (non-editable: today's date, the (CLONE)
 * marker, and the tier) and the EDITABLE remainder. E.g.
 *   "[05.08] - (t1) - [ES] - MKDIGITAL - Tima …"
 *   → { prefix: "[06.08] (CLONE) - (t1) - ", name: "[ES] - MKDIGITAL - Tima …" }
 */
export function splitCloneName(sourceName: string, ddmm: string): { prefix: string; name: string } {
  let s = (sourceName ?? "").trim();
  s = s.replace(/^\[[^\]]*\]\s*-?\s*/, ""); // drop the leading [date] and its separator
  s = s.replace(/^\(clone\)\s*-?\s*/i, ""); // drop a leading (CLONE) if the source is itself a clone
  const tierM = s.match(/^\(([^)]*)\)\s*-?\s*/); // capture + drop a leading (tier) like (t1)
  const tier = tierM ? tierM[1] : "";
  if (tierM) s = s.slice(tierM[0].length);
  // Slash date — same shape the launch prefixes moved to 2026-08-18 ("[18/08] (MO) - ").
  const d = ddmm.replace(".", "/");
  const prefix = tier ? `[${d}] (CLONE) - (${tier}) - ` : `[${d}] (CLONE) - `;
  return { prefix, name: s.trim() };
}

/** Full campaign name a clone is created with = fixed prefix + the editable remainder. */
export function fullCloneName(row: CloneRow): string {
  return `${row.namePrefix}${row.name}`;
}

/**
 * The owner tag a clone's name ends with by default: " - <Username>" (first letter capitalized to
 * match the team's naming convention — "Tima", "Nazar"). Blank/empty username → no tag.
 */
export function ownerTag(username?: string | null): string {
  const u = (username ?? "").trim();
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
}

/**
 * Append " - <Username>" to a clone's editable name so it defaults to whoever is making the clone.
 * Skips if the name already ends with that exact tag, so re-cloning your own clone doesn't stack
 * "- Nazar - Nazar".
 */
export function withOwner(name: string, username?: string | null): string {
  const tag = ownerTag(username);
  const base = (name ?? "").trim();
  if (!tag) return base;
  const suffix = ` - ${tag}`;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`;
}

/** Build an editable clone row from a fetched source, prefilled with the source's own values. The
 *  editable name defaults to end with " - <Username>" of whoever is making the clone. */
export function makeCloneRow(
  source: CloneSource,
  ddmm: string,
  rowId: string,
  username?: string | null,
): CloneRow {
  const { prefix, name } = splitCloneName(source.name, ddmm);
  return {
    id: rowId,
    source,
    namePrefix: prefix,
    name: withOwner(name, username),
    countries: [...source.countries],
    locales: [...source.locales],
    category: source.category,
    placement: source.placement,
    ageMin: source.ageMin,
    roasGoal: source.originalRoas,
    budget: source.originalBudget,
    redirectType: source.redirectType,
    highOffer: { enabled: source.redirectType === "HIGH ADX", offerId: "", share: "" },
  };
}

/** One resulting clone in the preview (each row is expanded into `copies` of these). */
export type ClonePreviewItem = {
  key: string;
  rowId: string;
  copyIndex: number; // 1..copies
  total: number;
  name: string;
  budget: string;
  roasGoal: string;
  /** The SOURCE's bid strategy — the preview labels the bid by its kind (ROAS / $ cap / auto). */
  bidStrategy: string;
  countries: string[];
};

/** Expand the rows into the flat list of clones a Duplicate run would create. */
export function flattenPreview(rows: CloneRow[], copies: number): ClonePreviewItem[] {
  const total = Math.max(1, Math.floor(copies) || 1);
  const out: ClonePreviewItem[] = [];
  for (const r of rows) {
    for (let k = 1; k <= total; k++) {
      out.push({
        key: `${r.id}-${k}`,
        rowId: r.id,
        copyIndex: k,
        total,
        // Must match the name the run actually creates (clone-board `duplicate()`): "<name> (k)" —
        // the preview would otherwise misrepresent what ships (was "<name> · k/total").
        name: total > 1 ? `${fullCloneName(r)} (${k})` : fullCloneName(r),
        budget: r.budget,
        roasGoal: r.roasGoal,
        bidStrategy: r.source.bidStrategy,
        countries: r.countries,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase-1 mock. Replaced in phase 2 by a real fetch — the signature stays identical.
// ---------------------------------------------------------------------------------------------

/** Sample campaign ids for the local "Load sample" button (when the page is opened with no ids). */
export const SAMPLE_IDS = ["120210000000101", "120210000000102", "120210000000103"];

// Strategies vary on purpose so "Load sample" exercises every bid-kind rendering (ROAS / $ cap /
// auto) the way real mixed selections do.
const MOCK_TEMPLATES = [
  { geo: ["WW"], budget: "10", roas: "0,40", strategy: "LOWEST_COST_WITH_MIN_ROAS", creatives: 2, redirect: "META ADX", tail: "GIFT - Digital-marketing es" },
  { geo: ["BR"], budget: "15", roas: "0,55", strategy: "LOWEST_COST_WITH_BID_CAP", creatives: 1, redirect: "HIGH ADX", tail: "LOAN - Personal loans en" },
  { geo: ["MX", "CO", "AR"], budget: "8", roas: "0,35", strategy: "LOWEST_COST_WITH_MIN_ROAS", creatives: 3, redirect: "#ADX", tail: "AUTO - Financiamiento es" },
  { geo: ["US"], budget: "20", roas: "", strategy: "LOWEST_COST_WITHOUT_CAP", creatives: 2, redirect: "META ADX", tail: "HEALTH - Retiree coverage en" },
];

function mockSource(campaignId: string, i: number): CloneSource {
  const t = MOCK_TEMPLATES[i % MOCK_TEMPLATES.length];
  const geoLabel = t.geo[0] === "WW" ? "WORLD" : t.geo.join("/");
  const redirectLabel = t.redirect === "HIGH ADX" ? "#ADX [HIGH]" : t.redirect;
  return {
    campaignId,
    name: `[05/08] (GLO-01) API - (${redirectLabel}) - [${geoLabel}] - ${t.tail}`,
    countries: [...t.geo],
    locales: [],
    category: "",
    placement: "FULL",
    ageMin: "18",
    userOs: "all",
    originalBudget: t.budget,
    originalRoas: t.roas,
    bidStrategy: t.strategy,
    objective: "OUTCOME_SALES",
    optimization: "conversions",
    conversionEvent: "PURCHASE",
    redirectType: t.redirect,
    creatives: Array.from({ length: t.creatives }, (_, k) => ({
      videoId: `v_${campaignId}_${k + 1}`,
      thumbUrl: "",
    })),
  };
}

/**
 * Fetch the source campaigns for the given ids from Facebook (via /api/clone/sources). Throws on
 * failure so the board can surface a proper error state — it never silently substitutes mock data.
 */
export async function loadCloneSources(ids: string[], partner: PartnerId): Promise<CloneSource[]> {
  const clean = ids.filter(Boolean);
  if (clean.length === 0) return [];
  const res = await fetch(
    `/api/clone/sources?partner=${encodeURIComponent(partner)}&ids=${encodeURIComponent(clean.join(","))}`,
    { cache: "no-store" },
  );
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    sources?: CloneSource[];
    error?: string;
  };
  if (!res.ok || !body.ok) {
    throw new Error(body?.error || `Failed to load campaigns (${res.status})`);
  }
  return body.sources ?? [];
}

/** Local sample sources for the "Load sample" button — mock data, no Facebook call. */
export async function loadSampleSources(): Promise<CloneSource[]> {
  return SAMPLE_IDS.map((id, i) => mockSource(id, i));
}
