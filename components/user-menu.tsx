"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckIcon, ChevronDownIcon, LogoutIcon, SparklesIcon, UsersIcon } from "./icons";

export type SessionUser = {
  username: string;
  role?: string | null;
  /** Computed SERVER-side (lib/roles reads env) and passed down — the client never decides. */
  owner?: boolean;
};

export function UserMenu({ user }: { user: SessionUser }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const initial = (user.username || "?").charAt(0).toUpperCase();

  // Close on outside click / Escape (same manners as the other header popovers).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore — navigate regardless */
    }
    window.location.href = "/login";
  }

  const identity = (
    <>
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/20 font-mono text-[10px] font-semibold text-[#9db8ff]">
        {initial}
      </span>
      <span
        className="hidden max-w-[110px] truncate text-[12.5px] font-medium text-dim xl:inline"
        title={user.username}
      >
        {user.username}
      </span>
    </>
  );

  const logoutBtn = (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      data-tip="Sign out"
      aria-label="Sign out"
      className="tip tip-b flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-raise hover:text-danger disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <LogoutIcon className="h-4 w-4" />
    </button>
  );

  // Non-owners keep the plain chip — no menu to open, nothing changes for them.
  if (!user.owner) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface pl-2 pr-1">
        {identity}
        {logoutBtn}
      </div>
    );
  }

  const onAccounts = pathname === "/accounts";
  const onAutoLandings = pathname === "/auto-landings";

  return (
    <div ref={boxRef} className="relative">
      <div className="flex h-9 items-center gap-1 rounded-full border border-line bg-surface pl-1 pr-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          className={
            "flex h-7 items-center gap-2 rounded-full pl-1 pr-1.5 transition-colors " +
            "hover:bg-raise focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
            (open ? "bg-raise" : "")
          }
        >
          {identity}
          <ChevronDownIcon
            className={`h-3.5 w-3.5 text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          />
        </button>
        {logoutBtn}
      </div>

      {open ? (
        <div
          role="menu"
          className={
            "absolute right-0 top-full z-50 mt-2 w-[264px] animate-pop-in rounded-2xl border " +
            "border-line bg-surface p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.5)]"
          }
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/20 font-mono text-[12px] font-semibold text-[#9db8ff]">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink">{user.username}</p>
              <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#9db8ff]">
                {user.role || "owner"}
              </p>
            </div>
          </div>

          <div className="mx-1 my-1 h-px bg-line" />

          <p className="px-2.5 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-faint select-none">
            Owner tools
          </p>
          <Link
            href="/accounts"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={
              "group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
              (onAccounts ? "bg-accent/10" : "hover:bg-raise")
            }
          >
            <span
              className={
                "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border transition-colors " +
                (onAccounts
                  ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                  : "border-line bg-surface2 text-dim group-hover:text-[#9db8ff]")
              }
            >
              <UsersIcon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                Account access
                {onAccounts ? <CheckIcon className="h-3.5 w-3.5 text-[#9db8ff]" /> : null}
              </span>
              <span className="block text-[11px] leading-snug text-faint">
                Split FB ad accounts between the team
              </span>
            </span>
          </Link>
          <Link
            href="/auto-landings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={
              "group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors " +
              (onAutoLandings ? "bg-accent/10" : "hover:bg-raise")
            }
          >
            <span
              className={
                "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border transition-colors " +
                (onAutoLandings
                  ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                  : "border-line bg-surface2 text-dim group-hover:text-[#9db8ff]")
              }
            >
              <SparklesIcon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                Auto landings
                {onAutoLandings ? <CheckIcon className="h-3.5 w-3.5 text-[#9db8ff]" /> : null}
              </span>
              <span className="block text-[11px] leading-snug text-faint">
                Generate &amp; schedule MK Learn articles
              </span>
            </span>
          </Link>

          <div className="mx-1 my-1 h-px bg-line" />

          <button
            type="button"
            role="menuitem"
            onClick={logout}
            disabled={busy}
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium text-dim transition-colors hover:bg-raise hover:text-danger disabled:opacity-50"
          >
            <LogoutIcon className="h-4 w-4" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
