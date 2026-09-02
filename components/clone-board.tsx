"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloneEdit,
  type CloneRow,
  type CloneSettings,
  type HighOfferConfig,
  SOURCE_ACCOUNT,
  defaultSettings,
  flattenPreview,
  fullCloneName,
  loadCloneSources,
  loadSampleSources,
  makeCloneRow,
} from "@/lib/clone";
import { bidKind, limitMoney, limitMoneyCents, moEnsureSocMark, moneyLabel, normalizeRoasGoal, parseMoney } from "@/lib/types";
import { BID_STRATEGIES, OS_OPTIONS, countryName, geoSummary } from "@/lib/catalog";
import { AIF_ROAS_LOCKED, type PartnerId, partnerConfig } from "@/lib/partners";
import { AutoTextarea, BidKindTag, Field, Select } from "./ui";
import {
  AlertIcon,
  ChevronDownIcon,
  CopyIcon,
  FilmIcon,
  GlobeIcon,
  LockIcon,
  PlusIcon,
  RetryIcon,
  SlidersIcon,
  TargetIcon,
  TrashIcon,
} from "./icons";
import { Header } from "./header";
import { useAifTaskManager, useTaskManager } from "./task-manager";
import { CloneTargetingModal } from "./clone-targeting-modal";
import { CloneHighOfferModal } from "./clone-high-offer-modal";
import { SearchSelect } from "./search-select";
import { useMoSocs } from "./use-mo-socs";
import { MO_CHANNEL_LS, MoSocPicker, defaultMoSoc } from "./mo-soc-picker";
import { useFanpages } from "./use-fanpages";
import { defaultPixelFor, pixelOptionsOf, useAdAccounts } from "./use-adaccounts";
import { decorateAccountOptions, fmtCountdown, useAcctLimits } from "./use-acct-limit";
import type { SessionUser } from "./user-menu";

/** Today as DD.MM for clone-name date stamping (client-side). */
function todayDDMM(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

const cellSelect =
  "h-8 w-full cursor-pointer appearance-none rounded-md border border-line bg-surface2 px-2 pr-6 text-[11.5px] text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

/** A row's Bid value is REQUIRED by its picked strategy (cap $ / ROAS goal; the ambiguous 10–20
 *  ROAS band counts as missing — every wire point refuses it). Mirrors the server's pre-claim
 *  checks so the fire button blocks instead of burning markers on per-clone errors. */
function rowBidMissing(r: CloneRow): boolean {
  const kind = bidKind(r.bidStrategy);
  if (kind === "none") return false;
  const v = parseMoney(r.roasGoal);
  if (v <= 0) return true;
  return kind === "roas" && normalizeRoasGoal(v) == null;
}

/** Column heading with the underline rule + an optional right-aligned count chip. */
function SectionHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
      <h4 className="text-[13px] font-semibold text-ink">{children}</h4>
      {right}
    </div>
  );
}

/** One locked destination bind (account / fanpage / pixel) — borderless row inside the card. */
function LockedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 py-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-[11.5px] text-ink" title={value}>
          {value}
        </span>
        <LockIcon className="h-3 w-3 shrink-0 text-faint" />
      </span>
    </div>
  );
}

/** Compact geo chips for the table cell. */
function GeoChips({ codes }: { codes: string[] }) {
  if (codes.length === 0) return <span className="text-[12px] text-faint">— no geo</span>;
  if (codes[0] === "WW") {
    return (
      <span className="inline-flex rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-[#9db8ff]">
        WORLD
      </span>
    );
  }
  const shown = codes.slice(0, 4);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <span
          key={c}
          title={countryName(c)}
          className="inline-flex rounded-md border border-accent/25 bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-[#9db8ff]"
        >
          {c}
        </span>
      ))}
      {codes.length > shown.length ? (
        <span className="inline-flex rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-faint">
          +{codes.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

/** Rendered inside the (app) layout's TaskManagerProvider — the queue lives up there so it
 *  survives navigating between the launcher and the clone board. */
export function CloneBoard({
  user,
  initialIds,
  partner = "in",
}: {
  user?: SessionUser;
  initialIds: string[];
  partner?: PartnerId;
}) {
  return <CloneInner user={user} initialIds={initialIds} partner={partner} />;
}

function CloneInner({
  user,
  initialIds,
  partner: initialPartner,
}: {
  user?: SessionUser;
  initialIds: string[];
  partner: PartnerId;
}) {
  // Fixed for the board's lifetime — a partner switch is a full navigation (see changePartner).
  const partnerId: PartnerId = initialPartner;
  // The board talks to the ACTIVE partner's own task manager: AIF clones queue/track in the
  // separate AIF instance (own drawer, own Strapi scope), MO in the team one — same rule as the
  // launcher board.
  const teamTm = useTaskManager();
  const aifTm = useAifTaskManager();
  const { enqueueClone, setOpen } = partnerConfig(partnerId).aifLaunch ? aifTm : teamTm;
  const [settings, setSettings] = useState<CloneSettings>(() => defaultSettings());
  const [rows, setRows] = useState<CloneRow[]>([]);
  const [loading, setLoading] = useState<boolean>(initialIds.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [targetingRowId, setTargetingRowId] = useState<string | null>(null);
  const [highOfferRowId, setHighOfferRowId] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(0);
  // Copies input: `null` = not being edited (show the committed settings.copies). While editing it
  // holds the raw string so the field can be transiently empty — clearing "1" to type "20" no longer
  // snaps back to 1 on every keystroke. Committed value stays clamped 1..100.
  const [copiesDraft, setCopiesDraft] = useState<string | null>(null);
  const setCopies = (n: number) => {
    patchSettings({ copies: Math.max(1, Math.min(100, n)) });
    setCopiesDraft(null);
  };
  const nextRowId = useRef(1);
  const queuedTimer = useRef<number | null>(null);
  // The "N queued" toast timer must not fire into an unmounted board (partner switches navigate away).
  useEffect(
    () => () => {
      if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    },
    [],
  );

  const partner = partnerConfig(partnerId);
  const aifMode = Boolean(partner.aifLaunch);
  // MO clone signer — the same soc roster + persisted pick as the launcher (one signer drives
  // every MO rail): the system token is RETIRED (owner ask 09-01 — Meta's ward kills its
  // adset-creates), so the CATALOGS (fanpages/accounts/pixels) and the clone build itself all
  // ride the picked soc's bearer. AIF keeps its own token — no signer concept there.
  const moSocs = useMoSocs(!aifMode);
  const [moChannel, setMoChannel] = useState<string>("");
  useEffect(() => {
    try {
      const v = localStorage.getItem(MO_CHANNEL_LS);
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v) setMoChannel(v);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, []);
  const changeMoChannel = useCallback((v: string) => {
    setMoChannel(v);
    try {
      localStorage.setItem(MO_CHANNEL_LS, v);
    } catch {
      /* storage disabled */
    }
  }, []);
  // Once the roster lands, an empty/stale pick auto-settles on the default signer.
  useEffect(() => {
    if (aifMode || !moSocs || moSocs.length === 0) return;
    if (moChannel && moSocs.some((s) => s.name === moChannel)) return;
    // Safe setState-in-effect: converges in one pass (the pick lands in the roster).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    changeMoChannel(defaultMoSoc(moSocs));
  }, [aifMode, moSocs, moChannel, changeMoChannel]);
  /** The EFFECTIVE signer ("" = none yet — Duplicate gates on it): picked AND provisioned. */
  const moSoc = !aifMode && moChannel && (moSocs ?? []).some((s) => s.name === moChannel) ? moChannel : "";
  /** SOC name marker rides соц-class picks only — system-class entries (Spencermo) go unmarked. */
  const moSocMarks = Boolean(moSoc) && !(moSocs ?? []).find((s) => s.name === moSoc)?.system;
  const signerMissing = !aifMode && !moSoc;
  // Token fanpages for the batch fanka picker (with live N/limit fill tags from the hs-tools
  // registry; AIF's scope fills in the day the box syncs AIF pages — same as the launcher board).
  // MO waits for the signer pick — there is no system catalog to fall back to any more.
  const fanpages = useFanpages(
    Boolean(partner.fanpagesFromToken) && (aifMode || Boolean(moSoc)),
    partner.pageAdLimit ?? 250,
    aifMode
      ? { list: "/api/aif/fanpages", volume: "/api/aif/fanpages/volume" }
      : { list: `/api/fanpages?channel=soc:${encodeURIComponent(moSoc)}`, volume: "/api/fanpages/volume" },
  );
  // A signer switch swaps the WHOLE catalog (each soc sees its own pages/accounts) but the
  // picked ids survive in state — a pick absent from the freshly LOADED list would fire a bind
  // the new signer can't use (per-clone server errors). Same derived-staleness idiom as
  // pixelStale below: a mid-load list (null) never flags a legit pick.
  const pageStale =
    Boolean(partner.fanpagesFromToken) &&
    Boolean(settings.pageId) &&
    fanpages !== null &&
    !fanpages.some((o) => o.value === settings.pageId);
  const fanpageMissing = Boolean(partner.fanpagesFromToken) && (!settings.pageId || pageStale);
  // Token ad accounts for the destination pick. The destination is an EXPLICIT choice:
  // "" = nothing chosen yet (Duplicate stays locked), SOURCE_ACCOUNT = consciously keep each
  // clone in its source campaign's own account, digits = a concrete target account (media gets
  // migrated there). No silent default — the buyer must say where the batch goes.
  const adAccounts = useAdAccounts(
    Boolean(partner.accountsFromToken) && (aifMode || Boolean(moSoc)),
    partner.preferredPixel,
    aifMode ? "/api/aif/adaccounts" : `/api/adaccounts?channel=soc:${encodeURIComponent(moSoc)}`,
  );
  const isTargetAccount = Boolean(settings.accountId) && settings.accountId !== SOURCE_ACCOUNT;
  // Same staleness rule for a concrete target account (SOURCE_ACCOUNT is a sentinel — never
  // stale): picked under one signer, absent from the other's loaded catalog → re-pick.
  const accountStale =
    Boolean(partner.accountsFromToken) &&
    isTargetAccount &&
    adAccounts !== null &&
    !adAccounts.some((a) => a.value === settings.accountId);
  const accountMissing = Boolean(partner.accountsFromToken) && (!settings.accountId || accountStale);
  const targetPixels = isTargetAccount ? pixelOptionsOf(adAccounts, settings.accountId) : [];
  // A concrete target account needs a pixel of that account: conversion sources can't carry
  // their own pixel across (it lives on the source's account) — the server enforces this too.
  // AIF derives its pixel server-side (conversions → the postback pixel, clicks → none), so the
  // board never asks for one there.
  // A reloaded account catalog can drop the picked pixel (pixel unshared / list refresh): a pick
  // outside the current LOADED options counts as missing — the bay blocks firing and the picker
  // asks again. Purely DERIVED (no state surgery, no effect), so a mid-load list (null) never
  // clears a legit pick and the server's pixel-on-account check stays the final authority.
  const pixelStale =
    !aifMode &&
    isTargetAccount &&
    Boolean(settings.pixelId) &&
    Boolean(adAccounts?.length) &&
    !targetPixels.some((p) => p.id === settings.pixelId);
  const pixelMissing = !aifMode && isTargetAccount && (!settings.pixelId || pixelStale);
  const destinationMissing = fanpageMissing || accountMissing || pixelMissing;
  // Account launch limit (5 campaigns / 30 min): a concrete TARGET account must fit the whole
  // batch (rows × copies). From-each-source batches aren't metered here — the sources' accounts
  // aren't exposed to the board, so the per-copy server claim refuses any overflow with the
  // countdown instead.
  const limits = useAcctLimits();
  const cloneDemand = rows.length * Math.max(1, Math.floor(settings.copies) || 1);
  // Fanka capacity: each clone ships ONE ad (campaign→adset→ad, clone-run) — the batch adds
  // rows×copies ads to the ONE picked fanpage. Free slots come from the picker's own volume feed;
  // unknown fill (numbers not landed / no registry data) = fail open, same as the badge grammar.
  const pickedFanka = settings.pageId ? fanpages?.find((o) => o.value === settings.pageId) : undefined;
  const fankaStats =
    pickedFanka && pickedFanka.adCount != null && pickedFanka.adLimit != null
      ? {
          used: pickedFanka.adCount,
          limit: pickedFanka.adLimit,
          free: Math.max(pickedFanka.adLimit - pickedFanka.adCount, 0),
        }
      : null;
  const fankaOver = fankaStats !== null && rows.length > 0 && cloneDemand > fankaStats.free;
  // Rows whose picked strategy needs a Bid that isn't there (cap $ / ROAS goal / ambiguous ROAS
  // band) — the fire button blocks on this instead of burning markers on per-clone 400s.
  const bidMissingCount = rows.filter(rowBidMissing).length;
  const targetRemaining = isTargetAccount
    ? Math.max(0, limits.limit - limits.countFor(settings.accountId))
    : null;
  const acctBlocked = targetRemaining !== null && cloneDemand > targetRemaining;
  const targetResetAt = isTargetAccount ? limits.resetAtFor(settings.accountId) : null;
  // Whoever is signed in — clone names default to end with " - <Username>".
  const me = user?.username ?? null;

  /** (Re)load real sources for a set of ids from Facebook. Used by the Retry button — an event
   *  handler, so the synchronous loading/error flips are fine here. */
  const loadIds = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) {
        setRows([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const ddmm = todayDDMM();
      loadCloneSources(ids, partnerId)
        .then((sources) => {
          setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
          setPreviewed(false);
        })
        .catch((e) => {
          setRows([]);
          setError(e instanceof Error ? e.message : "Failed to load campaigns");
        })
        .finally(() => setLoading(false));
    },
    [partnerId, me],
  );

  /** Load local mock sources for the "Load sample" button — no Facebook call. */
  const loadSample = () => {
    setLoading(true);
    setError(null);
    const ddmm = todayDDMM();
    loadSampleSources()
      .then((sources) => {
        setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setPreviewed(false);
      })
      .finally(() => setLoading(false));
  };

  // Initial load from the ids handed over in the link. Async-only (all setState lives in the
  // promise callbacks) so it never sets state synchronously inside the effect; `loading` is
  // already seeded true when ids are present.
  useEffect(() => {
    if (initialIds.length === 0) return;
    let alive = true;
    const ddmm = todayDDMM();
    loadCloneSources(initialIds, partnerId)
      .then((sources) => {
        if (!alive) return;
        setRows(sources.map((s) => makeCloneRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setPreviewed(false);
      })
      .catch((e) => {
        if (!alive) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Failed to load campaigns");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchRow = (id: string, patch: Partial<CloneRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setPreviewed(false);
  };
  const patchSettings = (patch: Partial<CloneSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setPreviewed(false);
  };
  const removeRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id));
    setPreviewed(false);
  };

  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    // Always a full navigation: LION partners swap the whole board (HS duplicator is a different
    // server tree), and MO ↔ AIF swap the Graph token + marker registry — rows loaded under one
    // partner's cabinets are meaningless (and unclonable) under the other's, so the board must
    // reload clean rather than carry them across.
    window.location.assign(url.toString());
  };

  const preview = flattenPreview(rows, settings.copies);

  /** Queue each clone (rows × copies) into the Task Manager, which builds them one at a time
   *  (ACTIVE since 08-11) with live stages / errors / retry — the same queue and pipeline as launches. */
  const duplicate = () => {
    if (destinationMissing || acctBlocked || fankaOver || bidMissingCount > 0 || signerMissing || limits.staleBuild) return; // the button is disabled too — belt and suspenders
    const total = Math.max(1, Math.floor(settings.copies) || 1);
    let queued = 0;
    for (const r of rows) {
      for (let k = 1; k <= total; k++) {
        // Soc-class signers stamp the SOC marker into the name (server re-ensures it — this
        // keeps the queue rows/previews honest); system-class signers (Spencermo) go unmarked.
        const full = moSocMarks ? moEnsureSocMark(fullCloneName(r)) : fullCloneName(r);
        const name = total > 1 ? `${full} (${k})` : full;
        const edit: CloneEdit = {
          campaignId: r.source.campaignId,
          name,
          budget: r.budget,
          // The row's PICKED strategy (may differ from the source's — the server rebuilds the
          // ad set around it); lowest-cost clones drop whatever bid value lingered in the field.
          bidStrategy: r.bidStrategy,
          roasGoal: bidKind(r.bidStrategy) === "none" ? "" : r.roasGoal,
          countries: r.countries,
          locales: r.locales,
          category: r.category,
          placement: r.placement,
          ageMin: r.ageMin,
          userOs: settings.userOs,
          pageId: settings.pageId,
          // Target account+pixel only for a concrete account; SOURCE_ACCOUNT (an explicit pick
          // too) omits them = each clone builds in its source's own account. AIF never sends a
          // pixel — the server derives it (postback pixel for conversions, none for clicks).
          ...(isTargetAccount
            ? // Belt: a stale pick (no longer among the account's pixels) must never ride the
              // POST even if some path skips the destinationMissing gate.
              { accountId: settings.accountId, ...(aifMode ? {} : { pixelId: pixelStale ? "" : settings.pixelId }) }
            : {}),
        };
        enqueueClone({
          partnerId,
          edit,
          // MO clones sign as the picked soc (the run route rejects signer-less MO batches).
          ...(moSoc ? { channel: `soc:${moSoc}` } : {}),
          name,
          geo: geoSummary(r.countries),
          budget: r.budget,
        });
        queued++;
      }
    }
    if (queued === 0) return;
    setOpen(true); // reveal the Task Manager so the clones are visible building right away
    setPreviewed(false); // re-arm — a fresh preview is required before queuing again
    setJustQueued(queued);
    if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    queuedTimer.current = window.setTimeout(() => setJustQueued(0), 4500);
  };

  const targetingRow = rows.find((r) => r.id === targetingRowId) ?? null;
  const highOfferRow = rows.find((r) => r.id === highOfferRowId) ?? null;

  return (
    <>
      <Header partner={partnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (left) ----
               Sticky AND internally scrollable: on short screens the column outgrows the viewport
               — without its own scroll the Duplicate button pins out of reach. */}
          <section className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <SectionHeading>Settings</SectionHeading>

            {/* MO signer — the soc token that reads the catalogs below AND signs every clone
                (the system token is retired). Shared pick with the launcher board. */}
            {!aifMode ? (
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Signer</span>
                <MoSocPicker socs={moSocs} value={moChannel} onChange={changeMoChannel} />
              </div>
            ) : null}

            {/* destination — fanpage always picked; account+pixel optionally re-target the batch */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Destination</span>
              <div className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface2/40 p-1.5">
                {partner.fanpagesFromToken ? (
                  <div className="flex flex-col gap-1 px-1.5 py-1">
                    <span
                      className={`text-[10px] font-medium uppercase tracking-[0.14em] ${fanpageMissing ? "text-warn" : "text-faint"}`}
                    >
                      Fanpage{pageStale ? " — re-pick (not on this signer)" : fanpageMissing ? " — required" : ""}
                    </span>
                    <SearchSelect
                      value={settings.pageId}
                      onChange={(v) => patchSettings({ pageId: v })}
                      options={fanpages ?? []}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                      metaWhenClosed
                      warn={fanpageMissing}
                    />
                    {/* Live fill of the picked fanka vs what THIS batch adds (1 ad per clone) —
                        red when it won't fit; Duplicate locks on the same flag. */}
                    {fankaStats ? (
                      <p
                        className={
                          "px-0.5 font-mono text-[10.5px] tabular-nums " +
                          (fankaOver
                            ? "font-semibold text-danger"
                            : fankaStats.limit > 0 && fankaStats.used / fankaStats.limit >= 0.8
                              ? "text-warn"
                              : "text-faint")
                        }
                      >
                        {fankaStats.used}/{fankaStats.limit} ads · {fankaStats.free} free
                        {rows.length > 0 ? ` · batch adds ${cloneDemand}` : ""}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {partner.accountsFromToken ? (
                  <>
                    <div className="flex flex-col gap-1 px-1.5 py-1">
                      <span
                        className={`text-[10px] font-medium uppercase tracking-[0.14em] ${accountMissing ? "text-warn" : "text-faint"}`}
                      >
                        Account{accountStale ? " — re-pick (not on this signer)" : accountMissing ? " — required" : ""}
                      </span>
                      <SearchSelect
                        value={settings.accountId}
                        onChange={(v) =>
                          patchSettings({
                            accountId: v,
                            // Auto-pick the target's pixel (FARM-1 when it carries it) the same way
                            // a fresh launch card does; no pixel in source mode / when cleared.
                            // AIF never picks one — the server derives it per source.
                            pixelId:
                              !aifMode && v && v !== SOURCE_ACCOUNT
                                ? defaultPixelFor(adAccounts, v, partner.preferredPixel)
                                : "",
                          })
                        }
                        options={[
                          { value: SOURCE_ACCOUNT, label: "From each source" },
                          ...decorateAccountOptions(adAccounts ?? [], limits),
                        ]}
                        placeholder="Select account"
                        emptyHint={adAccounts ? "No accounts on the token" : "Loading accounts…"}
                        warn={accountMissing}
                      />
                    </div>
                    {isTargetAccount && aifMode ? (
                      // AIF pixel is server-derived: conversion sources pin the postback pixel,
                      // click sources go pixel-less — nothing to pick.
                      <LockedRow label="Pixel" value="Auto · AIF Rewarded (conversions)" />
                    ) : isTargetAccount ? (
                      <div className="flex flex-col gap-1 px-1.5 py-1">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-[0.14em] ${pixelMissing ? "text-warn" : "text-faint"}`}
                        >
                          Pixel{pixelMissing ? " — required" : ""}
                        </span>
                        <SearchSelect
                          value={settings.pixelId}
                          onChange={(v) => patchSettings({ pixelId: v })}
                          options={targetPixels.map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                          placeholder="Search pixel"
                          emptyHint={adAccounts ? "No pixels on this account" : "Loading pixels…"}
                          metaWhenClosed
                          warn={pixelMissing}
                        />
                      </div>
                    ) : settings.accountId === SOURCE_ACCOUNT ? (
                      <LockedRow label="Pixel" value="From each source" />
                    ) : null}
                  </>
                ) : (
                  <>
                    <LockedRow label="Account" value="From each source" />
                    <LockedRow label="Pixel" value="From each source" />
                  </>
                )}
              </div>
              <p className="px-0.5 text-[10.5px] leading-relaxed text-faint">
                {accountMissing
                  ? "Pick the destination explicitly: the fanpage and the account. “From each source” keeps every clone in its source campaign’s own account; a concrete account re-builds the whole batch there."
                  : isTargetAccount
                    ? "Every clone in the batch is re-built in the picked account: the source video/image is re-uploaded there (adds a “Migrating media” step) and conversion clones optimize for the picked pixel."
                    : "Each clone is created in its source campaign’s own ad account (its video/image lives there), with the source’s pixel. Only the fanpage applies to every clone in the batch."}
              </p>
            </div>

            <Field label="User OS">
              <Select
                value={settings.userOs}
                onChange={(e) => patchSettings({ userOs: e.target.value as CloneSettings["userOs"] })}
                options={OS_OPTIONS}
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Copies per campaign</span>
              <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-line bg-surface2">
                <button
                  type="button"
                  aria-label="Fewer copies"
                  onClick={() => setCopies(settings.copies - 1)}
                  disabled={settings.copies <= 1}
                  className="flex w-9 shrink-0 items-center justify-center text-[17px] leading-none text-dim transition-colors hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  −
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Copies per campaign"
                  value={copiesDraft ?? String(settings.copies)}
                  onFocus={() => setCopiesDraft(String(settings.copies))}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
                    setCopiesDraft(raw);
                    if (raw !== "") patchSettings({ copies: Math.max(1, Math.min(100, Number(raw))) });
                  }}
                  onBlur={() => setCopiesDraft(null)}
                  className="w-full min-w-0 border-x border-line bg-transparent text-center font-mono text-[13px] tabular-nums text-ink outline-none focus:bg-surface2/60"
                />
                <button
                  type="button"
                  aria-label="More copies"
                  onClick={() => setCopies(settings.copies + 1)}
                  disabled={settings.copies >= 100}
                  className="flex w-9 shrink-0 items-center justify-center text-[17px] leading-none text-dim transition-colors hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  +
                </button>
              </div>
              <p className="text-[11px] leading-snug text-faint">Each campaign is duplicated this many times.</p>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPreviewed(true)}
                disabled={rows.length === 0}
                className={
                  "flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/15 " +
                  "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 " +
                  "hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <TargetIcon className="h-4 w-4" />
                Generate Preview
              </button>

              {previewed && rows.length > 0 ? (
                <button
                  type="button"
                  onClick={duplicate}
                  disabled={destinationMissing || acctBlocked || fankaOver || bidMissingCount > 0 || signerMissing || limits.staleBuild}
                  className={
                    "animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-launch/50 " +
                    "bg-launch/15 text-[14px] font-semibold text-launch2 transition-all duration-150 hover:border-launch/70 " +
                    "hover:bg-launch/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch/40"
                  }
                >
                  <CopyIcon className="h-4 w-4" />
                  {`Duplicate ${preview.length} ${preview.length === 1 ? "clone" : "clones"} · goes LIVE`}
                </button>
              ) : null}

              {previewed && rows.length > 0 && destinationMissing ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Duplicate is locked — set in Destination:{" "}
                  <span className="font-semibold">
                    {[
                      fanpageMissing ? "Fanpage" : null,
                      accountMissing ? "Account" : null,
                      pixelMissing ? "Pixel" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              ) : null}

              {previewed && rows.length > 0 && !destinationMissing && acctBlocked ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Account limit — only <span className="font-semibold">{targetRemaining}</span> of{" "}
                  <span className="font-semibold">{cloneDemand}</span> clones fit this account&apos;s
                  30-min window
                  {targetResetAt ? (
                    <>
                      {" "}
                      · resets in{" "}
                      <span className="font-mono font-semibold">
                        {fmtCountdown(targetResetAt, limits.skew)}
                      </span>
                    </>
                  ) : null}
                  . Trim copies or pick another account.
                </div>
              ) : null}

              {previewed && rows.length > 0 && signerMissing ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Duplicate is locked — pick a <span className="font-semibold">Signer</span> (the
                  system token is retired; MO clones sign as a soc).
                </div>
              ) : null}

              {previewed && rows.length > 0 && bidMissingCount > 0 ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  <span className="font-semibold">{bidMissingCount}</span> row
                  {bidMissingCount === 1 ? " needs" : "s need"} a Bid for{" "}
                  {bidMissingCount === 1 ? "its" : "their"} picked strategy (amber field) — type the
                  cap $ / ROAS goal or switch back.
                </div>
              ) : null}

              {previewed && rows.length > 0 && !destinationMissing && fankaOver && fankaStats ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Fanpage full — the batch adds <span className="font-semibold">{cloneDemand}</span>{" "}
                  ads but this fanpage has only{" "}
                  <span className="font-semibold">{fankaStats.free}</span> free (
                  <span className="font-mono">
                    {fankaStats.used}/{fankaStats.limit}
                  </span>
                  ). Trim copies or pick another fanpage.
                </div>
              ) : null}

              {previewed ? (
                <p className="text-center text-[11px] text-faint">
                  {rows.length} {rows.length === 1 ? "campaign" : "campaigns"} × {settings.copies} ={" "}
                  <span className="font-mono text-dim">{preview.length}</span> clones · created live
                </p>
              ) : null}

              {justQueued > 0 ? (
                <p className="animate-pop-in rounded-lg border border-launch/30 bg-launch/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-launch2">
                  {justQueued} {justQueued === 1 ? "clone" : "clones"} queued — building in the Task Manager.
                </p>
              ) : null}
            </div>
          </section>

          {/* ---- Selected campaigns (right) ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <SectionHeading
              right={
                <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                  {rows.length}
                </span>
              }
            >
              Selected Campaigns
            </SectionHeading>

            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">
                Loading campaigns from Facebook…
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-12 text-center">
                <AlertIcon className="h-7 w-7 text-danger" />
                <div>
                  <p className="text-[14px] font-medium text-ink">Couldn&apos;t load campaigns</p>
                  <p className="mx-auto mt-1 max-w-[440px] break-words font-mono text-[11.5px] leading-relaxed text-dim">
                    {error}
                  </p>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadIds(initialIds)}
                    disabled={initialIds.length === 0}
                    className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 py-2 text-[12.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <RetryIcon className="h-3.5 w-3.5" />
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={loadSample}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Load sample
                  </button>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line2 px-6 py-14 text-center">
                <TargetIcon className="h-7 w-7 text-faint" />
                <div>
                  <p className="text-[14px] font-medium text-ink">No campaigns received</p>
                  <p className="mt-1 text-[12px] text-dim">
                    Open this page from the <span className="text-ink">Clone</span> button in the stats tool —
                    the campaigns to duplicate arrive by id in the link.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadSample}
                  className="mt-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-dim transition-colors hover:border-accent/40 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Load sample campaigns
                </button>
              </div>
            ) : (
              // table-fixed + one flexible Name column — no 900px floor, so the board fits a
              // 1024px viewport scroll-free. The read-only source facts (orig $/bid/videos) fold
              // into ONE stacked column and hide below xl; the redirect config chip lives in the
              // name cell. The min-w only guards true mobile (wrapper scrolls there).
              <div className="overflow-x-auto rounded-2xl border border-line">
                <table className="w-full min-w-[620px] table-fixed border-collapse text-left">
                  <thead>
                    <tr className="border-b border-line bg-surface2/40 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
                      <th className="w-[34px] px-1.5 py-2.5 text-center">#</th>
                      <th className="px-3 py-2.5">Campaign name</th>
                      <th className="w-[122px] px-2 py-2.5">Geo</th>
                      <th className="hidden w-[110px] px-2 py-2.5 xl:table-cell">Source $ · bid</th>
                      <th className="w-[150px] border-l border-line px-2 py-2.5">Strategy · Bid</th>
                      <th className="w-[88px] px-2 py-2.5">Budget</th>
                      <th className="w-[40px] px-1 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={r.id}
                        className="border-b border-line align-middle transition-colors last:border-b-0 hover:bg-raise/25"
                      >
                        <td className="px-1.5 py-3.5 text-center">
                          <span className="flex h-8 items-center justify-center font-mono text-[12px] text-faint">
                            {i + 1}
                          </span>
                        </td>

                        {/* name — fixed prefix (locked) + editable remainder */}
                        <td className="px-3 py-3.5">
                          <span
                            className="mb-1 flex items-center gap-1 truncate font-mono text-[10.5px] text-faint"
                            title={`${r.namePrefix.trim()} — fixed, not editable`}
                          >
                            <LockIcon className="h-2.5 w-2.5 shrink-0" />
                            {r.namePrefix.trim()}
                          </span>
                          <AutoTextarea
                            value={r.name}
                            onChange={(v) => patchRow(r.id, { name: v })}
                            maxLength={400}
                            ariaLabel="Campaign name (editable part)"
                            className="block w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:bg-surface2/80 focus:ring-2 focus:ring-accent/15"
                          />
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint">
                              #{r.source.campaignId}
                            </span>
                            {/* Redirect config rides with the name (was its own 112px column):
                                HIGH ADX opens the High Offer modal, the rest is a passive tag. */}
                            {r.redirectType === "HIGH ADX" ? (
                              <button
                                type="button"
                                onClick={() => setHighOfferRowId(r.id)}
                                className={
                                  "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
                                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40 " +
                                  (r.highOffer.enabled
                                    ? "border-warn/50 bg-warn/15 text-warn"
                                    : "border-warn/40 bg-warn/5 text-warn hover:bg-warn/10")
                                }
                              >
                                <SlidersIcon className="h-3 w-3" />
                                High Offer
                              </button>
                            ) : (
                              <span className="inline-flex rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint">
                                {r.redirectType}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* geo + targeting */}
                        <td className="px-2 py-3.5">
                          <div className="flex flex-col gap-2">
                            <GeoChips codes={r.countries} />
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

                        {/* Source facts, one stacked read-only cell (was three columns): budget +
                            creative count on top, the bid — marked by HOW it bids (blue ROAS tag /
                            amber CAP tag / "auto") — under. Hidden below xl; the Preview repeats
                            the numbers that matter for the fire. */}
                        <td className="hidden px-2 py-3 xl:table-cell">
                          <div className="flex flex-col gap-1 font-mono text-[11px] tabular-nums text-faint">
                            <span className="flex items-center gap-1">
                              <span>${moneyLabel(r.source.originalBudget)}</span>
                              <span className="text-dim">·</span>
                              <FilmIcon className="h-3 w-3" />
                              <span>{r.source.creatives.length}</span>
                            </span>
                            <span className="flex flex-wrap items-center gap-1">
                              <BidKindTag strategy={r.source.bidStrategy} />
                              {bidKind(r.source.bidStrategy) === "none"
                                ? r.source.bidStrategy === "LOWEST_COST_WITHOUT_CAP"
                                  ? "auto"
                                  : r.source.originalRoas || "—"
                                : r.source.originalRoas
                                  ? `${bidKind(r.source.bidStrategy) === "cap" ? "$" : ""}${r.source.originalRoas}`
                                  : "—"}
                            </span>
                          </div>
                        </td>

                        {/* clone settings (editable) — money-sanitized like the launcher's fields
                            (ROAS = cash-register mode, budget = limitMoney) so garbage can't reach
                            CloneEdit.roasGoal/budget → money()=0 → an ad set Meta rejects
                            (orphan + burnt gcm). */}
                        <td className="border-l border-line px-2 py-3.5">
                          {/* The CLONE's strategy — switchable per row (ROAS ↔ cap ↔ lowest,
                              owner ask 09-01; the token rail rebuilds the ad set, so any
                              supported strategy is reachable). The bid field follows the PICKED
                              strategy; a kind change clears the value (a $ cap is not a ROAS
                              goal) and switching back to the source's kind restores its bid. */}
                          <div className="flex flex-col gap-1.5">
                            <div className="relative">
                              <select
                                value={r.bidStrategy}
                                onChange={(e) => {
                                  const bidStrategy = e.target.value;
                                  const kind = bidKind(bidStrategy);
                                  const roasGoal =
                                    kind === bidKind(r.bidStrategy)
                                      ? r.roasGoal
                                      : kind === bidKind(r.source.bidStrategy)
                                        ? r.source.originalRoas
                                        : "";
                                  patchRow(r.id, { bidStrategy, roasGoal });
                                }}
                                aria-label="Clone bid strategy"
                                title={
                                  r.bidStrategy !== r.source.bidStrategy
                                    ? "Strategy switched — the clone launches with THIS strategy, not the source's"
                                    : "The clone's bid strategy (the source's — switch it to re-bid the clone)"
                                }
                                className={
                                  cellSelect +
                                  (r.bidStrategy !== r.source.bidStrategy
                                    ? " border-accent/50 text-[#9db8ff]"
                                    : "")
                                }
                              >
                                {/* AIF: min-ROAS is locked at Meta's VO-eligibility gate
                                    (AIF_ROAS_LOCKED) — disabled, not hidden, so a roas SOURCE
                                    still shows its true strategy; the server 400s the row until
                                    it's switched to cap/lowest. */}
                                {BID_STRATEGIES.map((o) => (
                                  <option
                                    key={o.value}
                                    value={o.value}
                                    disabled={aifMode && AIF_ROAS_LOCKED && bidKind(o.value) === "roas"}
                                    className="bg-surface text-ink"
                                  >
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              <ChevronDownIcon className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-faint" />
                            </div>
                            <div className="relative">
                              {bidKind(r.bidStrategy) !== "none" ? (
                                <span
                                  className={
                                    "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[11px] " +
                                    (bidKind(r.bidStrategy) === "roas"
                                      ? "font-semibold text-[#9db8ff]"
                                      : "text-faint")
                                  }
                                >
                                  {bidKind(r.bidStrategy) === "roas" ? "R" : "$"}
                                </span>
                              ) : null}
                              <input
                                value={bidKind(r.bidStrategy) === "none" ? "" : r.roasGoal}
                                onChange={(e) =>
                                  patchRow(r.id, {
                                    roasGoal: limitMoneyCents(
                                      e.target.value,
                                      bidKind(r.bidStrategy) === "roas" ? 100 : 1000,
                                    ),
                                  })
                                }
                                inputMode="decimal"
                                disabled={bidKind(r.bidStrategy) === "none"}
                                placeholder={
                                  bidKind(r.bidStrategy) === "roas"
                                    ? "1,20"
                                    : bidKind(r.bidStrategy) === "cap"
                                      ? "0,50"
                                      : "auto"
                                }
                                title={
                                  bidKind(r.bidStrategy) === "roas"
                                    ? "ROAS decimal — 34 → 0,34 (34%)"
                                    : bidKind(r.bidStrategy) === "cap"
                                      ? "Bid cap in $ — digits fill cents, 34 → $0,34"
                                      : "Lowest cost bids automatically"
                                }
                                aria-label="Bid / ROAS goal"
                                className={
                                  cellInput +
                                  (bidKind(r.bidStrategy) !== "none" ? " pl-5" : " opacity-50") +
                                  (rowBidMissing(r)
                                    ? " border-warn/60 focus:border-warn focus:ring-warn/15"
                                    : "")
                                }
                              />
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-3.5">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">
                              $
                            </span>
                            <input
                              value={r.budget}
                              onChange={(e) => patchRow(r.id, { budget: limitMoney(e.target.value, 10000) })}
                              inputMode="decimal"
                              aria-label="Daily budget"
                              className={`${cellInput} pl-5`}
                            />
                          </div>
                        </td>

                        {/* remove */}
                        <td className="px-1 py-3.5">
                          <div className="flex h-8 items-center justify-center">
                            <button
                              type="button"
                              onClick={() => removeRow(r.id)}
                              aria-label="Remove campaign"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                            >
                              <TrashIcon className="h-[18px] w-[18px]" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* preview */}
            {previewed && rows.length > 0 ? (
              <div className="animate-pop-in mt-2 flex flex-col gap-2">
                <SectionHeading
                  right={
                    <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                      {preview.length}
                    </span>
                  }
                >
                  Preview · clones to create
                </SectionHeading>
                <div className="flex flex-col gap-1.5">
                  {preview.map((p) => (
                    <div
                      key={p.key}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface2/40 px-3 py-2"
                    >
                      <span className="min-w-0 flex-[1_1_220px] truncate text-[12px] text-ink" title={p.name}>
                        {p.name}
                      </span>
                      <GeoChips codes={p.countries} />
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {bidKind(p.bidStrategy) === "roas"
                          ? `ROAS ${p.roasGoal || "inherited"}`
                          : bidKind(p.bidStrategy) === "cap"
                            ? `bid ${p.roasGoal ? `$${p.roasGoal}` : "inherited"}`
                            : "bid auto"}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-dim">${moneyLabel(p.budget)}/day</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

          </section>
        </div>
      </main>

      {targetingRow ? (
        <CloneTargetingModal
          row={targetingRow}
          onClose={() => setTargetingRowId(null)}
          onApply={(patch) => patchRow(targetingRow.id, patch)}
        />
      ) : null}
      {highOfferRow ? (
        <CloneHighOfferModal
          row={highOfferRow}
          onClose={() => setHighOfferRowId(null)}
          onApply={(highOffer: HighOfferConfig) => patchRow(highOfferRow.id, { highOffer })}
        />
      ) : null}
    </>
  );
}
