// One browser, several buyers (owner 12.10: "when another account signs in, it must reset"). The
// console remembers things in the browser that are NOT filed under a username — the launch channel and
// board mode last picked, the TikTok identities, the wave a clone board has just sent — and a tab
// opened under one login keeps its cards, its name tails and its own idea of "me" while the cookie
// behind it already belongs to somebody else. Two resets close that:
//   • signing in as a DIFFERENT account than this browser's last one forgets the shared memory
//     (noteSignedIn, called by the login form before it navigates);
//   • a tab that finds the browser signed in as somebody else starts over (components/session-watch).
// The task managers' offline fallbacks are filed per username already and stay where they are.

/** Who this browser last signed in as. Its `storage` event is also how the other tabs hear of a switch. */
export const LAST_USER_KEY = "adlauncher.user";

const OURS = "adlauncher.";
/** `adlauncher.tasks`, `adlauncher.hstasks.<user>`, `adlauncher.aiftasks.<user>`, … — one per buyer. */
const PER_USER = /^adlauncher\.[a-z]*tasks(\.|$)/;

/** The keys a different account must not inherit, out of everything a storage holds. Pure. */
export function sharedMemoryKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith(OURS) && k !== LAST_USER_KEY && !PER_USER.test(k));
}

function forget(store: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k) keys.push(k);
  }
  for (const k of sharedMemoryKeys(keys)) store.removeItem(k);
}

/** What THIS tab remembers (sessionStorage — the wave a clone board sent under the previous login). */
export function forgetTabMemory(): void {
  try {
    forget(sessionStorage);
  } catch {
    /* storage disabled — nothing was remembered either */
  }
}

/**
 * A login just succeeded as `username`. A different account than this browser's last one starts from
 * the defaults; the same buyer signing in again keeps their picks. True when it was a switch.
 */
export function noteSignedIn(username: string): boolean {
  try {
    const last = localStorage.getItem(LAST_USER_KEY);
    const switched = !!last && last !== username;
    if (switched) {
      forget(localStorage);
      forget(sessionStorage);
    }
    if (last !== username) localStorage.setItem(LAST_USER_KEY, username);
    return switched;
  } catch {
    return false;
  }
}
