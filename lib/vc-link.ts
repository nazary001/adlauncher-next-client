// VC (ValueClick, app.valueclick.io) — the search-arb (RSOC) partner's link, pixel and delivery
// contract. Pure and dependency-free apart from lib/types, so `node --test` runs it straight
// (lib/partners re-exports it; that file pulls React icons and can't be tested bare).
//
// How a VC campaign works (partner dashboard, read 23.10): the buyer creates a "Landingpage" in VC
// (Search Arb → Landingpages → Create: name, domain QualityDays, traffic source Meta, article title
// + keywords, country/language) and sets its Tracking — Pixel-ID + Conversions API token + event
// Purchase. VC answers with ONE link per landingpage:
//   https://www.qualitydays.com/rsp/<article-slug>/?cmpid=<landingpage id>
// which its Link Generator may extend (sty / hl / sa / terms) and which carries `adtitle` — "the
// Title of the Ad / Creative" VC shows as the referrer ad creative. Clicks are matched by the
// fbclid Meta appends itself; VC fires Purchase (value = a share of the click revenue) into the
// landingpage's pixel through the Conversions API. So the launcher only needs: the pasted link, the
// ad's title in `adtitle`, and the ad set optimizing on the SAME pixel VC fires.
import type { Campaign } from "./types";
import { bidKind } from "./types";

/** The Meta pixel (dataset) the owner set up for launcher-born VC campaigns (23.10). VC fires
 *  Purchase into it through the Conversions API — the landingpage's Tracking must name it. */
export const VC_PIXEL = { id: "1505591128290736", name: "VC pixel" } as const;
/** The VC landingpage's conversion event (Tracking → Conversion-Event). */
export const VC_EVENT = "Purchase";
/** VC partner dashboard — where buyers create landingpages and copy their links. */
export const VC_PORTAL_URL = "https://app.valueclick.io/campaigns/";

/** The pixel-less VC mode: Traffic / link clicks (LINK_CLICKS, no promoted_object). */
export const VC_TRAFFIC_OBJECTIVE = "OUTCOME_TRAFFIC";
/** The default VC mode: Sales, optimizing Purchase on VC_PIXEL (min-ROAS too — VC's events carry a value). */
export const VC_SALES_OBJECTIVE = "OUTCOME_SALES";

/** Hosts VC serves landingpages on (the dashboard's "Domain" select: QualityDays). A landingpage
 *  on a new VC domain = one entry here. Subdomains (www.) are accepted. */
export const VC_HOSTS: readonly string[] = ["qualitydays.com"];

// ---- VC through TOOL (owner ask 23.10: "VC через TOOL без токена") -------------------------------
// A VC campaign can launch on a TOOL session alone: the cabinet comes from TOOL, the page id is typed
// (or picked from the VC token when one is assigned), TOOL itself checks page + pixel at publish.

/** The TOOL project VC's sessions are filed under (TOOL → Sessions → project). */
export const VC_TOOL_PROJECT = "VC";
/** VC's cabinets by name — the ones VC's dashboard lists (GC-VD-C1-DE-4, -5, -38-RSOC, 23.10). */
export const VC_ACCOUNT_NAME_RE = /^GC-VD-C1-DE-/i;

/** A TOOL account row as GET /api/v1/accounts lists it (lib/tool-sessions-model ToolTeamAccount). */
export type VcToolAccount = { account_id: string; name: string; sessions: readonly { id: number }[] };

/**
 * VC's cabinets among TOOL's live accounts: named like VC's (VC_ACCOUNT_NAME_RE) or seen by a session
 * filed under the VC project. `projectOf` answers a session id's project (null = unknown / none).
 */
export function vcToolAccounts<T extends VcToolAccount>(accounts: readonly T[], projectOf: (sessionId: number) => string | null | undefined): T[] {
  const isVcProject = (id: number): boolean => String(projectOf(id) ?? "").trim().toUpperCase() === VC_TOOL_PROJECT;
  return accounts.filter((a) => VC_ACCOUNT_NAME_RE.test(String(a.name ?? "").trim()) || (a.sessions ?? []).some((s) => isVcProject(s.id)));
}

/** A typed fanpage id (the TOOL path without a VC token): digits only. */
export const isPageId = (v: string): boolean => /^\d{5,30}$/.test(String(v ?? "").trim());

/** The `cmpid` VC prints in every landingpage link (the landingpage id, e.g. "aoz37upzf0"). */
const CMPID_RE = /^[a-z0-9]{6,32}$/i;

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

export type VcDestination = { ok: true; url: string; cmpid: string; host: string } | { ok: false; error: string };

const hostIsVc = (host: string): boolean => VC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Validate + normalize a pasted VC landingpage link. Accepts the link exactly as VC's dashboard
 * prints it (with or without the Link Generator's extras, with or without "https://"); refuses
 * anything that is not a VC landingpage: another host, no `cmpid`, the bare home page, credentials
 * or a port. The normalized URL keeps every query param VC put there (minus a #fragment).
 */
export function vcDestination(raw: string): VcDestination {
  let s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "destination_required — paste the VC landingpage link" };
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
  if (u.pathname === "/" || u.pathname === "") return { ok: false, error: "destination_invalid — that is the VC home page; paste the landingpage link" };
  const cmpid = u.searchParams.get("cmpid") ?? "";
  if (!CMPID_RE.test(cmpid)) {
    return { ok: false, error: "destination_no_cmpid — the link has no cmpid=…; copy it from the landingpage in VC" };
  }
  u.protocol = "https:";
  u.hash = "";
  return { ok: true, url: u.toString(), cmpid, host };
}

/** The title VC wants in `adtitle` — the ad's headline as the creative shows it (fb-launch maps
 *  headline || title onto the ad's bold title). */
export function vcAdTitle(c: Pick<Campaign, "title" | "headline">): string {
  return String(c.headline || c.title || "").trim();
}

/** Role-tagged link segments (lib/partners LinkSegment shape) for the card's colored preview. */
export type VcLinkSegment = { text: string; role: "base" | "slug" | "params" | "gcmKey" | "gcm" };

/**
 * The launched link as segments: the normalized landingpage link with `adtitle` set to the ad's
 * title (replacing whatever the pasted link carried — VC wants the title of THIS ad; an empty title
 * keeps the pasted one). Empty when the destination is not a valid VC link.
 */
export function vcLinkSegments(raw: string, adTitle: string): VcLinkSegment[] {
  const d = vcDestination(raw);
  if (!d.ok) return [];
  const u = new URL(d.url);
  const title = String(adTitle ?? "").trim();
  if (title) u.searchParams.set("adtitle", title);
  const full = u.toString();
  const q = full.indexOf("?");
  const head = full.slice(0, q);
  const cut = head.replace(/\/$/, "").lastIndexOf("/");
  const segs: VcLinkSegment[] = [
    { text: head.slice(0, cut + 1), role: "base" },
    { text: head.slice(cut + 1), role: "slug" },
  ];
  // The query, with the adtitle value highlighted (it is the part the launcher writes).
  const query = full.slice(q);
  const m = /([?&]adtitle=)([^&]*)/.exec(query);
  if (!m) segs.push({ text: query, role: "params" });
  else {
    if (m.index > 0) segs.push({ text: query.slice(0, m.index), role: "params" });
    segs.push({ text: m[1], role: "gcmKey" }, { text: m[2], role: "gcm" });
    const rest = query.slice(m.index + m[0].length);
    if (rest) segs.push({ text: rest, role: "params" });
  }
  return segs;
}

/** The joined link (what the ad actually points at). Empty when the destination is not valid. */
export function vcLink(raw: string, adTitle: string): string {
  return vcLinkSegments(raw, adTitle)
    .map((s) => s.text)
    .join("");
}
