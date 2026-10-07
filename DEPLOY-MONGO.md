# adlauncher → MongoDB Atlas: deploy notes (branch `mongo-migration`)

Strapi is gone from the launcher: every registry, the Task Manager, the KV/claim store, the Auto
landings queue and the user directory now live in MongoDB Atlas (`gc-prod`, eu-central-1, database
`gc`), reached through the official driver from the Vercel functions. The only Strapi reference left
is `STRAPI_TOOLS_URL`, used by the login's lazy password migration (below) — remove it when every
user has a hash.

Spec followed: `docs/strapi-to-mongo/CONVENTIONS.md` (collection names = Strapi `collectionName`,
Strapi envelope `id`/`documentId`/timestamps kept, claims = unique index + E11000, `$ne` null
semantics re-derived, biginteger → Number, datetime → BSON Date).

## 1. Environment variables

### Vercel dashboard (Project → Settings → Environment Variables, Production AND Preview)

| Variable | Value | Note |
|---|---|---|
| `MONGODB_URI` | the **SRV** connection string (`mongodb+srv://gcapp:…@<cluster>/…`) — `MONGODB_URI_SRV` in `C:\gc-migration\atlas.env` | Vercel resolves SRV fine; the host-list form is only for this Windows box (its DNS refuses SRV). |
| `MONGODB_DB` | `gc` | |
| `STRAPI_TOOLS_URL` | `https://efficient-broccoli-73345f1265.strapiapp.com` | login fallback ONLY (lazy password migration). Delete once Strapi is shut down / every user has a hash. |
| `MONGODB_APP_NAME` | `adlauncher` | optional (shows in Atlas metrics). |

**Remove** from Vercel: `STRAPI_API_URL`, `STRAPI_TOKEN`, `STRAPI_TOOLS_TOKEN` (no code reads them).
Everything else (AUTH_SECRET, FB_*, LION_*, SNAP_*, BLOB_READ_WRITE_TOKEN, CRON_SECRET, …) is unchanged.
`AUTH_SECRET` MUST stay the same: it is also the key of the AES-sealed FB token vault in
`app_caches` (`fb-token-registry:v1`) and of every live session cookie.

Atlas → Network Access must allow Vercel's egress (`0.0.0.0/0` with the strong `gcapp` password, or
Static IPs). Functions are pinned to Frankfurt (`vercel.json` → `"regions": ["fra1"]`), next to the
cluster — the claim paths do 3–6 sequential round trips per campaign.

### Local dev (`.env.local`, see `.env.example`)
`MONGODB_URI` (host-list form on this box), `MONGODB_DB=gc`, `STRAPI_TOOLS_URL`. `npm run dev`.

## 2. Build / run / verify

```bash
npm ci                      # adds mongodb@^6, bcryptjs@^3 (already in package-lock.json)
npm test                    # node --test "tests/**/*.test.ts" — 903 tests; the live ones run on gc_test when MONGODB_URI is set
npx tsc --noEmit            # clean (LayoutProps comes from .next/types after the first build)
npx eslint .                # 2 pre-existing errors in components/auto-landings-board.tsx (react-hooks rules, identical on origin/main) — not from this branch
npx next build
npm run ensure-indexes      # idempotent: creates/verifies every index incl. the UNIQUE claim ones — run once against gc before the switch
```

Deploy = the owner pushes `mongo-migration` → `main` (Vercel auto-deploys). Rollback = redeploy the
previous `main` build (Strapi Cloud stays up until the end of the migration; the old env vars still
exist in Vercel until you remove them — keep them until the first Mongo deploy is confirmed).

## 3. Cutover order (launches frozen for the few minutes between 3 and 5)

1. Vercel env: add `MONGODB_URI`, `MONGODB_DB`, keep `STRAPI_TOOLS_URL`.
2. `npm run ensure-indexes` against `gc` (safe to repeat).
3. **Freeze launches** (tell the team) — the pools/claims must not be written in two stores.
4. Delta-sync the HOT collections (section 4) from Strapi one last time; re-seed `counters` (the
   loader's `$max` seeding) so new ids land above every synced id. (The app also self-heals a
   counter that is behind: an `id` collision re-syncs and retries — `lib/store.ts insertFresh`.)
5. Push → deploy → smoke (section 6) → unfreeze.
6. Remove `STRAPI_API_URL` / `STRAPI_TOKEN` / `STRAPI_TOOLS_TOKEN` from Vercel.

## 4. Hot collections — delta-sync right before the switch

| Collection | Why it is hot | Sync key |
|---|---|---|
| `launch_tasks` | every launch/clone writes rows all day (48 392 loaded 07.10 18:01Z; prod keeps growing) | `documentId` (upsert), `task_id` unique |
| `app_caches` | wave claims (`hs-wave:*`, `google-wave:*`, `snap-wave:*`, `tiktok-wave:*`), per-account slots (`acct-window:*`, `acct-slot:*`), Snap/AV key registries (`snap-key:*`, `av-key:*`), the **FB token vault** `fb-token-registry:v1` (byte-exact!), token health, account assignments, TOOL sessions log | `documentId`; `ckey` unique — the delta MUST dedupe by `ckey` (keep newest `updatedAt`), the 07.10 re-run tripped on `token-health:7269c6c12110` (E11000) because the dump holds two rows for it; the loader parked 2 such rows in `app_caches__dupes` |
| `gcm_maps`, `gcm_binding_logs` | MO code claims + the ledger hs-tools reads | `documentId`; `gcm` unique on `gcm_maps` |
| `aif_maps` | AIF brand claims | `documentId`; `brand` unique |
| `mo_landing_jobs`, `mo_landings` | owner console + the generator worker (gc-gemini-generator) | `documentId`; `slug` on landings |
| `up_users` | only if a user/role changed in Strapi after the dump (21 users loaded, no password hashes) | `documentId`; `username`/`email` unique |

Warm/cold: nothing else is read by adlauncher.

## 5. Behaviour notes / drift to reconcile

- **Login (lazy migration).** `up_users` rows have no `password`. First login: the password is verified
  against `STRAPI_TOOLS_URL/api/auth/local`; on success it is bcrypt-hashed (cost 10) and stored, later
  logins are local. Wrong password → 401 (same message as before); Strapi unreachable AND no hash →
  502 "Auth service is unavailable" (never 401). Blocked users are refused. Lookup = exact username or
  lower-cased e-mail (Strapi's rule). Roles: `app_role` exactly as before; owner gate unchanged
  (`ADL_OWNER_ROLES` / `ADL_OWNER_USERS`).
- **Owner password reset / users who never log in before Strapi dies:**
  `npm run set-password -- <username> --password '<new>'` (or `NEW_PASSWORD=… node scripts/set-password.mjs <username>`,
  or interactive). Reads `MONGODB_URI` from env/.env.local; usernames are exact (case-sensitive).
- `/api/team` now reads the directory from `up_users` directly — `STRAPI_TOOLS_TOKEN` is no longer
  needed for an authoritative roster (`directory: true`).
- **Claims** are real unique indexes now: `gcm_maps.gcm`, `aif_maps.brand`, `app_caches.ckey`,
  `launch_tasks.task_id`. A lost race is `E11000` on that field (`lib/store.ts dupKeyOn`) — the branch
  that used to be Strapi's HTTP 400. The post-write "oldest row wins" twin checks are gone (the index
  is atomic); the acct-limit anchor re-check stays. Fail-closed is kept: `acct_limit_unavailable`
  whenever the store is unreachable or `MONGODB_URI` is missing (and every store call is bounded to 8 s).
- **MO drawer scope** (`/api/launch-tasks` default): `partner: {$nin: [br,us,gg,sn,tt,av]}` + `owner: {$ne: null}`
  — keeps partner-null/missing rows (null = MO), excludes the other drawers; proven on live rows in
  `tests/mongo-semantics.test.ts`. (A transliterated `$ne` would have matched null — CONVENTIONS §3.2.)
- **Typing:** `queued_at/started_at/finished_at` (launch_tasks), `refreshed_at` (app_caches),
  `scheduled_at/started_at/finished_at` (mo_landing_jobs) are stored as Numbers (the loader coerced the
  old strings; the app coerces numeric strings from older clients). `bound_at`/`released_at` are BSON
  Dates. The generator worker (other agent) must compare `scheduled_at` numerically.
- **Envelope of new rows** = exactly the loaded rows' shape: `id` from `counters`, 24-char `documentId`,
  `createdAt`/`updatedAt`/`publishedAt` (Strapi v5 set `publishedAt` on these non-D&P types too, so the
  loaded rows carry it — new rows match). Every schema attribute is present (nulls/defaults) so Python
  readers indexing keys directly do not KeyError. Unknown attributes are dropped on write (Strapi 400'd
  the whole write; now the known fields land).
- **`/api/gcm POST`** keeps answering 409 `{reason:"taken", next}` on any failed insert, as before.
- `app_caches__dupes` (2 old `token-health:*` rows the loader set aside) can be dropped after the switch.
- `_e2e/_snap_keys_reconcile.mjs` and `_snap_keys_release.mjs` (untracked, local only, not on `origin/main`)
  still speak Strapi REST — rewrite against `app_caches` (`ckey` prefix `snap-key:`) if still needed.
- The Vercel cron `/api/hs/token-cron` is unchanged (writes `hs-token-health` via app-cache).
- Local-vs-server drift: the main checkout sits on `fix/tool-ready-hs-combos` (78 files behind/apart
  from `origin/main`); this branch was cut from `origin/main` (46e8260) in the worktree
  `C:\Users\nazar\OneDrive\Desktop\GC-coding\adlauncher-mongo`. Nothing from the other local branches
  is included.

## 6. Smoke checklist (after deploy, with a real user)

1. `POST /api/auth/login` with a valid Strapi password → 200, cookie set; check `up_users.password`
   now holds a `$2a$10$…` hash for that user; log out/in again (now local). Wrong password → 401.
2. Open the MO board: Task Manager drawer lists the team's last 7 days (`GET /api/launch-tasks` →
   `{ok:true, now, tasks:[…]}`), HS/Google/Snap/TikTok/AIF/AV drawers likewise.
3. `GET /api/gcm` → `{used, next, poolMax:200}`; `GET /api/aif/brand` → `{used, next, poolMax:700}`.
4. `/accounts` (owner): roster with roles (`directory: true`); assignments save (`app_caches fb-acct-assignments`).
5. `/tokens` (owner): the registry opens (the AES vault decrypts with the unchanged `AUTH_SECRET`).
6. One real MO launch: gcm claimed (`gcm_maps` row + `gcm_binding_logs` epoch with `released_at: null`),
   acct slot taken (`acct-slot:*`), task row advances to done.
7. Header account-limit badge updates (`GET /api/acct-limit`).
8. Auto landings console lists jobs; a scheduled job is picked by the generator worker.

## 7. What was verified here (07.10, this machine)

- `npm test`: 903/903 pass, 0 skipped — includes the live gc_test tests: ckey claim + wave race,
  5-slot account limiter (+ fail-closed without store), gcm/brand claims with ledger, Snap/AV key
  registries, task_id create race (6 concurrent upserts → 1 row), counter self-heal, MO scope null
  semantics, lazy-migration decision table, set-password + local login.
- `tsc` clean (`.next/types` present); `eslint` only the 2 pre-existing errors; `next build` OK (twice).
- `gc` read-only check after the suite: counts unchanged (launch_tasks 48 392, app_caches 4 178,
  gcm_maps 49, aif_maps 183, gcm_binding_logs 1 024, mo_landing_jobs 12, mo_landings 13, up_users 21),
  unique indexes present, counters above max ids; `gc_test` left empty.
- Local `next start -p 3123` against Atlas `gc` with a minted owner session (reads only, nothing written
  to `gc`): `GET /api/launch-tasks` (+`?scope=aif`, `?scope=av`) → `{ok,now,tasks}` (0 rows — the last
  7 days hold only br/gg/sn/tt rows, confirmed by an aggregate), `/api/hs-tasks` 300 rows descending by
  queued_at (5 owners; 1.8 s cold, 13 ms from the 4 s cache), `/api/google-tasks` 298, `/api/snap-tasks` 15,
  `/api/tiktok-tasks` 6, `/api/gcm` `{used:49,next:"29",poolMax:200}`, `/api/aif/brand`
  `{used:183,next:"test184",poolMax:700}`, `/api/snap/keys` 262 used / next glo-snp_263, `/api/team` 21 users
  `directory:true`, `/api/landings` 13, `/api/auto-landings` 12 jobs; no cookie → 401; login with `{}` → 400,
  wrong password for a real user → 401 in 0.6 s through the Strapi fallback, unknown user → 401.
  `explain` on every drawer query: IXSCAN `partner_1_queued_at_-1`, docs examined = rows returned.
- Observed once, not a code issue: the very first cold reads of the bigger result sets (hs/google rows,
  snap keys) hit the 8 s bound while the other agent was bulk-loading `click_event7s` (1.3 GB) into the
  same M10 — the routes answered `ok:false`/502 as designed (stale-or-empty, never a hang) and were fine
  on the next request. Expect the same warm-up right after cutover if the cluster is busy.
- NOT verified: a real login with a real password (no user password available here — the fallback
  wiring was exercised with a wrong password → 401 through Strapi, and the hash path with a real bcrypt
  hash on gc_test), a real campaign launch/clone (the claim paths are covered by the live gc_test tests),
  the Vercel cron, and the generator worker's consumption of `mo_landing_jobs` (other agent).
