// VC (ValueClick, app.valueclick.io) — the CONTENT-ARB partner's link, pixel and delivery contract.
// Pure and dependency-free apart from lib/types, so `node --test` runs it straight (lib/partners
// re-exports it; that file pulls React icons and can't be tested bare).
//
// How a VC campaign works (partner dashboard, read 23.10): the buyer creates a Content Arb
// "Landingpage" in VC (Content Arb → Landingpages → Create: name, domain QualityDays, traffic source
// Meta, content type Personality Test) and sets its Tracking — Pixel-ID + Conversions API token +
// event Purchase. VC answers with ONE link per landingpage — a quiz page whose last slug word is the
// landingpage id:
//   https://www.qualitydays.com/coa/<quiz-slug>-<landingpage id>/
// No query params of ours: clicks are matched by the fbclid Meta appends itself, and VC fires Purchase
// (value = a share of the page's ad revenue) into the landingpage's pixel through the Conversions API.
// So the launcher only needs the link and the ad set optimizing on the SAME pixel VC fires.
// VC's other product, Search Arb / RSOC (…/rsp/<article>/?cmpid=…&adtitle=…), is NOT launched from
// here (owner 23.10: "нужен content arb только") — such a link is refused with its own reason.
import type { Campaign } from "./types";
import { bidKind } from "./types";

/** The Meta pixel (dataset) the owner set up for launcher-born VC campaigns (23.10). VC fires
 *  Purchase into it through the Conversions API — every Content Arb landingpage's Tracking names it. */
export const VC_PIXEL = { id: "1505591128290736", name: "VC pixel" } as const;
/** The VC landingpage's conversion event (Tracking → Conversion Event). */
export const VC_EVENT = "Purchase";
/** VC partner dashboard — where buyers create Content Arb landingpages and copy their links. */
export const VC_PORTAL_URL = "https://app.valueclick.io/coa/landingpages/";

/** The pixel-less VC mode: Traffic / link clicks (LINK_CLICKS, no promoted_object). */
export const VC_TRAFFIC_OBJECTIVE = "OUTCOME_TRAFFIC";
/** The default VC mode: Sales, optimizing Purchase on VC_PIXEL (min-ROAS too — VC's events carry a value). */
export const VC_SALES_OBJECTIVE = "OUTCOME_SALES";

/** Hosts VC serves landingpages on (the dashboard's "Domain" select: QualityDays). A landingpage
 *  on a new VC domain = one entry here. Subdomains (www.) are accepted. */
export const VC_HOSTS: readonly string[] = ["qualitydays.com"];

// ---- the ready Content Arb landingpages (owner ask 23.10: "все активные вот эти ссылки … сразу по
// дефолту добавь в автовыбор чтобы готовые были на партнере VC") ----------------------------------
// Every landingpage VC's Content Arb list showed ACTIVE on 23.10 (the 9 "Creation Failed" rows have no
// link), each with Tracking = VC_PIXEL + Purchase, each answering 200 in English. A pick only fills the
// card's link field — any other VC Content Arb link can still be pasted. A new landingpage = one row.

export type VcReadyLink = {
  /** The link exactly as VC prints it (Landingpage → Link). */
  url: string;
  /** The landingpage id — the link's last slug word. */
  id: string;
  /** The landingpage's niche (the part of its VC name before " | ") — the picker's section. */
  niche: string;
  /** The landingpage's name after the niche. */
  title: string;
  lang: "EN";
};

const ready = (slug: string, id: string, niche: string, title: string): VcReadyLink => ({
  url: `https://www.qualitydays.com/coa/${slug}-${id}/`,
  id,
  niche,
  title,
  lang: "EN",
});

export const VC_READY_LINKS: readonly VcReadyLink[] = [
  ready("words-or-actions", "fn3zbpziuj", "Relationships", "Words or Actions? Explore Your Connection Style"),
  ready("ready-for-dating-or-a-new-relationship", "gvohy56eu6", "Dating", "Ready for Dating or a New Relationship?"),
  ready("explore-your-dating-style", "j4erziw09v", "Dating", "Explore Your Dating Style"),
  ready("which-fashion-style-reflects-your-taste", "ck8mlgyt2x", "Fashion", "Which Fashion Style Reflects Your Taste?"),
  ready("explore-your-food-personality", "35hkgthi0x", "Food", "Explore Your Food Personality"),
  ready("which-home-style-matches-your-taste", "c03lhgu5sh", "Home / Lifestyle", "Which Home Style Matches Your Taste?"),
  ready("what-cus-your-everyday-money-style", "vbthoftnqw", "Money / Finance", "Explore Your Everyday Money Habits"),
  ready("what-kind-of-car-would-you-choose-take-the-quiz", "9tt1stzie8", "Automotive", "What Kind of Car Would You Choose? Take the Quiz!"),
  ready("what-career-were-you-really-made-for-take-this-personality-test", "ahgde6x3vy", "Career / Jobs", "What Career Were You Really Made For? Take This Personality Test!"),
];

/** The ready landingpage a card's link is (by landingpage id — the pasted link may carry extras), or null. */
export function vcReadyLinkOf(raw: string): VcReadyLink | null {
  const d = vcDestination(raw);
  return d.ok ? (VC_READY_LINKS.find((l) => l.id === d.lpId) ?? null) : null;
}

// ---- VC through TOOL (owner ask 23.10: "VC через TOOL без токена") -------------------------------
// A VC campaign can launch on a TOOL session alone: the cabinet comes from TOOL, the page id is typed
// (or picked from the VC token when one is assigned), TOOL itself checks page + pixel at publish.

/** The TOOL project VC's sessions are filed under (TOOL → Sessions → project). */
export const VC_TOOL_PROJECT = "VC";
/** VC's cabinets by name — the ones VC's system user holds (GC-for-VC-BR-742 … -762, BM VD-C1, 23.10). */
export const VC_ACCOUNT_NAME_RE = /^GC-for-VC-/i;
/** A cabinet name that is one of VC's. The VC token's account list is narrowed by it too: the system
 *  user also holds a stray cabinet of its own ("rr", 23.10) a card's least-loaded default must never pick. */
export const isVcAccountName = (name: string): boolean => VC_ACCOUNT_NAME_RE.test(String(name ?? "").trim());

/** A TOOL account row as GET /api/v1/accounts lists it (lib/tool-sessions-model ToolTeamAccount). */
export type VcToolAccount = { account_id: string; name: string; sessions: readonly { id: number }[] };

/**
 * VC's cabinets among TOOL's live accounts: named like VC's (VC_ACCOUNT_NAME_RE) or seen by a session
 * filed under the VC project. `projectOf` answers a session id's project (null = unknown / none).
 */
export function vcToolAccounts<T extends VcToolAccount>(accounts: readonly T[], projectOf: (sessionId: number) => string | null | undefined): T[] {
  const isVcProject = (id: number): boolean => String(projectOf(id) ?? "").trim().toUpperCase() === VC_TOOL_PROJECT;
  return accounts.filter((a) => isVcAccountName(a.name) || (a.sessions ?? []).some((s) => isVcProject(s.id)));
}

/** A typed fanpage id (the TOOL path without a VC token): digits only. */
export const isPageId = (v: string): boolean => /^\d{5,30}$/.test(String(v ?? "").trim());

/** A Content Arb landingpage path: /coa/<quiz-slug>-<landingpage id>/ — VC's ids are 10 [a-z0-9]
 *  ("fn3zbpziuj"); the slug before them is any run of lowercase words. */
const COA_PATH_RE = /^\/coa\/((?:[a-z0-9]+-)+)([a-z0-9]{10})\/?$/;

export type VcDelivery = { objective: string; optimization: Campaign["optimization"]; pixel: string; conversionEvent?: string };

/**
 * What a card's optimization (and bid strategy) means on the VC rail: conversions — and min-ROAS,
 * which always optimizes purchase value — = Sales optimizing Purchase on VC_PIXEL (a fresh card's
 * default); clicks = Traffic / link clicks with no pixel. Anything but "clicks" reads as conversions.
 * The ONE mapping the card, the locks and the launch route all use.
 */
export function vcDelivery(optimization: string, bidStrategy = ""): VcDelivery {
  return optimization === "clicks" && bidKind(bidStrategy) !== "roas"
    ? { objective: VC_TRAFFIC_OBJECTIVE, optimization: "clicks", pixel: "" }
    : { objective: VC_SALES_OBJECTIVE, optimization: "conversions", pixel: VC_PIXEL.id, conversionEvent: "PURCHASE" };
}

/** The VC lock for one card (applyPartnerLocks): objective, optimization, pixel and event converge
 *  to vcDelivery. Empty patch = the card already conforms. */
export function vcLockPatch(r: Campaign): Partial<Campaign> {
  const patch: Partial<Campaign> = {};
  const d = vcDelivery(r.optimization, r.bidStrategy);
  if (r.objective !== d.objective) patch.objective = d.objective;
  if (r.optimization !== d.optimization) patch.optimization = d.optimization;
  if (r.pixel !== d.pixel) patch.pixel = d.pixel;
  if (d.conversionEvent && r.conversionEvent !== d.conversionEvent) patch.conversionEvent = d.conversionEvent;
  return patch;
}

/** `lpId` = the landingpage id (VC's revenue key; the task rows' marker column shows it). */
export type VcDestination = { ok: true; url: string; lpId: string; host: string } | { ok: false; error: string };

const hostIsVc = (host: string): boolean => VC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Validate + normalize a pasted VC Content Arb landingpage link. Accepts the link exactly as VC's
 * dashboard prints it (with or without "https://", the trailing slash or extra query params); refuses
 * anything that is not a Content Arb landingpage: another host, a Search Arb (/rsp/) link, any other
 * path, credentials or a port. The normalized URL is https, ends its path in "/" (VC's own form) and
 * keeps every query param that was there (minus a #fragment).
 */
export function vcDestination(raw: string): VcDestination {
  let s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "destination_required — pick a ready VC landingpage or paste a Content Arb link" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "destination_invalid — not a link; paste the landingpage link from VC" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "destination_invalid — the link must be https://" };
  const host = u.hostname.toLowerCase();
  if (!hostIsVc(host)) {
    return { ok: false, error: `destination_not_vc — ${host} is not a VC landingpage domain (${VC_HOSTS.join(", ")})` };
  }
  if (u.username || u.password || u.port) return { ok: false, error: "destination_invalid — no credentials or port in the link" };
  if (/^\/rsp(\/|$)/i.test(u.pathname)) {
    return { ok: false, error: "destination_search_arb — that is a VC Search Arb (RSOC) link; VC launches here are Content Arb only — paste a Content Arb landingpage (…/coa/…)" };
  }
  const m = COA_PATH_RE.exec(u.pathname);
  if (!m) {
    return { ok: false, error: "destination_not_coa — not a Content Arb landingpage; copy the link from VC → Content Arb → Landingpages (…/coa/<quiz>-<id>/)" };
  }
  u.protocol = "https:";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname = `${u.pathname}/`;
  return { ok: true, url: u.toString(), lpId: m[2], host };
}

/** Role-tagged link segments (lib/partners LinkSegment shape) for the card's colored preview. */
export type VcLinkSegment = { text: string; role: "base" | "slug" | "params" | "gcm" };

/**
 * The launched link as segments: the normalized landingpage link, its landingpage id highlighted (the
 * part VC credits the revenue to). Empty when the destination is not a valid VC Content Arb link.
 */
export function vcLinkSegments(raw: string): VcLinkSegment[] {
  const d = vcDestination(raw);
  if (!d.ok) return [];
  const u = new URL(d.url);
  const base = `${u.origin}/coa/`;
  const slug = u.pathname.slice("/coa/".length, -1 - d.lpId.length);
  const segs: VcLinkSegment[] = [
    { text: base, role: "base" },
    { text: slug, role: "slug" },
    { text: d.lpId, role: "gcm" },
  ];
  segs.push({ text: `/${u.search}`, role: "params" });
  return segs;
}

/** The joined link (what the ad actually points at). Empty when the destination is not valid. */
export function vcLink(raw: string): string {
  return vcLinkSegments(raw)
    .map((s) => s.text)
    .join("");
}
