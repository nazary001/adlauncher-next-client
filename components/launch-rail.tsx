"use client";

import type { Campaign } from "@/lib/types";
import { fullName, isLaunchable, moneyLabel, parseMoney } from "@/lib/types";
import { CONVERSION_EVENTS, countryName } from "@/lib/catalog";
import type { PartnerConfig } from "@/lib/partners";
import { CheckIcon, EyeIcon, RocketIcon } from "./icons";

function geoLabel(c: Campaign): string {
  if (c.countries.length === 0) return "no geo";
  if (c.countries[0] === "WW") return "World";
  if (c.countries.length <= 2) return c.countries.map(countryName).join(", ");
  return `${c.countries.length} geos`;
}

export function LaunchRail({
  campaigns,
  partner,
  previewed,
  justQueued,
  onJump,
  onPreview,
  onLaunch,
}: {
  campaigns: Campaign[];
  partner: PartnerConfig;
  previewed: boolean;
  /** Count just sent to the Task Manager — shows a brief confirmation; campaigns stay on the board. */
  justQueued: number;
  /** Jump the page to a campaign card and focus-pulse it. */
  onJump: (id: string) => void;
  onPreview: () => void;
  onLaunch: () => void;
}) {
  const total = campaigns.reduce((s, c) => s + parseMoney(c.budget), 0);
  const opts = { landing: partner.usesGcm, profile: partner.usesProfile };
  const readyCount = campaigns.filter((c) => isLaunchable(c, opts)).length;
  const allReady = campaigns.length > 0 && readyCount === campaigns.length;

  return (
    <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
      <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
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
          <div className="-mx-2 flex flex-col">
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
                      {fullName(c) || "Untitled campaign"}
                    </span>
                    <span className="block truncate text-[10.5px] text-faint">
                      {(partner.usesGcm
                        ? c.gcm
                          ? `gcm ${c.gcm}`
                          : "no gcm"
                        : c.profile
                          ? c.profile.replace("globecoders-", "")
                          : "no profile") +
                        " · " +
                        geoLabel(c) +
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

        <div className="border-t border-line pt-3">
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

        <div className="flex flex-col gap-2">
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
              disabled={readyCount === 0}
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

          {justQueued > 0 ? (
            <p className="animate-pop-in text-center text-[11px] font-medium leading-relaxed text-launch2">
              ✓ {justQueued} sent to Task Manager · still here to tweak &amp; relaunch
            </p>
          ) : (
            <p className="text-center text-[10.5px] leading-relaxed text-faint">
              {readyCount > 0
                ? "Queued to Task Manager · creates paused"
                : `${partner.launchNote} · needs a video creative`}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
