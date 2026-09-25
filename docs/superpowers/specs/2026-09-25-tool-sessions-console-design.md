# TOOL Sessions console — the HS team's Ads Manager sessions inside Ad Launcher

**Date:** 2026-09-25 · **Status:** built + verified locally (unit 24/24, route smoke 61/61 against the contract mock, headless-Chrome walk 41/41, live run against the real TOOL with the real key 13/13 incl. one live `session.check`; multi-lens review 5 lenses × adversarial verification: 8 confirmed findings, all fixed — see §5) · owner ask 25.09: "add the `tool.gctracking.xyz/sessions` functionality to the launcher for the owner role, using the tool's API; everything the API allows per session" · **Deploy:** committed on `main`, NOT pushed — prod needs `TOOL_SESSIONS_API_KEY` in the Vercel env first (the page renders a setup notice until then).

## 1. Goal

The HS team runs its Ads Manager **sessions** (token + cookies + User-Agent + proxy captured from one logged-in anti-detect profile, or a Marketing API system-user token) on a separate service, **TOOL Sessions** (`https://tool.gctracking.xyz`). Its worker creates and duplicates campaigns through those sessions. The owner wants to run the sessions without leaving Ad Launcher: see them, add one, check one, refresh its cookies / token / proxy after a re-login, disable / enable, delete — and read, per session, the ad accounts it sees, the jobs that ran through it and its history. Two extra tabs expose what the same API gives team-wide: every job (with retry / cancel) and every ad account with the sessions that see it.

## 2. Partner contract (read 2026-09-25: `/api/openapi.json` + the owner's `API_GUIDE.md`; live probes with the new key)

Host `https://tool.gctracking.xyz/api/v1`, `Authorization: Bearer hst_…` (a **team** key issued on `/keys` — name, scopes, optional IP allow-list; shown once). The key acts for the whole team: every session and every account they see. Errors are always `{error, message, field?, problems?}`; 401 is `{"error":"http_error","message":"Unauthorized"}`; 403 is the plain text `forbidden` when a scope is missing.

| Call | Notes |
|---|---|
| `GET /me` | `{actor: "key:hst_P1aFCVPi", team_id, teams, is_hs_admin, scopes[]}` — the board greys out what the key cannot do. |
| `GET /sessions?status=` | `SessionOut[]` — **each row carries its full account list** (302 on the live session), so our list route strips it to a summary. |
| `POST /sessions` | `SessionCreate`: `name` (2–80, unique in the team), `kind` (`adsmanager_session` default / `marketing_token`), `token` (≥20), `cookies`, `user_agent`, `proxy` (`socks5h://u:p@host:port` / `http://…`), `profile_slug`, `account_ids[]` (restriction; empty = all), `client_hints`, `accept_language`, `egress_ip_browser`, `graph_version`, `source`, `extension_version`, `check_now` (default true), `team_id` (HS admin only). 201 `SessionOut`; a duplicate name is a 400 with a Russian sentence; schema errors are 422 with `field` + `problems`. |
| `GET / PATCH / DELETE /sessions/{id}` | `SessionUpdate` is a **subset patch** (any of token / cookies / user_agent / proxy / profile_slug / account_ids / client_hints / accept_language / egress_ip_browser / `status: active|disabled` / extension_version / check_now). DELETE → `{ok}`. |
| `POST /sessions/{id}/check` | queues a `session.check` job (`/me`, accounts, egress IP through the proxy — read-only on Facebook's side) → `JobOut`. A failing check (FB 190 / 102) marks the session `expired` and fills `last_check_error`. |
| `GET /sessions/{id}/events?limit=` | history rows `{id, session_id, ts, kind, actor, details}` — kinds seen live: `created`, `updated {changed[]}`, `checked {fb_user, accounts, ip_match, egress_ip}`, `check_failed {auth, error}`; actors `user:hs:<name>`, `key:hst_…`, `import:hs-settings`. |
| `GET /sessions/{id}/accounts` | `{accounts: [{account_id, name, currency, status}]}` from the last check (`status` = FB account_status code). |
| `GET /jobs?session_id&kind&status&batch_id&limit&offset` | `{rows: JobOut[], total}` newest first; kinds `session.check · campaign.create · duplicate · media.upload`; statuses `queued · retry · running · done · partial · error · unknown · canceled`. `JobOut` carries the whole `payload / normalized / plan` — dropped by our routes. |
| `GET /jobs/{id}`, `GET /jobs/{id}/events`, `POST /jobs/{id}/retry` (error / unknown), `POST /jobs/{id}/cancel` (queued / retry) | the step log rows are `{id, ts, step, level, message, meta}`. |
| `GET /accounts` | `{accounts: [{account_id, name, currency, status, sessions: [{id, name}]}], scope}` — team-wide. |
| `GET /whoami-ip` | the caller's IP (for the extension); not used by the board. |

Secrets never come back: `token_masked` ("EAABs…ZDZD"), `proxy_masked` ("socks5h://***:***@host:port"), cookie **names** only.

## 3. Decisions

1. **Key = env, server-only.** `TOOL_SESSIONS_API_KEY` (issued 25.09.2026 as "adlauncher", team HS, all six scopes, no IP allow-list — TOOL's own list shows it) + optional `TOOL_SESSIONS_BASE`. The browser never talks to TOOL; every call goes through `/api/tool-sessions/*`. Without the key the page shows a three-step setup notice and the routes answer `500 not_configured`.
2. **Owner-only**, the same gate as `/tokens` (`isOwnerSession`): the page redirects non-owners to `/`, the routes answer 401 / 403. The key signs for the whole HS team — nobody but an owner drives it.
3. **Validation happens twice with one rule set** (`lib/tool-sessions-model`, pure): the forms name the mistake before any request; the routes refuse the same things before reaching TOOL. An Ads Manager session must bring cookies with `c_user` + `xs` and a User-Agent (TOOL accepts a session without them and it would simply never work); a marketing token brings neither (those fields are dropped, not refused). A pasted cookie string may be a `Cookie:` header, several lines, or a JSON export (EditThisCookie / Cookie-Editor shape). A proxy must be a URL with a supported scheme, host and port. Account ids are digits (`act_` tolerated).
4. **Updates send only what changed** (TOOL patches a subset): blank fields are never sent as empty strings; lifting an account restriction sends `account_ids: []`; a status flip is `{status, check_now: status === "active"}` (an enable re-checks, a disable does not).
5. **A check is followed to its end.** `Check` → our route returns the job (202) → the board polls `GET /api/tool-sessions/jobs/<id>` every 2.5 s until terminal → reloads the list → a flash with the job's one-line summary. A create / update / enable with `check_now` queues a check TOOL-side **without telling us the job id**: the board finds the newest `session.check` of that session (`/jobs?session_id&kind&limit=1`, a few tries) and follows it the same way.
6. **The list row is light.** `ToolSessionRow` = `SessionOut` minus `accounts` plus `{total, active, other}`; the drawer's detail route returns the full session (with accounts), its history and its jobs in one answer, tolerating a failing history / jobs read (`partial[]`).
7. **Our own change log.** TOOL records every API action as the key's actor — it cannot tell which owner clicked. One Strapi `app-cache` row (`tool-sessions:log:v1`, 60 entries, best-effort, fire-and-forget after TOOL answered) keeps who / when / what: field NAMES and the masked proxy host only, never a value.
8. **Header mode "console".** `/sessions` belongs to no ad platform: the partner switcher becomes a static label ("TOOL Sessions · HS team"), the FB widgets and queue buttons stay hidden, no platform tab is active. `Header` gains `platform="console"` + `consoleLabel`.
9. **No TOOL write beyond the sessions API.** Campaign create / duplicate / media upload endpoints exist on TOOL but are out of scope (owner ask: the sessions page); the Jobs tab shows their jobs read-only apart from retry / cancel.

## 4. Architecture

Pure, dependency-free modules (run straight under `node --test`) hold the decisions; thin server modules bind I/O.

| File | Responsibility |
|---|---|
| `lib/tool-sessions-model.ts` | Wire shapes + guards (`toSession`, `toSessionRow`, `toSessionEvent`, `toJobView` (drops the heavy blobs, derives a one-line `summary`), `toJobEvent`, `toMe`, `toTeamAccount`), vocabularies (kinds, statuses, tones, FB account_status labels, scopes), cookie / proxy / token / account-id helpers, **`validateSessionCreate` / `validateSessionUpdate`**, `normalizeJobFilters`, `parseToolId`, history sentences (`describeSessionEvent`, `describeActor`), change-log helpers (`sanitizeLog`, `pushLog`). |
| `lib/tool-sessions.ts` | Transport-only client: host + key from env at call time, 30 s bound (60 s for create / update), `redirect: "manual"`, TOOL's error body → `ToolFailure` (401 = key rejected, 403 = scope missing, unreachable = 502, non-JSON 2xx = 502), `toolMe` cached 5 min per instance. Never throws, never logs bodies. |
| `lib/tool-sessions-log.ts` | The change-log row (read / append, best-effort). |
| `lib/tool-sessions-gate.ts` | `ownerGate(req)` (401 / 403) and `toolError(f)` (TOOL 4xx keep their status; 5xx / unreachable → 502; `not_configured` → 500). |
| `app/api/tool-sessions/route.ts` | GET list (+ me + log + host + configured), POST create. |
| `app/api/tool-sessions/[id]/route.ts` | GET detail (session + events + jobs, `partial[]`), PATCH subset update, DELETE. |
| `app/api/tool-sessions/[id]/check/route.ts` | POST → 202 `{job}`. |
| `app/api/tool-sessions/jobs/route.ts`, `jobs/[id]/route.ts` | GET list (filters normalised), GET one (+ events), POST `{op: retry|cancel}` with TOOL's rules checked first (409 `not_retryable` / `not_cancelable`). |
| `app/api/tool-sessions/accounts/route.ts` | GET team accounts. |
| `app/(app)/sessions/page.tsx` | Owner-only page; `?tab=jobs|accounts` and `?id=<session>` deep-link. |
| `components/tool-sessions-board.tsx` | The board: title + key badge + counts, tabs, the sessions table (search, status filter, 30 s auto-refresh + focus), actions with the check follow-up, the Jobs and Accounts tabs, the change log, modals + drawer wiring. |
| `components/tool-sessions-drawer.tsx` | Per-session slide-over: Overview (every field), Accounts (search + status filter + restriction marks), Jobs, History; the same actions; "open in TOOL". |
| `components/tool-sessions-forms.tsx` | Add / Update modals (live cookie hint, "Will change: …" preview). |
| `components/tool-sessions-jobs.tsx` | The jobs table (expand → step log + result JSON; Retry / Cancel). |
| `components/tool-sessions-ui.tsx`, `components/use-tool-sessions.ts` | Shared chips / buttons / modal shell / time formatting; data hooks (`useToolSessions`, `useToolSessionDetail`, `useToolJobs`, `useToolAccounts`, `waitForJob`) — all state changes in fetch continuations (React 19 `set-state-in-effect` rule). |
| `components/header.tsx`, `components/user-menu.tsx`, `components/icons.tsx` | `platform="console"` + `consoleLabel`; the owner-menu entry "Ads Manager sessions"; `SessionsIcon`, `ExternalLinkIcon`. |

## 5. Verification

Review (five lenses — correctness, security/secrets, Next 16/React 19, UX consistency, test gaps — each finding then judged by two skeptics): 20 raw → 8 confirmed, all fixed the same day: (1) a retried job froze at "queued" because the poll gate read the raw page rows — a retry / cancel now re-reads the owning list; (2) the follow-up of a queued check could latch onto an EARLIER finished check within a 60 s slack — it now waits for a job id newer than a baseline taken before the action; (3) a check outliving the 120 s poll window read as "ended running" — now "still running"; (4) Retry / Cancel stayed enabled for a key without `jobs:write` — threaded `canJobsWrite`; (5) Escape closed the drawer together with the Update modal above it — the drawer ignores Escape while a modal is open; (6) the drawer's Delete only armed a table row that a filter could hide — the drawer confirms and deletes itself; (7) icon-only Delete / Reload buttons had no accessible name; (8) a tautological UI assertion (`count() >= 0`). Refuted (12) were coverage notes or already-guarded paths; two of them were still hardened (a 2xx without a body on create / update / check → 502 `bad_answer`; the partial-detail path now has a smoke).


* `node --test tests/tool-sessions-model.test.ts tests/tool-sessions.test.ts` — 24/24.
* Route smoke `_e2e/_adl_tool_sessions_smoke.mts` (61/61) against `_e2e/_tool_sessions_mock.mjs` (the contract as read above, incl. the check job's queued → running → done|error progression, a BAD token → expired, a held queue for cancel, a failing history store → `partial`); a second app instance with the mock's read-only key answers `me.scopes` without the write scopes and passes TOOL's 403 through as `scope_missing`.
* Browser walk `_e2e/_adl_tool_sessions_ui.mjs` (41/41, headless Chrome via the session proxy): table, owner-menu entry, drawer tabs, Escape stacking, Add validation + add + queued check → active, Update preview + save, Check, Disable / Enable, filters, Jobs (filter, step log, Retry + self-refresh until terminal), Accounts, the row's two-step Delete arming / disarming and the drawer's own Delete, no console errors.
* Live (`_e2e/_adl_tool_sessions_live.mjs`, 13/13): the dev server with the real key lists the real session (glo-01, 302 accounts, 243 active), the drawer reads its accounts / jobs (with the live step log) / history, the Jobs and Accounts tabs read the team's data; one live `Check` on glo-01 ran to `done` ("active · 302 accounts · egress 193.193.217.60").
* `tsc` 0, `eslint` 0 new findings, `next build` OK.

## 6. Runbook

`_e2e/README-tool-sessions.md`.
