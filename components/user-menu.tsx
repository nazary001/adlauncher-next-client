"use client";

import { useState } from "react";
import { LogoutIcon } from "./icons";

export type SessionUser = { username: string; role?: string | null };

export function UserMenu({ user }: { user: SessionUser }) {
  const [busy, setBusy] = useState(false);
  const initial = (user.username || "?").charAt(0).toUpperCase();

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

  return (
    <div className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface pl-2 pr-1">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/20 font-mono text-[10px] font-semibold text-[#9db8ff]">
        {initial}
      </span>
      <span
        className="hidden max-w-[110px] truncate text-[12.5px] font-medium text-dim xl:inline"
        title={user.username}
      >
        {user.username}
      </span>
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
    </div>
  );
}
