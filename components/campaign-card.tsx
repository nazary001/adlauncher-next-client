"use client";

import { memo, useEffect, useState } from "react";
import type { Campaign } from "@/lib/types";
import { MO_SOC_MARK, bidAmountMissing, bidKind, fullName, isHttpUrl, isLaunchable, limitMoney, limitMoneyCents, moEnsureSocMark, moneyLabel, normalizeRoasGoal, parseMoney } from "@/lib/types";
import {
  AGES,
  BID_STRATEGIES,
  CATEGORIES,
  CONVERSION_EVENTS,
  conversionEventsFor,
  COUNTRIES,
  COUNTRY_PRESETS,
  CTAS,
  LOCALES,
  OBJECTIVES,
  OPTIMIZATIONS,
  OS_OPTIONS,
  PLACEMENTS,
  PROFILES,
  REDIRECT_TYPES,
  accountsFor,
  geoSummary,
  pagesFor,
  pixelsFor,
} from "@/lib/catalog";
import { hsFinalLink, hsLinkSegments, hsNamePrefix, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { type LinkRole, type PartnerConfig, ROAS_PIXEL, fullLandingUrl, landingUrlSegments, launchReadyOpts, pickAifPixel } from "@/lib/partners";
import type { FanpageOption } from "./use-fanpages";
import type { HsCatalog } from "./use-hs";
import { type AdAccountOption, defaultPixelFor, pixelOptionsOf } from "./use-adaccounts";
import { decorateAccountOptions, fmtCountdown, useAcctLimits } from "./use-acct-limit";
import { Field, MoneyInput, Select, TextArea, TextInput, IconButton } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { Dropzone } from "./dropzone";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GlobeIcon,
  LockIcon,
  MegaphoneIcon,
  SlidersIcon,
  TargetIcon,
  TrashIcon,
} from "./icons";

/** Tracking-link preview colors, keyed by segment role (see landingUrlSegments).
 *  gcm = accent blue, fire = launch green, pixel = accent2 violet — each distinct. */
const LINK_ROLE_CLASS: Record<LinkRole, string> = {
  base: "text-faint",
  slug: "text-ink",
  gcmKey: "text-faint",
  gcm: "text-[#9db8ff]",
  params: "text-faint",
  fire: "text-launch2",
  pixel: "text-accent2",
};

/** Human list of what a card is still missing to launch — partner-aware (mirrors isLaunchable +
 *  launchReadyOpts), so the draft-dot tooltip names the real blockers instead of a fixed string. */
function missingRequirements(
  c: Campaign,
  partner: PartnerConfig,
  opts: ReturnType<typeof launchReadyOpts>,
  acctFull = false,
): string[] {
  const m: string[] = [];
  if (acctFull) m.push("account at its 5/30min launch limit — pick another or wait for the reset");
  if (!c.name.trim()) m.push("name");
  if (c.countries.length === 0) m.push("geo");
  if (opts.account && !c.account) m.push("account");
  if (opts.pixel && !c.pixel) m.push("pixel");
  if (opts.page && !c.page) m.push(partner.pageLabel.toLowerCase());
  if (opts.landing && !c.landing) m.push(partner.aifLaunch ? "destination" : "landing");
  if (opts.gcm && !c.gcm) m.push(partner.aifLaunch ? "brand" : "gcm code");
  if (opts.profile && !c.profile) m.push("profile");
  if (opts.link && !isHttpUrl(c.link)) m.push("link");
  if (opts.adText && !c.title.trim()) m.push("title");
  if (opts.adText && !c.copy.trim()) m.push("copy");
  if (parseMoney(c.budget) < 1) m.push("budget");
  if (bidAmountMissing(c)) m.push("bid cap");
  if (opts.roasPixel && bidKind(c.bidStrategy) === "roas" && c.pixel !== opts.roasPixel)
    m.push(`${ROAS_PIXEL.name} pixel`);
  if (!c.files.some((f) => f.kind === "video" || f.kind === "image")) m.push("creative");
  return m.length ? m : ["—"];
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-faint">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
        {children}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Kind of a URL-added creative, judged by its extension (query strings tolerated). */
function urlCreativeKind(url: string): "video" | "image" {
  return /\.(jpe?g|png|gif|webp)([?#]|$)/i.test(url) ? "image" : "video";
}

/**
 * HS creatives can be public URLs (creative-studio renders, CDN assets) — LION downloads them
 * itself, so these skip the Blob upload entirely. One row: paste, Add, done.
 */
function AddByUrl({ onAdd }: { onAdd: (item: import("@/lib/types").FileItem) => void }) {
  const [draft, setDraft] = useState("");
  const valid = isHttpUrl(draft);
  const add = () => {
    if (!valid) return;
    const url = draft.trim();
    const name = url.split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "creative";
    onAdd({
      id: `u${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      size: 0,
      kind: urlCreativeKind(url),
      url,
    });
    setDraft("");
  };
  return (
    <div className="flex gap-2">
      <TextInput
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        maxLength={2000}
        placeholder="…or paste a public creative URL"
        className="font-mono text-[11.5px]"
      />
      <button
        type="button"
        onClick={add}
        disabled={!valid}
        className={
          "h-9 shrink-0 rounded-lg border px-3 text-[12px] font-semibold transition-all duration-150 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
          (valid
            ? "border-accent/40 bg-accent/15 text-[#9db8ff] hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97]"
            : "cursor-not-allowed border-line bg-surface text-faint opacity-50")
        }
      >
        Add
      </button>
    </div>
  );
}

/** Read-only field for values pinned by the partner (single account / pixel). */
function LockedField({ value, hint, mono }: { value: string; hint?: string; mono?: boolean }) {
  return (
    <div
      title={value}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-line bg-surface2/40 px-3"
    >
      <span className={"truncate text-ink " + (mono ? "font-mono text-[12px]" : "text-[13px]")}>
        {value || "—"}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-faint">
        {hint ? (
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em]">{hint}</span>
        ) : null}
        <LockIcon className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

/** The tracking-link preview's Copy control — one look for the MO and HS builders. */
function CopyLinkButton({
  copied,
  disabled,
  title,
  onClick,
}: {
  copied: boolean;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? title : undefined}
      aria-label={copied ? "Link copied to clipboard" : "Copy link to clipboard"}
      className={
        "group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold " +
        "transition-all duration-200 active:scale-[0.94] focus-visible:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40 " +
        (copied
          ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2"
          : "border-line2 bg-raise text-dim hover:border-accent/50 hover:bg-accent/10 hover:text-ink")
      }
    >
      <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
        {copied ? (
          <CheckIcon key="copied" className="animate-check h-3.5 w-3.5" />
        ) : (
          <CopyIcon className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-px group-active:scale-90" />
        )}
      </span>
      <span className="w-12 text-left">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// memo + the board's stable (useCallback) handlers: only the card whose `campaign` object
// actually changed re-renders — typing in one card of a 200-card wave no longer re-executes
// every card body (normalize/fillAccountDefaults preserve identity for untouched cards).
function CampaignCardBase({
  campaign: c,
  index,
  partner,
  fanpages,
  adAccounts,
  hs,
  highlight,
  coversEnabled,
  hsTokenRail,
  moSocRail,
  onPatch,
  onToggleCollapse,
  onDuplicate,
  onRemove,
  onApplyFilesToAll,
}: {
  campaign: Campaign;
  index: number;
  partner: PartnerConfig;
  /** Token fanpages for the picker (value = page id, adCount = live ads-running-or-in-review
   *  count on that page). null = loading/unavailable. */
  fanpages?: FanpageOption[] | null;
  /** Token ad accounts (value = account_id digits, with their pixels). null = loading. */
  adAccounts?: AdAccountOption[] | null;
  /** LION catalog (HS partner): profiles + per-profile accounts/pages/locales + pixels. */
  hs?: HsCatalog;
  /** Focus-pulse this card after a jump from the Launch bay. */
  highlight?: boolean;
  /** Offer the per-video custom-cover picker. True wherever the launch rides OUR FB token
   *  (MO / AIF always; HS only while the FB Token rail is picked — LION's create contract
   *  takes bare URLs and picks its own frame, owner rule 2026-08-18). */
  coversEnabled?: boolean;
  /** HS: the FB Token rail is picked — the account picker offers only token-visible accounts
   *  (LION binds cover segments the token was never granted; a launch there burns on the first
   *  Graph POST — aleph, 2026-08-19). */
  hsTokenRail?: boolean;
  /** MO: a soc signer is picked — the name preview carries the fixed SOC marker the server
   *  will really put into the created campaign's name. */
  moSocRail?: boolean;
  onPatch: (id: string, patch: Partial<Campaign>) => void;
  onToggleCollapse: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  /** Copy this card's creatives onto every card (only passed when >1 card exists). */
  onApplyFilesToAll?: (files: import("@/lib/types").FileItem[]) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  /* overflow must stay hidden while the collapse animation runs, but once the card
     is fully expanded it has to be released so field dropdowns can escape the card */
  const [settledOpen, setSettledOpen] = useState(!c.collapsed);
  const patch = (p: Partial<Campaign>) => onPatch(c.id, p);

  const accounts = accountsFor(c.profile);
  const pixels = pixelsFor(c.account);
  // Match the Launch bay + launch filter EXACTLY (isLaunchable = isReady + a video creative), so the
  // card dot can't show green "ready" while the rail refuses to launch it for want of a video.
  const opts = launchReadyOpts(partner);
  // Account launch limit (5 campaigns / 30 min, all users & channels): a full account blocks the
  // card exactly like a missing field — dot, tooltip, rail and the launch filter all agree.
  const limits = useAcctLimits();
  const acctFull = Boolean(c.account) && limits.countFor(c.account) >= limits.limit;
  const acctResetAt = acctFull ? limits.resetAtFor(c.account) : null;
  const ready = isLaunchable(c, opts) && !acctFull;
  const missing = missingRequirements(c, partner, opts, acctFull);
  const bidCapEnabled = c.bidStrategy !== "LOWEST_COST_WITHOUT_CAP";

  // ---- AIF mode: MO-style pickers on the AIF token; destination = free-typed slug; the pixel
  // is derived (conversions → the AIF postback pixel, clicks → none) and never picked. ----
  const aifMode = Boolean(partner.aifLaunch);
  // ---- HS (LION) mode: the bind cascade + locales come from LION's catalog ----
  const hsMode = Boolean(partner.lionLaunch && hs);
  const hsData = hsMode && hs ? hs.dataFor(c.profile) : undefined;
  const hsPixels = hsMode && hs ? hs.pixelsFor(c.profile, c.account) : undefined;
  // Idempotent loaders — cover picked, duplicated and copy-to-all'ed cards alike.
  useEffect(() => {
    if (hsMode && c.profile) hs?.ensureProfile(c.profile);
  }, [hsMode, c.profile, hs]);
  useEffect(() => {
    if (hsMode && c.profile && c.account) hs?.ensurePixels(c.profile, c.account);
  }, [hsMode, c.profile, c.account, hs]);
  const kind = bidKind(c.bidStrategy);
  // ROAS-goal echo for the bid field: what the wire will actually set (normalizeRoasGoal), so a
  // percent-form entry is visible as its decimal goal right under the input.
  const roasEntered = kind === "roas" ? parseMoney(c.bidCap) : 0;
  const roasGoal = roasEntered > 0 ? normalizeRoasGoal(roasEntered) : null;
  // Self-heal restored/copied min-ROAS drafts: the value-pixel pin is STATE, not just display —
  // a draft restored with another pixel converges to the only ROAS-allowed one. Idempotent
  // (patches only on mismatch), so the unstable `patch` identity is safe to leave out of deps.
  const roasPixelDrift =
    !hsMode && !aifMode && partner.accountsFromToken && kind === "roas" && c.pixel !== ROAS_PIXEL.id;
  useEffect(() => {
    if (roasPixelDrift) onPatch(c.id, { pixel: ROAS_PIXEL.id });
  }, [roasPixelDrift, onPatch, c.id]);
  // HS: a one-pixel account needs no picking — the field self-fills, but only ONCE THE FANKA IS
  // PICKED (owner ask 08-13: an id materialising right after the account read as noise — the
  // pixel belongs at the fanka step). Converges back if a stale draft carries some other id.
  const hsOnlyPixel =
    hsMode && c.account && c.page && Array.isArray(hsPixels) && hsPixels.length === 1
      ? hsPixels[0].id
      : "";
  const hsPixelDrift = Boolean(hsOnlyPixel) && c.pixel !== hsOnlyPixel;
  useEffect(() => {
    if (hsPixelDrift) onPatch(c.id, { pixel: hsOnlyPixel });
  }, [hsPixelDrift, hsOnlyPixel, onPatch, c.id]);
  // A stored pixel the account's (FARM-filtered) list doesn't offer would sit in the closed
  // field as raw digits and submit a bind the picker can't display — clear it; the autofill
  // above then re-fills the right one when the list is a single pixel.
  const hsPixelUnlisted =
    hsMode && Boolean(c.account) && Array.isArray(hsPixels) && Boolean(c.pixel) &&
    !hsPixels.some((p) => p.id === c.pixel);
  useEffect(() => {
    if (hsPixelUnlisted) onPatch(c.id, { pixel: "" });
  }, [hsPixelUnlisted, onPatch, c.id]);
  // FB Token rail: offer only accounts OUR token can act on — LION binds cover segments the
  // token was never granted (aleph, 08-19), and a launch there dies on the first Graph POST.
  // null sweep → no filtering (fail open; the token route's guard still refuses cleanly).
  const hsTokenVisible = hsMode && hsTokenRail ? (hsData?.tokenAccounts ?? null) : null;
  const hsAccountOptions =
    hsTokenVisible !== null
      ? (hsData?.accounts ?? []).filter((a) => hsTokenVisible.has(a.value))
      : (hsData?.accounts ?? []);
  // A stored account the rail switch just hid would submit a bind the picker can't display —
  // clear it (and the dependent pixel), same self-heal idiom as the unlisted-pixel guard above.
  const hsAccountHidden = Boolean(c.account) && hsTokenVisible !== null && !hsTokenVisible.has(c.account);
  useEffect(() => {
    if (hsAccountHidden) onPatch(c.id, { account: "", pixel: "" });
  }, [hsAccountHidden, onPatch, c.id]);
  const hsCurrency = hsMode ? hsData?.currencies?.[c.account] || "" : "";
  // The LION-validated name prefix is DERIVED (date + ACR + redirect label + geo, and the FB
  // Token rail's fixed TOKEN marker) — it re-renders live as the buyer flips redirect type, geo
  // or the launch rail; the server rebuilds the exact same string.
  const displayPrefix = hsMode
    ? hsNamePrefix(c, hs?.acr ?? "", todaySaoPauloDDMM(), hsTokenRail ? "token" : "lion")
    : c.namePrefix + (moSocRail ? MO_SOC_MARK : "");
  const displayName = hsMode
    ? c.name.trim()
      ? displayPrefix + c.name
      : ""
    : moSocRail
      ? moEnsureSocMark(fullName(c))
      : fullName(c);

  // Indians pin one account → its pixel and fanpage render locked, not searchable.
  const locked = Boolean(partner.lockedAccount);
  // Profile is a LION concept (Brazilians); hidden for direct-API partners like Indians.
  const setupCol = partner.usesProfile
    ? "col-span-12 md:col-span-6 xl:col-span-3"
    : "col-span-12 md:col-span-6 xl:col-span-4";
  // Fanpages (Indians) come from the partner, not the profile; other partners use profile pages.
  const pageOptions = partner.fanpages.length ? partner.fanpages : pagesFor(c.profile);
  // Niche section headers + language tags in the picker; searching "dental" / "es" narrows.
  const landingOptions = partner.landings.map((l) => ({
    value: l.slug,
    label: l.title,
    group: l.niche,
    tag: l.lang,
    tagTone: l.lang === "ES" ? ("ok" as const) : ("dim" as const),
  }));
  const conversions = c.optimization === "conversions";
  // AIF: the conversion pixel of the picked account, derived from the token's catalog (same rule
  // the server re-applies at launch — aifDerivedPixel). Display only; null while the account is
  // unpicked, the catalog is loading, or the account carries no derivable pixel.
  const aifPixel = aifMode && conversions ? pickAifPixel(pixelOptionsOf(adAccounts ?? null, c.account)) : null;
  // HS derives its link from the pasted base + tracking tail + picked pixel; MO from the landing
  // catalog. Either way this string is exactly what launches (and what Copy copies).
  const derivedLink = hsMode
    ? isHttpUrl(c.link)
      ? hsFinalLink(c.link, c.pixel, hs?.acr ?? "", c)
      : ""
    : fullLandingUrl(partner, c.landing, c.gcm, conversions, c.pixel);

  // Copy is offered only once the link is COMPLETE — for gcm partners that means a claimed code, so
  // the button never yields a "?gcm=" link with an empty code (which is also why the preview shows a
  // "…" placeholder until the code lands: preview and Copy now agree — nothing to copy until ready).
  // HS: same contract — no copy until the pixel is picked (the tail ends in pixel=<id>).
  const linkCopyable =
    Boolean(derivedLink) && (hsMode ? Boolean(c.pixel) : partner.usesGcm || aifMode ? Boolean(c.gcm) : true);
  function copyLink() {
    if (!linkCopyable) return;
    navigator.clipboard?.writeText(derivedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  const eventLabel = CONVERSION_EVENTS.find((e) => e.value === c.conversionEvent)?.label ?? "";
  const geo = geoSummary(c.countries);

  function remove() {
    setLeaving(true);
    setTimeout(() => onRemove(c.id), 150);
  }

  return (
    <article
      id={`card-${c.id}`}
      className={
        "group/card relative scroll-mt-24 rounded-2xl border bg-surface " +
        "transition-[border-color,box-shadow] duration-200 hover:shadow-[0_12px_44px_rgba(0,0,0,0.35)] " +
        (highlight ? "border-accent/60 highlight-glow " : "border-line hover:border-line2 ") +
        (leaving ? "animate-card-out" : "animate-card-in")
      }
    >
      {/* header */}
      <div
        onClick={() => onToggleCollapse(c.id)}
        className="flex cursor-pointer select-none items-center gap-3 px-4 py-3"
      >
        <span className="flex h-6 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface2 font-mono text-[11px] text-faint transition-colors group-hover/card:text-dim">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          title={ready ? "Ready to launch" : `Draft — needs: ${missing.join(", ")}`}
          className={
            "h-1.5 w-1.5 shrink-0 rounded-full transition-colors " +
            (ready ? "bg-launch2 shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-warn")
          }
        />
        <span className={"truncate text-[13.5px] font-medium " + (c.name ? "text-ink" : "text-faint")}>
          {displayName || "Untitled campaign"}
        </span>

        {c.collapsed ? (
          <span className="hidden items-center gap-2 text-[11px] text-faint md:flex">
            {c.profile ? (
              <span className="rounded border border-line bg-surface2 px-1.5 py-0.5">
                {c.profile.replace("globecoders-", "")}
              </span>
            ) : null}
            {(partner.usesGcm || aifMode) && c.gcm ? (
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[#9db8ff]">
                {partner.usesGcm ? `gcm ${c.gcm}` : c.gcm}
              </span>
            ) : null}
            <span className="font-mono">${moneyLabel(c.budget)}</span>
            <span>·</span>
            <span>{geo}</span>
            <span>·</span>
            <span>{eventLabel}</span>
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Duplicate" onClick={() => onDuplicate(c.id)}>
            <CopyIcon className="h-4 w-4" />
          </IconButton>
          <IconButton label="Remove" danger onClick={remove}>
            <TrashIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={c.collapsed ? "Expand" : "Collapse"}
            onClick={() => onToggleCollapse(c.id)}
          >
            <ChevronDownIcon
              className={
                "h-4 w-4 transition-transform duration-200 " + (c.collapsed ? "" : "rotate-180")
              }
            />
          </IconButton>
        </span>
      </div>

      {/* body */}
      <div
        className={
          "collapse-grid " +
          (c.collapsed ? "is-collapsed" : "") +
          (settledOpen && !c.collapsed ? " is-open" : "")
        }
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === "grid-template-rows") {
            setSettledOpen(!c.collapsed);
          }
        }}
      >
        <div>
          <div className="flex flex-col gap-6 border-t border-line px-4 pb-5 pt-4">
            {/* setup */}
            <section className="flex flex-col gap-3">
              <SectionLabel icon={<SlidersIcon className="h-3.5 w-3.5" />}>Setup</SectionLabel>
              <div className="grid grid-cols-12 gap-3">
                <Field
                  label="Campaign name"
                  className="col-span-12"
                  hint={hsMode ? "prefix follows LION's format — date, buyer, redirect, geo" : undefined}
                >
                  {displayPrefix ? (
                    <div className="flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface2 transition-[border-color,box-shadow] duration-150 hover:border-line2 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
                      <span
                        title={hsMode ? "LION name prefix (auto-built)" : "Fixed prefix"}
                        className="flex h-full min-w-0 shrink select-none items-center gap-1.5 overflow-hidden whitespace-pre border-r border-line bg-surface px-3 font-mono text-[12px] text-faint"
                      >
                        <LockIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate">{displayPrefix}</span>
                      </span>
                      <input
                        autoComplete="off"
                        spellCheck={false}
                        value={c.name}
                        onChange={(e) => patch({ name: e.target.value })}
                        maxLength={Math.max(1, 400 - displayPrefix.length)}
                        placeholder="suffix — e.g. Auto | vd-01"
                        className="h-full min-w-0 flex-1 bg-transparent px-3 text-[13px] text-ink placeholder:text-faint outline-none"
                      />
                    </div>
                  ) : (
                    <TextInput
                      value={c.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      maxLength={400}
                      placeholder="ZA | Cars | vd-01"
                    />
                  )}
                </Field>
                {partner.usesProfile ? (
                  <Field
                    label="Profile"
                    className="col-span-12 md:col-span-6 xl:col-span-3"
                    error={hsMode && hs?.profiles?.length && !c.profile ? "Pick a profile" : undefined}
                  >
                    <SearchSelect
                      value={c.profile}
                      onChange={(v) =>
                        // A new profile is a new bind space — every dependent pick resets.
                        patch({ profile: v, account: "", page: "", pixel: "", locales: [] })
                      }
                      options={hsMode ? (hs?.profiles ?? []) : PROFILES}
                      placeholder="Search profile"
                      emptyHint={hsMode ? (hs?.profiles ? "No LION profiles" : "Loading profiles…") : undefined}
                      // Closed field reads "glo-01-10 · globecoders-44" (slug + LION's label).
                      metaWhenClosed
                    />
                  </Field>
                ) : null}
                <Field
                  label="Account"
                  className={setupCol}
                  error={
                    acctFull && acctResetAt
                      ? `Account 5/5 — resets in ${fmtCountdown(acctResetAt, limits.skew)}`
                      : hsMode
                        ? c.profile && hsData && !c.account
                          ? "Pick an account"
                          : undefined
                        : partner.accountsFromToken && (adAccounts?.length ?? 0) > 0 && !c.account
                          ? "Pick an account"
                          : undefined
                  }
                >
                  {hsMode ? (
                    <SearchSelect
                      value={c.account}
                      onChange={(v) => patch({ account: v, pixel: "" })}
                      options={decorateAccountOptions(hsAccountOptions, limits)}
                      placeholder="Search account"
                      emptyHint={
                        !c.profile
                          ? "Pick a profile first"
                          : !hsData
                            ? "Loading accounts…"
                            : hsTokenVisible !== null &&
                                (hsData.accounts?.length ?? 0) > 0 &&
                                hsAccountOptions.length === 0
                              ? "No accounts here are visible to our FB token — use the LION API rail (or another profile)"
                              : "No accounts on this profile"
                      }
                      metaWhenClosed
                    />
                  ) : partner.accountsFromToken ? (
                    <SearchSelect
                      value={c.account}
                      onChange={(v) =>
                        patch({
                          account: v,
                          // A roas card keeps its pinned value pixel across account switches —
                          // defaultPixelFor would swap it back to the FARM-1 preference. AIF pixels
                          // are derived from the optimization (normalize re-pins) — never refilled.
                          pixel: aifMode
                            ? c.pixel
                            : kind === "roas"
                              ? ROAS_PIXEL.id
                              : defaultPixelFor(adAccounts ?? null, v, partner.preferredPixel),
                        })
                      }
                      options={decorateAccountOptions(adAccounts ?? [], limits)}
                      placeholder="Search account"
                      emptyHint={adAccounts ? "No accounts on the token" : "Loading accounts…"}
                    />
                  ) : partner.lockedAccount ? (
                    <LockedField value={partner.lockedAccount.name} hint="only" />
                  ) : (
                    <SearchSelect
                      value={c.account}
                      onChange={(v) => patch({ account: v, pixel: "" })}
                      options={accounts}
                      placeholder="Search account"
                      emptyHint="Pick a profile first"
                    />
                  )}
                </Field>
                <Field
                  label={partner.pageLabel}
                  className={setupCol}
                  error={
                    hsMode
                      ? c.profile && hsData && !c.page
                        ? "Pick a page"
                        : undefined
                      : partner.fanpagesFromToken && fanpages != null && !c.page
                        ? "Pick a fanpage"
                        : undefined
                  }
                >
                  {hsMode ? (
                    <SearchSelect
                      value={c.page}
                      onChange={(v) => patch({ page: v })}
                      options={hsData?.pages ?? []}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={
                        !c.profile ? "Pick a profile first" : hsData ? "No pages on this profile" : "Loading pages…"
                      }
                      metaWhenClosed
                    />
                  ) : partner.fanpagesFromToken ? (
                    <SearchSelect
                      value={c.page}
                      onChange={(v) => patch({ page: v })}
                      options={fanpages ?? []}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={fanpages ? "No fanpages on the token" : "Loading fanpages…"}
                      metaWhenClosed
                    />
                  ) : locked ? (
                    <LockedField value={partner.fanpages[0] ?? ""} hint="only" />
                  ) : (
                    <SearchSelect
                      value={c.page}
                      onChange={(v) => patch({ page: v })}
                      options={pageOptions}
                      placeholder={partner.pagePlaceholder}
                      emptyHint={partner.fanpages.length ? "No matches" : "Pick a profile first"}
                    />
                  )}
                </Field>
                <Field
                  label="Pixel"
                  className={setupCol}
                  hint={
                    aifMode
                      ? kind === "roas"
                        ? "pinned by min ROAS"
                        : conversions
                          ? "postback CAPI pixel"
                          : "clicks need no pixel"
                      : !hsMode && partner.accountsFromToken && kind === "roas"
                        ? "pinned by min ROAS"
                        : undefined
                  }
                  error={
                    hsMode
                      ? // Quiet until the fanka is picked — that's where the pixel step starts
                        // (single-pixel accounts then self-fill and never show this nag).
                        c.account && c.page && Array.isArray(hsPixels) && hsPixels.length > 0 && !c.pixel
                        ? "Pick a pixel"
                        : undefined
                      : aifMode
                        ? // Conversions on an account whose loaded catalog row derives NO pixel
                          // would only fail at launch — name the BM remedy right on the field.
                          conversions && c.account && adAccounts?.some((a) => a.value === c.account) && !aifPixel
                          ? "no pixel on this account — share the AIF pixel in BM or switch to Clicks"
                          : undefined
                        : !aifMode && partner.accountsFromToken && kind === "roas" && c.pixel !== ROAS_PIXEL.id
                          ? `min ROAS runs only on ${ROAS_PIXEL.name}`
                          : !aifMode && partner.accountsFromToken && c.account && !c.pixel
                            ? "Pick a pixel"
                            : undefined
                  }
                >
                  {aifMode ? (
                    // The pixel is never picked on this rail: conversions run ONLY on the picked
                    // account's own postback pixel (where the CAPI forwarder lands Purchases),
                    // derived from the token's catalog; clicks carry no pixel at all — both
                    // server-enforced, shown here as locked truth.
                    conversions ? (
                      <LockedField
                        value={
                          aifPixel
                            ? `${aifPixel.name} · ${aifPixel.id}`
                            : !c.account
                              ? "Pick an account first"
                              : adAccounts
                                ? "No pixel on this account"
                                : "Loading pixels…"
                        }
                        hint="from token"
                        mono={Boolean(aifPixel)}
                      />
                    ) : (
                      <LockedField value="No pixel — click optimization" hint="auto" />
                    )
                  ) : hsMode ? (
                    <SearchSelect
                      // While the pixel list is still loading there is no name to show — the raw
                      // id would render as bare digits, so the field shows its placeholder instead.
                      value={Array.isArray(hsPixels) ? c.pixel : ""}
                      onChange={(v) => patch({ pixel: v })}
                      options={(hsPixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                      placeholder="Search pixel"
                      emptyHint={
                        !c.account
                          ? "Pick an account first"
                          : hsPixels
                            ? "No pixels on this account"
                            : "Loading pixels…"
                      }
                    />
                  ) : partner.accountsFromToken && kind === "roas" ? (
                    // Min-ROAS: the value pixel is the ONLY allowed one — rendered locked, and the
                    // switch to the strategy already patched c.pixel to it.
                    <LockedField value={`${ROAS_PIXEL.name} · ${ROAS_PIXEL.id}`} hint="min ROAS" mono />
                  ) : partner.accountsFromToken ? (
                    <SearchSelect
                      value={c.pixel}
                      onChange={(v) => patch({ pixel: v })}
                      options={pixelOptionsOf(adAccounts ?? null, c.account).map((p) => ({
                        value: p.id,
                        label: p.name,
                        meta: p.id,
                      }))}
                      placeholder="Search pixel"
                      emptyHint={c.account ? "No pixels on this account" : "Pick an account first"}
                    />
                  ) : partner.lockedPixel ? (
                    <LockedField value={partner.lockedPixel.id} hint="auto" mono />
                  ) : (
                    <SearchSelect
                      value={c.pixel}
                      onChange={(v) => patch({ pixel: v })}
                      options={pixels}
                      placeholder="Search pixel"
                      emptyHint="Pick an account first"
                    />
                  )}
                </Field>
              </div>
            </section>

            {/* delivery */}
            <section className="flex flex-col gap-3">
              <SectionLabel icon={<TargetIcon className="h-3.5 w-3.5" />}>Delivery</SectionLabel>
              <div className="grid grid-cols-12 gap-3">
                {!aifMode ? (
                  <Field label="Objective" className={hsMode ? "col-span-6 md:col-span-4" : "col-span-6 md:col-span-3"}>
                    <Select
                      value={c.objective}
                      onChange={(e) => {
                        const objective = e.target.value;
                        // Events are objective-specific — keep the current one if still valid, else
                        // fall back to the first event allowed for the new objective.
                        const allowed = conversionEventsFor(objective);
                        const conversionEvent = allowed.some((o) => o.value === c.conversionEvent)
                          ? c.conversionEvent
                          : allowed[0]?.value ?? c.conversionEvent;
                        patch({ objective, conversionEvent });
                      }}
                      options={OBJECTIVES}
                    />
                  </Field>
                ) : null}
                {/* The optimization toggle is an MO funnel concept — HS tails get fire=click
                    unconditionally on HIGH ADX (redirect type decides, see hsLinkSegments). */}
                {!hsMode ? (
                  <Field
                    label="Optimization"
                    className={aifMode ? "col-span-6" : "col-span-6 md:col-span-3"}
                    hint={
                      kind === "roas"
                        ? "pinned by min ROAS"
                        : conversions
                          ? aifMode
                            ? "Purchase on the AIF pixel"
                            : "link gets &fire=click"
                          : undefined
                    }
                  >
                    <Select
                      value={kind === "roas" ? "conversions" : c.optimization}
                      onChange={(e) =>
                        patch({ optimization: e.target.value as Campaign["optimization"] })
                      }
                      options={OPTIMIZATIONS}
                      disabled={kind === "roas"}
                    />
                  </Field>
                ) : null}
                <Field
                  label="Bid strategy"
                  className={hsMode ? "col-span-6 md:col-span-4" : aifMode ? "col-span-6" : "col-span-6 md:col-span-3"}
                >
                  <Select
                    value={c.bidStrategy}
                    onChange={(e) => {
                      const bidStrategy = e.target.value;
                      // Min-ROAS optimizes purchase value — the event pins to Purchase, the
                      // optimization pins to conversions (MO's link keeps &fire=click), and the
                      // pixel pins to MO's value pixel VD-C1-HS-1. AIF's pixel stays DERIVED
                      // from the token's account data (server truth) — nothing to patch.
                      if (bidKind(bidStrategy) === "roas") {
                        patch({
                          bidStrategy,
                          conversionEvent: "PURCHASE",
                          optimization: "conversions",
                          ...(!aifMode && partner.accountsFromToken ? { pixel: ROAS_PIXEL.id } : {}),
                        });
                      } else {
                        // Leaving min-ROAS unlocks the pixel back to the partner default (bid
                        // launches keep the choice, defaulting to GC for MO). AIF pixels stay
                        // derived from the optimization (applyPartnerLocks) — never refilled.
                        patch({
                          bidStrategy,
                          ...(kind === "roas" && !aifMode && partner.accountsFromToken
                            ? { pixel: defaultPixelFor(adAccounts ?? null, c.account, partner.preferredPixel) }
                            : {}),
                        });
                      }
                    }}
                    options={BID_STRATEGIES}
                  />
                </Field>
                {!aifMode ? (
                  <Field
                    label="Conversion event"
                    className={hsMode ? "col-span-6 md:col-span-4" : "col-span-6 md:col-span-3"}
                    hint={kind === "roas" ? "pinned by min ROAS" : undefined}
                  >
                    <Select
                      value={kind === "roas" ? "PURCHASE" : c.conversionEvent}
                      onChange={(e) => patch({ conversionEvent: e.target.value })}
                      options={conversionEventsFor(c.objective)}
                      disabled={kind === "roas"}
                    />
                  </Field>
                ) : null}
                <Field
                  label="Daily budget"
                  className="col-span-6"
                  hint={hsMode && hsCurrency ? `in ${hsCurrency} (account currency)` : undefined}
                >
                  <MoneyInput
                    value={c.budget}
                    onChange={(e) => patch({ budget: limitMoney(e.target.value, 10000) })}
                    placeholder="7"
                    maxLength={8}
                  />
                </Field>
                <Field
                  label={kind === "roas" ? "ROAS goal *" : bidCapEnabled ? "Bid cap *" : "Bid cap"}
                  className="col-span-6"
                  hint={
                    kind === "roas"
                      ? // Live echo of normalizeRoasGoal: a percent/×10 entry shows the goal it
                        // will actually set, a clean decimal shows the semantics reminder.
                        roasEntered > 0 && roasGoal != null && roasGoal !== roasEntered
                        ? `sets goal ${String(roasGoal).replace(".", ",")} — % form auto-converted`
                        : "decimal: 0,30 = 30%"
                      : bidCapEnabled
                        ? "Digits fill cents — 50 → 0,50"
                        : "Lowest cost bids automatically"
                  }
                  error={
                    bidAmountMissing(c)
                      ? "Required for this bid strategy"
                      : kind === "roas" && roasEntered > 0 && roasGoal == null
                        ? "10–20 is ambiguous — type the decimal goal (0,30 = 30%)"
                        : undefined
                  }
                >
                  <MoneyInput
                    value={c.bidCap}
                    onChange={(e) =>
                      patch({ bidCap: limitMoneyCents(e.target.value, kind === "roas" ? 100 : 1000) })
                    }
                    placeholder={kind === "roas" ? "0,30" : "0,50"}
                    disabled={!bidCapEnabled}
                    maxLength={7}
                  />
                </Field>
              </div>
            </section>

            {/* creative */}
            <section className="flex flex-col gap-3">
              <SectionLabel icon={<MegaphoneIcon className="h-3.5 w-3.5" />}>Creative</SectionLabel>
              <div className="grid grid-cols-12 gap-3">
                <div className="col-span-12 flex flex-col gap-3 lg:col-span-7">
                  <Field label="Title">
                    <TextArea
                      value={c.title}
                      onChange={(e) => patch({ title: e.target.value })}
                      maxLength={255}
                      placeholder="Ad title"
                      className="min-h-[56px]"
                      rows={2}
                    />
                  </Field>
                  <Field label="Copy">
                    <TextArea
                      value={c.copy}
                      onChange={(e) => patch({ copy: e.target.value })}
                      maxLength={2000}
                      placeholder="Primary text"
                      rows={3}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="CTA">
                      <Select
                        value={c.cta}
                        onChange={(e) => patch({ cta: e.target.value })}
                        options={CTAS}
                      />
                    </Field>
                    {/* Redirect type is an HS concept only (drives the LION tail/link — see
                        hsLinkSegments); MO/AIF links ignore it entirely, so the field renders
                        nowhere else (owner ask 09-01 — it used to show on MO doing nothing). */}
                    {hsMode ? (
                      <Field label="Redirect type">
                        <Select
                          value={c.redirectType}
                          onChange={(e) => patch({ redirectType: e.target.value })}
                          options={REDIRECT_TYPES}
                        />
                      </Field>
                    ) : null}
                  </div>
                  {partner.usesGcm ? (
                    <>
                      <Field label="Landing">
                        <SearchSelect
                          value={c.landing}
                          onChange={(v) => patch({ landing: v })}
                          options={landingOptions}
                          placeholder="Search landing"
                          emptyHint="No landings match"
                          facets
                        />
                      </Field>
                      <Field label="Destination link">
                        <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
                          {c.landing ? (
                            <>
                              <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                                {landingUrlSegments(partner, c.landing, c.gcm || "…", conversions, c.pixel).map(
                                  (seg, i) => (
                                    <span key={i} className={LINK_ROLE_CLASS[seg.role]}>
                                      {seg.text}
                                    </span>
                                  ),
                                )}
                              </div>
                              <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                                <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                                  Tracking link
                                </span>
                                <CopyLinkButton
                                  copied={copied}
                                  disabled={!linkCopyable}
                                  title="Waiting for a gcm code…"
                                  onClick={copyLink}
                                />
                              </div>
                            </>
                          ) : (
                            <div className="px-3 py-2 font-mono text-[11px] text-faint">
                              Select a landing to build the link
                            </div>
                          )}
                        </div>
                      </Field>
                    </>
                  ) : aifMode ? (
                    <Field
                      label="Destination article"
                      hint="the partner's standard articles — the RW link carries the bare slug"
                    >
                      <div>
                        <SearchSelect
                          value={c.landing}
                          onChange={(v) => patch({ landing: v })}
                          options={landingOptions}
                          placeholder="Search article"
                          emptyHint="No articles match"
                          facets
                        />
                        {/* RW-link preview — the EXACT link the launch will send (same segments
                            the server joins); brand slot fills once the registry hands a code. */}
                        {c.landing ? (
                          <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface2/50">
                            <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                              {landingUrlSegments(partner, c.landing, c.gcm || "…", conversions).map((seg, i) => (
                                <span key={i} className={LINK_ROLE_CLASS[seg.role]}>
                                  {seg.text}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                              <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                                RW link
                              </span>
                              <CopyLinkButton
                                copied={copied}
                                disabled={!linkCopyable}
                                title="Waiting for a brand…"
                                onClick={copyLink}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </Field>
                  ) : (
                    <Field
                      label="Destination link"
                      hint={hsMode ? "paste the bare landing — tracking + the picked pixel are appended" : undefined}
                      error={hsMode && c.link.trim() !== "" && !isHttpUrl(c.link) ? "Must be an http(s) URL" : undefined}
                    >
                      <div>
                        <TextInput
                          value={c.link}
                          onChange={(e) => patch({ link: e.target.value })}
                          maxLength={2000}
                          placeholder="https://…"
                          className="font-mono text-[12px]"
                        />
                        {/* HS link builder preview — the EXACT link the launch will send (same
                            segments the payload joins); pixel slot mirrors the Pixel field live. */}
                        {hsMode && isHttpUrl(c.link) ? (
                          <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface2/50">
                            <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                              {hsLinkSegments(c.link, c.pixel || "…", hs?.acr ?? "", c).map((seg, i) => (
                                <span key={i} className={LINK_ROLE_CLASS[seg.role]}>
                                  {seg.text}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                              <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                                Final launch link
                              </span>
                              <CopyLinkButton
                                copied={copied}
                                disabled={!linkCopyable}
                                title="Pick a pixel first"
                                onClick={copyLink}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </Field>
                  )}
                  {!hsMode ? (
                    <Field label="Headline">
                      <TextInput
                        value={c.headline}
                        onChange={(e) => patch({ headline: e.target.value })}
                        maxLength={255}
                        placeholder="Headline"
                      />
                    </Field>
                  ) : null}
                </div>

                <Field
                  label="Creatives"
                  className="col-span-12 lg:col-span-5"
                  hint={hsMode ? "one ad per creative (LION)" : undefined}
                >
                  <div className="flex flex-col gap-2">
                    <Dropzone
                      files={c.files}
                      onChange={(files) => patch({ files })}
                      maxFiles={partner.maxCreatives}
                      covers={coversEnabled}
                    />
                    {hsMode ? <AddByUrl onAdd={(item) => patch({ files: [...c.files, item] })} /> : null}
                    {onApplyFilesToAll && c.files.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => onApplyFilesToAll(c.files)}
                        className={
                          "flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2/50 py-1.5 " +
                          "text-[11.5px] font-medium text-dim transition-colors hover:border-accent/40 hover:bg-accent/5 " +
                          "hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        }
                      >
                        <CopyIcon className="h-3.5 w-3.5" />
                        Apply creative to all cards
                      </button>
                    ) : null}
                  </div>
                </Field>
              </div>
            </section>

            {/* targeting */}
            <section className="flex flex-col gap-3">
              <SectionLabel icon={<GlobeIcon className="h-3.5 w-3.5" />}>Targeting</SectionLabel>
              <div className="grid grid-cols-12 gap-3">
                <Field label="Geo" className="col-span-12 xl:col-span-6">
                  <MultiSelect
                    values={c.countries}
                    onChange={(countries) => patch({ countries })}
                    options={COUNTRIES.map((x) => ({ value: x.code, label: x.name }))}
                    presets={COUNTRY_PRESETS}
                    exclusiveValues={["WW"]}
                    chipMode="code"
                    placeholder="Search country"
                  />
                </Field>
                <Field
                  label="Languages"
                  className="col-span-12 xl:col-span-6"
                  hint={
                    hsMode
                      ? !c.profile
                        ? "pick a profile first"
                        : hsData
                          ? "FB locales from the profile · empty = all"
                          : "loading locales…"
                      : undefined
                  }
                >
                  <MultiSelect
                    values={c.locales}
                    onChange={(locales) => patch({ locales })}
                    options={
                      hsMode
                        ? (hsData?.locales ?? []).map((l) => ({ value: l.id, label: l.name }))
                        : LOCALES.map((l) => ({ value: l, label: l }))
                    }
                    placeholder="Search language"
                  />
                </Field>
                <Field label="Category" className="col-span-6 xl:col-span-3">
                  <Select
                    value={c.category}
                    onChange={(e) => patch({ category: e.target.value })}
                    options={CATEGORIES}
                  />
                </Field>
                <Field label="Placement" className="col-span-6 xl:col-span-3">
                  <Select
                    value={c.placement}
                    onChange={(e) => patch({ placement: e.target.value })}
                    options={PLACEMENTS}
                  />
                </Field>
                <Field label="Age" className="col-span-6 xl:col-span-3">
                  <Select
                    value={c.ageMin}
                    onChange={(e) => patch({ ageMin: e.target.value })}
                    options={AGES}
                  />
                </Field>
                <Field label="User OS" className="col-span-6 xl:col-span-3">
                  <Select
                    value={c.userOs}
                    onChange={(e) => patch({ userOs: e.target.value })}
                    options={OS_OPTIONS}
                  />
                </Field>
              </div>
            </section>
          </div>
        </div>
      </div>
    </article>
  );
}

export const CampaignCard = memo(CampaignCardBase);
