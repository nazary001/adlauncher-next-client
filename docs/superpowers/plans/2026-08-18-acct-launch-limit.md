# Per-Account Launch Rate Limit (5/30min) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No more than 5 campaigns may be created in any single ad account within a 30-minute window (anchored at the first launch), across all partners and all six launch/clone channels, with per-account timers visible in the header and full accounts unselectable.

**Architecture:** A server-side claim registry on Strapi `app-cache` rows (unique `ckey` = atomicity; claim-then-verify like gcm/aif-claim) guards every campaign-creating route; a `GET /api/acct-limit` snapshot feeds a client context that decorates account pickers, gates cards/rails, and renders a header timer widget.

**Tech Stack:** Next.js 16.3 App Router (nodejs runtime routes), Strapi 5 REST (`app-cache` collection, existing), React 19 client components, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-18-acct-launch-limit-design.md`

## Global Constraints

- `ACCT_LIMIT = 5`, `ACCT_WINDOW_MS = 30 * 60_000` — single source in `lib/acct-limit.ts`.
- Account key = numeric id with `act_` prefix stripped.
- Fail CLOSED when Strapi is unreachable during a claim (throw → launch errors).
- Release a slot only when NO campaign was created; ambiguous LION outcomes KEEP the slot.
- Repo conventions: no committed test framework — unit/API tests are ephemeral `_*.mts` scripts run with `npx tsx`, deleted before the final commit. Verification: `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- All Strapi list reads paginate (Strapi Cloud clamps pageSize to 100).

---

### Task 1: Core lib `lib/acct-limit.ts` + unit script

**Files:**
- Create: `lib/acct-limit.ts`
- Create (ephemeral): `_acct_limit_units.mts`

**Interfaces (Produces):**
```ts
export const ACCT_LIMIT = 5;
export const ACCT_WINDOW_MS = 30 * 60_000;
export class AcctLimitedError extends Error { resetAt: number; accountId: string }
export function acctKey(raw: string): string            // strip act_, trim
export function windowActive(ws: number, now: number): boolean
export type AcctWindowInfo = { count: number; resetAt: number; name?: string };
export type AcctLimitSnapshot = { now: number; limit: number; windowMs: number; accounts: Record<string, AcctWindowInfo> };
export function deriveSnapshot(                          // PURE — unit-testable
  windows: Array<{ ckey: string; value: unknown }>,
  slots: Array<{ ckey: string; value: unknown }>,
  now: number,
): AcctLimitSnapshot
export async function acctLimitSnapshot(): Promise<AcctLimitSnapshot>   // + opportunistic sweep
export async function claimAcctSlot(
  accountId: string,
  meta: { user?: string; partner?: string; channel?: string; name?: string; accountName?: string },
): Promise<{ documentId: string; count: number }>        // throws AcctLimitedError | Error (store down)
export async function releaseAcctSlot(documentId: string | null): Promise<void>  // best-effort DELETE
```

- [ ] **Step 1: Write the failing unit script** `_acct_limit_units.mts` (node asserts, run via `npx tsx _acct_limit_units.mts`): `acctKey("act_123")==="123"`; `windowActive(0, ACCT_WINDOW_MS-1)===true`, `windowActive(0, ACCT_WINDOW_MS)===false`; `deriveSnapshot` cases — active window with 3 slots → `{count:3, resetAt:ws+30m}`; expired window → dropped; slot rows of a stale ws ignored; name picked from latest slot meta; garbage cvalue tolerated.
- [ ] **Step 2: Run it** — expect module-not-found failure.
- [ ] **Step 3: Implement `lib/acct-limit.ts`.** Own fetch helpers against `${STRAPI_API_URL}/api/app-caches` (mirror `lib/aif-claim.ts` style; do NOT reuse `lib/app-cache.ts` — its writer collapses unique-violation and outage into one `null`). Row keys: window `acct-window:<id>` with `cvalue:{ws:number}`; slot `acct-slot:<id>:<ws>:<n>` with `cvalue:{user,partner,channel,name,accountName,ts}`. Claim protocol (bounded outer loop, 3 attempts):
  1. read window row; missing → POST (400 → re-read winner; other non-2xx → throw store error); expired/garbage `ws` → PUT fresh `{ws:now}` by documentId, then RE-READ and adopt the stored ws;
  2. list existing slots for `acct-slot:<id>:<ws>:` (prefix filter `filters[ckey][$startsWith]`), collect taken n;
  3. for `n = 1..ACCT_LIMIT` skipping taken: POST slot; 400 → next n; 2xx → verify win (re-read rows for that exact ckey, `sort=createdAt:asc,documentId:asc`; ours not first → DELETE ours, next n); then re-read the window row — ws changed → DELETE the orphan slot, restart outer loop;
  4. all 5 taken → `throw new AcctLimitedError(resetAt = ws + ACCT_WINDOW_MS, accountId)`.
  `acctLimitSnapshot()`: two paginated prefix reads (`acct-window:`, `acct-slot:`), `deriveSnapshot`, then best-effort sweep — DELETE ≤20 rows whose window expired > 5 min ago (slots of dead ws + dead window rows), fire-and-forget.
- [ ] **Step 4: Run the unit script** — all asserts pass.
- [ ] **Step 5: Commit** `feat: acct-limit core (window math + atomic slot claims)` (lib only; the script stays uncommitted).

### Task 2: `GET /api/acct-limit`

**Files:**
- Create: `app/api/acct-limit/route.ts`

**Interfaces (Produces):** `GET → { ok:true, now, limit, windowMs, accounts: {[actId]:{count,resetAt,name?}} }`, 401 without session.

- [ ] **Step 1:** Route: `runtime="nodejs"`; inline `sessionFromCookieHeader` check (defense-in-depth; proxy gates it too since the matcher excludes only named paths) → 401; then `NextResponse.json({ ok: true, ...(await acctLimitSnapshot()) })` with `Cache-Control: no-store`; catch → 502 `{ ok:false, error }`.
- [ ] **Step 2:** Verify live against the running dev server: unauth `curl` → 401; with a minted `adl_session` cookie (local AUTH_SECRET HMAC) → `{ok:true, accounts:{}}`.
- [ ] **Step 3: Commit** `feat: /api/acct-limit snapshot endpoint`.

### Task 3: Guards on the direct-Graph rails (MO launch, AIF launch, MO clone)

**Files:**
- Modify: `app/api/launch/route.ts` (claim before `claimGcm`, ~line 341)
- Modify: `app/api/aif/launch/route.ts` (claim before `claimBrand`, ~line 289)
- Modify: `app/api/clone/run/route.ts` (claim per copy, before the cross-account migration block ~line 291)
- Modify: `lib/fb-graph.ts` (+`tokenAccountName(id)` over the cached `tokenAdAccounts` list, mirroring `advertisablePageName`)
- Modify: `lib/aif-launch.ts` (+`aifAccountName(id)` if the TokenCatalog exposes the cached list; otherwise omit the name)

**Interfaces (Consumes):** Task 1's `claimAcctSlot/releaseAcctSlot/AcctLimitedError`.

- [ ] **Step 1:** In each route's per-campaign `try`, FIRST claim:
```ts
let acctSlot: { documentId: string } | null = null;
// inside try, before the marker claim / media migration:
acctSlot = await claimAcctSlot(binds.accountId, {
  user: session.username, partner: "in" /* "us" | "in"(clone) */, channel: "launch" /* "aif" | "clone" */,
  name, accountName: await tokenAccountName(binds.accountId).catch(() => ""),
});
```
In each `catch`, before the task-row error write:
```ts
if (acctSlot && !created.campaign_id) await releaseAcctSlot(acctSlot.documentId);
```
`AcctLimitedError` flows through the existing catch → task error text. Give it the human message at throw-time in lib: `Account limit: ${ACCT_LIMIT} campaigns / 30 min — resets in ${mm}:${ss}`.
- [ ] **Step 2:** `npx tsc --noEmit` clean.
- [ ] **Step 3:** Live seeded check (script `_acct_limit_api.mts`, kept for Task 5): seed 5 slots for a fake account id `999900000000001` directly via claims, then POST `/api/launch` with a campaign bound to it → NDJSON `error` event carrying "Account limit" WITHOUT any FB call (assert no campaign fields in `created`); gcm registry untouched. Clean the seeded rows (releaseAcctSlot).
- [ ] **Step 4: Commit** `feat: account rate-limit guard on MO/AIF launch + MO clone`.

### Task 4: Guards on the HS rails (LION create, FB token, duplicator)

**Files:**
- Modify: `app/api/hs/launch/route.ts` (claim before `lionCreateCampaign`, ~line 81)
- Modify: `app/api/hs/token-launch/route.ts` (claim first inside the stream `try`, ~line 187)
- Modify: `app/api/hs/duplicate/route.ts` (batch precheck before stamping; per-shot claim in `pumpBatch` phase 1; legacy path claims `copies` slots)

**Interfaces (Consumes):** Task 1 exports; `acctLimitSnapshot` for the precheck.

- [ ] **Step 1: `/api/hs/launch`** — after bind validation: `const slot = await claimAcctSlot(acctKey(c.account), { user, partner:"br", channel:"hs-lion", name: String(payload.campaign_name), accountName: account.name })`; wrap in try/catch: `AcctLimitedError` → `bad(err.message, 429)`; store-down → `bad("acct_limit_unavailable — launch blocked (registry unreachable)", 503)`. After `lionCreateCampaign`: success → keep; clean LION rejection (`result.result !== "success"` branch) → `releaseAcctSlot` then the existing `bad(...)`; thrown submit error (ambiguous) → KEEP.
- [ ] **Step 2: `/api/hs/token-launch`** — first act inside the stream try: claim (channel `"hs-token"`, accountName `account.name`); in catch: release when `!created.campaign_id`.
- [ ] **Step 3: `/api/hs/duplicate`** batch shape — after `validateBinds`, before row stamping:
```ts
const snap = await acctLimitSnapshot().catch(() => null);
if (!snap) return bad("acct_limit_unavailable — wave blocked (registry unreachable)", 503);
const info = snap.accounts[acctKey(account)];
const remaining = ACCT_LIMIT - (info?.count ?? 0);
if (info && info.count >= ACCT_LIMIT) return bad(acctLimitMessage(info.resetAt), 429);
if (shots.length > remaining && info) return bad(`account_limit — only ${remaining} of ${shots.length} clones fit this half-hour window (resets in …)`, 429);
```
In `pumpBatch` phase 1, per shot right before `lionDuplicate`: claim (channel `"hs-dup"`); `AcctLimitedError` → mark THIS and every remaining unsettled shot error with the limit message (deterministic for the pump's window) and stop submitting; store-down → per-shot error, continue nothing. Ambiguous `lionDuplicate` throw → KEEP slot; clean preflight rejection (`!lionTaskId`) → release. Legacy single-shot path: loop-claim `copies` slots before `lionDuplicate`; limited mid-loop → release the ones just claimed, `bad(429)`; rejection after submit-refusal → release all; ambiguous → keep.
- [ ] **Step 4:** `npx tsc --noEmit` clean; seeded live check for hs/launch (5/5 fake LION-shaped account can't be faked easily — instead seed the REAL test account id used by smoke, assert 429 pre-LION) — folded into Task 5's matrix.
- [ ] **Step 5: Commit** `feat: account rate-limit guard on HS rails (LION create / token / duplicator)`.

### Task 5: Live API matrix + race verification (no FB writes)

**Files:**
- Create (ephemeral): `_acct_limit_api.mts` (extends Task 3's script)

- [ ] **Step 1:** Against local dev + real Strapi: (a) race — `Promise.all` of 8 `claimAcctSlot("999900000000002")` → exactly 5 resolve, 3 throw `AcctLimitedError`, slot rows n=1..5 each single (verify by listing); (b) release → count drops; (c) window expiry — seed window row with `ws = now - 31min` + 5 stale slots, claim → succeeds fresh (count 1), snapshot drops stale, sweep deletes them; (d) route matrix — seeded-full accounts: `/api/launch` error-event, `/api/aif/launch` error-event, `/api/clone/run` per-copy error, `/api/hs/launch` 429, `/api/hs/token-launch` error-event, `/api/hs/duplicate` batch 429 (all WITHOUT reaching FB/LION: assert no created ids; hs routes need real LION catalog binds — use profile globecoders-1 + its first account, seeded then cleaned).
- [ ] **Step 2:** Clean every probe row (windows+slots for 9999… ids and the LION account), assert snapshot empty for them.
- [ ] **Step 3: Commit** (code unchanged — only run; commit only if lib fixes surfaced).

### Task 6: Client context `components/use-acct-limit.tsx`

**Files:**
- Create: `components/use-acct-limit.tsx`
- Modify: `app/(app)/layout.tsx` (wrap children with `<AcctLimitProvider>`)

**Interfaces (Produces):**
```ts
export function AcctLimitProvider({ children }): JSX.Element
export type AcctLimits = {
  limit: number;
  accounts: Record<string, { count: number; resetAt: number; name?: string }>; // key = acctKey
  countFor(id: string): number;            // server truth
  resetAtFor(id: string): number | null;
  refresh(): void;                          // immediate re-poll
  skew: number;                             // serverNow - clientNow
};
export function useAcctLimits(): AcctLimits            // context consumer
export function decorateAccountOptions<T extends RichOption>(opts: T[], limits: AcctLimits): T[]
// tag `${count}/5`, tagTone dim | warn(4) | danger(5), disabled at 5/5; value may carry act_ — acctKey it
export function acctLimitNote(resetAt: number, skew: number): string  // "5/5 — resets in 12:34"
```

- [ ] **Step 1:** Provider: fetch `/api/acct-limit` on mount, on `focus`/`visibilitychange`(visible), and every 30 s while visible (skip when hidden); 401 → stop until focus. Expose `refresh` so task terminals can poke it. State replaced per poll (consumers re-render ≤ every 30 s).
- [ ] **Step 2:** Mount in `app/(app)/layout.tsx` inside the task-manager providers. `npx tsc --noEmit`.
- [ ] **Step 3: Commit** `feat: acct-limit client context`.

### Task 7: Header timer widget

**Files:**
- Create: `components/acct-limit-widget.tsx`
- Modify: `components/header.tsx` (render `<AcctLimitWidget />` before the tasks button, ~line 94)

- [ ] **Step 1:** Widget (client): pill button — clock/gauge icon + label: no active windows → dim `–`; else `N/5` of the hottest account + its mm:ss countdown; any account at 5/5 → danger tone + `M full`. Local 1 s tick inside the widget only (`useNow`), corrected by `skew`. Click → absolute dropdown panel (idiom: task drawer styling, `rounded-2xl border-line bg-surface`, z-50, closes on outside click/Esc): rows per active account sorted by count desc — account name (fallback id), mono id, 5-segment bar (filled cells `bg-accent`, 4th `bg-warn`, full `bg-danger`), right mono countdown `mm:ss`; footer line "5 campaigns / account / 30 min · window starts on the first launch".
- [ ] **Step 2:** Visual check in the browser (dev server, seeded rows via script from Task 5 re-seed, then cleaned).
- [ ] **Step 3: Commit** `feat: header account-limit timer widget`.

### Task 8: Launcher gates (options, card, rail, board partition)

**Files:**
- Modify: `components/campaign-card.tsx` — wrap BOTH account option feeds with `decorateAccountOptions` (MO/AIF site ~line 544 `options={adAccounts ?? []}`, HS site ~line 517 `options={hsData?.accounts ?? []}`); extend `missingRequirements(c, partner, opts, acctFull)` to append `Account is full (5/5 this half-hour) — pick another or wait for the reset` and make the ready-dot amber (`ready = isLaunchable(...) && !acctFull`, ~line 263).
- Modify: `components/launch-rail.tsx` — accept `acctFullFor?: (c: Campaign) => boolean`; `ready = isLaunchable(c, opts) && !acctFullFor?.(c)` (~lines 46, 87) so dot/count/button agree with the card.
- Modify: `components/launcher-board.tsx` — consume `useAcctLimits()`:
  - `effCountFor(acctId)` = server `countFor` + own pending tasks (active partner's TM: `tasks.filter(t => t.local && (t.status==="queued"||t.status==="running") && t.partner===partnerId)` with account read from the task input campaign; HS: `hsTasks` pending per `c.account`);
  - `acctFullFor = (c) => { const id = acctKey(c.account); return !!id && effCountFor(id) >= limits.limit }` — passed to rail + per-card;
  - `launch()` partition: walk `launchable`, per-account running tally starting at `effCountFor`; enqueue while `tally < limit`, else collect into `held`; after the loop `setHeldBack(held.length)` (new state, rendered as an amber rail line "N held — account limit 5/30 min, resets soon; they stay on the board", cleared with the justQueued timer); applies to BOTH the MO/AIF loop and the HS loop;
  - `fillAccountDefaults` prefers a non-full account: pass `limits` in; when the default/first account is at 5/5 pick the first account with `countFor < limit` (fall back to the full one when every account is full);
  - call `limits.refresh()` alongside the reserved-set fold when a task reaches a terminal state (existing `tasks` effect ~line 239).
- [ ] **Step 1:** Implement; `npx tsc --noEmit` + `npm run lint` clean.
- [ ] **Step 2:** Browser check with seeded counts: option tags visible in MO + HS + AIF pickers, 5/5 option disabled, card dot amber with tooltip reason, rail count drops, launch holds back the overflow with the amber note.
- [ ] **Step 3: Commit** `feat: launcher gates + picker badges for the account limit`.

### Task 9: Clone-board gates

**Files:**
- Modify: `components/clone-board.tsx` — decorate the Destination account options (~line 414); when a TARGET account is picked (`isTargetAccount`): demand = Σ copies over valid rows; `remaining = limit - countFor(target)`; demand > remaining → disable Duplicate with the note `Account limit: only ${remaining} of ${demand} clones fit — resets in mm:ss`; "From each source" keeps no precheck (per-copy server guard answers; note this in a code comment).
- Modify: `components/hs-clone-board.tsx` — decorate account options (~line 361); `remaining = limit - countFor(acctKey(account))`; `totalClones > remaining` → Duplicate disabled (~line 422) + the hint line (~line 441) explains with the live reset time.
- [ ] **Step 1:** Implement; tsc/lint clean.
- [ ] **Step 2:** Browser check (seeded): HS duplicator blocks a 6-clone wave at 3 remaining; MO clone target-account block; option tags render.
- [ ] **Step 3: Commit** `feat: clone-board gates for the account limit`.

### Task 10: Full verification + cleanup

- [ ] **Step 1:** `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run build` (with `rm -rf .next` first if stale).
- [ ] **Step 2:** Re-run `_acct_limit_units.mts` + `_acct_limit_api.mts` end-to-end green; then delete both scripts and every probe row (list `acct-window:`/`acct-slot:` — only real traffic remains).
- [ ] **Step 3:** One real E2E through `/api/hs/token-launch` OR `/api/aif/launch` (whichever the owner's quota prefers; $0: create → verify slot row exists with count 1 → delete campaign → row stays by design (campaign existed) → manually clean the probe slot).
- [ ] **Step 4:** Playwright smoke (chromium in scratchpad, minted session): header widget renders counts; picker option disabled at 5/5.
- [ ] **Step 5: Commit** remaining changes; update memory file per project convention.
