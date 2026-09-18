"use client";

// One fresh TikTok campaign card for the TikTok launcher — the fields of tiktok-weapon's
// `/campaign/launch/` in the order a buyer thinks: Advertiser · Pixel · Budget · Mode / Countries
// (the ADVERTISER's own list, World·LATAM·Anglo·Franco presets) · Language · the value the mode
// takes / Landing URL + final-link preview / a READ-ONLY name head (LION builds it) + a custom
// tail + MOSH + copies / Identity (display name + avatar, remembered between launches) / Creative
// (ad text, CTA, 1–20 videos — all of them land in ONE ad group as a Smart Creative) / Smart+.
// Every gate is delegated to the SAME validator the server runs (tiktokLaunchWire) on placeholder
// URLs, so the card's readiness dot can never disagree with LION's answer. Files stay
// session-local object URLs here and ride Vercel Blob only at launch.

import { useState } from "react";
import { Dropzone } from "./dropzone";
import { AutoTextarea, Select } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { CheckIcon, ChevronsIcon, CopyIcon, GlobeIcon, LockIcon, TrashIcon, UploadIcon, XIcon } from "./icons";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoney, limitMoneyCents, type FileItem } from "@/lib/types";
import {
  TIKTOK_AD_TEXTS_MAX,
  TIKTOK_BID_MAX,
  TIKTOK_BUDGET_MAX,
  TIKTOK_CTAS,
  TIKTOK_CTAS_MAX,
  TIKTOK_DEFAULT_BUDGET,
  TIKTOK_GEO_PRESETS,
  TIKTOK_IDENTITY_NAME_MAX,
  TIKTOK_LAUNCH_MODES,
  TIKTOK_MAX_COPIES,
  TIKTOK_ROAS_MAX,
  TIKTOK_TITLE_MAX,
  TIKTOK_VIDEOS_MAX,
  splitTextLines,
  splitUrlLines,
  tiktokCopies,
  tiktokDraftShot,
  tiktokLandingBase,
  tiktokLandingSegments,
  tiktokLaunchWire,
  tiktokModeKind,
  tiktokNameHeadPreview,
  tiktokNamePreview,
  tiktokNameSuffix,
  todaySaoPauloDotDDMM,
  type TiktokLaunchShotIn,
  type TiktokLocaleConfig,
} from "@/lib/tiktok-launch";
import type { TiktokConfigEntry } from "./use-tiktok";
import type { RememberedIdentity } from "./tiktok-identity";
import type { SessionUser } from "./user-menu";

/** TikTok's own ceiling for one ad video — refused on the card instead of after a long upload. */
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

/** One fresh-launch card. Money is HUMAN ("20,00"); assets are session object URLs until launch. */
export type TiktokCard = {
  id: string;
  collapsed: boolean;
  // row 1
  advertiser: string;
  pixel: string;
  budget: string;
  mode: string;
  // row 2
  countries: string[];
  language: string;
  bid: string;
  // row 3
  landingUrl: string;
  // name row
  suffix: string;
  mosh: boolean;
  copies: string;
  // identity
  identityName: string;
  identityMode: "file" | "url";
  identityFiles: FileItem[];
  identityUrl: string;
  // creative
  title: string;
  callToAction: string;
  videoMode: "files" | "urls";
  videoFiles: FileItem[];
  videoUrlsText: string;
  // Smart+
  smartPlus: boolean;
  budgetLevel: "adgroup" | "campaign";
  extraTexts: string;
  extraCtas: string[];
  // launch lifecycle (per card)
  state: "idle" | "uploading" | "sending" | "ok" | "error";
  msg?: string;
  progress?: string;
};

// Client-side sequence for cards born AFTER mount (New campaign / Duplicate). The FIRST card is
// created inside the board's useState initializer, which runs on the server AND the client — a
// sequence id there differed between the two renders and tripped React's hydration check on the
// Google launcher (live 09-14), so the first card gets a FIXED id.
let cardSeq = 1;
export const FIRST_TT_CARD_ID = "ttl-card-1";

export function freshTiktokCard(id?: string): TiktokCard {
  return {
    id: id ?? `ttl-card-${++cardSeq}`,
    collapsed: false,
    advertiser: "",
    pixel: "",
    budget: TIKTOK_DEFAULT_BUDGET,
    // The team's book is bid-capped conversions ($0.10–0.90) — the launcher opens on it.
    mode: "NORMAL_WITH_BID",
    countries: [],
    language: "",
    bid: "",
    landingUrl: "",
    suffix: "",
    mosh: false,
    copies: "1",
    identityName: "",
    identityMode: "file",
    identityFiles: [],
    identityUrl: "",
    title: "",
    callToAction: "LEARN_MORE",
    videoMode: "files",
    videoFiles: [],
    videoUrlsText: "",
    smartPlus: false,
    budgetLevel: "adgroup",
    extraTexts: "",
    extraCtas: [],
    state: "idle",
  };
}

/** Deep-ish clone for the duplicate button — fresh arrays so a later edit can't bleed into the
 *  sibling (blob URLs stay shared by design, exactly like the FB cloneCardFrom rule). */
export function cloneTiktokCard(src: TiktokCard): TiktokCard {
  return {
    ...src,
    id: `ttl-card-${++cardSeq}`,
    collapsed: false,
    countries: [...src.countries],
    identityFiles: src.identityFiles.map((f) => ({ ...f })),
    videoFiles: src.videoFiles.map((f) => ({ ...f })),
    extraCtas: [...src.extraCtas],
    state: "idle",
    msg: undefined,
    progress: undefined,
  };
}

/** Hosted URLs of a card's files (resolved at launch). */
export type TiktokCardUpload = { identityUrl?: string; videoUrls?: string[] };

/** Build the shot. `upload` present = the real hosted URLs; absent = the DRY-RUN with placeholder
 *  https URLs so the SAME validator gates the card before anything is uploaded. */
export function buildTiktokShot(card: TiktokCard, ctx: { currency?: string; advertiserName?: string; upload?: TiktokCardUpload } = {}): TiktokLaunchShotIn {
  const identityImageUrl =
    ctx.upload?.identityUrl ?? (card.identityMode === "url" ? card.identityUrl.trim() : card.identityFiles.length ? "https://pending.local/identity.png" : "");
  const videoUrls =
    ctx.upload?.videoUrls ?? (card.videoMode === "urls" ? splitUrlLines(card.videoUrlsText) : card.videoFiles.map((_, i) => `https://pending.local/video-${i + 1}.mp4`));
  return tiktokDraftShot({
    advertiser: card.advertiser,
    pixel: card.pixel,
    mode: card.mode,
    budget: card.budget,
    bid: card.bid,
    suffix: card.suffix,
    landingUrl: card.landingUrl,
    identityName: card.identityName,
    identityImageUrl,
    title: card.title,
    callToAction: card.callToAction,
    videoUrls,
    countries: card.countries,
    language: card.language,
    mosh: card.mosh,
    smartPlus: card.smartPlus,
    budgetLevel: card.budgetLevel,
    extraTexts: card.extraTexts,
    extraCtas: card.extraCtas,
    currency: ctx.currency,
    label: `TikTok launch · ${ctx.advertiserName || "advertiser"}`,
  });
}

/** The card's blocking refusal from the shared validator (null when the wire is valid). Advertiser
 *  and pixel readiness are gated by the board (they need the catalogs); here a placeholder stands
 *  in for both so the validator reaches the creative. */
export function tiktokCardRefusal(card: TiktokCard, r: { pixelCode?: string; supportedModes?: string[]; config?: TiktokLocaleConfig } = {}): string | null {
  const big = card.videoMode === "files" ? card.videoFiles.findIndex((f) => f.size > VIDEO_MAX_BYTES) : -1;
  if (big >= 0) return `Video #${big + 1} is ${Math.round(card.videoFiles[big].size / 1024 / 1024)} MB — TikTok takes at most 500 MB per video`;
  const built = tiktokLaunchWire(buildTiktokShot(card), {
    advertiserId: card.advertiser || "0000000000",
    pixelCode: r.pixelCode || "PENDING",
    supportedModes: r.supportedModes,
    nameSuffix: "",
    config: r.config,
  });
  return "refusal" in built ? built.refusal : null;
}

/** Signature of a card's launch-relevant content — the wave id is cached per this so a retry after
 *  a lost answer re-sends the same id (the server claim makes it a no-op). */
export function tiktokCardSignature(card: TiktokCard): string {
  return JSON.stringify({
    a: card.advertiser,
    px: card.pixel,
    b: card.budget,
    m: card.mode,
    bd: card.bid,
    g: card.countries,
    lg: card.language,
    l: card.landingUrl,
    s: card.suffix,
    mo: card.mosh,
    n: card.copies,
    idn: card.identityName,
    idm: card.identityMode,
    idf: card.identityFiles.map((f) => f.id),
    idu: card.identityUrl,
    t: card.title,
    cta: card.callToAction,
    vm: card.videoMode,
    vf: card.videoFiles.map((f) => f.id),
    vu: card.videoUrlsText,
    sp: card.smartPlus,
    bl: card.budgetLevel,
    et: card.extraTexts,
    ec: card.extraCtas,
  });
}

// ---------- shared classes ----------

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
/** The same field without the full-width rule — for the fixed-width copies stepper. */
const inpNarrow = inp.replace("w-full ", "");
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";
const area =
  "block w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-3 py-2 text-[13px] leading-relaxed text-ink " +
  "placeholder:text-faint outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

const CTA_OPTIONS = TIKTOK_CTAS.map((c) => ({ value: c.value, label: c.label }));
const FALLBACK_COUNTRIES = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));

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

/** Segmented two-way toggle (avatar source, video source, Smart+ budget level). */
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
            className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " + (on ? "bg-accent/20 text-[#9db8ff]" : "text-dim hover:text-ink")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- the card ----------

export function TiktokLaunchCard({
  card,
  index,
  user,
  advertiserOptions,
  config,
  onRetryConfig,
  acr = "",
  advertiserName,
  effPixel,
  pixelNeeded,
  refusal,
  ready,
  advertisersLoading,
  highlight,
  landings,
  identities,
  onForgetIdentity,
  onPatch,
  onDuplicate,
  onRemove,
  onToggleCollapse,
}: {
  card: TiktokCard;
  index: number;
  user?: SessionUser;
  advertiserOptions: RichOption[];
  /** The picked advertiser's config: loaded, failed, or undefined while loading / none picked. */
  config: TiktokConfigEntry | undefined;
  onRetryConfig: (advertiserId: string) => void;
  /** LION user's ACR (lower-cased) — printed in the name head and stamped as mb= on the link. */
  acr?: string;
  advertiserName: string;
  /** The pixel that will ride ("" while unresolved). */
  effPixel: string;
  pixelNeeded: boolean;
  refusal: string | null;
  ready: boolean;
  advertisersLoading: boolean;
  highlight?: boolean;
  /** The team's live landings — suggestions for the landing field. */
  landings: string[];
  identities: RememberedIdentity[];
  onForgetIdentity: (id: RememberedIdentity) => void;
  onPatch: (id: string, p: Partial<TiktokCard>) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const patch = (p: Partial<TiktokCard>) => onPatch(card.id, p);
  const cfg = config && !("error" in config) ? config : null;
  const cfgError = config && "error" in config ? config.error : "";
  const cfgLoading = Boolean(card.advertiser) && !config;
  const kind = tiktokModeKind(card.mode);
  const copies = tiktokCopies(card.copies);

  // ---- catalogs of the PICKED advertiser -----------------------------------------------------
  const pixelOptions: RichOption[] = (cfg?.pixels ?? []).map((p) => ({ value: p.pixelCode, label: p.pixelCode }));
  const pixelModes = cfg?.pixels.find((p) => p.pixelCode === effPixel)?.supportedModes ?? [];
  // Value optimisation (Highest value / Min ROAS) is a property of the PIXEL, not of the account.
  const pixelVo = pixelModes.some((m) => m.startsWith("VO_"));
  const modeOptions = TIKTOK_LAUNCH_MODES.map((m) => ({
    value: m.value,
    label: m.value.startsWith("VO_") && pixelModes.length > 0 && !pixelModes.includes(m.value) ? `${m.label} — not on this pixel` : m.label,
  }));
  const modeHint = TIKTOK_LAUNCH_MODES.find((m) => m.value === card.mode)?.hint ?? "";
  const countryOptions = cfg ? [{ value: "WW", label: "Worldwide" }, ...cfg.countries.map((c) => ({ value: c.code, label: c.name || c.code }))] : [{ value: "WW", label: "Worldwide" }, ...FALLBACK_COUNTRIES];
  const offered = new Set(countryOptions.map((o) => o.value));
  const langOptions: RichOption[] = [
    { value: "", label: "All languages" },
    ...(cfg?.languages ?? []).map((l) => ({ value: l.code, label: l.name || l.code, meta: l.code })),
  ];
  // A preset keeps only what THIS advertiser can target (LION refuses the rest by name).
  const presets = TIKTOK_GEO_PRESETS.map((p) => ({ label: p.label, codes: p.codes.filter((c) => offered.has(c)) })).filter((p) => p.codes.length > 0);
  const geoSet = new Set(card.countries);
  const presetActive = (codes: string[]) => codes.length === card.countries.length && codes.every((c) => geoSet.has(c));
  const worldwide = card.countries.length === 1 && card.countries[0] === "WW";

  // ---- names and links -------------------------------------------------------------------------
  const landingSegments = tiktokLandingSegments(card.landingUrl, { acr, pixel: effPixel || undefined });
  const landingStripped = tiktokLandingBase(card.landingUrl)?.strippedQuery ?? false;
  const [landingCopied, setLandingCopied] = useState(false);
  const copyLanding = () => {
    const base = tiktokLandingBase(card.landingUrl)?.base;
    if (!base) return;
    void navigator.clipboard?.writeText(base).then(() => {
      setLandingCopied(true);
      setTimeout(() => setLandingCopied(false), 1400);
    });
  };
  const headPreview = tiktokNameHeadPreview({ acr, countries: card.countries, language: card.language, landing: card.landingUrl });
  const bareSuffix = tiktokNameSuffix({ user: user?.username ?? "", ddmm: todaySaoPauloDotDDMM(), tail: card.suffix });
  const fullNamePreview = tiktokNamePreview({ head: headPreview, suffix: bareSuffix, kind: "launch", smartPlus: card.smartPlus ? card.budgetLevel : "" });

  const changeMode = (val: string) => patch({ mode: val, bid: tiktokModeKind(val) === kind ? card.bid : "" });

  // ---- identity ----------------------------------------------------------------------------------
  const [dropNote, setDropNote] = useState("");
  const onIdentityFiles = (files: FileItem[]) => {
    setDropNote("");
    patch({ identityFiles: files.filter((f) => f.kind === "image").slice(0, 1) });
  };
  const identityPreview = card.identityMode === "file" ? card.identityFiles[0]?.url : /^https:\/\//i.test(card.identityUrl.trim()) ? card.identityUrl.trim() : "";
  const pickIdentity = (id: RememberedIdentity) => patch({ identityName: id.name, identityMode: "url", identityUrl: id.imageUrl, identityFiles: [] });

  // ---- creative ----------------------------------------------------------------------------------
  const onVideoFiles = (files: FileItem[]) => {
    setDropNote("");
    const vids = files.filter((f) => f.kind === "video");
    if (vids.length > TIKTOK_VIDEOS_MAX) setDropNote(`A campaign takes at most ${TIKTOK_VIDEOS_MAX} videos — the first ${TIKTOK_VIDEOS_MAX} were kept.`);
    patch({ videoFiles: vids.slice(0, TIKTOK_VIDEOS_MAX) });
  };
  const videoCount = card.videoMode === "urls" ? splitUrlLines(card.videoUrlsText).length : card.videoFiles.length;
  const textCount = 1 + splitTextLines(card.extraTexts).length;
  const extraCtaOptions = CTA_OPTIONS.filter((c) => c.value !== card.callToAction);

  const stateTone =
    card.state === "error" ? "text-danger" : card.state === "ok" ? "text-launch2" : card.state === "uploading" || card.state === "sending" ? "text-[#9db8ff]" : "text-faint";

  return (
    <div
      id={`ttcard-${card.id}`}
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
          <p className="truncate text-[12.5px] font-medium text-ink">{card.smartPlus ? "Smart+ campaign" : "TikTok campaign"}</p>
          <p className="truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
            {fullNamePreview}
          </p>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">
          {videoCount} video{videoCount === 1 ? "" : "s"}
          {copies > 1 ? ` · ×${copies}` : ""}
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
            {advertiserName || "no advertiser"} · ${card.budget} · {videoCount} video{videoCount === 1 ? "" : "s"}
            {copies > 1 ? ` · ×${copies}` : ""}
          </span>
          {card.state !== "idle" ? <span className={"ml-auto truncate font-mono text-[10.5px] " + stateTone}>{card.msg ?? "—"}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          {/* ---- ROW 1 — Advertiser · Pixel · Budget · Mode ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Advertiser</span>
              <SearchSelect
                value={card.advertiser}
                // Countries / language / pixel belong to the advertiser — a new one starts clean.
                onChange={(v) => patch({ advertiser: v, pixel: "" })}
                options={advertiserOptions}
                placeholder="Search advertiser"
                warn={!card.advertiser}
                emptyHint={advertisersLoading ? "Loading advertisers…" : "No launch-eligible advertisers"}
                ariaLabel="Advertiser"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Pixel</span>
              <SearchSelect
                value={effPixel}
                onChange={(v) => patch({ pixel: v })}
                options={pixelOptions}
                placeholder={cfgLoading ? "Loading…" : "Search pixel"}
                warn={pixelNeeded}
                emptyHint={!card.advertiser ? "Pick an advertiser first" : cfgLoading ? "Loading the advertiser's pixels…" : "No pixels on this advertiser"}
                ariaLabel="Pixel"
              />
              <p className="text-[10px] leading-snug text-faint">
                {!card.advertiser ? (
                  "Pick an advertiser first"
                ) : cfgError ? (
                  <span className="text-warn">
                    Couldn&apos;t read the advertiser — {cfgError}.{" "}
                    <button type="button" onClick={() => onRetryConfig(card.advertiser)} className="font-semibold text-[#9db8ff] underline-offset-2 hover:underline">
                      Retry
                    </button>
                  </span>
                ) : cfgLoading ? (
                  "Reading pixels, countries and languages…"
                ) : pixelNeeded ? (
                  "Several pixels — pick one"
                ) : (cfg?.pixels.length ?? 0) === 0 ? (
                  <span className="text-warn">No usable pixel — LION can&apos;t launch here</span>
                ) : (
                  `${(cfg?.pixels.length ?? 0) === 1 ? "One pixel — auto-picked" : "Picked"} · value optimisation ${pixelVo ? "on" : "off"}`
                )}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={micro}>Budget / day</span>
                <InfoDot tip="Daily budget in USD. TikTok refuses less than $20 — LION never raises it for you." />
              </span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">$</span>
                <input
                  value={card.budget}
                  onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, TIKTOK_BUDGET_MAX) })}
                  inputMode="decimal"
                  placeholder={TIKTOK_DEFAULT_BUDGET}
                  aria-label="Daily budget"
                  title="Daily budget in USD — digits fill cents (2000 → 20,00)"
                  className={inp + " pl-7"}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={micro}>Mode</span>
                <InfoDot tip={TIKTOK_LAUNCH_MODES.map((m) => `${m.label} — ${m.hint}`).join(" ")} />
              </span>
              <Select value={card.mode} onChange={(e) => changeMode(e.target.value)} options={modeOptions} aria-label="Bidding mode" />
              <p className="text-[10px] leading-snug text-faint">{modeHint}</p>
            </div>
          </div>

          {/* ---- ROW 2 — Countries + presets · Language · the mode's value ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span className={micro}>Countries</span>
                <InfoDot tip="The list is the picked advertiser's own — LION refuses a country it can't target there. World = worldwide and needs a language. Targeting is fixed by LION: all genders, 18+." />
              </span>
              <MultiSelect
                id={`ttgeo-${card.id}`}
                values={card.countries}
                onChange={(v) => patch({ countries: v })}
                options={countryOptions}
                placeholder={card.advertiser ? "Countries — or World" : "Pick an advertiser first"}
                chipMode="code"
                exclusiveValues={["WW"]}
              />
              <div className="flex flex-wrap gap-1">
                {presets.map((p) => {
                  const on = presetActive(p.codes);
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => patch({ countries: [...p.codes] })}
                      aria-pressed={on}
                      className={
                        "rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 active:scale-95 " +
                        (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")
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
                options={langOptions}
                placeholder="Search language"
                warn={worldwide && !card.language}
                emptyHint="No matches"
                ariaLabel="Language"
              />
              <p className="text-[10px] leading-snug text-faint">{worldwide ? "Worldwide needs a language" : "Empty = every language (LION prints ALL in the name)"}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>{kind === "roas" ? "ROAS goal" : kind === "bid" ? "Bid per conversion" : "Value"}</span>
              {kind === "bid" || kind === "roas" ? (
                <div className="relative">
                  {kind === "roas" ? (
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[12px] font-semibold text-[#9db8ff]">×</span>
                  ) : (
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">$</span>
                  )}
                  <input
                    value={card.bid}
                    onChange={(e) => patch({ bid: kind === "bid" ? limitMoneyCents(e.target.value, TIKTOK_BID_MAX) : limitMoney(e.target.value, TIKTOK_ROAS_MAX) })}
                    inputMode="decimal"
                    placeholder={kind === "roas" ? "1,2" : "0,46"}
                    aria-label={kind === "roas" ? "ROAS goal" : "Bid per conversion"}
                    title={kind === "roas" ? "Minimum ROAS as a multiplier — 1,2 = 120%" : "Bid per conversion in USD — digits fill cents (46 → 0,46). Must stay below the daily budget."}
                    className={inp + (kind === "bid" ? " pl-7" : " pr-8")}
                  />
                </div>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-line bg-surface2/40 px-3 text-[11.5px] text-faint">Automatic — this mode takes no value</div>
              )}
            </div>
          </div>

          {/* ---- ROW 3 — Landing URL ---- */}
          <section className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5">
              <span className={micro}>Landing URL</span>
              <InfoDot tip="Paste only the base URL. LION drops the query string and appends its own tracking (utm, mb, pixel, cl). The suggestions are the landings the team's TikTok campaigns run right now — every one is on LION's allowed domains." />
            </span>
            <div className="relative">
              <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
              <input
                value={card.landingUrl}
                onChange={(e) => patch({ landingUrl: e.target.value.trim() })}
                list={`ttlandings-${card.id}`}
                placeholder="https://…/ht/…/en/"
                aria-label="Landing URL"
                className={inp + " pl-9"}
              />
              <datalist id={`ttlandings-${card.id}`}>
                {landings.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
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
                  <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Final launch link{landingStripped ? " · pasted query dropped" : ""}</span>
                  <button
                    type="button"
                    onClick={copyLanding}
                    aria-label={landingCopied ? "Link copied to clipboard" : "Copy the bare landing"}
                    className={
                      "group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-all duration-200 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                      (landingCopied ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2" : "border-line2 bg-raise text-dim hover:border-accent/50 hover:bg-accent/10 hover:text-ink")
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
              Must be on one of LION&apos;s allowed domains — LION refuses others and lists the allowed ones.
            </p>
          </section>

          {/* ---- ROW 4 — Campaign name (read-only head + custom tail) · MOSH · copies ---- */}
          <section className="flex flex-col gap-2">
            <span className={micro}>Campaign name</span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div className="relative sm:basis-[55%]">
                <input
                  value={headPreview}
                  readOnly
                  tabIndex={-1}
                  aria-label="Campaign name head (LION generates it)"
                  title="LION builds this head — {HS-xxxx} is a unique hash and cl the advertiser's cluster number at launch. Everything after the | is yours."
                  className="h-9 w-full cursor-default truncate rounded-lg border border-line bg-surface2/30 px-3 font-mono text-[11.5px] text-faint outline-none"
                />
              </div>
              <input
                value={card.suffix}
                onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })}
                maxLength={80}
                placeholder="Custom (CREO, angle, notes…)"
                aria-label="Custom name tail"
                className={inp + " sm:flex-1"}
              />
            </div>
            <p className="truncate font-mono text-[10px] text-faint" title={fullNamePreview}>
              {fullNamePreview}
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
              <label className="flex w-fit cursor-pointer items-center gap-2 text-[11.5px] text-dim">
                <input type="checkbox" checked={card.mosh} onChange={(e) => patch({ mosh: e.target.checked })} className="h-3.5 w-3.5 accent-[#7a96ff]" />
                MOSH
                <InfoDot tip="LION applies small changes to each video (borders, audio filters…) so TikTok treats it as a new creative." />
              </label>
              <div className="flex items-center gap-2 text-[11.5px] text-dim">
                <span>Copies</span>
                <button
                  type="button"
                  onClick={() => patch({ copies: String(Math.max(1, copies - 1)) })}
                  disabled={copies <= 1}
                  className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40"
                  aria-label="Fewer copies"
                >
                  −
                </button>
                <input
                  value={card.copies}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                    patch({ copies: raw !== "" && Number(raw) > TIKTOK_MAX_COPIES ? String(TIKTOK_MAX_COPIES) : raw });
                  }}
                  inputMode="numeric"
                  aria-label="Number of copies"
                  className={inpNarrow + " w-14 text-center"}
                />
                <button
                  type="button"
                  onClick={() => patch({ copies: String(Math.min(TIKTOK_MAX_COPIES, copies + 1)) })}
                  disabled={copies >= TIKTOK_MAX_COPIES}
                  className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40"
                  aria-label="More copies"
                >
                  +
                </button>
                <InfoDot tip={`Each copy is its own campaign with the same fields (up to ${TIKTOK_MAX_COPIES}). The files are uploaded once.`} />
              </div>
            </div>
          </section>

          {/* ---- IDENTITY ---- */}
          <section className="flex flex-col gap-3 border-t border-line/60 pt-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className={micro}>Identity</span>
                <InfoDot tip="The custom identity the ad runs under: a display name and an avatar. The avatar is cropped to a 256×256 PNG here, before it is uploaded." />
              </span>
              <Seg
                value={card.identityMode}
                onChange={(k) => patch({ identityMode: k as TiktokCard["identityMode"] })}
                options={[
                  { key: "file", label: "Upload" },
                  { key: "url", label: "URL" },
                ]}
              />
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-[96px] w-[96px] shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-surface2/50">
                {identityPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local blob / hosted avatar preview
                  <img src={identityPreview} alt="Identity avatar preview" className="h-full w-full object-cover" />
                ) : (
                  <UploadIcon className="h-5 w-5 text-faint" />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="relative">
                  <input
                    value={card.identityName}
                    onChange={(e) => patch({ identityName: e.target.value.replace(/[\r\n]+/g, " ").slice(0, TIKTOK_IDENTITY_NAME_MAX) })}
                    placeholder="Display name — e.g. Daily Trends"
                    aria-label="Identity display name"
                    className={inp}
                  />
                </div>
                {card.identityMode === "url" ? (
                  <input
                    value={card.identityUrl}
                    onChange={(e) => patch({ identityUrl: e.target.value.trim() })}
                    placeholder="https://…/avatar.png"
                    aria-label="Identity image URL"
                    className={inp}
                  />
                ) : (
                  <div className="h-[120px]">
                    <Dropzone id={`ttidentity-${card.id}`} files={card.identityFiles} onChange={onIdentityFiles} maxFiles={1} accept="image" compact />
                  </div>
                )}
                <p className="text-[10px] leading-snug text-faint">
                  {card.identityMode === "file" ? "Any PNG / JPG — it is centre-cropped to a square 256×256 PNG at launch." : "A public https:// image; LION uses it as it is — square works best."}
                </p>
              </div>
            </div>
            {identities.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-faint">Recent:</span>
                {identities.map((id) => {
                  const on = card.identityMode === "url" && card.identityUrl === id.imageUrl && card.identityName === id.name;
                  return (
                    <span
                      key={`${id.name}|${id.imageUrl}`}
                      className={"group/id flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-1 text-[11px] " + (on ? "border-accent/50 bg-accent/15 text-[#9db8ff]" : "border-line bg-surface2 text-dim")}
                    >
                      <button type="button" onClick={() => pickIdentity(id)} aria-pressed={on} title={`Use “${id.name}”`} className="flex items-center gap-1.5 rounded-full hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                        {/* eslint-disable-next-line @next/next/no-img-element -- hosted avatar thumb */}
                        <img src={id.imageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                        <span className="max-w-[140px] truncate">{id.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onForgetIdentity(id)}
                        aria-label={`Forget ${id.name}`}
                        title="Forget this identity"
                        className="flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
          </section>

          {/* ---- CREATIVE ---- */}
          <section className="flex flex-col gap-3 border-t border-line/60 pt-4">
            <span className={micro}>Creative</span>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className={micro}>Ad text</span>
                  <span className={"font-mono text-[10px] tabular-nums " + (card.title.trim().length > TIKTOK_TITLE_MAX ? "text-warn" : "text-faint")}>
                    {card.title.trim().length}/{TIKTOK_TITLE_MAX}
                  </span>
                </div>
                <AutoTextarea
                  value={card.title}
                  onChange={(v) => patch({ title: v.replace(/[\r\n]+/g, " ") })}
                  ariaLabel="Ad text"
                  placeholder="The caption under the video — up to 100 characters"
                  className={area + " min-h-[44px]"}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Call to action</span>
                <Select
                  value={card.callToAction}
                  // The main CTA can't also sit among the Smart+ extras (LION wants them distinct).
                  onChange={(e) => patch({ callToAction: e.target.value, extraCtas: card.extraCtas.filter((c) => c !== e.target.value) })}
                  options={CTA_OPTIONS}
                  aria-label="Call to action"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className={micro}>Videos</span>
                  <InfoDot tip={`1–${TIKTOK_VIDEOS_MAX} videos. ALL of them go into one ad group as a Smart Creative — TikTok rotates them itself. Vertical 9:16 fills the screen.`} />
                </span>
                <span className="flex items-center gap-2">
                  <span className={"font-mono text-[10px] tabular-nums " + (videoCount > TIKTOK_VIDEOS_MAX ? "text-warn" : "text-faint")}>
                    {videoCount}/{TIKTOK_VIDEOS_MAX}
                  </span>
                  <Seg
                    value={card.videoMode}
                    onChange={(k) => patch({ videoMode: k as TiktokCard["videoMode"] })}
                    options={[
                      { key: "files", label: "Upload" },
                      { key: "urls", label: "URLs" },
                    ]}
                  />
                </span>
              </div>
              {card.videoMode === "files" ? (
                <Dropzone id={`ttvideos-${card.id}`} files={card.videoFiles} onChange={onVideoFiles} maxFiles={TIKTOK_VIDEOS_MAX} accept="video" portrait />
              ) : (
                <AutoTextarea
                  value={card.videoUrlsText}
                  onChange={(v) => patch({ videoUrlsText: v })}
                  ariaLabel="Video URLs"
                  placeholder={"One public https:// video URL per line (up to " + TIKTOK_VIDEOS_MAX + ")"}
                  className={area + " min-h-[68px] font-mono text-[12px]"}
                />
              )}
            </div>
            {dropNote ? <p className="text-[10.5px] leading-snug text-warn">{dropNote}</p> : null}
          </section>

          {/* ---- SMART+ ---- */}
          <section className="flex flex-col gap-3 border-t border-line/60 pt-4">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] font-medium text-ink">
              <input type="checkbox" checked={card.smartPlus} onChange={(e) => patch({ smartPlus: e.target.checked })} className="h-3.5 w-3.5 accent-[#7a96ff]" />
              Smart+ campaign
              <InfoDot tip="TikTok's automated campaign type. LION locks a “Smart+” (or “Smart+ CBO”) tag into the campaign name. Off = a classic campaign." />
            </label>
            {card.smartPlus ? (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface2/30 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={micro}>Budget level</span>
                  <Seg
                    value={card.budgetLevel}
                    onChange={(k) => patch({ budgetLevel: k as TiktokCard["budgetLevel"] })}
                    options={[
                      { key: "adgroup", label: "Ad group" },
                      { key: "campaign", label: "Campaign (CBO)" },
                    ]}
                  />
                  <span className="text-[10.5px] text-faint">{card.budgetLevel === "campaign" ? "The daily budget sits on the campaign — TikTok spreads it." : "The daily budget sits on the ad group."}</span>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className={micro}>Extra ad texts</span>
                      <span className={"font-mono text-[10px] tabular-nums " + (textCount > TIKTOK_AD_TEXTS_MAX ? "text-warn" : "text-faint")}>
                        {textCount}/{TIKTOK_AD_TEXTS_MAX}
                      </span>
                    </div>
                    <AutoTextarea
                      value={card.extraTexts}
                      onChange={(v) => patch({ extraTexts: v })}
                      ariaLabel="Extra ad texts"
                      placeholder={`One per line — up to ${TIKTOK_AD_TEXTS_MAX - 1} more, each different from the main text`}
                      className={area + " min-h-[68px]"}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className={micro}>Extra calls to action</span>
                      <span className="font-mono text-[10px] tabular-nums text-faint">
                        {1 + card.extraCtas.length}/{TIKTOK_CTAS_MAX}
                      </span>
                    </div>
                    <MultiSelect
                      id={`ttctas-${card.id}`}
                      values={card.extraCtas}
                      onChange={(v) => patch({ extraCtas: v.slice(0, TIKTOK_CTAS_MAX - 1) })}
                      options={extraCtaOptions}
                      placeholder={`Up to ${TIKTOK_CTAS_MAX - 1} more`}
                    />
                  </div>
                </div>
              </div>
            ) : null}
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
