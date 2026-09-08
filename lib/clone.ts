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

/** A row's OWN destination on the MO/AIF clone board (owner ask 2026-09-08): the fanpage, the
 *  account (SOURCE_ACCOUNT = "keep it in the source's own account") and, for a concrete
 *  account, that account's pixel — the same three picks the batch Settings carry, per row. */
export type CloneRowDest = { pageId: string; accountId: string; pixelId: string };

/** The editable clone config layered on a source. Copies and the destination default to the
 *  batch settings; a row may carry its own (`dest`, `copies`). */
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
  /** The CLONE's bid strategy (editable — owner ask 09-01: a clone may switch ROAS ↔ cap ↔
   *  lowest). Born as the source's; the Bid column's meaning follows THIS, not the source's. */
  bidStrategy: string;
  roasGoal: string; // the "Bid" column — ROAS decimal or $ cap, by the ROW's bid strategy
  budget: string; // target daily budget, display string
  redirectType: string;
  highOffer: HighOfferConfig;
  /** The row's OWN destination — null = the batch settings' fanpage / account / pixel. */
  dest: CloneRowDest | null;
  /** The row's OWN number of copies — null = the batch settings' copies. */
  copies: number | null;
};

/** Copies bound: 1..100 (the batch field's own clamp). */
export const MAX_CLONE_COPIES = 100;
const clampCopies = (n: number): number => Math.max(1, Math.min(MAX_CLONE_COPIES, Math.floor(n) || 1));

/** A row's EFFECTIVE destination: its own picks, the batch settings for whatever it leaves empty
 *  (owner ask 09-08 — the board's inline pickers override ONE field at a time). The pixel only
 *  inherits while the row lands in the batch's own account: a pixel belongs to its account, so
 *  an account of the row's own with no pixel pick reads as "pixel missing", never as the batch's. */
export function rowDestination(
  row: Pick<CloneRow, "dest">,
  settings: Pick<CloneSettings, "pageId" | "accountId" | "pixelId">,
): CloneRowDest {
  const own = row.dest;
  if (!own) return { pageId: settings.pageId, accountId: settings.accountId, pixelId: settings.pixelId };
  const accountId = own.accountId || settings.accountId;
  return {
    pageId: own.pageId || settings.pageId,
    accountId,
    pixelId: own.pixelId || (accountId === settings.accountId ? settings.pixelId : ""),
  };
}

/** A row's own destination with nothing picked is no override at all → null (rides the batch). */
export function normalizeRowDest(dest: CloneRowDest | null): CloneRowDest | null {
  if (!dest) return null;
  return dest.pageId || dest.accountId || dest.pixelId ? dest : null;
}

/** A row's EFFECTIVE number of copies: its own (clamped), else the batch settings' (clamped). */
export function rowCopiesOf(row: Pick<CloneRow, "copies">, settings: Pick<CloneSettings, "copies">): number {
  return clampCopies(row.copies != null && row.copies >= 1 ? row.copies : settings.copies);
}

/** One clone to create, sent from the board to /api/clone/run (rows × copies flattened). Client-safe
 *  (no server deps) so both the board and the server builder share the shape. */
export type CloneEdit = {
  campaignId: string; // source FB campaign id to clone from
  name: string;
  budget: string;
  roasGoal: string;
  /** The clone's TARGET bid strategy (may differ from the source's — ROAS ↔ cap ↔ lowest).
   *  Empty/absent = inherit the source's; the server validates against the supported set. */
  bidStrategy?: string;
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

export function defaultSettings(): CloneSettings {
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
    bidStrategy: source.bidStrategy,
    roasGoal: source.originalRoas,
    budget: source.originalBudget,
    redirectType: source.redirectType,
    highOffer: { enabled: source.redirectType === "HIGH ADX", offerId: "", share: "" },
    dest: null,
    copies: null,
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
  /** The CLONE's bid strategy (the row's pick) — the preview labels the bid by its kind. */
  bidStrategy: string;
  countries: string[];
};

/** Expand the rows into the flat list of clones a Duplicate run would create — each row with
 *  ITS effective copies (its own, else the batch `copies`). */
export function flattenPreview(rows: CloneRow[], copies: number): ClonePreviewItem[] {
  const out: ClonePreviewItem[] = [];
  for (const r of rows) {
    const total = rowCopiesOf(r, { copies });
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
        bidStrategy: r.bidStrategy || r.source.bidStrategy,
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

/** One source id the read could not deliver, with Meta's reason (not found / no access …). */
export type CloneSourceFailure = { id: string; error: string };

/**
 * Fetch the source campaigns for the given ids from Facebook (via /api/clone/sources). Throws on
 * failure so the board can surface a proper error state — it never silently substitutes mock data.
 * `channel` = the MO signer (`soc:<name>`) whose token performs the read (the retired system
 * token can't see the campaigns any more — owner report 09-08); AIF passes none. When NOT ONE
 * id could be read the call throws with the per-id reasons, so the board shows an error + Retry
 * instead of an empty "No campaigns received"; partial failures come back in `failed`.
 */
export async function loadCloneSources(
  ids: string[],
  partner: PartnerId,
  channel?: string,
): Promise<{ sources: CloneSource[]; failed: CloneSourceFailure[] }> {
  const clean = ids.filter(Boolean);
  if (clean.length === 0) return { sources: [], failed: [] };
  const res = await fetch(
    `/api/clone/sources?partner=${encodeURIComponent(partner)}&ids=${encodeURIComponent(clean.join(","))}` +
      (channel ? `&channel=${encodeURIComponent(channel)}` : ""),
    { cache: "no-store" },
  );
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    sources?: CloneSource[];
    failed?: string[];
    failures?: Record<string, string>;
    error?: string;
  };
  if (!res.ok || !body.ok) {
    throw new Error(body?.error || `Failed to load campaigns (${res.status})`);
  }
  const sources = body.sources ?? [];
  const failed = (body.failed ?? []).map((id) => ({ id, error: body.failures?.[id] || "not found / no access" }));
  if (sources.length === 0 && failed.length > 0) {
    throw new Error(
      `Couldn't read ${failed.length === 1 ? "the campaign" : `${failed.length} campaigns`} with this signer: ` +
        failed.map((f) => `#${f.id} — ${f.error}`).join(" · "),
    );
  }
  return { sources, failed };
}

/** Local sample sources for the "Load sample" button — mock data, no Facebook call. */
export async function loadSampleSources(): Promise<CloneSource[]> {
  return SAMPLE_IDS.map((id, i) => mockSource(id, i));
}
