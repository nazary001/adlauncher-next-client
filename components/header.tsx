"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { FacebookMark, GoogleMark, RocketIcon, SnapMark, TikTokMark } from "./icons";
import { PartnerSwitcher } from "./partner-switcher";
import { AcctLimitWidget } from "./acct-limit-widget";
import { HsTokenStatusWidget } from "./hs-token-status";
import { AifTaskManagerButton, AvTaskManagerButton, TaskManagerButton } from "./task-manager";
import { HsTaskManagerButton } from "./hs-task-manager";
import { GoogleTaskManagerButton } from "./google-task-manager";
import { SnapTaskManagerButton } from "./snap-task-manager";
import { TiktokTaskManagerButton } from "./tiktok-task-manager";
import { UserMenu, type SessionUser } from "./user-menu";
import { GOOGLE_ENABLED, SNAP_ENABLED, TIKTOK_ENABLED, partnerConfig, type PartnerId } from "@/lib/partners";

/** "console" = an owner tool page (e.g. /sessions) that belongs to no ad platform: no tab is
 *  active, the partner switcher gives way to a static label, the FB widgets stay hidden. */
type Platform = "facebook" | "tiktok" | "google" | "snapchat" | "console";

function Logo() {
  return (
    <Link href="/" className="group flex select-none items-center gap-3">
      <span
        className={
          "relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl " +
          "bg-gradient-to-br from-accent via-[#5b6bff] to-accent2 " +
          "shadow-[0_0_24px_rgba(61,127,255,0.35)] transition-shadow duration-300 " +
          "group-hover:shadow-[0_0_32px_rgba(124,92,255,0.5)]"
        }
      >
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
        <RocketIcon className="relative h-5 w-5 text-white transition-transform duration-300 ease-out group-hover:-translate-y-[2px] group-hover:translate-x-[2px]" />
      </span>
      {/* The wordmark gives way where the row is tightest: phones, and the single-row lg band
          (1024–1279px) where every pixel goes to the switcher + tabs. Never wraps (it used to break
          into "Ad / Launcher" once the row got crowded). */}
      <span className="hidden flex-col whitespace-nowrap leading-none sm:flex lg:hidden xl:flex">
        <span className="text-[17px] font-semibold tracking-tight text-ink">
          Ad Launcher
        </span>
        <span className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.22em] text-faint">
          Campaign console
        </span>
      </span>
    </Link>
  );
}

function PlatformTabs({ platform }: { platform: Platform }) {
  // Inactive tabs are icon-only (a tooltip names them) — every platform label at once never fit
  // next to the partner switcher (the header overflowed the viewport from 1366px down). The ACTIVE
  // tab keeps its name from xl up; below that the coloured pill alone says where you are.
  const base =
    "relative flex h-9 shrink-0 items-center gap-2 rounded-full px-2.5 text-[13px] font-medium " +
    "transition-all duration-200 sm:px-3";
  const label = (active: boolean) => (active ? "hidden whitespace-nowrap xl:inline" : "sr-only");
  // Inactive tab: a plain link that lights up on hover (same idiom as the partner switcher).
  const inactive = "border border-transparent text-dim hover:bg-raise hover:text-ink";
  // Facebook keeps its blue active pill; Google gets an analogous pill in the Google blue so it
  // reads as a sibling, not a bolt-on.
  const fbActive =
    "border border-fb/40 bg-fb/15 text-[#85b3f5] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(24,119,242,0.18)]";
  const googleActive =
    "border border-[#4285F4]/40 bg-[#4285F4]/15 text-[#9cc0ff] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(66,133,244,0.18)]";
  // Snapchat: the same pill shape in the brand yellow (a third sibling, same glow recipe).
  const snapActive = "border border-[#FFFC00]/40 bg-[#FFFC00]/10 text-[#f3f0a3] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(255,252,0,0.12)]";
  // TikTok: the same pill in the brand cyan.
  const tiktokActive = "border border-[#25F4EE]/40 bg-[#25F4EE]/10 text-[#9ff3ef] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(37,244,238,0.14)]";
  const onFacebook = platform === "facebook";
  const onTiktok = platform === "tiktok";
  const onGoogle = platform === "google";
  const onSnap = platform === "snapchat";
  return (
    <nav aria-label="Ad platform" className="flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface p-1 sm:gap-1">
      <Link
        href="/"
        aria-current={onFacebook ? "page" : undefined}
        data-tip={onFacebook ? undefined : "Facebook"}
        className={`${base} ${onFacebook ? fbActive : `${inactive} tip tip-b`}`}
      >
        <FacebookMark className={`h-4 w-4 ${onFacebook ? "text-[#5f9bf0]" : ""}`} />
        <span className={label(onFacebook)}>Facebook</span>
      </Link>

      {TIKTOK_ENABLED ? (
        <Link
          href="/tiktok"
          aria-current={onTiktok ? "page" : undefined}
          data-tip={onTiktok ? undefined : "TikTok"}
          className={`${base} ${onTiktok ? tiktokActive : `${inactive} tip tip-b`}`}
        >
          <TikTokMark className="h-4 w-4" />
          <span className={label(onTiktok)}>TikTok</span>
        </Link>
      ) : (
        // Dormant on prod (NEXT_PUBLIC_TIKTOK_ENABLED unset) → the disabled "in development" cue.
        <button
          type="button"
          aria-disabled="true"
          tabIndex={-1}
          data-tip="TikTok — in development"
          className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}
        >
          <TikTokMark className="h-4 w-4" />
          <span className="sr-only">TikTok</span>
          <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}

      {GOOGLE_ENABLED ? (
        // Real navigation target: full-colour Google mark, active pill when we're on /google.
        <Link
          href="/google"
          aria-current={onGoogle ? "page" : undefined}
          data-tip={onGoogle ? undefined : "Google"}
          className={`${base} ${onGoogle ? googleActive : `${inactive} tip tip-b`}`}
        >
          <GoogleMark className="h-4 w-4" />
          <span className={label(onGoogle)}>Google</span>
        </Link>
      ) : (
        // Dormant on prod (NEXT_PUBLIC_GOOGLE_ENABLED unset) → the same disabled "in development" cue.
        <button
          type="button"
          aria-disabled="true"
          tabIndex={-1}
          data-tip="Google — in development"
          className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}
        >
          <GoogleMark mono className="h-4 w-4" />
          <span className="sr-only">Google</span>
          <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}

      {SNAP_ENABLED ? (
        <Link
          href="/snap"
          aria-current={onSnap ? "page" : undefined}
          data-tip={onSnap ? undefined : "Snapchat"}
          className={`${base} ${onSnap ? snapActive : `${inactive} tip tip-b`}`}
        >
          <SnapMark className="h-4 w-4" />
          <span className={label(onSnap)}>Snapchat</span>
        </Link>
      ) : (
        <button type="button" aria-disabled="true" tabIndex={-1} data-tip="Snapchat — in development" className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}>
          <SnapMark mono className="h-4 w-4" />
          <span className="sr-only">Snapchat</span>
          <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}
    </nav>
  );
}

export function Header({
  partner,
  onPartnerChange,
  user,
  platform = "facebook",
  consoleLabel,
}: {
  partner: PartnerId;
  onPartnerChange: (id: PartnerId) => void;
  user?: SessionUser;
  /** Which platform board this header sits on. On "google" and "tiktok" the partner switcher is
   *  pinned to HS (both rails run through LION only) and the FB-only widgets give way to that
   *  platform's task manager. On "snapchat" there is no
   *  partner axis at all (our own ad account): the switcher becomes a static label and the queue
   *  button is the Snapchat task manager. On "console" (owner tools such as /sessions) the
   *  switcher is the `consoleLabel` and there is no queue button. Default keeps FB behaviour. */
  platform?: Platform;
  /** The static label shown in place of the partner switcher on platform="console". */
  consoleLabel?: React.ReactNode;
}) {
  const isGoogle = platform === "google";
  const isSnap = platform === "snapchat";
  const isTiktok = platform === "tiktok";
  const isConsole = platform === "console";
  // Every non-FB platform hides the FB-only widgets (HS token pool, per-account launch limit).
  const pinned = isGoogle || isSnap || isTiktok || isConsole;
  // The header's real height rides a CSS variable (--hdr-h): from lg up it is one 64px row, below
  // lg the partner row wraps under the logo row, so the sticky sub-navs (Google / Snap / TikTok) and
  // the launch-limit toast sit under whatever height the header actually has (they read
  // top-[var(--hdr-h,4rem)]). A ResizeObserver keeps it exact through wraps and font loads.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--hdr-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const middle = isConsole ? (
    <span className="flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-dim">
      {consoleLabel}
    </span>
  ) : isSnap ? (
    <span
      className="flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-dim"
      title="Snapchat runs on our own ad account — there is no partner rail to pick"
    >
      <SnapMark className="h-3.5 w-3.5" />
      Own Snapchat ad account
    </span>
  ) : (
    <PartnerSwitcher
      value={partner}
      onChange={onPartnerChange}
      {...(isGoogle ? { lockedNote: "Google runs through LION (HS) only" } : isTiktok ? { lockedNote: "TikTok runs through LION (HS) only" } : {})}
    />
  );
  return (
    <header ref={ref} className="sticky top-0 z-40 border-b border-line bg-bg/75 backdrop-blur-md">
      {/* One row from lg up (logo · partner context · queue/platforms/user); below lg the partner
          context (switcher + the FB widgets) wraps into its own full-width row under the logo row —
          the old 3-column grid simply ran off the right edge (1366px and down, HS already at 1536). */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2 sm:gap-x-3 sm:px-6 lg:h-16 lg:flex-nowrap lg:py-0">
        <div className="order-1 shrink-0">
          <Logo />
        </div>
        {/* Partner context: the switcher (Google / TikTok pin it to HS; Snapchat and owner consoles
            show a static label) + the FB rails' widgets that belong to the picked partner. */}
        <div className="order-3 flex w-full min-w-0 flex-wrap items-center justify-center gap-2 lg:order-2 lg:w-auto lg:flex-1 lg:flex-nowrap">
          {middle}
          {/* HS launch-token pool (T1→T2 failover) — health dots + which bearer is in use;
              keeping it on screen also keeps the shared failover state fresh (the status
              endpoint's probe marks burned tokens for the whole fleet). FB rail only. */}
          {!pinned && partnerConfig(partner).lionLaunch ? <HsTokenStatusWidget /> : null}
          {/* Per-account launch-limit timer (5 campaigns / 30 min) — the FB rails' concern; the
              Google rail has no such per-account window (LION owns pacing), nor does Snapchat
              (the server pump paces the wave). */}
          {!pinned ? <AcctLimitWidget /> : null}
        </div>
        <div className="order-2 ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2 lg:order-3 lg:ml-0">
          {/* The active rail's queue button: Snapchat and Google each have their own compact
              manager; on FB, HS (LION submits) has its own manager, everyone else shares the team
              Tasks queue. Every provider stays mounted in the app layout, so the hidden queue keeps
              working. */}
          {isConsole ? null : isSnap ? (
            <SnapTaskManagerButton />
          ) : isGoogle ? (
            <GoogleTaskManagerButton />
          ) : isTiktok ? (
            <TiktokTaskManagerButton />
          ) : partnerConfig(partner).lionLaunch ? (
            <HsTaskManagerButton />
          ) : partnerConfig(partner).avLaunch ? (
            <AvTaskManagerButton />
          ) : partnerConfig(partner).aifLaunch ? (
            <AifTaskManagerButton />
          ) : (
            <TaskManagerButton />
          )}
          <PlatformTabs platform={platform} />
          {user ? <UserMenu user={user} /> : null}
        </div>
      </div>
    </header>
  );
}
