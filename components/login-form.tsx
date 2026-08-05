"use client";

import { useState } from "react";
import { RocketIcon } from "./icons";

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4 animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.6" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) {
        window.location.href = "/"; // full nav so the server re-reads the new session cookie
        return;
      }
      setError(d.error || "Sign in failed.");
    } catch {
      setError("Network error — please try again.");
    }
    setLoading(false);
  }

  const field =
    "h-11 w-full rounded-xl border border-line bg-surface2/60 px-3.5 text-[14px] text-ink placeholder:text-faint " +
    "transition-colors duration-150 focus:border-accent/60 focus:bg-surface2 focus:outline-none " +
    "focus:ring-2 focus:ring-accent/25";

  return (
    <form
      onSubmit={submit}
      className="animate-pop-in flex w-full max-w-[380px] flex-col gap-5 rounded-2xl border border-line bg-surface/90 p-7 shadow-[0_30px_80px_rgba(0,0,0,0.55)] backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-accent via-[#5b6bff] to-accent2 shadow-[0_0_28px_rgba(61,127,255,0.4)]">
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
          <RocketIcon className="relative h-6 w-6 text-white" />
        </span>
        <div className="leading-tight">
          <h1 className="text-[18px] font-semibold text-ink">Ad Launcher</h1>
          <p className="mt-1 text-[12px] text-dim">Sign in to the campaign console</p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-user" className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
            Username
          </label>
          <input
            id="login-user"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="your username or email"
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="login-pass" className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
            Password
          </label>
          <input
            id="login-pass"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={field}
          />
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={loading || !username.trim() || !password}
        className={
          "flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/15 " +
          "text-[14px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 " +
          "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        }
      >
        {loading ? (
          <>
            <Spinner />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>

      <p className="text-center text-[11px] leading-relaxed text-faint">
        Use your Amazon Tools account — the same login works here.
      </p>
    </form>
  );
}
