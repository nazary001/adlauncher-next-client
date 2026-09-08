"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloneEdit,
  type CloneRow,
  type CloneRowDest,
  type CloneSettings,
  type HighOfferConfig,
  MAX_CLONE_COPIES,
  SOURCE_ACCOUNT,
  defaultSettings,
  flattenPreview,
  fullCloneName,
  loadCloneSources,
  loadSampleSources,
  makeCloneRow,
  normalizeRowDest,
  rowCopiesOf,
  rowDestination,
} from "@/lib/clone";
import {
  bidKind,
  limitMoneyCents,
  moEnsureSocMark,
  moneyCentsLabel,
  moneyLabel,
  normalizeRoasGoal,
  parseMoney,
} from "@/lib/types";
import { BID_STRATEGIES, OS_OPTIONS, countryName, geoSummary } from "@/lib/catalog";
import { AIF_VALUE_PIXEL, type PartnerId, aifOfferablePixels, partnerConfig, pickAifPixel } from "@/lib/partners";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "@/lib/pick-defaults";
import { AutoTextarea, BidKindTag, Field, Select } from "./ui";
import {
  AlertIcon,
  ChevronDownIcon,
  CopyIcon,
  FilmIcon,
  GlobeIcon,
  LockIcon,
  MinusIcon,
  MoreIcon,
  PlusIcon,
  RetryIcon,
  SlidersIcon,
  TargetIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import { Header } from "./header";
import { useAifTaskManager, useTaskManager } from "./task-manager";
import { CloneTargetingModal } from "./clone-targeting-modal";
import { CloneHighOfferModal } from "./clone-high-offer-modal";
import { CloneDestinationModal } from "./clone-destination-modal";
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

/** A source row seeded for the board: makeCloneRow + the budget in the cash-register spelling
 *  the Budget cell runs in (owner ask 09-08 — "10" would re-read as 0,10 on the first keystroke). */
function seedRow(...args: Parameters<typeof makeCloneRow>): CloneRow {
  const row = makeCloneRow(...args);
  return { ...row, budget: moneyCentsLabel(row.budget) };
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
  // Ids the last read could NOT deliver (not found / no access on this signer) while others
  // loaded — shown above the table instead of vanishing silently.
  const [loadWarn, setLoadWarn] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [targetingRowId, setTargetingRowId] = useState<string | null>(null);
  const [highOfferRowId, setHighOfferRowId] = useState<string | null>(null);
  const [destRowId, setDestRowId] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(0);
  // Copies input: `null` = not being edited (show the committed settings.copies). While editing it
  // holds the raw string so the field can be transiently empty — clearing "1" to type "20" no longer
  // snaps back to 1 on every keystroke. Committed value stays clamped 1..100.
  const [copiesDraft, setCopiesDraft] = useState<string | null>(null);
  const setCopies = (n: number) => {
    patchSettings({ copies: Math.max(1, Math.min(MAX_CLONE_COPIES, n)) });
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
  // Token ad accounts for the destination pick. The destination is an EXPLICIT choice:
  // "" = nothing chosen yet (Duplicate stays locked), SOURCE_ACCOUNT = consciously keep each
  // clone in its source campaign's own account, digits = a concrete target account (media gets
  // migrated there). No silent default — the buyer must say where the batch goes.
  const adAccounts = useAdAccounts(
    Boolean(partner.accountsFromToken) && (aifMode || Boolean(moSoc)),
    partner.preferredPixel,
    aifMode ? "/api/aif/adaccounts" : `/api/adaccounts?channel=soc:${encodeURIComponent(moSoc)}`,
  );

  // ---- destination verdicts, per TUPLE (owner ask 09-08: a row may carry its own) -----------
  // The batch Settings tuple is judged with the same helpers as any row's own tuple. Staleness
  // (a pick absent from the freshly LOADED catalog after a signer switch / list refresh) counts
  // as missing — the pick would fire a bind the new signer can't use. A mid-load list (null)
  // never flags a legit pick; the server's own catalog checks stay the final authority.
  const isTargetFor = (d: CloneRowDest): boolean => Boolean(d.accountId) && d.accountId !== SOURCE_ACCOUNT;
  const pageStaleFor = (d: CloneRowDest): boolean =>
    Boolean(partner.fanpagesFromToken) &&
    Boolean(d.pageId) &&
    fanpages !== null &&
    !fanpages.some((o) => o.value === d.pageId);
  const fanpageMissingFor = (d: CloneRowDest): boolean =>
    Boolean(partner.fanpagesFromToken) && (!d.pageId || pageStaleFor(d));
  const accountStaleFor = (d: CloneRowDest): boolean =>
    Boolean(partner.accountsFromToken) &&
    isTargetFor(d) &&
    adAccounts !== null &&
    !adAccounts.some((a) => a.value === d.accountId);
  const accountMissingFor = (d: CloneRowDest): boolean =>
    Boolean(partner.accountsFromToken) && (!d.accountId || accountStaleFor(d));
  // AIF offers the cabinet's pixels minus the retired ones (owner call 09-02 pt3 — «GC for
  // AIF» / «GC for MO» never offered); MO keeps the account's full list.
  const targetPixelsFor = (accountId: string) => {
    const all = pixelOptionsOf(adAccounts, accountId);
    return aifMode ? aifOfferablePixels(all) : all;
  };
  const pixelStaleFor = (d: CloneRowDest): boolean =>
    isTargetFor(d) &&
    Boolean(d.pixelId) &&
    Boolean(adAccounts?.length) &&
    !targetPixelsFor(d.accountId).some((p) => p.id === d.pixelId);
  const pixelMissingFor = (d: CloneRowDest): boolean => isTargetFor(d) && (!d.pixelId || pixelStaleFor(d));
  const destMissingFor = (d: CloneRowDest): boolean =>
    fanpageMissingFor(d) || accountMissingFor(d) || pixelMissingFor(d);

  // Account launch limit (5 campaigns / 30 min) — the pickers' N/5 badges, the default account
  // pick and the batch gate below.
  const limits = useAcctLimits();

  // ---- default binds (owner rule 09-08): the LEAST-FILLED fanka and the LEAST-LOADED account
  // on our 5/30-min timer are what an EMPTY Settings pick shows and fires; a real pick (incl.
  // "From each source") wins via state and the × clear returns to auto. The partner's preferred
  // account (BR-1500) is ranked first so it wins ties. Purely derived — live as the meters move.
  const autoPageId = partner.fanpagesFromToken
    ? leastFilledPage(
        (fanpages ?? []).map((o) => ({ id: o.value, used: o.adCount, limit: o.adLimit, disabled: o.disabled })),
        partner.pageAdLimit ?? 250,
      )
    : "";
  const preferredAcct = partner.defaultAccount?.id ?? "";
  const acctCandidates = (adAccounts ?? [])
    .slice()
    .sort((a, b) => (a.value === preferredAcct ? -1 : b.value === preferredAcct ? 1 : 0));
  const autoAccountId = partner.accountsFromToken
    ? leastLoadedAccount(
        accountLoads(
          acctCandidates.map((a) => ({ id: a.value, disabled: a.disabled })),
          limits,
        ),
        limits.limit,
      )
    : "";
  const settingsPageIsAuto = Boolean(partner.fanpagesFromToken) && !settings.pageId && Boolean(autoPageId);
  const settingsAccountIsAuto = Boolean(partner.accountsFromToken) && !settings.accountId && Boolean(autoAccountId);
  const effPageId = settings.pageId || autoPageId;
  const effAccountId = settings.accountId || autoAccountId;
  // An auto account brings its own default pixel (the same rule the manual pick applies).
  const effPixelId =
    settings.pixelId ||
    (settingsAccountIsAuto && effAccountId !== SOURCE_ACCOUNT
      ? aifMode
        ? (pickAifPixel(pixelOptionsOf(adAccounts, effAccountId))?.id ?? "")
        : defaultPixelFor(adAccounts, effAccountId, partner.preferredPixel)
      : "");
  // The batch Settings tuple (the wave defaults, auto picks resolved) — decorates the pickers
  // and is what every row without its own destination rides.
  const defaults: CloneRowDest = { pageId: effPageId, accountId: effAccountId, pixelId: effPixelId };
  const pageStale = pageStaleFor(defaults);
  const fanpageMissing = fanpageMissingFor(defaults);
  const isTargetAccount = isTargetFor(defaults);
  const accountStale = accountStaleFor(defaults);
  const accountMissing = accountMissingFor(defaults);
  const targetPixels = isTargetAccount ? targetPixelsFor(effAccountId) : [];
  const pixelMissing = pixelMissingFor(defaults);
  // The defaults only matter while some row rides them (or no rows yet — guide the pick).
  const defaultsUsed = rows.length === 0 || rows.some((r) => !r.dest);

  // Per-row effective destination + copies (its own, else the batch settings).
  const destOf = (r: CloneRow): CloneRowDest => rowDestination(r, defaults);
  const copiesOf = (r: CloneRow): number => rowCopiesOf(r, settings);
  const rowsMissing = rows.filter((r) => destMissingFor(destOf(r)));
  const destinationMissing = rows.length > 0 && rowsMissing.length > 0;

  // Account launch limit (5 campaigns / 30 min): EVERY concrete TARGET account must fit its
  // share (rows × copies bound to it). From-each-source rows aren't metered here — the sources'
  // accounts aren't exposed to the board, so the per-copy server claim refuses any overflow with
  // the countdown instead.
  const acctDemand = new Map<string, number>();
  for (const r of rows) {
    const d = destOf(r);
    if (isTargetFor(d)) acctDemand.set(d.accountId, (acctDemand.get(d.accountId) ?? 0) + copiesOf(r));
  }
  const acctShort = [...acctDemand.entries()]
    .map(([accountId, need]) => ({
      accountId,
      need,
      remaining: Math.max(0, limits.limit - limits.countFor(accountId)),
      resetAt: limits.resetAtFor(accountId),
    }))
    .filter((x) => x.need > x.remaining);
  const acctBlocked = acctShort.length > 0;
  // Fanka capacity: each clone ships ONE ad (campaign→adset→ad, clone-run) — every fanpage the
  // batch binds must fit the rows × copies landing on it. Free slots come from the picker's own
  // volume feed; unknown fill (numbers not landed / no registry data) = fail open, same as the
  // badge grammar.
  const pageDemand = new Map<string, number>();
  for (const r of rows) {
    const d = destOf(r);
    if (d.pageId) pageDemand.set(d.pageId, (pageDemand.get(d.pageId) ?? 0) + copiesOf(r));
  }
  const fankaStatsOf = (pageId: string) => {
    const o = pageId ? fanpages?.find((x) => x.value === pageId) : undefined;
    return o && o.adCount != null && o.adLimit != null
      ? { name: o.label, used: o.adCount, limit: o.adLimit, free: Math.max(o.adLimit - o.adCount, 0) }
      : null;
  };
  const fankaShort = [...pageDemand.entries()]
    .map(([pageId, need]) => ({ pageId, need, st: fankaStatsOf(pageId) }))
    .filter((x): x is { pageId: string; need: number; st: NonNullable<ReturnType<typeof fankaStatsOf>> } =>
      x.st !== null && x.need > x.st.free,
    );
  const fankaOver = fankaShort.length > 0;
  /** The batch Settings fanpage's own meter + what the rows bound to it add (Settings line). */
  const fankaStats = fankaStatsOf(effPageId);
  const defaultFankaDemand = effPageId ? (pageDemand.get(effPageId) ?? 0) : 0;
  const defaultFankaOver = fankaShort.some((x) => x.pageId === effPageId);
  // Rows whose picked strategy needs a Bid that isn't there (cap $ / ROAS goal / ambiguous ROAS
  // band) — the fire button blocks on this instead of burning markers on per-clone 400s.
  const bidMissingCount = rows.filter(rowBidMissing).length;
  // Whoever is signed in — clone names default to end with " - <Username>".
  const me = user?.username ?? null;

  // Catalog display names for a destination tuple.
  const fanpageLabel = (pageId: string): string => fanpages?.find((o) => o.value === pageId)?.label || pageId;
  const accountLabel = (accountId: string): string =>
    accountId === SOURCE_ACCOUNT ? "From each source" : adAccounts?.find((a) => a.value === accountId)?.label || accountId;
  const pixelLabel = (accountId: string, pixelId: string): string =>
    pixelOptionsOf(adAccounts, accountId).find((p) => p.id === pixelId)?.name || pixelId;

  // The MO source read rides the picked SIGNER's token (the retired system token can't see the
  // campaigns — owner report 09-08: the board sat on "No campaigns received"); AIF reads on
  // its own token, no channel.
  const sourceChannel = aifMode ? undefined : moSoc ? `soc:${moSoc}` : undefined;
  const partialWarn = (failed: { id: string; error: string }[]): string | null =>
    failed.length
      ? `${failed.length} campaign${failed.length === 1 ? "" : "s"} didn't load with this signer: ` +
        failed.map((f) => `#${f.id} — ${f.error}`).join(" · ")
      : null;

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
      loadCloneSources(ids, partnerId, sourceChannel)
        .then(({ sources, failed }) => {
          setRows(sources.map((s) => seedRow(s, ddmm, `r${nextRowId.current++}`, me)));
          setLoadWarn(partialWarn(failed));
          setPreviewed(false);
        })
        .catch((e) => {
          setRows([]);
          setError(e instanceof Error ? e.message : "Failed to load campaigns");
        })
        .finally(() => setLoading(false));
    },
    [partnerId, me, sourceChannel],
  );

  /** Load local mock sources for the "Load sample" button — no Facebook call. */
  const loadSample = () => {
    setLoading(true);
    setError(null);
    const ddmm = todayDDMM();
    loadSampleSources()
      .then((sources) => {
        setRows(sources.map((s) => seedRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setLoadWarn(null);
        setPreviewed(false);
      })
      .finally(() => setLoading(false));
  };

  // Initial load from the ids handed over in the link — ONCE, as soon as the reading token is
  // known: AIF right away, MO only after the signer roster lands and the pick settles (the read
  // rides that soc's token). Async-only (all setState lives in the promise callbacks) so it never
  // sets state synchronously inside the effect; `loading` is already seeded true when ids are
  // present. A roster with NO provisioned soc can never read → say so instead of spinning.
  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (initialIds.length === 0 || initialLoadRef.current) return;
    if (!aifMode && !moSoc) {
      if (moSocs && moSocs.length === 0) {
        initialLoadRef.current = true;
        Promise.resolve().then(() => {
          setLoading(false);
          setError("No MO signer is provisioned on the server (FB_MO_SOC_TOKENS) — the system token is retired, sources can't be read");
        });
      }
      return;
    }
    initialLoadRef.current = true;
    let alive = true;
    const ddmm = todayDDMM();
    loadCloneSources(initialIds, partnerId, sourceChannel)
      .then(({ sources, failed }) => {
        if (!alive) return;
        setRows(sources.map((s) => seedRow(s, ddmm, `r${nextRowId.current++}`, me)));
        setLoadWarn(partialWarn(failed));
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
  }, [aifMode, moSoc, moSocs]);

  const patchRow = (id: string, patch: Partial<CloneRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setPreviewed(false);
  };
  /** The pixel a fresh account pick brings along (the Settings rule): the target's preferred
   *  pixel — AIF: the value pixel — when the cabinet carries it; none in source mode. */
  const autoPixelFor = (accountId: string): string =>
    accountId && accountId !== SOURCE_ACCOUNT
      ? aifMode
        ? (pickAifPixel(pixelOptionsOf(adAccounts, accountId))?.id ?? "")
        : defaultPixelFor(adAccounts, accountId, partner.preferredPixel)
      : "";
  /** Inline per-field destination edit (owner ask 09-08): only the touched field becomes the
   *  row's own — the rest keeps riding the batch defaults (rowDestination fills them). Clearing
   *  every field hands the row back to the defaults (dest → null). */
  const patchRowDest = (r: CloneRow, patch: Partial<CloneRowDest>) => {
    const base = r.dest ?? { pageId: "", accountId: "", pixelId: "" };
    patchRow(r.id, { dest: normalizeRowDest({ ...base, ...patch }) });
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

  /** Queue each clone (rows × the row's copies) into the Task Manager, which builds them one at
   *  a time (ACTIVE since 08-11) with live stages / errors / retry — the same queue and pipeline
   *  as launches. Each clone carries ITS row's destination (own or the batch defaults). */
  const duplicate = () => {
    if (destinationMissing || acctBlocked || fankaOver || bidMissingCount > 0 || signerMissing || limits.staleBuild) return; // the button is disabled too — belt and suspenders
    let queued = 0;
    for (const r of rows) {
      const d = destOf(r);
      const target = isTargetFor(d);
      const stale = pixelStaleFor(d);
      const total = copiesOf(r);
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
          pageId: d.pageId,
          // Target account+pixel only for a concrete account; SOURCE_ACCOUNT (an explicit pick
          // too) omits them = each clone builds in its source's own account. AIF sends the pick
          // too (09-02) — an empty one auto-derives server-side (click sources stay pixel-less).
          ...(target
            ? // Belt: a stale pick (no longer among the account's pixels) must never ride the
              // POST even if some path skips the destinationMissing gate.
              { accountId: d.accountId, pixelId: stale ? "" : d.pixelId }
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
  const destRow = rows.find((r) => r.id === destRowId) ?? null;

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
            <p className="-mt-2 text-[10.5px] leading-snug text-faint">
              Batch defaults — every row rides these unless it sets its own Destination in the table.
            </p>

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
                      className={`text-[10px] font-medium uppercase tracking-[0.14em] ${fanpageMissing && defaultsUsed ? "text-warn" : "text-faint"}`}
                    >
                      Fanpage{pageStale ? " — re-pick (not on this signer)" : fanpageMissing && defaultsUsed ? " — required" : ""}
                    </span>
                    <SearchSelect
                      value={effPageId}
                      onChange={(v) => patchSettings({ pageId: v })}
                      options={fanpages ?? []}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                      metaWhenClosed
                      warn={fanpageMissing && defaultsUsed}
                    />
                    {/* Live fill of the picked fanka vs what the rows bound to it add (1 ad per
                        clone) — red when it won't fit; Duplicate locks on the same flag. The
                        auto pick names itself (least filled). */}
                    {fankaStats ? (
                      <p
                        className={
                          "px-0.5 font-mono text-[10.5px] tabular-nums " +
                          (defaultFankaOver
                            ? "font-semibold text-danger"
                            : fankaStats.limit > 0 && fankaStats.used / fankaStats.limit >= 0.8
                              ? "text-warn"
                              : "text-faint")
                        }
                      >
                        {settingsPageIsAuto ? "auto · least filled · " : ""}
                        {fankaStats.used}/{fankaStats.limit} ads · {fankaStats.free} free
                        {defaultFankaDemand > 0 ? ` · batch adds ${defaultFankaDemand}` : ""}
                      </p>
                    ) : settingsPageIsAuto ? (
                      <p className="px-0.5 text-[10.5px] text-faint">auto · least filled fanka — pick another to override</p>
                    ) : null}
                  </div>
                ) : null}
                {partner.accountsFromToken ? (
                  <>
                    <div className="flex flex-col gap-1 px-1.5 py-1">
                      <span
                        className={`text-[10px] font-medium uppercase tracking-[0.14em] ${accountMissing && defaultsUsed ? "text-warn" : "text-faint"}`}
                      >
                        Account{accountStale ? " — re-pick (not on this signer)" : accountMissing && defaultsUsed ? " — required" : ""}
                      </span>
                      <SearchSelect
                        value={effAccountId}
                        onChange={(v) =>
                          patchSettings({
                            accountId: v,
                            // Auto-pick the target's pixel (FARM-1 when it carries it) the same way
                            // a fresh launch card does; no pixel in source mode / when cleared.
                            // AIF auto-picks the value pixel VD-C1-HS-1 (the only offerable one, 09-02 pt2).
                            pixelId:
                              v && v !== SOURCE_ACCOUNT
                                ? aifMode
                                  ? (pickAifPixel(pixelOptionsOf(adAccounts, v))?.id ?? "")
                                  : defaultPixelFor(adAccounts, v, partner.preferredPixel)
                                : "",
                          })
                        }
                        options={[
                          { value: SOURCE_ACCOUNT, label: "From each source" },
                          ...decorateAccountOptions(adAccounts ?? [], limits),
                        ]}
                        placeholder="Select account"
                        emptyHint={adAccounts ? "No accounts on the token" : "Loading accounts…"}
                        warn={accountMissing && defaultsUsed}
                      />
                      {settingsAccountIsAuto ? (
                        <p className="px-0.5 font-mono text-[10.5px] tabular-nums text-faint">
                          auto · least loaded · {limits.countFor(effAccountId)}/{limits.limit} launches in its 30-min window —
                          pick another (or “From each source”) to override
                        </p>
                      ) : null}
                    </div>
                    {isTargetAccount ? (
                      <div className="flex flex-col gap-1 px-1.5 py-1">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-[0.14em] ${pixelMissing && defaultsUsed ? "text-warn" : "text-faint"}`}
                        >
                          Pixel{pixelMissing && defaultsUsed ? " — required" : ""}
                        </span>
                        <SearchSelect
                          value={effPixelId}
                          onChange={(v) => patchSettings({ pixelId: v })}
                          options={targetPixels.map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                          placeholder="Search pixel"
                          emptyHint={
                            adAccounts
                              ? aifMode
                                ? `Share ${AIF_VALUE_PIXEL.name} to this cabinet in BM`
                                : "No pixels on this account"
                              : "Loading pixels…"
                          }
                          metaWhenClosed
                          warn={pixelMissing && defaultsUsed}
                        />
                      </div>
                    ) : effAccountId === SOURCE_ACCOUNT ? (
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
                  ? "Pick the destination explicitly: the fanpage and the account. “From each source” keeps every clone in its source campaign’s own account; a concrete account re-builds the whole batch there. Any row can override these with its own Destination."
                  : isTargetAccount
                    ? "Rows on the defaults are re-built in the picked account: the source video/image is re-uploaded there (adds a “Migrating media” step) and conversion clones optimize for the picked pixel."
                    : "Rows on the defaults are created in their source campaign’s own ad account (its video/image lives there), with the source’s pixel. Only the fanpage applies to them."}
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
                    if (raw !== "") patchSettings({ copies: Math.max(1, Math.min(MAX_CLONE_COPIES, Number(raw))) });
                  }}
                  onBlur={() => setCopiesDraft(null)}
                  className="w-full min-w-0 border-x border-line bg-transparent text-center font-mono text-[13px] tabular-nums text-ink outline-none focus:bg-surface2/60"
                />
                <button
                  type="button"
                  aria-label="More copies"
                  onClick={() => setCopies(settings.copies + 1)}
                  disabled={settings.copies >= MAX_CLONE_COPIES}
                  className="flex w-9 shrink-0 items-center justify-center text-[17px] leading-none text-dim transition-colors hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  +
                </button>
              </div>
              <p className="text-[11px] leading-snug text-faint">Default for every campaign — a row can set its own copies.</p>
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
                  {rowsMissing.every((r) => !r.dest) ? (
                    <>
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
                      {rowsMissing.length < rows.length ? ` (${rowsMissing.length} of ${rows.length} rows ride the defaults)` : ""}
                    </>
                  ) : (
                    <>
                      Duplicate is locked — <span className="font-semibold">{rowsMissing.length}</span> row
                      {rowsMissing.length === 1 ? " has" : "s have"} an incomplete Destination (see the amber
                      chips in the table).
                    </>
                  )}
                </div>
              ) : null}

              {previewed && rows.length > 0 && !destinationMissing && acctBlocked
                ? acctShort.map((x) => (
                    <div
                      key={x.accountId}
                      className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn"
                    >
                      Account limit — <span className="font-semibold">{accountLabel(x.accountId)}</span>: only{" "}
                      <span className="font-semibold">{x.remaining}</span> of{" "}
                      <span className="font-semibold">{x.need}</span> clones fit its 30-min window
                      {x.resetAt ? (
                        <>
                          {" "}
                          · resets in{" "}
                          <span className="font-mono font-semibold">{fmtCountdown(x.resetAt, limits.skew)}</span>
                        </>
                      ) : null}
                      . Trim copies or pick another account.
                    </div>
                  ))
                : null}

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

              {previewed && rows.length > 0 && !destinationMissing && fankaOver
                ? fankaShort.map((x) => (
                    <div
                      key={x.pageId}
                      className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn"
                    >
                      Fanpage full — <span className="font-semibold">{x.st.name}</span>: the batch adds{" "}
                      <span className="font-semibold">{x.need}</span> ads but it has only{" "}
                      <span className="font-semibold">{x.st.free}</span> free (
                      <span className="font-mono">
                        {x.st.used}/{x.st.limit}
                      </span>
                      ). Trim copies or pick another fanpage.
                    </div>
                  ))
                : null}

              {previewed ? (
                <p className="text-center text-[11px] text-faint">
                  {rows.length} {rows.length === 1 ? "campaign" : "campaigns"} ={" "}
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

            {loadWarn && !loading && !error ? (
              <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                {loadWarn}
              </div>
            ) : null}
            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">
                {!aifMode && !moSoc ? "Waiting for the signer…" : "Loading campaigns from Facebook…"}
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
              // Responsive grid list (owner ask 09-08 «адаптивно и удобно»): ONE aligned line per
              // row on a wide board (a table's scan, no horizontal scroll), two lines on a laptop
              // board, a stack on a narrow one — CSS container queries on the list (globals.css
              // `.clone-row`), so the layout follows the BOARD's width, not the viewport's. The
              // row's destination is edited INLINE (fanpage / account / pixel pickers carrying the
              // live fill / load badges); the modal stays for "apply to all rows".
              <div className="clone-rows rounded-2xl border border-line">
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
                  const d = destOf(r);
                  const own = r.dest !== null;
                  const target = isTargetFor(d);
                  const pageMissing = fanpageMissingFor(d);
                  const acctMissing = accountMissingFor(d);
                  const pxMissing = pixelMissingFor(d);
                  const missing = pageMissing || acctMissing || pxMissing;
                  const copiesEff = copiesOf(r);
                  const srcKind = bidKind(r.source.bidStrategy);
                  const srcBid =
                    srcKind === "none"
                      ? r.source.bidStrategy === "LOWEST_COST_WITHOUT_CAP"
                        ? "auto"
                        : r.source.originalRoas || "—"
                      : r.source.originalRoas
                        ? `${srcKind === "cap" ? "$" : ""}${r.source.originalRoas}`
                        : "—";
                  const kind = bidKind(r.bidStrategy);
                  return (
                    <div
                      key={r.id}
                      className="clone-row border-b border-line transition-colors last:border-b-0 hover:bg-raise/25"
                    >
                      <div className="cr-num">
                        <span className="flex h-8 items-center justify-center font-mono text-[12px] text-faint">{i + 1}</span>
                      </div>

                      {/* name — fixed prefix (locked) + editable remainder; the chips under it carry
                          the source id, the redirect config and the SOURCE facts (budget · creatives
                          · bid) so they never hide on a narrow board (was an xl-only column). */}
                      <div className="cr-name min-w-0">
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
                          {/* Redirect config rides with the name: HIGH ADX opens the High Offer
                              modal, the rest is a passive tag. */}
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
                          <span
                            className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-faint"
                            title="Source campaign — daily budget · creatives · bid (the clone's own settings are on the right)"
                          >
                            <span className="text-dim">src</span>
                            <span>${moneyLabel(r.source.originalBudget)}</span>
                            <span className="text-dim">·</span>
                            <FilmIcon className="h-3 w-3" />
                            <span>{r.source.creatives.length}</span>
                            <span className="text-dim">·</span>
                            <BidKindTag strategy={r.source.bidStrategy} />
                            <span>{srcBid}</span>
                          </span>
                        </div>
                      </div>

                      {/* geo — the whole block opens the targeting editor (chips are clickable) */}
                      <div className="cr-geo min-w-0">
                        <span className="cr-label">Geo</span>
                        <button
                          type="button"
                          onClick={() => setTargetingRowId(r.id)}
                          title="Edit targeting — countries, languages, OS, age"
                          className="group/geo -m-1 flex max-w-full flex-col items-start gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          <GeoChips codes={r.countries} />
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-dim transition-colors group-hover/geo:text-[#9db8ff]">
                            <GlobeIcon className="h-3 w-3" />
                            Targeting
                          </span>
                        </button>
                      </div>

                      {/* destination — INLINE pickers (owner ask 09-08): every field the row leaves
                          empty rides the batch Settings; a pick here overrides just that field
                          (accent border = the row's own). × on a field returns it to the default;
                          ↺ drops the whole override. The badges are the live fanka fill and the
                          account's 5/30-min load. */}
                      <div className="cr-dest min-w-0">
                        <span className="cr-label">Destination</span>
                        <div className="mb-1.5 flex flex-wrap items-center gap-1">
                          {own ? (
                            <>
                              <span
                                className="rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-[#9db8ff]"
                                title="This row carries its own destination picks — the batch defaults fill only what it leaves empty"
                              >
                                own
                              </span>
                              <button
                                type="button"
                                onClick={() => patchRow(r.id, { dest: null })}
                                aria-label="Back to the batch defaults"
                                title="Back to the batch defaults"
                                className="inline-flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                              >
                                <UndoIcon className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <span
                              className="rounded border border-line bg-surface2 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-faint"
                              title="Rides the batch defaults from Settings — pick a fanpage / account / pixel here to override just that field"
                            >
                              defaults
                            </span>
                          )}
                          {missing ? (
                            <span
                              className="text-[10px] font-semibold text-warn"
                              title="Fanpage · account · pixel not all picked (or no longer on this signer) — Duplicate stays locked"
                            >
                              incomplete
                            </span>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setDestRowId(r.id)}
                            aria-label="Destination options"
                            title="Destination options — apply this row's destination and copies to all rows"
                            className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <MoreIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="cr-dest-picks">
                          {partner.fanpagesFromToken ? (
                            <SearchSelect
                              size="sm"
                              value={d.pageId}
                              onChange={(v) => patchRowDest(r, { pageId: v })}
                              options={fanpages ?? []}
                              placeholder={partner.pagePlaceholder}
                              emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                              warn={pageMissing}
                              accent={Boolean(r.dest?.pageId)}
                              ariaLabel={`Fanpage for row ${i + 1}`}
                            />
                          ) : null}
                          {partner.accountsFromToken ? (
                            <SearchSelect
                              size="sm"
                              value={d.accountId}
                              onChange={(v) => patchRowDest(r, { accountId: v, pixelId: autoPixelFor(v) })}
                              options={[
                                { value: SOURCE_ACCOUNT, label: "From each source" },
                                ...decorateAccountOptions(adAccounts ?? [], limits),
                              ]}
                              placeholder="Account"
                              emptyHint={adAccounts ? "No accounts on the token" : "Loading accounts…"}
                              warn={acctMissing}
                              accent={Boolean(r.dest?.accountId)}
                              ariaLabel={`Account for row ${i + 1}`}
                            />
                          ) : (
                            <span className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint">
                              <LockIcon className="h-3 w-3 shrink-0" />
                              Account · from each source
                            </span>
                          )}
                          {partner.accountsFromToken ? (
                            target ? (
                              <SearchSelect
                                size="sm"
                                value={d.pixelId}
                                onChange={(v) => patchRowDest(r, { pixelId: v })}
                                options={targetPixelsFor(d.accountId).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                                placeholder="Pixel"
                                emptyHint={
                                  adAccounts
                                    ? aifMode
                                      ? `Share ${AIF_VALUE_PIXEL.name} to this cabinet in BM`
                                      : "No pixels on this account"
                                    : "Loading pixels…"
                                }
                                warn={pxMissing}
                                accent={Boolean(r.dest?.pixelId)}
                                ariaLabel={`Pixel for row ${i + 1}`}
                              />
                            ) : (
                              <span
                                className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint"
                                title="The clones keep their source campaign's pixel"
                              >
                                <LockIcon className="h-3 w-3 shrink-0" />
                                Pixel · from source
                              </span>
                            )
                          ) : null}
                        </div>
                      </div>

                      {/* clone settings (editable) — money-sanitized like the launcher's fields
                          (ROAS = cash-register mode, budget = cash-register too since 09-08) so
                          garbage can't reach CloneEdit.roasGoal/budget → money()=0 → an ad set
                          Meta rejects (orphan + burnt gcm). */}
                      <div className="cr-bid min-w-0">
                        <span className="cr-label">Strategy · Bid</span>
                        <div className="cr-bid-inner">
                          {/* The CLONE's strategy — switchable per row (ROAS ↔ cap ↔ lowest, owner
                              ask 09-01). The bid field follows the PICKED strategy; a kind change
                              clears the value and switching back to the source's kind restores
                              its bid. */}
                          <div className="relative">
                            <select
                              value={r.bidStrategy}
                              onChange={(e) => {
                                const bidStrategy = e.target.value;
                                const next = bidKind(bidStrategy);
                                const roasGoal =
                                  next === bidKind(r.bidStrategy)
                                    ? r.roasGoal
                                    : next === bidKind(r.source.bidStrategy)
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
                                cellSelect + (r.bidStrategy !== r.source.bidStrategy ? " border-accent/50 text-[#9db8ff]" : "")
                              }
                            >
                              {BID_STRATEGIES.map((o) => (
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
                              value={kind === "none" ? "" : r.roasGoal}
                              onChange={(e) =>
                                patchRow(r.id, {
                                  roasGoal: limitMoneyCents(e.target.value, kind === "roas" ? 100 : 1000),
                                })
                              }
                              inputMode="decimal"
                              disabled={kind === "none"}
                              placeholder={kind === "roas" ? "1,20" : kind === "cap" ? "0,50" : "auto"}
                              title={
                                kind === "roas"
                                  ? "ROAS decimal — 34 → 0,34 (34%)"
                                  : kind === "cap"
                                    ? "Bid cap in $ — digits fill cents, 34 → $0,34"
                                    : "Lowest cost bids automatically"
                              }
                              aria-label="Bid / ROAS goal"
                              className={
                                cellInput +
                                (kind !== "none" ? " pl-5" : " opacity-50") +
                                (rowBidMissing(r) ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")
                              }
                            />
                          </div>
                        </div>
                      </div>

                      {/* budget (cash register) + this row's copies (stepper; empty = batch default) */}
                      <div className="cr-budget min-w-0">
                        <span className="cr-label">Budget · Copies</span>
                        <div className="cr-budget-inner">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">
                              $
                            </span>
                            <input
                              value={r.budget}
                              onChange={(e) => patchRow(r.id, { budget: limitMoneyCents(e.target.value, 10000) })}
                              inputMode="decimal"
                              placeholder="10,00"
                              aria-label="Daily budget"
                              title="Daily budget in $ — digits fill cents, 1000 → 10,00"
                              className={
                                `${cellInput} pl-5` +
                                (parseMoney(r.budget) < 1 ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")
                              }
                            />
                          </div>
                          <div
                            className={
                              "flex h-8 items-stretch overflow-hidden rounded-md border bg-surface2 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15 " +
                              (r.copies != null ? "border-accent/45" : "border-line hover:border-line2")
                            }
                            title={`Copies of this row · empty = the batch default (${settings.copies}) · max ${MAX_CLONE_COPIES}`}
                          >
                            <button
                              type="button"
                              onClick={() => patchRow(r.id, { copies: Math.max(1, copiesEff - 1) })}
                              disabled={copiesEff <= 1}
                              aria-label="Fewer copies"
                              className="flex w-7 shrink-0 items-center justify-center text-faint transition-colors hover:bg-raise hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <MinusIcon className="h-3 w-3" />
                            </button>
                            <span className="pointer-events-none self-center font-mono text-[10.5px] text-faint">×</span>
                            <input
                              value={r.copies != null ? String(r.copies) : ""}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/\D/g, "").slice(0, 3);
                                patchRow(r.id, {
                                  copies: raw === "" ? null : Math.max(1, Math.min(MAX_CLONE_COPIES, Number(raw))),
                                });
                              }}
                              inputMode="numeric"
                              placeholder={String(settings.copies)}
                              aria-label="Copies for this row"
                              className={
                                "min-w-0 flex-1 bg-transparent px-1 text-center font-mono text-[12px] tabular-nums outline-none placeholder:text-faint " +
                                (r.copies != null ? "text-[#9db8ff]" : "text-dim")
                              }
                            />
                            <button
                              type="button"
                              onClick={() => patchRow(r.id, { copies: Math.min(MAX_CLONE_COPIES, copiesEff + 1) })}
                              disabled={copiesEff >= MAX_CLONE_COPIES}
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
                          onClick={() => removeRow(r.id)}
                          aria-label="Remove campaign"
                          title="Remove from the batch"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                        >
                          <TrashIcon className="h-[18px] w-[18px]" />
                        </button>
                      </div>
                    </div>
                  );
                })}
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
                  {preview.map((p) => {
                    const r = rows.find((x) => x.id === p.rowId);
                    const d = r ? destOf(r) : null;
                    return (
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
                      {d ? (
                        <span
                          className={"shrink-0 truncate text-[11px] " + (r?.dest ? "text-[#9db8ff]" : "text-faint")}
                          title={`${partner.fanpagesFromToken ? `fanpage ${fanpageLabel(d.pageId)} · ` : ""}${accountLabel(d.accountId)}${isTargetFor(d) && d.pixelId ? ` · pixel ${pixelLabel(d.accountId, d.pixelId)}` : ""}`}
                        >
                          → {partner.fanpagesFromToken ? fanpageLabel(d.pageId) : ""}
                          {partner.accountsFromToken ? ` · ${accountLabel(d.accountId)}` : ""}
                          {r?.dest ? " (own)" : ""}
                        </span>
                      ) : null}
                    </div>
                    );
                  })}
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
      {destRow ? (
        <CloneDestinationModal
          title={fullCloneName(destRow)}
          partner={partner}
          aifMode={aifMode}
          fanpages={fanpages}
          adAccounts={adAccounts}
          limits={limits}
          initial={destOf(destRow)}
          initialCopies={destRow.copies}
          defaultCopies={settings.copies}
          hasOverride={destRow.dest !== null}
          rowCount={rows.length}
          onClose={() => setDestRowId(null)}
          onApply={(dest, copies) => patchRow(destRow.id, { dest, copies })}
          onApplyAll={(dest, copies) => {
            setRows((rs) => rs.map((x) => ({ ...x, dest: { ...dest }, copies })));
            setPreviewed(false);
          }}
          onUseDefaults={() => patchRow(destRow.id, { dest: null, copies: null })}
        />
      ) : null}
    </>
  );
}
