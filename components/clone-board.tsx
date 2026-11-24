"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CloneEdit,
  type CloneRow,
  type CloneRowDest,
  type CloneSettings,
  type CloneSource,
  type HighOfferConfig,
  MAX_CLONE_COPIES,
  SOURCE_ACCOUNT,
  SOURCE_PAGE,
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
  bidTag,
  budgetOnStrategyChange,
  defaultBudgetFor,
  limitMoneyCents,
  moEnsureSocMark,
  moneyCentsLabel,
  moneyLabel,
  normalizeRoasGoal,
  parseMoney,
  todayPrefixDDMM,
} from "@/lib/types";
import { BID_STRATEGIES, LOCALES, OS_OPTIONS, countryName, geoSummary } from "@/lib/catalog";
import { TOOL_MARK, stripToolMark, toolEnsureMark } from "@/lib/tool-launch";
import { AIF_VALUE_PIXEL, type PartnerId, aifOfferablePixels, partnerConfig, pickAifPixel } from "@/lib/partners";
import { accountLoads, leastFilledPage, leastLoadedAccount } from "@/lib/pick-defaults";
import { teamHas } from "@/lib/team";
import { cloneAutofillRows, undoCloneAutofill } from "@/lib/clone-autofill";
import { type HsAutofillPatch, autofillNote } from "@/lib/hs-autofill";
import {
  VC_CLONE_EVENTS,
  type VcCloneEvent,
  type VcCloneSource,
  isVcCloneEvent,
  vcBoardSource,
  vcCloneBinds,
  vcCloneDelivery,
  vcCloneRefusal,
  vcPixelName,
  vcRowEdit,
} from "@/lib/vc-clone";
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
  SparklesIcon,
  TargetIcon,
  TrashIcon,
  UndoIcon,
  XIcon,
} from "./icons";
import { Header } from "./header";
import { useAifTaskManager, useAvTaskManager, useTaskManager, useVcTaskManager } from "./task-manager";
import { UploadingNotice } from "./upload-guard";
import { CloneTargetingModal } from "./clone-targeting-modal";
import { CloneHighOfferModal } from "./clone-high-offer-modal";
import { CloneDestinationModal } from "./clone-destination-modal";
import { HsAutofillModal } from "./hs-autofill-modal";
import { type VcSourceList, VcSourcePicker, fetchVcSources } from "./vc-source-picker";
import { SearchSelect } from "./search-select";
import { useSigners } from "./use-signers";
import { SignerBadge } from "./signer-badge";
import { useFanpages } from "./use-fanpages";
import { defaultPixelFor, pixelOptionsOf, useAdAccounts } from "./use-adaccounts";
import { decorateAccountOptions, fmtCountdown, useAcctLimits, windowMinutes } from "./use-acct-limit";
import { useToolReady } from "./use-tool-ready";
import type { SessionUser } from "./user-menu";

/** Today as DD.MM for clone-name date stamping — the team's (Kyiv) calendar day (lib/types
 *  todayPrefixDDMM), identical on the server render and the client hydration (the old
 *  renderer-clock version caused React #418 on every board open for hours every night, live 09-09). */
const todayDDMM = (): string => todayPrefixDDMM();

// A team without the TOOL rail (lib/team) must not poll /api/tool/ready — on such a team it 404s
// forever. glo-01 has the rail, so this is true there and the poll is unchanged.
const HAS_TOOL_RAIL = teamHas("channel:tool");

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
 *  the Budget cell runs in (owner ask 09-08 — "10" would re-read as 0,10 on the first keystroke).
 *  A source that bids on min ROAS seeds the $50 default instead of its own budget (owner rule
 *  09-11); every other strategy keeps the source's. */
function seedRow(...args: Parameters<typeof makeCloneRow>): CloneRow {
  const row = makeCloneRow(...args);
  return { ...row, budget: moneyCentsLabel(defaultBudgetFor(row.bidStrategy, row.budget)) };
}

/** AV never launches min-ROAS — the AV page carries no conversion signal (Traffic / link clicks
 *  only), so the AV bid select never offers ROAS and the server refuses it. A source read on the
 *  AV rail that happens to bid on min ROAS is snapped to lowest cost AS IT SEEDS, exactly as if
 *  the buyer had switched the strategy in the row: the goal clears and an untouched $50 ROAS
 *  default budget drops back to the source's own (budgetOnStrategyChange). Pure — only the AV
 *  branch calls it, so MO/AIF rows are untouched. */
function snapAvRoasRow(row: CloneRow): CloneRow {
  if (bidKind(row.bidStrategy) !== "roas") return row;
  const bidStrategy = "LOWEST_COST_WITHOUT_CAP";
  const budget = moneyCentsLabel(budgetOnStrategyChange(row.bidStrategy, bidStrategy, row.budget, row.source.originalBudget));
  return { ...row, bidStrategy, roasGoal: "", budget };
}

/** Every AV source is TOOL-born ("… (AV) - GCL TOOL - <topic> | …"), so its tail would carry that mark into
 *  the clone's editable name — shown twice next to the locked prefix on TOOL, and kept on a clone the AV
 *  FB token builds. The clone gets the mark of ITS OWN channel at fire time (toolEnsureMark on TOOL, the
 *  server re-ensures it), so the seeded tail starts without it (09.11). AV and VC (a VC source may be
 *  TOOL-born too, 17.11) — MO/AIF untouched. */
function dropAvToolMark(row: CloneRow): CloneRow {
  const name = stripToolMark(row.name);
  return name === row.name ? row : { ...row, name };
}

/** VC's User OS pick (owner ask 17.11): a VC clone keeps its source's own devices unless the buyer says
 *  otherwise — so the batch select gets a third, default choice the other partners' boards do not have. */
type VcUserOs = "" | "all" | "android";
const VC_OS_OPTIONS = [{ value: "", label: "As each source" }, ...OS_OPTIONS];
const VC_EVENT_LS = "adlauncher.clone.vc.event";

/** What a clone of `src` optimizes under the batch Optimization pick, in a word ("Lead", "Purchase", "Clicks"). */
function vcEventWord(event: VcCloneEvent, src: VcCloneSource): string {
  const d = vcCloneDelivery(event, src);
  if (!d.conversionEvent) return "Clicks";
  return d.conversionEvent.charAt(0) + d.conversionEvent.slice(1).toLowerCase();
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
  // separate AIF instance (own drawer, own Strapi scope), AV in its own, MO in the team one —
  // same rule as the launcher board.
  const teamTm = useTaskManager();
  const aifTm = useAifTaskManager();
  const avTm = useAvTaskManager();
  const vcTm = useVcTaskManager();
  const cloneTm = partnerConfig(partnerId).vcLaunch ? vcTm : partnerConfig(partnerId).avLaunch ? avTm : partnerConfig(partnerId).aifLaunch ? aifTm : teamTm;
  const { enqueueClone, setOpen } = cloneTm;
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
  // ---- VC only (owner ask 17.11) -------------------------------------------------------------------
  // The batch Optimization: what every clone optimizes — as its source does (the default: a faithful
  // copy), or Lead / Purchase forced on the whole batch (the 05.11 ask — Purchase campaigns re-born as
  // Lead). Remembered per browser. The batch User OS: "" = each source's own devices.
  const [vcEvent, setVcEvent] = useState<VcCloneEvent>("SOURCE");
  const [vcUserOs, setVcUserOs] = useState<VcUserOs>("");
  // The list of ACTIVE VC campaigns the rows are ticked out of (components/vc-source-picker) — null until
  // it is read: at once on a board opened without ids, on demand on a deep link.
  const [vcList, setVcList] = useState<VcSourceList | null>(null);
  const [vcListLoading, setVcListLoading] = useState(false);
  const [vcListError, setVcListError] = useState<string | null>(null);
  // "Autofill all rows" (the HS board's form, lib/clone-autofill) + ONE Undo of the last one.
  const [autofillOpen, setAutofillOpen] = useState(false);
  const [autofillDone, setAutofillDone] = useState<{ before: CloneRow[]; note: string; changed: number } | null>(null);
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
  // AV clone board (partner "av"): AV's own token/catalogs, no pixel anywhere (the AV page has
  // none — Traffic / link clicks), no SOC marks, keys claimed server-side per clone. Every AV
  // branch guards on this so MO/AIF stay byte-identical.
  const avMode = Boolean(partner.avLaunch);
  // VC clone board (partner "vc", owner ask 17.11: «сделай его нормальным так как у нас и на других
  // партнерах со всем функционалом, чтобы можно было акк выбрать»): the same board, on VC's own token
  // and catalogs, with what VC alone needs — the sources are LISTED here (no stats tool hands VC ids
  // over; the ticked ones become the rows), "From each source" is the default for the account AND the
  // fanpage (a VC clone is a faithful copy unless the buyer re-targets it), the pixel follows the batch
  // Optimization (as each source / Lead / Purchase) unless one is picked, and the clone carries every
  // reusable ad of its source. No marker pool, no SOC marks. Every VC branch guards on this so
  // MO/AIF/AV stay byte-identical.
  const vcMode = Boolean(partner.vcLaunch);
  // The clone signer is the OWNER'S pick on /tokens (mo.clone / aif.clone / av.clone; env default
  // while unassigned — AV has no env seed) — read-only here: the CATALOGS (fanpages/accounts;
  // AV carries no pixels), the source reads and the clone build all ride that bearer (the run
  // route resolves the same slot server-side). VC: VC · Clones when the owner assigned one, else
  // VC · Launches — one VC system user serves both (lib/vc-launch vcCloneRail, the same rule the
  // catalogs and the run follow server-side).
  const signers = useSigners(true);
  const railSigner = vcMode
    ? ((signers.slots?.["vc.clone"]?.primary ? signers.slots["vc.clone"] : signers.slots?.["vc.launch"]) ?? null)
    : (signers.slots?.[avMode ? "av.clone" : aifMode ? "aif.clone" : "mo.clone"] ?? null);
  /** A token exists for this rail — catalogs load, Duplicate may fire. */
  const signerReady = Boolean(railSigner?.primary);
  /** SOC name marker rides personal-soc signers only (MO) — system users (AIF/AV/VC) go unmarked. */
  const moSocMarks = !aifMode && !avMode && !vcMode && Boolean(railSigner?.primary?.personal);
  const signerMissing = !signerReady;

  // ---- launch channel (owner ask 28.09): our FB Token (the default Graph rail) vs TOOL (the HS
  // team's Ads Manager sessions service). Persisted per partner. TOOL is offered only when the
  // server says a live TOOL session sees this partner's accounts (useToolReady) — today only HS has
  // such a session, so MO/AIF stay on FB Token until an owner adds one on Ads Manager sessions. A
  // stale "tool" pick with the rail not ready falls back to FB Token (same rule as the HS board).
  const CHANNEL_LS = `adlauncher.clone.${partnerId}.channel`;
  // AV starts on TOOL (owner ask 09.11: «сделай чтобы работал через Tool» — AV launches build only there,
  // the AV token just reads the source and lists the fanpage); every other partner starts on FB Token.
  const [channel, setChannel] = useState<"token" | "tool">(avMode ? "tool" : "token");
  useEffect(() => {
    try {
      const v = localStorage.getItem(CHANNEL_LS);
      // Safe setState-in-effect: runs once on mount (localStorage is unreadable during SSR).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "tool" || v === "token") setChannel(v);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, [CHANNEL_LS]);
  const changeChannel = (ch: "token" | "tool") => {
    setChannel(ch);
    setPreviewed(false);
    try {
      localStorage.setItem(CHANNEL_LS, ch);
    } catch {
      /* storage disabled */
    }
  };
  // AV clones through TOOL (owner ask 09.11): the AV token READS the source (TOOL cannot), TOOL builds the
  // clone in a GC-AV cabinet a live session sees — /api/tool/ready?partner=av&rail=clone answers like
  // the launch rail (the GC-AV cabinets ∩ the buyer's /accounts).
  const toolReady = useToolReady(partnerId, "clone", HAS_TOOL_RAIL);
  /** The channel that actually fires: a "tool" pick only holds while the rail is READY (else the
   *  segment is disabled and the fire falls back to FB Token). */
  const onTool = channel === "tool" && toolReady.ready;
  // /api/tool/ready returns BARE digits; our catalog account values are bare digits too, but strip
  // any "act_" defensively so the TOOL filter matches regardless of spelling.
  const bareId = (v: string): string => v.replace(/^act_/, "");
  /** A concrete account a live TOOL session sees for this partner (never SOURCE_ACCOUNT). */
  const toolAccountVisible = (accountId: string): boolean =>
    Boolean(accountId) && accountId !== SOURCE_ACCOUNT && toolReady.accounts.has(bareId(accountId));
  // Token fanpages for the batch fanka picker (with live N/limit fill tags from the hs-tools
  // registry; AIF's scope fills in the day the box syncs AIF pages — same as the launcher board).
  // MO waits for the signer pick — there is no system catalog to fall back to any more.
  const fanpages = useFanpages(
    Boolean(partner.fanpagesFromToken) && signerReady,
    partner.pageAdLimit ?? 250,
    vcMode
      ? // VC's pages are the VC token's (no hs-tools scope → no fill badges).
        { list: "/api/vc/fanpages?rail=clone", volume: null }
      : avMode
      ? // hs-tools has no AV scope → no fill badges (volume null); the list alone is the picker.
        { list: "/api/av/fanpages?rail=clone", volume: null }
      : aifMode
        ? { list: "/api/aif/fanpages?rail=clone", volume: "/api/aif/fanpages/volume" }
        : { list: "/api/fanpages?rail=clone", volume: "/api/fanpages/volume" },
  );
  // Token ad accounts for the destination pick. The destination is an EXPLICIT choice:
  // "" = nothing chosen yet (Duplicate stays locked), SOURCE_ACCOUNT = consciously keep each
  // clone in its source campaign's own account, digits = a concrete target account (media gets
  // migrated there). No silent default — the buyer must say where the batch goes.
  const adAccounts = useAdAccounts(
    Boolean(partner.accountsFromToken) && signerReady,
    partner.preferredPixel,
    vcMode ? "/api/vc/adaccounts?rail=clone" : avMode ? "/api/av/adaccounts?rail=clone" : aifMode ? "/api/aif/adaccounts?rail=clone" : "/api/adaccounts?rail=clone",
    // AV cabinets carry no pixel — the picker must not flag every one with the "no pixel" danger tag.
    avMode ? { noPixelTag: true } : undefined,
  );

  // ---- destination verdicts, per TUPLE (owner ask 09-08: a row may carry its own) -----------
  // The batch Settings tuple is judged with the same helpers as any row's own tuple. Staleness
  // (a pick absent from the freshly LOADED catalog after a signer switch / list refresh) counts
  // as missing — the pick would fire a bind the new signer can't use. A mid-load list (null)
  // never flags a legit pick; the server's own catalog checks stay the final authority.
  const isTargetFor = (d: CloneRowDest): boolean => Boolean(d.accountId) && d.accountId !== SOURCE_ACCOUNT;
  // VC's "From each source" fanpage pick is no page of the catalog — it never reads as stale (whether
  // the token still holds each SOURCE's page is judged per row, vcIssueOf).
  const pageStaleFor = (d: CloneRowDest): boolean =>
    Boolean(partner.fanpagesFromToken) &&
    Boolean(d.pageId) &&
    !(vcMode && d.pageId === SOURCE_PAGE) &&
    fanpages !== null &&
    !fanpages.some((o) => o.value === d.pageId);
  const fanpageMissingFor = (d: CloneRowDest): boolean =>
    Boolean(partner.fanpagesFromToken) && (!d.pageId || pageStaleFor(d));
  const accountStaleFor = (d: CloneRowDest): boolean =>
    Boolean(partner.accountsFromToken) &&
    isTargetFor(d) &&
    adAccounts !== null &&
    !adAccounts.some((a) => a.value === d.accountId);
  /** On the TOOL rail the effective build account must be a concrete TOOL-visible cabinet — a
   *  non-TOOL account or the "From each source" sentinel can't build through TOOL (owner ask 28.09),
   *  so it reads as missing and blocks Duplicate with the message below. */
  // VC knows each source's own cabinet, so "From each source" stays a valid pick on TOOL too — whether a
  // live session sees THAT cabinet is judged per row (vcIssueOf).
  const accountToolMissingFor = (d: CloneRowDest): boolean =>
    onTool && Boolean(d.accountId) && !(vcMode && d.accountId === SOURCE_ACCOUNT) && !toolAccountVisible(d.accountId);
  const accountMissingFor = (d: CloneRowDest): boolean =>
    Boolean(partner.accountsFromToken) && (!d.accountId || accountStaleFor(d) || accountToolMissingFor(d));
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
  // AV's pixel is never picked (the route gives a Purchase clone AV_PIXEL, a click clone none), so a
  // pixel is never required and never blocks Duplicate; MO/AIF keep the concrete-account pixel requirement.
  // VC's pixel is OPTIONAL: empty = the batch Optimization's own dataset (the source's, the S-1 nik pixel
  // for Lead, the VC pixel for Purchase) — only a pick the account no longer carries reads as missing.
  const pixelMissingFor = (d: CloneRowDest): boolean =>
    vcMode ? pixelStaleFor(d) : !avMode && isTargetFor(d) && (!d.pixelId || pixelStaleFor(d));
  const destMissingFor = (d: CloneRowDest): boolean =>
    fanpageMissingFor(d) || accountMissingFor(d) || pixelMissingFor(d);

  // Account launch limit (5 campaigns / 15 min) — the pickers' N/5 badges, the default account
  // pick and the batch gate below.
  const limits = useAcctLimits();

  // AV keys registry status. Clones claim a fresh AV key server-side per copy (never here), but
  // the whole batch is pointless until the owner has uploaded a pool to ActiveView (UTM Campaign
  // Values) — the preview endpoint answers `poolMax` = the registered count. poolMax 0 = the stub:
  // the clone run route refuses every AV clone with av_keys_not_registered before any FB write, so we
  // block Duplicate up front with the reason (mirrors the launcher board's poolMax-0 banner).
  // null = not yet known; only a definite 0 blocks. Non-AV boards never touch the endpoint.
  const [avPoolMax, setAvPoolMax] = useState<number | null>(null);
  useEffect(() => {
    if (!avMode) return;
    let alive = true;
    fetch("/api/av/keys")
      .then((r) => r.json())
      .then((d) => {
        if (alive && typeof d?.poolMax === "number") setAvPoolMax(d.poolMax);
      })
      .catch(() => {
        /* registry unreachable — leave it unknown; the server still refuses unregistered keys */
      });
    return () => {
      alive = false;
    };
  }, [avMode]);
  const avKeysUnregistered = avMode && avPoolMax === 0;

  // AV refuses min-ROAS end to end (the AV page has no conversion signal — the run route rejects a
  // roas target strategy), so the row bid select drops it; a roas source is already snapped to
  // lowest cost at seed (snapAvRoasRow). MO/AIF keep the full list unchanged.
  const bidStrategyOptions = avMode ? BID_STRATEGIES.filter((o) => bidKind(o.value) !== "roas") : BID_STRATEGIES;

  // ---- default binds (owner rule 09-08): the LEAST-FILLED fanka and the LEAST-LOADED account
  // on our 5/15-min timer are what an EMPTY Settings pick shows and fires; a real pick (incl.
  // "From each source") wins via state and the × clear returns to auto. The partner's preferred
  // account (BR-1500) is ranked first so it wins ties. Purely derived — live as the meters move.
  // VC: the defaults are "From each source" for BOTH — a clone keeps its source's page and cabinet unless
  // the buyer moves it (owner ask 17.11: the account became a pick, not a forced move).
  const autoPageId = vcMode
    ? SOURCE_PAGE
    : partner.fanpagesFromToken
      ? leastFilledPage(
          (fanpages ?? []).map((o) => ({ id: o.value, used: o.adCount, limit: o.adLimit, disabled: o.disabled })),
          partner.pageAdLimit ?? 250,
        )
      : "";
  /** The fanpage picker's options (Settings + per-row pickers share it): VC leads with "From each source". */
  const fanpageOptions = vcMode
    ? [{ value: SOURCE_PAGE, label: "From each source", adCount: null, adLimit: null }, ...(fanpages ?? [])]
    : (fanpages ?? []);
  const preferredAcct = partner.defaultAccount?.id ?? "";
  // On the TOOL rail only TOOL-visible cabinets are candidates for the auto default (so an empty
  // Settings pick resolves to an account the TOOL session can actually build in).
  const acctCandidates = (onTool ? (adAccounts ?? []).filter((a) => toolReady.accounts.has(bareId(a.value))) : (adAccounts ?? []))
    .slice()
    .sort((a, b) => (a.value === preferredAcct ? -1 : b.value === preferredAcct ? 1 : 0));
  const autoAccountId = vcMode
    ? SOURCE_ACCOUNT
    : partner.accountsFromToken
      ? leastLoadedAccount(
          accountLoads(
            acctCandidates.map((a) => ({ id: a.value, disabled: a.disabled })),
            limits,
          ),
          limits.limit,
        )
      : "";
  /** The account picker's options for the current rail (Settings + per-row pickers share it): on
   *  TOOL only the TOOL-visible cabinets (no "From each source" — a TOOL clone must land in a
   *  concrete TOOL cabinet, and the client has no source-account id to prove SOURCE is visible);
   *  off it, the full token catalog with the "From each source" sentinel (owner ask 28.09). */
  const accountPickerOptions = onTool
    ? [
        // VC keeps the sentinel on TOOL: it knows each source's cabinet and checks it per row.
        ...(vcMode ? [{ value: SOURCE_ACCOUNT, label: "From each source" }] : []),
        ...decorateAccountOptions((adAccounts ?? []).filter((a) => toolReady.accounts.has(bareId(a.value))), limits),
      ]
    : [{ value: SOURCE_ACCOUNT, label: "From each source" }, ...decorateAccountOptions(adAccounts ?? [], limits)];
  const settingsPageIsAuto = Boolean(partner.fanpagesFromToken) && !settings.pageId && Boolean(autoPageId);
  const settingsAccountIsAuto = Boolean(partner.accountsFromToken) && !settings.accountId && Boolean(autoAccountId);
  const effPageId = settings.pageId || autoPageId;
  const effAccountId = settings.accountId || autoAccountId;
  // An auto account brings its own default pixel (the same rule the manual pick applies) — never
  // for AV, which has no pixel at all, nor for VC, whose empty pixel means "the Optimization's own".
  const effPixelId = avMode
    ? ""
    : vcMode
      ? settings.pixelId
      : settings.pixelId ||
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

  // ---- VC: the edit a row ships and why it cannot ship (lib/vc-clone — the run judges the same) ----
  /** A row's values in the VC edit's reading: its effective destination, the batch Optimization / OS. */
  const vcPickOf = (r: CloneRow, d: CloneRowDest, name: string) => ({
    name,
    budget: r.budget,
    bidStrategy: r.bidStrategy,
    bid: r.roasGoal,
    countries: r.countries,
    locales: r.locales,
    category: r.category,
    placement: r.placement,
    ageMin: r.ageMin,
    accountId: d.accountId,
    pageId: d.pageId,
    pixelId: d.pixelId,
    event: vcEvent,
    userOs: vcUserOs,
  });
  /** Where a VC row's clone lands — the cabinet, the page, the pixel — resolved against its source
   *  (null off VC). "From each source" resolves to the source's own here, so everything below (the
   *  launch-limit meter, the TOOL check, the pixel check) works on real ids. */
  const vcBindsOf = (r: CloneRow) => {
    const src = r.source.vc;
    return vcMode && src ? vcCloneBinds(vcRowEdit(src, vcPickOf(r, destOf(r), fullCloneName(r))), src) : null;
  };
  /** Why a VC row cannot be cloned as it stands (null = fine): the contract's own refusals (bid, budget,
   *  geo, languages, a reusable ad, min-ROAS only on Purchase …), then what the catalogs say about where it
   *  lands — a cabinet TOOL / the token does not see, a page the token no longer holds, a pixel not shared
   *  to the cabinet. The same verdicts the run gives, shown BEFORE anything is queued. */
  const vcIssueOf = (r: CloneRow): string | null => {
    const src = r.source.vc;
    if (!src) return "not a VC campaign — remove the row";
    const edit = vcRowEdit(src, vcPickOf(r, destOf(r), fullCloneName(r)));
    const refusal = vcCloneRefusal(edit, src);
    if (refusal) return refusal;
    const b = vcCloneBinds(edit, src);
    const acct = adAccounts?.find((a) => bareId(a.value) === b.accountId);
    const acctName = acct?.label || (!b.cross && src.accountName) || `act_${b.accountId}`;
    if (onTool) {
      if (!toolReady.accounts.has(b.accountId)) return `no live TOOL session sees ${acctName} — pick a TOOL account or switch to FB Token`;
    } else {
      if (adAccounts?.length && !acct) return `${acctName} is not among your VC cabinets on the token — pick another account`;
      if (fanpages?.length && !fanpages.some((o) => o.value === b.pageId)) {
        return `the VC token cannot advertise with ${b.pageId === src.pageId ? "the source's page" : "page"} ${b.pageId} — pick another fanpage`;
      }
    }
    if (b.pixelId && acct && !acct.pixels.some((p) => p.id === b.pixelId)) {
      return `${vcPixelName(b.pixelId)} is not shared to ${acctName} — share it in Business Manager, or pick another pixel / account`;
    }
    return null;
  };
  const vcIssues = new Map<string, string | null>(vcMode ? rows.map((r) => [r.id, vcIssueOf(r)] as const) : []);
  const vcBlockedRows = rows.filter((r) => vcIssues.get(r.id));
  const vcBlocked = vcBlockedRows.length > 0;
  /** The dataset an EMPTY pixel pick means under the batch Optimization. */
  const vcAutoPixelLabel = vcEvent === "SOURCE" ? "each source's own" : vcPixelName(vcCloneDelivery(vcEvent).pixel);

  const rowsMissing = rows.filter((r) => destMissingFor(destOf(r)));
  const destinationMissing = rows.length > 0 && rowsMissing.length > 0;
  /** TOOL rail only: rows whose effective build account isn't a TOOL-visible cabinet (a concrete
   *  non-TOOL account, or a lingering "From each source" pick) — surfaced with its own message
   *  below (the generic destinationMissing box already blocks them via accountMissingFor). */
  const toolAcctBlockedRows = onTool
    ? rows.filter((r) => {
        const d = destOf(r);
        return Boolean(d.accountId) && !toolAccountVisible(d.accountId);
      })
    : [];

  // Account launch limit (5 campaigns / 15 min): EVERY concrete TARGET account must fit its
  // share (rows × copies bound to it). From-each-source rows aren't metered here — the sources'
  // accounts aren't exposed to the board, so the per-copy server claim refuses any overflow with
  // the countdown instead.
  // VC meters EVERY row: it knows each source's own cabinet, so a "From each source" row counts against it.
  const acctDemand = new Map<string, number>();
  for (const r of rows) {
    const d = destOf(r);
    const acct = vcMode ? (vcBindsOf(r)?.accountId ?? "") : isTargetFor(d) ? d.accountId : "";
    if (acct) acctDemand.set(acct, (acctDemand.get(acct) ?? 0) + copiesOf(r));
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
    if (d.pageId && d.pageId !== SOURCE_PAGE) pageDemand.set(d.pageId, (pageDemand.get(d.pageId) ?? 0) + copiesOf(r));
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
  const fanpageLabel = (pageId: string): string =>
    vcMode && pageId === SOURCE_PAGE ? "the source's page" : fanpages?.find((o) => o.value === pageId)?.label || pageId;
  const accountLabel = (accountId: string): string =>
    accountId === SOURCE_ACCOUNT ? "From each source" : adAccounts?.find((a) => a.value === accountId)?.label || accountId;
  const pixelLabel = (accountId: string, pixelId: string): string =>
    pixelOptionsOf(adAccounts, accountId).find((p) => p.id === pixelId)?.name || pixelId;

  // Source reads ride the CLONE signer's token server-side (?rail=clone) — the same bearer that
  // will build, so "no access" on read means "no access" on build.
  const partialWarn = (failed: { id: string; error: string }[]): string | null =>
    failed.length
      ? `${failed.length} campaign${failed.length === 1 ? "" : "s"} didn't load with this signer: ` +
        failed.map((f) => `#${f.id} — ${f.error}`).join(" · ")
      : null;

  /** Snap a freshly seeded row for the active partner: AV min-ROAS sources drop to lowest cost
   *  (see snapAvRoasRow); MO/AIF rows pass through untouched. Stable (avMode is fixed for the
   *  board's life) so it doesn't churn the loadIds callback. */
  const avSnap = useCallback(
    (r: CloneRow): CloneRow => (avMode ? snapAvRoasRow(dropAvToolMark(r)) : vcMode ? dropAvToolMark(r) : r),
    [avMode, vcMode],
  );

  /** Read the sources of `ids` on this partner's rail: /api/clone/sources for MO / AIF / AV; VC reads its
   *  own trees (GET /api/vc/sources?ids=) and hands them over in the board's row-source shape, the VC
   *  facts along (lib/vc-clone vcBoardSource). Same contract either way: throws when NOT ONE id could be
   *  read (the board shows the reasons + Retry), partial failures come back in `failed`. */
  const readSources = useCallback(
    async (ids: string[]): Promise<{ sources: CloneSource[]; failed: { id: string; error: string }[] }> => {
      if (!vcMode) return loadCloneSources(ids, partnerId);
      const res = await fetchVcSources(ids);
      if (res.sources.length === 0 && res.failed.length > 0) {
        throw new Error(
          `Couldn't read ${res.failed.length === 1 ? "the campaign" : `${res.failed.length} campaigns`} with this signer: ` +
            res.failed.map((f) => `#${f.id} — ${f.error}`).join(" · "),
        );
      }
      return { sources: res.sources.map(vcBoardSource), failed: res.failed };
    },
    [vcMode, partnerId],
  );

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
      readSources(ids)
        .then(({ sources, failed }) => {
          setRows(sources.map((s) => avSnap(seedRow(s, ddmm, `r${nextRowId.current++}`, me))));
          setLoadWarn(partialWarn(failed));
          setPreviewed(false);
        })
        .catch((e) => {
          setRows([]);
          setError(e instanceof Error ? e.message : "Failed to load campaigns");
        })
        .finally(() => setLoading(false));
    },
    [readSources, me, avSnap],
  );

  /** Load local mock sources for the "Load sample" button — no Facebook call. */
  const loadSample = () => {
    setLoading(true);
    setError(null);
    const ddmm = todayDDMM();
    loadSampleSources()
      .then((sources) => {
        setRows(sources.map((s) => avSnap(seedRow(s, ddmm, `r${nextRowId.current++}`, me))));
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
    if (!signerReady) {
      if (signers.loaded) {
        initialLoadRef.current = true;
        Promise.resolve().then(() => {
          setLoading(false);
          setError(railSigner?.error || "No clone token is assigned for this partner — an owner assigns one under FB tokens; sources can't be read");
        });
      }
      return;
    }
    initialLoadRef.current = true;
    let alive = true;
    const ddmm = todayDDMM();
    readSources(initialIds)
      .then(({ sources, failed }) => {
        if (!alive) return;
        setRows(sources.map((s) => avSnap(seedRow(s, ddmm, `r${nextRowId.current++}`, me))));
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
  }, [signerReady, signers.loaded]);

  // ---- VC: the list of ACTIVE campaigns the batch is ticked out of -----------------------------
  /** (Re)read the list — an event handler (the picker's Reload), so the synchronous flips are fine. */
  const loadVcList = useCallback(() => {
    setVcListLoading(true);
    setVcListError(null);
    fetchVcSources()
      .then((list) => setVcList(list))
      .catch((e) => {
        setVcList(null);
        setVcListError(e instanceof Error ? e.message : "Failed to load VC campaigns");
      })
      .finally(() => setVcListLoading(false));
  }, []);
  // The first read: ONCE, as soon as the reading token is known, on a board opened WITHOUT ids (a deep
  // link shows its own rows and reads the list on demand — one Graph read per cabinet is not free).
  // Async-only, like the initial load above: every setState lives in a callback.
  const vcListAutoRef = useRef(false);
  useEffect(() => {
    if (!vcMode || initialIds.length > 0 || vcListAutoRef.current) return;
    if (!signerReady) {
      if (signers.loaded) {
        vcListAutoRef.current = true;
        Promise.resolve().then(() =>
          setVcListError(railSigner?.error || "no_token — no token is assigned to VC · Clones or VC · Launches; an owner assigns one under FB tokens"),
        );
      }
      return;
    }
    vcListAutoRef.current = true;
    Promise.resolve().then(loadVcList);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vcMode, signerReady, signers.loaded]);
  // The remembered Optimization (per browser). Safe setState-in-effect: runs once on mount
  // (localStorage is unreadable during SSR) — the same pattern as the channel pick above.
  useEffect(() => {
    if (!vcMode) return;
    try {
      const v = localStorage.getItem(VC_EVENT_LS);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (isVcCloneEvent(v)) setVcEvent(v);
    } catch {
      /* storage disabled — session-local pick only */
    }
  }, [vcMode]);
  const changeVcEvent = (ev: VcCloneEvent) => {
    setVcEvent(ev);
    setPreviewed(false);
    try {
      localStorage.setItem(VC_EVENT_LS, ev);
    } catch {
      /* storage disabled */
    }
  };
  /** Tick: the ticked campaigns become rows (a campaign already in the batch is left as the buyer has it). */
  const addVcSources = (srcs: VcCloneSource[]) => {
    const ddmm = todayDDMM();
    const have = new Set(rows.map((r) => r.source.campaignId));
    const fresh = srcs
      .filter((s) => !have.has(s.campaignId))
      .map((s) => avSnap(seedRow(vcBoardSource(s), ddmm, `r${nextRowId.current++}`, me)));
    if (fresh.length === 0) return;
    setRows((rs) => {
      const now = new Set(rs.map((r) => r.source.campaignId));
      return [...rs, ...fresh.filter((r) => !now.has(r.source.campaignId))];
    });
    setError(null);
    setPreviewed(false);
  };
  /** Untick: the campaigns leave the batch. */
  const removeVcSources = (ids: string[]) => {
    const gone = new Set(ids);
    setRows((rs) => rs.filter((r) => !gone.has(r.source.campaignId)));
    setPreviewed(false);
  };

  // ---- Autofill (VC, owner ask 17.11 — the HS board's batch form on this board's rows) ---------
  const applyAutofill = (patch: HsAutofillPatch) => {
    const res = cloneAutofillRows(rows, patch, MAX_CLONE_COPIES);
    setRows(res.rows);
    setAutofillDone({ before: rows, note: autofillNote(patch), changed: res.changed });
    setAutofillOpen(false);
    setPreviewed(false); // the batch changed — re-preview before firing
  };
  const undoLastAutofill = () => {
    if (!autofillDone) return;
    const { before } = autofillDone;
    setRows((rs) => undoCloneAutofill(rs, before));
    setAutofillDone(null);
    setPreviewed(false);
  };

  const patchRow = (id: string, patch: Partial<CloneRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setPreviewed(false);
  };
  /** The pixel a fresh account pick brings along (the Settings rule): the target's preferred
   *  pixel — AIF: the value pixel — when the cabinet carries it; none in source mode. */
  const autoPixelFor = (accountId: string): string =>
    avMode || vcMode
      ? "" // AV binds no pixel — every account pick stays pixel-less; VC's empty pixel = the Optimization's own
      : accountId && accountId !== SOURCE_ACCOUNT
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

  /** Hand each clone (rows × the row's copies) to the SERVER queue via enqueueClone, which drops an
   *  optimistic row into the Task Manager at once; the server pump builds them one at a time with
   *  live stages / errors / retry — the same queue and pipeline as launches. Clones carry no media
   *  (the source is reused by id), so the hand-off is instant and the tab can be closed right after.
   *  Each clone carries ITS row's destination (own or the batch defaults). */
  const duplicate = () => {
    if (destinationMissing || acctBlocked || fankaOver || bidMissingCount > 0 || signerMissing || limits.reloadRequired || avKeysUnregistered || vcBlocked)
      return; // the button is disabled too — belt and suspenders
    let queued = 0;
    for (const r of rows) {
      const d = destOf(r);
      const target = isTargetFor(d);
      const stale = pixelStaleFor(d);
      const total = copiesOf(r);
      for (let k = 1; k <= total; k++) {
        const vcSrc = r.source.vc;
        if (vcMode) {
          // VC: the row ships as a VC edit (lib/vc-clone vcRowEdit — only what the buyer changed rides as
          // an override; the cabinet is always named, so the queue meters the launch limit by where the
          // clone is really built). On TOOL the mark sits after the clone prefix, exactly as elsewhere.
          if (!vcSrc) continue;
          const vcBase = fullCloneName(r);
          const vcFull = onTool ? toolEnsureMark(vcBase) : vcBase;
          const vcName = total > 1 ? `${vcFull} (${k})` : vcFull;
          const vcEdit = vcRowEdit(vcSrc, vcPickOf(r, d, vcName));
          enqueueClone({
            partnerId,
            edit: vcEdit,
            name: vcName,
            geo: geoSummary(r.countries),
            budget: r.budget,
            bid: bidTag(vcEdit.bidStrategy, vcEdit.bidCap) || undefined,
            ...(onTool ? { via: "tool" as const } : {}),
          });
          queued++;
          continue;
        }
        // Name marker: on TOOL the "GCL TOOL - " marker goes right after the clone prefix (owner
        // ask 28.09; toolEnsureMark, never a SOC mark — TOOL isn't our social signer). Off TOOL,
        // soc-class signers stamp the SOC marker (server re-ensures either way — this keeps the
        // queue rows/previews honest); system-class signers (Spencermo) go unmarked.
        const base = fullCloneName(r);
        const full = onTool ? toolEnsureMark(base) : moSocMarks ? moEnsureSocMark(base) : base;
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
          // AV NEVER sends a pixel (the AV page has none — the run route forces pixelId=""); it
          // sends only the target account.
          ...(target
            ? avMode
              ? { accountId: d.accountId }
              : // Belt: a stale pick (no longer among the account's pixels) must never ride the
                // POST even if some path skips the destinationMissing gate.
                { accountId: d.accountId, pixelId: stale ? "" : d.pixelId }
            : {}),
        };
        enqueueClone({
          partnerId,
          edit,
          name,
          geo: geoSummary(r.countries),
          budget: r.budget,
          // Card tag: the row's picked strategy + its Bid value (cap/ROAS rows can't fire without
          // one — rowBidMissing gates the button; lowest-cost reads "auto").
          bid: bidTag(r.bidStrategy, edit.roasGoal) || undefined,
          // TOOL rail (owner ask 28.09): `via:"tool"` rides the queued job's body so the server pump
          // POSTs the clone through the TOOL clone path (CloneEnqueueArgs.via, forwarded verbatim).
          ...(onTool ? { via: "tool" as const } : {}),
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

            {/* launch channel (owner ask 28.09): our FB Token (the default Graph rail) vs the HS
                team's TOOL service. TOOL unlocks only when a live session sees this partner's
                accounts (useToolReady) — MO/AIF stay on FB Token until an owner adds a session on
                Ads Manager sessions. AV starts on TOOL (owner ask 09.11): the AV token reads the
                source, TOOL builds the clone in a GC-AV cabinet. */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Launch channel</span>
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {[
                  { key: "token" as const, label: "FB Token", ready: true, hint: "Builds on our FB token (the default rail)" },
                  {
                    key: "tool" as const,
                    label: "TOOL",
                    ready: toolReady.ready,
                    hint: !toolReady.loaded
                      ? "Checking TOOL…"
                      : toolReady.ready
                        ? `Launches through TOOL · ${toolReady.accounts.size} account${toolReady.accounts.size === 1 ? "" : "s"}`
                        : toolReady.message || "TOOL is not ready for this partner",
                  },
                ].map((opt) => {
                  const active = channel === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!opt.ready}
                      aria-pressed={active}
                      title={opt.hint}
                      onClick={() => changeChannel(opt.key)}
                      className={
                        "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 " +
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                        (active
                          ? "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                          : "text-dim hover:text-ink") +
                        (opt.ready ? "" : " cursor-not-allowed opacity-40")
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-center text-[10px] leading-relaxed text-faint">
                {onTool
                  ? `Launches through TOOL · ${toolReady.accounts.size} account${toolReady.accounts.size === 1 ? "" : "s"} · marks names “${TOOL_MARK.trim()}”${avMode ? " · the AV token only reads the source" : vcMode ? " · the VC token only reads the source" : ""}`
                  : channel === "tool" && !toolReady.ready
                    ? toolReady.message || "TOOL not ready — firing on FB Token"
                    : avMode
                      ? "Builds on the AV FB token"
                      : vcMode
                        ? "Builds on the VC token"
                        : "Builds on our FB token"}
              </p>
            </div>

            {/* The clone signer — the OWNER'S pick on /tokens: reads the catalogs below AND signs
                every clone (read-only here, owner ask 09-14). */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">Signer</span>
              <SignerBadge signer={railSigner} loaded={signers.loaded} rail="clone" owner={Boolean(user?.owner)} />
            </div>

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
                      options={fanpageOptions}
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
                    ) : vcMode ? (
                      effPageId === SOURCE_PAGE ? (
                        <p className="px-0.5 text-[10.5px] text-faint">
                          {settingsPageIsAuto ? "default · " : ""}each clone advertises with its source&apos;s own page — pick a fanpage to move the batch onto it
                        </p>
                      ) : null
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
                            // AV's pixel is never picked (autoPixelFor returns ""; the route sets it).
                            pixelId: autoPixelFor(v),
                          })
                        }
                        options={accountPickerOptions}
                        placeholder="Select account"
                        emptyHint={
                          adAccounts
                            ? onTool
                              ? "No TOOL-visible accounts for this partner"
                              : "No accounts on the token"
                            : "Loading accounts…"
                        }
                        warn={accountMissing && defaultsUsed}
                      />
                      {vcMode ? (
                        effAccountId === SOURCE_ACCOUNT ? (
                          <p className="px-0.5 text-[10.5px] text-faint">
                            {settingsAccountIsAuto ? "default · " : ""}each clone is built in its source&apos;s own cabinet — pick an account to build the batch there
                          </p>
                        ) : isTargetAccount ? (
                          <p className="px-0.5 font-mono text-[10.5px] tabular-nums text-faint">
                            {limits.countFor(effAccountId)}/{limits.limit} launches in its {windowMinutes(limits)}-min window
                          </p>
                        ) : null
                      ) : settingsAccountIsAuto ? (
                        <p className="px-0.5 font-mono text-[10.5px] tabular-nums text-faint">
                          auto · least loaded · {limits.countFor(effAccountId)}/{limits.limit} launches in its {windowMinutes(limits)}-min window —
                          pick another (or “From each source”) to override
                        </p>
                      ) : null}
                    </div>
                    {vcMode ? (
                      // VC: the pixel is the batch Optimization's own unless one is picked — and a pick is
                      // offered only for a concrete account (a pixel belongs to its cabinet's list).
                      isTargetAccount ? (
                        <div className="flex flex-col gap-1 px-1.5 py-1">
                          <span className={`text-[10px] font-medium uppercase tracking-[0.14em] ${pixelMissing && defaultsUsed ? "text-warn" : "text-faint"}`}>
                            Pixel{pixelMissing && defaultsUsed ? " — re-pick (not on this account)" : ""}
                          </span>
                          <SearchSelect
                            value={effPixelId}
                            onChange={(v) => patchSettings({ pixelId: v })}
                            options={targetPixels.map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                            placeholder={`Auto · ${vcAutoPixelLabel}`}
                            emptyHint={adAccounts ? "No pixels on this account" : "Loading pixels…"}
                            metaWhenClosed
                            warn={pixelMissing && defaultsUsed}
                          />
                          {!effPixelId ? <p className="px-0.5 text-[10.5px] text-faint">auto · {vcAutoPixelLabel} — pick a pixel to override</p> : null}
                        </div>
                      ) : (
                        <LockedRow label="Pixel" value={vcAutoPixelLabel} />
                      )
                    ) : avMode ? (
                      // Nothing to pick: the clone follows its SOURCE (avDelivery, since 30.09) — a
                      // Purchase source clones as Purchase on its own AV pixel (lib/av-delivery AV_PIXELS), a link-click source
                      // as link clicks with no pixel (the run route sets it, a row's pick is ignored).
                      <LockedRow label="Pixel" value="AV pixel · as the source" />
                    ) : isTargetAccount ? (
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
                {vcMode
                  ? isTargetAccount
                    ? "Rows on the defaults are re-built in the picked account: every video / image of the source is moved there first (adds a “Migrating media” step). The ad link stays the source’s. Any row can set its own Destination."
                    : "Rows on the defaults are created in their source campaign’s own cabinet (its videos / images live there). Pick an account to build the batch elsewhere, a fanpage to change the page; any row can set its own Destination."
                  : avMode
                  ? accountMissing
                    ? "Pick the destination explicitly: the fanpage and the account. “From each source” keeps every clone in its source campaign’s own account; a concrete account re-builds the whole batch there. AV clones follow their source: Purchase on the source’s own AV pixel, or link clicks. Any row can override these with its own Destination."
                    : isTargetAccount
                      ? "Rows on the defaults are re-built in the picked account: the source video/image is re-uploaded there (adds a “Migrating media” step). AV clones follow their source: Purchase on the source’s own AV pixel, or link clicks."
                      : "Rows on the defaults are created in their source campaign’s own ad account (its video/image lives there). AV clones follow their source: Purchase on the source’s own AV pixel, or link clicks. Only the fanpage applies to them."
                  : accountMissing
                    ? "Pick the destination explicitly: the fanpage and the account. “From each source” keeps every clone in its source campaign’s own account; a concrete account re-builds the whole batch there. Any row can override these with its own Destination."
                    : isTargetAccount
                      ? "Rows on the defaults are re-built in the picked account: the source video/image is re-uploaded there (adds a “Migrating media” step) and conversion clones optimize for the picked pixel."
                      : "Rows on the defaults are created in their source campaign’s own ad account (its video/image lives there), with the source’s pixel. Only the fanpage applies to them."}
              </p>
            </div>

            {vcMode ? (
              <>
                {/* VC only: what every clone optimizes. "As each source" = a faithful copy (a Lead
                    source stays Lead on its own pixel, a link-click source stays clicks); Lead / Purchase
                    re-point the whole batch (the 05.11 ask — Purchase campaigns re-born as Lead). */}
                <Field
                  label="Optimization"
                  hint={
                    vcEvent === "SOURCE"
                      ? "Each clone optimizes what its source does, on the source’s own pixel."
                      : vcEvent === "LEAD"
                        ? `Every clone becomes a Leads campaign optimizing LEAD on the ${vcPixelName(vcCloneDelivery("LEAD").pixel)}.`
                        : `Every clone becomes a Sales campaign optimizing PURCHASE on the ${vcPixelName(vcCloneDelivery("PURCHASE").pixel)}.`
                  }
                >
                  <Select
                    value={vcEvent}
                    onChange={(e) => changeVcEvent(isVcCloneEvent(e.target.value) ? e.target.value : "SOURCE")}
                    options={VC_CLONE_EVENTS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Field>
                <Field label="User OS">
                  <Select
                    value={vcUserOs}
                    onChange={(e) => {
                      setVcUserOs(e.target.value === "all" || e.target.value === "android" ? e.target.value : "");
                      setPreviewed(false);
                    }}
                    options={VC_OS_OPTIONS}
                  />
                </Field>
              </>
            ) : (
              <Field label="User OS">
                <Select
                  value={settings.userOs}
                  onChange={(e) => patchSettings({ userOs: e.target.value as CloneSettings["userOs"] })}
                  options={OS_OPTIONS}
                />
              </Field>
            )}

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

              {/* AV keys stub (owner ask 28.09): the pool preview answers poolMax 0 until the
                  owner uploads AV keys to ActiveView. Clones would be refused server-side, so
                  Duplicate is blocked with the reason. Shown as soon as it's known, not only after
                  a preview — the buyer shouldn't build a batch that can't fire. */}
              {avKeysUnregistered ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  No AV keys are registered in ActiveView yet — duplicating is locked. An owner
                  uploads the key pool on the <span className="font-semibold">AV keys</span> page
                  (UTM Campaign Values) and sets <span className="font-mono">AV_KEYS_REGISTERED</span>.
                </div>
              ) : null}

              {previewed && rows.length > 0 ? (
                <button
                  type="button"
                  onClick={duplicate}
                  disabled={
                    destinationMissing ||
                    acctBlocked ||
                    fankaOver ||
                    bidMissingCount > 0 ||
                    signerMissing ||
                    limits.reloadRequired ||
                    avKeysUnregistered ||
                    vcBlocked
                  }
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
                      <span className="font-semibold">{x.need}</span> clones fit its {windowMinutes(limits)}-min window
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

              {previewed && rows.length > 0 && toolAcctBlockedRows.length > 0 ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  TOOL launches only into cabinets a live session sees —{" "}
                  <span className="font-semibold">{toolAcctBlockedRows.length}</span> row
                  {toolAcctBlockedRows.length === 1 ? " targets" : "s target"} an account that isn&apos;t
                  TOOL-visible ({toolReady.accounts.size} available). Pick a TOOL account
                  {toolReady.accounts.size === 0 ? " (none yet — an owner adds a TOOL session)" : ""} — “From
                  each source” isn&apos;t available on TOOL.
                </div>
              ) : null}

              {/* VC: rows that cannot be cloned as they stand (the reason is on the row itself). */}
              {previewed && rows.length > 0 && vcBlocked ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Duplicate is locked — <span className="font-semibold">{vcBlockedRows.length}</span> row
                  {vcBlockedRows.length === 1 ? " can’t" : "s can’t"} be cloned as {vcBlockedRows.length === 1 ? "it stands" : "they stand"} (the amber note on the row says why). Fix
                  {vcBlockedRows.length === 1 ? " it" : " them"} or remove {vcBlockedRows.length === 1 ? "it" : "them"} from the batch.
                </div>
              ) : null}

              {previewed && rows.length > 0 && signerMissing ? (
                <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11.5px] leading-relaxed text-warn">
                  Duplicate is locked — no clone token is assigned for this partner (an owner
                  assigns one under <span className="font-semibold">FB tokens</span>).
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
              {/* Clones are handed to the server from this tab (no media to upload — the source is
                  reused by id), so the hand-off is a brief beat; the notice shows only while it is in
                  flight (inFlight = useHandoffPending) and clears the moment the server accepts them. */}
              <UploadingNotice n={cloneTm.counts.inFlight} compact />
            </div>
          </section>

          {/* ---- Selected campaigns (right) ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            {/* VC: the batch is ticked out of the live campaigns of the VC cabinets (no stats tool hands
                VC ids over) — a tick adds a row below, an untick removes it. */}
            {vcMode ? (
              <VcSourcePicker
                list={vcList}
                loading={vcListLoading}
                error={vcListError}
                picked={new Set(rows.map((r) => r.source.campaignId))}
                onToggle={(src, on) => (on ? addVcSources([src]) : removeVcSources([src.campaignId]))}
                onAdd={addVcSources}
                onRemove={removeVcSources}
                onLoad={loadVcList}
                owner={Boolean(user?.owner)}
              />
            ) : null}
            <SectionHeading
              right={
                <span className="flex items-center gap-2">
                  {/* Autofill (VC, owner ask 17.11): one form sets targeting · strategy + bid · budget ·
                      copies on every row at once — the HS board's batch tool on this board's rows. */}
                  {vcMode ? (
                    <button
                      type="button"
                      onClick={() => setAutofillOpen(true)}
                      disabled={rows.length === 0}
                      title={
                        rows.length === 0
                          ? "Tick campaigns first — the autofill sets geo · strategy + bid · budget · copies on every row at once"
                          : "Set geo · strategy + bid · budget · copies on every row at once"
                      }
                      className="flex h-7 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:border-accent/60 hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <SparklesIcon className="h-3.5 w-3.5" />
                      Autofill{rows.length > 0 ? ` ${rows.length} row${rows.length === 1 ? "" : "s"}` : ""}
                    </button>
                  ) : null}
                  <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                    {rows.length}
                  </span>
                </span>
              }
            >
              Selected Campaigns
            </SectionHeading>
            {vcMode && autofillDone ? (
              <div
                role="status"
                className="animate-pop-in flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[11.5px] leading-snug text-[#9db8ff]"
              >
                <SparklesIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  {autofillDone.changed > 0
                    ? `Autofill set ${autofillDone.note} on ${autofillDone.changed} row${autofillDone.changed === 1 ? "" : "s"}.`
                    : "Autofill changed nothing — every row already had these values."}
                </span>
                <button
                  type="button"
                  onClick={undoLastAutofill}
                  disabled={autofillDone.changed === 0}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-accent/40 bg-surface px-2 text-[11px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <UndoIcon className="h-3 w-3" />
                  Undo
                </button>
                <button
                  type="button"
                  onClick={() => setAutofillDone(null)}
                  aria-label="Dismiss"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ) : null}

            {loadWarn && !loading && !error ? (
              <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                {loadWarn}
              </div>
            ) : null}
            {loading ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-line2 text-[13px] text-faint">
                {signerMissing ? "Waiting for the signer…" : "Loading campaigns from Facebook…"}
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
                  {/* The sample rows are MO-shaped mocks — no use on VC, whose rows come off its own list. */}
                  {vcMode ? null : (
                    <button
                      type="button"
                      onClick={loadSample}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-2 text-[12.5px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                      Load sample
                    </button>
                  )}
                </div>
              </div>
            ) : rows.length === 0 && vcMode ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line2 px-6 py-12 text-center">
                <TargetIcon className="h-7 w-7 text-faint" />
                <div>
                  <p className="text-[14px] font-medium text-ink">Nothing in the batch yet</p>
                  <p className="mx-auto mt-1 max-w-[460px] text-[12px] text-dim">
                    Tick campaigns in <span className="text-ink">Active VC campaigns</span> above — each one becomes a row here
                    with its own destination, targeting, bid, budget and copies.
                  </p>
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line2 px-6 py-14 text-center">
                <TargetIcon className="h-7 w-7 text-faint" />
                <div>
                  <p className="text-[14px] font-medium text-ink">No campaigns received</p>
                  <p className="mt-1 text-[12px] text-dim">
                    {avMode ? (
                      <>
                        Open this page from <span className="text-ink">Clone</span> on a finished row in{" "}
                        <span className="text-ink">AV Tasks</span> — the campaign to duplicate arrives by id in the link.
                      </>
                    ) : (
                      <>
                        Open this page from the <span className="text-ink">Clone</span> button in the stats tool —
                        the campaigns to duplicate arrive by id in the link.
                      </>
                    )}
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
                  const vcIssue = vcIssues.get(r.id) ?? null;
                  // VC: the dataset an empty pixel pick resolves to for THIS row (its source's own under
                  // "as each source"; "" for a click clone, which promotes none).
                  const vcAutoPixel = vcMode && r.source.vc ? vcCloneDelivery(vcEvent, r.source.vc).pixel : "";
                  return (
                    <div
                      key={r.id}
                      data-campaign={r.source.campaignId}
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
                          title={`${(onTool ? `${r.namePrefix}${TOOL_MARK}` : r.namePrefix).trim()} — fixed, not editable`}
                        >
                          <LockIcon className="h-2.5 w-2.5 shrink-0" />
                          {/* TOOL rail (owner ask 28.09): the "GCL TOOL - " marker rides after the
                              clone prefix (server re-ensures it via toolEnsureMark). */}
                          {(onTool ? `${r.namePrefix}${TOOL_MARK}` : r.namePrefix).trim()}
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
                              modal, the rest is a passive tag. VC has no redirect — its tags are the
                              source's own cabinet and what the clone will optimize (the batch
                              Optimization against this source). */}
                          {vcMode && r.source.vc ? (
                            <>
                              <span
                                className="inline-flex max-w-full items-center truncate rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint"
                                title={`The source's cabinet · act_${r.source.vc.accountId}`}
                              >
                                {r.source.vc.accountName || `act_${r.source.vc.accountId}`}
                              </span>
                              <span
                                className={
                                  "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] " +
                                  (vcEvent === "SOURCE" ? "border-line bg-surface2 text-faint" : "border-accent/40 bg-accent/10 text-[#9db8ff]")
                                }
                                title={
                                  vcEvent === "SOURCE"
                                    ? "The clone optimizes what its source does (Optimization: as each source)"
                                    : "The batch Optimization re-points this clone"
                                }
                              >
                                {vcEventWord(vcEvent, r.source.vc)}
                              </span>
                            </>
                          ) : r.redirectType === "HIGH ADX" ? (
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
                        {/* VC: why this row can't be cloned as it stands (the run would refuse it the same
                            way) — shown on the row, before anything is queued. */}
                        {vcIssue ? (
                          <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-warn" role="alert">
                            <AlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="min-w-0 break-words">{vcIssue}</span>
                          </p>
                        ) : null}
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
                          account's 5/15-min load. */}
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
                              options={fanpageOptions}
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
                              options={accountPickerOptions}
                              placeholder="Account"
                              emptyHint={
                                adAccounts
                                  ? onTool
                                    ? "No TOOL-visible accounts for this partner"
                                    : "No accounts on the token"
                                  : "Loading accounts…"
                              }
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
                            vcMode ? (
                              // VC: a pixel pick only for a concrete account (a pixel belongs to its
                              // cabinet's list); empty = the batch Optimization's own dataset for this row.
                              target ? (
                                <SearchSelect
                                  size="sm"
                                  value={d.pixelId}
                                  onChange={(v) => patchRowDest(r, { pixelId: v })}
                                  options={targetPixelsFor(d.accountId).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                                  placeholder={vcAutoPixel ? `Pixel · ${vcPixelName(vcAutoPixel)}` : "Pixel · none (clicks)"}
                                  emptyHint={adAccounts ? "No pixels on this account" : "Loading pixels…"}
                                  warn={pxMissing}
                                  accent={Boolean(r.dest?.pixelId)}
                                  ariaLabel={`Pixel for row ${i + 1}`}
                                />
                              ) : (
                                <span
                                  className="flex h-8 items-center gap-1.5 truncate rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint"
                                  title="The pixel follows the batch Optimization — pick a concrete account to choose another"
                                >
                                  <LockIcon className="h-3 w-3 shrink-0" />
                                  {vcAutoPixel ? `Pixel · ${vcPixelName(vcAutoPixel)}` : "Pixel · none (clicks)"}
                                </span>
                              )
                            ) : avMode ? (
                              // Nothing to pick per row: the clone follows its SOURCE (avDelivery) —
                              // Purchase on the source’s own AV pixel, or link clicks with no pixel.
                              <span
                                className="flex h-8 items-center gap-1.5 rounded-md border border-dashed border-line px-2 font-mono text-[11px] text-faint"
                                title="AV clones follow their source: Purchase on the source’s own AV pixel (the AV site pixel when the source ran on another), or link clicks with no pixel"
                              >
                                <LockIcon className="h-3 w-3 shrink-0" />
                                AV pixel · as the source
                              </span>
                            ) : target ? (
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
                                // Owner rule 09-11: an untouched default budget follows the strategy
                                // ($50 on min ROAS, else the source's own); a typed budget stays.
                                const budget = moneyCentsLabel(
                                  budgetOnStrategyChange(r.bidStrategy, bidStrategy, r.budget, r.source.originalBudget),
                                );
                                patchRow(r.id, { bidStrategy, roasGoal, budget });
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
                              {bidStrategyOptions.map((o) => (
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
                    const vb = r ? vcBindsOf(r) : null;
                    return (
                    <div
                      key={p.key}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface2/40 px-3 py-2"
                    >
                      <span
                        className="min-w-0 flex-[1_1_220px] truncate text-[12px] text-ink"
                        title={onTool ? toolEnsureMark(p.name) : p.name}
                      >
                        {/* On TOOL the marker rides after the clone prefix (toolEnsureMark, idempotent). */}
                        {onTool ? toolEnsureMark(p.name) : p.name}
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
                      {vb ? (
                        // VC: the real landing place — the cabinet (the source's own or the picked one),
                        // the page and the pixel the clone optimizes on.
                        <span
                          className={"shrink-0 truncate text-[11px] " + (r?.dest ? "text-[#9db8ff]" : "text-faint")}
                          title={`${accountLabel(vb.accountId)}${vb.cross ? " (media is moved there)" : " (the source's own cabinet)"} · fanpage ${fanpageLabel(vb.pageId)}${vb.pixelId ? ` · pixel ${vcPixelName(vb.pixelId)}` : " · no pixel (clicks)"}`}
                        >
                          → {accountLabel(vb.accountId)} · {fanpageLabel(vb.pageId)}
                          {vb.pixelId ? ` · ${vcPixelName(vb.pixelId)}` : ""}
                          {r?.dest ? " (own)" : ""}
                        </span>
                      ) : d ? (
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
          avMode={avMode}
          vcMode={vcMode}
          vcAutoPixelLabel={vcAutoPixelLabel}
          fanpages={fanpages}
          adAccounts={adAccounts}
          limits={limits}
          onTool={onTool}
          toolAccounts={onTool ? toolReady.accounts : null}
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
      {vcMode && autofillOpen ? (
        <HsAutofillModal
          rows={rows.map((r) => ({
            id: r.id,
            label: fullCloneName(r),
            takes: true,
            countries: r.countries,
            locales: r.locales,
            budget: r.budget,
            bidStrategy: r.bidStrategy,
            bid: r.roasGoal,
            copies: r.copies != null ? String(r.copies) : "",
          }))}
          // This board's languages are the catalog's NAMES (the Targeting editor's own list).
          localeOptions={LOCALES.map((l) => ({ value: l, label: l }))}
          strategyOptions={bidStrategyOptions}
          geoLocked={null}
          maxCopies={MAX_CLONE_COPIES}
          defaultCopies={settings.copies}
          onClose={() => setAutofillOpen(false)}
          onApply={applyAutofill}
        />
      ) : null}
    </>
  );
}
