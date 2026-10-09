# Every rail on the durable launch queue — nothing a launch needs lives in the tab

Owner ask, 09.10.2026 (verbatim, shortened): «проработай максимально … чтобы когда делаются запуски
всё делалось на сервере, тот же Snapchat и так далее … чтобы можно было спокойно закрывать вкладку
после того как сделал запуск … поищи баги … максимально стабильно и корректно». Applies to BOTH
launchers (glo-01 and glo-02 run this one codebase — `lib/team.ts`).

## 1. Where launches stand today, and what still needs a tab

| Rail | Today | What a closed tab (or a dead function) costs |
|---|---|---|
| MO / AIF / AV launches, FB clones, HS launches (lion / token / tool) | durable **server queue** (`launch_jobs`, lane pumps, every-minute cron, retry / cancel) since 08.10 | nothing — the tab only hands over |
| Snapchat launch + clone (`/api/snap/launch`) | `after()` wave pump, 770 s budget, not durable | shots past the budget: "fire it again"; a platform kill mid-wave: rows `running` for 3 h, key `active` with no ids, no sweeper, no retry |
| Google launch / clone / JURO | `after()` wave pump | same class: budget cut = "fire it again", no sweeper, no retry |
| TikTok launch / clone / JURO | `after()` wave pump (+ a settle pass that upgrades "Sent to LION") | same class; a task LION finishes after the window stays "Sent to LION" for good |
| HS LION duplicates (`/api/hs/duplicate`) | `after()` pump: submit → poll → **activate** (clones are born PAUSED) | whatever the pump does not settle inside its window "is picked up by any later tab's poller" — **with every tab closed a clone LION finishes late stays PAUSED**, rename never lands, the row says "submitted" until the HS drawer's 3 h cap |
| HS JURO (`/api/hs/jurar`) | same shape (born ACTIVE; activation is a belt; Meta walls settle shots) | rows left "submitted"; wall detection / shell pause skipped |
| HS token duplicate / token JURO | `after()` pump, one full Graph tree per shot, cap 10 shots | budget cut = "re-fire"; a kill mid-tree leaves an ACTIVE partial tree un-paused |
| HS TOOL duplicate | `after()` pump: submit + follow the child job | "TOOL is still finishing … past the wave window — verify in Ads Manager" with nobody ever finishing the row |

Everything in rows 2–8 answers the browser at once, so a buyer *can* close the tab today — what
they lose is **durability**: a long wave is cut, a dead function leaves `running` rows nobody closes,
there is no Retry, and the HS clone activation can depend on a tab.

## 2. Decision

One mechanism, already proven on the FB rails: **every shot of every rail becomes a job of the
durable queue** (`launch_jobs`), run by the lane pump with leases, the every-minute sweep,
at-most-once, retry / cancel, update-safety and the hand-off contract — and the long tails that come
AFTER a submit (LION creation polling + activation, TikTok settle, TOOL job follow) become
**follow-up jobs**: idempotent, re-runnable, sliced, living in their own lane so they never hold
a submit lane.

The routes keep their validation byte for byte (session, team gates, catalogs, launch-limit
pre-check, wave idempotency claim); only their tail changes: `stamp rows → claim → after(pump)` becomes
`stamp rows → claim → enqueue one job per shot (+ one follow-up per wave) → after(pumpLane)`. The pure
pump cores (`lib/snap-pump-core.ts`, `lib/tiktok-pump-core.ts`, the Google pump, the HS pumps' loop
bodies) are reused **per shot** — a list of one — so nothing about how a campaign is built changes.

Not chosen: (a) keeping the after() pumps and adding a sweeper for their rows — it leaves budget
cuts and lost activations in place and adds a second recovery mechanism; (b) one job per wave —
at-most-once is per job, so one kill would strand up to 44 shots as "interrupted".

## 3. Queue model changes (`lib/launch-queue-types.ts`, `-store.ts`, `.ts`, `-run.ts`)

### 3.1 Scopes and kinds

* Scopes: `mo aif av hs` + **`gg sn tt`** (one drawer each; partner tags `gg sn tt`).
* Kinds (handler-reply kinds unchanged): `mo.launch aif.launch av.launch fb.clone hs.lion hs.token
  hs.tool` + **runner kinds**: `sn.launch` (clones ride it with `cloneOf`), `gg.launch gg.clone
  gg.juro`, `tt.launch tt.clone tt.juro`, `hs.dup hs.jurar hs.tokendup hs.tokenjurar hs.tooldup`,
  and **follow-up kinds** `hs.dup.follow hs.jurar.follow hs.tooldup.follow tt.follow`.
* `teamAllowsJob`: `gg/sn/tt` scopes need `platform:<x>`; `hs.dup`/`hs.jurar` (+follow) = channel
  `lion`, `hs.tokendup`/`hs.tokenjurar` = `token`, `hs.tooldup` (+follow) = `tool`.
* Lane names: `<scope>:<user>` for submits; **`<scope>-follow:<user>`** for follow-ups (regex
  widened). Follow-ups never block submits and vice versa.
* `worstCaseMs(kind, body)`: per kind, from the rail's own constants — Snap: media batches ×
  (download + READY 120 s) + chain, capped at `PUMP_BUDGET_MS − margin` (the core self-limits past
  its deadline exactly as today); Google: dataset budget 180 s + submit 60 s; TikTok submit: 60 s (+
  one dataset fetch 30 s); HS dup / jurar submit: 2 × 60 s LION + registry; token dup / jurar: 310 s
  (FB budget 240 s + pause); TOOL dup: submit + a 60 s first look; follow-ups: one slice (4 min).

### 3.2 New job fields (schema version stays 1 — old code ignores unknown fields and never meets
these kinds: an older build refuses unknown kinds cleanly, `unsupportedReason`)

* `group` — the wave id (siblings of one Launch click). Indexed with `lane`.
* `idempotent` — true on follow-ups: a lost lease **re-queues** (bounded `attempts ≤ 60`) instead of
  "interrupted"; `began` stays the money line for everything else.
* `not_before` — a job is claimable only when `not_before ≤ now` (null = at once). The sweep only
  restarts lanes that have a DUE job.
* `row_extra` — rail display columns stamped on the queued row (Google `adset_id`=customer,
  `ad_id`=currency; TikTok the same; Snap `gcm`=desired key) and never nulled by the pump.

Store primitives added: `deferJob(jobId, runner, notBefore, bodyPatch?)` (running → queued, lease
cleared, attempts kept, `not_before` set, body patched atomically — the follow-up's progress note);
`failQueuedSiblings(lane, group, match, patch)` (one `updateMany` over QUEUED siblings — "a refusal of
one copy refuses the identical copies without sending them", today's `familyFailed` / `rowRefusal` /
"same account window full" rules, made durable); `claimNextJob` honours `not_before`;
`lanesNeedingPump` ignores lanes whose only queued jobs are not due; `reapExpiredJobs` re-queues
`idempotent` jobs that began.

`runLane` gains one outcome branch: a runner may answer `{ defer: { notBefore, body } }` instead of a
verdict — the pump calls `deps.defer` (row untouched) and goes on to the next job.

### 3.3 Runners (`lib/launch-queue-runners.ts`)

`RUNNERS[kind](job, ctx) → JobOutcome | Defer`, where `ctx = { deadlineAt, log }`. Each runner builds the
rail's deps exactly as the old `pump*Wave` binder did, with ONE difference: the task-row writer carries
`srv: 1` on every write (the client then never judges, settles or writes the row), and the writer is
**observed** — the last terminal write the core makes for the task is what the runner turns into the
job verdict (`verdictFromRow`: `done` → done with the ids; `interrupted` → not retryable, ambiguous;
`error` without a created id at a stage before anything exists → retryable; `error` with a campaign id
→ not retryable). Settle then repeats that same row (consistent double write, as on the FB rails).

* `sn.launch` → `runSnapPump(user, [shot], deadline, deps)` (clone = same shot with `cloneOf`). Media
  reuse across copies of one card on one account — today an in-wave map — becomes a small durable
  cache in `app_caches` (`snap-media:<account>|<sha1(url)>` → media id, 12 h) read through two new
  optional core deps (`lookupMedia` / `rememberMedia`); the in-process map stays for the running
  invocation.
* `gg.*` → `pumpGoogleWave(user, [shot], deadline, deps)` (the dataset phase is idempotent per
  source — `gwEnsureDataset` fetch → poll — so the first copy of a source pays it; the others find it
  ready). A deterministic partner refusal (4xx) fails the queued copies that share the `rowKey`
  (`failQueuedSiblings`), as the wave did in memory.
* `tt.launch|clone|juro` → `runTiktokPump([shot], deadline, deps, { settleMs: 0 })` — submit only;
  the settle pass moves to `tt.follow`. The cold-source wait stays inside the shot (it is bounded by
  `giveUpMs`).
* `hs.dup` / `hs.jurar` → the submit body of today's phase 1, moved verbatim into
  `lib/hs-dup-shot.ts` / `lib/hs-jurar-shot.ts` (one shot: team check, bid plan, slot, LION submit,
  bid read-back, ledger). The LION task id goes into `result.link` (and the row's `link`); the job is
  **done** at acceptance ("submitted"), exactly as the hs.lion launch is done at acceptance.
  Family / account-window refusals fail the queued siblings.
* `hs.tokendup` / `hs.tokenjurar` → the loop body of today's pumps, verbatim, in
  `lib/hs-token-dup-shot.ts` / `lib/hs-token-jurar-shot.ts`, under `withFbBudget({ deadlineAt })`.
  Source trees / migrated media are cached per process (the copies of a wave run back to back in one
  invocation almost always; a cold cache only costs a re-read).
* `hs.tooldup` → submit + a 60 s first look (`runToolDuplicate` with `deadlineAt = now + 60 s`);
  `pending` → the row stays "running · tool job #N" and the follow-up finishes it.

### 3.4 Follow-ups

One per wave, enqueued by the route together with the submits (`not_before = now + 20 s`, lane
`<scope>-follow:<user>`, `group = waveId`, `until = now + FOLLOW_MAX` — 3 h for LION, matching the
HS drawer's old cap; 30 min for TOOL and TikTok). A follow-up slice:

1. reads its sibling submit jobs (`group`) and their rows — pending = submit done, LION / TOOL /
   TikTok task id known, row still open;
2. polls (LION `creation-status` + the `details/` reality check every 40 s; TikTok `twTask`; TOOL
   `getJob`), and for each finished one does what the pump's phase 2 did: rename (token teams), bid
   gate, wall detection (`lionRoasWall`, `juroBlockingError` + shell pause), **activate with retry**
   (`lionActivateWithRetry`), write the done row — all idempotent, all written only over a still-open
   row (`patchOpenTaskRow`), so a repeated slice can never demote a settled row;
3. after `FOLLOW_SLICE_MS` (4 min) or when nothing is pending: nothing pending → done; pending and
   `now < until` → `defer(now + 20 s)`; past `until` → closes the stragglers with the drawer's old
   sentence ("Still not finished on LION after 3 h — check the LION dashboard", campaign id kept) and
   is done.

Phase-2 logic is ported into pure, deps-injected cores (`lib/hs-follow-core.ts`, `lib/tt-follow-core.ts`,
`lib/tool-follow-core.ts`) so `node --test` proves the dispositions.

### 3.5 Routes

`/api/snap/launch`, `/api/google/{launch,clone,juro}`, `/api/tiktok/{launch,clone,juro}`,
`/api/hs/{duplicate,jurar,token-duplicate,token-jurar,tool-duplicate}`: validation unchanged; then
`stamp rows (queuedRow + row_extra) → wave claim (unchanged key, so /api/wave-status and the old
re-POST idempotency keep working) → insert jobs (job_id = the shot's task id — a re-POST of a wave meets
existing ids and answers alreadyAccepted) → after(pumpLane(submit lane)) → after(pumpLane(follow lane))
→ the same JSON answer as today`. Fail closed exactly as today (store down = `…_wave_not_fired` 503).
`maxDuration` stays 800 (the invocation hosts the first pump window).

`POST /api/launch-queue` (`retry` / `cancel`) now accepts the new scopes; `GET /api/acct-limit`'s
queued demand counts the new kinds' accounts.

### 3.6 Client

* The Google / Snapchat / TikTok drawers: rows with `srv` are never "session offline" and never aged
  out by the tab (the sweep owns them); the list routes return `srv` / `retry`; own `error` rows with
  `retry` get **Retry**, own `queued` rows **Cancel** (through `launch-queue-client`, as the MO
  drawer). A "queued" row reads "queued on the server".
* HS drawer: duplicate / JURO rows now carry `srv` — the client poller already skips `srv` rows (it
  polls + activates only non-srv duplicates of this tab's own session), so the server follow-up is the
  one activator; the row's "submitted" view is derived as before (link present, row open).
* The four clone boards (Google / Snapchat / TikTok / HS duplicator) get the same **wave-hold** the launch
  boards have (a lost answer, or an answer without a verdict such as a gateway 502/504 page, holds the
  rows and asks `/api/wave-status` — rails `google|snap|tiktok|hs|hs-tool`), the hand-off overlay, and a
  **wave memory** (`components/wave-memory`, sessionStorage): the wave is remembered the moment it goes
  out and forgotten on any verdict, so a reload after a lost answer holds the same rows again instead of
  showing them idle; the same content fired again re-uses the remembered wave id. A refused wave pins
  "shot N: …" to the row the N-th expanded shot came from (Google used to index un-expanded rows).
* Queued rows are not fireable until the buyer edits them ("edit the row to fire it again" — the
  TikTok cloner's rule, now on Google and the HS duplicator too); a wave-level change (mode, channel,
  Settings binds, default copies) re-opens them. Held rows stay held through edits.
* The Auto-landings "Launch campaign" modal hands the campaign to the queue (`sendToQueue("mo", …)`,
  the task id as the idempotency key) instead of streaming `/api/launch` from the tab; the dialog cannot
  be dismissed during the seconds of the hand-off.
* Nothing else changes for the buyer: the hand-off screen, the "safe to close the tab" states and the
  stale-build banner behave as on 08.10.

## 4. Invariants (checked by review)

1. A submit runs at most once per (re)queue; a follow-up is idempotent by construction and may run
   any number of times.
2. Rows before jobs; the wave claim before the answer; store down = refused, never half-accepted.
3. A row the queue owns (`srv`) is written only by the queue and the sweep.
4. A refusal that is a fact of the SOURCE / the account window fails the identical queued copies
   without sending them (durable `failQueuedSiblings`), never a copy that already began.
5. No job ever starts unless its worst case fits the invocation; a shot that cannot fit any invocation
   (a 20-creative Snap card) is still admitted — its core self-limits and reports what it left out.
6. Every follow-up ends: done, or closed at `until` with the campaign id it knows.

## 5. Tests and bench

Unit (node --test): runners' `verdictFromRow`; follow-up cores (LION completed / wall / not-found /
reality-check paths; TikTok settle; TOOL pending → done / failed); store (`not_before`, `deferJob`,
`failQueuedSiblings`, idempotent reap); `runLane` defer branch; `teamAllowsJob` for every new kind;
`team.test.ts` route classification; golden wire fixtures for the new hand-off shapes; the Snapchat
pump's durable media reuse; the wave memory (`wave-memory-core`) and the held-row rule of the Snapchat
clone core. The offline bench (`_e2e/`) gains Snap / Google / TikTok / HS-dup scenarios on the existing
mocks (not written on 09.10 — the unit layer covers the runners and cores; the bench scenarios remain
a follow-up).
