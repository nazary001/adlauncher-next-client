# S3 creative uploads at attach time + server-side launch queue + hand-off screen

Owner ask, 08.10.2026 (verbatim, shortened): «версель использовать для трансфера медиа очень дорого …
на амазоне s3 … когда ребята только добавляют креатив … чтобы он уже сразу загружался … Максимально
сократить время … когда нажимают запустить — сразу лоадер, что загружено а что не успело, потом красивая
анимация и галочка что все передано в работу на наш сервер … чтобы не нужно было держать страничку
открытой … нажал запустить и кампании пошли в работу сразу же».

## 1. What changes, in one screen

| Today | After |
|---|---|
| Creatives go browser → **Vercel Blob** when Launch is pressed, one file after another, inside each task. | Creatives go browser → **our S3 bucket** (presigned PUT / multipart) the moment they are **attached** to a card. Content-addressed keys: the same bytes are uploaded once, ever. |
| MO / AIF / AV launches + clones and HS launches are run by the **browser** (task-manager pumps a queue, calls the launch route, reads its NDJSON stream). Close the tab → the wave dies. | The tab only **hands the wave over** (`POST /api/launch-queue`). A **server pump** runs every job by calling the very same route handlers in-process, as the job's owner. The tab may be closed the moment the hand-off is accepted. |
| Launch → a drawer row per task, "Do not close this window" for minutes. | Launch → the **hand-off screen**: per campaign `uploading → sending → with the server ✓`, then the finish animation "everything is with the server — you can close this tab". |
| A retry needs the tab that still holds the file. | Retry / Cancel are server actions: any session of the owner can retry a failed job (the payload and the creative are on the server) or cancel a queued one. |
| Each launch registers its video with Meta when its turn comes and waits for processing. | The pump gives the next jobs a **head start** (registers their videos while the current job builds) and a video already registered in the same ad account is **reused** — the processing wait mostly disappears. |

Rails that already run server-side waves (`after()` pumps: Google, Snapchat, TikTok launches; every HS /
TikTok / Google / Snap clone board) keep their pumps untouched — they only switch their upload phase
to the shared S3 uploader and show the same hand-off screen.

## 2. Vocabulary and the files that hold the contracts

These files are the contract — read them before writing anything; **do not change their exported
names or types** (if one is wrong, report it instead of patching around it):

| File | What it fixes |
|---|---|
| `lib/creative-url.ts` (done, pure) | keys, public URLs, **the fence `isOwnCreativeUrl`**, `creativeTypeOf`, limits, the `/api/creatives` wire types |
| `lib/creative-store.ts` (stub) | server S3 API: `planCreativeUpload`, `completeCreativeUpload`, `abortCreativeUpload`, `putCreativeBytes`, `creativesConfigured` |
| `components/creative-uploads.ts` (stub) | browser upload manager: `startCreativeUpload`, `ensureCreativeUploaded`, `useCreativeUpload(s)`, `uploadCreativeBlob`, … |
| `components/launch-handoff.tsx` (stub) | hand-off store + UI: `handoffBegin`, `handoffPatch`, `useHandoffPending`, `useHandoffDemand`, `<LaunchHandoffHost/>` |
| `components/launch-queue-client.ts` (done) | browser → queue: `sendToQueue`, `retryQueued`, `cancelQueued` |
| `lib/launch-queue-types.ts` (done, pure) | scopes, kinds, `QueueJob`, `parseEnqueue`, `outcomeOf`, row patches, timings, the `/api/launch-queue` wire types |
| `lib/launch-queue.ts` (done, pure) | the lane pump algorithm `runLane(deps)` |
| `lib/launch-queue-store.ts` (stub) | Mongo store of jobs + lane locks |

## 3. Creative store (S3)

Bucket `gc-adlauncher-creatives`, eu-central-1 (same metro as Vercel fra1 and Atlas). Setup is
`scripts/creatives-bucket-setup.mjs` (idempotent): public read by POLICY on `creatives/*` and
`keep/*`; CORS lets the launcher's origins PUT and exposes `ETag`; lifecycle expires `creatives/*`
after 14 days and aborts stale multipart uploads after 2. Env: see `lib/creative-store.ts` header.

* Key: `creatives/<sha256>-<size>-<owner>.<ext>` when the browser could hash the file (≤ 256 MB),
  else `creatives/u-<random>.<ext>`. `<owner>` is a 12-hex tag of the uploader's username, derived
  on the server from the SESSION (`creativeOwnerTag`): the hash is the client's word, so "these bytes
  are already here" is only ever answered from that same buyer's own objects — one buyer can never
  plant bytes under a key another buyer's launch would reuse. Keys the server hashes itself (the
  Auto-landing image) carry no tag. `keep/…` = same shape, never expires (TikTok remembered identities).
* The browser computes SHA-256 with **WebCrypto only** (`crypto.subtle.digest`) — no hand-written
  hash: a wrong hash would make two different files share a key, i.e. launch the wrong creative.
  No WebCrypto / file too big → no hash → random key (no dedupe, nothing can collide).
* `POST /api/creatives` (session cookie; proxied) — actions `plan | complete | abort`, wire types in
  `lib/creative-url.ts`. `plan` answers `exists` (HeadObject: same key, **exact** byte size, younger
  than 9 days), `single` (presigned PUT, < 32 MB) or `multipart` (16 MB parts, all part URLs presigned).
* The S3 client MUST be created with `requestChecksumCalculation: "WHEN_REQUIRED"` and
  `responseChecksumValidation: "WHEN_REQUIRED"` — AWS SDK ≥ 3.729 otherwise bakes a CRC32 into
  presigned URLs and every browser PUT fails. `Content-Type` is signed: the plan response returns the
  exact headers the browser must send. Credentials are passed explicitly from `CREATIVES_S3_*`
  (never rely on ambient `AWS_*` on Vercel — the platform sets its own).
* Nothing deletes creatives per launch any more (objects are shared between cards, retries and
  waves): the lifecycle rule is the cleanup. The launch routes' `del()` stays ONLY for legacy Blob URLs.
* **Fence**: every place that required an "own Blob" URL now calls `isOwnCreativeUrl` (our bucket on
  either accepted origin, path under `creatives/` or `keep/`; or — transition only — a legacy Blob
  URL). Sites: `app/api/launch/route.ts`, `app/api/aif/launch/route.ts`, `app/api/av/launch/route.ts`,
  `lib/hs-token-launch.ts` (`isOwnBlobUrl`). Snap / TikTok / Google / LION accept any https — unchanged.
* `/api/blob-upload` and the `@vercel/blob` dependency stay for ONE release so a tab opened before
  the deploy can finish its wave; no new client code may import `@vercel/blob`.

### Browser upload manager (`components/creative-uploads.ts`)

Module-level singleton keyed by the file's session object URL (`FileItem.url`, `FileItem.cover.url`).

1. `startCreativeUpload(src, meta)` — called by the shared `Dropzone` for every image/video it adds
   and for every picked cover. Idempotent. A remote (`http(s)`) source is `done` at once.
2. Pipeline per source: read the Blob behind the object URL and **probe 64 KB** (a dead file handle
   fails here, in under a second, with the creative's name and the re-attach remedy — keep the
   exact wording of today's `unreadableError`) → hash (WebCrypto, ≤ 256 MB) → `plan` → `exists` ⇒
   done · `single` ⇒ one XHR PUT · `multipart` ⇒ parts with 4 in flight → `complete`.
3. Progress comes from `XMLHttpRequest.upload.onprogress` (fetch has none). At most 3 files upload
   at once; the rest wait as `queued`.
4. Failure taxonomy (keep today's named, actionable errors — `components/blob-uploader.ts`): dead
   handle → re-attach; `plan` answers 401 → "your launcher login expired — log in again in a new tab
   (keep this one open: the cards and attached files stay), then press Retry here"; network-class
   failure → 3 attempts with a growing pause, then "network failed 3× … check the network and press
   Retry"; a part / PUT answering 403 (expired URL) → re-plan once; anything else → the server's
   reason, once. Each attempt of a PUT / part is bounded (5 min). A re-plan after a failed multipart
   aborts the old upload id (best effort).
5. Two different object URLs with identical bytes share one upload (join on the hash).
6. `ensureCreativeUploaded(src, meta)` is what launches await; `uploadCreativeBlob(blob, meta)` is
   for in-memory bytes (TikTok's 256² avatar crop).

The Dropzone tile shows the state: a thin progress bar + percent while uploading, a small emerald
check when it is on the server ("Uploaded"), and a red "Upload failed — Retry" chip (the full reason
in the tooltip). Never block attaching, editing or previewing on an upload.

## 4. Server-side launch queue

### 4.1 Model

* Scope = one drawer: `mo`, `aif`, `av`, `hs`. Lane = `<scope>:<username>`. Jobs of a lane run
  **one at a time, in hand-off order, with a random 1–3 s breather** — exactly the pacing the browser
  pumps had (owner calls 08-11 / 08-12; it is the defence against profile blocks and throttles).
  Different lanes run in parallel, as different buyers' tabs did.
* Job kinds → handler: `mo.launch` `/api/launch` · `aif.launch` `/api/aif/launch` · `av.launch`
  `/api/av/launch` · `fb.clone` `/api/clone/run` · `hs.lion` `/api/hs/launch` · `hs.token`
  `/api/hs/token-launch` · `hs.tool` `/api/hs/tool-launch`.
* A job stores the handler's request body **exactly as the browser used to POST it** (minus the task
  id) + the display row statics + owner / role / sub. `job_id` = the task row's `task_id`.
* The pump runs a job by calling the route's exported `POST(new Request(...))` **in-process**, with a
  short-lived session cookie minted for the job's owner (`signSession({sub, username, role}, 900)`),
  and reads the reply exactly as the browser did. **The launch routes' bodies are not refactored** —
  every claim, gate, budget, pause-on-failure and TOOL belt stays where it is, byte for byte.
* `outcomeOf` (pure) turns the reply into the verdict + the row writes; it is a port of the browser
  code it replaces (`runLaunchTask`, `runCloneTask`, HS `runTask`).

### 4.2 Invariants (review these first)

1. **At most once.** `claimNextJob` is one atomic `findOneAndUpdate` (queued → running), and the pump
   records `began` (`markJobBegan`) BEFORE it invokes the handler. The sweeper treats an expired
   lease by that mark: a job that had **begun** is closed as *interrupted* and is **never** re-run by
   the system (its outcome is unknown); a job that was only claimed (the pump died or lost the store
   between the claim and the mark — nothing was sent anywhere) goes back to `queued`.
2. **No one-click retry of an unknown outcome.** `retryable` is true only for: a pre-run rejection,
   a clean error with no created campaign, a cancel. TOOL `pending`, a reply without a verdict, a
   crashed run, an ambiguous LION submit → not retryable.
3. **A job never starts unless its worst case fits the invocation** (`worstCaseMs` + margin vs the
   invocation deadline). Otherwise the pump un-claims it, releases the lane and kicks a fresh
   invocation. A platform kill mid-launch skips every error path — this is the guard against it.
4. **One pump per lane** — leased lock in `launch_lanes`; the lease is extended on every heartbeat
   and re-asserted before every claim.
5. **Hand-off is idempotent** by task id (unique `job_id`). A re-sent request never re-stamps the row
   of a job that already exists.
6. **Rows of queued jobs belong to the server.** Every queue write stamps `srv: 1`; a CLIENT write
   (POST `/api/launch-tasks`, `/api/hs-tasks`) to a row that carries `srv` is silently ignored, and
   clients can never set `srv` / `retry` themselves. (An old tab's stale-settle or pagehide beacon
   must not bury a job the server is about to run.)
7. Enqueue order: check which ids already exist → stamp rows `queued` (new ids only) → insert jobs →
   `after(pump)` → answer. Rows first, as every wave route does ("stamp rows BEFORE the claim").
8. Fail closed: the store being down means the hand-off is refused (503) — nothing half-accepted.

### 4.3 Routes

* `POST /api/launch-queue` (session; `maxDuration = 800`): `enqueue` (default) | `retry` | `cancel`
  — wire types in `lib/launch-queue-types.ts`. After accepting, `after(() => pumpLane(lane))`.
* `POST /api/launch-queue/pump` (internal; excluded from the proxy; `maxDuration = 800`): body
  `{ lane }`; auth = `Authorization: Bearer <CRON_SECRET | internal token>` (constant-time; the
  internal token is an HMAC of `AUTH_SECRET`, so self-kicks work even where `CRON_SECRET` is unset).
  Answers 202 at once and pumps in `after()`.
* `GET /api/launch-queue/cron` (Vercel Cron, every minute; excluded from the proxy; bearer
  `CRON_SECRET`, a valid session passes too — same pattern as `/api/hs/token-cron`; `maxDuration =
  800`): reap expired leases (row written only if still open), then kick every lane that has queued
  jobs and no live lock. A kick counts only when the pump route ANSWERS 2xx; a lane whose kick was
  refused or lost is pumped by the cron's own invocation in `after()` (`pumpedHere` in the reply) —
  the queue never depends on the deployment being able to call itself over HTTP.
* Continuation: a pump that runs out of invocation budget kicks `/api/launch-queue/pump` on
  `selfOrigin` (`ADL_SELF_ORIGIN` → the request's origin unless it is a `*.vercel.app` host →
  `https://$VERCEL_PROJECT_PRODUCTION_URL` → the request's origin). If the kick is lost or refused
  (logged with its HTTP status), the cron restarts the lane within a minute — by a kick, or itself.

### 4.4 Task rows

`launch_tasks` gains two columns: `srv` (1 = the queue owns this row) and `retry` (1 = the owner may
re-queue it). Both list routes return them. Row life of a job: `queuedRow` → `runningRow` → the
handler's own stage writes (unchanged) → `outcome.row` (always) + `outcome.openRow` (only when the
outcome is ambiguous AND the row is still non-terminal). A canceled job's row is `status:"error",
stage:"canceled"`.

### 4.5 Launch-limit demand

`GET /api/acct-limit` adds `queued: { <account>: n }` (jobs still QUEUED per ad account). The client
folds it — plus its own not-yet-accepted hand-off items (`useHandoffDemand`) — into `countFor`, so a
second wave cannot over-queue an account the first wave is still waiting to fill. The server-side
slot claim stays the only authority.

### 4.6 Head start and reuse of Meta videos

`lib/fb-media.ts uploadVideo(accountId, fileUrl, name, token)` keeps its signature and becomes
cache-aware for content-addressed creatives (`creativeKeyOf` + `isContentKey`):

* cache = collection `fb_media_cache` `{ ckey: "<account>|<key>" (unique), video_id, expire_at (TTL) }`,
  window `FB_VIDEO_REUSE_HOURS` (default 12; `0` switches reuse off);
* hit → one `GET <video_id>?fields=status`: `ready` / `processing` ⇒ return the cached id; anything
  else (error status, a Graph error) ⇒ drop the entry and upload fresh;
* same-process concurrency: an in-memory in-flight map makes the job and its head start share ONE upload.

The pump's `prewarm` (for `mo.launch` / `aif.launch` jobs that are not `via:"tool"`) resolves the
rail's signer exactly as the route does, checks the cheap gates (assignment, account visible to the
token) and calls `uploadVideo` for the job's videos. Best-effort: any failure is swallowed and the
job simply registers its own video as before. A video is an account-library asset — an ad that
reuses its id is the same thing a duplicate / clone does.

## 5. Client

### 5.1 Task managers (MO/AIF/AV `components/task-manager.tsx`, HS `components/hs-task-manager.tsx`)

`enqueue()` / `enqueueClone()` keep their signatures (the boards do not change). They no longer run
anything:

```
id = mint();  handoffBegin([{ id, scope, label, sub, sources, account }])
urls = await Promise.all(sources.map(ensureCreativeUploaded))        // usually already done
handoffPatch(id, { phase: "sending" });  await sendToQueue(scope, { taskId: id, kind, body, row, account })
handoffPatch(id, { phase: "accepted" });  // + an optimistic row so the drawer shows it at once
// any throw → handoffPatch(id, { phase: "failed", error, retry })   (retry re-runs these steps)
```

Removed from the client: the queue / worker / `runLaunchTask` / `runCloneTask` / HS `runTask`, the
running-row heartbeat, the pagehide "Interrupted" beacon, the stale-settle writes, the launch unload
guard (the hand-off host owns the one that remains). Kept: the shared team poll and its cadence, the
401 quieting, tombstones, the localStorage snapshot, drawer UI, HS duplicate polling / activation.

* Rows with `srv` are never judged stale and never written by the client.
* Retry (own `error` rows with `retry`) and Cancel (own `queued` rows with `srv`) call
  `retryQueued` / `cancelQueued`; "Retry all" = every own retryable row; "Cancel queued" = the scope.
* An accepted job's optimistic row survives up to 30 s of absence from the polled list (the team
  list is cached 4 s server-side — a poll taken just before the insert must not make the row blink).
* `counts.inFlight` = `useHandoffPending(scope)` (what still depends on this tab).

### 5.2 Hand-off screen (`components/launch-handoff.tsx`)

Design system: dark cockpit (`DESIGN.md`, `app/globals.css` tokens; emerald is reserved for Launch /
success; Geist Mono for numbers; micro-labels 10 px uppercase tracking). Overlay `z-[95]`, centered
panel ≤ 560 px:

* header — an animated ring while anything is pending; when the whole wave is accepted it resolves
  into a large emerald check that strokes itself in with a ring pulse ("Handed to the server");
* a counter ("7 of 12 campaigns with the server") and one thin bar of the wave's uploaded bytes;
* a scrolling list, one row per campaign: name, sub line, state chip — `Uploading 43%` (live, from
  `useCreativeUploads`), `Sending…`, `With the server ✓`, `Failed — <reason>` + Retry;
* footer — pending: "Keep this tab open until everything is handed over."; finished: "All set —
  launches continue on our server. You can close this tab." Buttons: "Open tasks" (opens that
  scope's drawer), "Close". After a clean finish it dismisses itself in ~4 s (a shrinking bar shows
  it; hovering stops it). Failures never auto-dismiss.
* closed with items still pending → a floating pill ("Handing over 3 campaigns · 62%") that reopens
  it; a failed item keeps a red pill until retried or dismissed. `useUnloadGuard(pending > 0)`.
* `prefers-reduced-motion` is already handled globally.

### 5.3 Wave rails (Google / Snapchat / TikTok launch boards)

Their `fireWave` keeps its shape and its single wave POST. Only: (a) uploads go through
`ensureCreativeUploaded` (files were already started by the Dropzone at attach) instead of
`readCreative` + `uploadCreativeFile`; (b) the cards of the wave are registered with `handoffBegin`
(scope `gg` / `sn` / `tt`, id `<waveId>:<cardId>`) and moved `uploading → sending → accepted | failed`
at the board's existing transitions. TikTok's avatar crop goes through `uploadCreativeBlob(...,
{ purpose: "keep" })`.

## 6. Deploy

The order matters: the bucket and the env come BEFORE the push — a deployment without
`CREATIVES_S3_*` answers 503 `creatives_not_configured` to every attach, i.e. nobody can launch.

1. Bucket (owner runs it once; idempotent):
   `node scripts/creatives-bucket-setup.mjs --env-file <aws.env> --bucket gc-adlauncher-creatives`.
2. Prove it against the real bucket: `node scripts/creatives-smoke.mjs --env-file <aws.env>` (plan →
   presigned PUT → public GET → multipart → reuse).
3. Vercel env (Production + Preview): `CREATIVES_S3_BUCKET`, `CREATIVES_S3_REGION`,
   `CREATIVES_S3_ACCESS_KEY_ID`, `CREATIVES_S3_SECRET_ACCESS_KEY`, and
   `ADL_SELF_ORIGIN=https://adlauncher.gcamazingtool.xyz`. (`CRON_SECRET` and `AUTH_SECRET` are
   already there.)
4. `npm run ensure-indexes` against `gc` (new collections `launch_jobs`, `launch_lanes`,
   `fb_media_cache`; the two unique indexes the claim protocol needs are also ensured at runtime).
5. `git push origin <branch>:main` → Vercel auto-deploy; the every-minute cron appears with the deploy.
6. After the deploy: `GET /api/launch-queue/cron` with a session answers `{ ok, kicked, pumpedHere }`
   (a non-zero `pumpedHere` or a `kickLane … refused` log line means the self-origin is wrong — the
   queue still works, each continuation just waits for the cron); attach one creative on any board
   and see it turn "Uploaded" (one file above 32 MB proves the multipart path and the bucket's CORS).
7. Old tabs see the stale-build banner and reload; a wave they were already running finishes on Blob.

## 7. Tests

`node --test "tests/**/*.test.ts"` — pure modules with injected deps; live store tests only against
`gc_test` (`tests/_mongo.ts`). New: creative-url, creative-store (fake S3), creative-uploads (pure
parts), launch-queue-types (parseEnqueue, every `outcomeOf` branch, row patches), launch-queue
(`runLane` with fakes: busy / drained / handoff / lost / crash / prewarm / gap / heartbeat),
mongo-launch-queue (live: claim atomicity, lane lock, requeue, cancel, reap, demand), task-store
client-write guard, fb-media cache decisions, task-view (`srv` rows never stale).
