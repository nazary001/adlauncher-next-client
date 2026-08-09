# Shared Task Manager visibility — live, truthful, cross-account (2026-08-09)

## Problem

Every account must see everyone's launches/clones correctly **at any moment**. The current
implementation (shared GET + owner-scoped writes) has structural holes:

1. **Two `TaskManagerProvider` mounts** — `/` (launcher) and `/clone` each wrap themselves.
   Navigating between boards unmounts the provider mid-run: the queue ref dies (queued rows become
   eternal ghosts), the new provider falsely marks the still-running task "Interrupted", and two
   independent single-flight workers can run FB calls in parallel.
2. **No liveness model** — `asRestored()` is applied to *every* fetch, so my rows running on another
   device/tab always display as "Interrupted by page reload" (false); the interruption is never
   persisted, so the owner sees "error" while everyone else sees a forever-"running" ghost with a
   ticking timer. A browser closed mid-wave leaves "queued"/"running" rows in Strapi forever.
3. **Stage never persisted during a run** — teammates see a launch stuck on "Uploading video" for
   the whole run, then jump straight to done.
4. **Refresh only with the drawer open (15s) or on window focus** — the header badge goes stale.
5. **Deleted rows never leave other sessions** — `mergeShared` keeps any current row missing from
   the fetch, so a teammate's Dismiss/Clear only disappears for them.
6. **Strapi clamps pageSize to 100** (probe-verified; 109 rows exist today) — restore already
   silently truncates. No time window, unbounded growth.
7. **Swallowed saves** — a failed terminal save (`.catch(() => {})`, no retry) leaves a permanent
   running-ghost for the team.

## Design

**One provider.** Route group `app/(app)/` with a server layout that reads the session and mounts
`TaskManagerProvider` once above both boards. URLs unchanged; queue/worker survive navigation.

**Server-authoritative progress.** `/api/launch` and `/api/clone/run` accept the task id and write
`status/stage` transitions + the terminal state to the launch-task row **server-side** (chained,
non-blocking, flushed before the stream closes; owner-guarded via shared `lib/task-store.ts`).
The row now stays truthful even if the launching browser dies mid-run — a launch that completes
after the tab closed still lands as done for the whole team.

**Liveness instead of guessing.** GET returns Strapi's `updatedAt` per row (`updated_ms`) + server
`now`. A 25s client heartbeat re-upserts the running task (identical PUT bumps `updatedAt` —
probe-verified). An owner is *live* while any of their rows updated within `STALE_MS` (180s).
Non-terminal rows of a dead owner render as **stale/interrupted** (amber, derived — client-side
only, recomputed over time). No more `asRestored`: fetched rows are taken at face value.

**Convergence.** (a) `pagehide` beacon batch-marks this session's local queued/running rows as
interrupted (server-writer later overwrites if the server is in fact still finishing — self-heals
to the truth). (b) Each session persists the interrupt for its *own* stale rows once (owner
authority), so Strapi converges even after a crash. Others' dead rows stay derived-stale until
their owner returns.

**Merge.** Local (this-session) tasks always win; every non-local row mirrors the fetch exactly —
present = shown, absent = deleted (tombstones stop an in-flight fetch from resurrecting a row just
deleted here). Rows sort by `queued_at` desc.

**Freshness.** Poll `/api/launch-tasks` every 4s with the drawer open / 12s closed, paused while
the tab is hidden, immediate on focus/visible; stop on 401 until the next focus. GET filters to a
7-day window, owner-not-null, and paginates up to 3×100 rows.

**UI.** Owner chips get a stable per-user hue; stale rows render amber ("Interrupted — session went
offline") distinct from real errors; a "Mine" toggle filters the list; counts/badge use *effective*
status so dead ghosts never inflate "active".

## Invariants kept

- Mutations stay owner-scoped (403 foreign update, DELETE skips foreign) — visibility is shared,
  authority is not.
- Single-flight worker per session; retry only for local, non-partial failures.
- No Strapi schema change (no gc-server deploy needed).
