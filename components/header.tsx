"use client";

import { FacebookMark, GoogleMark, RocketIcon, TikTokMark } from "./icons";
import { PartnerSwitcher } from "./partner-switcher";
import { AcctLimitWidget } from "./acct-limit-widget";
import { HsTokenStatusWidget } from "./hs-token-status";
import { AifTaskManagerButton, TaskManagerButton } from "./task-manager";
import { HsTaskManagerButton } from "./hs-task-manager";
import { UserMenu, type SessionUser } from "./user-menu";
import { partnerConfig, type PartnerId } from "@/lib/partners";

function Logo() {
  return (
    <div className="group flex select-none items-center gap-3">
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
      <span className="flex flex-col leading-none">
        <span className="text-[17px] font-semibold tracking-tight text-ink">
          Ad Launcher
        </span>
        <span className="mt-1 text-[9.5px] font-medium uppercase tracking-[0.22em] text-faint">
          Campaign console
        </span>
      </span>
    </div>
  );
}

function PlatformTabs() {
  const base =
    "relative flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium " +
    "transition-all duration-200 sm:px-4";
  return (
    <nav aria-label="Ad platform" className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
      <button type="button" aria-current="page" className={`${base} border border-fb/40 bg-fb/15 text-[#85b3f5] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(24,119,242,0.18)]`}>
        <FacebookMark className="h-4 w-4 text-[#5f9bf0]" />
        <span className="hidden sm:inline">Facebook</span>
      </button>

      <button
        type="button"
        aria-disabled="true"
        tabIndex={-1}
        data-tip="TikTok — in development"
        className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}
      >
        <TikTokMark className="h-4 w-4" />
        <span className="hidden sm:inline">TikTok</span>
        <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
      </button>

      <button
        type="button"
        aria-disabled="true"
        tabIndex={-1}
        data-tip="Google — in development"
        className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}
      >
        <GoogleMark mono className="h-4 w-4" />
        <span className="hidden sm:inline">Google</span>
        <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
      </button>
    </nav>
  );
}

export function Header({
  partner,
  onPartnerChange,
  user,
}: {
  partner: PartnerId;
  onPartnerChange: (id: PartnerId) => void;
  user?: SessionUser;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto grid h-16 w-full max-w-[1440px] grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 sm:px-6">
        <div className="justify-self-start">
          <Logo />
        </div>
        <PartnerSwitcher value={partner} onChange={onPartnerChange} />
        <div className="flex items-center gap-2.5 justify-self-end">
          {/* HS launch-token pool (T1→T2 failover) — health dots + which bearer is in use;
              keeping it on screen also keeps the shared failover state fresh (the status
              endpoint's probe marks burned tokens for the whole fleet). */}
          {partnerConfig(partner).lionLaunch ? <HsTokenStatusWidget /> : null}
          {/* Per-account launch-limit timer (5 campaigns / 30 min) — visible on every partner
              and both boards; the panel lists each account's live window. */}
          <AcctLimitWidget />
          {/* Only the active partner's queue button shows: HS (LION submits) has its own
              independent manager, everyone else shares the team Tasks queue. Both providers stay
              mounted in the app layout, so the hidden queue keeps working across the switch. */}
          {partnerConfig(partner).lionLaunch ? (
            <HsTaskManagerButton />
          ) : partnerConfig(partner).aifLaunch ? (
            <AifTaskManagerButton />
          ) : (
            <TaskManagerButton />
          )}
          <PlatformTabs />
          {user ? <UserMenu user={user} /> : null}
        </div>
      </div>
    </header>
  );
}
