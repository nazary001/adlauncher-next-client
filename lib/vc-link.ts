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
import { carriesOwnName } from "./own-name.ts";

/** The Meta pixel (dataset) the owner set up for launcher-born VC campaigns (23.10). VC fires
 *  Purchase into it through the Conversions API — every Content Arb landingpage's Tracking names it. */
export const VC_PIXEL = { id: "1505591128290736", name: "VC pixel" } as const;
/** The dataset the owner named for Lead (05.11, first for the Lead clones: «на этот новый пиксель … лид
 *  оптимизацию вместо пурчейс»): "S-1 nik pixel", BM VD Market — shared to every GC-for-VC cabinet (read 05.11
 *  with the VC token). A Lead launch optimizes LEAD on it (vcDelivery). */
export const VC_LEAD_PIXEL = { id: "2126539511577664", name: "S-1 nik pixel" } as const;
/** The VC datasets the launcher knows by name (the clone board offers them; the launch pins one by event). */
export const VC_PIXELS: readonly { id: string; name: string }[] = [VC_PIXEL, VC_LEAD_PIXEL];
export const vcPixelName = (id: string): string => VC_PIXELS.find((p) => p.id === id)?.name ?? id;

/** The pixel-less VC mode: Traffic / link clicks (LINK_CLICKS, no promoted_object). */
export const VC_TRAFFIC_OBJECTIVE = "OUTCOME_TRAFFIC";
/** The default VC mode: Sales, optimizing Purchase on VC_PIXEL (min-ROAS too — VC's events carry a value). */
export const VC_SALES_OBJECTIVE = "OUTCOME_SALES";
/** The Lead mode: a Leads campaign optimizing LEAD on VC_LEAD_PIXEL — Meta allows the LEAD event only under
 *  OUTCOME_LEADS (lib/catalog EVENTS_BY_OBJECTIVE). */
export const VC_LEADS_OBJECTIVE = "OUTCOME_LEADS";

/** Hosts VC serves landingpages on (the dashboard's "Domain" select: QualityDays). A landingpage
 *  on a new VC domain = one entry here. Subdomains (www.) are accepted. */
export const VC_HOSTS: readonly string[] = ["qualitydays.com"];

// ---- the ready Content Arb landingpages (owner ask 23.10: "все активные вот эти ссылки … сразу по
// дефолту добавь в автовыбор чтобы готовые были на партнере VC") ----------------------------------
// Every landingpage VC's Content Arb list showed ACTIVE on 23.10 (the 9 "Creation Failed" rows have no
// link), each with Tracking = VC_PIXEL + Purchase, each answering 200 in English — plus the three
// Black Friday landingpages the owner created on 05.11 (ask: «3 последние лендинга которые я создал по
// black friday, добавь их в наш адлаунчер»), whose Tracking (read in VC 05.11) fires LEAD into the
// S-1 nik pixel 2126539511577664 instead: `event` tells the two apart — plus the fifteen quizzes of 10.11
// (five niches × EN / ES / PT, all Lead into the same S-1 nik pixel): `lang` tells those apart. A pick only
// fills the card's link field — any other VC Content Arb link can still be pasted. A new landingpage = one row.

export type VcReadyLink = {
  /** The link exactly as VC prints it (Landingpage → Link). */
  url: string;
  /** The landingpage id — the link's last slug word. */
  id: string;
  /** The landingpage's niche (the part of its VC name before " | ") — the picker's section. */
  niche: string;
  /** The landingpage's name after the niche. */
  title: string;
  /** The event the landingpage's VC Tracking fires through the Conversions API: the 23.10 nine fire
   *  PURCHASE into VC_PIXEL; the Black Friday three (05.11) fire LEAD into the S-1 nik pixel
   *  2126539511577664 — a launch on them should optimize THAT event on THAT dataset. */
  event: "PURCHASE" | "LEAD";
  /** The language the quiz is written in (its VC locale: en-US / es-US / pt-BR) — the picker's tag. */
  lang: "EN" | "ES" | "PT";
};

const ready = (
  slug: string,
  id: string,
  niche: string,
  title: string,
  event: VcReadyLink["event"] = "PURCHASE",
  lang: VcReadyLink["lang"] = "EN",
): VcReadyLink => ({
  url: `https://www.qualitydays.com/coa/${slug}-${id}/`,
  id,
  niche,
  title,
  event,
  lang,
});

export const VC_READY_LINKS: readonly VcReadyLink[] = [
  // 10.11 — five personality quizzes, each in English, Spanish (es-US, neutral Latin American) and
  // Portuguese (pt-BR) (owner: «создай новые квизы под нашего партнера VC», then «сделай еще на испанском
  // вариант и на порту», then «добавь нам в лаунчер, чтобы можно было на них запускать»). VC Tracking of all
  // fifteen: pixel 2126539511577664 "S-1 nik pixel" + Lead; each answered 200 with its quiz on 10.11. The
  // title is the quiz's own public title, so the campaign name carries it in the quiz's language.
  ready("are-you-more-fire-earth-air-or-water", "l9yz5jh8al", "Astrology / Zodiac", "Are You More Fire, Earth, Air, or Water?", "LEAD"),
  ready("eres-mas-fuego-tierra-aire-o-agua", "5m5zpgj36a", "Astrology / Zodiac", "¿Eres más fuego, tierra, aire o agua?", "LEAD", "ES"),
  ready("voce-e-mais-fogo-terra-ar-ou-agua", "lni5wgxefh", "Astrology / Zodiac", "Você é mais fogo, terra, ar ou água?", "LEAD", "PT"),
  ready("are-you-a-romantic-dreamer-or-a-practical-partner", "afisuync73", "Love / Relationships", "Are You a Romantic Dreamer or a Practical Partner?", "LEAD"),
  ready("eres-un-alma-romantica-o-un-corazon-practico", "l470bp8ioz", "Love / Relationships", "¿Eres un alma romántica o un corazón práctico?", "LEAD", "ES"),
  ready("no-amor-voce-sonha-alto-ou-tem-os-pes-no-chao", "9xih0kcl3c", "Love / Relationships", "No amor, você sonha alto ou tem os pés no chão?", "LEAD", "PT"),
  ready("what-does-your-birthday-number-represent", "63lpxyt9f6", "Numerology / Life Path", "What Does Your Birthday Number Represent?", "LEAD"),
  ready("que-representa-tu-numero-de-cumpleanos", "azumevchez", "Numerology / Life Path", "¿Qué representa tu número de cumpleaños?", "LEAD", "ES"),
  ready("o-que-o-seu-numero-de-aniversario-representa", "1582t0n3uf", "Numerology / Life Path", "O que o seu número de aniversário representa?", "LEAD", "PT"),
  ready("are-you-more-the-star-the-sun-or-the-empress", "iizi7oluss", "Tarot / Intuition", "Are You More The Star, The Sun, or The Empress?", "LEAD"),
  ready("eres-mas-la-estrella-el-sol-o-la-emperatriz", "v114lsuae4", "Tarot / Intuition", "¿Eres más La Estrella, El Sol o La Emperatriz?", "LEAD", "ES"),
  ready("voce-e-mais-a-estrela-o-sol-ou-a-imperatriz", "0t3j63tlvo", "Tarot / Intuition", "Você é mais a Estrela, o Sol ou a Imperatriz?", "LEAD", "PT"),
  ready("are-you-a-cozy-evening-or-outdoor-escape-person", "9219428wfo", "Self-Care / Inner Balance", "Are You a Cozy Evening or Outdoor Escape Person?", "LEAD"),
  ready("eres-de-noches-acogedoras-o-de-escapadas-al-aire-libre", "0tda2xyfd5", "Self-Care / Inner Balance", "¿Eres de noches acogedoras o de escapadas al aire libre?", "LEAD", "ES"),
  ready("voce-e-do-tipo-noite-aconchegante-ou-aventura-ao-ar-livre", "y83zpkdt2f", "Self-Care / Inner Balance", "Você é do tipo noite aconchegante ou aventura ao ar livre?", "LEAD", "PT"),
  // Black Friday (owner 05.11) — VC Tracking: pixel 2126539511577664 "S-1 nik pixel" + Lead; each 200, en-US
  ready("what-is-your-black-friday-shopping-superpower", "d3k4c7b7ek", "Black Friday / Shopping", "What Is Your Black Friday Shopping Superpower?", "LEAD"),
  ready("are-you-a-smart-planner-or-a-spontaneous-shopper", "kcvhp9yt0f", "Black Friday / Shopping", "Are You a Smart Planner or a Spontaneous Shopper?", "LEAD"),
  ready("what-does-your-black-friday-shopping-style-reveal-about-you", "yqj0on8cgc", "Black Friday / Shopping", "What Does Your Black Friday Shopping Style Reveal About You?", "LEAD"),
  // 23.10 — VC Tracking: VC_PIXEL + Purchase
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

export type VcEvent = "PURCHASE" | "LEAD";
export type VcDelivery = { objective: string; optimization: Campaign["optimization"]; pixel: string; conversionEvent?: VcEvent };

/** The card's Optimization pick on the VC rail (lib/catalog VC_OPTIMIZATIONS): Purchase on VC_PIXEL
 *  ("conversions" — a fresh card's default), Lead on VC_LEAD_PIXEL ("lead", owner ask 05.11: «возможность
 *  заливать на событие Lead»), or Traffic / link clicks with no pixel ("clicks"). */
export type VcMode = "conversions" | "lead" | "clicks";

/** The mode a card is in, read off the two fields that encode it — the optimization (conversions /
 *  clicks) and, for conversions, the event (LEAD = the Lead mode; anything else = Purchase). A card
 *  of another partner's draft (optimization "conversions" + some other event) reads as Purchase. */
export function vcModeOf(c: Pick<Campaign, "optimization" | "conversionEvent">): VcMode {
  if (c.optimization === "clicks") return "clicks";
  return c.conversionEvent === "LEAD" ? "lead" : "conversions";
}

/**
 * What a card's mode (and bid strategy) means on the VC rail: Purchase — and min-ROAS, which always
 * optimizes purchase VALUE, whatever the mode — = Sales optimizing PURCHASE on VC_PIXEL; Lead = a Leads
 * campaign optimizing LEAD on VC_LEAD_PIXEL (the dataset VC's Lead landingpages fire into); clicks =
 * Traffic / link clicks with no pixel. Anything else reads as Purchase. The ONE mapping the card, the
 * locks and the launch route all use — pass vcModeOf(card) for a card.
 */
export function vcDelivery(mode: string, bidStrategy = ""): VcDelivery {
  const roas = bidKind(bidStrategy) === "roas";
  if (mode === "clicks" && !roas) return { objective: VC_TRAFFIC_OBJECTIVE, optimization: "clicks", pixel: "" };
  if (mode === "lead" && !roas) return { objective: VC_LEADS_OBJECTIVE, optimization: "conversions", pixel: VC_LEAD_PIXEL.id, conversionEvent: "LEAD" };
  return { objective: VC_SALES_OBJECTIVE, optimization: "conversions", pixel: VC_PIXEL.id, conversionEvent: "PURCHASE" };
}

/** The mode a ready landingpage's VC Tracking asks for (its `event`, 05.11): Lead → "lead", else Purchase. */
export const vcReadyMode = (event: VcReadyLink["event"]): VcMode => (event === "LEAD" ? "lead" : "conversions");

/**
 * A READY landingpage whose VC Tracking fires one event, launched to optimize the other — the ad set would
 * wait for an event the page never sends (a Black Friday quiz fires Lead into the S-1 nik pixel; a Purchase
 * launch on it optimizes PURCHASE on the VC pixel). "" = they agree, or nothing to compare: link clicks
 * optimize no pixel event, and a landingpage outside the ready list fires who-knows-what. Else the event the
 * page fires — the card names it under Optimization, readiness holds the card, the route refuses the launch.
 */
export function vcReadyEventMismatch(c: Pick<Campaign, "optimization" | "conversionEvent" | "bidStrategy" | "landing">): VcReadyLink["event"] | "" {
  const ready = vcReadyLinkOf(c.landing);
  if (!ready) return "";
  const d = vcDelivery(vcModeOf(c), c.bidStrategy);
  if (!d.conversionEvent) return "";
  return d.conversionEvent === ready.event ? "" : ready.event;
}

/** The VC lock for one card (applyPartnerLocks): objective, optimization, pixel and event converge
 *  to vcDelivery of the card's own mode. Empty patch = the card already conforms. */
export function vcLockPatch(r: Campaign): Partial<Campaign> {
  const patch: Partial<Campaign> = {};
  const d = vcDelivery(vcModeOf(r), r.bidStrategy);
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
// ---- the campaign name carries the landingpage's title (owner ask 05.11: «чтобы при запуске в нейминг
// добавлялось название самой статьи») ------------------------------------------------------------------
// The VC "article" is the Content Arb landingpage (quiz) the card points at. Its title joins the name as
// its own " - " segment right after the partner prefix — the AV pattern (lib/av-link pinAvNamePrefix /
// avServerName): the board pins it into the card's LOCKED prefix, the buyer types only the tail, and the
// launch route rebuilds the same name from the RESOLVED link, so the locked part is never the client's word.
//   [05/11] (VC) - Explore Your Dating Style - Tima

const VC_DATE_PREFIX = /^\[\d{2}[./]\d{2}\]\s*\([^)]*\)\s*-\s*/;

/**
 * The landingpage's title for the campaign name: a ready landingpage's own title (VC_READY_LINKS — the
 * name VC shows for it); any other Content Arb link reads its quiz slug as words, first letter up
 * ("explore-your-dating-style" → "Explore your dating style"). "" = not a valid VC link.
 */
export function vcArticleTitle(raw: string): string {
  const d = vcDestination(raw);
  if (!d.ok) return "";
  const ready = VC_READY_LINKS.find((l) => l.id === d.lpId);
  if (ready) return ready.title;
  const u = new URL(d.url);
  const slug = u.pathname.slice("/coa/".length, -1 - d.lpId.length).replace(/-+$/, "");
  const words = slug.split("-").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** The locked name part a VC card carries after the partner prefix: "<title> - " (empty without a valid link). */
export function vcAutoName(landing: string): string {
  const title = vcArticleTitle(landing);
  return title ? `${title} - ` : "";
}

/**
 * The board's name-prefix pin for VC cards (lib/types pinNamePrefix's twin): the partner prefix
 * ("[DD/MM] (VC) - ") plus the landingpage's title as its own segment, so the card shows it under the
 * lock, the launch bay reads it and the buyer's `name` stays the typed tail alone. Identity-preserving —
 * the SAME array when every card already carries its prefix.
 */
export function pinVcNamePrefix<T extends { namePrefix: string; landing: string }>(rows: T[], base: string): T[] {
  let changed = false;
  const next = rows.map((c) => {
    const want = base + vcAutoName(c.landing);
    if (c.namePrefix === want) return c;
    changed = true;
    return { ...c, namePrefix: want };
  });
  return changed ? next : rows;
}

/**
 * The VC campaign name the SERVER builds: the client's "[DD/MM] (VC) - " date prefix (the route then
 * stamps its own partner mark into it), the title of the RESOLVED landingpage link as its own segment,
 * then the buyer's typed tail. A tail that already carries the title as a whole " - " segment (a tab
 * that kept it in the editable field, or a buyer who typed it) is not doubled.
 */
export function vcServerName(clientPrefix: string, clientName: string, landing: string): string {
  const date = VC_DATE_PREFIX.exec(String(clientPrefix ?? ""))?.[0] ?? "";
  const title = vcArticleTitle(landing);
  const tail = String(clientName ?? "").trim();
  if (!title || carriesOwnName(tail, title)) return `${date}${tail}`.trim();
  return `${date}${title}${tail ? ` - ${tail}` : ""}`.trim();
}
