"use client";

import type { Campaign } from "@/lib/types";
import { fullName, isLaunchable, moEnsureSocMark, moneyLabel, parseMoney } from "@/lib/types";
import { toolEnsureMark } from "@/lib/tool-launch";
import { UploadingNotice } from "./upload-guard";
import { CONVERSION_EVENTS, geoSummary } from "@/lib/catalog";
import { hsFullName, todaySaoPauloDDMM } from "@/lib/hs-launch";
import { type PartnerConfig, launchReadyOpts, markerPool } from "@/lib/partners";
import type { HsLaunchChannel } from "./hs-task-manager";
import type { ToolReadyState } from "./use-tool-ready";
import type { SlotSigner } from "./use-signers";
import { SignerBadge } from "./signer-badge";
import { CheckIcon, EyeIcon, RocketIcon } from "./icons";
import { useAcctLimits } from "./use-acct-limit";

export function LaunchRail({
  campaigns,
  partner,
  hsAcr,
  hsChannel = "lion",
  hsTokenReady = false,
  onHsChannel,
  tool,
  graphChannel = "token",
  onGraphChannel,
  signer = null,
  signerLoaded = false,
  owner = false,
  previewed,
  justQueued,
  inFlight = 0,
  heldBack = 0,
  poolFree,
  poolMax = null,
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
  /** TOOL readiness for THIS partner × launch rail (useToolReady from the board). Gates the TOOL
   *  segment on the HS control and the graphRail (MO/AIF) FB Token|TOOL control; its `message` is
   *  the disabled-segment tooltip and `accounts.size` the "· N accounts" count (owner ask 28.09).
   *  Undefined = the caller isn't wiring TOOL (TOOL segment renders as not-ready). */
  tool?: ToolReadyState;
  /** MO/AIF launch-rail pick: our FB token (direct Graph) vs the TOOL sessions service. Only read
   *  on the graphRail branch; HS uses hsChannel instead. */
  graphChannel?: "token" | "tool";
  onGraphChannel?: (ch: "token" | "tool") => void;
  /** The rail's effective signer (MO / AIF: the owner's pick on /tokens) — read-only badge +
   *  launch gate; null while unknown. */
  signer?: SlotSigner | null;
  /** false until the first /signers answer landed (the badge says "resolving"). */
  signerLoaded?: boolean;
  /** Owners get a /tokens link in the badge's empty/dead states. */
  owner?: boolean;
  previewed: boolean;
  /** Count just sent to the Task Manager — shows a brief confirmation; campaigns stay on the board. */
  justQueued: number;
  /** Launches still uploading FROM THIS TAB (the partner's Task Manager `counts.inFlight`) — the
   *  rail shows the "do not close this window" notice while any are (owner ask 09-09). */
  inFlight?: number;
  /** Cards held on the board by the account launch limit during the last Launch click. */
  heldBack?: number;
  /** Free gcm codes left in the registry pool (null while loading). 0 → launching hard-blocked. */
  poolFree?: number | null;
  /** Effective pool ceiling — the AV keys endpoint reports how many are REGISTERED in ActiveView
   *  (0 = the stub: nothing launchable, but that reads "not registered", not "exhausted"). */
  poolMax?: number | null;
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
  // AV stub: nothing registered in ActiveView yet (poolMax 0) — launching is blocked, but the
  // message must say "not registered", not "exhausted" (there are no codes to free).
  const poolUnregistered = Boolean(pool) && poolMax === 0;
  const gcmBlocked = Boolean(pool) && poolFree === 0;
  const ddmm = partner.lionLaunch ? todaySaoPauloDDMM() : "";
  const toolReady = tool?.ready ?? false;
  // The bay previews the name the launch will really create — the effective channel's marker
  // included (same picked-AND-ready rule as the launch itself). TOOL (GCL TOOL - ) wins when it is
  // both picked and ready; else the FB Token rail's fixed TOKEN marker; else LION's bare grammar.
  const nameChannel: HsLaunchChannel =
    hsChannel === "tool" && toolReady ? "tool" : hsChannel === "token" && hsTokenReady ? "token" : "lion";
  const graphRail = !partner.lionLaunch && (partner.usesGcm || Boolean(partner.aifLaunch) || Boolean(partner.avLaunch));
  // MO/AIF/AV TOOL is the EFFECTIVE channel. MO/AIF: only when picked AND ready — a stale "tool"
  // pick falls back to our FB token (the same rule the board fires on). AV launches ONLY through
  // TOOL (owner ask 28.09) — its graphChannel is pinned "tool", so this is really "AV and a live
  // session is ready"; when it is NOT ready AV never falls back to a token rail (avToolBlocked).
  const graphToolActive = graphRail && graphChannel === "tool" && toolReady;
  // SOC name marker rides personal-soc signers only (MO) — system users launch unmarked. TOOL
  // drops SOC (it marks OUR social token as signer, which TOOL is not), so a TOOL wave shows the
  // GCL TOOL marker instead, never SOC.
  const moSocMarks = partner.usesGcm && Boolean(signer?.primary?.personal) && !graphToolActive;
  // No token for this partner's launch rail (nothing assigned, no env default) → nothing may fire.
  // KEPT even on the TOOL channel (owner ask 28.09): the MO/AIF account/pixel/page pickers read the
  // SIGNER'S token catalog (TOOL exposes no page/pixel list endpoint), so a signer-less rail has no
  // launchable card whatever the channel — this gate is really "no catalog", not "TOOL needs our
  // signer to sign". AV keeps it too: its token is exactly what pulls the fanpage (owner ask 28.09),
  // so an unassigned AV slot means no page and nothing to launch.
  const moSignerMissing = graphRail && !signer?.primary;
  // AV launches ONLY through TOOL (owner ask 28.09): there is no FB Token fallback, so a not-ready
  // TOOL is a hard block carrying TOOL's own reason (MO/AIF instead fall back to FB Token and are
  // never blocked here). Only meaningful once the AV token is present (moSignerMissing wins first).
  const avToolBlocked = graphRail && Boolean(partner.avLaunch) && !toolReady;
  const nameOf = (c: Campaign) =>
    partner.lionLaunch
      ? c.name.trim()
        ? hsFullName(c, hsAcr ?? "", ddmm, nameChannel)
        : ""
      : graphToolActive
        ? toolEnsureMark(fullName(c))
        : moSocMarks
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
              // AV runs Traffic / link clicks — its card carries a conversion event nobody optimizes on.
              const eventLabel = partner.avLaunch
                ? "link clicks"
                : (CONVERSION_EVENTS.find((e) => e.value === c.conversionEvent)?.label ?? "");
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
              {/* Three rails now (owner ask 28.09): LION's create weapon, our FB token direct on
                  the Graph, or the HS TOOL sessions service. TOOL is offered only while the server
                  says it's ready (a live session sees this partner's accounts) — otherwise the
                  segment is disabled with the server's reason as its tooltip; a stale "tool" pick
                  with the rail not ready falls back to LION at fire time (board's effective rule). */}
              <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {(
                  [
                    { key: "lion" as const, label: "LION API", ready: true, title: undefined as string | undefined },
                    {
                      key: "token" as const,
                      label: "FB Token",
                      ready: hsTokenReady,
                      title: hsTokenReady ? undefined : "FB token not configured on the server (FB_HS_LAUNCH_TOKEN)",
                    },
                    {
                      key: "tool" as const,
                      label: "TOOL",
                      ready: toolReady,
                      title: toolReady
                        ? undefined
                        : tool?.message ||
                          (tool && !tool.loaded
                            ? "Checking TOOL readiness…"
                            : "TOOL is not ready — no live session sees this partner's accounts"),
                    },
                  ]
                ).map((opt) => {
                  const active = hsChannel === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!opt.ready}
                      aria-pressed={active}
                      title={opt.title}
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
                {/* Caption gates on the EFFECTIVE channel (nameChannel), never the raw pick
                    (review find 28.09): a "tool"/"token" pick restored from localStorage while
                    the server flips the rail not-ready renders disabled-but-highlighted, yet
                    launchWave falls back to LION — so the caption must not claim TOOL/Token. A
                    picked-but-not-ready TOOL shows the server's reason plus that the wave fires
                    on the LION API; a stale token pick folds into the LION caption. */}
                {nameChannel === "tool"
                  ? `Launches through TOOL · ${tool?.accounts.size ?? 0} account${(tool?.accounts.size ?? 0) === 1 ? "" : "s"} · delivery +30 min`
                  : hsChannel === "tool"
                    ? `${tool?.message || "TOOL not ready"} · wave fires on the LION API`
                    : nameChannel === "token"
                      ? "Our FB token builds the tree · delivery starts +30 min"
                      : "LION profiles build the tree on the weapon side"}
              </p>
            </div>
          ) : null}
          {/* MO/AIF launch rail (owner ask 28.09): our FB token (direct Graph — the signer badge
              shows the OWNER'S /tokens pick, read-only here) or the HS TOOL sessions service (TOOL
              resolves the session from the account; no signer of ours). TOOL is offered only while
              the server says it's ready; a stale "tool" pick falls back to FB Token at fire time. */}
          {graphRail && !partner.avLaunch ? (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {(
                  [
                    { key: "token" as const, label: "FB Token", ready: true, title: undefined as string | undefined },
                    {
                      key: "tool" as const,
                      label: "TOOL",
                      ready: toolReady,
                      title: toolReady
                        ? undefined
                        : tool?.message ||
                          (tool && !tool.loaded
                            ? "Checking TOOL readiness…"
                            : "TOOL is not ready — no live session sees this partner's accounts"),
                    },
                  ]
                ).map((opt) => {
                  const active = graphChannel === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!opt.ready}
                      aria-pressed={active}
                      title={opt.title}
                      onClick={() => onGraphChannel?.(opt.key)}
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
              {graphToolActive ? (
                <p className="text-center text-[10px] leading-relaxed text-faint">
                  Launches through TOOL · {tool?.accounts.size ?? 0} account
                  {(tool?.accounts.size ?? 0) === 1 ? "" : "s"}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="select-none text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
                    Signer
                  </span>
                  <SignerBadge signer={signer} loaded={signerLoaded} rail="launch" owner={owner} />
                </div>
              )}
            </div>
          ) : null}
          {/* AV launch rail (owner ask 28.09): AV launches ONLY through TOOL — no FB Token switch.
              Its cabinets ride the live TOOL session and the fanpage is the one the AV token pulls;
              there is no fallback. Ready → the "through TOOL · N accounts" line; not ready → TOOL's
              own reason (the Launch button is disabled on it too). */}
          {graphRail && partner.avLaunch ? (
            <div className="flex flex-col gap-1.5">
              {graphToolActive ? (
                <p className="text-center text-[10px] leading-relaxed text-faint">
                  Launches through TOOL · {tool?.accounts.size ?? 0} account
                  {(tool?.accounts.size ?? 0) === 1 ? "" : "s"} · fanpage from the AV token
                </p>
              ) : (
                <p className="text-center text-[11px] font-medium leading-relaxed text-warn">
                  {tool?.message ||
                    (tool && !tool.loaded
                      ? "Checking TOOL readiness…"
                      : "TOOL is not ready — no live session sees AV's cabinets")}
                </p>
              )}
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

          {/* Client-side uploads die with the page — the warning sits right by the Launch button
              for as long as any launch is still in flight (owner ask 09-09). */}
          <UploadingNotice n={inFlight} compact />

          {previewed ? (
            <button
              type="button"
              onClick={onLaunch}
              disabled={readyCount === 0 || gcmBlocked || moSignerMissing || avToolBlocked || limits.staleBuild || launching}
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
          ) : moSignerMissing ? (
            <p className="text-center text-[11px] font-semibold leading-relaxed text-danger">
              No launch token is assigned for this partner — an owner assigns one under FB tokens (menu).
            </p>
          ) : avToolBlocked ? (
            // AV launches only through TOOL (owner ask 28.09): no fallback rail, so the button stays
            // disabled and carries TOOL's own reason.
            <p className="text-center text-[11px] font-semibold leading-relaxed text-danger">
              {tool?.message ||
                (tool && !tool.loaded
                  ? "Checking TOOL readiness…"
                  : "TOOL is not ready — an owner refreshes a session that sees AV's cabinets on Ads Manager sessions")}
            </p>
          ) : gcmBlocked ? (
            <p className="text-center text-[11px] font-semibold leading-relaxed text-danger">
              {poolUnregistered
                ? "No AV keys are registered in ActiveView yet — an owner uploads the key pool on the AV keys page before anything can launch."
                : `No free ${pool?.label ?? "gcm"} codes left — launching is blocked until codes are freed in the registry.`}
            </p>
          ) : justQueued > 0 ? (
            <p className="animate-pop-in text-center text-[11px] font-medium leading-relaxed text-launch2">
              ✓ {justQueued} sent to Task Manager · still here to tweak &amp; relaunch
            </p>
          ) : (
            <p className="text-center text-[10.5px] leading-relaxed text-faint">
              {readyCount > 0
                ? partner.lionLaunch
                  ? nameChannel === "tool"
                    ? "Queued to HS Task Manager · TOOL builds the ads · starts in 30 min"
                    : nameChannel === "token"
                      ? "Queued to HS Task Manager · FB token builds the ads · starts in 30 min"
                      : "Queued to HS Task Manager · LION builds the ads"
                  : graphToolActive
                    ? "Queued to Task Manager · TOOL builds the ads"
                    : "Queued to Task Manager · goes live on create"
                : `${partner.launchNote} · needs a creative`}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
