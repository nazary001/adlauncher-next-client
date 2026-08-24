"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Campaign, FileItem } from "@/lib/types";
import { bidKind, firstMedia, fullName, isLaunchable, makeCampaign } from "@/lib/types";
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
} from "@/lib/partners";
import { hsFullName, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { makeGate } from "@/lib/launch-guards";
import { Header } from "./header";
import { CampaignCard } from "./campaign-card";
import { useFanpages } from "./use-fanpages";
import { hsTokensAllDown, useHsTokenStatus } from "./hs-token-status";
import { type AdAccountOption, defaultPixelFor, useAdAccounts } from "./use-adaccounts";
import { type AcctLimits, acctIdKey, useAcctLimits } from "./use-acct-limit";
import { useHs } from "./use-hs";
import { LaunchRail } from "./launch-rail";
import { CopySettingsModal } from "./copy-settings-modal";
import { ChevronsIcon, CopyIcon, PlusIcon } from "./icons";
import { useAifTaskManager, useTaskManager } from "./task-manager";
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

/** Today as DD.MM for the campaign-name prefix. Runs client-side (and on the local dev server). */
function todayDDMM(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Free-pool warning threshold: at or below this many free gcm codes the board shows the early
 *  amber banner, so designers know BEFORE building a wave that it may not fit. 0 = hard block. */
const GCM_LOW_WATER = 15;

/** The HS launch-rail pick (LION API vs FB Token) survives refreshes — buyers run whole waves on
 *  one rail, re-picking it every session would invite accidental LION shots mid-token-wave. */
const HS_CHANNEL_LS = "adlauncher.hs.channel";

/** gcm auto-claim (skipping registry-reserved codes) + single account/pixel/fanpage pinning. */
function normalize(rows: Campaign[], partner: PartnerConfig, reserved: Set<string> | null): Campaign[] {
  const pool = markerPool(partner);
  const withGcm = pool ? assignPoolCodes(rows, reserved, pool) : rows;
  return applyPartnerLocks(withGcm, partner);
}

/** Fresh card with the partner's own defaults on top of makeCampaign's (e.g. HS is born with the
 *  HIGH-ADX redirect — owner call 08-13). Duplicates copy their source instead, on purpose. */
function freshCard(id: string, partner: PartnerConfig, owner: string): Campaign {
  const c = makeCampaign(id, namePrefixFor(partner, todayDDMM()), owner);
  if (partner.defaultRedirect) c.redirectType = partner.defaultRedirect;
  return c;
}

/** Token-account partners: fill an empty/invalid account with the partner default (else the first
 *  token account) and keep the pixel on something the chosen account actually carries. When the
 *  natural default sits at its 5/30min launch limit, the fill prefers the first account with
 *  room (falls back to the full one when every account is full). Only ever touches EMPTY/invalid
 *  accounts — a buyer's pick is never moved. Pure — returns the SAME array when nothing changes. */
function fillAccountDefaults(
  rows: Campaign[],
  partner: PartnerConfig,
  adAccounts: AdAccountOption[] | null,
  limits?: Pick<AcctLimits, "countFor" | "limit">,
): Campaign[] {
  if (!partner.accountsFromToken || !adAccounts || adAccounts.length === 0) return rows;
  const hasRoom = (id: string) => !limits || limits.countFor(id) < limits.limit;
  let changed = false;
  const next = rows.map((c) => {
    let account = c.account;
    if (!account || !adAccounts.some((a) => a.value === account)) {
      const preferred = adAccounts.some((a) => a.value === partner.defaultAccount?.id)
        ? partner.defaultAccount!.id
        : adAccounts[0].value;
      account = hasRoom(preferred)
        ? preferred
        : (adAccounts.find((a) => hasRoom(a.value))?.value ?? preferred);
    }
    let pixel = c.pixel;
    const pixels = adAccounts.find((a) => a.value === account)?.pixels ?? [];
    // Min-ROAS cards are pinned to the value pixel — never re-fill them, even if this account's
    // list misses it (the launch route's pixel_not_on_account then names the real problem
    // instead of a silent swap ping-ponging with the card's pin effect). AIF pixels are derived
    // from the optimization (applyPartnerLocks), never filled from the account's list.
    if (!partner.aifLaunch && bidKind(c.bidStrategy) !== "roas" && (!pixel || !pixels.some((p) => p.id === pixel))) {
      pixel = defaultPixelFor(adAccounts, account, partner.preferredPixel);
    }
    if (account === c.account && pixel === c.pixel) return c;
    changed = true;
    return { ...c, account, pixel };
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
  const [partnerId, setPartnerId] = useState<PartnerId>(initialPartner);
  // Codes already taken in the current partner's Strapi registry (MO gcm / AIF brand), keyed by
  // the registry endpoint they came from: switching partners makes the other pool's snapshot
  // instantly invalid (derived `reserved` reads null → assign nothing until the refetch lands).
  const [reservedState, setReservedState] = useState<{ api: string; set: Set<string> } | null>(null);
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
  const partner = partnerConfig(partnerId);
  // The board talks to the ACTIVE partner's own task manager: AIF launches queue/track in the
  // separate AIF instance (own drawer, own Strapi scope), everything else in the team one.
  const { enqueue, tasks } = partner.aifLaunch ? aifTm : teamTm;
  const anyExpanded = campaigns.some((c) => !c.collapsed);
  // The partner's marker pool (MO gcm 01..200 / AIF brand test01..test700; null = no markers).
  const pool = markerPool(partner);
  const poolApi = pool?.api ?? "";
  // The current partner's used-set — null while another pool's snapshot (or nothing) is loaded.
  const reserved = reservedState && reservedState.api === poolApi ? reservedState.set : null;
  // Free codes left in the registry pool (null until the registry loads). `reserved` is the
  // live used-set — refreshed on focus and grown by completed launches — so this count updates
  // without extra requests. Drives the exhaustion banner and the Launch hard-block below.
  const poolFree = pool && reserved ? Math.max(0, pool.max - reserved.size) : null;
  const poolExhausted = Boolean(pool) && poolFree === 0;
  // Token fanpages for the per-card fanka picker, each with its live N/limit fill tag from the
  // hs-tools registry (AIF reads its own token's pages; its registry scope fills the badges the
  // day the box starts syncing AIF pages — empty until then).
  const fanpages = useFanpages(
    Boolean(partner.fanpagesFromToken),
    partner.pageAdLimit ?? 250,
    partner.aifLaunch ? { list: "/api/aif/fanpages", volume: "/api/aif/fanpages/volume" } : undefined,
  );
  // HS launch-token pool health — powers the "all tokens burned" banner (the server gate is the
  // enforcement; this is the courtesy warning before buyers build a wave into a 429).
  const hsTokenStatus = useHsTokenStatus(Boolean(partner.lionLaunch));
  const hsTokensDown = partner.lionLaunch ? hsTokensAllDown(hsTokenStatus.tokens, hsTokenStatus.loaded) : false;
  // Token ad accounts (with their pixels) for the account/pixel pickers.
  const adAccounts = useAdAccounts(
    Boolean(partner.accountsFromToken),
    partner.preferredPixel,
    partner.aifLaunch ? "/api/aif/adaccounts" : undefined,
  );
  // LION catalog (HS): profiles + ACR, per-profile accounts/pages/locales, per-account pixels.
  const hs = useHs(Boolean(partner.lionLaunch));
  const hsTasks = useHsTaskManager();
  // HS launch rail: LION create weapon (default) or the FB Token direct-Graph build. Restored
  // from localStorage after mount (SSR-safe); the token option is offered only once the server
  // says the rail is provisioned (hs.tokenLaunch).
  const [hsChannel, setHsChannel] = useState<HsLaunchChannel>("lion");
  useEffect(() => {
    try {
      const v = localStorage.getItem(HS_CHANNEL_LS);
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR),
      // and only flips the default when a pick was actually saved.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "token" || v === "lion") setHsChannel(v);
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

  // Latest partner for callbacks that must not re-subscribe on partner switch.
  const partnerRef = useRef(partner);
  useEffect(() => {
    partnerRef.current = partner;
  }, [partner]);

  // Latest accounts for the mutate() wrapper (defaults fill on every board change).
  const adAccountsRef = useRef<AdAccountOption[] | null>(null);
  useEffect(() => {
    adAccountsRef.current = adAccounts;
  }, [adAccounts]);

  // When the account list ARRIVES, backfill defaults (BR-1500 + its preferred pixel) into cards
  // created while it was loading. Functional updater returns the same reference when nothing
  // changes, so this never cascades.
  useEffect(() => {
    if (!adAccounts || adAccounts.length === 0) return;
    setCampaigns((cs) => fillAccountDefaults(cs, partnerRef.current, adAccounts, limitsRef.current));
  }, [adAccounts]);

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
        setReservedState({ api: poolApi, set });
        // The partner may have switched while this was in flight — assigning the new partner's
        // codes from the OLD pool's snapshot could preview an already-taken code. Only normalize
        // while this snapshot still belongs to the current partner's registry.
        if (markerPool(partnerRef.current)?.api === poolApi) {
          setCampaigns((cs) => normalize(cs, partnerRef.current, set));
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
      return set ? { api: prev.api, set } : prev;
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
      const channel: HsLaunchChannel = hsChannel === "token" && hs.tokenLaunch ? "token" : "lion";
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
        medias,
        mediaUrl: media.url,
        mediaName: media.name,
        mediaKind: media.kind === "image" ? "image" : "video",
        ...(media.kind === "video" && media.cover ? { cover: media.cover } : {}),
        name: fullName(c),
        gcm: c.gcm,
        geo: geoSummary(c.countries),
        budget: c.budget,
      });
      noteSent(c.account);
      launched.add(c.id);
    }
    if (nextReserved) setReservedState({ api: launchApi, set: nextReserved });
    setPreviewed(false);

    // Keep the campaigns on the board so you can tweak them and relaunch — only clear the gcm of the
    // ones just sent (their codes are now taken) so normalize hands them fresh codes for the next wave.
    setCampaigns((cs) =>
      normalize(cs.map((c) => (launched.has(c.id) ? { ...c, gcm: "" } : c)), partner, nextReserved),
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
        fillAccountDefaults(normalize(fn(cs), partner, reserved), partner, adAccountsRef.current, limitsRef.current),
      );
      setPreviewed(false);
    },
    [partner, reserved],
  );

  function changePartner(id: PartnerId) {
    setPartnerId(id);
    setCampaigns((cs) => normalize(cs, partnerConfig(id), reserved));
    setPreviewed(false);
    // Every drawer closes on a partner switch: the swapped-in tasks button could otherwise open a
    // second z-[80] panel on top of a still-open one (reachable keyboard-only — review find 08-17).
    teamTm.setOpen(false);
    aifTm.setOpen(false);
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
      if (keys.includes("redirectType")) patch.paramMode = src.paramMode; // keep the pair consistent
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
  // full wave can't leave a card without a code.
  const MAX_CARDS = Math.min(pool?.max ?? GCM_POOL_MAX, GCM_POOL_MAX);

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
        {pool && poolFree !== null && poolFree <= GCM_LOW_WATER ? (
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
                ? `No free ${pool!.label} codes left — all ${pool!.max} are in use. Launching is blocked until codes are freed in the registry.`
                : `Only ${poolFree} free ${pool!.label} code${poolFree === 1 ? "" : "s"} left of ${pool!.max} — a bigger wave won't fit.`}
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
                fanpages={fanpages}
                adAccounts={adAccounts}
                hs={partner.lionLaunch ? hs : undefined}
                highlight={highlightId === c.id}
                // Covers ride only on OUR FB token (owner rule): MO/AIF rails always do; HS only
                // while the FB Token channel is picked — the LION weapon picks its own frame.
                coversEnabled={partner.lionLaunch ? hsChannel === "token" && hs.tokenLaunch : true}
                // FB Token rail picked → the card's account picker filters to token-visible ones.
                hsTokenRail={partner.lionLaunch ? hsChannel === "token" && hs.tokenLaunch : false}
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
            previewed={previewed}
            justQueued={justQueued}
            heldBack={heldBack}
            poolFree={poolFree}
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
