# Per-account launch rate limit — 5 campaigns / 30 min (all partners, all channels)

**Date:** 2026-08-18 · **Status:** approved (chat) · **Owner ask:** no more than 5 campaigns
may land in any single ad account within a 30-minute window, across every partner and both
the launcher and the cloner; a visible, pretty timer shows per-account usage; full accounts
become unselectable until their window resets.

## 1. Semantics

- **Unit = one created campaign** (РК), regardless of channel. Six routes create campaigns
  and all of them enforce the limit: `/api/launch` (MO), `/api/clone/run` (MO cloner),
  `/api/hs/launch` (HS LION create), `/api/hs/duplicate` (HS LION pump), `/api/hs/token-launch`
  (HS FB Token), `/api/aif/launch` (AIF).
- **Window is anchored at the first launch** (user's explicit choice): the first campaign
  into an account opens that account's window; for the next 30 minutes at most 5 campaigns
  total may enter it; when the window expires the counter vanishes and the next campaign
  opens a fresh window. Every account has its own independent countdown.
- Constants live in one place: `ACCT_LIMIT = 5`, `ACCT_WINDOW_MS = 30 * 60_000`
  (`lib/acct-limit.ts`).
- **Global scope:** all users and both boards share the same 5 slots per account (the limit
  protects the account, not the user). Launches made outside adlauncher (Ads Manager,
  weapon UI) are invisible to the counter — accepted honesty limitation, same class as the
  fanpage N/250 badges.
- **Slot lifecycle:** a slot is claimed immediately before campaign creation starts.
  Failure *before* the FB/LION campaign exists → the slot is released back. Failure *after*
  → the slot stays (the campaign exists and counted against the account). LION submits:
  an accepted submit keeps the slot forever; an ambiguous network outcome also keeps it
  (exactly-once philosophy — assume created, over-counting is safer than under-counting).
- **Fail closed:** when Strapi is unreachable the claim throws and the launch errors out.
  Consistent with gcm/brand/wave claims; with Strapi down most flows are dead anyway.

## 2. Storage & atomicity

Rows in the existing Strapi `app-cache` KV collection (`ckey` unique) — no gc-server deploy:

- `acct-window:<actId>` → `{ windowStart }` — the window anchor for one account
  (`actId` is the canonical numeric id, `act_` prefix stripped).
- `acct-slot:<actId>:<windowStart>:<n>` (n = 1..5) → `{ user, partner, channel, name,
  accountName, ts }` — one row per launched campaign; the unique ckey makes the claim atomic.

Claim protocol (mirrors `lib/gcm-claim` / `lib/aif-claim`, proven live under concurrent waves):

1. Read the window row. Missing → POST it (`windowStart = now`); unique-violation → re-read
   and adopt the winner's anchor. Expired → PUT a fresh anchor by documentId, then re-read
   and adopt whatever is stored (last-write-wins converges).
2. Count existing slots for `<actId>:<windowStart>` and try `n = count+1 … 5`: POST the slot
   row; 400 (taken) → next n; 2xx → verify via re-read (oldest createdAt+documentId wins,
   loser deletes its row and tries the next n). All n taken → `limited` with
   `resetAt = windowStart + 30min`.
3. After a slot win, re-read the window row; if the anchor changed (boundary race), delete
   the orphan slot and retry the whole claim (bounded retries).

Expired window/slot rows are swept opportunistically by the snapshot endpoint (best-effort,
bounded deletes, 5-min grace so a just-expired window isn't churned).

Rejected alternatives: dedicated Strapi collection (cleaner but needs a cross-repo deploy);
deriving counts from `launch-task` rows (no account column; HS reuses columns); in-memory
(Vercel serverless — no shared/persistent state).

## 3. Server guards

| Route | Claim point | Release on pre-campaign failure |
|---|---|---|
| `/api/launch` | in-stream, before gcm claim | yes |
| `/api/clone/run` | per copy, before gcm claim (target account or per-source) | yes |
| `/api/hs/launch` | before `lionPostOnce` | yes (preflight rejects) |
| `/api/hs/duplicate` | per shot inside the server pump | yes |
| `/api/hs/token-launch` | before campaign create | yes |
| `/api/aif/launch` | before brand claim | yes |

A limited claim fails the task with a human message: **“Account limit: 5 campaigns / 30 min —
resets in MM:SS”** (retryable after reset). Claim meta records `accountName` when the route
has it from its catalog, so the UI panel can label accounts without extra catalog wiring.

## 4. API + client state

- `GET /api/acct-limit` (session-gated): `{ now, limit, windowMs, accounts: { [actId]:
  { count, resetAt, name? } } }` — two Strapi list queries total (windows + slots), expired
  windows dropped, sweep piggybacked.
- `useAcctLimit` context, provider mounted once in `app/(app)/layout.tsx`. Polls every 30 s
  while the tab is visible, immediately on focus and after each own task reaches a terminal
  state; countdowns tick locally with server-skew correction.

## 5. UI

- **Header widget** (both boards, all partners): a compact pill — timer icon plus the
  hottest account's countdown / “N full”; dim and quiet when no windows are active.
  Click → dropdown panel: one row per account with an active window — name, mono id,
  segmented 5-cell bar, live mm:ss countdown; tones dim → warn (4) → danger (5/5).
- **Account pickers** (MO card, MO clone Destination, HS launcher cascade, HS clone board,
  AIF card): right-aligned `N/5` tag per option; at 5/5 the option is `disabled`
  (existing generic SearchSelect feature, same as overfull fanpages). Auto-default account
  resolution (`fillAccountDefaults`, AIF first-by-sort) prefers a non-full account.
- **Card / launch rail:** a card whose selected account is full is not launchable; the
  blocker reason carries the live countdown. Before sending a wave the rail computes
  per-account demand (including the user's own queued/running tasks) against remaining
  slots; the overflow cards stay on the board with an amber note instead of flying into a
  guaranteed rejection.
- **HS duplicator:** the Duplicate button blocks when the wave's shot count exceeds the
  remaining slots of the bound account.
- Other users' queued-but-not-yet-launched tasks are invisible to the pre-check (no account
  column in shared rows); the server claim is the authority and the loser gets the clean
  retryable error.

## 6. Testing

- Unit: window math (anchor/expiry/reset), claim walk + verify logic on mocked fetch.
- API matrix: all six routes against seeded 5/5 slots on the live Strapi collection —
  clean rejection without any FB/LION call, release-on-early-failure semantics; probe rows
  cleaned up.
- Race: 8 concurrent claims for one account on live Strapi → at most 5 winners, no
  duplicate slot rows.
- Playwright: option tags, disabled-at-5/5, header panel countdown, rail hold-back note.
- One live E2E through a real route ($0, deleted after) proving slot claim + backfill.
