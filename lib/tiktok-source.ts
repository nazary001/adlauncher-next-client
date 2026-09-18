// TikTok rail — pure source-campaign helpers (LION TikTok metrics rows → board facts) and LION's
// campaign-name grammar. Dependency-free on purpose (see lib/tiktok-launch.ts) so `node --test`
// covers it; the small landing-base rule is duplicated here rather than imported for that reason.

export type LionTiktokRow = {
  campaignId: string;
  name: string;
  /** ENABLE | DISABLE | DELETE (TikTok's operation status, passed through by LION). */
  status: string;
  /** TikTok's delivery status, e.g. CAMPAIGN_STATUS_ENABLE / ADVERTISER_ACCOUNT_PUNISH. */
  delivery: string;
  /** TikTok advertiser id (== tiktok-weapon `advertiser_id`). */
  accountId: string;
  accountName: string;
  currency: string;
  /** Daily budget, USD float (LION converts every TikTok money field to USD). */
  budget: number | null;
  /** Bid, USD float; 0/null on no-bid and value-optimisation campaigns. */
  bid: number | null;
  /** The ad's landing WITH LION's tracking tail ("" when LION hasn't read the ad yet). */
  landingUrl: string;
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One `GET /api/tiktok/campaigns/metrics/` row → LionTiktokRow (unknown shapes → nulls, never throws). */
export function mapLionTiktokRow(r: Record<string, unknown>): LionTiktokRow {
  return {
    campaignId: str(r.campaign_id),
    name: str(r.campaign_name),
    status: str(r.campaign_status),
    delivery: str(r.delivery),
    accountId: str(r.account_id),
    accountName: str(r.account_name),
    currency: str(r.account_currency).toUpperCase(),
    budget: num(r.campaign_budget),
    bid: num(r.campaign_bid),
    landingUrl: str(r.landing_page_url),
  };
}

/** YYYY-MM-DD of (now − offsetDays) in São Paulo — LION's metrics day boundary. */
export function saoPauloDate(offsetDays = 0, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(shifted)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export type TiktokNameParts = {
  /** Everything LION generated, source marker included. */
  head: string;
  /** The buyer's own suffix (the Smart+ tag is NOT part of it). */
  suffix: string;
  /** LION's cluster number (the first field of the bracket group). */
  cl: string;
  geo: string[];
  /** Upper-cased language code, or "ALL". */
  language: string;
  landingPath: string;
  sourceKind: "" | "clone" | "juro";
  sourceId: string;
  /** "campaign" = Smart+ CBO, "adgroup" = Smart+ with ad-group budgets, "" = classic. */
  smartPlus: "" | "adgroup" | "campaign";
};

/**
 * LION's TikTok name (live 17–18.09):
 *   {HS-xxxx} (GLO-01) [<cl>|<GEO,GEO>|<LANG|ALL>] (<landing path>)[ (CLONE_FROM=<id>)][ | Smart+[ CBO]] | <suffix>
 * The head ends at the first " | "; a locked `Smart+` / `Smart+ CBO` segment may sit between the
 * head and the buyer's suffix. The FIRST bracket group is LION's (a buyer's suffix may start with
 * its own "[EN]"). A name of any other shape parses to empty parts.
 */
export function parseTiktokName(name: string): TiktokNameParts {
  const s = String(name ?? "");
  const cut = s.indexOf(" | ");
  const head = (cut < 0 ? s : s.slice(0, cut)).trim();
  let rest = cut < 0 ? "" : s.slice(cut + 3).trim();
  let smartPlus: TiktokNameParts["smartPlus"] = "";
  const smart = /^Smart\+( CBO)?(?: \| |$)/.exec(rest);
  if (smart) {
    smartPlus = smart[1] ? "campaign" : "adgroup";
    rest = rest.slice(smart[0].length).trim();
  }
  const bracket = /\[([^|\]]*)\|([^|\]]*)\|([^|\]]*)\]/.exec(head);
  const landing = bracket ? /\]\s*\(([^()]*\/[^()]*)\)/.exec(head) : null;
  const source = /\((CLONE|JURO)_FROM=(\d{5,})\)/.exec(head);
  return {
    head,
    suffix: rest,
    cl: bracket ? bracket[1].trim() : "",
    geo: bracket
      ? bracket[2]
          .split(",")
          .map((g) => g.trim().toUpperCase())
          .filter(Boolean)
      : [],
    language: bracket ? bracket[3].trim().toUpperCase() : "",
    landingPath: landing ? landing[1].trim() : "",
    sourceKind: source ? (source[1] === "CLONE" ? "clone" : "juro") : "",
    sourceId: source ? source[2] : "",
    smartPlus,
  };
}

/** The partner has no dataset STATUS read (unlike google-weapon): all the board can know is that a
 *  fetch was accepted ("fetching"), that LION never saw the campaign ("missing"), or that the
 *  trigger failed ("error"). "unknown" = not asked yet. The pump is the real gate. */
export type TiktokDatasetState = "fetching" | "missing" | "error" | "unknown";

/** What the clone board shows per pasted source id (POST /api/tiktok/sources). */
export type TiktokSourceInfo = {
  campaignId: string;
  /** Seen in LION's TikTok metrics within the lookback window. */
  known: boolean;
  name: string;
  status: string;
  delivery: string;
  accountId: string;
  accountName: string;
  currency: string;
  budget: number | null;
  bid: number | null;
  /** "US+CA" / "WW" from the name. */
  geo: string;
  language: string;
  landingPath: string;
  smartPlus: "" | "adgroup" | "campaign";
  dataset: { state: TiktokDatasetState; error?: string };
};

/** Bare https landing (query + hash dropped), "" when the value isn't one. */
function bareLanding(raw: string): string {
  const v = String(raw ?? "").trim();
  if (!/^https:\/\//i.test(v)) return "";
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".")) return "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Landing suggestions for the launcher: the bare landings the team's own campaigns run RIGHT NOW,
 * most used first (ties alphabetical). Every one of them is by construction on LION's allowed
 * domain list — the partner publishes that list only inside a 400.
 */
export function rankTiktokLandings(rows: LionTiktokRow[], limit = 40): { url: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const url = bareLanding(r.landingUrl);
    if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url))
    .slice(0, limit);
}
