// Which TEAM this deployment of the launcher serves (owner ask 08.10: "такой же точно ad launcher
// только для другой команды … вход с других акаунтов … только HS партнер … запуски только через
// Lion api … полностью разделено с командой glo 01").
//
// ONE codebase, ONE deployment per team. NEXT_PUBLIC_ADL_TEAM is inlined at build time into the
// client bundle AND the server of the same build (Next replaces the literal `process.env.NEXT_PUBLIC_*`
// reference everywhere), so the UI and the server gates of a build can never disagree. Unset = glo-01 =
// the launcher exactly as it was before teams existed.
//
// Everything a team may or may not use is decided HERE and only here:
//   • the UI hides what the team does not have (partners, launch channels, platform tabs, owner tools);
//   • the SERVER refuses it — proxy.ts by route path, the launch queue by job kind, lib/lion by profile;
//   • each team lives in its own Mongo DATABASE on the shared cluster, under its own AUTH_SECRET /
//     CRON_SECRET / LION key — and the session cookie carries the team (lib/session).
//
// Import-free and pure on purpose: loaded by proxy.ts, by client components and by `node --test`.

export type TeamId = "glo-01" | "glo-02";
export const DEFAULT_TEAM: TeamId = "glo-01";

/** FB-board partner ids (= lib/partners PartnerId; repeated here so this file imports nothing). */
export type TeamPartner = "br" | "in" | "us" | "av";
/** How an HS campaign can be submitted: the LION weapons, our own FB tokens, or the TOOL sessions. */
export type HsChannel = "lion" | "token" | "tool";
export type TeamPlatform = "google" | "tiktok" | "snap";
export type OwnerTool = "accounts" | "autoLandings" | "tokens" | "sessions" | "avKeys";

export type TeamConfig = {
  id: TeamId;
  /** The mark shown in the header, on the login card and in the tab title — also the LION ACR the
   *  team's key carries ("GLO-01"). */
  label: string;
  /** FB-board partners the team works with, in switcher order. Every other partner is HIDDEN. */
  partners: readonly TeamPartner[];
  /** Where a bare URL / an unknown ?partner= lands. */
  defaultPartner: TeamPartner;
  hsChannels: readonly HsChannel[];
  /** Platform tabs next to Facebook. A platform listed here still needs its own NEXT_PUBLIC_*_ENABLED
   *  build flag (the dormant-on-prod pattern); one that is NOT listed does not exist for the team. */
  platforms: readonly TeamPlatform[];
  ownerTools: readonly OwnerTool[];
  /** The hs-tools pages registry tracks this team's fanpages: the fanka OK-gate (only `ok` pages
   *  launch), the fill meters and the usage ledger. Without it every page LION lists for a profile
   *  is offered and accepted, nothing is reported to the box and the pickers carry no meters. */
  pagesRegistry: boolean;
  /** LION pools whose slug carries no team prefix (globecoders-RENT-*) — the first team's. */
  sharedPools: boolean;
  /** Logins are the shared tools directory (`gc.up_users`, same accounts as Amazon Tools, with the
   *  lazy Strapi password migration). false = the team's own user list in its own database. */
  toolsDirectory: boolean;
  /** An API route this file does not classify: allowed (the first team — nothing may break there
   *  because a route was forgotten here) or refused (a restricted team fails closed). */
  openApi: boolean;
};

const TEAMS: Record<TeamId, TeamConfig> = {
  "glo-01": {
    id: "glo-01",
    label: "GLO-01",
    partners: ["br", "in", "us", "av"],
    defaultPartner: "in",
    hsChannels: ["lion", "token", "tool"],
    platforms: ["google", "tiktok", "snap"],
    ownerTools: ["accounts", "autoLandings", "tokens", "sessions", "avKeys"],
    pagesRegistry: true,
    sharedPools: true,
    toolsDirectory: true,
    openApi: true,
  },
  // The second team (08.10): only the HS partner, only through LION, Facebook only. Its fanpages are
  // not in the hs-tools registry (probed 08.10: 0 of 10), so the fanka gate cannot judge them.
  "glo-02": {
    id: "glo-02",
    label: "GLO-02",
    partners: ["br"],
    defaultPartner: "br",
    hsChannels: ["lion"],
    platforms: [],
    ownerTools: ["accounts"],
    pagesRegistry: false,
    sharedPools: false,
    toolsDirectory: false,
    openApi: false,
  },
};

export const TEAM_IDS = Object.keys(TEAMS) as TeamId[];

/** The team an env value names. Unset / empty = the first team. A value that names NO team throws:
 *  a typo must never fall back to the first team's full access. */
export function teamConfig(raw: string | null | undefined): TeamConfig {
  const id = String(raw ?? "").trim().toLowerCase();
  if (!id) return TEAMS[DEFAULT_TEAM];
  const team = (TEAMS as Record<string, TeamConfig | undefined>)[id];
  if (!team) throw new Error(`NEXT_PUBLIC_ADL_TEAM="${raw}" names no team — use one of: ${TEAM_IDS.join(", ")}`);
  return team;
}

/** This deployment's team. The literal env reference is what the build inlines — keep it literal. */
export const TEAM: TeamConfig = teamConfig(process.env.NEXT_PUBLIC_ADL_TEAM);

// ---- what a route / job / tool needs ---------------------------------------------------------------

export type Need =
  | "always"
  | `partner:${TeamPartner}`
  /** At least one direct-Graph partner (MO / AIF / AV) — their shared clone board and task drawers. */
  | "graph"
  | `channel:${"token" | "tool"}`
  /** Our own FB tokens exist for the team at all: a Graph partner or the HS token rail. */
  | "fbTokens"
  | `platform:${TeamPlatform}`
  | "platform:any"
  | `tool:${OwnerTool}`
  /** The pre-S3 Vercel Blob upload broker — only tabs opened before the S3 release still call it. */
  | "legacyBlob";

const GRAPH_PARTNERS: readonly TeamPartner[] = ["in", "us", "av"];

export function teamHas(need: Need, team: TeamConfig = TEAM): boolean {
  if (need === "always") return true;
  if (need === "graph") return GRAPH_PARTNERS.some((p) => team.partners.includes(p));
  if (need === "fbTokens") return teamHas("graph", team) || team.hsChannels.includes("token");
  if (need === "platform:any") return team.platforms.length > 0;
  if (need === "legacyBlob") return team.id === DEFAULT_TEAM;
  const [kind, value] = need.split(":") as [string, string];
  if (kind === "partner") return team.partners.includes(value as TeamPartner);
  // The token / TOOL rails are HS channels first; MO / AIF only ride them where HS has them.
  if (kind === "channel") return team.hsChannels.includes(value as HsChannel);
  if (kind === "platform") return team.platforms.includes(value as TeamPlatform);
  if (kind === "tool") return team.ownerTools.includes(value as OwnerTool);
  return false;
}

// Route → need, most specific first. A row matches the path itself and everything under it
// ("/api/hs" matches "/api/hs/launch", never "/api/hs-tasks"). tests/team.test.ts walks app/ and
// fails when a route or page is missing here — classify it when you add one.
const API_NEEDS: ReadonlyArray<readonly [string, Need]> = [
  ["/api/auth", "always"],
  // HS: the FB-token and TOOL rails are their own routes; the rest of /api/hs is the LION rail.
  ["/api/hs/token-launch", "channel:token"],
  ["/api/hs/token-duplicate", "channel:token"],
  ["/api/hs/token-jurar", "channel:token"],
  ["/api/hs/token-status", "channel:token"],
  ["/api/hs/token-cron", "channel:token"],
  ["/api/hs/tool-launch", "channel:tool"],
  ["/api/hs/tool-duplicate", "channel:tool"],
  ["/api/hs", "partner:br"],
  ["/api/hs-tasks", "partner:br"],
  ["/api/tool", "channel:tool"],
  ["/api/tool-sessions", "channel:tool"],
  ["/api/fb-tokens", "fbTokens"],
  // The server-side launch queue serves every rail; what a JOB may be is teamAllowsJob below.
  ["/api/launch-queue", "always"],
  ["/api/launch-tasks", "graph"],
  ["/api/launch", "partner:in"],
  ["/api/clone", "graph"],
  ["/api/adaccounts", "partner:in"],
  ["/api/fanpages", "partner:in"],
  ["/api/fanpage-volume", "partner:in"],
  ["/api/gcm", "partner:in"],
  ["/api/landings", "partner:in"],
  ["/api/auto-landings", "tool:autoLandings"],
  ["/api/aif", "partner:us"],
  ["/api/av", "partner:av"],
  ["/api/google-tasks", "platform:google"],
  ["/api/google", "platform:google"],
  ["/api/tiktok-tasks", "platform:tiktok"],
  ["/api/tiktok", "platform:tiktok"],
  ["/api/snap-tasks", "platform:snap"],
  ["/api/snap", "platform:snap"],
  ["/api/wave-status", "platform:any"],
  ["/api/acct-limit", "always"],
  ["/api/acct-assignments", "tool:accounts"],
  ["/api/team", "tool:accounts"],
  ["/api/creatives", "always"],
  ["/api/blob-upload", "legacyBlob"],
];

const PAGE_NEEDS: ReadonlyArray<readonly [string, Need]> = [
  ["/login", "always"],
  ["/clone", "always"],
  ["/accounts", "tool:accounts"],
  ["/auto-landings", "tool:autoLandings"],
  ["/tokens", "tool:tokens"],
  ["/sessions", "tool:sessions"],
  ["/av", "tool:avKeys"],
  ["/google", "platform:google"],
  ["/tiktok", "platform:tiktok"],
  ["/snap", "platform:snap"],
];

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
const isApiPath = (path: string): boolean => under(path, "/api");

/** What a path needs, or null when this file does not know it. */
export function routeNeed(pathname: string): Need | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/" || path === "") return "always";
  for (const [prefix, need] of isApiPath(path) ? API_NEEDS : PAGE_NEEDS) if (under(path, prefix)) return need;
  return null;
}

/** May this team reach the path at all? An unknown API route follows the team's `openApi`; an unknown
 *  non-API path (an asset, a framework internal) always passes — only classified pages are refused. */
export function teamAllowsPath(pathname: string, team: TeamConfig = TEAM): boolean {
  const need = routeNeed(pathname);
  if (need === null) return isApiPath(pathname) ? team.openApi : true;
  return teamHas(need, team);
}

// ---- the launch queue --------------------------------------------------------------------------

const SCOPE_PARTNER: Record<string, TeamPartner> = { hs: "br", mo: "in", aif: "us", av: "av" };
const HS_KIND_CHANNEL: Record<string, HsChannel> = { "hs.lion": "lion", "hs.token": "token", "hs.tool": "tool" };

/** May this team hand over / run a queue job of this scope and kind? The runner calls the launch
 *  handlers IN-PROCESS (no HTTP hop → proxy.ts never sees a queued launch), so the queue asks here
 *  itself, at enqueue and again before dispatch. Unknown scope or an HS kind without a channel = no. */
export function teamAllowsJob(scope: string, kind: string, team: TeamConfig = TEAM): boolean {
  const partner = SCOPE_PARTNER[scope];
  if (!partner || !team.partners.includes(partner)) return false;
  if (scope !== "hs") return !kind.startsWith("hs.");
  const channel = HS_KIND_CHANNEL[kind];
  return Boolean(channel) && team.hsChannels.includes(channel);
}

// ---- LION profiles -----------------------------------------------------------------------------

// LION's profile list is COMPANY-WIDE: every team's key returns every team's profiles and may read
// and launch on any of them (probed 08.10 — both keys answer the same 26 rows, readonly:false). The
// team is the slug's own prefix ("glo-02-3"), so the separation is enforced by us, on that prefix.
const TEAM_SLUG = /^(glo-\d+)-/i;

/** Does this profile belong to the team? Un-prefixed pools (globecoders-RENT-*) are the first team's. */
export function teamOwnsProfile(slug: string, team: TeamConfig = TEAM): boolean {
  const s = String(slug ?? "").trim();
  if (!s) return false;
  const m = TEAM_SLUG.exec(s);
  return m ? m[1].toLowerCase() === team.id : team.sharedPools;
}

/** A LION key of ANOTHER team on this build is a deployment mistake that would launch one team's
 *  campaigns under the other's name: the reason to refuse every LION call, or null when the ACR is
 *  this team's (or names no team at all). */
export function teamAcrProblem(acr: string | null | undefined, team: TeamConfig = TEAM): string | null {
  const a = String(acr ?? "").trim().toLowerCase();
  if (!/^glo-\d+$/.test(a) || a === team.id) return null;
  return `lion_team_mismatch — this launcher is built for ${team.label} but LION_ACR is ${a.toUpperCase()}; fix NEXT_PUBLIC_ADL_TEAM or the LION key`;
}

// ---- the store ---------------------------------------------------------------------------------

const DB_TEAM_TAG = /glo[-_]?(\d+)/i;

/** May this team run on this Mongo database? Every team but the first lives in a database named
 *  after it (gc_glo02, gc_glo02_test); the first one keeps `gc` / `gc_test` and must never be pointed
 *  at another team's. A wrong pairing would mix users, the launch queue and the task registry. */
export function teamAllowsDb(dbName: string, team: TeamConfig = TEAM): boolean {
  const m = DB_TEAM_TAG.exec(String(dbName ?? ""));
  const tagged = m ? `glo-${m[1].padStart(2, "0")}` : null;
  return tagged === null ? team.id === DEFAULT_TEAM : tagged === team.id;
}

/** Namespace for values two teams must not share inside one store (S3 object owner tags): empty for
 *  the first team — its keys stay byte-identical to the pre-team ones. */
export const teamNamespace = (team: TeamConfig = TEAM): string => (team.id === DEFAULT_TEAM ? "" : team.id);
