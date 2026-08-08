"use client";

import { useState } from "react";
import type { Campaign } from "@/lib/types";
import { bidAmountMissing, fullName, isReady, limitMoney, moneyLabel } from "@/lib/types";
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
  PARAM_MODES,
  PLACEMENTS,
  PROFILES,
  REDIRECT_TYPES,
  accountsFor,
  pagesFor,
  pixelsFor,
} from "@/lib/catalog";
import { type PartnerConfig, fullLandingUrl, launchReadyOpts } from "@/lib/partners";
import type { FanpageOption } from "./use-fanpages";
import { type AdAccountOption, defaultPixelFor, pixelOptionsOf } from "./use-adaccounts";
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

export function CampaignCard({
  campaign: c,
  index,
  partner,
  fanpages,
  adAccounts,
  highlight,
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
  /** Focus-pulse this card after a jump from the Launch bay. */
  highlight?: boolean;
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
  const ready = isReady(c, launchReadyOpts(partner));
  const bidCapEnabled = c.bidStrategy !== "LOWEST_COST_WITHOUT_CAP";

  // Indians pin one account → its pixel and fanpage render locked, not searchable.
  const locked = Boolean(partner.lockedAccount);
  // Profile is a LION concept (Brazilians); hidden for direct-API partners like Indians.
  const setupCol = partner.usesProfile
    ? "col-span-12 md:col-span-6 xl:col-span-3"
    : "col-span-12 md:col-span-6 xl:col-span-4";
  // Fanpages (Indians) come from the partner, not the profile; other partners use profile pages.
  const pageOptions = partner.fanpages.length ? partner.fanpages : pagesFor(c.profile);
  const landingOptions = partner.landings.map((l) => ({ value: l.slug, label: l.title, meta: l.lang }));
  const conversions = c.optimization === "conversions";
  const derivedLink = fullLandingUrl(partner, c.landing, c.gcm, conversions);

  function copyLink() {
    if (!derivedLink) return;
    navigator.clipboard?.writeText(derivedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  const eventLabel = CONVERSION_EVENTS.find((e) => e.value === c.conversionEvent)?.label ?? "";
  const geoSummary =
    c.countries[0] === "WW"
      ? "World"
      : c.countries.length === 0
        ? "no geo"
        : c.countries.length <= 3
          ? c.countries.join(", ")
          : `${c.countries.length} geo`;

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
          title={ready ? "Ready to launch" : "Draft — name, profile and geo required"}
          className={
            "h-1.5 w-1.5 shrink-0 rounded-full transition-colors " +
            (ready ? "bg-launch2 shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-warn")
          }
        />
        <span className={"truncate text-[13.5px] font-medium " + (c.name ? "text-ink" : "text-faint")}>
          {fullName(c) || "Untitled campaign"}
        </span>

        {c.collapsed ? (
          <span className="hidden items-center gap-2 text-[11px] text-faint md:flex">
            {c.profile ? (
              <span className="rounded border border-line bg-surface2 px-1.5 py-0.5">
                {c.profile.replace("globecoders-", "")}
              </span>
            ) : null}
            {partner.usesGcm && c.gcm ? (
              <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[#9db8ff]">
                gcm {c.gcm}
              </span>
            ) : null}
            <span className="font-mono">${moneyLabel(c.budget)}</span>
            <span>·</span>
            <span>{geoSummary}</span>
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
                <Field label="Campaign name" className="col-span-12">
                  {c.namePrefix ? (
                    <div className="flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface2 transition-[border-color,box-shadow] duration-150 hover:border-line2 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
                      <span
                        title="Fixed prefix"
                        className="flex h-full shrink-0 select-none items-center gap-1.5 whitespace-pre border-r border-line bg-surface px-3 font-mono text-[12px] text-faint"
                      >
                        <LockIcon className="h-3 w-3 shrink-0" />
                        {c.namePrefix}
                      </span>
                      <input
                        autoComplete="off"
                        spellCheck={false}
                        value={c.name}
                        onChange={(e) => patch({ name: e.target.value })}
                        maxLength={Math.max(1, 400 - c.namePrefix.length)}
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
                  <Field label="Profile" className="col-span-12 md:col-span-6 xl:col-span-3">
                    <SearchSelect
                      value={c.profile}
                      onChange={(v) => patch({ profile: v, account: "", page: "", pixel: "" })}
                      options={PROFILES}
                      placeholder="Search profile"
                    />
                  </Field>
                ) : null}
                <Field
                  label="Account"
                  className={setupCol}
                  error={partner.accountsFromToken && !c.account ? "Pick an account" : undefined}
                >
                  {partner.accountsFromToken ? (
                    <SearchSelect
                      value={c.account}
                      onChange={(v) =>
                        patch({ account: v, pixel: defaultPixelFor(adAccounts ?? null, v, partner.preferredPixel) })
                      }
                      options={adAccounts ?? []}
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
                  error={partner.fanpagesFromToken && !c.page ? "Pick a fanpage" : undefined}
                >
                  {partner.fanpagesFromToken ? (
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
                  error={partner.accountsFromToken && c.account && !c.pixel ? "Pick a pixel" : undefined}
                >
                  {partner.accountsFromToken ? (
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
                <Field label="Objective" className="col-span-6 md:col-span-3">
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
                <Field
                  label="Optimization"
                  className="col-span-6 md:col-span-3"
                  hint={conversions ? "link gets &fire=click" : undefined}
                >
                  <Select
                    value={c.optimization}
                    onChange={(e) =>
                      patch({ optimization: e.target.value as Campaign["optimization"] })
                    }
                    options={OPTIMIZATIONS}
                  />
                </Field>
                <Field label="Bid strategy" className="col-span-6 md:col-span-3">
                  <Select
                    value={c.bidStrategy}
                    onChange={(e) => patch({ bidStrategy: e.target.value })}
                    options={BID_STRATEGIES}
                  />
                </Field>
                <Field label="Conversion event" className="col-span-6 md:col-span-3">
                  <Select
                    value={c.conversionEvent}
                    onChange={(e) => patch({ conversionEvent: e.target.value })}
                    options={conversionEventsFor(c.objective)}
                  />
                </Field>
                <Field label="Daily budget" className="col-span-6">
                  <MoneyInput
                    value={c.budget}
                    onChange={(e) => patch({ budget: limitMoney(e.target.value, 10000) })}
                    placeholder="7"
                    maxLength={8}
                  />
                </Field>
                <Field
                  label={bidCapEnabled ? "Bid cap *" : "Bid cap"}
                  className="col-span-6"
                  hint={bidCapEnabled ? undefined : "Lowest cost bids automatically"}
                  error={bidAmountMissing(c) ? "Required for this bid strategy" : undefined}
                >
                  <MoneyInput
                    value={c.bidCap}
                    onChange={(e) => patch({ bidCap: limitMoney(e.target.value, 1000) })}
                    placeholder="0,50"
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
                    <Field label="Redirect type">
                      <Select
                        value={c.redirectType}
                        onChange={(e) => patch({ redirectType: e.target.value })}
                        options={REDIRECT_TYPES}
                      />
                    </Field>
                  </div>
                  {c.redirectType === "#ADX" ? (
                    <div className="animate-pop-in">
                      <Field label="Param mode">
                        <Select
                          value={c.paramMode}
                          onChange={(e) => patch({ paramMode: e.target.value })}
                          options={PARAM_MODES}
                        />
                      </Field>
                    </div>
                  ) : null}
                  {c.redirectType === "HIGH ADX" ? (
                    <button
                      type="button"
                      className={
                        "animate-pop-in flex h-9 w-full items-center justify-center gap-2 rounded-lg " +
                        "border border-warn/40 bg-warn/5 text-[12.5px] font-medium text-warn " +
                        "transition-all duration-150 hover:bg-warn/10 active:scale-[0.99] " +
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn/40"
                      }
                    >
                      <SlidersIcon className="h-3.5 w-3.5" />
                      High offer config
                    </button>
                  ) : null}
                  {partner.usesGcm ? (
                    <>
                      <Field label="Landing">
                        <SearchSelect
                          value={c.landing}
                          onChange={(v) => patch({ landing: v })}
                          options={landingOptions}
                          placeholder="Search landing"
                          emptyHint="No landings"
                        />
                      </Field>
                      <Field label="Destination link">
                        <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
                          {c.landing ? (
                            <>
                              <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                                <span className="text-faint">{partner.landingBase}/</span>
                                <span className="text-ink">{c.landing}</span>
                                <span className="text-faint">?gcm=</span>
                                <span className="text-[#9db8ff]">{c.gcm || "…"}</span>
                                <span className="text-faint">
                                  {`&utm_source=facebook${partner.nameTier ? `&utm_medium=${partner.nameTier}` : ""}&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}`}
                                </span>
                                {conversions ? <span className="text-launch2">{"&fire=click"}</span> : null}
                              </div>
                              <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                                <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                                  Tracking link
                                </span>
                                <button
                                  type="button"
                                  onClick={copyLink}
                                  aria-label={copied ? "Link copied to clipboard" : "Copy link to clipboard"}
                                  className={
                                    "group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold " +
                                    "transition-all duration-200 active:scale-[0.94] focus-visible:outline-none " +
                                    "focus-visible:ring-2 focus-visible:ring-accent/40 " +
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
                  ) : (
                    <Field label="Destination link">
                      <TextInput
                        value={c.link}
                        onChange={(e) => patch({ link: e.target.value })}
                        maxLength={2000}
                        placeholder="https://…"
                        className="font-mono text-[12px]"
                      />
                    </Field>
                  )}
                  <Field label="Headline">
                    <TextInput
                      value={c.headline}
                      onChange={(e) => patch({ headline: e.target.value })}
                      maxLength={255}
                      placeholder="Headline"
                    />
                  </Field>
                </div>

                <Field label="Creatives" className="col-span-12 lg:col-span-5">
                  <div className="flex flex-col gap-2">
                    <Dropzone files={c.files} onChange={(files) => patch({ files })} maxFiles={partner.maxCreatives} />
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
                <Field label="Languages" className="col-span-12 xl:col-span-6">
                  <MultiSelect
                    values={c.locales}
                    onChange={(locales) => patch({ locales })}
                    options={LOCALES.map((l) => ({ value: l, label: l }))}
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
