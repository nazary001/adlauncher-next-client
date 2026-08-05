# Multi-user concurrent support — per-user Task Manager scoping

Date: 2026-08-06
Status: approved for implementation (autonomous session; user request: "when several people
log in simultaneously from different accounts, everything — including the Task Manager —
must display correctly and nothing must break").

## Problem

Login exists (per-account HMAC sessions), but all server-side Task Manager state is global:

1. `GET /api/launch-tasks` returns **every** row → each user's drawer restores everyone's
   tasks on page load.
2. `asRestored()` marks any non-terminal restored row as "Interrupted by page reload" —
   so user B merely loading the page shows user A's **still-running** launch as a false error.
3. Destructive cross-user actions: user B's *Clear finished* / *Dismiss* deletes user A's rows
   from Strapi (including falsely-"interrupted" ones actually still running in A's browser).
   A's next reload silently loses history.
4. `localStorage` fallback key `adlauncher.tasks` is account-agnostic → two accounts on one
   browser mix task lists.
5. No owner attribution exists at all (`launch-task` collection has no user field).

Already safe (no change needed): task ids are `crypto.randomUUID()`-based (collision-proof
across users); gcm claims are atomic via the Strapi unique constraint and walk forward on
conflict; Blob uploads are tokenised per upload with random suffixes; FB rate-limit
retry/backoff + usage-header throttling are per-call and hold under N parallel users;
login throttle counts only failures.

## Approaches considered

- **A. Per-user scoping via an `owner` field (chosen).** Server stamps `owner` from the
  session cookie on create, filters GET, and refuses cross-owner update/delete. Each user
  sees and manages only their own queue. Smallest change, removes every failure mode above.
- **B. Shared team view with owner chips.** Everyone sees all tasks. Requires solving
  "is A's task really interrupted or still running in A's browser?" (heartbeats), plus
  owner-scoped destructive ops anyway. Much more complexity for a view nobody asked for.
- **C. localStorage-only (drop shared Strapi persistence).** Regresses F5-restore. No.

## Design (approach A)

### Strapi (gc-server, deploy FIRST)
- Add `owner` (string) to `launch-task` schema. Additive; legacy rows keep `owner=null` and
  become invisible to everyone (harmless history; tests were cleaned up).
- Deploy order matters: Strapi must accept the `owner` key before the app sends it
  (Strapi 5 rejects unknown attributes with 400 "Invalid key").

### `/api/launch-tasks` (adlauncher)
- All three handlers resolve `owner = session.username` via `sessionFromCookieHeader`
  (route stays behind the proxy gate; this is defense in depth + gives us the identity).
  No session → 401.
- `GET` → `filters[owner][$eq]=<username>`, unchanged pageSize 100 (now per user).
- `POST` upsert → on create, force `owner`; on update, fetch the row's owner and return
  403 if it isn't the caller's. Client never supplies `owner` (whitelist unchanged).
- `DELETE` → same owner check per id; skip (don't delete) rows that aren't the caller's.

### Client (task-manager.tsx, launcher-board.tsx)
- `TaskManagerProvider` gets the `user` prop; localStorage key becomes
  `adlauncher.tasks.<username>` (legacy `adlauncher.tasks` removed once on mount).
- On `done`, patch the in-memory `task.gcm` with the server-claimed `f.gcm` — under
  concurrency the optimistic preview code and the actually-claimed code diverge more often
  (claim walks forward), and the drawer should show the real one.

### gcm preview freshness (launcher-board.tsx)
- Correctness is already guaranteed at claim time; only the *preview* can go stale when
  another user claims a code. Refetch `/api/gcm` on window focus (≥15s between fetches),
  replace the `reserved` set and renormalize, so previews converge on reality.

## Error handling
- Missing/invalid session on any launch-tasks call → 401 (proxy already redirects pages).
- Cross-owner POST/DELETE → 403 / silent skip; client save chain already swallows
  non-OK responses (fire-and-forget persistence, localStorage still mirrors locally).
- Strapi without the `owner` field (deploy-order violation) → create 400s; mitigated by
  sequencing (schema first, verified live, then app deploy).

## Testing
- `tsc --noEmit`, eslint, `next build`.
- Two minted sessions (signSession with the env AUTH_SECRET) → curl matrix against the
  running app: A creates; B's GET excludes it; B's POST-update and DELETE on A's task_id
  are refused; A still sees/updates own. Test rows cleaned from Strapi afterwards.
- Prod smoke after Vercel deploy with prod-minted sessions (no FB launches — quota).
