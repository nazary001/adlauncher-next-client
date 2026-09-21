"use client";

// One fresh Demand Gen campaign card for the Google launcher — rebuilt 2026-09-14 to mirror LION's
// own "Demand Generation Launcher" UI field-for-field (owner ask): Customer · Pixel · Budget ·
// Bidding (the 5 launcher strategies) / Countries (World·LATAM·Anglo·Franco presets) · Language
// (52) · conditional bid value / Landing URL + link preview / a READ-ONLY name prefix (LION builds
// the head) + a custom tail + MOSH / one-or-more repeatable AD GROUPS (pipe-separated Headlines ·
// Long headlines · Descriptions, CTA, YouTube URLs one-per-line OR uploaded videos + a channel id,
// Logo URL/upload) + a STRUCTURE switch over them (owner ask 21.09): the groups launch as typed,
// videos together ("1-1-5"), or every video in its own ad group with the same copy ("1-5-5") —
// fanned out by googleLaunchWire. Copies are made by the board's Autofill (one shot = one card), not a per-card
// stepper. Every gate is delegated to the SAME validator the server runs (googleLaunchWire) so the
// card's readiness dot can never disagree with LION's answer. Files stay session-local object URLs
// here and ride Vercel Blob only at launch (per ad group).

import { useState } from "react";
import { Dropzone } from "./dropzone";
import { AutoTextarea, Select } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { CheckIcon, ChevronsIcon, CopyIcon, GlobeIcon, LockIcon, PlusIcon, TrashIcon, UploadIcon, XIcon } from "./icons";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoneyCents, type FileItem } from "@/lib/types";
import {
  GOOGLE_BUDGET_MAX,
  GOOGLE_CPA_MAX,
  GOOGLE_CTAS,
  GOOGLE_DESCRIPTION_MAX,
  GOOGLE_GEO_PRESETS,
  GOOGLE_HEADLINE_MAX,
  GOOGLE_LANGUAGES_FULL,
  GOOGLE_LAUNCH_BID_STRATEGIES,
  GOOGLE_LONG_HEADLINE_MAX,
  GOOGLE_ROAS_MAX,
  GOOGLE_TEXT_ASSETS_MAX,
  GOOGLE_VIDEOS_MAX,
  googleAdGroupsAtLaunch,
  googleBidKind,
  googleLaunchWire,
  googleLandingBase,
  googleLandingSegments,
  googleLogoDimsIssue,
  googleLogoUrlNote,
  googleNameHeadPreview,
  googleNamePreview,
  googleNameSuffix,
  googleStructureLabel,
  splitLines,
  splitPipes,
  todaySaoPauloDotDDMM,
  type GoogleBidKind,
  type GoogleLaunchAdIn,
  type GoogleLaunchShotIn,
} from "@/lib/google-bid";
import type { SessionUser } from "./user-menu";

/** Max copies the board's Autofill fans out from card 1 (LION's launcher: 1–20). */
export const AUTOFILL_MAX_COPIES = 20;

/** Currency glyph — the Google book is BRL/USD/EUR; anything else shows the bare code. */
const CUR_SYMBOL: Record<string, string> = { BRL: "R$", USD: "$", EUR: "€" };
export const curSymbol = (code: string): string => CUR_SYMBOL[code] || code || "$";

/** One ad group inside a card (LION's launcher repeats these). Copy rides as ONE pipe-separated
 *  string per LION's UI ("H1 | H2 | H3"); YouTube links ride as one textarea (one URL per line).
 *  Exactly one video source per group (YouTube links OR uploaded files). */
export type AdGroup = {
  id: string;
  headlines: string;
  longHeadlines: string;
  descriptions: string;
  callToAction: string;
  videoMode: "youtube" | "files";
  youtubeText: string;
  videoFiles: FileItem[];
  /** YouTube channel id for uploaded videos ("" = Unlisted, Google-managed); ignored in link mode. */
  channelId: string;
  logoMode: "url" | "file";
  logoUrl: string;
  logoFiles: FileItem[];
  /** Pixel size of the uploaded logo (read client-side after the drop) — Google wants 1:1, ≥128 px. */
  logoDims: { w: number; h: number } | null;
};

/** One fresh-launch card. Money is HUMAN ("30,00"); assets are session object URLs until launch. */
export type LaunchCard = {
  id: string;
  collapsed: boolean;
  // name
  suffix: string;
  // row 1
  customer: string;
  pixel: string;
  budget: string;
  bidStrategy: string;
  bid: string;
  // row 2
  geo: string[];
  language: string;
  // row 3
  landingUrl: string;
  // name row
  mosh: boolean;
  // ad groups (≥1)
  adGroups: AdGroup[];
  /** Structure switch (owner ask 21.09): false = the ad groups launch as typed, all their videos
   *  together ("1-1-5"); true = every video launches in its OWN ad group with the same copy/CTA/
   *  logo ("1-5-5"). The card keeps its typed groups either way — the fan-out is on the wire. */
  adGroupPerVideo: boolean;
  // launch lifecycle (per card)
  state: "idle" | "uploading" | "sending" | "ok" | "error";
  msg?: string;
  progress?: string;
};

// Client-side sequences for nodes born AFTER mount (New campaign / Duplicate / +Ad Group). The
// FIRST card is created inside the board's useState initializer, which runs on the server AND the
// client — a Date.now()/sequence id there differed between the two renders and tripped React's
// hydration check (live 09-14), so the first card AND its first ad group get FIXED ids.
let cardSeq = 1;
let agSeq = 1;
export const FIRST_CARD_ID = "gl-1";

export function freshAdGroup(id?: string): AdGroup {
  return {
    id: id ?? `ag-${++agSeq}`,
    headlines: "",
    longHeadlines: "",
    descriptions: "",
    callToAction: "",
    videoMode: "youtube",
    youtubeText: "",
    videoFiles: [],
    channelId: "",
    logoMode: "url",
    logoUrl: "",
    logoFiles: [],
    logoDims: null,
  };
}

export function freshLaunchCard(id?: string): LaunchCard {
  const cardId = id ?? `gl-${++cardSeq}`;
  return {
    id: cardId,
    collapsed: false,
    // Empty: the team suffix already carries the buyer's username ("| DD.MM <user>") — a default
    // tail equal to the username printed it twice.
    suffix: "",
    customer: "",
    pixel: "",
    budget: "30,00",
    bidStrategy: "target_cpa",
    bid: "",
    // LION's launcher defaults the geo chip to World (WW = worldwide, dropped from the wire).
    geo: ["WW"],
    language: "",
    landingUrl: "",
    mosh: false,
    // A deterministic first-ad-group id when the card id is deterministic (the SSR first card).
    adGroups: [freshAdGroup(id ? `${cardId}-ag1` : undefined)],
    adGroupPerVideo: false,
    state: "idle",
  };
}

/** Deep-ish clone of ONE ad group — fresh arrays/objects so a later edit can't bleed into a
 *  sibling (blob URLs stay shared by design, exactly like the FB cloneCardFrom rule). */
export function cloneAdGroup(src: AdGroup): AdGroup {
  return {
    ...src,
    id: `ag-${++agSeq}`,
    videoFiles: src.videoFiles.map((f) => ({ ...f })),
    logoFiles: src.logoFiles.map((f) => ({ ...f })),
    logoDims: src.logoDims,
  };
}

/** Deep-ish clone for the duplicate button — every ad group cloned so nothing is shared by ref. */
export function cloneLaunchCard(src: LaunchCard): LaunchCard {
  return {
    ...src,
    id: `gl-${++cardSeq}`,
    collapsed: false,
    geo: [...src.geo],
    adGroups: src.adGroups.map(cloneAdGroup),
    state: "idle",
    msg: undefined,
    progress: undefined,
  };
}

/** Videos each typed ad group carries (links or files, whichever source the group is on). */
export const launchCardVideoCounts = (card: LaunchCard): number[] =>
  card.adGroups.map((ag) => (ag.videoMode === "youtube" ? splitLines(ag.youtubeText).length : ag.videoFiles.length));

/** Ad groups the card LAUNCHES with — the typed count, or one per video on the per-video structure. */
export const launchCardAdGroupCount = (card: LaunchCard): number => googleAdGroupsAtLaunch(launchCardVideoCounts(card), card.adGroupPerVideo);

/** Per-ad-group uploaded asset URLs (resolved at launch). Parallel to card.adGroups. */
export type AdGroupUpload = { logoUrl?: string; videoUrls?: string[] };

/** One ad group → the wire ad. `upload` present = the real hosted URLs; absent = the DRY-RUN with
 *  placeholder https URLs so the SAME validator gates the card before anything is uploaded. */
function adGroupWire(ag: AdGroup, upload?: AdGroupUpload): GoogleLaunchAdIn {
  const youtube = ag.videoMode === "youtube";
  const youtubeUrls = youtube ? splitLines(ag.youtubeText) : [];
  const videoUrls = youtube ? [] : upload?.videoUrls ?? ag.videoFiles.map(() => "https://pending.local/x.mp4");
  const logoUrl =
    upload?.logoUrl ?? (ag.logoMode === "url" ? ag.logoUrl.trim() : ag.logoFiles.length ? "https://pending.local/logo.jpg" : "");
  const channelId = !youtube ? ag.channelId.trim() : "";
  return {
    headlines: splitPipes(ag.headlines),
    longHeadlines: splitPipes(ag.longHeadlines),
    descriptions: splitPipes(ag.descriptions),
    ...(ag.callToAction ? { callToAction: ag.callToAction } : {}),
    logoUrl,
    youtubeUrls,
    videoUrls,
    ...(channelId ? { channelId } : {}),
  };
}

/** Build the wire shot (real at launch when `uploaded` is given, otherwise a DRY-RUN). One shot =
 *  one card; every ad group becomes one wire ad. */
export function buildLaunchShot(
  card: LaunchCard,
  ctx: { currency?: string; accountName?: string; uploaded?: AdGroupUpload[] },
): GoogleLaunchShotIn {
  return {
    customer: card.customer || "0",
    budget: card.budget,
    bidStrategy: card.bidStrategy,
    bid: card.bid.trim(),
    ...(card.pixel ? { pixel: card.pixel } : {}),
    suffix: card.suffix.trim(),
    landingUrl: card.landingUrl.trim(),
    geo: card.geo,
    ...(card.language ? { language: card.language } : {}),
    ...(card.mosh ? { mosh: true } : {}),
    ads: card.adGroups.map((ag, i) => adGroupWire(ag, ctx.uploaded?.[i])),
    ...(card.adGroupPerVideo ? { adGroupPerVideo: true } : {}),
    ...(ctx.currency ? { currency: ctx.currency } : {}),
    label: `Google launch · ${ctx.accountName || "account"}`,
  };
}

/** The card's blocking refusal from the shared validator (null when the creative wire is valid).
 *  Account + pixel readiness are gated separately (they need the customers catalog). An uploaded
 *  logo of the wrong shape is refused BEFORE any upload; the ad group is named when there is >1. */
export function launchCardRefusal(card: LaunchCard): string | null {
  const many = card.adGroups.length > 1;
  for (let i = 0; i < card.adGroups.length; i++) {
    const ag = card.adGroups[i];
    if (ag.logoMode !== "file") continue;
    const issue = googleLogoDimsIssue(ag.logoDims);
    if (issue) return many ? `Ad group ${i + 1}: ${issue}` : issue;
  }
  const built = googleLaunchWire(buildLaunchShot(card, {}), { customerId: card.customer || "0000000000", nameSuffix: "" });
  return "refusal" in built ? built.refusal : null;
}

/** Signature of a card's launch-relevant content — the wave id is cached per this so a retry after
 *  a lost answer re-sends the same id (the server claim makes it a no-op). */
export function launchCardSignature(card: LaunchCard): string {
  return JSON.stringify({
    c: card.customer,
    px: card.pixel,
    b: card.budget,
    bs: card.bidStrategy,
    bd: card.bid,
    s: card.suffix,
    l: card.landingUrl,
    g: card.geo,
    lg: card.language,
    m: card.mosh,
    pv: card.adGroupPerVideo,
    ag: card.adGroups.map((a) => ({
      h: a.headlines,
      lh: a.longHeadlines,
      d: a.descriptions,
      cta: a.callToAction,
      vm: a.videoMode,
      yt: a.youtubeText,
      vf: a.videoFiles.map((f) => f.id),
      ch: a.channelId,
      lm: a.logoMode,
      lu: a.logoUrl,
      lf: a.logoFiles.map((f) => f.id),
    })),
  });
}

// ---------- shared classes ----------

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";

const COUNTRY_OPTIONS = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));
const CTA_OPTIONS = GOOGLE_CTAS.map((c) => ({ value: c.value, label: c.label }));
const LANG_OPTIONS: RichOption[] = GOOGLE_LANGUAGES_FULL.map((l) => ({ value: l.value, label: l.label, meta: l.value || undefined }));
const STRATEGY_OPTIONS = GOOGLE_LAUNCH_BID_STRATEGIES.map((s) => ({ value: s.value, label: s.label }));

/** LION's bidding-strategy explainer, one sentence each — the native-title tooltip on the ⓘ. */
const BIDDING_TIP =
  "Maximize Conversions — the most conversions your budget can get (no target). " +
  "Target CPA — aim for this average cost per conversion. " +
  "Target ROAS — aim for this return (percent of spend). " +
  "Maximize Conversion Value — the most conversion value (no target). " +
  "Manual CPC — you set the max cost-per-click yourself.";

/** A tiny ⓘ that shows a wrapping native tooltip (the .tip bubble is nowrap — too narrow for a
 *  paragraph). Purely decorative; the label beside it carries the meaning. */
function InfoDot({ tip }: { tip: string }) {
  return (
    <span
      title={tip}
      role="img"
      aria-label={tip}
      className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-line2 text-[8.5px] font-bold text-faint"
    >
      i
    </span>
  );
}

/** Segmented two-way toggle (video source, logo source). */
function Seg({ options, value, onChange }: { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="inline-grid grid-flow-col overflow-hidden rounded-lg border border-line bg-surface2/50 p-0.5">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={
              "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " +
              (on ? "bg-accent/20 text-[#9db8ff]" : "text-dim hover:text-ink")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** One pipe-separated copy field ("H1 | H2 | H3") with a live segment count and over-limit warn —
 *  LION's launcher takes headlines/long headlines/descriptions this way. */
function PipeField({
  label,
  value,
  onChange,
  limit,
  placeholder,
  tip,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  limit: number;
  placeholder: string;
  tip: string;
}) {
  const segs = splitPipes(value);
  const over = segs.find((s) => s.length > limit);
  const tooMany = segs.length > GOOGLE_TEXT_ASSETS_MAX;
  const bad = Boolean(over) || tooMany;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className={micro}>{label}</span>
          <InfoDot tip={tip} />
        </span>
        <span className={"font-mono text-[10px] tabular-nums " + (bad ? "text-warn" : "text-faint")}>
          {segs.length}/{GOOGLE_TEXT_ASSETS_MAX}
        </span>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        title={tip}
        className={inp + (bad ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")}
      />
      {over ? (
        <p className="text-[10px] leading-snug text-warn">&ldquo;{over.slice(0, 28)}…&rdquo; is over {limit} characters</p>
      ) : tooMany ? (
        <p className="text-[10px] leading-snug text-warn">At most {GOOGLE_TEXT_ASSETS_MAX} — drop one.</p>
      ) : null}
    </div>
  );
}

// ---------- the card ----------

export function GoogleLaunchCard({
  card,
  index,
  user,
  customerOptions,
  pixelOptions,
  currency,
  effPixel,
  acr = "",
  accountName,
  pixelNeeded,
  noPixel,
  refusal,
  ready,
  customersLoading,
  highlight,
  onPatch,
  onPatchAdGroup,
  onDuplicate,
  onRemove,
  onToggleCollapse,
  onBulk,
}: {
  card: LaunchCard;
  index: number;
  user?: SessionUser;
  customerOptions: RichOption[];
  pixelOptions: RichOption[];
  currency: string;
  effPixel: string;
  /** LION user's ACR (lower-cased) — the `mb=` / utm_campaign prefix in the link preview. */
  acr?: string;
  /** Target account name — the read-only campaign-name prefix's `<ACCOUNT>` segment. */
  accountName: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  refusal: string | null;
  ready: boolean;
  customersLoading: boolean;
  highlight?: boolean;
  onPatch: (id: string, p: Partial<LaunchCard>) => void;
  onPatchAdGroup: (cardId: string, agId: string, p: Partial<AdGroup>) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onBulk: (id: string) => void;
}) {
  const patch = (p: Partial<LaunchCard>) => onPatch(card.id, p);
  const kind: GoogleBidKind | "unknown" = googleBidKind(card.bidStrategy);
  const cur = currency || "$";

  const landingSegments = googleLandingSegments(card.landingUrl, { acr, pixel: effPixel || undefined });
  const landingStripped = googleLandingBase(card.landingUrl)?.strippedQuery ?? false;
  const [landingCopied, setLandingCopied] = useState(false);
  const copyLanding = () => {
    const base = googleLandingBase(card.landingUrl)?.base;
    if (!base) return;
    void navigator.clipboard?.writeText(base).then(() => {
      setLandingCopied(true);
      setTimeout(() => setLandingCopied(false), 1400);
    });
  };

  // The read-only name prefix LION shows, and the whole final line LION will build around our tail.
  const headPreview = googleNameHeadPreview({ accountName, acr, geo: card.geo, landing: card.landingUrl });
  const bareSuffix = googleNameSuffix({ mode: "launch", user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: card.suffix });
  const fullNamePreview = googleNamePreview({ mode: "launch", head: headPreview, suffix: bareSuffix });

  const changeStrategy = (val: string) => {
    const nextKind = googleBidKind(val);
    patch({ bidStrategy: val, bid: nextKind === kind ? card.bid : "" });
  };

  // Geo preset buttons (World / LATAM / Anglo / Franco): a preset is "active" when the chips are
  // exactly its set (order-insensitive).
  const geoSet = new Set(card.geo);
  const presetActive = (codes: string[]) => codes.length === card.geo.length && codes.every((c) => geoSet.has(c));

  const stateTone =
    card.state === "error"
      ? "text-danger"
      : card.state === "ok"
        ? "text-launch2"
        : card.state === "uploading" || card.state === "sending"
          ? "text-[#9db8ff]"
          : "text-faint";

  // ---- ad group operations -------------------------------------------------------------------
  const addAdGroup = () => patch({ adGroups: [...card.adGroups, freshAdGroup()] });
  const duplicateAdGroup = (agId: string) => {
    const i = card.adGroups.findIndex((a) => a.id === agId);
    if (i === -1) return;
    patch({ adGroups: [...card.adGroups.slice(0, i + 1), cloneAdGroup(card.adGroups[i]), ...card.adGroups.slice(i + 1)] });
  };
  const removeAdGroup = (agId: string) =>
    card.adGroups.length > 1 ? patch({ adGroups: card.adGroups.filter((a) => a.id !== agId) }) : undefined;
  const clearAgUrls = (agId: string) => onPatchAdGroup(card.id, agId, { youtubeText: "", videoFiles: [] });
  const clearAgAll = (agId: string) =>
    onPatchAdGroup(card.id, agId, {
      headlines: "",
      longHeadlines: "",
      descriptions: "",
      callToAction: "",
      youtubeText: "",
      videoFiles: [],
      channelId: "",
      logoUrl: "",
      logoFiles: [],
      logoDims: null,
    });
  const clearAllUrls = () => patch({ adGroups: card.adGroups.map((a) => ({ ...a, youtubeText: "", videoFiles: [] })) });
  const removeAllAdGroups = () => patch({ adGroups: [freshAdGroup()] });

  // ---- structure: "1-1-5" (videos together, as typed) vs "1-5-5" (an ad group per video) -----
  const videoCounts = launchCardVideoCounts(card);
  const agAtLaunch = googleAdGroupsAtLaunch(videoCounts, card.adGroupPerVideo);

  return (
    <div
      id={`glcard-${card.id}`}
      className={
        "animate-row-in overflow-hidden rounded-2xl border bg-surface transition-shadow " +
        (highlight ? "border-accent/60 shadow-[0_0_0_2px_rgba(122,150,255,0.28)]" : "border-line")
      }
    >
      {/* card header */}
      <div className="flex items-center gap-2.5 border-b border-line/70 bg-surface2/30 px-3.5 py-2.5">
        <span className="font-mono text-[12px] text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className={"h-2 w-2 shrink-0 rounded-full " + (ready ? "bg-launch2" : "bg-warn")} title={ready ? "Ready" : "Not ready"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink">Demand Gen campaign</p>
          <p className="truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
            {fullNamePreview}
          </p>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">
          {agAtLaunch} AG
        </span>
        <button
          type="button"
          onClick={() => onToggleCollapse(card.id)}
          aria-label={card.collapsed ? "Expand" : "Collapse"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ChevronsIcon className={"h-4 w-4 transition-transform " + (card.collapsed ? "rotate-180" : "")} />
        </button>
        <button
          type="button"
          onClick={() => onDuplicate(card.id)}
          aria-label="Duplicate campaign"
          title="Duplicate this campaign"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CopyIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(card.id)}
          aria-label="Remove campaign"
          title="Remove from the wave"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {card.collapsed ? (
        <div className="flex items-center gap-2 px-3.5 py-2.5 text-[11px] text-faint">
          <span className="truncate">
            {customerOptions.find((o) => o.value === card.customer)?.label ?? "no account"} · {cur} · {agAtLaunch} ad group
            {agAtLaunch === 1 ? "" : "s"}
            {card.adGroupPerVideo ? " (one per video)" : ""}
          </span>
          {card.state !== "idle" ? <span className={"ml-auto truncate font-mono text-[10.5px] " + stateTone}>{card.msg ?? "—"}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          {/* ---- ROW 1 — Customer · Pixel · Budget · Bidding ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Customer</span>
              <SearchSelect
                value={card.customer}
                onChange={(v) => patch({ customer: v, pixel: "" })}
                options={customerOptions}
                placeholder="Search account"
                metaWhenClosed
                warn={!card.customer}
                emptyHint={customersLoading ? "Loading accounts…" : "No accounts"}
                ariaLabel="Customer account"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Pixel</span>
              <SearchSelect
                value={effPixel}
                onChange={(v) => patch({ pixel: v })}
                options={pixelOptions}
                placeholder="Search pixel"
                warn={pixelNeeded}
                emptyHint={!card.customer ? "Pick an account first" : "No pixels on this account"}
                ariaLabel="Conversion pixel"
              />
              <p className="text-[10px] leading-snug text-faint">
                {!card.customer
                  ? "Pick a customer first"
                  : noPixel
                    ? "No conversion pixel — LION decides"
                    : pixelNeeded
                      ? "Several pixels — pick one"
                      : "One pixel — auto-picked"}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Budget</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase text-faint">{cur}</span>
                <input
                  value={card.budget}
                  onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, GOOGLE_BUDGET_MAX) })}
                  inputMode="decimal"
                  placeholder="30,00"
                  aria-label="Daily budget"
                  title="Daily budget in the account currency — digits fill cents (3000 → 30,00)"
                  className={inp + " pl-11"}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={micro}>Bidding</span>
                <InfoDot tip={BIDDING_TIP} />
              </span>
              <Select value={card.bidStrategy} onChange={(e) => changeStrategy(e.target.value)} options={STRATEGY_OPTIONS} aria-label="Bidding strategy" />
            </div>
          </div>

          {/* ---- ROW 2 — Countries + presets · Language · Bid value ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Countries</span>
              <MultiSelect
                id={`geo-${card.id}`}
                values={card.geo}
                onChange={(v) => patch({ geo: v.length ? v : ["WW"] })}
                options={COUNTRY_OPTIONS}
                placeholder="Countries — World = worldwide"
                chipMode="code"
                exclusiveValues={["WW"]}
              />
              <div className="flex flex-wrap gap-1">
                {GOOGLE_GEO_PRESETS.map((p) => {
                  const on = presetActive(p.codes);
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => patch({ geo: [...p.codes] })}
                      aria-pressed={on}
                      className={
                        "rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 active:scale-95 " +
                        (on
                          ? "border-accent/50 bg-accent/15 text-[#9db8ff]"
                          : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")
                      }
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Language</span>
              <SearchSelect
                value={card.language}
                onChange={(v) => patch({ language: v })}
                options={LANG_OPTIONS}
                placeholder="Search language"
                emptyHint="No matches"
                ariaLabel="Language"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>{kind === "roas" ? "Target ROAS" : kind === "cpa" ? "Target CPA" : "Bid value"}</span>
              {kind === "cpa" || kind === "roas" ? (
                <div className="relative">
                  {kind === "roas" ? (
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[12px] font-semibold text-[#9db8ff]">%</span>
                  ) : (
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">{curSymbol(cur)}</span>
                  )}
                  <input
                    value={card.bid}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const v =
                        kind === "cpa"
                          ? limitMoneyCents(raw, GOOGLE_CPA_MAX)
                          : (() => {
                              const digs = raw.replace(/\D/g, "").slice(0, 3);
                              return digs && Number(digs) > GOOGLE_ROAS_MAX ? String(GOOGLE_ROAS_MAX) : digs;
                            })();
                      patch({ bid: v });
                    }}
                    inputMode={kind === "roas" ? "numeric" : "decimal"}
                    placeholder={kind === "roas" ? "90" : "3,95"}
                    aria-label="Bid value"
                    title={
                      kind === "roas"
                        ? "Target ROAS as a whole percent 1–200 (90 = 90%)"
                        : `Target CPA in ${cur} — digits fill cents (395 → 3,95)`
                    }
                    className={inp + (kind === "cpa" ? " pl-8" : " pr-8")}
                  />
                </div>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-line bg-surface2/40 px-3 text-[11.5px] text-faint">
                  Automatic — this strategy sets no target
                </div>
              )}
            </div>
          </div>

          {/* ---- ROW 3 — Landing URL ---- */}
          <section className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5">
              <span className={micro}>Landing URL</span>
              <InfoDot tip="Paste only the base URL. Tracking params (utm, pixel) are added automatically; the business name is derived from the domain." />
            </span>
            <div className="relative">
              <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input
                value={card.landingUrl}
                onChange={(e) => patch({ landingUrl: e.target.value.trim() })}
                placeholder="https://…"
                aria-label="Landing URL"
                className={inp + " pl-9"}
              />
            </div>
            {landingSegments.length ? (
              <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
                <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {landingSegments.map((seg, i) => (
                    <span key={i} className={seg.role === "slug" ? "text-ink" : seg.role === "pixel" ? "text-accent2" : "text-faint"}>
                      {seg.text}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                  <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    Final launch link{landingStripped ? " · pasted query dropped" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={copyLanding}
                    aria-label={landingCopied ? "Link copied to clipboard" : "Copy the bare landing"}
                    className={
                      "group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-all duration-200 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (landingCopied
                        ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2"
                        : "border-line2 bg-raise text-dim hover:border-accent/50 hover:bg-accent/10 hover:text-ink")
                    }
                  >
                    {landingCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    {landingCopied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ) : null}
            <p className="flex items-center gap-1.5 text-[10px] leading-snug text-faint">
              <LockIcon className="h-3 w-3 shrink-0" />
              Must be on LION&apos;s allowed URL map — LION refuses others with a sentence.
            </p>
          </section>

          {/* ---- ROW 4 — Campaign name (read-only prefix + custom tail) · MOSH ---- */}
          <section className="flex flex-col gap-2">
            <span className={micro}>Campaign name</span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="relative sm:basis-[55%]">
                <input
                  value={headPreview}
                  readOnly
                  tabIndex={-1}
                  aria-label="Campaign name prefix (LION generates it)"
                  title="LION builds this prefix — {HS-xxxx} is a unique hash at launch. Everything after the | is yours."
                  className="h-9 w-full cursor-default truncate rounded-lg border border-line bg-surface2/30 px-3 font-mono text-[11.5px] text-faint outline-none"
                />
              </div>
              <input
                value={card.suffix}
                onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })}
                maxLength={80}
                placeholder="Custom (niche, notes…)"
                aria-label="Custom name tail"
                className={inp + " sm:flex-1"}
              />
            </div>
            <p className="truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
              {fullNamePreview}
            </p>
            <label className="flex w-fit cursor-pointer items-center gap-2 pt-1 text-[11.5px] text-dim">
              <input type="checkbox" checked={card.mosh} onChange={(e) => patch({ mosh: e.target.checked })} className="h-3.5 w-3.5 accent-[#7a96ff]" />
              MOSH
              <InfoDot tip="UPLOAD MODE ONLY. Applies subtle modifications so the platform recognizes videos as new content." />
            </label>
          </section>

          {/* ---- AD GROUPS ---- */}
          <section className="flex flex-col gap-3 border-t border-line/60 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="flex items-center gap-2">
                <span className={micro}>Ad groups</span>
                <span className="font-mono text-[10px] text-faint">{card.adGroups.length}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5">
                  <span className={micro}>Structure</span>
                  <InfoDot tip="Campaigns-ad groups-videos. Together: every ad group launches as typed, all its videos in it (1-1-5). Per video: every video launches in its own ad group with the same copy, CTA and logo (1-5-5)." />
                </span>
                <Seg
                  value={card.adGroupPerVideo ? "video" : "group"}
                  onChange={(k) => patch({ adGroupPerVideo: k === "video" })}
                  options={[
                    { key: "group", label: `${googleStructureLabel(videoCounts, false)} · together` },
                    { key: "video", label: `${googleStructureLabel(videoCounts, true)} · per video` },
                  ]}
                />
              </span>
            </div>
            <p className="text-[10px] leading-snug text-faint">
              {card.adGroupPerVideo
                ? `Launches ${agAtLaunch} ad group${agAtLaunch === 1 ? "" : "s"} — one per video, each with its group's copy, CTA and logo.`
                : `Launches ${agAtLaunch} ad group${agAtLaunch === 1 ? "" : "s"} as typed — a group's videos stay together.`}
            </p>
            {card.adGroups.map((ag, i) => (
              <AdGroupCard
                key={ag.id}
                cardId={card.id}
                ag={ag}
                index={i}
                only={card.adGroups.length === 1}
                onPatch={(p) => onPatchAdGroup(card.id, ag.id, p)}
                onDuplicate={() => duplicateAdGroup(ag.id)}
                onClearUrls={() => clearAgUrls(ag.id)}
                onClearAll={() => clearAgAll(ag.id)}
                onRemove={() => removeAdGroup(ag.id)}
              />
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onBulk(card.id)}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-[12px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/20 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Bulk Ad Groups
              </button>
              <button
                type="button"
                onClick={addAdGroup}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-line2 px-3 text-[12px] font-medium text-dim transition-colors hover:border-accent/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Ad Group
              </button>
              <button
                type="button"
                onClick={clearAllUrls}
                className="ml-auto rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Clear All URLs
              </button>
              <button
                type="button"
                onClick={removeAllAdGroups}
                className="rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium text-faint transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
              >
                Remove All Ad Groups
              </button>
            </div>
            <p className="text-[10px] leading-snug text-faint">
              Up to {50} videos — auto-split into ad groups of {GOOGLE_VIDEOS_MAX}, duplicating all fields.
            </p>
          </section>

          {/* per-card gate note / launch state */}
          {card.state === "idle" && refusal ? <p className="text-[11px] leading-snug text-warn">{refusal}</p> : null}
          {card.state !== "idle" ? (
            <p className={"break-words font-mono text-[11px] leading-snug " + stateTone}>
              {card.state === "uploading" ? card.progress ?? "Uploading…" : card.state === "sending" ? "Submitting…" : card.msg ?? "—"}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------- one ad group ----------

function AdGroupCard({
  cardId,
  ag,
  index,
  only,
  onPatch,
  onDuplicate,
  onClearUrls,
  onClearAll,
  onRemove,
}: {
  cardId: string;
  ag: AdGroup;
  index: number;
  only: boolean;
  onPatch: (p: Partial<AdGroup>) => void;
  onDuplicate: () => void;
  onClearUrls: () => void;
  onClearAll: () => void;
  onRemove: () => void;
}) {
  const [dropNote, setDropNote] = useState("");

  const onVideoFiles = (files: FileItem[]) => {
    setDropNote("");
    onPatch({ videoFiles: files.filter((f) => f.kind === "video").slice(0, GOOGLE_VIDEOS_MAX) });
  };
  // Logo drop: keep one image, then read its pixel size (Google wants 1:1, ≥128 px) so readiness
  // can refuse a wrong shape before any upload.
  const onLogoFiles = (files: FileItem[]) => {
    const imgs = files.filter((f) => f.kind === "image").slice(0, 1);
    setDropNote("");
    onPatch({ logoFiles: imgs, logoDims: null });
    const first = imgs[0];
    if (first) {
      const img = new Image();
      img.onload = () => onPatch({ logoDims: { w: img.naturalWidth, h: img.naturalHeight } });
      img.onerror = () => setDropNote("Couldn't read that image — pick a PNG, JPG or GIF.");
      img.src = first.url;
    }
  };

  const logoUrlNote = ag.logoMode === "url" ? googleLogoUrlNote(ag.logoUrl) : null;
  const logoDimsIssue = ag.logoMode === "file" ? googleLogoDimsIssue(ag.logoDims) : null;
  const logoPreview = ag.logoMode === "file" ? ag.logoFiles[0]?.url : ag.logoUrl.trim() && !logoUrlNote ? ag.logoUrl.trim() : "";
  const videoCount = ag.videoMode === "youtube" ? splitLines(ag.youtubeText).length : ag.videoFiles.length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface2/30 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-faint">
          Ad group {index + 1}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onDuplicate}
            title="Duplicate this ad group"
            aria-label="Duplicate ad group"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <CopyIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClearUrls}
            className="rounded-lg px-2 py-1 text-[10.5px] font-medium text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Clear URLs
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-lg px-2 py-1 text-[10.5px] font-medium text-faint transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Clear All
          </button>
          {!only ? (
            <button
              type="button"
              onClick={onRemove}
              title="Delete this ad group"
              aria-label="Delete ad group"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <PipeField
        label="Headlines"
        value={ag.headlines}
        onChange={(v) => onPatch({ headlines: v })}
        limit={GOOGLE_HEADLINE_MAX}
        placeholder="H1 | H2 | H3"
        tip={`Pipe-separated. Max ${GOOGLE_HEADLINE_MAX} chars each, at least 1, up to ${GOOGLE_TEXT_ASSETS_MAX}.`}
      />
      <PipeField
        label="Long headlines"
        value={ag.longHeadlines}
        onChange={(v) => onPatch({ longHeadlines: v })}
        limit={GOOGLE_LONG_HEADLINE_MAX}
        placeholder="Long headline 1 | Long headline 2"
        tip={`Pipe-separated. Max ${GOOGLE_LONG_HEADLINE_MAX} chars each, at least 1, up to ${GOOGLE_TEXT_ASSETS_MAX}.`}
      />
      <PipeField
        label="Descriptions"
        value={ag.descriptions}
        onChange={(v) => onPatch({ descriptions: v })}
        limit={GOOGLE_DESCRIPTION_MAX}
        placeholder="Description 1 | Description 2"
        tip={`Pipe-separated. Max ${GOOGLE_DESCRIPTION_MAX} chars each, at least 1, up to ${GOOGLE_TEXT_ASSETS_MAX}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5">
            <span className={micro}>Call to action</span>
            <InfoDot tip="The external API accepts only Learn more / Shop now / Sign up (or Automatic). Any other value is refused." />
          </span>
          <Select value={ag.callToAction} onChange={(e) => onPatch({ callToAction: e.target.value })} options={CTA_OPTIONS} aria-label="Call to action" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className={micro}>Video source</span>
          <Seg
            value={ag.videoMode}
            onChange={(k) => onPatch({ videoMode: k as AdGroup["videoMode"] })}
            options={[
              { key: "youtube", label: "YouTube URLs" },
              { key: "files", label: "Upload Videos" },
            ]}
          />
        </div>
      </div>

      {/* channel id — upload mode only */}
      {ag.videoMode === "files" ? (
        <div className="flex flex-col gap-1.5">
          <span className={micro}>YouTube channel id</span>
          <input
            value={ag.channelId}
            onChange={(e) => onPatch({ channelId: e.target.value.trim() })}
            placeholder="Unlisted (Google-managed)"
            aria-label="YouTube channel id"
            title="Empty = the videos are uploaded Unlisted on a Google-managed channel."
            className={inp}
          />
        </div>
      ) : null}

      {/* videos — one source */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className={micro}>Videos</span>
          <span className={"font-mono text-[10px] tabular-nums " + (videoCount > GOOGLE_VIDEOS_MAX ? "text-warn" : "text-faint")}>
            {videoCount} video{videoCount === 1 ? "" : "s"}
          </span>
        </div>
        {ag.videoMode === "youtube" ? (
          <AutoTextarea
            value={ag.youtubeText}
            onChange={(v) => onPatch({ youtubeText: v })}
            ariaLabel="YouTube URLs"
            placeholder={"One URL per line — youtube.com / youtu.be / shorts (up to " + GOOGLE_VIDEOS_MAX + ")"}
            className="block min-h-[68px] w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
          />
        ) : (
          <Dropzone id={`vids-${cardId}-${ag.id}`} files={ag.videoFiles} onChange={onVideoFiles} maxFiles={GOOGLE_VIDEOS_MAX} accept="video" compact />
        )}
      </div>

      {/* logo */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className={micro}>Logo</span>
          <Seg
            value={ag.logoMode}
            onChange={(k) => onPatch({ logoMode: k as AdGroup["logoMode"] })}
            options={[
              { key: "url", label: "URL" },
              { key: "file", label: "Upload" },
            ]}
          />
        </div>
        <div className="flex items-start gap-3">
          <span className="flex h-[120px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface2/50">
            {logoPreview ? (
              // eslint-disable-next-line @next/next/no-img-element -- local blob / external logo preview
              <img src={logoPreview} alt="Logo preview" className="h-full w-full object-contain" />
            ) : (
              <UploadIcon className="h-6 w-6 text-faint" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {ag.logoMode === "url" ? (
              <input
                value={ag.logoUrl}
                onChange={(e) => onPatch({ logoUrl: e.target.value.trim() })}
                placeholder="https://…/logo.png"
                aria-label="Logo URL"
                className={inp}
              />
            ) : (
              <div className="h-[120px]">
                <Dropzone id={`logo-${cardId}-${ag.id}`} files={ag.logoFiles} onChange={onLogoFiles} maxFiles={1} accept="image" compact />
              </div>
            )}
            {logoUrlNote ? (
              <p className="text-[10px] leading-snug text-warn">{logoUrlNote}</p>
            ) : logoDimsIssue ? (
              <p className="text-[10px] leading-snug text-warn">{logoDimsIssue}</p>
            ) : ag.logoMode === "file" && ag.logoDims ? (
              <p className="text-[10px] leading-snug text-faint">
                {ag.logoDims.w}×{ag.logoDims.h} · square ✓
              </p>
            ) : (
              <p className="text-[10px] leading-snug text-faint">Square PNG/JPG/GIF, at least 128×128.</p>
            )}
          </div>
        </div>
      </div>
      {dropNote ? <p className="text-[10.5px] leading-snug text-warn">{dropNote}</p> : null}
    </div>
  );
}
