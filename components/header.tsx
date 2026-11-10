"use client";

import Link from "next/link";
import { useLayoutEffect, useRef } from "react";
import { FacebookMark, GoogleMark, RocketIcon, SnapMark, TikTokMark } from "./icons";
import { PartnerSwitcher } from "./partner-switcher";
import { AcctLimitWidget } from "./acct-limit-widget";
import { HsTokenStatusWidget } from "./hs-token-status";
import { AifTaskManagerButton, AvTaskManagerButton, TaskManagerButton, VcTaskManagerButton } from "./task-manager";
import { HsTaskManagerButton } from "./hs-task-manager";
import { GoogleTaskManagerButton } from "./google-task-manager";
import { SnapTaskManagerButton } from "./snap-task-manager";
import { TiktokTaskManagerButton } from "./tiktok-task-manager";
import { UserMenu, type SessionUser } from "./user-menu";
import { TeamBadge } from "./team-badge";
import { UpdateChip } from "./update-notice";
import { GOOGLE_ENABLED, SNAP_ENABLED, TIKTOK_ENABLED, partnerConfig, type PartnerId } from "@/lib/partners";
import { TEAM, teamHas } from "@/lib/team";
import { MAX_SQUEEZE, ROOMY_FIT, fitAttrs, fitFromAttrs, midLineFits, oneRowFits, settleFit, topLineFits, type FitProbe, type HeaderFit } from "@/lib/header-fit";

/** "console" = an owner tool page (e.g. /sessions) that belongs to no ad platform: no tab is
 *  active, the partner switcher gives way to a static label, the FB widgets stay hidden. */
type Platform = "facebook" | "tiktok" | "google" | "snapchat" | "console";

function Logo() {
  return (
    <Link href="/" className="group flex select-none items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
      <span className="relative shrink-0">
        <span
          className={
            "relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl " +
            "bg-gradient-to-br from-accent via-[#5b6bff] to-accent2 " +
            "shadow-[0_0_24px_rgba(61,127,255,0.35),inset_0_1px_0_rgba(255,255,255,0.25)] transition-shadow duration-300 " +
            "group-hover:shadow-[0_0_32px_rgba(124,92,255,0.5),inset_0_1px_0_rgba(255,255,255,0.25)]"
          }
        >
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
          <RocketIcon className="relative h-5 w-5 text-white transition-transform duration-300 ease-out group-hover:-translate-y-[2px] group-hover:translate-x-[2px]" />
        </span>
        {/* The team's mark (lib/team) is on screen in EVERY layout: pinned to the logo — where it
            costs the row no pixels — exactly when the wordmark below is folded away (hdr-on4 /
            hdr-s4 are the two sides of squeeze step 4, app/globals.css), next to the wordmark
            otherwise. */}
        <TeamBadge corner className="hdr-on4" />
      </span>
      {/* Never wraps (it used to break into "Ad / Launcher" once the row got crowded) — it folds. */}
      <span className="hdr-s4 flex flex-col whitespace-nowrap leading-none">
        <span className="flex items-center gap-1.5 text-[17px] font-semibold tracking-tight text-ink">
          Ad Launcher
          <TeamBadge />
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
  // next to the partner switcher. The ACTIVE tab keeps its name while the row has room for it
  // (squeeze step 2 folds it — lib/header-fit); after that the coloured pill alone says where you are.
  // A segment is 32px inside the 40px track — the one control height of the whole header.
  const base =
    "relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2 text-[13px] font-medium " +
    "transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const label = (active: boolean) => (active ? "hdr-s2 whitespace-nowrap pr-1" : "sr-only");
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
    <nav aria-label="Ad platform" className="flex h-10 shrink-0 items-center gap-0.5 rounded-full border border-line bg-surface p-[3px]">
      <Link
        href="/"
        aria-current={onFacebook ? "page" : undefined}
        data-tip={onFacebook ? undefined : "Facebook"}
        className={`${base} ${onFacebook ? fbActive : `${inactive} tip tip-b`}`}
      >
        <FacebookMark className={`h-4 w-4 ${onFacebook ? "text-[#5f9bf0]" : ""}`} />
        <span className={label(onFacebook)}>Facebook</span>
      </Link>

      {/* A platform that is not this team's (lib/team) has no tab at all — not even the dormant cue. */}
      {!TEAM.platforms.includes("tiktok") ? null : TIKTOK_ENABLED ? (
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
          <span className="animate-pulse-soft absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}

      {!TEAM.platforms.includes("google") ? null : GOOGLE_ENABLED ? (
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
          <span className="animate-pulse-soft absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}

      {!TEAM.platforms.includes("snap") ? null : SNAP_ENABLED ? (
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
          <span className="animate-pulse-soft absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}
    </nav>
  );
}

/**
 * Fits the header to the width it has (lib/header-fit has the why and the layouts). Tries the
 * layouts from the one it is in, measuring the three parts — logo, partner context, controls — at
 * their natural width, and leaves the roomiest that fits in data-rows / data-sq / data-sqm /
 * data-wrap for the CSS. Runs before the first paint, on every window resize, and whenever a part changes size on
 * its own (a widget grows, the update chip appears, the web font lands).
 *
 * The attributes are written straight to the element — React does not know them, so a re-render
 * never resets them (and <header> carries suppressHydrationWarning: the server's HTML reaches React
 * with them already set by the pre-paint script) — and the header's real height rides --hdr-h: the sticky sub-navs (Google / Snap
 * / TikTok), the update card and the phone popovers sit under whatever height the header ends up with.
 */
function useHeaderFit(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const hdr = ref.current;
    const row = hdr?.querySelector<HTMLElement>(".hdr-row");
    const logo = hdr?.querySelector<HTMLElement>(".hdr-logo");
    const mid = hdr?.querySelector<HTMLElement>(".hdr-mid-in");
    const right = hdr?.querySelector<HTMLElement>(".hdr-right");
    if (!hdr || !row || !logo || !mid || !right) return;

    const read = () => fitFromAttrs({ rows: hdr.getAttribute("data-rows"), sq: hdr.getAttribute("data-sq"), sqm: hdr.getAttribute("data-sqm"), wrap: hdr.getAttribute("data-wrap") });
    const apply = (f: HeaderFit) => {
      const a = fitAttrs(f);
      hdr.setAttribute("data-rows", a.rows);
      hdr.setAttribute("data-sq", a.sq);
      hdr.setAttribute("data-sqm", a.sqm);
      if (a.wrap) hdr.setAttribute("data-wrap", a.wrap);
      else hdr.removeAttribute("data-wrap");
    };
    const width = (el: HTMLElement) => el.getBoundingClientRect().width;
    const rowStyle = getComputedStyle(row); // live
    /** Room for the parts: the row minus its side padding. */
    const inner = () => row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
    const gap = () => parseFloat(rowStyle.columnGap) || 0;
    /** The parts as they are laid out right now — what a fit depends on besides the room. */
    const content = () => `${hdr.getAttribute("data-rows")}|${hdr.getAttribute("data-sq")}|${hdr.getAttribute("data-sqm")}|${width(logo)}|${width(mid)}|${width(right)}`;

    // The server's HTML arrives already fitted (HEADER_PREFIT_SCRIPT, app/layout.tsx): start from
    // the layout it left. A header mounted by a client navigation starts roomy.
    let fit = read() ?? ROOMY_FIT;
    let seen = "";
    // What the tightest single line needs, for the content `tightFor` describes. On two lines every
    // run asks "would one line fit yet?" — answering from this instead of laying the header out on
    // one line again spares a narrow window a relayout of the whole board per resize frame.
    let tight: number | null = null;
    let tightFor = "";

    const run = () => {
      if (content() !== tightFor) tight = null;
      const probe: FitProbe = {
        oneRow: (s) => {
          if (s === MAX_SQUEEZE && tight !== null) return oneRowFits(tight, 0, 0, inner(), 0);
          apply({ rows: 1, top: s, mid: s, wrapTop: false, wrapMid: false });
          if (s === MAX_SQUEEZE) tight = width(logo) + width(mid) + width(right) + 2 * gap();
          return oneRowFits(width(logo), width(mid), width(right), inner(), gap());
        },
        // On two lines the other line's step does not matter to this one: it keeps the one it has.
        top: (s) => {
          apply({ rows: 2, top: s, mid: fit.mid, wrapTop: false, wrapMid: false });
          return topLineFits(width(logo), width(right), inner(), gap());
        },
        mid: (s) => {
          apply({ rows: 2, top: fit.top, mid: s, wrapTop: false, wrapMid: false });
          return midLineFits(width(mid), inner());
        },
      };
      fit = settleFit(fit, probe);
      apply(fit);
      tightFor = content();
      seen = `${inner()}|${tightFor}`;
      document.documentElement.style.setProperty("--hdr-h", `${Math.round(hdr.getBoundingClientRect().height)}px`);
    };
    run();

    // A window resize is handled on the spot (the event comes before the frame is laid out, so the
    // new layout is painted with the new width). A part changing size by itself is seen by the
    // observer, and handled a frame later — re-laying out inside the observer's own callback would
    // resize what it watches. Our own attribute writes resize the parts too, which wakes the
    // observer once more: `seen` is where that ends.
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (`${inner()}|${content()}` !== seen) run();
        else document.documentElement.style.setProperty("--hdr-h", `${Math.round(hdr.getBoundingClientRect().height)}px`);
      });
    };
    window.addEventListener("resize", run);
    const ro = new ResizeObserver(later);
    for (const el of [hdr, logo, mid, right]) ro.observe(el);
    return () => {
      window.removeEventListener("resize", run);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
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
  const ref = useRef<HTMLElement>(null);
  useHeaderFit(ref);
  const middle = isConsole ? (
    <span className="flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[12px] font-medium text-dim">
      {consoleLabel}
    </span>
  ) : isSnap ? (
    <span
      className="flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[12px] font-medium text-dim"
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
    <header ref={ref} data-hdr="" suppressHydrationWarning className="hdr sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl backdrop-saturate-150">
      {/* logo · partner context · queue/platforms/user. Which of them share a line, and how much of
          each is folded away, is not decided by breakpoints: useHeaderFit measures the row and sets
          data-rows / data-sq / data-sqm / data-wrap, and the hdr-* rules in app/globals.css follow. */}
      <div className="hdr-row mx-auto w-full max-w-[1440px] px-3 sm:px-6">
        <div className="hdr-logo">
          <Logo />
        </div>
        {/* Partner context: the switcher (Google / TikTok pin it to HS; Snapchat and owner consoles
            show a static label) + the FB rails' widgets that belong to the picked partner. */}
        <div className="hdr-mid">
          <div className="hdr-mid-in">
          {middle}
          {/* HS launch-token pool (T1→T2 failover) — health dots + which bearer is in use;
              keeping it on screen also keeps the shared failover state fresh (the status
              endpoint's probe marks burned tokens for the whole fleet). FB rail only. */}
          {!pinned && partnerConfig(partner).lionLaunch && teamHas("channel:token") ? <HsTokenStatusWidget /> : null}
          {/* Per-account launch-limit timer (5 campaigns / 15 min) — the FB rails' concern; the
              Google rail has no such per-account window (LION owns pacing), nor does Snapchat
              (the server pump paces the wave). */}
          {!pinned ? <AcctLimitWidget /> : null}
          </div>
        </div>
        <div className="hdr-right">
          {/* "A new version is live" — nothing on a current tab; from a deploy until the reload, the
              chip the update card folds into (and opens from). */}
          <UpdateChip />
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
          ) : partnerConfig(partner).vcLaunch ? (
            <VcTaskManagerButton />
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
