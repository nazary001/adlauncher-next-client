"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Campaign, FileItem } from "@/lib/types";
import { bidKind, firstMedia, fullName, isLaunchable, makeCampaign, moEnsureSocMark, todayPrefixDDMM, pinNamePrefix } from "@/lib/types";
import { geoSummary } from "@/lib/catalog";
import {
  GCM_POOL_MAX,
  type PartnerConfig,
  type PartnerId,
  applyPartnerLocks,
  assignPoolCodes,
  markerPool,
  launchReadyOpts,
  namePrefixFor,
  partnerConfig,
  pickAifPixel,
} from "@/lib/partners";
import { hsFullName, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { toolEnsureMark } from "@/lib/tool-launch";
import { makeGate } from "@/lib/launch-guards";
import { Header } from "./header";
import { CampaignCard } from "./campaign-card";
import { type FanpageOption, useFanpages } from "./use-fanpages";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "@/lib/pick-defaults";
import { useAutoLandings } from "./use-auto-landings";
import { useSigners } from "./use-signers";
import { hsTokensAllDown, useHsTokenStatus } from "./hs-token-status";
import { type AdAccountOption, defaultPixelFor, useAdAccounts } from "./use-adaccounts";
import { type AcctLimits, acctIdKey, useAcctLimits } from "./use-acct-limit";
import { useHs } from "./use-hs";
import { LaunchRail } from "./launch-rail";
import { type ToolSessionOption, useToolReady } from "./use-tool-ready";
import { CopySettingsModal } from "./copy-settings-modal";
import { ChevronsIcon, CopyIcon, PlusIcon } from "./icons";
import { useAifTaskManager, useAvTaskManager, useTaskManager } from "./task-manager";
import { useAvDestinations } from "./use-av-destinations";
import { pinAvNamePrefix } from "@/lib/av-link";
import { type HsLaunchChannel, useHsTaskManager } from "./hs-task-manager";
import type { SessionUser } from "./user-menu";

/** Card clone for duplication: fresh array/object identities for every mutable field (files —
 *  cover objects included — countries, locales), so a future in-place edit on one card can never
 *  bleed into siblings sharing the refs (review find 08-24). gcm intentionally cleared — every
 *  card claims its own code; blob `url`s stay shared by design (dups reuse the session upload). */
function cloneCardFrom(src: Campaign, id: string): Campaign {
  return {
    ...src,
    id,
    collapsed: false,
    gcm: "",
    countries: [...src.countries],
    locales: [...src.locales],
    files: src.files.map((f) => ({ ...f })),
  };
}

/** Today as DD.MM for the campaign-name prefix — the team's (Kyiv) calendar day (lib/types
 *  todayPrefixDDMM), identical on the server render and the client hydration. The old
 *  renderer-clock version differed between Vercel (UTC) and the buyer's zone for hours every
 *  night → React #418 on every board open + zone-dependent born-dates (live 09-09). */
const todayDDMM = (): string => todayPrefixDDMM();

/** Free-pool warning threshold: at or below this many free gcm codes the board shows the early
 *  amber banner, so designers know BEFORE building a wave that it may not fit. 0 = hard block. */
const GCM_LOW_WATER = 15;

/** The HS launch-rail pick (LION API | FB Token | TOOL) survives refreshes — buyers run whole
 *  waves on one rail, re-picking it every session would invite accidental LION shots mid-wave. */
const HS_CHANNEL_LS = "adlauncher.hs.channel";
/** MO/AIF launch-rail pick (FB Token | TOOL) — one key per partner (owner ask 28.09). MO uses the
 *  fresh `...channel2` key, NOT the retired `adlauncher.mo.channel` (the old soc-signer switch). */
const MO_CHANNEL_LS = "adlauncher.mo.channel2";
const AIF_CHANNEL_LS = "adlauncher.aif.channel";
// AV has NO launch-rail pick (owner ask 28.09: "нужно на нужную фанку делать — на то что тянет
// токен, а через сам токен только фанку тянуть"): AV launches ONLY through TOOL — its cabinets come
// from the live TOOL session, the fanpage from the AV token's own catalog — so there is no FB Token
// option and nothing to persist. When TOOL is not ready the Launch button is disabled with TOOL's
// own reason; it NEVER falls back to a token rail.

/** MO/AIF direct-Graph partners choose between our FB token and the HS TOOL sessions service. */
type GraphChannel = "token" | "tool";

// The MO / AIF launch signer is no longer a per-buyer pick: the owner assigns it on /tokens
// (lib/fb-tokens) and every rail resolves that same slot server-side (badge via use-signers).

/** gcm auto-claim (skipping registry-reserved codes) + single account/pixel/fanpage pinning.
 *  `poolMax` overrides the pool's static ceiling — AV's launchable range is only the keys
 *  registered in ActiveView (the preview endpoint reports it), so codes are assigned strictly
 *  within it; MO/AIF pass nothing and keep their static pool.max. */
function normalize(rows: Campaign[], partner: PartnerConfig, reserved: Set<string> | null, poolMax?: number | null): Campaign[] {
  const base = markerPool(partner);
  const pool = base ? { ...base, max: poolMax ?? base.max } : base;
  const withGcm = pool ? assignPoolCodes(rows, reserved, pool) : rows;
  // The fixed name prefix follows the ACTIVE partner: a card born on MO and launched after the
  // buyer switched to AIF must read "(AIF)" — it kept "(MO)" and every list showed the AIF
  // wave as MO runs (live bug 23.09). HS has no prefix (LION's grammar builds its own). AV's fixed
  // prefix also carries the card's locked "<topic> | <GEO> | <lang> | " from its destination (owner
  // ask 30.09 — under the lock, the buyer types only the tail; the server rebuilds it the same way).
  const prefix = namePrefixFor(partner, todayDDMM());
  const pinned = partner.avLaunch ? pinAvNamePrefix(withGcm, prefix) : pinNamePrefix(withGcm, prefix);
  return applyPartnerLocks(pinned, partner);
}

/** Fresh card with the partner's own defaults on top of makeCampaign's (e.g. HS is born with the
 *  HIGH-ADX redirect — owner call 08-13). Duplicates copy their source instead, on purpose. */
function freshCard(id: string, partner: PartnerConfig, owner: string): Campaign {
  // The typed tail starts as the buyer's username on every partner — AV too, after its locked
  // "<topic> | <GEO> | <lang> | " (owner 30.09: "в суфикс тот добавь сразу имя как оно и было, например Tima").
  const c = makeCampaign(id, namePrefixFor(partner, todayDDMM()), owner);
  if (partner.defaultRedirect) c.redirectType = partner.defaultRedirect;
  return c;
}

/** Token-account partners: fill an empty/invalid account with the LEAST-LOADED account on the
 *  5/30-min launch timer (owner rule 09-08 — fewest launches in its open window, then the sooner
 *  reset; the partner's preferred account is ranked first so it wins ties, i.e. a quiet board
 *  still lands on the historical default) and keep the pixel on something the chosen account
 *  actually carries. Only ever touches EMPTY/invalid accounts — a buyer's pick is never moved.
 *  Pure — returns the SAME array when nothing changes. */
function fillAccountDefaults(
  rows: Campaign[],
  partner: PartnerConfig,
  adAccounts: AdAccountOption[] | null,
  limits?: Pick<AcctLimits, "countFor" | "limit" | "resetAtFor">,
  visible?: Set<string> | null,
): Campaign[] {
  if (!partner.accountsFromToken || !adAccounts || adAccounts.length === 0) return rows;
  // TOOL wave armed (owner ask 28.09): the auto-pick candidate pool is restricted to TOOL-visible
  // accounts AND a card bound to a non-visible account counts as invalid (needs re-fill). This
  // keeps the board's default in the same set the card's picker offers, so its self-heal (which
  // clears a hidden account) and this re-fill converge instead of ping-ponging. Nothing visible
  // yet → leave the rows for the card-level heal (don't blank a good account off an empty sweep).
  const pool = visible ? adAccounts.filter((a) => visible.has(a.value)) : adAccounts;
  if (pool.length === 0) return rows;
  const preferred = partner.defaultAccount?.id ?? "";
  const ordered = pool.slice().sort((a, b) => (a.value === preferred ? -1 : b.value === preferred ? 1 : 0));
  const pick = limits
    ? leastLoadedAccount(
        accountLoads(
          ordered.map((a) => ({ id: a.value, disabled: a.disabled })),
          limits,
        ),
        limits.limit,
      )
    : "";
  let changed = false;
  const next = rows.map((c) => {
    let account = c.account;
    if (!account || !adAccounts.some((a) => a.value === account) || (visible && !visible.has(account))) {
      account = pick || ordered[0].value;
    }
    let pixel = c.pixel;
    const pixels = adAccounts.find((a) => a.value === account)?.pixels ?? [];
    // Min-ROAS cards are pinned to the value pixel — never re-fill them, even if this account's
    // list misses it (the launch route's pixel_not_on_account then names the real problem
    // instead of a silent swap ping-ponging with the card's pin effect). AIF converges to the value
    // pixel VD-C1-HS-1 (the only offerable one since 09-02 pt2; empty while unshared).
    // AV binds NO pixel — the AV page has none (Traffic / link clicks), and every other AV path keeps
    // pixel "" (applyPartnerLocks, the card's account-switch handler, the launch/clone routes). Guard
    // this backfill too: an AV cabinet that happens to expose a Meta pixel would otherwise seed one
    // onto the card here (the only unguarded AV no-pixel path), violating the invariant in client
    // state and relying solely on the server's pixel="" override (review find 09-28).
    if (!partner.avLaunch && bidKind(c.bidStrategy) !== "roas" && (!pixel || !pixels.some((p) => p.id === pixel))) {
      pixel = partner.aifLaunch
        ? (pickAifPixel(pixels)?.id ?? "")
        : defaultPixelFor(adAccounts, account, partner.preferredPixel);
    }
    if (account === c.account && pixel === c.pixel) return c;
    changed = true;
    return { ...c, account, pixel };
  });
  return changed ? next : rows;
}

/** Token-fanpage partners: fill an EMPTY/invalid fanpage with the LEAST-FILLED page (owner rule
 *  09-08 — lowest ads/limit ratio; full pages never). The card REMEMBERS what the fill chose
 *  (`autoPage`, carried in the row itself) so the fill keeps re-picking such cards while the fill
 *  numbers keep landing — the list arrives before its counts, so the first pick settles on the
 *  emptiest page once the counts do. A buyer's own pick (page ≠ the remembered auto value) is
 *  never moved. PURE: no outside memory (React double-invokes state updaters in dev StrictMode —
 *  a ref mutated in here made the second call see its own mark and freeze the card, 09-08) and
 *  the SAME array comes back when nothing changes. */
function fillPageDefaults(rows: Campaign[], partner: PartnerConfig, fanpages: FanpageOption[] | null): Campaign[] {
  if (!partner.fanpagesFromToken || !fanpages || fanpages.length === 0) return rows;
  const pick = leastFilledPage(
    fanpages.map((o) => ({ id: o.value, used: o.adCount, limit: o.adLimit, disabled: o.disabled })),
    partner.pageAdLimit ?? 250,
  );
  if (!pick) return rows;
  let changed = false;
  const next = rows.map((c) => {
    const valid = Boolean(c.page) && fanpages.some((o) => o.value === c.page);
    if (valid && c.autoPage !== c.page) return c; // the buyer's own pick
    if (c.page === pick && c.autoPage === pick) return c;
    changed = true;
    return { ...c, page: pick, autoPage: pick };
  });
  return changed ? next : rows;
}


/** Rendered inside the (app) layout's TaskManagerProvider — the queue lives up there so it
 *  survives navigating between the launcher and the clone board. */
export function LauncherBoard({ user, initialPartner = "in" }: { user?: SessionUser; initialPartner?: PartnerId }) {
  return <LauncherInner user={user} initialPartner={initialPartner} />;
}

function LauncherInner({ user, initialPartner }: { user?: SessionUser; initialPartner: PartnerId }) {
  const teamTm = useTaskManager();
  const aifTm = useAifTaskManager();
  const avTm = useAvTaskManager();
  const [partnerId, setPartnerId] = useState<PartnerId>(initialPartner);
  // Codes already taken in the current partner's Strapi registry (MO gcm / AIF brand / AV keys),
  // keyed by the registry endpoint they came from: switching partners makes the other pool's
  // snapshot instantly invalid (derived `reserved` reads null → assign nothing until the refetch
  // lands). `poolMax` rides along for AV, whose launchable ceiling = the keys registered in AV
  // (the preview endpoint reports it); null = the endpoint omits it (MO/AIF → the static max).
  const [reservedState, setReservedState] = useState<{ api: string; set: Set<string>; poolMax: number | null } | null>(null);
  // Count just sent to the Task Manager, shown as a brief confirmation (campaigns stay on the board).
  const [justQueued, setJustQueued] = useState(0);
  const queuedTimer = useRef<number | null>(null);
  // Cards the last Launch click held back because their account hit the 5/30min launch limit.
  const [heldBack, setHeldBack] = useState(0);
  const heldTimer = useRef<number | null>(null);
  // Per-account launch-limit picture (server counts + own queued demand) — gates the wave below.
  const limits = useAcctLimits();
  const limitsRef = useRef(limits);
  useEffect(() => {
    limitsRef.current = limits;
  }, [limits]);
  // Card that a Launch-bay row jumped to (focus-pulses briefly).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const hlTimer = useRef<number | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    normalize([freshCard("c1", partnerConfig(initialPartner), user?.username ?? "")], partnerConfig(initialPartner), null),
  );
  const [previewed, setPreviewed] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const nextId = useRef(2);
  // Owner-generated MK Learn pages join the MO landing catalog live (grouped "Auto · <niche>",
  // appended after the static niches so SearchSelect's contiguous-group contract holds).
  const autoLandings = useAutoLandings(partnerId === "in");
  const partner = useMemo(() => {
    const base = partnerConfig(partnerId);
    if (!base.usesGcm || autoLandings.length === 0) return base;
    return { ...base, landings: [...base.landings, ...autoLandings] };
  }, [partnerId, autoLandings]);
  // The board talks to the ACTIVE partner's own task manager: AIF launches queue/track in the
  // separate AIF instance (own drawer, own Strapi scope), AV in its own, everything else in the
  // team one.
  const { enqueue, tasks } = partner.avLaunch ? avTm : partner.aifLaunch ? aifTm : teamTm;
  const anyExpanded = campaigns.some((c) => !c.collapsed);
  // The partner's marker pool (MO gcm 01..200 / AIF brand test01..test700 / AV key av001..;
  // null = no markers).
  const pool = markerPool(partner);
  const poolApi = pool?.api ?? "";
  // The current partner's used-set — null while another pool's snapshot (or nothing) is loaded.
  const reserved = reservedState && reservedState.api === poolApi ? reservedState.set : null;
  // Effective pool ceiling. AV's preview endpoint reports how many keys the owner actually
  // registered in ActiveView (`poolMax`) — the real launchable max; the codec's 999 (pool.max)
  // is only the key SHAPE. MO/AIF omit poolMax, so their static pool.max stands.
  // Only AV's endpoint max is honoured — /api/gcm and /api/aif/brand also answer poolMax (their
  // static 200 / 700), and their arithmetic below must stay exactly what it was.
  const endpointMax = partner.avLaunch && reservedState && reservedState.api === poolApi ? reservedState.poolMax : null;
  const poolMax = pool ? (endpointMax ?? pool.max) : null;
  // Free codes left in the registry pool (null until the registry loads). `reserved` is the live
  // used-set — refreshed on focus and grown by completed launches — so this count updates without
  // extra requests. Counted WITHIN the effective range (a key claimed above a later-lowered
  // registered count must not eat a free slot). Drives the banner + the Launch hard-block below.
  // MO/AIF (endpointMax null) keep the historical `max − used` arithmetic byte-for-byte.
  const poolFree = useMemo(() => {
    if (!pool || !reserved || poolMax == null) return null;
    if (endpointMax == null) return Math.max(0, pool.max - reserved.size);
    let inRange = 0;
    for (let n = 1; n <= poolMax; n++) if (reserved.has(pool.code(n))) inRange++;
    return Math.max(0, poolMax - inRange);
  }, [pool, reserved, poolMax, endpointMax]);
  // AV stub: poolMax 0 = no keys registered in ActiveView yet. Distinct from "exhausted" — there
  // are no codes to free, an owner must upload the pool (AV keys page). Both block launching.
  const poolUnregistered = Boolean(pool) && poolMax === 0;
  const poolExhausted = Boolean(pool) && poolFree === 0;
  // The rail's signer (MO / AIF direct-Graph rails) is the OWNER'S pick on /tokens — read-only
  // here (badge in the rail); the launch route resolves the very same slot server-side.
  const graphRail = !partner.lionLaunch && (partner.usesGcm || Boolean(partner.aifLaunch) || Boolean(partner.avLaunch));
  // TOOL launch-channel readiness for the ACTIVE partner (owner ask 28.09): the server verifies the
  // key + scopes + ≥1 live-session account also in this partner's catalog and assigned to this
  // buyer. Gates the TOOL rail segment and filters the account pickers; polls 5 min + on focus and
  // resets on a partner switch (the hook keys on partner|rail). AV now rides TOOL too (owner ask
  // 28.09 "сделай чтобы лаунчер оттуда кабинеты тянул"): the live av-01 session sees the GC-AV
  // cabinets, and for AV the ready `rows` ARE the account catalog (AV has no FB token). So every
  // partner polls it — the endpoint decides who is TOOL-ready.
  const toolReady = useToolReady(partnerId, "launch");
  const signers = useSigners(graphRail);
  const railSigner = graphRail
    ? (signers.slots?.[partner.avLaunch ? "av.launch" : partner.aifLaunch ? "aif.launch" : "mo.launch"] ?? null)
    : null;
  /** A token exists for this rail (assigned or env default) — the catalogs load and waves may
   *  fire. An UNHEALTHY token stays effective: its pickers/launch error with FB's own reason. */
  const signerReady = !graphRail || Boolean(railSigner?.primary);
  /** SOC name marker rides personal-soc signers only (MO) — system users launch unmarked, so
   *  their previews stay unmarked too (server is the truth either way). */
  const moSocMarks = partner.usesGcm && Boolean(railSigner?.primary?.personal);

  // Token fanpages for the per-card fanka picker, each with its live N/limit fill tag from the
  // hs-tools registry (AIF reads its own token's pages; its registry scope fills the badges the
  // day the box starts syncing AIF pages — empty until then). A soc channel reads the SOC's own
  // page catalog (its me/accounts) — the volume badges stay on the shared registry sweep.
  // MO catalogs wait for the signer pick (no system token to read from any more) — the picker
  // shows its loading hint for the auto-pick beat instead of flashing the retired catalog.
  const fanpages = useFanpages(
    Boolean(partner.fanpagesFromToken) && signerReady,
    partner.pageAdLimit ?? 250,
    partner.avLaunch
      ? // hs-tools has no AV scope → no fill badges (volume: null); the list alone is the picker.
        { list: "/api/av/fanpages?rail=launch", volume: null }
      : partner.aifLaunch
        ? { list: "/api/aif/fanpages?rail=launch", volume: "/api/aif/fanpages/volume" }
        : { list: "/api/fanpages?rail=launch", volume: "/api/fanpages/volume" },
  );
  // HS launch-token pool health — powers the "all tokens burned" banner (the server gate is the
  // enforcement; this is the courtesy warning before buyers build a wave into a 429).
  const hsTokenStatus = useHsTokenStatus(Boolean(partner.lionLaunch));
  const hsTokensDown = partner.lionLaunch ? hsTokensAllDown(hsTokenStatus.tokens, hsTokenStatus.loaded) : false;
  // Token ad accounts (with their pixels) for the account/pixel pickers — read from the picked
  // signer's catalog (a soc may see a different account set than the system user). NOT read for AV
  // (owner ask 28.09): AV launches only through TOOL, so its cabinets come from the live TOOL
  // session (the ready `rows` → `avToolAccounts` below), and the AV token is used ONLY for the
  // fanpage list — never for an account catalog. So the AV token is never asked for accounts here.
  const adAccounts = useAdAccounts(
    Boolean(partner.accountsFromToken) && signerReady && !partner.avLaunch,
    partner.preferredPixel,
    partner.aifLaunch ? "/api/aif/adaccounts?rail=launch" : "/api/adaccounts?rail=launch",
  );
  // AV destination catalog (articles + redirect paths) — loaded only on the AV rail; passed to the
  // cards' Destination field. Undefined for every other partner.
  const avDestinations = useAvDestinations(Boolean(partner.avLaunch));
  // LION catalog (HS): profiles + ACR, per-profile accounts/pages/locales, per-account pixels.
  const hs = useHs(Boolean(partner.lionLaunch));
  const hsTasks = useHsTaskManager();
  // HS launch rail: LION create weapon (default) or the FB Token direct-Graph build. Restored
  // from localStorage after mount (SSR-safe); the token option is offered only once the server
  // says the rail is provisioned (hs.tokenLaunch).
  const [hsChannel, setHsChannel] = useState<HsLaunchChannel>("lion");
  // MO/AIF launch rail (owner ask 28.09): our FB token (direct Graph, default) or the HS TOOL
  // sessions service. Per-partner localStorage keys, restored after mount (SSR-safe).
  const [moChannel, setMoChannel] = useState<GraphChannel>("token");
  const [aifChannel, setAifChannel] = useState<GraphChannel>("token");
  useEffect(() => {
    try {
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR),
      // and only flips a default when a pick was actually saved.
      const v = localStorage.getItem(HS_CHANNEL_LS);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "token" || v === "lion" || v === "tool") setHsChannel(v);
      const mo = localStorage.getItem(MO_CHANNEL_LS);
      if (mo === "token" || mo === "tool") setMoChannel(mo);
      const aif = localStorage.getItem(AIF_CHANNEL_LS);
      if (aif === "token" || aif === "tool") setAifChannel(aif);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, []);
  const changeHsChannel = useCallback((ch: HsLaunchChannel) => {
    setHsChannel(ch);
    try {
      localStorage.setItem(HS_CHANNEL_LS, ch);
    } catch {
      /* storage disabled */
    }
  }, []);
  // One toggle handler for the active graphRail partner (MO / AIF); each persists to its own key.
  // AV has no channel switch (it is TOOL-only, owner ask 28.09), so this only ever fires for MO/AIF.
  // Plain function (the rail isn't memoized): reads the current `partner` freshly, no stale closure.
  const changeGraphChannel = (ch: GraphChannel) => {
    if (partner.aifLaunch) {
      setAifChannel(ch);
      try {
        localStorage.setItem(AIF_CHANNEL_LS, ch);
      } catch {
        /* storage disabled */
      }
    } else {
      setMoChannel(ch);
      try {
        localStorage.setItem(MO_CHANNEL_LS, ch);
      } catch {
        /* storage disabled */
      }
    }
  };
  // The active graphRail partner's effective channel (owner ask 28.09). AV is PINNED to TOOL — it
  // has no FB Token rail and never falls back to one (its cabinets ride the live TOOL session, its
  // fanpage the AV token's catalog). MO/AIF read their own pick; a stale "tool" pick with the rail
  // not ready still falls back to FB Token at fire time (graphToolActive gates that).
  const graphChannel: GraphChannel = partner.avLaunch ? "tool" : partner.aifLaunch ? aifChannel : moChannel;
  const hsToolActive = Boolean(partner.lionLaunch) && hsChannel === "tool" && toolReady.ready;
  const graphToolActive = graphRail && graphChannel === "tool" && toolReady.ready;
  // AV-on-TOOL specifically (owner ask 28.09): AV launches ONLY through TOOL, so this is really
  // "AV and a live TOOL session is ready". The account picker is the TOOL ready rows; the fanpage
  // still comes from the AV token's catalog. Every AV-TOOL-only branch keys on this.
  const avOnTool = Boolean(partner.avLaunch) && graphToolActive;
  // AV account catalog = the TOOL ready rows themselves (owner ask 28.09: the AV token is used ONLY
  // for the fanpage list, NEVER for accounts). Shaped as AdAccountOption so the card's normal
  // token-account picker renders them (name label, id + currency sub, no pixels). Built whenever AV
  // is active — empty (→ no launchable card) while no live session is ready, so a not-ready TOOL is
  // a clean block, and the AV token is never asked for an account catalog. Off AV → the real
  // token catalog (MO/AIF).
  const avToolAccounts = useMemo<AdAccountOption[] | null>(() => {
    if (!partner.avLaunch) return null;
    return toolReady.rows.map((r) => ({
      value: r.id,
      label: r.name || r.id,
      meta: r.id,
      subLabel: r.currency ? `${r.id} · ${r.currency}` : r.id,
      pixels: [],
    }));
  }, [partner.avLaunch, toolReady.rows]);
  const boardAccounts = partner.avLaunch ? avToolAccounts : adAccounts;
  // The AV card's Profile pick (owner ask 30.09: TOOL took session_id — "теперь можем сделать выбор
  // профилей"): the live TOOL sessions per cabinet, straight from the ready rows. null until the first
  // answer lands, so a card never flags its pick as unavailable while the roster is still loading.
  const avToolSessions = useMemo<ReadonlyMap<string, ToolSessionOption[]> | null>(() => {
    if (!partner.avLaunch || !toolReady.loaded) return null;
    return new Map(toolReady.rows.map((r) => [r.id, r.sessions]));
  }, [partner.avLaunch, toolReady.loaded, toolReady.rows]);
  // The TOOL-visible account set to constrain MO/AIF auto-fill to (null unless a TOOL wave is
  // armed) — mirrors the card picker's filter so the board default lands in the same set.
  const toolVisible = graphToolActive ? toolReady.accounts : null;
  const toolVisibleRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    toolVisibleRef.current = toolVisible;
  }, [toolVisible]);

  // Latest partner for callbacks that must not re-subscribe on partner switch.
  const partnerRef = useRef(partner);
  useEffect(() => {
    partnerRef.current = partner;
  }, [partner]);

  // Latest accounts for the mutate() wrapper (defaults fill on every board change). `boardAccounts`
  // is the token catalog for MO/AIF/HS and the TOOL ready rows for AV-on-TOOL — the auto-pick then
  // lands in a TOOL cabinet just like the picker offers.
  const adAccountsRef = useRef<AdAccountOption[] | null>(null);
  useEffect(() => {
    adAccountsRef.current = boardAccounts;
  }, [boardAccounts]);

  // When the account list ARRIVES, backfill defaults (the least-loaded account + its preferred
  // pixel) into cards created while it was loading. Functional updater returns the same
  // reference when nothing changes, so this never cascades.
  useEffect(() => {
    if (!boardAccounts || boardAccounts.length === 0) return;
    setCampaigns((cs) => fillAccountDefaults(cs, partnerRef.current, boardAccounts, limitsRef.current, toolVisibleRef.current));
  }, [boardAccounts]);

  // When the TOOL-visible set changes (channel switched to/from TOOL, or its readiness landed),
  // re-fill account defaults so cards converge onto a TOOL-visible account (or off a now-hidden
  // one) — the card's self-heal clears a hidden pick, this refills a visible one; they converge.
  useEffect(() => {
    const accts = adAccountsRef.current;
    if (!accts || accts.length === 0) return;
    setCampaigns((cs) => fillAccountDefaults(cs, partnerRef.current, accts, limitsRef.current, toolVisible));
  }, [toolVisible]);

  // Fanpage defaults (owner rule 09-08): the least-filled fanka fills every empty card — on the
  // list's arrival, again when its fill counts land (the auto memory lets those cards re-settle
  // on the emptiest page), and for every new card via mutate().
  const fanpagesRef = useRef<FanpageOption[] | null>(null);
  useEffect(() => {
    fanpagesRef.current = fanpages;
  }, [fanpages]);
  useEffect(() => {
    if (!fanpages || fanpages.length === 0) return;
    setCampaigns((cs) => fillPageDefaults(cs, partnerRef.current, fanpages));
  }, [fanpages]);

  // Pull the live registry and (re)assign gcm codes above whatever is already used. Runs on
  // mount and again when the window regains focus (≥15s apart): with several accounts working
  // at once another user may claim a previewed code — the claim itself is atomic server-side,
  // this just keeps the optimistic previews close to reality.
  const lastGcmFetch = useRef<{ api: string; at: number }>({ api: "", at: 0 });
  const refreshGcm = useCallback(() => {
    if (!poolApi) return;
    const last = lastGcmFetch.current;
    if (last.api === poolApi && Date.now() - last.at < 15_000) return;
    lastGcmFetch.current = { api: poolApi, at: Date.now() };
    fetch(poolApi)
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d.used)) return;
        const set = new Set<string>(d.used);
        // AV reports its registered ceiling as poolMax; MO/AIF omit it (→ null → static max).
        const max = typeof d.poolMax === "number" ? d.poolMax : null;
        setReservedState({ api: poolApi, set, poolMax: max });
        // The partner may have switched while this was in flight — assigning the new partner's
        // codes from the OLD pool's snapshot could preview an already-taken code. Only normalize
        // while this snapshot still belongs to the current partner's registry.
        if (markerPool(partnerRef.current)?.api === poolApi) {
          setCampaigns((cs) => normalize(cs, partnerRef.current, set, partnerRef.current.avLaunch ? max : null));
        }
      })
      .catch(() => {
        /* registry unreachable — keep the previous reserved set (null on first load =
           no possibly-taken code is handed out) */
      });
  }, [poolApi]);

  useEffect(() => {
    refreshGcm();
    const onFocus = () => refreshGcm();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGcm]);

  // Fold the codes of launches completed SINCE the last registry snapshot back into the reserved
  // set — the registry fetch is throttled (15s), so a wave finishing between refreshes must not
  // re-preview its own codes. ONLY post-snapshot completions count: older done tasks are already
  // reflected in the registry — and since codes are recyclable (released codes return to the pool,
  // 08-12), re-reserving every historical done task's code would phantom-fill the pool (live bug:
  // 86 taken in the registry, banner claimed 196 — the shared Task Manager's history re-added 110
  // long-released codes). The registry snapshot stays the source of truth; stays null while it
  // hasn't loaded (→ keep assigning nothing).
  useEffect(() => {
    // Safe setState-in-effect: the functional updater returns the SAME reference when nothing new is
    // added, so it never re-renders (let alone cascades); it only grows `reserved` when a launch
    // actually completes with a new claimed code.
    setReservedState((prev) => {
      if (!prev || prev.api !== poolApi) return prev;
      let set: Set<string> | null = null;
      for (const t of tasks) {
        // Only the CURRENT partner's completions belong to this pool — an MO wave finishing
        // while the board sits on AIF must not fold gcm codes into the brand set (and vice versa).
        const fresh =
          t.status === "done" && t.partner === partnerId && (t.finishedAt ?? 0) > lastGcmFetch.current.at;
        const g = fresh ? t.result?.gcm : undefined;
        if (g && !prev.set.has(g)) {
          set = set ?? new Set(prev.set);
          set.add(g);
        }
      }
      return set ? { api: prev.api, set, poolMax: prev.poolMax } : prev;
    });
  }, [tasks, poolApi, partnerId]);

  // Single-flight latch for the Launch click: launchWave() awaits a fresh limits fetch before
  // anything enqueues, and a double-click's second call lands inside that window — both calls
  // would pass every guard and fire the whole wave twice (real duplicate campaigns within the
  // account's 5/30min headroom). React state can't close a same-tick window; the synchronous
  // gate does. launchBusy greys the rail button for the visible part of the wave.
  const launchGate = useRef(makeGate());
  const [launchBusy, setLaunchBusy] = useState(false);

  async function launch() {
    if (!launchGate.current.enter()) return; // double-click — the first call owns this wave
    setLaunchBusy(true);
    try {
      await launchWave();
    } finally {
      launchGate.current.exit();
      setLaunchBusy(false);
    }
  }

  /** Non-blocking launch (guarded by launch()'s gate above): every launchable campaign is captured
   *  + dropped into the Task Manager instantly, then flies off the board so you can keep building.
   *  The queue creates them one by one (ACTIVE since 08-11) in the background. */
  async function launchWave() {
    // Pool exhausted → nothing may launch: stale card previews would only burn failed claims
    // (the rail button is disabled too; the server-side claim is the last-resort guard).
    if (poolExhausted) return;
    // A tab older than the deployed build has outdated gates — launching is locked until reload
    // (the banner explains; the rail button is disabled too).
    if (limits.staleBuild) return;
    // No token for this rail (nothing assigned on /tokens, no env default): nothing fires (belt
    // over the rail's disabled button; the server refuses signer-less launches too). AV keeps this
    // gate too — its token is what pulls the fanpage, so an unassigned AV slot means no page and no
    // launchable card (owner ask 28.09).
    if (!signerReady) return;
    // AV launches ONLY through TOOL (owner ask 28.09): with no live session ready there is nothing
    // to fire, and it must NEVER fall back to a token rail. Belt over the disabled Launch button.
    if (partner.avLaunch && !avOnTool) return;
    const opts = launchReadyOpts(partner);
    const launchable = campaigns.filter((c) => isLaunchable(c, opts));
    if (launchable.length === 0) return;

    // Account launch limit (5 campaigns / 30 min, all users & channels): send only what fits each
    // account's remaining capacity, measured against a picture fetched AT THIS CLICK — never the
    // ≤30s poll cache (another buyer may have filled the account seconds ago). Capacity =
    // fresh server count + own queued tasks + what this very wave has just taken (sentNow —
    // enqueued tasks only reach the pending fold on the next render). The overflow stays on the
    // board with the amber rail note; the server-side claim stays the final authority for
    // whatever still races past.
    const fresh = await limits.fetchFresh(); // null on a blip → the cached view gates instead
    const serverCountOf = (k: string): number => {
      if (!fresh) return Math.max(0, limits.countFor(k) - limits.pendingFor(k));
      const a = fresh.accounts[k];
      return a && a.resetAt > Date.now() + fresh.skew ? a.count : 0;
    };
    const sentNow = new Map<string, number>();
    const fitsAcct = (acct: string): boolean => {
      const k = acctIdKey(acct);
      if (!k) return true; // no account bound (non-token partners) — nothing to meter here
      return serverCountOf(k) + limits.pendingFor(k) + (sentNow.get(k) ?? 0) < limits.limit;
    };
    const noteSent = (acct: string) => {
      const k = acctIdKey(acct);
      if (k) sentNow.set(k, (sentNow.get(k) ?? 0) + 1);
    };
    let held = 0;
    const showHeld = (n: number) => {
      setHeldBack(n);
      if (heldTimer.current) window.clearTimeout(heldTimer.current);
      if (n > 0) heldTimer.current = window.setTimeout(() => setHeldBack(0), 8000);
    };

    // HS: every launchable card becomes ONE submit on the picked rail — LION's create weapon
    // (one ad per creative URL, built on LION's side) or the FB Token rail (the same tree built
    // directly on the Graph by /api/hs/token-launch). Cards stay on the board for
    // tweak-and-relaunch, same as MO. The token pick is honored only while the server says the
    // rail is provisioned — otherwise the wave falls back to LION rather than dying en masse.
    if (partner.lionLaunch) {
      // Effective HS rail (owner ask 28.09): TOOL when picked AND ready, else FB Token when picked
      // AND provisioned, else LION — a stale pick falls back rather than dying en masse.
      const channel: HsLaunchChannel =
        hsChannel === "tool" && toolReady.ready
          ? "tool"
          : hsChannel === "token" && hs.tokenLaunch
            ? "token"
            : "lion";
      const ddmm = todaySaoPauloDDMM();
      let sent = 0;
      for (const c of launchable) {
        const media = c.files.filter((f) => f.kind === "video" || f.kind === "image");
        if (media.length === 0) continue;
        if (!fitsAcct(c.account)) {
          held++;
          continue;
        }
        hsTasks.enqueue({
          campaign: c,
          files: media,
          // Channel-marked display name (FB Token rail → fixed TOKEN marker) — the drawer row
          // must read like the campaign the server actually creates.
          name: hsFullName(c, hs.acr, ddmm, channel),
          profile: c.profile,
          geo: geoSummary(c.countries),
          budget: c.budget,
          channel,
        });
        noteSent(c.account);
        sent++;
      }
      setPreviewed(false);
      setJustQueued(sent);
      showHeld(held);
      // The drawer opens itself on a launch (owner ask 08-17): the queue's progress is the thing
      // the buyer needs to watch next, and the floating still-launching guard takes over if they
      // close it early.
      if (sent > 0) hsTasks.setOpen(true);
      if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
      queuedTimer.current = window.setTimeout(() => setJustQueued(0), 3500);
      return;
    }

    // Reserve every code we're launching right now (optimistic — the tasks fire in the background),
    // so any card built next never re-previews a code that's already on its way into the registry.
    const nextReserved = reserved ? new Set(reserved) : null;
    const launched = new Set<string>();
    const launchApi = poolApi; // snapshot — the async wave keeps writing to ITS pool's key
    for (const c of launchable) {
      const media = firstMedia(c);
      if (!media) continue;
      if (!fitsAcct(c.account)) {
        held++;
        continue;
      }
      if (nextReserved && c.gcm) nextReserved.add(c.gcm);
      // Every creative on the card (capped by the partner, e.g. MO = 5) — one ad each under the
      // campaign's single ad set. Legacy single-media fields carry the first one alongside.
      const medias = c.files
        .filter((f) => f.kind === "video" || f.kind === "image")
        .slice(0, Math.max(1, partner.maxCreatives ?? 1))
        .map((f) => ({
          url: f.url,
          name: f.name,
          kind: f.kind === "image" ? ("image" as const) : ("video" as const),
          // Custom video cover picked in the dropzone (images are their own cover).
          ...(f.kind === "video" && f.cover ? { cover: f.cover } : {}),
        }));
      enqueue({
        partnerId,
        campaign: c,
        // The signer is resolved server-side from the owner's /tokens pick; the drawer row
        // previews the SOC-marked name the server will really create (moEnsureSocMark is the truth).
        medias,
        mediaUrl: media.url,
        mediaName: media.name,
        mediaKind: media.kind === "image" ? "image" : "video",
        ...(media.kind === "video" && media.cover ? { cover: media.cover } : {}),
        // TOOL wave (owner ask 28.09): the marked preview name (server re-ensures it) and the
        // distinct `via:"tool"` field — NEVER the retired soc `channel`. TOOL drops the SOC mark.
        // AV always rides TOOL (the guard above already blocked a not-ready AV wave), so it is
        // marked + sent via:"tool" unconditionally — it must NEVER fall back to a token rail.
        name: graphToolActive || partner.avLaunch
          ? toolEnsureMark(fullName(c))
          : moSocMarks
            ? moEnsureSocMark(fullName(c))
            : fullName(c),
        ...(graphToolActive || partner.avLaunch ? { via: "tool" as const } : {}),
        gcm: c.gcm,
        geo: geoSummary(c.countries),
        budget: c.budget,
      });
      noteSent(c.account);
      launched.add(c.id);
    }
    if (nextReserved) setReservedState({ api: launchApi, set: nextReserved, poolMax: endpointMax });
    setPreviewed(false);

    // Keep the campaigns on the board so you can tweak them and relaunch — only clear the gcm of the
    // ones just sent (their codes are now taken) so normalize hands them fresh codes for the next wave.
    setCampaigns((cs) =>
      normalize(cs.map((c) => (launched.has(c.id) ? { ...c, gcm: "" } : c)), partner, nextReserved, poolMax),
    );

    setJustQueued(launched.size);
    showHeld(held);
    if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    queuedTimer.current = window.setTimeout(() => setJustQueued(0), 3500);
  }

  // Stable identity (useCallback): every card handler derives from mutate, and the cards are
  // memoized — handler churn would re-render the whole wave on each keystroke (review find
  // 08-24). Refs carry the volatile lookups; only partner/reserved changes (rare) re-mint it.
  const mutate = useCallback(
    (fn: (cs: Campaign[]) => Campaign[]) => {
      setCampaigns((cs) =>
        fillPageDefaults(
          fillAccountDefaults(
            normalize(fn(cs), partner, reserved, poolMax),
            partner,
            adAccountsRef.current,
            limitsRef.current,
            toolVisibleRef.current,
          ),
          partner,
          fanpagesRef.current,
        ),
      );
      setPreviewed(false);
    },
    [partner, reserved, poolMax],
  );

  function changePartner(id: PartnerId) {
    setPartnerId(id);
    const cfg = partnerConfig(id);
    // A card's marker (Campaign.gcm) is a code of the OUTGOING partner's pool — an MO gcm ("05"), an
    // AIF brand ("test05") or an AV key ("av005"); the shapes never collide, so assignPoolCodes' "row
    // already has a gcm" guard would KEEP the stale code across a switch instead of reassigning from
    // the incoming pool. For AV that stale code is a money-safety defect: a carried MO/AIF marker reads
    // as a valid utm_campaign in the AV link preview + Copy while it is NOT a registered AV key, and it
    // survives the poolMax-0 stub. Clear the marker whenever the switch crosses the AV rail (either
    // direction) and pass reserved as null so nothing is handed out from the OUTGOING pool's snapshot —
    // refreshGcm loads the new pool's used-set + poolMax and assigns then, exactly like a fresh mount
    // (poolMax 0 → no code, matching the stub). MO/AIF/HS ↔ MO/AIF/HS switches stay byte-identical: the
    // branch is dead while AV is dormant (review find 09-28).
    const crossesAv = Boolean(cfg.avLaunch) || Boolean(partner.avLaunch);
    // Re-baseline the redirect to the incoming partner's default (HS → HIGH ADX). Cards born on
    // another partner carry makeCampaign's global META ADX from a board where the field never
    // rendered — without this, switching MO → HS shows every card on a redirect nobody picked.
    setCampaigns((cs) => {
      let next = cfg.defaultRedirect
        ? cs.map((c) => (c.redirectType === cfg.defaultRedirect ? c : { ...c, redirectType: cfg.defaultRedirect! }))
        : cs;
      if (crossesAv) next = next.map((c) => (c.gcm ? { ...c, gcm: "" } : c));
      return normalize(next, cfg, crossesAv ? null : reserved);
    });
    setPreviewed(false);
    // Every drawer closes on a partner switch: the swapped-in tasks button could otherwise open a
    // second z-[80] panel on top of a still-open one (reachable keyboard-only — review find 08-17).
    teamTm.setOpen(false);
    aifTm.setOpen(false);
    avTm.setOpen(false);
    hsTasks.setOpen(false);
    // The pick rides in the URL so a refresh reopens on the same partner (no navigation).
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.history.replaceState(null, "", url);
  }

  const patch = useCallback(
    (id: string, p: Partial<Campaign>) => mutate((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c))),
    [mutate],
  );

  const toggleCollapse = useCallback(
    (id: string) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c))),
    [],
  );

  /** Launch-bay row click → expand the card, smooth-scroll the page to it, then focus-pulse it. */
  const jumpTo = (id: string) => {
    setCampaigns((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null); // reset so re-clicking the same card re-triggers the pulse
    window.setTimeout(() => {
      document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) window.clearTimeout(hlTimer.current);
    hlTimer.current = window.setTimeout(() => setHighlightId(null), 1800);
  };

  const add = () => {
    mutate((cs) => [...cs, freshCard(`c${nextId.current++}`, partner, user?.username ?? "")]);
  };

  const duplicate = useCallback(
    (id: string) =>
      mutate((cs) => {
        const i = cs.findIndex((c) => c.id === id);
        if (i === -1) return cs;
        // primary text carried over verbatim from the source (cloneCardFrom spreads it)
        const clone = cloneCardFrom(cs[i], `c${nextId.current++}`);
        return [...cs.slice(0, i + 1), clone, ...cs.slice(i + 1)];
      }),
    [mutate],
  );

  const remove = useCallback((id: string) => mutate((cs) => cs.filter((c) => c.id !== id)), [mutate]);

  /** Copy the picked settings from the first campaign onto every other one. gcm is NEVER copied
   *  (each ad keeps its own code); every other field including `name` is copied only when the user
   *  ticks it in the modal (name is offered default-on, per the 08-05 wave workflow). Locks re-sync
   *  via normalize; account defaults re-fill via mutate → fillAccountDefaults. */
  const applyCopy = (keys: (keyof Campaign)[]) => {
    setCopyOpen(false);
    if (keys.length === 0) return;
    mutate((cs) => {
      if (cs.length <= 1) return cs;
      const src = cs[0];
      const patch: Record<string, unknown> = {};
      for (const k of keys) {
        const v = src[k];
        patch[k] = Array.isArray(v) ? [...v] : v; // clone arrays (geo/locales/files)
      }
      // objective ↔ conversionEvent are a pair — copying one without the other would leave a
      // target with an event invalid for its objective (Meta rejects the ad set). Copy both together.
      if (keys.includes("objective") || keys.includes("conversionEvent")) {
        patch.objective = src.objective;
        patch.conversionEvent = src.conversionEvent;
      }
      // Fresh array/object identities PER TARGET — one shared array across N cards is the exact
      // sibling-bleed footgun cloneCardFrom exists to prevent (review find 08-24).
      return cs.map((c, i) => {
        if (i === 0) return c;
        const mine: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          mine[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? { ...(x as object) } : x)) : v;
        }
        return { ...c, ...(mine as Partial<Campaign>) };
      });
    });
  };

  // Capped at the marker pool size (and 200 overall — a bigger board is unusable anyway) so a
  // full wave can't leave a card without a code. AV uses its REGISTERED range when known (a wave
  // can't exceed the keys uploaded to ActiveView); its unregistered stub keeps the static cap so
  // the board is still buildable (the launch gate blocks it anyway).
  const MAX_CARDS = Math.min(poolMax && poolMax > 0 ? poolMax : pool?.max ?? GCM_POOL_MAX, GCM_POOL_MAX);

  /** Wave builder: APPEND `n` new cards (owner switched from ×multiply 08-11), cycling through
   *  the existing cards as templates — one template card → n identical copies, several cards →
   *  copies round-robin. Fresh gcm each, primary text verbatim; clones open expanded. */
  const duplicateAll = (n: number) =>
    mutate((cs) => {
      if (cs.length === 0) return cs;
      const out = [...cs];
      for (let k = 0; k < n && out.length < MAX_CARDS; k++) {
        out.push(cloneCardFrom(cs[k % cs.length], `c${nextId.current++}`));
      }
      return out;
    });

  const setAllCollapsed = (collapsed: boolean) =>
    setCampaigns((cs) => cs.map((c) => ({ ...c, collapsed })));

  const removeAll = () =>
    mutate(() => [freshCard(`c${nextId.current++}`, partner, user?.username ?? "")]);

  /** Copy one card's creatives onto every card — build a wave, drop the video once, apply to all.
   *  Each card gets its OWN array + file objects (identity-fresh — see cloneCardFrom's rationale). */
  const applyFilesToAll = useCallback(
    (files: FileItem[]) => mutate((cs) => cs.map((c) => ({ ...c, files: files.map((f) => ({ ...f })) }))),
    [mutate],
  );

  return (
    <>
      <Header partner={partnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        {/* Free-pool alert, first thing on the board: designers must see BEFORE building cards
            that launches are (about to be) blocked. Red = pool exhausted (Launch disabled),
            amber = running low. gcm partners only; hidden until the registry loads. */}
        {pool && poolUnregistered ? (
          // AV stub: nothing registered in ActiveView yet — the owner uploads the key pool first.
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6">
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-danger/45 bg-danger/10 px-4 py-3 text-[13px] font-semibold text-danger"
            >
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
              No {pool.label}s are registered in ActiveView yet — launching is blocked until an owner
              uploads the key pool (AV keys page) and sets AV_KEYS_REGISTERED.
            </div>
          </div>
        ) : pool && poolFree !== null && poolFree <= GCM_LOW_WATER ? (
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6">
            <div
              role="alert"
              className={
                "flex items-center gap-3 rounded-xl border px-4 py-3 text-[13px] font-semibold " +
                (poolFree === 0
                  ? "border-danger/45 bg-danger/10 text-danger"
                  : "border-warn/40 bg-warn/10 text-warn")
              }
            >
              <span
                className={
                  "h-2 w-2 shrink-0 animate-pulse rounded-full " +
                  (poolFree === 0 ? "bg-danger" : "bg-warn")
                }
              />
              {poolFree === 0
                ? `No free ${pool.label} codes left — all ${poolMax ?? pool.max} are in use. Launching is blocked until codes are freed in the registry.`
                : `Only ${poolFree} free ${pool.label} code${poolFree === 1 ? "" : "s"} left of ${poolMax ?? pool.max} — a bigger wave won't fit.`}
            </div>
          </div>
        ) : null}
        {/* HS launch-token pool exhausted: FB Token launches are refused by the server gate —
            tell buyers up front (the LION API channel keeps working). */}
        {partner.lionLaunch && hsTokensDown ? (
          <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6">
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-danger/45 bg-danger/10 px-4 py-3 text-[13px] font-semibold text-danger"
            >
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
              All FB launch tokens are rate-limited — FB Token launches are blocked until a
              cooldown lifts (see the Tokens widget). The LION API channel keeps working.
            </div>
          </div>
        ) : null}
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {campaigns.length}
              </span>

              {/* wave builder — append N more copies at once */}
              <div className="ml-1 flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface">
                <span className="px-2.5 text-[12px] font-medium text-dim">Duplicate all</span>
                {[2, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => duplicateAll(n)}
                    className={
                      "h-9 border-l border-line px-2.5 font-mono text-[12px] text-dim transition-colors " +
                      "hover:bg-accent/15 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    }
                  >
                    +{n}
                  </button>
                ))}
              </div>

              {campaigns.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setAllCollapsed(anyExpanded)}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-dim transition-colors hover:border-line2 hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <ChevronsIcon className={"h-3.5 w-3.5 transition-transform " + (anyExpanded ? "" : "rotate-180")} />
                    {anyExpanded ? "Collapse all" : "Expand all"}
                  </button>
                  <button
                    type="button"
                    onClick={removeAll}
                    className="flex h-9 items-center rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-faint transition-colors hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Clear
                  </button>
                </>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCopyOpen(true)}
                  disabled={campaigns.length <= 1}
                  className={
                    "flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 " +
                    "text-[13px] font-medium text-dim transition-all duration-150 " +
                    "hover:border-line2 hover:bg-surface2 hover:text-ink active:scale-[0.97] " +
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-dim " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <CopyIcon className="h-4 w-4 text-accent2" />
                  Copy to all
                </button>
                <button
                  type="button"
                  onClick={add}
                  className={
                    "flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 " +
                    "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
                    "hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97] " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>

            {campaigns.map((c, i) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                index={i}
                partner={partner}
                // AV: the fanpage picker reads the AV token's own catalog (owner ask 28.09 — the
                // token pulls only the fanpage), same as the direct-Graph AV rail. MO/AIF read theirs.
                fanpages={fanpages}
                // AV launches only through TOOL → the account picker reads the TOOL ready rows
                // (boardAccounts); every other rail reads the token catalog (owner ask 28.09).
                adAccounts={boardAccounts}
                hs={partner.lionLaunch ? hs : undefined}
                avDestinations={partner.avLaunch ? avDestinations : undefined}
                highlight={highlightId === c.id}
                // Covers ride only where WE pin the thumbnail (owner rule): MO/AIF rails always do;
                // HS only on the FB Token or TOOL channel — the LION weapon picks its own frame.
                coversEnabled={partner.lionLaunch ? (hsChannel === "token" && hs.tokenLaunch) || hsToolActive : true}
                // FB Token rail picked → the card's account picker filters to token-visible ones.
                hsTokenRail={partner.lionLaunch ? hsChannel === "token" && hs.tokenLaunch : false}
                // TOOL is the effective channel (owner ask 28.09) → the account picker filters to
                // TOOL-visible accounts and the name preview carries the GCL TOOL marker. AV rides
                // this too (avOnTool ⊂ graphToolActive): its cabinet list is the TOOL ready rows.
                toolRail={hsToolActive}
                moToolRail={graphToolActive}
                toolAccounts={toolReady.ready ? toolReady.accounts : undefined}
                // AV: the live TOOL profiles per cabinet for the card's Profile pick (owner ask 30.09).
                toolSessions={partner.avLaunch ? avToolSessions : undefined}
                // Соц-class channel picked (MO) → the card's name preview carries the SOC marker
                // (alternate SYSTEM entries launch unmarked — preview stays unmarked too). TOOL
                // drops SOC, so never show it on a TOOL wave.
                moSocRail={moSocMarks && !graphToolActive}
                onPatch={patch}
                onToggleCollapse={toggleCollapse}
                onDuplicate={duplicate}
                onRemove={remove}
                onApplyFilesToAll={campaigns.length > 1 ? applyFilesToAll : undefined}
              />
            ))}

            <button
              type="button"
              onClick={add}
              className={
                "flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed " +
                "border-line2 text-[13px] font-medium text-dim transition-all duration-200 " +
                "hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          <LaunchRail
            campaigns={campaigns}
            partner={partner}
            launching={launchBusy}
            hsAcr={hs.acr}
            hsChannel={hsChannel}
            hsTokenReady={hs.tokenLaunch}
            onHsChannel={changeHsChannel}
            tool={toolReady}
            graphChannel={graphChannel}
            onGraphChannel={changeGraphChannel}
            signer={railSigner}
            signerLoaded={signers.loaded}
            owner={Boolean(user?.owner)}
            previewed={previewed}
            justQueued={justQueued}
            inFlight={
              partner.lionLaunch
                ? hsTasks.counts.inFlight
                : partner.avLaunch
                  ? avTm.counts.inFlight
                  : partner.aifLaunch
                    ? aifTm.counts.inFlight
                    : teamTm.counts.inFlight
            }
            heldBack={heldBack}
            poolFree={poolFree}
            poolMax={poolMax}
            onJump={jumpTo}
            onPreview={() => setPreviewed(true)}
            onLaunch={launch}
          />
        </div>
      </main>

      <CopySettingsModal
        open={copyOpen}
        source={campaigns[0] ?? null}
        count={Math.max(0, campaigns.length - 1)}
        partner={partner}
        onClose={() => setCopyOpen(false)}
        onApply={applyCopy}
      />
    </>
  );
}
