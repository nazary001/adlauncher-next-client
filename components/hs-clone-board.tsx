"use client";

import { useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { AutoTextarea, BidKindTag, Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useHs } from "./use-hs";
import { useHsTaskManager } from "./hs-task-manager";
import { decorateAccountOptions, fmtCountdown, useAcctLimits } from "./use-acct-limit";
import { bidKind, limitMoneyCents, moneyCentsLabel, moneyLabel, parseMoney } from "@/lib/types";
import { lionNameSuffix } from "@/lib/hs-clone-name";
import { BID_STRATEGIES, geoSummary } from "@/lib/catalog";
import { HS_TOKEN_MARK, splitHsGrammar, stripTokenMark, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { juroEnsureMark, juroLionStrategyAccepted } from "@/lib/juro";
import { relabelNameGeo } from "@/lib/targeting-override";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "@/lib/pick-defaults";
import type { PartnerId } from "@/lib/partners";
import {
  ChevronDownIcon,
  CopyIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  MinusIcon,
  MoreIcon,
  PlusIcon,
  RetryIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import { HsTargetingModal } from "./hs-targeting-modal";
import { HsDestinationModal, type HsRowDest } from "./hs-destination-modal";
import { hsAllBearersDown, hsTokensAllDown, useHsTokenStatus } from "./hs-token-status";
import type { SessionUser } from "./user-menu";

const MAX_COPIES = 20;
const MAX_SOURCES = 30;

/** One source campaign row: LION-read facts + the editable overrides. */
type Row = {
  id: string;
  campaignId: string;
  /** LION details/targeting — null while loading, "UNREADABLE" status = duplicate would die too. */
  info: {
    name: string;
    status: string;
    countries: string[];
    budget: number | null; // MAJOR $ (LION reads are major)
    bid: number | null;
    bidStrategy: string;
    /** Source account billing currency ("" = unknown) — LION duplicate v2 can't inherit a
     *  monetary bid into an account of another currency (partner docs 09-09). */
    currency: string;
    adsCount: number;
    /** Fanpage(s) the source's ads live on (per-page ad tally from the story ids) — where a JURO
     *  copy lands its ads. [] = underivable → no fanka meter, never blocks. */
    pages: { pageId: string; ads: number }[];
  } | null;
  loading: boolean;
  bid: string; // editable override; "" = inherit from source (safe default)
  /** The row's PICKED bid strategy (seeded with the source's once facts land). May differ from
   *  the source's on every rail (ROAS ↔ cap ↔ cost cap ↔ lowest — owner asks 09-01 / 09-08 /
   *  09-09: the token rails rebuild the ad set, /jurar/ and LION duplicate v2 take
   *  bid_strategy natively). */
  bidStrategy: string;
  /** Editable daily budget — cash-register display ("10,00", digits fill cents) → cents on the wire. */
  budget: string;
  suffix: string;
  /** Targeting override (modal): geo codes (["WW"] = worldwide) — empty = inherit the source's. */
  countries: string[];
  /** Targeting override: FB locale ids from the picked profile — empty = inherit the source's. */
  locales: string[];
  /** The row's OWN destination (owner ask 09-08): profile / account / page / pixel of ITS clones —
   *  null = the wave defaults in Settings. Edited in the Destination modal. */
  dest: HsRowDest | null;
  /** The row's OWN number of copies — "" = the wave default ("Number of copies" in Settings). */
  copies: string;
  /** The LION facts read failed (network / HTTP) — the row offers a manual Retry instead of the
   *  fetch effect hammering a dead LION every debounce tick. The row can still fire "blind"
   *  (the duplicate weapon re-reads the source itself). */
  failed?: boolean;
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

const cellSelect =
  "h-8 w-full cursor-pointer appearance-none rounded-md border border-line bg-surface2 px-2 pr-6 text-[11.5px] text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Human display of a source's OWN bid, formatted by how it bids (BidKindTag names the how):
 *  min-ROAS goal = plain decimal ("0,34" = 34%), cap = "$0,34", lowest = "auto" (no bid at all).
 *  "—" = the bid is unknown right now (roas goals only exist in LION's metrics read — when that
 *  is down the goal is null while the strategy still names the kind). Exotic strategies fall
 *  through to the raw number, unmarked — same honesty rule as the tag. */
function origBidLabel(info: NonNullable<Row["info"]>): string {
  const v = info.bid != null ? String(info.bid).replace(".", ",") : "";
  switch (bidKind(info.bidStrategy)) {
    case "roas":
      return v || "—";
    case "cap":
      return v ? `$${v}` : "—";
    default:
      return info.bidStrategy === "LOWEST_COST_WITHOUT_CAP" ? "auto" : v || "—";
  }
}

/** Split a LION name by its validated grammar (shared splitHsGrammar): the STRUCTURED prefix
 *  `[DD/MM] (ACR) API[ (CLONE)] - (LABEL) - [CODES] - [LANG] - ...` stays fixed (re-dated to
 *  today, "(CLONE)" ensured — that part LION owns), while the free-text TAIL after it is the
 *  buyer's to replace. A source's channel marker ("TOKEN - ", sits right before the tail) is
 *  STRIPPED here: the marker states how a run was CREATED, so the clone re-earns it only from
 *  the rail it fires on — never by inheritance. Unparseable names fall back to
 *  everything-is-tail (marker-stripped all the same). */
function splitLionName(sourceName: string, ddmm: string): { prefix: string; tail: string } {
  const m = splitHsGrammar(sourceName);
  if (!m) return { prefix: "", tail: stripTokenMark(sourceName) };
  let prefix = m.prefix.replace(/^\[\d{2}\/\d{2}\]/, `[${ddmm}]`);
  if (!/\(CLONE\)/.test(prefix)) prefix = prefix.replace(/API/, "API (CLONE)");
  return { prefix, tail: stripTokenMark(m.tail.trim()) };
}

/** Default tail = the source's old tail + " - <owner>" (the buyer duplicating it), matching the
 *  historical LION naming ("… Cars en Alex Nazar"). Editable afterwards; skips the append when
 *  the tail already ends with the owner name so a re-fetch can't double it. */
function withOwner(tail: string, owner: string): string {
  const o = owner.trim();
  if (!o) return tail;
  if (!tail) return o;
  return tail.toLowerCase().endsWith(o.toLowerCase()) ? tail : `${tail} - ${o}`;
}

/** Geo from the NAME's grammar (the `[CODES]` group after the redirect label) — the display
 *  fallback for sources whose targeting/ answers an empty country list (worldwide runs). */
function geoFromName(name: string, summary: (codes: string[]) => string): string {
  const m = /API(?:\s*\(CLONE\))?\s*-\s*\([^)]*\)\s*-\s*\[([^\]]*)\]/.exec(name);
  if (!m) return "";
  const codes = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  if (codes.length === 0) return "";
  if (codes.length === 1 && /^world$/i.test(codes[0])) return "World";
  return summary(codes);
}

const freshRow = (campaignId: string, n: number): Row => ({
  id: `r${Date.now()}-${n}`,
  campaignId,
  info: null,
  loading: false,
  failed: false,
  bid: "",
  bidStrategy: "", // seeded with the source's strategy once the LION facts land
  // Cash-register seed (owner ask 09-08): the field always shows cents, digits fill from the right.
  budget: moneyCentsLabel("10"),
  suffix: "", // becomes the source's old TAIL once LION answers — an editable replacement
  countries: [],
  locales: [],
  dest: null,
  copies: "",
  state: "idle",
});

/** Display label for a row's geo override ("World" for WW, else the summary of the codes). */
const overrideGeoLabel = (codes: string[]): string =>
  codes.includes("WW") ? "World" : geoSummary(codes);

/** A JURO copy's fixed part: the re-dated prefix with the JURO marker instead of "(CLONE)"
 *  (idempotent — a JURO-born source keeps one marker). On the LION channel this is APPROXIMATE
 *  (LION builds the whole name server-side and appends its own family label, live 08-25); on the
 *  FB Token channel it is EXACT — the board's name is what the campaign gets, marker-ensured
 *  again server-side. */
const juroPrefixPreview = (prefix: string): string => juroEnsureMark(prefix);

/**
 * HS duplicator, structured like LION's own duplicator UI: a Settings column (the wave's DEFAULT
 * destination binds + default copies + Preview→Duplicate) and a Selected Campaigns table whose
 * rows show the REAL source facts read from LION (name, countries, original budget/bid,
 * creatives) next to the editable Bid/Budget/Suffix overrides — and, since 09-08, each row's OWN
 * destination (profile / account / page / pixel / copies) that overrides the wave defaults, so
 * one wave fans out across accounts and fankas. Submits go through the mode's route with per-shot
 * binds; successful tasks land in the HS Task Manager already "submitted" and auto-activate after
 * COMPLETED.
 */
export function HsCloneBoard({
  user,
  partner,
  initialIds = [],
  initialMode,
}: {
  user?: SessionUser;
  partner: PartnerId;
  /** Source campaign ids handed over in the link (?ids=…) — one prefilled row each. */
  initialIds?: string[];
  /** Board mode forced by the link (?mode=juro) — wins over the localStorage pick. */
  initialMode?: "clone" | "juro";
}) {
  const hs = useHs(true);
  const { setOpen } = useHsTaskManager();

  const [profile, setProfile] = useState("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [pixel, setPixel] = useState("");
  const [copies, setCopies] = useState("1");
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  // Pre-fire refusal (token pool down / wave over the per-fire cap) — an inline warn box under
  // the fire button instead of a blocking alert() dialog. Cleared on the next preview/gate pass.
  // `juro` = the refusal has a LION-native way out: the note offers the one-click JURO switch.
  const [fireNote, setFireNote] = useState<{ text: string; juro?: boolean } | null>(null);
  // Board mode: the CLONER (duplicate an existing tree) vs JURO (new campaign from the source's
  // page POSTS — no page bind). Each mode carries its own LION-vs-FB-token channel pair (owner
  // ask 08-26): the cloner pair fires /api/hs/duplicate | /api/hs/token-duplicate, the JURO pair
  // /api/hs/jurar | /api/hs/token-jurar. All picks survive refreshes; the token options unlock
  // only once the server says the rail is provisioned.
  const [mode, setMode] = useState<"clone" | "juro">(initialMode ?? "clone");
  const [dupChannel, setDupChannel] = useState<"lion" | "token">("lion");
  const [juroChannel, setJuroChannel] = useState<"lion" | "token">("lion");
  useEffect(() => {
    try {
      const m = localStorage.getItem("adlauncher.hs.mode");
      const v = localStorage.getItem("adlauncher.hs.dupchannel");
      const j = localStorage.getItem("adlauncher.hs.jurochannel");
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR).
      // A link-forced mode (?mode=juro) wins — the remembered pick must not override it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!initialMode && (m === "juro" || m === "clone")) setMode(m);
      // pre-split storage carried the mode inside the channel key ("juro") — map it forward
      else if (!initialMode && v === "juro") setMode("juro");
      if (v === "token" || v === "lion") setDupChannel(v);
      if (j === "token" || j === "lion") setJuroChannel(j);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, [initialMode]);
  const changeMode = (m: "clone" | "juro") => {
    setMode(m);
    setPreviewed(false);
    setFireNote(null);
    try {
      localStorage.setItem("adlauncher.hs.mode", m);
    } catch {
      /* storage disabled */
    }
  };
  const changeDupChannel = (ch: "lion" | "token") => {
    setDupChannel(ch);
    setPreviewed(false);
    setFireNote(null);
    try {
      localStorage.setItem("adlauncher.hs.dupchannel", ch);
    } catch {
      /* storage disabled */
    }
  };
  const changeJuroChannel = (ch: "lion" | "token") => {
    setJuroChannel(ch);
    setPreviewed(false);
    setFireNote(null);
    try {
      localStorage.setItem("adlauncher.hs.jurochannel", ch);
    } catch {
      /* storage disabled */
    }
  };
  const [draftId, setDraftId] = useState("");
  const [targetingRowId, setTargetingRowId] = useState<string | null>(null);
  const [destRowId, setDestRowId] = useState<string | null>(null);
  const counter = useRef(1);
  // One waveId per PREPARED wave (same binds + same shots): a retry-click after a lost answer
  // re-sends the same id, and the server's wave claim makes the re-POST a no-op instead of a
  // second pump (double campaigns). Cleared on confirmed success; regenerated when the wave
  // content changes.
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  const [rows, setRows] = useState<Row[]>(() => {
    const seeded = initialIds
      .filter((id) => /^\d{5,}$/.test(id))
      .slice(0, MAX_SOURCES)
      .map((cid, i) => freshRow(cid, i + 1));
    return seeded;
  });

  const data = profile ? hs.dataFor(profile) : undefined;

  const effDupChannel: "lion" | "token" | "juro" | "juro-token" =
    mode === "juro"
      ? juroChannel === "token" && hs.tokenLaunch
        ? "juro-token"
        : "juro"
      : dupChannel === "token" && hs.tokenLaunch
        ? "token"
        : "lion";
  /** Both FB-Token channels ride the same token pool — one flag for every pool-dependent gate. */
  const tokenRail = effDupChannel === "token" || effDupChannel === "juro-token";
  /** The row's strategy pick WINS on every rail since 09-09: the FB Token rails rebuild the ad
   *  set (owner ask 09-01), LION JURO's /jurar/ takes bid_strategy natively (owner ask 09-08) and
   *  LION duplicate v2 does too (partner docs 09-09 — ROAS ↔ cap ↔ cost cap ↔ lowest). */
  const rowStrategy = (r: Row): string => r.bidStrategy || r.info?.bidStrategy || "";
  const rowSwitched = (r: Row): boolean =>
    r.info !== null && Boolean(r.bidStrategy) && r.bidStrategy !== r.info.bidStrategy;
  /** Strategies pickable on the current rail — LION's jurar documents no COST_CAP; duplicate v2
   *  and the token rails take all four (a source born with an exotic strategy still shows as the
   *  "exotic" option, pickable back = unswitched). */
  const strategyOptions =
    effDupChannel === "juro" ? BID_STRATEGIES.filter((o) => juroLionStrategyAccepted(o.value)) : BID_STRATEGIES;
  // JURO relaunches the source's page POSTS — the ads live on the source post's fanpage, so
  // there is no page bind at all on either channel (LION checks the executor profile's page
  // catalog; the token rail checks our token's own page access — both server-side).
  const needsPage = mode !== "juro";

  // Account launch limit (5 campaigns / 30 min) — feeds the pickers' N/5 badges, the default
  // account pick and the wave gate below.
  const limits = useAcctLimits();
  // FB Token rails: offer only accounts the DUP signer can act on (its grant is its own — 299
  // accs vs the pool's 379 as of 09-03) — LION binds cover segments a token was never granted
  // (aleph, 08-19), and a build there dies on the first Graph POST. null sweep → no filtering
  // (fail open; the server guard still answers with the actionable error).
  const tokenVisible = tokenRail ? (data?.dupTokenAccounts ?? data?.tokenAccounts ?? null) : null;
  const accountOptions =
    tokenVisible !== null ? (data?.accounts ?? []).filter((a) => tokenVisible.has(a.value)) : (data?.accounts ?? []);

  // ---- default binds (owner rule 09-08): the LEAST-LOADED account on our 5/30-min timer and
  // the LEAST-FILLED fanka are what the Settings picks DEFAULT to. Purely derived: an empty pick
  // ("" — nothing chosen, or the × clear) shows and fires the auto value, live as the meters
  // move; a real pick wins via state and the auto value stops mattering. The choice stays.
  const autoAccount = leastLoadedAccount(
    accountLoads(
      accountOptions.map((a) => ({ id: a.value, disabled: a.disabled })),
      limits,
    ),
    limits.limit,
  );
  const autoPage = needsPage
    ? leastFilledPage(
        (data?.pages ?? []).map((p) => {
          const st = hs.pageStats(p.value);
          return { id: p.value, used: st?.used ?? null, limit: st?.limit ?? null, disabled: p.disabled };
        }),
      )
    : "";
  const effAccount = account || autoAccount;
  const effPage = needsPage ? page || autoPage : "";
  const accountIsAuto = !account && Boolean(autoAccount);
  const pageIsAuto = needsPage && !page && Boolean(autoPage);
  const pixels = profile && effAccount ? hs.pixelsFor(profile, effAccount) : undefined;
  // The auto account's pixels load like a picked one's (idempotent loader).
  useEffect(() => {
    if (profile && effAccount) hs.ensurePixels(profile, effAccount);
  }, [profile, effAccount, hs]);

  // A one-pixel account needs no picking — the field DERIVES the lone id (no effect write: the
  // react-compiler lint rejects sync setState in effects, and a derived value can't ever lag the
  // list), but only once the page is picked (owner ask 08-13 — the pixel belongs at the fanka
  // step, not right after the account). A real user pick (multi list) still wins via state.
  const onlyPixel = Array.isArray(pixels) && pixels.length === 1 ? pixels[0].id : "";
  // JURO has no page step — the lone pixel derives right after the account there.
  const effectivePixel = pixel || (effPage || !needsPage ? onlyPixel : "");

  const pickProfile = (slug: string) => {
    setProfile(slug);
    setAccount("");
    setPage("");
    setPixel("");
    setPreviewed(false);
    if (slug) hs.ensureProfile(slug);
  };
  const pickAccount = (id: string) => {
    setAccount(id);
    setPixel("");
    setPreviewed(false);
    if (profile && id) hs.ensurePixels(profile, id);
  };

  // No manual useCallback: the React Compiler memoizes it itself, and its inference of the
  // setter dependency no longer matched the empty manual list (lint react-hooks/preserve-
  // manual-memoization) once the board gained the per-row destination effects.
  const patchRow = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const addSources = () => {
    const ids = [...new Set(draftId.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)))];
    if (ids.length === 0) return;
    setRows((rs) => {
      const have = new Set(rs.map((r) => r.campaignId));
      const fresh = ids
        .filter((id) => !have.has(id))
        .map((id) => freshRow(id, ++counter.current));
      return [...rs, ...fresh].slice(0, MAX_SOURCES);
    });
    setDraftId("");
    setPreviewed(false);
  };
  const removeRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setPreviewed(false);
  };
  /** Re-arm one failed LION read: free the fetch claim and clear the flag — the sources effect
   *  sees a !info/!loading/unclaimed row again and refetches it (event-handler-driven, so a dead
   *  LION is only re-asked when the buyer asks). */
  const retrySource = (r: Row) => {
    fetchedRef.current.delete(r.campaignId.trim());
    patchRow(r.id, { failed: false });
  };

  // ---- source facts from LION (details + targeting), batched + debounced ----
  const fetchedRef = useRef(new Set<string>());
  useEffect(() => {
    const want = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && !r.info && !r.loading);
    const ids = [...new Set(want.map((r) => r.campaignId.trim()))].filter((id) => !fetchedRef.current.has(id));
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      ids.forEach((id) => fetchedRef.current.add(id));
      setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: true } : r)));
      void (async () => {
        try {
          const res = await fetch("/api/hs/sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          });
          const d = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            sources?: Array<{
              campaignId: string;
              name: string;
              status: string;
              countries: string[];
              budget: number | null;
              bid: number | null;
              bidStrategy: string;
              currency?: string;
              adsCount: number;
              pages?: Array<{ pageId: string; ads: number }>;
            }>;
          };
          if (!res.ok || !d?.ok) throw new Error(`HTTP ${res.status}`);
          const byId = new Map((d.sources ?? []).map((s) => [s.campaignId, s]));
          setRows((rs) =>
            rs.map((r) => {
              const s = byId.get(r.campaignId.trim());
              // Answered without this id — same manual-Retry path as a failed call (no auto-loop).
              if (!s) return ids.includes(r.campaignId.trim()) ? { ...r, loading: false, failed: true } : r;
              return {
                ...r,
                loading: false,
                failed: false,
                info: {
                  name: s.name,
                  status: s.status,
                  countries: s.countries,
                  budget: s.budget,
                  bid: s.bid,
                  bidStrategy: s.bidStrategy,
                  currency: s.currency ?? "",
                  adsCount: s.adsCount,
                  pages: Array.isArray(s.pages) ? s.pages : [],
                },
                // Prefill the editable bid with the source's own (LION-UI does the same); the
                // buyer clearing it back to "" means "inherit". Two-decimal comma format on
                // purpose — the field is cash-register (digits fill cents), and "1,2" would
                // re-read as 0,12 there; "1,20" is the stable spelling.
                bid: r.bid || (s.bid != null ? s.bid.toFixed(2).replace(".", ",") : ""),
                // Seed the strategy pick with the source's (the select is locked until facts land).
                bidStrategy: r.bidStrategy || s.bidStrategy,
                // Prefill the editable TAIL with the source's old one + the owner's name.
                suffix: r.suffix || withOwner(splitLionName(s.name, todaySaoPauloDDMM()).tail, user?.username ?? ""),
              };
            }),
          );
        } catch {
          // Failed ids KEEP their fetchedRef claim: deleting it here re-armed the effect on the
          // very rows-change this setState causes → an endless 500ms fetch loop against a dead
          // LION. The row shows "read failed" + a Retry button instead (retrySource re-arms).
          setRows((rs) =>
            rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: false, failed: true } : r)),
          );
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [rows, user?.username]);

  // ---- per-row destination (owner ask 09-08) ------------------------------------------------
  // A row rides the wave defaults (Settings) unless it carries its own tuple; copies likewise.
  // Every wave number below (demand per account / per fanka, the fire cap, the shots) is built
  // from these EFFECTIVE values, never from the Settings column alone.
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  /** A one-pixel account derives its pixel once the page step is done — same rule as the
   *  Settings column, read from the catalog of the ROW's own profile/account. */
  const lonePixelFor = (prof: string, acct: string, pageDone: boolean): string => {
    if (!prof || !acct || !pageDone) return "";
    const list = hs.pixelsFor(prof, acct);
    return Array.isArray(list) && list.length === 1 ? list[0].id : "";
  };
  // FB Token rails: offer only accounts the DUP signer can act on (its grant is its own — 299
  // accs vs the pool's 379 as of 09-03) — LION binds cover segments a token was never granted
  // (aleph, 08-19), and a build there dies on the first Graph POST. null sweep → no filtering
  // (fail open; the server guard still answers with the actionable error).
  const visibleFor = (prof: string): ReadonlySet<string> | null => {
    if (!tokenRail) return null;
    const d = hs.dataFor(prof);
    return d?.dupTokenAccounts ?? d?.tokenAccounts ?? null;
  };
  /** The accounts a row on `prof` may bind (its profile's catalog, token-filtered on the FB
   *  Token rails) — the row pickers' list and the auto pick's candidates. */
  const accountOptionsFor = (prof: string) => {
    const d = hs.dataFor(prof);
    const vis = visibleFor(prof);
    return vis !== null ? (d?.accounts ?? []).filter((a) => vis.has(a.value)) : (d?.accounts ?? []);
  };
  /** Default binds for ANY profile (owner rule 09-08): least-loaded account, least-filled page. */
  const autoAccountFor = (prof: string): string =>
    prof
      ? leastLoadedAccount(
          accountLoads(
            accountOptionsFor(prof).map((a) => ({ id: a.value, disabled: a.disabled })),
            limits,
          ),
          limits.limit,
        )
      : "";
  const autoPageFor = (prof: string): string =>
    needsPage && prof
      ? leastFilledPage(
          (hs.dataFor(prof)?.pages ?? []).map((pg) => {
            const st = hs.pageStats(pg.value);
            return { id: pg.value, used: st?.used ?? null, limit: st?.limit ?? null, disabled: pg.disabled };
          }),
        )
      : "";
  const emptyDest: HsRowDest = { profile: "", account: "", page: "", pixel: "" };
  /** A row's EFFECTIVE binds: its own picks first, the wave Settings for whatever it leaves
   *  empty — resolved down the cascade (owner ask 09-08, inline row pickers): an account belongs
   *  to a profile and a pixel to an account, so a row on ANOTHER profile gets that profile's
   *  auto account / page instead of the wave's, and a row on another account never inherits the
   *  wave's pixel (a one-pixel account still derives its lone pixel once the page step is done). */
  const rowBinds = (r: Row): HsRowDest => {
    const own = r.dest ?? emptyDest;
    const prof = own.profile || profile;
    const sameProfile = prof === profile;
    const acct = own.account || (sameProfile ? effAccount : autoAccountFor(prof));
    const pg = needsPage ? own.page || (sameProfile ? effPage : autoPageFor(prof)) : "";
    const sameAccount = sameProfile && acct === effAccount;
    const pageDone = Boolean(pg) || !needsPage;
    const pix = own.pixel || (sameAccount ? pixel : "") || lonePixelFor(prof, acct, pageDone);
    return { profile: prof, account: acct, page: pg, pixel: pix };
  };
  /** Inline per-field destination edit: only the touched field becomes the row's own — the rest
   *  keeps riding the wave (rowBinds resolves it). Every field empty → back to the wave (null). */
  const patchRowDest = (r: Row, patch: Partial<HsRowDest>) => {
    const next = { ...(r.dest ?? emptyDest), ...patch };
    patchRow(r.id, { dest: next.profile || next.account || next.page || next.pixel ? next : null });
    setPreviewed(false);
    if (next.profile) hs.ensureProfile(next.profile);
  };
  const bindsComplete = (b: HsRowDest): boolean =>
    Boolean(b.profile && b.account && (b.page || !needsPage) && b.pixel);
  const rowCopies = (r: Row): number => {
    const n = Number(r.copies);
    return r.copies !== "" && Number.isFinite(n) && n >= 1 ? Math.min(MAX_COPIES, Math.round(n)) : copiesN;
  };
  // Catalog display names for a row's binds (its own profile's catalog — not the Settings one).
  const accountLabel = (prof: string, id: string): string =>
    hs.dataFor(prof)?.accounts.find((a) => a.value === id)?.label || id;
  const pageLabelOf = (prof: string, id: string): string =>
    hs.dataFor(prof)?.pages.find((p) => p.value === id)?.label || id;
  const pixelLabelOf = (prof: string, acct: string, id: string): string =>
    (hs.pixelsFor(prof, acct) ?? []).find((p) => p.id === id)?.name || id;

  // Rows with their OWN destination may resolve to a profile/account the Settings column never
  // loaded (their own profile's auto account included) — the idempotent loaders fetch what
  // those rows show (names, pixels, token sweeps). Keyed by the resolved pairs, so the effect
  // runs only when a row's binds actually change.
  const ownBindsKey = rows
    .filter((r) => r.dest)
    .map((r) => {
      const bnd = rowBinds(r);
      return `${bnd.profile}|${bnd.account}`;
    })
    .join(",");
  useEffect(() => {
    for (const pair of ownBindsKey.split(",")) {
      const [prof, acct] = pair.split("|");
      if (prof) hs.ensureProfile(prof);
      if (prof && acct) hs.ensurePixels(prof, acct);
    }
  }, [ownBindsKey, hs]);

  const defaultsReady = Boolean(profile && effAccount && (effPage || !needsPage) && effectivePixel);
  // Fireable rows only: a real id, a ≥$1 budget AND not UNREADABLE — an unreadable source's
  // duplicate dies the same way (LION can't read it), so firing it only burns wave slots and the
  // account's 30-min window. Every wave number (totalClones, acct gate, fanka demand) counts the
  // SAME set; excluded rows are flagged in the table instead of silently diverging.
  const validRows = rows.filter(
    (r) =>
      /^\d{5,}$/.test(r.campaignId.trim()) &&
      parseMoney(r.budget) >= 1 &&
      r.info?.status !== "UNREADABLE",
  );
  const unreadable = rows.filter((r) => r.info?.status === "UNREADABLE").length;
  /** Rows skipped ONLY for their sub-$1 budget (amber field + chip — otherwise they vanish silently). */
  const lowBudgetCount = rows.filter(
    (r) =>
      /^\d{5,}$/.test(r.campaignId.trim()) &&
      r.info?.status !== "UNREADABLE" &&
      parseMoney(r.budget) < 1,
  ).length;
  /** Rows whose EFFECTIVE destination is incomplete (an own tuple missing a pick, or the wave
   *  defaults still unpicked) — the wave can't fire until every row resolves. */
  const incompleteRows = validRows.filter((r) => !bindsComplete(rowBinds(r)));
  const bindsReady = validRows.length > 0 && incompleteRows.length === 0;
  const totalClones = validRows.reduce((s, r) => s + rowCopies(r), 0);

  // Account launch limit (5 campaigns / 30 min): EVERY account the wave targets must take its
  // share — an over-capacity account blocks the fire here with the countdown (the server
  // precheck would 429 it anyway).
  const acctDemand = new Map<string, number>();
  for (const r of validRows) {
    const a = rowBinds(r).account;
    if (a) acctDemand.set(a, (acctDemand.get(a) ?? 0) + rowCopies(r));
  }
  const acctShort = [...acctDemand.entries()]
    .map(([acct, need]) => ({
      acct,
      need,
      remaining: Math.max(0, limits.limit - limits.countFor(acct)),
      resetAt: limits.resetAtFor(acct),
    }))
    .filter((x) => x.need > x.remaining);
  const acctOver = acctShort.length > 0;

  // ---- fanka capacity (Meta's per-page ad limit, /api/hs/page-volume meter) -------------------
  // Cloner: every clone rebuilds the source's ads on ITS bound page — demand is summed PER PAGE
  // across the wave (rows may bind different fankas), and every page must fit its free slots.
  // Unloaded rows count 0 (best-effort lower bound); readable sources count at least 1 ad (the
  // duplicate rails ledger the same floor). Unknown meter = fail open, exactly like the pickers
  // (never block on numbers nobody has read).
  const pageDemand = new Map<string, number>();
  if (needsPage) {
    for (const r of validRows) {
      const p = rowBinds(r).page;
      if (!p) continue;
      const ads = r.info && r.info.status !== "UNREADABLE" ? Math.max(r.info.adsCount, 1) : 0;
      pageDemand.set(p, (pageDemand.get(p) ?? 0) + ads * rowCopies(r));
    }
  }
  const pageShort = [...pageDemand.entries()]
    .map(([pageId, need]) => ({ pageId, need, st: hs.pageStats(pageId) }))
    .filter((x): x is { pageId: string; need: number; st: NonNullable<ReturnType<typeof hs.pageStats>> } =>
      x.st !== null && x.need > x.st.free,
    );
  const pageOver = pageShort.length > 0;
  /** The Settings (default) page's own meter + what the wave adds THERE (rows bound to it). */
  const boundPageStats = needsPage && effPage ? hs.pageStats(effPage) : null;
  const pageAdsDemand = effPage ? (pageDemand.get(effPage) ?? 0) : 0;
  const defaultPageOver = pageShort.some((x) => x.pageId === effPage);
  // JURO: ads land on each source's OWN page(s) — demand is summed PER PAGE across the whole
  // wave (two rows on one fanka charge it together), and every page must fit its free slots.
  const juroPageDemand = new Map<string, number>();
  if (mode === "juro") {
    for (const r of validRows) {
      for (const p of r.info?.pages ?? []) {
        juroPageDemand.set(p.pageId, (juroPageDemand.get(p.pageId) ?? 0) + p.ads * rowCopies(r));
      }
    }
  }
  const juroPageOver = (pageId: string): boolean => {
    const st = hs.pageStats(pageId);
    return st !== null && (juroPageDemand.get(pageId) ?? 0) > st.free;
  };
  // Owner rule 09-07: JURO lands on the source's own fanka, which must be OK in hs-tools like any
  // picked page — a known non-OK (or unregistered) state blocks the row here with the reason the
  // server would refuse it with; an unknown state (feed not landed) leaves the verdict to the
  // server gate.
  const juroPageBad = (pageId: string): string | null => {
    const state = hs.pageState(pageId);
    if (state === null || state === "ok") return null;
    return state || "unregistered";
  };
  const juroBadCount =
    mode === "juro"
      ? validRows.filter((r) => (r.info?.pages ?? []).some((p) => juroPageBad(p.pageId) !== null)).length
      : 0;
  const juroBlockedCount =
    mode === "juro"
      ? validRows.filter((r) =>
          (r.info?.pages ?? []).some((p) => juroPageOver(p.pageId) || juroPageBad(p.pageId) !== null),
        ).length
      : 0;
  // Sidebar fanka meter for JURO (owner ask 09-01, narrowed same day): ONLY the fanka(s) the
  // JURO copies actually land on — the source pages of the added rows — each with its live fill
  // and the wave's summed demand (+N, the rows' numbers aggregated where the buyer tunes
  // copies). Names resolve like the row cell: profile catalog → registry → bare id.
  const juroFankaRows =
    mode === "juro"
      ? [...juroPageDemand.entries()].map(([pageId, need]) => {
          const st = hs.pageStats(pageId);
          return {
            pageId,
            name: data?.pages.find((o) => o.value === pageId)?.label || st?.name || pageId,
            need,
            st,
            over: st !== null && need > st.free,
            bad: juroPageBad(pageId),
          };
        })
      : [];
  /** The active mode's fanka verdict — one flag for the fire guard and the button. */
  const fankaOver = mode === "juro" ? juroBlockedCount > 0 : pageOver;
  // A row SWITCHED to cap/ROAS must type a Bid (nothing inherits across strategies) — the fire
  // button blocks here instead of the wave dying per shot in the drawer.
  const strategyBidMissing = validRows.filter(
    (r) => rowSwitched(r) && bidKind(r.bidStrategy) !== "none" && !r.bid.trim(),
  ).length;
  /** Destination currency of a row's account (LION catalog) — "" until the profile data lands. */
  const rowDestCurrency = (r: Row): string => {
    const b = rowBinds(r);
    return (b.profile && b.account && hs.dataFor(b.profile)?.currencies[b.account]) || "";
  };
  /** LION duplicate v2 can't inherit a MONETARY bid into an account of another currency (partner
   *  docs 09-09) — an unswitched cap/cost-cap row whose source bids in another currency than its
   *  destination: with an empty Bid the fire blocks (LION would reject the shot), with a bid the
   *  row is flagged (the number rides in the DESTINATION currency — the prefilled source amount
   *  may need retyping). ROAS goals are multipliers, currency-free. LION duplicate rail only:
   *  JURO builds a fresh ad set, the token rails write Meta-native values themselves. */
  const rowCurrencyGap = (r: Row): { src: string; dest: string } | null => {
    if (effDupChannel !== "lion" || !r.info?.currency || rowSwitched(r) || bidKind(rowStrategy(r)) !== "cap") return null;
    const dest = rowDestCurrency(r);
    return dest && dest !== r.info.currency ? { src: r.info.currency, dest } : null;
  };
  const currencyBidMissing = validRows.filter((r) => rowCurrencyGap(r) !== null && !r.bid.trim()).length;
  const currencyRetype = validRows.filter((r) => rowCurrencyGap(r) !== null && r.bid.trim()).length;

  // The server pump takes the whole wave in ONE call and paces/polls/activates it after the
  // response (fire-and-forget, owner ask 08-14) — its shot cap must fit the pump's time budget.
  // The token rail builds one full Graph tree per shot (much heavier than a LION submit), so its
  // wave cap is tighter (mirrors the server's MAX_TOKEN_SHOTS).
  const MAX_SHOTS_PER_FIRE = 45;
  const MAX_TOKEN_SHOTS_PER_FIRE = 10;
  // The token rails HERE sign with the duplicate/JURO signer (dedicated FB_HS_DUP_TOKEN since
  // 09-03, else the launch pool) — ITS health gates the channel (the server gate refuses waves
  // anyway — this keeps the click honest instead of round-tripping into a 429).
  const tokenStatus = useHsTokenStatus();
  const dupSigner = tokenStatus.dup;
  const tokensDown = tokenStatus.loaded
    ? dupSigner?.dedicated
      ? dupSigner.state !== "ok"
      : hsTokensAllDown(tokenStatus.tokens, tokenStatus.loaded)
    : false;
  // The LION rail's geo-override patch signs with ANY bearer (launch pool or the duplicate
  // signer — server-side since 09-08), so only EVERY bearer being down blocks override waves
  // there; JURO on LION API is the token-free way out (its wire carries the geo natively).
  const bearersDown = hsAllBearersDown(tokenStatus.tokens, tokenStatus.dup, tokenStatus.loaded);
  const overrideRows = validRows.filter((r) => r.countries.length > 0 || r.locales.length > 0);
  const lionOverrideBlocked = effDupChannel === "lion" && overrideRows.length > 0 && bearersDown;

  // "Signs as Peter5gc (Peter 5 GC Acc)" — the owner-visible truth of WHO builds token-rail
  // waves (ask 09-03: entering the cloner must show the new token). Falls back honestly while
  // the status is loading or when no dedicated bearer is configured.
  const signerLabel = dupSigner
    ? `${dupSigner.user || "our FB token"}${dupSigner.app ? ` (${dupSigner.app})` : ""}${dupSigner.dedicated ? "" : " — launch pool"}`
    : "our FB token";

  // A picked account that the rail switch just hid would submit a bind the picker can't display —
  // clear it (and its dependent pixel), same self-heal idiom as the card's unlisted-pixel guard.
  const accountHidden = Boolean(account) && tokenVisible !== null && !tokenVisible.has(account);
  useEffect(() => {
    if (!accountHidden) return;
    // Safe setState-in-effect: converges in one pass (account clears → accountHidden false).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAccount("");
    setPixel("");
    setPreviewed(false);
  }, [accountHidden]);
  /** A row's OWN account the token rail can't act on — flagged on the row, blocks the fire
   *  (the wave-default pick self-heals above; an own pick stays visible so the buyer re-picks). */
  const rowAccountHidden = (r: Row): boolean => {
    if (!r.dest?.account) return false;
    const bnd = rowBinds(r);
    const v = visibleFor(bnd.profile);
    return v !== null && !v.has(bnd.account);
  };
  const hiddenRows = validRows.filter(rowAccountHidden).length;

  const fireBlocked =
    !bindsReady ||
    firing ||
    acctOver ||
    fankaOver ||
    strategyBidMissing > 0 ||
    currencyBidMissing > 0 ||
    hiddenRows > 0 ||
    limits.staleBuild;

  const switchToJuro = () => {
    changeMode("juro");
    changeJuroChannel("lion");
    setFireNote(null);
  };

  async function duplicateAll() {
    if (fireBlocked) return;
    // Token-rail wave while the whole pool is burned → honest local stop (the server gate would
    // refuse it with the same message anyway).
    if (tokenRail && tokensDown) {
      setFireNote({
        text:
          "All FB launch tokens are rate-limited right now — the FB Token rail is blocked until a cooldown lifts. " +
          "Fire on the LION API rail or wait (see the Tokens widget).",
      });
      return;
    }
    // Geo-override LION waves need ONE live bearer for the Graph patch (any of them since
    // 09-08). None left → the LION-native way is JURO: /jurar/ takes the geo in its own wire.
    if (lionOverrideBlocked) {
      setFireNote({
        text:
          "Every FB bearer (launch pool + duplicate signer) is rate-limited/dead right now — targeting-override " +
          "clones on the LION API rail need one for the Graph patch. JURO on the LION API rail applies the geo " +
          "natively without any token: switch these rows to JURO, or clear the overrides, or wait (see the Tokens widget).",
        juro: true,
      });
      return;
    }
    const cap = tokenRail ? MAX_TOKEN_SHOTS_PER_FIRE : MAX_SHOTS_PER_FIRE;
    if (totalClones > cap) {
      setFireNote({
        text:
          `That's ${totalClones} clones — the ${tokenRail ? "FB Token rail builds" : "server fires"} at most ${cap} per wave. ` +
          "Lower the copies or remove some rows and fire in waves.",
      });
      return;
    }
    setFireNote(null);
    setFiring(true);
    // ONE batch POST: the server stamps every row into the shared store, answers immediately and
    // keeps working in the background — jittered single-copy submits, status polling and clone
    // activation all happen server-side, so the tab may be closed right after this resolves.
    // Every shot carries ITS row's destination (per-row binds, 09-08); the wave-level binds in
    // the body are the defaults the server falls back to for bind-less shots (old contract).
    const shots = validRows.flatMap((r) => {
      const cid = r.campaignId.trim();
      const b = rowBinds(r);
      const n = rowCopies(r);
      const overridden = r.countries.length > 0;
      const geo = overridden
        ? overrideGeoLabel(r.countries)
        : r.info?.countries.length
          ? geoSummary(r.info.countries)
          : r.info?.name
            ? geoFromName(r.info.name, geoSummary) || "inherited"
            : "inherited";
      const label = r.info?.name || `#${cid}`;
      // Geo override relabels the name's [CODES] slot too — names must never disagree with the
      // clone's real targeting (their ecosystem parses geo from names).
      const prefix = r.info?.name
        ? relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries)
        : "";
      // The channel marker is re-earned per fire: token waves stamp TOKEN into the fixed part
      // (the server ensures it too), LION waves stay unmarked — splitLionName already stripped
      // any marker the SOURCE was born with.
      const mark = effDupChannel === "token" ? HS_TOKEN_MARK : "";
      return Array.from({ length: n }, (_, copy) => ({
        campaignId: cid,
        budget: r.budget,
        bid: r.bid.trim(),
        // Fallback for the server's bid scaling (its own details/ re-read wins) — the bid
        // rides in HUMAN units and is scaled to LION's Meta-native wire unit server-side.
        ...(r.info?.bidStrategy ? { bidStrategy: r.info.bidStrategy } : {}),
        // The row's SWITCHED strategy — the token rails rebuild the ad set around it, /jurar/ and
        // LION duplicate v2 take it as bid_strategy (unswitched rows omit it = inherit).
        ...(rowSwitched(r) ? { bidStrategyOverride: r.bidStrategy } : {}),
        geo,
        // LION JURO: LION builds the name itself (`… API - JURO - …`) — only the buyer's tail
        // rides as name_suffix. Token JURO: WE own the name — the JURO-marked prefix + the TOKEN
        // marker + tail (the server re-ensures both markers). Cloner rails: fixed grammar prefix
        // + channel marker + tail.
        ...(effDupChannel === "juro"
          ? { suffix: r.suffix.trim() }
          : effDupChannel === "juro-token"
            ? { name: r.info?.name ? `${juroPrefixPreview(prefix)}${HS_TOKEN_MARK}${r.suffix.trim()}`.trim() : r.suffix.trim() }
            : effDupChannel === "token"
              ? r.info?.name
                ? { name: `${prefix}${mark}${r.suffix.trim()}`.trim() }
                : {}
              : {
                  // LION duplicate: LION writes the whole name itself and honours ONLY
                  // name_suffix (partner docs 09-08), so the wire carries the buyer's ADDITION
                  // beyond the source tail (default tail = source tail + owner → just the owner).
                  // The composed name still rides for the row title + geo-override rename.
                  suffix: lionNameSuffix(
                    r.suffix,
                    r.info?.name ? splitLionName(r.info.name, todaySaoPauloDDMM()).tail : "",
                  ),
                  ...(r.info?.name ? { name: `${prefix}${r.suffix.trim()}`.trim() } : {}),
                }),
        // Targeting override — JURO sends it natively in the jurar wire; the other rails patch
        // the clone (token rail: before creating the ad set; LION rail: Graph after birth).
        ...(overridden ? { countries: r.countries } : {}),
        ...(r.locales.length ? { locales: r.locales } : {}),
        // The row's destination — its own tuple or the wave defaults, resolved here so the
        // server never has to guess which rows were overridden.
        profile: b.profile,
        account: b.account,
        ...(needsPage ? { page: b.page } : {}),
        pixel: b.pixel,
        label: n > 1 ? `${label} · copy ${copy + 1}/${n}` : label,
      }));
    });
    // Wave-level defaults for the body: the Settings picks when complete, else the first shot's
    // own tuple (a fully per-row wave may leave Settings blank — old servers still need them).
    const first = shots[0];
    const waveBinds = defaultsReady
      ? { profile, account: effAccount, page: effPage, pixel: effectivePixel }
      : { profile: first.profile, account: first.account, page: first.page ?? "", pixel: first.pixel };
    validRows.forEach((r) => patchRow(r.id, { state: "sending", msg: "queuing on server…" }));
    // The channel is part of the wave's identity — a LION wave retried on the token rail (or
    // vice versa) is a DIFFERENT wave and must not be swallowed by the idempotency claim.
    const sig = JSON.stringify({ channel: effDupChannel, ...waveBinds, shots });
    if (!waveRef.current || waveRef.current.sig !== sig) {
      waveRef.current = { sig, id: crypto.randomUUID() };
    }
    try {
      const endpoint =
        effDupChannel === "token"
          ? "/api/hs/token-duplicate"
          : effDupChannel === "juro"
            ? "/api/hs/jurar"
            : effDupChannel === "juro-token"
              ? "/api/hs/token-jurar"
              : "/api/hs/duplicate";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: waveBinds.profile,
          account: waveBinds.account,
          // JURO has no page bind — the ads live on the source post's own fanpage.
          ...(needsPage ? { page: waveBinds.page } : {}),
          pixel: waveBinds.pixel,
          shots,
          waveId: waveRef.current.id,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; queued?: number; error?: string };
      if (d?.ok) {
        waveRef.current = null; // accepted — the next wave is a new wave
        // Preflight answers now land on the task rows (shared store), not here — the drawer is
        // the place to watch; the board rows just confirm the hand-off.
        validRows.forEach((r) =>
          patchRow(r.id, { state: "ok", msg: `${rowCopies(r)}/${rowCopies(r)} queued — safe to close the tab` }),
        );
        setOpen(true); // the drawer mirrors the server's progress from the shared store
      } else {
        const msg = d?.error ?? `HTTP ${res.status}`;
        validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      validRows.forEach((r) => patchRow(r.id, { state: "error", msg }));
    } finally {
      setFiring(false);
    }
  }

  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    // Cross-rail switch (HS duplicator ↔ MO clone board) is a different server component tree.
    window.location.assign(url.toString());
  };

  /** Preview footer: the wave's clones grouped by destination (one line per distinct tuple). */
  const destSummary = (() => {
    const m = new Map<string, { b: HsRowDest; n: number }>();
    for (const r of validRows) {
      const b = rowBinds(r);
      const key = `${b.profile}|${b.account}|${b.page}|${b.pixel}`;
      const cur = m.get(key);
      if (cur) cur.n += rowCopies(r);
      else m.set(key, { b, n: rowCopies(r) });
    }
    return [...m.values()];
  })();

  return (
    <>
      <Header partner={partner} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (LION-duplicator structure: binds + copies + preview→duplicate) ----
               Sticky AND internally scrollable: on short screens (768p laptops) the card is
               taller than the viewport — without its own scroll the bottom (fire button!) would
               be pinned out of reach. */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                  Settings
                </span>
                <span className="text-[10.5px] leading-snug text-faint">
                  Wave defaults — every row rides these unless it sets its own Destination in the table.
                </span>
              </div>

              {/* board mode (cloner vs JURO), then the mode's own LION-vs-FB-token channel pair —
                  FIRST in the card: the mode decides which binds below even exist (JURO has no
                  Page), so picking it after the binds re-shuffled the form under the pointer.
                  Both token chips ride the launcher's provisioning/cooldown gates (one pool). */}
              <div className="flex flex-col gap-1">
                <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                  {(
                    [
                      { key: "clone" as const, label: "Cloner" },
                      { key: "juro" as const, label: "JURO" },
                    ]
                  ).map((opt) => {
                    const active = mode === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => changeMode(opt.key)}
                        className={
                          "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 " +
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                          (active
                            ? "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                            : "text-dim hover:text-ink")
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                  {[
                    { key: "lion" as const, label: "LION API", ready: true, down: false, hint: undefined as string | undefined },
                    {
                      key: "token" as const,
                      label: "FB Token",
                      ready: hs.tokenLaunch,
                      down: tokensDown,
                      hint: hs.tokenLaunch
                        ? tokensDown
                          ? "The FB token is rate-limited/dead — the rail re-opens after a cooldown (see the Tokens widget)"
                          : `Signs as ${signerLabel}`
                        : "FB token not configured on the server (FB_HS_DUP_TOKEN / FB_HS_LAUNCH_TOKEN)",
                    },
                  ].map((opt) => {
                    const active = (mode === "juro" ? juroChannel : dupChannel) === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        disabled={!opt.ready}
                        aria-pressed={active}
                        title={opt.hint}
                        onClick={() => {
                          if (mode === "juro") changeJuroChannel(opt.key);
                          else changeDupChannel(opt.key);
                        }}
                        className={
                          "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 " +
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                          (active
                            ? opt.down
                              ? "bg-danger/15 text-danger shadow-[inset_0_0_0_1px_rgba(255,107,107,0.35)]"
                              : "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                            : opt.down
                              ? "text-danger/70 hover:text-danger"
                              : "text-dim hover:text-ink") +
                          (opt.ready ? "" : " cursor-not-allowed opacity-40")
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p
                  className={
                    "text-center text-[10px] leading-relaxed " +
                    (tokenRail && tokensDown ? "font-medium text-danger" : "text-faint")
                  }
                >
                  {tokenRail && tokensDown
                    ? dupSigner?.dedicated
                      ? `The ${dupSigner.user || "duplicate/JURO"} token is rate-limited/dead — this rail is blocked until its cooldown lifts; fire on LION API or wait`
                      : "All FB launch tokens are rate-limited — this rail is blocked until a cooldown lifts; fire on LION API or wait"
                    : effDupChannel === "token"
                      ? `Signs as ${signerLabel} · rebuilds each tree · starts +30 min · max ${MAX_TOKEN_SHOTS_PER_FIRE}/wave`
                      : effDupChannel === "juro-token"
                        ? `Signs as ${signerLabel} · relaunches the posts (social proof kept) · starts +30 min · max ${MAX_TOKEN_SHOTS_PER_FIRE}/wave`
                        : effDupChannel === "juro"
                          ? "New campaign from the source's page posts (social proof kept) · geo/languages editable per row · born ACTIVE"
                          : "LION's clone weapon builds on the weapon side"}
                </p>
              </div>

              <Field label="Profile">
                <SearchSelect
                  value={profile}
                  onChange={pickProfile}
                  options={hs.profiles ?? []}
                  placeholder="Search profile"
                  emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
                  // Closed field reads "glo-01-10 · globecoders-44" (slug + LION's label).
                  metaWhenClosed
                />
              </Field>
              <Field
                label="Account"
                // The auto pick names itself: the least-loaded account on the 5/30-min timer.
                hint={
                  accountIsAuto
                    ? `auto · least loaded (${limits.countFor(effAccount)}/${limits.limit} launches in its 30-min window) — pick another to override`
                    : undefined
                }
              >
                <SearchSelect
                  value={effAccount}
                  onChange={pickAccount}
                  options={decorateAccountOptions(accountOptions, limits)}
                  placeholder="Search account"
                  emptyHint={
                    !profile
                      ? "Pick a profile first"
                      : !data
                        ? "Loading…"
                        : tokenVisible !== null && (data.accounts?.length ?? 0) > 0 && accountOptions.length === 0
                          ? "No accounts here are visible to our FB token — use the LION API rail (or another profile)"
                          : "No enabled accounts"
                  }
                />
              </Field>
              {needsPage ? (
                <Field
                  label="Page"
                  // Live fanka meter for the picked page: fill + free slots vs what the rows
                  // bound to it add. Turns into the blocking error when they don't fit (the fire
                  // button locks on the same flag). Unknown meter → no line, no gate; "~" marks
                  // the LION-tally estimate (registry never read this page).
                  hint={
                    effPage && boundPageStats && !defaultPageOver
                      ? `${pageIsAuto ? "auto · least filled · " : ""}${boundPageStats.approx ? "~" : ""}${boundPageStats.used}/${boundPageStats.limit} ads on this page · ${boundPageStats.approx ? "~" : ""}${boundPageStats.free} free` +
                        (pageAdsDemand > 0 ? ` · wave adds ${pageAdsDemand}` : "")
                      : pageIsAuto
                        ? `auto · least filled fanka — pick another to override${data && data.pagesHidden > 0 ? ` · ${data.pagesHidden} hidden (not OK in hs-tools)` : ""}`
                        : !page && data && data.pages.length > 0 && data.pagesHidden > 0
                          ? `${data.pagesHidden} fanka${data.pagesHidden === 1 ? "" : "s"} hidden — not OK in hs-tools`
                          : undefined
                  }
                  error={
                    effPage && boundPageStats && defaultPageOver
                      ? `Won't fit — the wave adds ${pageAdsDemand} ads here, only ${boundPageStats.approx ? "~" : ""}${boundPageStats.free} free (${boundPageStats.approx ? "~" : ""}${boundPageStats.used}/${boundPageStats.limit}). Trim copies/rows or pick another page.`
                      : undefined
                  }
                >
                  <SearchSelect
                    value={effPage}
                    onChange={(v) => {
                      setPage(v);
                      setPreviewed(false);
                    }}
                    options={data?.pages ?? []}
                    placeholder="Search page"
                    emptyHint={
                      !profile
                        ? "Pick a profile first"
                        : !data
                          ? "Loading…"
                          : data.pagesUnavailable
                            ? `No fankas offered — ${data.pagesUnavailable} (only OK fankas may launch)`
                            : data.pagesHidden > 0
                              ? `No OK fankas on this profile — ${data.pagesHidden} hidden by hs-tools status`
                              : "No pages"
                    }
                  />
                </Field>
              ) : (
                <Field label="Page">
                  <div className="flex flex-col gap-1.5">
                    <p className="rounded-lg border border-dashed border-line bg-surface2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
                      JURO reuses the source&apos;s page posts — ads land on the source post&apos;s
                      own fanpage.{" "}
                      {effDupChannel === "juro-token"
                        ? "Our FB token must be able to use that page (checked per shot)."
                        : "The picked profile must carry that page (checked per shot)."}
                    </p>
                    {/* ONLY the fanka(s) this wave's JURO copies land on (the source pages),
                        each with live fill and +N = what the wave adds there — red where it
                        won't fit; the fire button locks on the same check. */}
                    {juroFankaRows.length > 0 ? (
                      <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-surface2/50 px-3 py-2">
                        {juroFankaRows.map((p) => (
                          <div key={p.pageId} className="flex items-center justify-between gap-2">
                            <span className="truncate text-[11px] text-dim" title={`${p.name} · ${p.pageId}`}>
                              {p.name}
                            </span>
                            {p.bad ? (
                              <span
                                className="shrink-0 font-mono text-[10.5px] font-semibold uppercase text-danger"
                                title={`hs-tools marks this fanka ${p.bad.toUpperCase()} — only OK fankas may launch; this source's JURO copies would be refused`}
                              >
                                not OK · {p.bad}
                              </span>
                            ) : p.st ? (
                              <span
                                className={
                                  "shrink-0 font-mono text-[10.5px] tabular-nums " +
                                  (p.over
                                    ? "font-semibold text-danger"
                                    : p.st.limit > 0 && p.st.used / p.st.limit >= 0.8
                                      ? "text-warn"
                                      : "text-faint")
                                }
                                title={
                                  `${p.st.approx ? "~" : ""}${p.st.used} of ${p.st.limit} ad slots used — ` +
                                  `${p.st.approx ? "~" : ""}${p.st.free} free` +
                                  (p.need > 0 ? ` · this wave adds ${p.need}` : "")
                                }
                              >
                                {p.st.approx ? "~" : ""}
                                {p.st.used}/{p.st.limit} · free {p.st.free}
                                {p.need > 0 ? ` · +${p.need}` : ""}
                              </span>
                            ) : (
                              <span className="shrink-0 font-mono text-[10.5px] text-faint">fill unknown</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="px-0.5 text-[11px] leading-snug text-faint">
                        Add source campaigns — the fanka their JURO copies land on shows here
                        with its free slots.
                      </p>
                    )}
                  </div>
                </Field>
              )}
              <Field label="Pixel">
                <SearchSelect
                  value={effectivePixel}
                  onChange={(v) => {
                    setPixel(v);
                    setPreviewed(false);
                  }}
                  options={(pixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                  placeholder="Search pixel"
                  emptyHint={!account ? "Pick an account first" : pixels ? "No pixels on this account" : "Loading…"}
                />
              </Field>
              <Field label="Number of copies" hint={`default per source campaign · max ${MAX_COPIES} · a row can set its own`}>
                <input
                  value={copies}
                  onChange={(e) => {
                    // Clamp AT the field: the wave already fires with copiesN (≤ MAX_COPIES), so a
                    // field reading "99" while the button says "Duplicate 20" lied to the buyer.
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    setCopies(raw !== "" && Number(raw) > MAX_COPIES ? String(MAX_COPIES) : raw);
                    setPreviewed(false);
                  }}
                  onBlur={() => {
                    if (copies === "" || Number(copies) < 1) setCopies("1");
                  }}
                  inputMode="numeric"
                  aria-label="Number of copies"
                  className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] font-mono tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
              </Field>

              <button
                type="button"
                onClick={() => {
                  setPreviewed(true);
                  setFireNote(null);
                }}
                disabled={!bindsReady}
                className={
                  "mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 " +
                  "bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
                  "hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] " +
                  "disabled:cursor-not-allowed disabled:opacity-40 " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>
              {previewed ? (
                <button
                  type="button"
                  onClick={() => void duplicateAll()}
                  disabled={fireBlocked}
                  className={
                    "animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl " +
                    "bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] " +
                    "shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 " +
                    "hover:shadow-[0_10px_36px_rgba(16,185,129,0.5)] hover:brightness-110 active:scale-[0.98] " +
                    "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
                  }
                >
                  <CopyIcon className="h-4 w-4" />
                  {firing
                    ? "Submitting…"
                    : mode === "juro"
                      ? `JURO ${totalClones} cop${totalClones === 1 ? "y" : "ies"}`
                      : `Duplicate ${totalClones} clone${totalClones === 1 ? "" : "s"}`}
                </button>
              ) : null}
              {fireNote ? (
                <div className="animate-pop-in flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">
                  <span>{fireNote.text}</span>
                  {fireNote.juro ? (
                    <button
                      type="button"
                      onClick={switchToJuro}
                      className="mx-auto rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      Switch to JURO (LION API) — geo without a token
                    </button>
                  ) : null}
                </div>
              ) : null}
              {incompleteRows.length > 0 && validRows.length > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {incompleteRows.length === validRows.length && !defaultsReady && incompleteRows.every((r) => !r.dest)
                    ? `Pick the wave defaults (profile · account${needsPage ? " · page" : ""} · pixel) — or set each row's own Destination.`
                    : `${incompleteRows.length} row${incompleteRows.length === 1 ? " has" : "s have"} an incomplete destination — open Destination on ${incompleteRows.length === 1 ? "that row" : "those rows"} (or fill the wave defaults).`}
                </p>
              ) : null}
              {acctOver
                ? acctShort.map((x) => (
                    <p key={x.acct} className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                      Account limit — {accountLabel(rowBinds(validRows.find((r) => rowBinds(r).account === x.acct) ?? validRows[0]).profile, x.acct)}: only {x.remaining} of {x.need} clones fit
                      its 30-min window
                      {x.resetAt ? ` · resets in ${fmtCountdown(x.resetAt, limits.skew)}` : ""}.
                      Trim copies/rows or pick another account.
                    </p>
                  ))
                : null}
              {mode !== "juro" && pageOver
                ? pageShort.map((x) => (
                    <p key={x.pageId} className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                      Fanpage full — {x.st.name || x.pageId}: the wave adds {x.need} ads but it has only{" "}
                      {x.st.approx ? "~" : ""}
                      {x.st.free} free slot{x.st.free === 1 ? "" : "s"} ({x.st.approx ? "~" : ""}
                      {x.st.used}/{x.st.limit}). Trim copies/rows or pick another page.
                    </p>
                  ))
                : null}
              {mode === "juro" && juroBadCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {juroBadCount} source{juroBadCount === 1 ? " sits" : "s sit"} on a fanpage hs-tools
                  doesn&apos;t mark OK — JURO lands the ads there, and only OK fankas may launch.
                  Remove those rows (see the fanka chips under the name).
                </p>
              ) : null}
              {mode === "juro" && juroBlockedCount > juroBadCount ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {juroBlockedCount - juroBadCount} source{juroBlockedCount - juroBadCount === 1 ? "" : "s"}{" "}
                  won&apos;t fit {juroBlockedCount - juroBadCount === 1 ? "its" : "their"} own fanpage
                  (JURO lands the ads there) — see the red fanka chips under the name. Lower
                  copies or remove those rows.
                </p>
              ) : null}
              {strategyBidMissing > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {strategyBidMissing} row{strategyBidMissing === 1 ? " has" : "s have"} a switched
                  strategy without a Bid — type the cap $ / ROAS goal (the source&apos;s bid
                  doesn&apos;t carry across strategies).
                </p>
              ) : null}
              {currencyBidMissing > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {currencyBidMissing} row{currencyBidMissing === 1 ? " clones" : "s clone"} a bid-capped source into an
                  account of another currency without a Bid — LION can&apos;t inherit a monetary bid across
                  currencies; type the cap in the destination currency.
                </p>
              ) : null}
              {currencyRetype > 0 ? (
                <p className="animate-pop-in text-center text-[11px] leading-relaxed text-faint">
                  {currencyRetype} row{currencyRetype === 1 ? "" : "s"}: the source bids in another currency than the
                  destination account — the Bid rides in the destination currency (0,50 BRL ≠ 0,50 USD), retype it
                  if needed.
                </p>
              ) : null}
              {hiddenRows > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {hiddenRows} row{hiddenRows === 1 ? " targets" : "s target"} an account our FB token
                  can&apos;t act on — pick another account on {hiddenRows === 1 ? "that row" : "those rows"} or
                  fire on the LION API rail.
                </p>
              ) : null}
              <p className="text-center text-[10.5px] leading-relaxed text-faint">
                {bindsReady
                  ? previewed
                    ? tokenRail
                      ? "Builds over our FB token · born ACTIVE, starts +30 min"
                      : "Submits to LION · clones activate automatically"
                    : "Preview first, then duplicate"
                  : validRows.length === 0
                    ? "Add source campaigns below"
                    : needsPage
                      ? "Pick profile · account · page · pixel (wave defaults) — or a Destination per row"
                      : "Pick profile · account · pixel (wave defaults) — or a Destination per row"}
              </p>
            </div>
          </aside>

          {/* ---- Selected campaigns ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Selected campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {validRows.length}
              </span>
              {unreadable > 0 ? (
                <span className="rounded-md border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger">
                  {unreadable} unreadable — excluded (their duplicates would fail too)
                </span>
              ) : null}
              {lowBudgetCount > 0 ? (
                <span className="rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10.5px] text-warn">
                  {lowBudgetCount} below $1/day — won&apos;t fire (amber Budget field)
                </span>
              ) : null}
            </div>

            {/* Responsive grid list (owner ask 09-08, same as the MO/AIF board): ONE aligned line
                per row on a wide board, folded lines on a laptop board, a stacked card below
                ~672px — CSS container queries on the list (globals.css `.clone-row`), so the
                layout follows the BOARD's width. The row's destination is edited INLINE (profile
                → account → page → pixel pickers with the live load / fill badges); the modal
                stays for "apply to all rows". */}
            <div className="clone-rows rounded-2xl border border-line bg-surface">
              <div className="clone-row clone-head border-b border-line bg-surface2/40 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                <span className="cr-num text-center">#</span>
                <span className="cr-name">Campaign</span>
                <span className="cr-geo">Geo</span>
                <span className="cr-dest">Destination</span>
                <span className="cr-bid">Strategy · Bid</span>
                <span className="cr-budget">Budget · Copies</span>
                <span className="cr-del" />
              </div>
              {rows.map((r, i) => {
                const unreadableRow = r.info?.status === "UNREADABLE";
                const lowBudget =
                  /^\d{5,}$/.test(r.campaignId.trim()) && !unreadableRow && parseMoney(r.budget) < 1;
                const b = rowBinds(r);
                const own = r.dest !== null;
                const complete = bindsComplete(b);
                const hidden = rowAccountHidden(r);
                const copiesEff = rowCopies(r);
                const strategy = rowStrategy(r);
                const kind = bidKind(strategy);
                const switched = rowSwitched(r);
                const gap = rowCurrencyGap(r);
                const rowData = hs.dataFor(b.profile);
                const rowPixels = b.profile && b.account ? hs.pixelsFor(b.profile, b.account) : undefined;
                const rowAccounts = accountOptionsFor(b.profile);
                // Fixed name part = grammar prefix (re-dated, geo-relabeled) + the FIRE channel's
                // marker (token → TOKEN, live-toggles with the rail switch).
                const fixedName = r.info?.name
                  ? (() => {
                      const p = relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries);
                      if (!p) return r.info.name;
                      if (effDupChannel === "juro") return `${juroPrefixPreview(p)}…`;
                      if (effDupChannel === "juro-token") return juroPrefixPreview(p) + HS_TOKEN_MARK;
                      // LION duplicate: LION fills "<family> <lang> <random5>" itself (ellipsis), then
                      // appends the buyer's addition; token duplicates carry the exact board-built name.
                      return effDupChannel === "token" ? p + HS_TOKEN_MARK : `${p}…`;
                    })()
                  : "";
                const geoInherited = r.info?.countries.length
                  ? geoSummary(r.info.countries)
                  : r.info?.name
                    ? geoFromName(r.info.name, geoSummary) || "inherited"
                    : "";
                return (
                  <div
                    key={r.id}
                    className={
                      "clone-row border-b border-line/60 transition-colors last:border-b-0 hover:bg-raise/25" +
                      (unreadableRow ? " opacity-60" : "")
                    }
                  >
                    <div className="cr-num">
                      <span className="flex h-8 items-center justify-center font-mono text-[12px] text-faint">{i + 1}</span>
                    </div>

                    {/* name — the LION-rebuilt part is FIXED (muted), only the tail is editable;
                        the chips under it carry the source id, its facts (budget · ads · bid)
                        and the fanka(s) its ads live on, with the live fill — always visible
                        (were xl-only columns). */}
                    <div className="cr-name min-w-0">
                      {r.loading ? (
                        <span className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                          Loading from LION…
                        </span>
                      ) : unreadableRow ? (
                        <span className="mb-1 block font-mono text-[10.5px] font-semibold text-danger">
                          LION can’t read this campaign — excluded from the wave
                        </span>
                      ) : !r.info && r.failed ? (
                        <span className="mb-1 block font-mono text-[10.5px] font-semibold text-danger">LION read failed</span>
                      ) : (
                        <span
                          className="mb-1 flex items-center gap-1 truncate font-mono text-[10.5px] text-faint"
                          title={fixedName ? `${fixedName} — fixed, LION's grammar` : undefined}
                        >
                          <LockIcon className="h-2.5 w-2.5 shrink-0" />
                          {fixedName || "—"}
                        </span>
                      )}
                      <AutoTextarea
                        value={r.suffix}
                        onChange={(v) => patchRow(r.id, { suffix: v })}
                        placeholder="tail — edit to rename the clone"
                        ariaLabel="Name suffix"
                        maxLength={80}
                        singleLine
                        className="block w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:bg-surface2/80 focus:ring-2 focus:ring-accent/15"
                      />
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint">
                          #{r.campaignId}
                        </span>
                        {!r.info && r.failed && !r.loading ? (
                          // Manual re-ask (the effect no longer auto-loops a dead LION). The row
                          // can still fire blind — the duplicate weapon re-reads the source.
                          <button
                            type="button"
                            onClick={() => retrySource(r)}
                            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <RetryIcon className="h-3 w-3" />
                            Retry read
                          </button>
                        ) : null}
                        {r.info ? (
                          <span
                            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-faint"
                            title="Source campaign — daily budget · ads · bid (the clone's own settings are on the right)"
                          >
                            <span className="text-dim">src</span>
                            <span>{r.info.budget != null ? `$${moneyLabel(r.info.budget)}` : "—"}</span>
                            <span className="text-dim">·</span>
                            <span>{r.info.adsCount} ads</span>
                            <span className="text-dim">·</span>
                            <BidKindTag strategy={r.info.bidStrategy} />
                            <span>{origBidLabel(r.info)}</span>
                          </span>
                        ) : null}
                        {/* Source fanka(s) + live fill. In JURO mode the copies LAND here, so the
                            chip also shows what the wave needs — red when it won't fit (the fire
                            button locks on the same check). Cloner mode: info only. */}
                        {r.info?.pages.map((p) => {
                          const st = hs.pageStats(p.pageId);
                          const name = data?.pages.find((o) => o.value === p.pageId)?.label || st?.name || p.pageId;
                          const need = juroPageDemand.get(p.pageId) ?? p.ads * copiesEff;
                          const over = mode === "juro" && juroPageOver(p.pageId);
                          // Owner rule 09-07: a JURO source fanka must be OK in hs-tools — a known
                          // non-OK / unregistered state blocks the row (the fire locks on it).
                          const bad = mode === "juro" ? juroPageBad(p.pageId) : null;
                          return (
                            <span
                              key={p.pageId}
                              className={
                                "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] tabular-nums " +
                                (over || bad
                                  ? "border-danger/40 bg-danger/10 text-danger"
                                  : st && st.limit > 0 && st.used / st.limit >= 0.8
                                    ? "border-warn/40 bg-warn/10 text-warn"
                                    : "border-line bg-surface text-faint")
                              }
                              title={
                                `${mode === "juro" ? "JURO copies land here — " : "Source ads live on "}${name} · ${p.pageId}` +
                                (bad ? ` · hs-tools marks this fanka ${bad.toUpperCase()} — only OK fankas may launch; this source's JURO copies would be refused` : "") +
                                (st
                                  ? ` · ${st.approx ? "~" : ""}${st.used} of ${st.limit} ad slots used, ${st.approx ? "~" : ""}${st.free} free` +
                                    (st.approx ? " (LION-tally estimate)" : "") +
                                    (mode === "juro" && need > 0 ? ` · this wave adds ${need}` : "")
                                  : " · fill unknown")
                              }
                            >
                              <span className="truncate text-dim">{name}</span>
                              {bad ? (
                                <span className="font-semibold uppercase">not OK · {bad}</span>
                              ) : st ? (
                                <span>
                                  {st.approx ? "~" : ""}
                                  {st.used}/{st.limit}
                                  {over ? ` · needs ${need}, free ${st.free}` : ""}
                                </span>
                              ) : (
                                <span>fill ?</span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                      {r.state !== "idle" ? (
                        // Wave status lives UNDER the name: full-width, wraps — a real FB/LION
                        // error is readable, not hover-only.
                        <p
                          className={
                            "mt-1.5 break-words font-mono text-[10.5px] leading-snug " +
                            (r.state === "error" ? "text-danger" : r.state === "ok" ? "text-launch2" : "text-[#9db8ff]")
                          }
                        >
                          {r.state === "sending" ? "Submitting…" : (r.msg ?? "—")}
                        </p>
                      ) : null}
                    </div>

                    {/* geo — the whole block opens the targeting editor */}
                    <div className="cr-geo min-w-0">
                      <span className="cr-label">Geo</span>
                      <button
                        type="button"
                        onClick={() => setTargetingRowId(r.id)}
                        title={
                          r.countries.length > 0
                            ? "Geo override — the clone launches with THIS targeting, not the source's · click to edit"
                            : "Inherits the source's targeting · click to override countries / languages"
                        }
                        className="group/geo -m-1 flex max-w-full flex-col items-start gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        {r.countries.length > 0 ? (
                          <span className="flex max-w-full flex-wrap items-center gap-1">
                            <span className="inline-flex max-w-full truncate rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#9db8ff]">
                              {overrideGeoLabel(r.countries)}
                            </span>
                            <span className="rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]">
                              override
                            </span>
                          </span>
                        ) : geoInherited ? (
                          <span className="inline-flex max-w-full truncate rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                            {geoInherited}
                          </span>
                        ) : (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                        {effDupChannel === "lion" && (r.countries.length > 0 || r.locales.length > 0) && bearersDown ? (
                          <span
                            className="text-[10px] font-semibold leading-snug text-warn"
                            title="The LION rail patches the geo through our FB token after LION builds the clone — every bearer is down right now. JURO (LION API) carries the geo natively."
                          >
                            needs an FB token — or JURO
                          </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-dim transition-colors group-hover/geo:text-[#9db8ff]">
                          <GlobeIcon className="h-3 w-3" />
                          Targeting
                        </span>
                      </button>
                    </div>

                    {/* destination — INLINE pickers (owner ask 09-08): profile → account → page →
                        pixel; every field the row leaves empty rides the wave Settings (the
                        cascade re-resolves: another profile brings its own least-loaded account /
                        least-filled page), a pick here overrides just that field (accent border =
                        the row's own). × returns a field to the default, ↺ drops the whole
                        override. Badges: the account's 5/30-min load, the fanka fill. */}
                    <div className="cr-dest min-w-0">
                      <span className="cr-label">Destination</span>
                      <div className="mb-1.5 flex flex-wrap items-center gap-1">
                        {own ? (
                          <>
                            <span
                              className="rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]"
                              title="This row carries its own destination picks — the wave defaults fill only what it leaves empty"
                            >
                              own
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                patchRow(r.id, { dest: null });
                                setPreviewed(false);
                              }}
                              aria-label="Back to the wave defaults"
                              title="Back to the wave defaults"
                              className="inline-flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                            >
                              <UndoIcon className="h-3 w-3" />
                            </button>
                          </>
                        ) : (
                          <span
                            className="rounded border border-line bg-surface2 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-faint"
                            title="Rides the wave defaults from Settings — pick a profile / account / page / pixel here to override just that field"
                          >
                            defaults
                          </span>
                        )}
                        {!complete ? (
                          <span
                            className="text-[10px] font-semibold text-warn"
                            title={needsPage ? "Profile · account · page · pixel not all picked yet" : "Profile · account · pixel not all picked yet"}
                          >
                            incomplete
                          </span>
                        ) : null}
                        {hidden ? (
                          <span
                            className="text-[10px] font-semibold text-danger"
                            title="Our FB token was never granted this account — pick another or fire on LION API"
                          >
                            not on token
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setDestRowId(r.id)}
                          disabled={unreadableRow}
                          aria-label="Destination options"
                          title="Destination options — apply this row's destination and copies to all rows"
                          className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          <MoreIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="cr-dest-picks">
                        <SearchSelect
                          size="sm"
                          value={b.profile}
                          onChange={(v) => patchRowDest(r, { profile: v, account: "", page: "", pixel: "" })}
                          options={hs.profiles ?? []}
                          placeholder="Profile"
                          emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
                          disabled={unreadableRow}
                          warn={!b.profile}
                          accent={Boolean(r.dest?.profile)}
                          ariaLabel={`Profile for row ${i + 1}`}
                        />
                        <SearchSelect
                          size="sm"
                          value={b.account}
                          onChange={(v) => patchRowDest(r, { account: v, pixel: "" })}
                          options={decorateAccountOptions(rowAccounts, limits)}
                          placeholder="Account"
                          emptyHint={
                            !b.profile
                              ? "Pick a profile first"
                              : !rowData
                                ? "Loading…"
                                : visibleFor(b.profile) !== null && (rowData.accounts?.length ?? 0) > 0 && rowAccounts.length === 0
                                  ? "No accounts here are visible to our FB token — use the LION API rail (or another profile)"
                                  : "No enabled accounts"
                          }
                          disabled={unreadableRow}
                          warn={!b.account || hidden}
                          accent={Boolean(r.dest?.account)}
                          ariaLabel={`Account for row ${i + 1}`}
                        />
                        {needsPage ? (
                          <SearchSelect
                            size="sm"
                            value={b.page}
                            onChange={(v) => patchRowDest(r, { page: v })}
                            options={rowData?.pages ?? []}
                            placeholder="Page"
                            emptyHint={!b.profile ? "Pick a profile first" : rowData ? "No pages" : "Loading…"}
                            disabled={unreadableRow}
                            warn={!b.page}
                            accent={Boolean(r.dest?.page)}
                            ariaLabel={`Page for row ${i + 1}`}
                          />
                        ) : (
                          <span
                            className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint"
                            title="JURO copies land on the source post's own fanpage — no page bind on this row"
                          >
                            <LockIcon className="h-3 w-3 shrink-0" />
                            Page · source post’s fanpage
                          </span>
                        )}
                        <SearchSelect
                          size="sm"
                          value={b.pixel}
                          onChange={(v) => patchRowDest(r, { pixel: v })}
                          options={(rowPixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                          placeholder="Pixel"
                          emptyHint={!b.account ? "Pick an account first" : rowPixels ? "No pixels on this account" : "Loading…"}
                          disabled={unreadableRow}
                          warn={!b.pixel}
                          accent={Boolean(r.dest?.pixel)}
                          ariaLabel={`Pixel for row ${i + 1}`}
                        />
                      </div>
                    </div>

                    {/* The CLONE's strategy — switchable per row on every rail (FB Token rails
                        rebuild the ad set; LION JURO and LION duplicate v2 take bid_strategy).
                        The bid field follows the EFFECTIVE strategy: ROAS decimal (blue R) / cap $
                        / nothing on lowest. A kind change clears the typed bid; switching back to
                        the source's kind re-prefills its own bid. */}
                    <div className="cr-bid min-w-0">
                      <span className="cr-label">Strategy · Bid</span>
                      <div className="cr-bid-inner">
                        <div className="relative">
                          <select
                            value={strategy || ""}
                            onChange={(e) => {
                              const bidStrategy = e.target.value;
                              const next = bidKind(bidStrategy);
                              const srcKind = bidKind(r.info?.bidStrategy ?? "");
                              const bid =
                                next === bidKind(strategy)
                                  ? r.bid
                                  : next === srcKind && r.info?.bid != null
                                    ? r.info.bid.toFixed(2).replace(".", ",")
                                    : "";
                              patchRow(r.id, { bidStrategy, bid });
                            }}
                            disabled={!r.info || unreadableRow}
                            aria-label="Clone bid strategy"
                            title={
                              switched
                                ? kind === "roas"
                                  ? "Strategy switched to min ROAS — the clone value-optimizes PURCHASE and needs a value-optimization (VO) pixel; on any other pixel Meta births an ad-less shell"
                                  : "Strategy switched — the clone launches with THIS strategy, not the source's"
                                : "The clone's bid strategy (the source's — switch it to re-bid the clone)"
                            }
                            className={cellSelect + (switched ? " border-accent/50 text-[#9db8ff]" : "")}
                          >
                            {/* An exotic source strategy stays visible (and pickable back) even
                                though it's not in the shared list. */}
                            {strategy && !strategyOptions.some((o) => o.value === strategy) ? (
                              <option value={strategy} className="bg-surface text-ink">
                                {strategy}
                              </option>
                            ) : null}
                            {!strategy ? (
                              <option value="" className="bg-surface text-ink">
                                …
                              </option>
                            ) : null}
                            {strategyOptions.map((o) => (
                              <option key={o.value} value={o.value} className="bg-surface text-ink">
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
                        </div>
                        <div className="relative">
                          {kind !== "none" ? (
                            <span
                              className={
                                "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] " +
                                (kind === "roas" ? "font-semibold text-[#9db8ff]" : "text-faint")
                              }
                            >
                              {kind === "roas" ? "R" : "$"}
                            </span>
                          ) : null}
                          <input
                            value={r.bid}
                            // Cash-register entry, SAME as the launcher's bid/ROAS field: typed
                            // digits fill hundredths from the right (34 → 0,34 · 120 → 1,20).
                            // HUMAN units — the routes scale to Meta-native wire units by the
                            // EFFECTIVE strategy. Empty inherits the source's own bid.
                            onChange={(e) => patchRow(r.id, { bid: limitMoneyCents(e.target.value, kind === "roas" ? 100 : 1000) })}
                            disabled={unreadableRow || (Boolean(r.info) && kind === "none")}
                            placeholder={
                              switched && kind !== "none"
                                ? "required"
                                : gap
                                  ? `required in ${gap.dest}`
                                  : kind === "roas"
                                  ? "inherits ROAS goal"
                                  : kind === "none" && r.info
                                    ? "auto"
                                    : "inherit"
                            }
                            title={
                              kind === "roas"
                                ? "ROAS decimal — 34 → 0,34 (34%)" +
                                  (switched ? " · required for the switched strategy" : " · empty = inherit the source's goal")
                                : kind === "cap"
                                  ? "Bid cap in $ — digits fill cents, 34 → $0,34" +
                                    (switched ? " · required for the switched strategy" : " · empty = inherit the source's cap") +
                                    (gap ? ` · source bids in ${gap.src}, this account is ${gap.dest} — the Bid rides in ${gap.dest}` : "")
                                  : "Lowest cost bids automatically"
                            }
                            inputMode="decimal"
                            aria-label="Bid / ROAS goal"
                            className={
                              cellInput +
                              (kind !== "none" ? " pl-5" : "") +
                              (((switched && kind !== "none") || gap) && !r.bid.trim() ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")
                            }
                          />
                        </div>
                      </div>
                    </div>

                    {/* budget (cash register) + this row's copies (stepper; empty = wave default) */}
                    <div className="cr-budget min-w-0">
                      <span className="cr-label">Budget · Copies</span>
                      <div className="cr-budget-inner">
                        <div className="relative">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">
                            $
                          </span>
                          <input
                            value={r.budget}
                            // Cash-register entry like the ROAS/bid field (owner ask 09-08): the
                            // cents are always visible and typed digits fill them from the right
                            // — 1000 → 10,00 · 1250 → 12,50. Cents ride to the wire as-is.
                            onChange={(e) => patchRow(r.id, { budget: limitMoneyCents(e.target.value, 10000) })}
                            disabled={unreadableRow}
                            inputMode="decimal"
                            placeholder="10,00"
                            aria-label="Daily budget"
                            title={
                              lowBudget
                                ? "Min $1/day — this row won't fire until the budget is raised"
                                : "Daily budget in $ — digits fill cents, 1000 → 10,00"
                            }
                            className={cellInput + " pl-5" + (lowBudget ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")}
                          />
                        </div>
                        <div
                          className={
                            "flex h-8 items-stretch overflow-hidden rounded-md border bg-surface2 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 " +
                            (r.copies ? "border-accent/45" : "border-line hover:border-line2") +
                            (unreadableRow ? " opacity-50" : "")
                          }
                          title={`Copies of this row · empty = the wave default (${copiesN}) · max ${MAX_COPIES}`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              patchRow(r.id, { copies: String(Math.max(1, copiesEff - 1)) });
                              setPreviewed(false);
                            }}
                            disabled={unreadableRow || copiesEff <= 1}
                            aria-label="Fewer copies"
                            className="flex w-7 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <MinusIcon className="h-3 w-3" />
                          </button>
                          <span className="pointer-events-none self-center font-mono text-[10.5px] text-faint">×</span>
                          <input
                            value={r.copies}
                            onChange={(e) => {
                              const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                              patchRow(r.id, { copies: raw !== "" && Number(raw) > MAX_COPIES ? String(MAX_COPIES) : raw });
                              setPreviewed(false);
                            }}
                            onBlur={() => {
                              if (r.copies !== "" && Number(r.copies) < 1) patchRow(r.id, { copies: "" });
                            }}
                            inputMode="numeric"
                            placeholder={String(copiesN)}
                            aria-label="Copies for this row"
                            disabled={unreadableRow}
                            className={
                              "min-w-0 flex-1 bg-transparent px-1 text-center font-mono text-[12px] tabular-nums outline-none placeholder:text-faint disabled:cursor-not-allowed " +
                              (r.copies ? "text-[#9db8ff]" : "text-dim")
                            }
                          />
                          <button
                            type="button"
                            onClick={() => {
                              patchRow(r.id, { copies: String(Math.min(MAX_COPIES, copiesEff + 1)) });
                              setPreviewed(false);
                            }}
                            disabled={unreadableRow || copiesEff >= MAX_COPIES}
                            aria-label="More copies"
                            className="flex w-7 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <PlusIcon className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* remove */}
                    <div className="cr-del">
                      <button
                        type="button"
                        aria-label="Remove row"
                        title="Remove from the wave"
                        onClick={() => removeRow(r.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                      >
                        <TrashIcon className="h-[18px] w-[18px]" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 grow basis-[240px] items-center gap-1.5 sm:grow-0">
                <input
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addSources();
                  }}
                  placeholder="Campaign ID(s) — paste one or a comma list"
                  aria-label="Add source campaign ids"
                  className="h-8 w-full min-w-0 rounded-md border border-line bg-surface2 px-2 font-mono text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 sm:w-[280px]"
                />
                <button
                  type="button"
                  onClick={addSources}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[11.5px] font-medium text-faint transition-colors hover:border-accent/50 hover:text-[#9db8ff]"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add
                </button>
                {rows.length >= MAX_SOURCES ? (
                  // addSources silently .slice()s past the cap — say so instead of eating ids.
                  <span className="shrink-0 rounded-md border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10.5px] text-warn">
                    {rows.length}/{MAX_SOURCES} max
                  </span>
                ) : null}
              </div>
              <p className="min-w-0 text-[10.5px] text-faint">
                Empty Bid = inherits the source’s · MIN_ROAS sources take a ROAS decimal (0,34 = 34%), cap sources $ · budget digits fill cents (1000 → 10,00) · Destination per row overrides the wave defaults · targeting & creatives inherit
              </p>
            </div>

            {/* preview — what exactly will be fired */}
            {previewed ? (
              <div className="animate-pop-in rounded-2xl border border-line bg-surface p-4">
                <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                <div className="flex flex-col gap-1.5">
                  {validRows.map((r) => {
                    const b = rowBinds(r);
                    const n = rowCopies(r);
                    return (
                    <p key={r.id} className="text-[12px] text-dim">
                      <span className="text-ink">
                        {r.info?.name
                          ? (effDupChannel === "juro"
                              ? `${juroPrefixPreview(relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries))}… ${r.suffix.trim()}`
                              : effDupChannel === "juro-token"
                                ? `${juroPrefixPreview(relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries))}${HS_TOKEN_MARK}${r.suffix.trim()}`
                                : effDupChannel === "token"
                                  ? `${relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries)}${HS_TOKEN_MARK}${r.suffix.trim()}`
                                  : `${relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries)}… ${lionNameSuffix(r.suffix, splitLionName(r.info.name, todaySaoPauloDDMM()).tail)}`
                            ).slice(0, 110)
                          : `#${r.campaignId}`}
                      </span>{" "}
                      → {n} cop{n === 1 ? "y" : "ies"} @ ${moneyLabel(r.budget)}/day
                      {rowSwitched(r) ? (
                        <span className="text-[#9db8ff]">
                          {" "}
                          · strategy → {BID_STRATEGIES.find((o) => o.value === r.bidStrategy)?.label ?? r.bidStrategy}
                        </span>
                      ) : null}
                      {r.bid.trim()
                        ? bidKind(rowStrategy(r)) === "roas"
                          ? ` · ROAS ${r.bid}`
                          : ` · bid ${bidKind(rowStrategy(r)) === "cap" ? "$" : ""}${r.bid}`
                        : bidKind(rowStrategy(r)) === "none"
                          ? " · lowest cost"
                          : " · bid inherited"}
                      {r.countries.length > 0 ? (
                        <span className="text-[#9db8ff]"> · geo → {overrideGeoLabel(r.countries)}</span>
                      ) : null}
                      {r.locales.length > 0 ? <span className="text-[#9db8ff]"> · {r.locales.length} lang</span> : null}
                      <span className={r.dest ? "text-[#9db8ff]" : "text-faint"}>
                        {" "}
                        · → {accountLabel(b.profile, b.account)}
                        {needsPage && b.page ? ` · ${pageLabelOf(b.profile, b.page)}` : ""}
                        {r.dest ? " (own)" : ""}
                      </span>
                    </p>
                    );
                  })}
                  <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-2 text-[12px] text-ink">
                    {destSummary.map(({ b, n }) => (
                      <p key={`${b.profile}|${b.account}|${b.page}|${b.pixel}`}>
                        {n} clone{n === 1 ? "" : "s"} → {accountLabel(b.profile, b.account)}{" "}
                        <span className="font-mono text-[11px] text-dim">{b.account}</span>
                        {needsPage ? ` · page ${pageLabelOf(b.profile, b.page)}` : " · ads on the source posts' pages"} · pixel{" "}
                        {pixelLabelOf(b.profile, b.account, b.pixel)} · profile {b.profile}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </main>

      {(() => {
        const r = targetingRowId ? rows.find((x) => x.id === targetingRowId) : null;
        if (!r) return null;
        // Languages come from the ROW's effective profile (its own or the wave default).
        const prof = rowBinds(r).profile;
        const locales = (prof ? (hs.dataFor(prof)?.locales ?? []) : []).map((l) => ({
          value: l.id,
          label: l.name,
        }));
        return (
          <HsTargetingModal
            title={r.info?.name || `#${r.campaignId}`}
            countries={r.countries}
            locales={r.locales}
            localeOptions={locales}
            onClose={() => setTargetingRowId(null)}
            onApply={(patch) => {
              patchRow(r.id, patch);
              setPreviewed(false); // the wave changed — re-preview before firing
            }}
          />
        );
      })()}
      {(() => {
        const r = destRowId ? rows.find((x) => x.id === destRowId) : null;
        if (!r) return null;
        return (
          <HsDestinationModal
            title={r.info?.name || `#${r.campaignId}`}
            hs={hs}
            limits={limits}
            needsPage={needsPage}
            tokenRail={tokenRail}
            maxCopies={MAX_COPIES}
            initial={rowBinds(r)}
            initialCopies={r.copies}
            defaultCopies={copiesN}
            hasOverride={r.dest !== null}
            rowCount={rows.length}
            onClose={() => setDestRowId(null)}
            onApply={(dest, c) => {
              patchRow(r.id, { dest, copies: c });
              setPreviewed(false);
            }}
            onApplyAll={(dest, c) => {
              setRows((rs) => rs.map((x) => ({ ...x, dest: { ...dest }, copies: c })));
              setPreviewed(false);
            }}
            onUseDefaults={() => {
              patchRow(r.id, { dest: null, copies: "" });
              setPreviewed(false);
            }}
          />
        );
      })()}
    </>
  );
}
