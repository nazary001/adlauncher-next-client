"use client";

import type { Campaign } from "@/lib/types";
import { fullName, isLaunchable, moneyLabel, parseMoney } from "@/lib/types";
import { CONVERSION_EVENTS, geoSummary } from "@/lib/catalog";
import { hsFullName, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { type PartnerConfig, launchReadyOpts, markerPool } from "@/lib/partners";
import type { HsLaunchChannel } from "./hs-task-manager";
import { CheckIcon, EyeIcon, RocketIcon } from "./icons";

export function LaunchRail({
  campaigns,
  partner,
  hsAcr,
  hsChannel = "lion",
  hsTokenReady = false,
  onHsChannel,
  previewed,
  justQueued,
  poolFree,
  onJump,
  onPreview,
  onLaunch,
}: {
  campaigns: Campaign[];
  partner: PartnerConfig;
  /** LION media-buyer acronym — the HS name preview needs it (empty while loading). */
  hsAcr?: string;
  /** HS launch rail pick (LION create weapon vs FB Token direct build). */
  hsChannel?: HsLaunchChannel;
  /** FB Token rail provisioned server-side — until then the Token option renders disabled. */
  hsTokenReady?: boolean;
  onHsChannel?: (ch: HsLaunchChannel) => void;
  previewed: boolean;
  /** Count just sent to the Task Manager — shows a brief confirmation; campaigns stay on the board. */
  justQueued: number;
  /** Free gcm codes left in the registry pool (null while loading). 0 → launching hard-blocked. */
  poolFree?: number | null;
  /** Jump the page to a campaign card and focus-pulse it. */
  onJump: (id: string) => void;
  onPreview: () => void;
  onLaunch: () => void;
}) {
  const total = campaigns.reduce((s, c) => s + parseMoney(c.budget), 0);
  const opts = launchReadyOpts(partner);
  const readyCount = campaigns.filter((c) => isLaunchable(c, opts)).length;
  const allReady = campaigns.length > 0 && readyCount === campaigns.length;
  // Registry pool exhausted → the button locks even for cards holding stale code previews: with
  // every code row taken, their claims can only fail server-side (the claim walks 400s then throws).
  const pool = markerPool(partner);
  const gcmBlocked = Boolean(pool) && poolFree === 0;
  const ddmm = partner.lionLaunch ? todaySaoPauloDDMM() : "";
  const nameOf = (c: Campaign) =>
    partner.lionLaunch ? (c.name.trim() ? hsFullName(c, hsAcr ?? "", ddmm) : "") : fullName(c);

  return (
    <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
      {/* Capped to the viewport on desktop: with a long wave only the campaign LIST scrolls
          (min-h-0 makes it the one shrinkable flex child) while the header, total and the
          Preview/Launch buttons stay on screen — no page-scrolling to reach Launch. */}
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-6rem)]">
        <div className="flex shrink-0 items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
            Launch bay
          </span>
          <span
            className={
              "rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] " +
              (allReady
                ? "border-launch/30 bg-launch/10 text-launch2"
                : "border-warn/25 bg-warn/5 text-warn")
            }
          >
            {readyCount}/{campaigns.length} ready
          </span>
        </div>

        {campaigns.length === 0 ? (
          <p className="py-4 text-center text-[12px] leading-relaxed text-faint">
            No campaigns yet.
            <br />
            Add one to arm the bay.
          </p>
        ) : (
          <div className="-mx-2 flex min-h-0 flex-col overflow-y-auto overscroll-contain">
            {campaigns.map((c, i) => {
              const ready = isLaunchable(c, opts);
              const eventLabel =
                CONVERSION_EVENTS.find((e) => e.value === c.conversionEvent)?.label ?? "";
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onJump(c.id)}
                  title="Jump to this campaign"
                  style={{ animationDelay: `${i * 45}ms` }}
                  className="group animate-row-in flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <span className="w-5 shrink-0 font-mono text-[10.5px] text-faint transition-colors group-hover:text-[#9db8ff]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        "block truncate text-[12.5px] font-medium " +
                        (c.name ? "text-ink" : "text-faint")
                      }
                    >
                      {nameOf(c) || "Untitled campaign"}
                    </span>
                    <span className="block truncate text-[10.5px] text-faint">
                      {(pool
                        ? c.gcm
                          ? partner.usesGcm
                            ? `gcm ${c.gcm}`
                            : c.gcm
                          : `no ${pool.label}`
                        : c.profile
                          ? c.profile.replace("globecoders-", "")
                          : "no profile") +
                        " · " +
                        geoSummary(c.countries) +
                        " · " +
                        eventLabel}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-dim">
                    ${moneyLabel(c.budget)}
                  </span>
                  {previewed && ready ? (
                    <CheckIcon className="h-3.5 w-3.5 shrink-0 text-launch2" />
                  ) : (
                    <span
                      className={
                        "h-1.5 w-1.5 shrink-0 rounded-full " + (ready ? "bg-launch2" : "bg-warn")
                      }
                    />
                  )}
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-faint opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-hover:text-[#9db8ff]"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              );
            })}
          </div>
        )}

        <div className="shrink-0 border-t border-line pt-3">
          <div className="flex items-end justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
              Total / day
            </span>
            <span className="font-mono text-[22px] font-medium leading-none tabular-nums text-ink">
              ${moneyLabel(total)}
            </span>
          </div>
          <p className="mt-1 text-right text-[10.5px] text-faint">
            across {campaigns.length} campaign{campaigns.length === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          {/* HS launch rail: LION's create weapon vs our FB token building the same tree
              directly on the Graph (partner-approved bypass — same name pattern, same binds,
              +30 min delivery gap). One pick for the whole wave. */}
          {partner.lionLaunch ? (
            <div className="flex flex-col gap-1">
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {(
                  [
                    { key: "lion" as const, label: "LION API", ready: true },
                    { key: "token" as const, label: "FB Token", ready: hsTokenReady },
                  ]
                ).map((opt) => {
                  const active = hsChannel === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!opt.ready}
                      aria-pressed={active}
                      title={opt.ready ? undefined : "FB token not configured on the server (FB_HS_LAUNCH_TOKEN)"}
                      onClick={() => onHsChannel?.(opt.key)}
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
                {hsChannel === "token"
                  ? "Our FB token builds the tree · delivery starts +30 min"
                  : "LION profiles build the tree on the weapon side"}
              </p>
            </div>
          ) : null}
          <button
            type="button"
            onClick={onPreview}
            disabled={campaigns.length === 0}
            className={
              "flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 " +
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
              onClick={onLaunch}
              disabled={readyCount === 0 || gcmBlocked}
              className={
                "animate-pop-in group flex h-11 w-full items-center justify-center gap-2 rounded-xl " +
                "bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] " +
                "shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 " +
                "hover:shadow-[0_10px_36px_rgba(16,185,129,0.5)] hover:brightness-110 active:scale-[0.98] " +
                "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
              }
            >
              <RocketIcon className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-[1px] group-hover:translate-x-[1px]" />
              Launch {readyCount} campaign{readyCount === 1 ? "" : "s"}
            </button>
          ) : null}

          {gcmBlocked ? (
            <p className="text-center text-[11px] font-semibold leading-relaxed text-danger">
              No free {pool?.label ?? "gcm"} codes left — launching is blocked until codes are freed in the registry.
            </p>
          ) : justQueued > 0 ? (
            <p className="animate-pop-in text-center text-[11px] font-medium leading-relaxed text-launch2">
              ✓ {justQueued} sent to Task Manager · still here to tweak &amp; relaunch
            </p>
          ) : (
            <p className="text-center text-[10.5px] leading-relaxed text-faint">
              {readyCount > 0
                ? partner.lionLaunch
                  ? hsChannel === "token"
                    ? "Queued to HS Task Manager · FB token builds the ads · starts in 30 min"
                    : "Queued to HS Task Manager · LION builds the ads"
                  : "Queued to Task Manager · goes live on create"
                : `${partner.launchNote} · needs a creative`}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
