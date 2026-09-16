"use client";

// The slim strip under the Header on the Snapchat platform: two pill-links between the LAUNCH
// board (/snap) and the KEYS · REPORT page (/snap/keys), with a one-line hint of the active side.
// Same texture as google-nav, Snap-yellow accent. Sticky under the sticky header (h-16 / z-40).

import Link from "next/link";

const PILLS = [
  { key: "launch", href: "/snap", label: "Launch", hint: "Web campaigns on our Snapchat ad account — one partner key per campaign" },
  { key: "keys", href: "/snap/keys", label: "Keys · report", hint: "The 100 partner keys, who holds them, and LION's daily revenue per key" },
] as const;

export function SnapNav({ active }: { active: "launch" | "keys" }) {
  const hint = PILLS.find((p) => p.key === active)?.hint ?? "";
  const base = "flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-150";
  const on = "border border-[#FFFC00]/40 bg-[#FFFC00]/10 text-[#f3f0a3]";
  const off = "border border-transparent text-dim hover:bg-raise hover:text-ink";
  return (
    <div className="sticky top-16 z-30 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6">
        <nav aria-label="Snapchat board" className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
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
