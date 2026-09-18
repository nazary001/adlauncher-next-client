// Snapchat rail — the SNAPCHAT side of the keys report: what each bound campaign spent and
// delivered on the picked São Paulo day (Marketing API stats) and where it stands with Snap's
// delivery + ad review. Pure and dependency-free (node --test); the reads live in lib/snap-api.ts,
// the route that joins them with the registry in app/api/snap/stats. Live shapes probed 2026-09-18:
//   GET /adaccounts/{id}/stats?granularity=TOTAL&breakdown=campaign&start_time=…&end_time=…&fields=impressions,swipes,spend
//     → { total_stats:[{ total_stat:{ breakdown_stats:{ campaign:[{ id, stats:{ impressions, swipes, spend } }] } } }] }
//     spend is MICRO currency. TOTAL takes any hour-aligned window; DAY demands the ACCOUNT's own
//     midnight (E1008) — our accounts are America/Los_Angeles while the partner's day is São Paulo,
//     so the day is asked as a TOTAL window and both sides of the table cover the same 24 hours.
//   GET /adaccounts/{id}/campaigns → { campaigns:[{ campaign:{ id, status, delivery_status[] } }] }
//   GET /adaccounts/{id}/ads       → { ads:[{ ad:{ ad_squad_id, review_status } }] }

export type SnapCampaignStats = { spend: number; impressions: number; swipes: number };
export type SnapCampaignState = { status: string; delivery: string[] };
export type SnapAdReview = { total: number; approved: number; pending: number; rejected: number };

/** One bound key as Snapchat sees it. `stats` / `state` are null when that read of the key's ad
 *  account failed (the failure is named in the route's `errors`), never when the answer was empty:
 *  a campaign Snap has no stats row for simply did not deliver → zeros. */
export type SnapKeyLive = {
  key: string;
  campaignId: string;
  adAccount: string;
  adAccountName: string;
  stats: SnapCampaignStats | null;
  /** null = the campaign list could not be read; `found:false` = read fine, the campaign is gone. */
  state: (SnapCampaignState & { found: boolean }) | null;
  ads: SnapAdReview | null;
};

export const EMPTY_SNAP_CAMPAIGN_STATS: SnapCampaignStats = Object.freeze({ spend: 0, impressions: 0, swipes: 0 }) as SnapCampaignStats;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------- the day window ----------

/** "GMT-03:00" → "-03:00" for the zone at that instant ("GMT" alone = UTC). */
function zoneOffset(timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d{2}):?(\d{2})/.exec(name);
  return m ? `${m[1]}:${m[2]}` : "+00:00";
}

const nextISODate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** The São Paulo day `date` (YYYY-MM-DD) as the [start, end) pair Snap's stats endpoint takes —
 *  the same 24 hours LION's report covers. The offset is read per boundary, so a DST change (none
 *  in Brazil since 2019) would still land on local midnight. */
export function snapDayWindow(date: string): { start: string; end: string } {
  const next = nextISODate(date);
  const at = (d: string) => `${d}T00:00:00.000${zoneOffset("America/Sao_Paulo", new Date(`${d}T12:00:00Z`))}`;
  return { start: at(date), end: at(next) };
}

// ---------- parsers (never throw: junk → empty) ----------

/** Stats body → campaign id → numbers (spend in currency units, not micro). */
export function parseSnapAccountStats(body: unknown): Record<string, SnapCampaignStats> {
  const out: Record<string, SnapCampaignStats> = {};
  for (const t of arr(rec(body).total_stats)) {
    const rows = arr(rec(rec(rec(t).total_stat).breakdown_stats).campaign);
    for (const row of rows) {
      const r = rec(row);
      const id = str(r.id);
      if (!id) continue;
      const s = rec(r.stats);
      const prev = out[id] ?? EMPTY_SNAP_CAMPAIGN_STATS;
      out[id] = { spend: prev.spend + num(s.spend) / 1_000_000, impressions: prev.impressions + num(s.impressions), swipes: prev.swipes + num(s.swipes) };
    }
  }
  return out;
}

/** Campaign list pages → campaign id → status + delivery flags. */
export function parseSnapCampaignStates(pages: unknown[]): Record<string, SnapCampaignState> {
  const out: Record<string, SnapCampaignState> = {};
  for (const page of pages) {
    for (const item of arr(rec(page).campaigns)) {
      const c = rec(rec(item).campaign);
      const id = str(c.id);
      if (!id) continue;
      out[id] = { status: str(c.status).toUpperCase(), delivery: arr(c.delivery_status).map(str) };
    }
  }
  return out;
}

/** Ad list pages → ad squad id → review counts (anything not APPROVED / REJECTED is still in review). */
export function parseSnapAdReviews(pages: unknown[]): Record<string, SnapAdReview> {
  const out: Record<string, SnapAdReview> = {};
  for (const page of pages) {
    for (const item of arr(rec(page).ads)) {
      const a = rec(rec(item).ad);
      const squad = str(a.ad_squad_id);
      if (!squad) continue;
      const r = (out[squad] ??= { total: 0, approved: 0, pending: 0, rejected: 0 });
      const review = str(a.review_status).toUpperCase();
      r.total += 1;
      if (review === "APPROVED") r.approved += 1;
      else if (review === "REJECTED") r.rejected += 1;
      else r.pending += 1;
    }
  }
  return out;
}

// ---------- the join ----------

export type SnapBoundKey = { key: string; campaign_id?: string; adsquad_id?: string; ad_account?: string };
export type SnapAccountRead = {
  name?: string;
  stats: Record<string, SnapCampaignStats> | null;
  states: Record<string, SnapCampaignState> | null;
  reviews: Record<string, SnapAdReview> | null;
};

/** Registry bindings × per-account reads → one row per key that owns a campaign, in key order. */
export function joinSnapLive(bindings: SnapBoundKey[], reads: Record<string, SnapAccountRead>): SnapKeyLive[] {
  const out: SnapKeyLive[] = [];
  for (const b of bindings) {
    const campaignId = str(b.campaign_id);
    const adAccount = str(b.ad_account);
    if (!campaignId || !adAccount) continue;
    const read = reads[adAccount];
    const state = read?.states ? read.states[campaignId] : undefined;
    out.push({
      key: b.key,
      campaignId,
      adAccount,
      adAccountName: str(read?.name),
      stats: read?.stats ? (read.stats[campaignId] ?? { ...EMPTY_SNAP_CAMPAIGN_STATS }) : null,
      state: read?.states ? (state ? { ...state, found: true } : { status: "", delivery: [], found: false }) : null,
      ads: read?.reviews && b.adsquad_id ? (read.reviews[b.adsquad_id] ?? { total: 0, approved: 0, pending: 0, rejected: 0 }) : null,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Totals over the keys whose stats were read; `complete` is false when any account's stats failed. */
export function snapLiveTotals(keys: SnapKeyLive[]): SnapCampaignStats & { complete: boolean } {
  const t = { spend: 0, impressions: 0, swipes: 0, complete: true };
  for (const k of keys) {
    if (!k.stats) {
      t.complete = false;
      continue;
    }
    t.spend += k.stats.spend;
    t.impressions += k.stats.impressions;
    t.swipes += k.stats.swipes;
  }
  return t;
}

// ---------- presentation ----------

export type SnapDeliveryNote = { text: string; tone: "ok" | "warn" | "bad" };

/** Where the campaign stands, in a few words: Snap reviews every AD after we create it, so a row
 *  we closed as done/live can still be a campaign nothing is delivering from. */
export function snapDeliveryNote(live: Pick<SnapKeyLive, "state" | "ads">): SnapDeliveryNote | null {
  const { state, ads } = live;
  if (!state) return null;
  if (!state.found) return { text: "campaign not found on Snapchat", tone: "bad" };
  const parts: string[] = [];
  let tone: SnapDeliveryNote["tone"] = "ok";
  if (state.status && state.status !== "ACTIVE") {
    parts.push(state.status.toLowerCase());
    tone = "warn";
  }
  if (ads && ads.total > 0) {
    if (ads.approved === 0 && ads.pending === 0) {
      parts.push(`all ${ads.total} ads rejected — not delivering`);
      tone = "bad";
    } else if (ads.approved === 0) {
      parts.push(`in review: ${ads.pending} pending${ads.rejected ? `, ${ads.rejected} rejected` : ""}`);
      if (tone === "ok") tone = "warn";
    } else {
      parts.push(`${ads.approved}/${ads.total} ads live${ads.rejected ? `, ${ads.rejected} rejected` : ""}${ads.pending ? `, ${ads.pending} in review` : ""}`);
    }
  }
  if (tone !== "bad" && state.delivery.includes("LEARNING_PHASE")) parts.push("learning");
  return parts.length ? { text: parts.join(" · "), tone } : { text: "active", tone };
}

/** Money for a table where a day's take can be a fraction of a cent: two decimals from $1 up,
 *  three below it, four below a cent — $0.000233 must not read as $0.00. */
export function snapMoney(v: number): string {
  const a = Math.abs(v);
  const digits = a === 0 || a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
  return `${v < 0 ? "-" : ""}$${a.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
