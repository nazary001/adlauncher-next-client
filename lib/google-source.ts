// Google Ads rail — pure source-campaign helpers (LION Google metrics rows → board facts).
// Dependency-free on purpose (see lib/google-bid.ts) so `node --test` covers it.

export type LionGoogleRow = {
  campaignId: string;
  name: string;
  /** ENABLED | PAUSED | REMOVED | … (LION passes Google's status through). */
  status: string;
  /** Google Ads customer id (== google-weapon `customer_id`). */
  accountId: string;
  accountName: string;
  accountStatus: string;
  /** Daily budget in MAJOR account units (LION reads are major). */
  budget: number | null;
  /** Bid value as LION shows it (CPA in account currency for the team's Target-CPA book). */
  bid: number | null;
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One `GET /api/google/campaigns/metrics/` row → LionGoogleRow (unknown shapes → nulls, never throws). */
export function mapLionGoogleRow(r: Record<string, unknown>): LionGoogleRow {
  return {
    campaignId: str(r.campaign_id),
    name: str(r.campaign_name),
    status: str(r.campaign_status),
    accountId: str(r.account_id),
    accountName: str(r.account_name),
    accountStatus: str(r.account_status),
    budget: num(r.campaign_budget),
    bid: num(r.campaign_bid),
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

/** Geo segment of a LION Google name: `… - BE+CA - S2EARCH …` → "BE+CA"; `… - LATAM - …` →
 *  "LATAM"; "" when no segment reads as a geo. Country segments are 2-letter codes joined by
 *  "+"; named pools (WW/WORLD/LATAM/ANGLO/EU/T1…) are accepted as a single upper-case token
 *  that is not an offer word (offers end with " DIRETO" or carry lower-case letters). */
export function googleGeoFromName(name: string): string {
  const s = String(name ?? "");
  const codes = s.match(/ - ((?:[A-Z]{2})(?:\+[A-Z]{2})+|[A-Z]{2}) - /);
  if (codes) return codes[1];
  const pool = s.match(/ - (WW|WORLD|WORLDWIDE|LATAM|ANGLO|EU|T1|TIER1|GLOBAL) - /i);
  return pool ? pool[1].toUpperCase() : "";
}

/** Split a LION Google name into the generated head and the team suffix (first " | "). */
export function splitGoogleName(name: string): { head: string; suffix: string } {
  const s = String(name ?? "");
  const i = s.indexOf(" | ");
  return i < 0 ? { head: s.trim(), suffix: "" } : { head: s.slice(0, i).trim(), suffix: s.slice(i + 3).trim() };
}

/** Source id the team's suffix names (`CLONE_FROM=` / `JURO_FROM=`), "" when absent. */
export function googleSourceFromName(name: string): string {
  const m = String(name ?? "").match(/(?:CLONE|JURO)_FROM=(\d{5,})/);
  return m ? m[1] : "";
}

export type GoogleDatasetState = "ready" | "fetching" | "missing" | "error";

/** What the board shows per pasted source id (POST /api/google/sources). */
export type GoogleSourceInfo = {
  campaignId: string;
  /** Seen in LION's Google metrics within the lookback window (name/account/budget/bid known). */
  known: boolean;
  name: string;
  status: string;
  accountId: string;
  accountName: string;
  /** Currency of the source's account from the customers list ("" when the account isn't ours). */
  currency: string;
  budget: number | null;
  bid: number | null;
  geo: string;
  dataset: { state: GoogleDatasetState; fetchedAt: string | null; error?: string };
};

// ---------- dataset ensure (pure algorithm; lib/google-weapon.ts binds the real I/O) ----------

export type GoogleDatasetFetchResult = { state: "ready" | "fetching"; fetchedAt: string | null };
export type GoogleDatasetDeps = {
  fetch: (campaignId: string, force?: boolean) => Promise<GoogleDatasetFetchResult>;
  status: (campaignId: string) => Promise<{ ready: boolean; fetchedAt: string | null }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
export type GoogleEnsureResult = { ok: true; fetchedAt: string | null } | { ok: false; reason: string };

/**
 * Bring a source into the launch dataset and wait for it: fetch → ready at once, or poll status
 * every `pollMs` up to `maxWaitMs` (partner: typically 30–120 s); still false → re-trigger the
 * fetch once (the docs' "re-trigger if it stays false for more than ~3 minutes") and wait up to
 * `retryWaitMs` more. A thrown fetch (404 never seen / 400 no MCC credentials) is final.
 */
export async function ensureGoogleDataset(
  campaignId: string,
  deps: GoogleDatasetDeps,
  opts: { maxWaitMs?: number; retryWaitMs?: number; pollMs?: number } = {},
): Promise<GoogleEnsureResult> {
  const maxWaitMs = opts.maxWaitMs ?? 180_000;
  const retryWaitMs = opts.retryWaitMs ?? 120_000;
  const pollMs = opts.pollMs ?? 8_000;
  const waitReady = async (budget: number): Promise<{ fetchedAt: string | null } | null> => {
    const until = deps.now() + budget;
    while (deps.now() < until) {
      await deps.sleep(pollMs);
      const s = await deps.status(campaignId);
      if (s.ready) return { fetchedAt: s.fetchedAt };
    }
    return null;
  };
  try {
    const first = await deps.fetch(campaignId);
    if (first.state === "ready") return { ok: true, fetchedAt: first.fetchedAt };
    const r1 = await waitReady(maxWaitMs);
    if (r1) return { ok: true, fetchedAt: r1.fetchedAt };
    const second = await deps.fetch(campaignId);
    if (second.state === "ready") return { ok: true, fetchedAt: second.fetchedAt };
    const r2 = await waitReady(retryWaitMs);
    if (r2) return { ok: true, fetchedAt: r2.fetchedAt };
    return {
      ok: false,
      reason: `source ${campaignId}: dataset not ready after ${Math.round((maxWaitMs + retryWaitMs) / 1000)} s — re-fetch and fire again`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `source ${campaignId}: ${msg}` };
  }
}
