"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { AutoTextarea, BidKindTag, Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useHs } from "./use-hs";
import { useHsTaskManager } from "./hs-task-manager";
import { decorateAccountOptions, fmtCountdown, useAcctLimits } from "./use-acct-limit";
import { bidKind, limitMoney, limitMoneyCents, moneyLabel, parseMoney } from "@/lib/types";
import { geoSummary } from "@/lib/catalog";
import { HS_TOKEN_MARK, splitHsGrammar, stripTokenMark, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { juroEnsureMark } from "@/lib/juro";
import { relabelNameGeo } from "@/lib/targeting-override";
import type { PartnerId } from "@/lib/partners";
import { CopyIcon, EyeIcon, GlobeIcon, PlusIcon, TrashIcon } from "./icons";
import { HsTargetingModal } from "./hs-targeting-modal";
import { hsTokensAllDown, useHsTokenStatus } from "./hs-token-status";
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
    adsCount: number;
  } | null;
  loading: boolean;
  bid: string; // editable override; "" = inherit from source (safe default)
  budget: string; // editable, display string → cents on the wire
  suffix: string;
  /** Targeting override (modal): geo codes (["WW"] = worldwide) — empty = inherit the source's. */
  countries: string[];
  /** Targeting override: FB locale ids from the picked profile — empty = inherit the source's. */
  locales: string[];
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

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
  bid: "",
  budget: "10",
  suffix: "", // becomes the source's old TAIL once LION answers — an editable replacement
  countries: [],
  locales: [],
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
 * HS duplicator, structured like LION's own duplicator UI: a Settings column (destination binds
 * + global copies + Preview→Duplicate) and a Selected Campaigns table whose rows show the REAL
 * source facts read from LION (name, countries, original budget/bid, creatives) next to the
 * editable Bid/Budget/Suffix overrides. Submits go through /api/hs/duplicate; successful tasks
 * land in the HS Task Manager already "submitted" and auto-activate after COMPLETED.
 */
export function HsCloneBoard({
  user,
  partner,
  initialIds = [],
}: {
  user?: SessionUser;
  partner: PartnerId;
  /** Source campaign ids handed over in the link (?ids=…) — one prefilled row each. */
  initialIds?: string[];
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
  // Board mode: the CLONER (duplicate an existing tree) vs JURO (new campaign from the source's
  // page POSTS — no page bind). Each mode carries its own LION-vs-FB-token channel pair (owner
  // ask 08-26): the cloner pair fires /api/hs/duplicate | /api/hs/token-duplicate, the JURO pair
  // /api/hs/jurar | /api/hs/token-jurar. All picks survive refreshes; the token options unlock
  // only once the server says the rail is provisioned.
  const [mode, setMode] = useState<"clone" | "juro">("clone");
  const [dupChannel, setDupChannel] = useState<"lion" | "token">("lion");
  const [juroChannel, setJuroChannel] = useState<"lion" | "token">("lion");
  useEffect(() => {
    try {
      const m = localStorage.getItem("adlauncher.hs.mode");
      const v = localStorage.getItem("adlauncher.hs.dupchannel");
      const j = localStorage.getItem("adlauncher.hs.jurochannel");
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (m === "juro" || m === "clone") setMode(m);
      // pre-split storage carried the mode inside the channel key ("juro") — map it forward
      else if (v === "juro") setMode("juro");
      if (v === "token" || v === "lion") setDupChannel(v);
      if (j === "token" || j === "lion") setJuroChannel(j);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, []);
  const changeMode = (m: "clone" | "juro") => {
    setMode(m);
    setPreviewed(false);
    try {
      localStorage.setItem("adlauncher.hs.mode", m);
    } catch {
      /* storage disabled */
    }
  };
  const changeDupChannel = (ch: "lion" | "token") => {
    setDupChannel(ch);
    setPreviewed(false);
    try {
      localStorage.setItem("adlauncher.hs.dupchannel", ch);
    } catch {
      /* storage disabled */
    }
  };
  const changeJuroChannel = (ch: "lion" | "token") => {
    setJuroChannel(ch);
    setPreviewed(false);
    try {
      localStorage.setItem("adlauncher.hs.jurochannel", ch);
    } catch {
      /* storage disabled */
    }
  };
  const [draftId, setDraftId] = useState("");
  const [targetingRowId, setTargetingRowId] = useState<string | null>(null);
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
  const pixels = profile && account ? hs.pixelsFor(profile, account) : undefined;

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
  // JURO relaunches the source's page POSTS — the ads live on the source post's fanpage, so
  // there is no page bind at all on either channel (LION checks the executor profile's page
  // catalog; the token rail checks our token's own page access — both server-side).
  const needsPage = mode !== "juro";

  // A one-pixel account needs no picking — the field DERIVES the lone id (no effect write: the
  // react-compiler lint rejects sync setState in effects, and a derived value can't ever lag the
  // list), but only once the page is picked (owner ask 08-13 — the pixel belongs at the fanka
  // step, not right after the account). A real user pick (multi list) still wins via state.
  const onlyPixel = Array.isArray(pixels) && pixels.length === 1 ? pixels[0].id : "";
  // JURO has no page step — the lone pixel derives right after the account there.
  const effectivePixel = pixel || (page || !needsPage ? onlyPixel : "");

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

  const patchRow = useCallback(
    (id: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))),
    [],
  );
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
              adsCount: number;
            }>;
          };
          const byId = new Map((d.sources ?? []).map((s) => [s.campaignId, s]));
          setRows((rs) =>
            rs.map((r) => {
              const s = byId.get(r.campaignId.trim());
              if (!s) return ids.includes(r.campaignId.trim()) ? { ...r, loading: false } : r;
              return {
                ...r,
                loading: false,
                info: {
                  name: s.name,
                  status: s.status,
                  countries: s.countries,
                  budget: s.budget,
                  bid: s.bid,
                  bidStrategy: s.bidStrategy,
                  adsCount: s.adsCount,
                },
                // Prefill the editable bid with the source's own (LION-UI does the same); the
                // buyer clearing it back to "" means "inherit". Two-decimal comma format on
                // purpose — the field is cash-register (digits fill cents), and "1,2" would
                // re-read as 0,12 there; "1,20" is the stable spelling.
                bid: r.bid || (s.bid != null ? s.bid.toFixed(2).replace(".", ",") : ""),
                // Prefill the editable TAIL with the source's old one + the owner's name.
                suffix: r.suffix || withOwner(splitLionName(s.name, todaySaoPauloDDMM()).tail, user?.username ?? ""),
              };
            }),
          );
        } catch {
          ids.forEach((id) => fetchedRef.current.delete(id)); // retry on next edit
          setRows((rs) => rs.map((r) => (ids.includes(r.campaignId.trim()) ? { ...r, loading: false } : r)));
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [rows, user?.username]);

  const bindsReady = Boolean(profile && account && (page || !needsPage) && effectivePixel);
  const copiesN = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies) || 1)));
  const validRows = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && parseMoney(r.budget) >= 1);
  const unreadable = rows.filter((r) => r.info?.status === "UNREADABLE").length;
  const totalClones = validRows.length * copiesN;
  // Account launch limit (5 campaigns / 30 min): the wave binds ONE account, so an over-capacity
  // fire is blocked here with the countdown (the server precheck would 429 it anyway).
  const limits = useAcctLimits();
  const acctRemaining = account ? Math.max(0, limits.limit - limits.countFor(account)) : null;
  const acctOver = acctRemaining !== null && totalClones > acctRemaining;
  const acctResetAt = account ? limits.resetAtFor(account) : null;

  // The server pump takes the whole wave in ONE call and paces/polls/activates it after the
  // response (fire-and-forget, owner ask 08-14) — its shot cap must fit the pump's time budget.
  // The token rail builds one full Graph tree per shot (much heavier than a LION submit), so its
  // wave cap is tighter (mirrors the server's MAX_TOKEN_SHOTS).
  const MAX_SHOTS_PER_FIRE = 45;
  const MAX_TOKEN_SHOTS_PER_FIRE = 10;
  // Whole launch-token pool burned → the token rail is closed (the server gate refuses waves
  // anyway — this keeps the click honest instead of round-tripping into a 429).
  const tokenStatus = useHsTokenStatus();
  const tokensDown = hsTokensAllDown(tokenStatus.tokens, tokenStatus.loaded);

  // FB Token rails: offer only accounts OUR token can act on — LION binds cover segments the
  // token was never granted (aleph, 08-19), and a build there dies on the first Graph POST. null
  // sweep → no filtering (fail open; the server guard still answers with the actionable error).
  const tokenVisible = tokenRail ? (data?.tokenAccounts ?? null) : null;
  const accountOptions =
    tokenVisible !== null ? (data?.accounts ?? []).filter((a) => tokenVisible.has(a.value)) : (data?.accounts ?? []);
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

  async function duplicateAll() {
    if (!bindsReady || validRows.length === 0 || firing || acctOver || limits.staleBuild) return;
    // Token-rail wave while the whole pool is burned → honest local stop (the server gate would
    // refuse it with the same message anyway). Geo-override LION waves need a live token too —
    // LION JURO doesn't: its geo/locales ride natively in the jurar wire, no Graph patch involved.
    if (
      tokensDown &&
      (tokenRail ||
        (effDupChannel === "lion" && validRows.some((r) => r.countries.length > 0 || r.locales.length > 0)))
    ) {
      alert(
        "All FB launch tokens are rate-limited right now — " +
          (tokenRail
            ? "the FB Token rail is blocked until a cooldown lifts. Fire on the LION API rail or wait (see the Tokens widget)."
            : "Targeting-override clones need a live token for the Graph patch. Clear the overrides or wait (see the Tokens widget)."),
      );
      return;
    }
    const cap = tokenRail ? MAX_TOKEN_SHOTS_PER_FIRE : MAX_SHOTS_PER_FIRE;
    if (totalClones > cap) {
      alert(
        `That's ${totalClones} clones — the ${tokenRail ? "FB Token rail builds" : "server fires"} at most ${cap} per wave. ` +
          "Lower the copies or remove some rows and fire in waves.",
      );
      return;
    }
    setFiring(true);
    // ONE batch POST: the server stamps every row into the shared store, answers immediately and
    // keeps working in the background — jittered single-copy submits, status polling and clone
    // activation all happen server-side, so the tab may be closed right after this resolves.
    const shots = validRows.flatMap((r) => {
      const cid = r.campaignId.trim();
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
      return Array.from({ length: copiesN }, (_, copy) => ({
        campaignId: cid,
        budget: r.budget,
        bid: r.bid.trim(),
        // Fallback for the server's bid scaling (its own details/ re-read wins) — the bid
        // rides in HUMAN units and is scaled to LION's Meta-native wire unit server-side.
        ...(r.info?.bidStrategy ? { bidStrategy: r.info.bidStrategy } : {}),
        geo,
        // LION JURO: LION builds the name itself (`… API - JURO - …`) — only the buyer's tail
        // rides as name_suffix. Token JURO: WE own the name — the JURO-marked prefix + the TOKEN
        // marker + tail (the server re-ensures both markers). Cloner rails: fixed grammar prefix
        // + channel marker + tail.
        ...(effDupChannel === "juro"
          ? { suffix: r.suffix.trim() }
          : effDupChannel === "juro-token"
            ? { name: r.info?.name ? `${juroPrefixPreview(prefix)}${HS_TOKEN_MARK}${r.suffix.trim()}`.trim() : r.suffix.trim() }
            : r.info?.name
              ? { name: `${prefix}${mark}${r.suffix.trim()}`.trim() }
              : {}),
        // Targeting override — JURO sends it natively in the jurar wire; the other rails patch
        // the clone (token rail: before creating the ad set; LION rail: Graph after birth).
        ...(overridden ? { countries: r.countries } : {}),
        ...(r.locales.length ? { locales: r.locales } : {}),
        label: copiesN > 1 ? `${label} · copy ${copy + 1}/${copiesN}` : label,
      }));
    });
    validRows.forEach((r) => patchRow(r.id, { state: "sending", msg: "queuing on server…" }));
    // The channel is part of the wave's identity — a LION wave retried on the token rail (or
    // vice versa) is a DIFFERENT wave and must not be swallowed by the idempotency claim.
    const sig = JSON.stringify({ channel: effDupChannel, profile, account, page, pixel: effectivePixel, shots });
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
          profile,
          account,
          // JURO has no page bind — the ads live on the source post's own fanpage.
          ...(needsPage ? { page } : {}),
          pixel: effectivePixel,
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
          patchRow(r.id, { state: "ok", msg: `${copiesN}/${copiesN} queued — safe to close the tab` }),
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

  return (
    <>
      <Header partner={partner} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ---- Settings (LION-duplicator structure: binds + copies + preview→duplicate) ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
                Settings
              </span>
              <Field label="Profile">
                <SearchSelect
                  value={profile}
                  onChange={pickProfile}
                  options={hs.profiles ?? []}
                  placeholder="Search profile"
                  emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
                />
              </Field>
              <Field label="Account">
                <SearchSelect
                  value={account}
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
                <Field label="Page">
                  <SearchSelect
                    value={page}
                    onChange={(v) => {
                      setPage(v);
                      setPreviewed(false);
                    }}
                    options={data?.pages ?? []}
                    placeholder="Search page"
                    emptyHint={!profile ? "Pick a profile first" : data ? "No pages" : "Loading…"}
                  />
                </Field>
              ) : (
                <Field label="Page">
                  <p className="rounded-lg border border-dashed border-line bg-surface2/50 px-3 py-2 text-[11px] leading-relaxed text-faint">
                    JURO reuses the source&apos;s page posts — ads land on the source post&apos;s own
                    fanpage.{" "}
                    {effDupChannel === "juro-token"
                      ? "Our FB token must be able to use that page (checked per shot)."
                      : "The picked profile must carry that page (checked per shot)."}
                  </p>
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
              <Field label="Number of copies" hint="per source campaign">
                <input
                  value={copies}
                  onChange={(e) => {
                    setCopies(e.target.value.replace(/\D/g, "").slice(0, 2));
                    setPreviewed(false);
                  }}
                  inputMode="numeric"
                  aria-label="Number of copies"
                  className="h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] font-mono tabular-nums text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
              </Field>

              {/* board mode (cloner vs JURO), then the mode's own LION-vs-FB-token channel pair.
                  Both token chips ride the launcher's provisioning/cooldown gates (one pool). */}
              <div className="mt-1 flex flex-col gap-1">
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
                          ? "All FB launch tokens are rate-limited — the rail re-opens after a cooldown (see the Tokens widget)"
                          : undefined
                        : "FB token not configured on the server (FB_HS_LAUNCH_TOKEN)",
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
                    ? "All FB launch tokens are rate-limited — this rail is blocked until a cooldown lifts; fire on LION API or wait"
                    : effDupChannel === "token"
                      ? `Our FB token rebuilds each tree · starts +30 min · max ${MAX_TOKEN_SHOTS_PER_FIRE}/wave`
                      : effDupChannel === "juro-token"
                        ? `Our FB token relaunches the posts (social proof kept) · source languages preserved · starts +30 min · max ${MAX_TOKEN_SHOTS_PER_FIRE}/wave`
                        : effDupChannel === "juro"
                          ? "New campaign from the source's page posts (social proof kept) · geo/languages editable per row · born ACTIVE"
                          : "LION's clone weapon builds on the weapon side"}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setPreviewed(true)}
                disabled={!bindsReady || validRows.length === 0}
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
                  disabled={!bindsReady || validRows.length === 0 || firing || acctOver || limits.staleBuild}
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
              {bindsReady && acctOver ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  Account limit — only {acctRemaining} of {totalClones} clones fit this
                  account&apos;s 30-min window
                  {acctResetAt ? ` · resets in ${fmtCountdown(acctResetAt, limits.skew)}` : ""}.
                  Trim copies/rows or pick another account.
                </p>
              ) : null}
              <p className="text-center text-[10.5px] leading-relaxed text-faint">
                {bindsReady
                  ? previewed
                    ? tokenRail
                      ? "Builds over our FB token · born ACTIVE, starts +30 min"
                      : "Submits to LION · clones activate automatically"
                    : "Preview first, then duplicate"
                  : needsPage
                    ? "Pick profile · account · page · pixel"
                    : "Pick profile · account · pixel"}
              </p>
            </div>
          </aside>

          {/* ---- Selected campaigns ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Selected campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {validRows.length}
              </span>
              {unreadable > 0 ? (
                <span className="rounded-md border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10.5px] text-danger">
                  {unreadable} unreadable — their duplicates would fail too
                </span>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
              <table className="w-full min-w-[960px] text-left">
                <thead>
                  <tr className="border-b border-line text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                    <th className="px-3 py-2 font-semibold">#</th>
                    <th className="px-2 py-2 font-semibold">Name (fixed) + suffix</th>
                    <th className="px-2 py-2 font-semibold">Countries</th>
                    <th className="px-2 py-2 text-right font-semibold">Orig budget</th>
                    <th className="px-2 py-2 text-right font-semibold">Orig bid</th>
                    <th className="px-2 py-2 text-center font-semibold">Ads</th>
                    <th className="px-2 py-2 font-semibold">Bid</th>
                    <th className="px-2 py-2 font-semibold">Budget $</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className="border-b border-line/60 align-top last:border-b-0">
                      <td className="px-3 py-3 font-mono text-[11px] text-faint">{String(i + 1).padStart(2, "0")}</td>
                      <td className="min-w-[320px] px-2 py-2.5">
                        {/* Like the launcher's name field: the LION-rebuilt part is FIXED (muted),
                            only the trailing suffix is the buyer's to edit. */}
                        <div className="rounded-md border border-line bg-surface2 px-2.5 py-1.5">
                          <p className="font-mono text-[10px] text-faint">#{r.campaignId}</p>
                          <p className="mt-0.5 break-words text-[11.5px] leading-snug text-dim" title={r.info?.name}>
                            {r.loading ? (
                              "Loading from LION…"
                            ) : r.info?.status === "UNREADABLE" ? (
                              <span className="text-danger">LION can’t read this campaign</span>
                            ) : r.info?.name ? (
                              // Fixed part = grammar prefix + the FIRE channel's marker (token →
                              // TOKEN, live-toggles with the rail switch; source markers were
                              // stripped into the tail parse).
                              (() => {
                                const p = relabelNameGeo(
                                  splitLionName(r.info.name, todaySaoPauloDDMM()).prefix,
                                  r.countries,
                                );
                                if (!p) return r.info.name;
                                // LION JURO appends its own family label server-side (hence the
                                // ellipsis); token JURO's name is exact — board-built.
                                if (effDupChannel === "juro") return `${juroPrefixPreview(p)}…`;
                                if (effDupChannel === "juro-token") return juroPrefixPreview(p) + HS_TOKEN_MARK;
                                return p + (effDupChannel === "token" ? HS_TOKEN_MARK : "");
                              })()
                            ) : (
                              "—"
                            )}
                          </p>
                          {/* Grows with the typed tail (wraps, no inner scroll) — same adaptive
                              name editing as the MO clone board; Enter/newlines never reach the
                              campaign name (singleLine). */}
                          <AutoTextarea
                            value={r.suffix}
                            onChange={(v) => patchRow(r.id, { suffix: v })}
                            placeholder="tail — edit to rename the clone"
                            ariaLabel="Name suffix"
                            maxLength={80}
                            singleLine
                            className="mt-1.5 block w-full resize-none overflow-hidden rounded border border-line bg-surface px-2 py-1 text-[12px] leading-snug text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                          />
                        </div>
                      </td>
                      <td className="px-2 py-3 text-[11.5px]">
                        <div className="flex flex-col gap-1.5">
                          {r.countries.length > 0 ? (
                            <span
                              className="font-medium text-[#9db8ff]"
                              title="Geo override — the clone launches with THIS targeting, not the source's"
                            >
                              {overrideGeoLabel(r.countries)}
                              <span className="ml-1 rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide">
                                override
                              </span>
                            </span>
                          ) : (
                            <span className="text-dim">
                              {r.info?.countries.length
                                ? geoSummary(r.info.countries)
                                : r.info?.name
                                  ? geoFromName(r.info.name, geoSummary) || "inherited"
                                  : "—"}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setTargetingRowId(r.id)}
                            className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-dim transition-colors hover:bg-accent/10 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <GlobeIcon className="h-3 w-3" />
                            Targeting
                          </button>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-right font-mono text-[11.5px] tabular-nums text-dim">
                        {r.info?.budget != null ? `$${moneyLabel(r.info.budget)}` : "—"}
                      </td>
                      <td className="px-2 py-3 text-right font-mono text-[11.5px] tabular-nums text-dim">
                        {r.info ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-1">
                            <BidKindTag strategy={r.info.bidStrategy} />
                            <span>{origBidLabel(r.info)}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-3 text-center font-mono text-[11.5px] text-dim">
                        {r.info ? r.info.adsCount : "—"}
                      </td>
                      <td className="w-[110px] px-2 py-2.5">
                        {/* The same field means a ROAS decimal on a min-ROAS row and $ on a cap
                            row — the in-field marker (blue R / faint $) keeps the unit readable
                            right where the buyer types, matching the row's BidKindTag. */}
                        <div className="relative">
                          {r.info && bidKind(r.info.bidStrategy) !== "none" ? (
                            <span
                              className={
                                "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] " +
                                (bidKind(r.info.bidStrategy) === "roas"
                                  ? "font-semibold text-[#9db8ff]"
                                  : "text-faint")
                              }
                            >
                              {bidKind(r.info.bidStrategy) === "roas" ? "R" : "$"}
                            </span>
                          ) : null}
                          <input
                            value={r.bid}
                            // Cash-register entry, SAME as the launcher's bid/ROAS field: typed
                            // digits fill hundredths from the right (34 → 0,34 · 120 → 1,20), so a
                            // missed comma can never inflate a bid 100×. HUMAN units, like LION's
                            // reads prefill them: ROAS decimal for MIN_ROAS sources, $ for cap —
                            // the duplicate route scales to Meta-native wire units by the SOURCE's
                            // strategy. Empty inherits the source's own bid.
                            onChange={(e) =>
                              patchRow(r.id, {
                                bid: limitMoneyCents(
                                  e.target.value,
                                  bidKind(r.info?.bidStrategy ?? "") === "roas" ? 100 : 1000,
                                ),
                              })
                            }
                            placeholder={
                              bidKind(r.info?.bidStrategy ?? "") === "roas" ? "inherits ROAS goal" : "inherit"
                            }
                            title={
                              bidKind(r.info?.bidStrategy ?? "") === "roas"
                                ? "ROAS decimal — 34 → 0,34 (34%) · empty = inherit the source's goal"
                                : bidKind(r.info?.bidStrategy ?? "") === "cap"
                                  ? "Bid cap in $ — digits fill cents, 34 → $0,34 · empty = inherit the source's cap"
                                  : "Digits fill cents — 34 → 0,34 · 120 → 1,20"
                            }
                            inputMode="decimal"
                            aria-label="Bid / ROAS goal"
                            className={cellInput + (r.info && bidKind(r.info.bidStrategy) !== "none" ? " pl-5" : "")}
                          />
                        </div>
                      </td>
                      <td className="w-[100px] px-2 py-2.5">
                        <input
                          value={r.budget}
                          onChange={(e) => patchRow(r.id, { budget: limitMoney(e.target.value, 10000) })}
                          aria-label="Daily budget"
                          className={cellInput}
                        />
                      </td>
                      <td className="max-w-[180px] px-2 py-3">
                        <span
                          className={
                            "block truncate text-[11px] " +
                            (r.state === "error"
                              ? "text-danger"
                              : r.state === "ok"
                                ? "text-launch2"
                                : r.state === "sending"
                                  ? "text-[#9db8ff]"
                                  : "text-faint")
                          }
                          title={r.msg}
                        >
                          {r.state === "sending" ? "Submitting…" : (r.msg ?? "—")}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <button
                          type="button"
                          aria-label="Remove row"
                          onClick={() => removeRow(r.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addSources();
                  }}
                  placeholder="Campaign ID(s) — paste one or a comma list"
                  aria-label="Add source campaign ids"
                  className="h-8 w-[280px] rounded-md border border-line bg-surface2 px-2 font-mono text-[12px] text-ink outline-none transition-colors hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
                />
                <button
                  type="button"
                  onClick={addSources}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[11.5px] font-medium text-faint transition-colors hover:border-accent/50 hover:text-[#9db8ff]"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>
              <p className="text-[10.5px] text-faint">
                Empty Bid = inherits the source’s · MIN_ROAS sources take a ROAS decimal (0,34 = 34%), cap sources $ · targeting & creatives inherit
              </p>
            </div>

            {/* preview — what exactly will be fired */}
            {previewed ? (
              <div className="animate-pop-in rounded-2xl border border-line bg-surface p-4">
                <p className="pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                <div className="flex flex-col gap-1.5">
                  {validRows.map((r) => (
                    <p key={r.id} className="text-[12px] text-dim">
                      <span className="text-ink">
                        {r.info?.name
                          ? (effDupChannel === "juro"
                              ? `${juroPrefixPreview(relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries))}… ${r.suffix.trim()}`
                              : effDupChannel === "juro-token"
                                ? `${juroPrefixPreview(relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries))}${HS_TOKEN_MARK}${r.suffix.trim()}`
                                : `${relabelNameGeo(splitLionName(r.info.name, todaySaoPauloDDMM()).prefix, r.countries)}${effDupChannel === "token" ? HS_TOKEN_MARK : ""}${r.suffix.trim()}`
                            ).slice(0, 110)
                          : `#${r.campaignId}`}
                      </span>{" "}
                      → {copiesN} cop{copiesN === 1 ? "y" : "ies"} @ ${moneyLabel(r.budget)}/day
                      {r.bid.trim()
                        ? bidKind(r.info?.bidStrategy ?? "") === "roas"
                          ? ` · ROAS ${r.bid}`
                          : ` · bid ${bidKind(r.info?.bidStrategy ?? "") === "cap" ? "$" : ""}${r.bid}`
                        : " · bid inherited"}
                      {r.countries.length > 0 ? (
                        <span className="text-[#9db8ff]"> · geo → {overrideGeoLabel(r.countries)}</span>
                      ) : null}
                      {r.locales.length > 0 ? <span className="text-[#9db8ff]"> · {r.locales.length} lang</span> : null}
                    </p>
                  ))}
                  <p className="mt-1 border-t border-line pt-2 text-[12px] text-ink">
                    {totalClones} clone{totalClones === 1 ? "" : "s"} → {account}
                    {needsPage ? ` · page ${page}` : " · ads on the source posts' pages"} · pixel {effectivePixel}
                  </p>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </main>

      {(() => {
        const r = targetingRowId ? rows.find((x) => x.id === targetingRowId) : null;
        if (!r) return null;
        const locales = (profile ? (hs.dataFor(profile)?.locales ?? []) : []).map((l) => ({
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
    </>
  );
}
