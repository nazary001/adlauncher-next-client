"use client";

// The slim strip under the Header on the TikTok platform: two pill-links between the TikTok LAUNCH
// board (/tiktok) and the CLONE · JURO board (/tiktok/clone), with a one-line hint of the active
// mode on the right. Same texture as google-nav, TikTok-cyan accent. Sticky under the sticky header
// (which is h-16 / z-40) so it stays reachable while a long wave scrolls.

import Link from "next/link";

const PILLS = [
  { key: "launch", href: "/tiktok", label: "Launch", hint: "Fresh TikTok campaigns — identity, videos, geo, landing → LION builds them" },
  { key: "clone", href: "/tiktok/clone", label: "Clone · JURO", hint: "Clone a TikTok campaign onto any advertiser, or JURO it on its own, through LION" },
] as const;

/** TikTok accent classes shared by the platform's boards (the brand cyan on the console's dark). */
export const TT_ON = "border border-[#25F4EE]/40 bg-[#25F4EE]/10 text-[#9ff3ef]";

export function TiktokNav({ active }: { active: "launch" | "clone" }) {
  const hint = PILLS.find((p) => p.key === active)?.hint ?? "";
  const base = "flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-150";
  const off = "border border-transparent text-dim hover:bg-raise hover:text-ink";
  return (
    <div className="sticky top-16 z-30 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6">
        <nav aria-label="TikTok board" className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          {PILLS.map((p) => {
            const isOn = p.key === active;
            return (
              <Link key={p.key} href={p.href} aria-current={isOn ? "page" : undefined} className={`${base} ${isOn ? TT_ON : off}`}>
                {p.label}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto hidden truncate text-[11px] leading-snug text-faint sm:block">{hint}</span>
      </div>
    </div>
  );
}
