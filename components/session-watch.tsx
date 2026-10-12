"use client";

import { useEffect } from "react";
import { LAST_USER_KEY, forgetTabMemory } from "./account-switch";

// A tab is rendered for ONE login: its cards default their name tail to that username, the task
// managers file "my rows" under it, the name previews print it. The cookie behind the tab can change
// underneath it — somebody signs in as another account in the next tab, or the owner renames the login
// — and from then on the tab would launch as one buyer while showing (and naming) another. So the tab
// asks who it is: when another tab signs in (the `storage` event — at once), when it comes back to the
// foreground, and every few minutes. A different answer starts the tab over under the real login.
//
// An expired login is NOT this component's business: the proxy sends the next navigation to /login and
// the uploader has its own wording; a tab full of unsent cards must survive a re-login in another tab.

const ASK_EVERY_MS = 5 * 60_000;
const ASK_GAP_MS = 30_000; // focus / visibility can fire in bursts
/** The switch this tab already reloaded for — a reload that did not help must not become a loop. */
const RELOADED_KEY = "adl.session-watch.reloaded";

export function SessionWatch({ username }: { username: string }) {
  useEffect(() => {
    let off = false;
    let asking = false;
    let askedAt = 0;

    try {
      if (localStorage.getItem(LAST_USER_KEY) !== username) localStorage.setItem(LAST_USER_KEY, username);
    } catch {
      /* storage disabled — the periodic ask still covers this tab */
    }

    const startOver = (now: string) => {
      const pair = `${username}\n${now}`;
      try {
        if (sessionStorage.getItem(RELOADED_KEY) === pair) return;
        forgetTabMemory();
        sessionStorage.setItem(RELOADED_KEY, pair);
      } catch {
        /* storage disabled — reload anyway; the server render is what resets the tab */
      }
      window.location.reload();
    };

    const ask = async (force = false) => {
      if (off || asking || (!force && Date.now() - askedAt < ASK_GAP_MS)) return;
      asking = true;
      askedAt = Date.now();
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return;
        const d = (await r.json().catch(() => ({}))) as { username?: unknown };
        if (!off && typeof d.username === "string" && d.username && d.username !== username) startOver(d.username);
      } catch {
        /* offline or slow — ask again later */
      } finally {
        asking = false;
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === LAST_USER_KEY && e.newValue && e.newValue !== username) void ask(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    const onFocus = () => void ask();

    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void ask(), ASK_EVERY_MS);
    void ask(true);

    return () => {
      off = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [username]);

  return null;
}
