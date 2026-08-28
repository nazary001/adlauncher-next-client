"use client";

import type { Campaign } from "@/lib/types";
import { fullName, isLaunchable, moEnsureSocMark, moneyLabel, parseMoney } from "@/lib/types";
import { CONVERSION_EVENTS, geoSummary } from "@/lib/catalog";
import { hsFullName, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { type PartnerConfig, launchReadyOpts, markerPool } from "@/lib/partners";
import type { HsLaunchChannel } from "./hs-task-manager";
import type { MoSocStatus } from "./use-mo-socs";
import { CheckIcon, EyeIcon, RocketIcon } from "./icons";
import { useAcctLimits } from "./use-acct-limit";

export function LaunchRail({
  campaigns,
  partner,
  hsAcr,
  hsChannel = "lion",
  hsTokenReady = false,
  onHsChannel,
  moSocs = null,
  moChannel = "",
  moSoc = "",
  onMoChannel,
  previewed,
  justQueued,
  heldBack = 0,
  poolFree,
  onJump,
  onPreview,
  onLaunch,
  launching = false,
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
  /** MO soc channels provisioned server-side, each with its live token verdict (null while
   *  loading, [] = switch hidden). A dead soc renders flagged, with FB's reason under the
   *  switch when picked — so an empty account picker reads as "re-issue this token". */
  moSocs?: MoSocStatus[] | null;
  /** The STORED MO signer pick ("" = system token) — what the switch highlights. */
  moChannel?: string;
  /** The EFFECTIVE soc for the wave ("" = system): picked AND provisioned — drives the name
   *  preview and the caption, same honor rule the launch itself applies. */
  moSoc?: string;
  onMoChannel?: (v: string) => void;
  previewed: boolean;
  /** Count just sent to the Task Manager — shows a brief confirmation; campaigns stay on the board. */
  justQueued: number;
  /** Cards held on the board by the account launch limit during the last Launch click. */
  heldBack?: number;
  /** Free gcm codes left in the registry pool (null while loading). 0 → launching hard-blocked. */
  poolFree?: number | null;
  /** Jump the page to a campaign card and focus-pulse it. */
  onJump: (id: string) => void;
  onPreview: () => void;
  onLaunch: () => void;
  /** launch() in flight — the button greys out while the wave enqueues (double-clicks are latched
   *  in the board too; this is the visible half of the same guard). */
  launching?: boolean;
}) {
  const total = campaigns.reduce((s, c) => s + parseMoney(c.budget), 0);
  const opts = launchReadyOpts(partner);
  // Account launch limit (5/30min): a card bound to a full account is not launchable — the SAME
  // predicate the card dot uses, so the bay count, the dots and the launch filter always agree.
  const limits = useAcctLimits();
  const launchableOf = (c: Campaign) =>
    isLaunchable(c, opts) && !(c.account && limits.countFor(c.account) >= limits.limit);
  const readyCount = campaigns.filter(launchableOf).length;
  const allReady = campaigns.length > 0 && readyCount === campaigns.length;
  // Registry pool exhausted → the button locks even for cards holding stale code previews: with
  // every code row taken, their claims can only fail server-side (the claim walks 400s then throws).
  const pool = markerPool(partner);
  const gcmBlocked = Boolean(pool) && poolFree === 0;
  const ddmm = partner.lionLaunch ? todaySaoPauloDDMM() : "";
  // The bay previews the name the launch will really create — the FB Token rail's fixed TOKEN
  // marker included (same effective-channel rule as the launch itself: picked AND provisioned).
  const nameChannel = hsChannel === "token" && hsTokenReady ? ("token" as const) : ("lion" as const);
  const nameOf = (c: Campaign) =>
    partner.lionLaunch
      ? c.name.trim()
        ? hsFullName(c, hsAcr ?? "", ddmm, nameChannel)
        : ""
      : moSoc
        ? moEnsureSocMark(fullName(c))
        : fullName(c);

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
              const ready = launchableOf(c);
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
          {/* MO launch signer: the system-user token (default) vs a personal soc token — same
              direct-Graph tree, different bearer. Rendered only when at least one soc is
              provisioned server-side (FB_MO_SOC_TOKENS). One pick for the whole wave. */}
          {!partner.lionLaunch && partner.usesGcm && (moSocs?.length ?? 0) > 0 ? (
            <div className="flex flex-col gap-1">
              <div
                className="grid overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5"
                style={{ gridTemplateColumns: `repeat(${1 + (moSocs?.length ?? 0)}, minmax(0, 1fr))` }}
              >
                {[
                  { key: "", label: "System token", dead: false, err: "" },
                  ...(moSocs ?? []).map((s) => ({ key: s.name, label: s.name, dead: !s.ok, err: s.error ?? "" })),
                ].map((opt) => {
                  const active = moChannel === opt.key;
                  return (
                    <button
                      key={opt.key || "system"}
                      type="button"
                      aria-pressed={active}
                      title={
                        opt.dead
                          ? `Token dead — ${opt.err || "re-issue it"}`
                          : opt.key
                            ? `Launch as the "${opt.key}" soc token`
                            : "Launch via the system-user token"
                      }
                      onClick={() => onMoChannel?.(opt.key)}
                      className={
                        "h-8 truncate rounded-[10px] px-1 text-[12px] font-semibold transition-all duration-150 " +
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                        (active
                          ? opt.dead
                            ? "bg-red-500/15 text-red-300 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.35)]"
                            : "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]"
                          : opt.dead
                            ? "text-red-400/70 hover:text-red-300"
                            : "text-dim hover:text-ink")
                      }
                    >
                      {opt.dead ? "⚠ " : ""}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-center text-[10px] leading-relaxed text-faint">
                {moSoc
                  ? `Soc token "${moSoc}" signs the tree · names carry the SOC marker`
                  : "System-user token signs the tree"}
              </p>
              {(() => {
                // The picked soc's live verdict: FB's own error text turns a silently empty
                // account picker into an actionable "this token needs re-issuing".
                const err = moSoc ? (moSocs ?? []).find((s) => s.name === moSoc && !s.ok)?.error : "";
                return err ? (
                  <p className="text-center text-[10px] leading-relaxed text-red-400">
                    Token dead — pickers stay empty and launches will fail: {err}
                  </p>
                ) : null;
              })()}
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
              disabled={readyCount === 0 || gcmBlocked || limits.staleBuild || launching}
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

          {heldBack > 0 ? (
            <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
              {heldBack} held by the account limit (5 / 30 min) — they stay on the board; relaunch
              after the reset or move them to another account.
            </p>
          ) : null}
          {limits.staleBuild ? (
            <p className="text-center text-[11px] font-semibold leading-relaxed text-danger">
              A newer version is live — reload this tab to launch (its limit gates are outdated).
            </p>
          ) : gcmBlocked ? (
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
