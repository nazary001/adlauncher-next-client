"use client";

// The slim strip under the Header on the Google platform: two pill-links between the Google
// LAUNCH board (/google) and the CLONE · JURO board (/google/clone), with a one-line hint of the
// active mode on the right. Both Google boards mount it right under <Header platform="google" …/>.
// Sticky under the sticky header (which is h-16 / z-40) so it stays reachable while a long wave
// scrolls.

import Link from "next/link";

const PILLS = [
  { key: "launch", href: "/google", label: "Launch", hint: "Fresh Demand Gen campaigns — creatives, geo, landing → LION builds them" },
  { key: "clone", href: "/google/clone", label: "Clone · JURO", hint: "Duplicate or JURO an existing Google campaign through LION" },
] as const;

export function GoogleNav({ active }: { active: "launch" | "clone" }) {
  const hint = PILLS.find((p) => p.key === active)?.hint ?? "";
  const base = "flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-150";
  const on = "border border-[#4285F4]/40 bg-[#4285F4]/15 text-[#9cc0ff]";
  const off = "border border-transparent text-dim hover:bg-raise hover:text-ink";
  return (
    <div className="sticky top-16 z-30 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6">
        <nav aria-label="Google board" className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          {PILLS.map((p) => {
            const isOn = p.key === active;
            return (
              <Link key={p.key} href={p.href} aria-current={isOn ? "page" : undefined} className={`${base} ${isOn ? on : off}`}>
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
