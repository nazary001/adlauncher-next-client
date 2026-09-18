# TikTok Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working TikTok platform in the console — fresh launches (classic + Smart+), clones and JUROs through LION's `tiktok-weapon` API — verified locally against a contract mock, never deployed.

**Architecture:** The Google rail's twin. Pure dependency-free modules (`tiktok-launch`, `tiktok-source`, `tiktok-pump-core`) own every decision and are unit-tested under `node --test`; a thin client (`tiktok-weapon`), a wave handler and an `after()` pump bind the I/O; per-rail UI files follow the repo's copy-and-adapt convention (no cross-rail refactor).

**Tech Stack:** Next.js 16.3 (App Router, `after()`), React 19, Tailwind 4, `@vercel/blob`, Strapi `launch-task` store, Node 24 test runner.

**Spec:** `docs/superpowers/specs/2026-09-18-tiktok-rail-design.md`

**Deviation from the plan template:** this plan is executed inline by its author in the same session, so tasks carry exact files, interfaces, test lists and verification commands instead of pre-written code bodies — the code is written once, in the files.

## Global Constraints

- Branch `feat/tiktok-rail`; commit per task; **never push** (push to `main` auto-deploys).
- **No launch/clone/JURO POST ever reaches `tiktok-weapon.highstakes.tech`.** Live traffic is GET-only (advertisers, config, LION metrics). Anything that fires runs against `_e2e/_tiktok_mock.mjs` on `:3197`.
- Rail flag `NEXT_PUBLIC_TIKTOK_ENABLED=1` in `.env.local` only. Store partner code `tt`. Task ids `ttl-/ttc-/ttj-<wave>-NN`. `TIKTOK_MAX_SHOTS = 45`.
- Pure modules: no `@/` imports, no extensionless value imports (type-only imports are fine) — Node's type stripping must run them.
- Launches are exactly-once: ONE attempt, a 5xx/network outcome is `interrupted` and never re-sent; only a 404 "source not fetched" on clone/JURO is retried.
- Budget 20…10000 USD → `"20.00"`; bid 0 < b ≤ 100 and b < budget → `"0.15"`; ROAS 0.01…1000 → `"1.20"`.
- Name suffix `DD.MM - <user> - GC-Launcher[ - <tail>]`, São Paulo date, cap 80, pipes in the tail → `/`.
- Read `node_modules/next/dist/docs/` before using a Next API not already used by the Google rail (AGENTS.md).
- Do not touch the behaviour of the FB / Google / Snapchat rails. Shared files change additively only (`header.tsx`, `partners.ts`, `(app)/layout.tsx`, `api/launch-tasks/route.ts`).

---

### Task 1: `lib/tiktok-launch.ts` — the decisions

**Files:** Create `lib/tiktok-launch.ts`, `tests/tiktok-launch.test.ts`.

**Produces:**

```ts
export type TiktokKind = "launch" | "clone" | "juro";
export type TiktokBidKind = "bid" | "roas" | "none";
export type TiktokModeDef = { value: string; label: string; short: string; kind: TiktokBidKind; hint: string };
export const TIKTOK_LAUNCH_MODES: readonly TiktokModeDef[];   // NORMAL_WITH_BID, NORMAL_NO_BID, VO_HIGHEST_VALUE, VO_MIN_ROAS
export const TIKTOK_CLONE_MODES: readonly TiktokModeDef[];    // + WARM_UP
export function tiktokModeKind(mode: string): TiktokBidKind | "unknown";
export const TIKTOK_DEFAULT_BUDGET = "20,00", TIKTOK_BUDGET_MIN = 20, TIKTOK_BUDGET_MAX = 10_000, TIKTOK_BID_MAX = 100, TIKTOK_ROAS_MIN = 0.01, TIKTOK_ROAS_MAX = 1000;
export function parseDecimal(raw: string): number;
export function tiktokBudgetWire(human: string): string | null;
export function parseTiktokBid(raw: string): number | null;
export function parseTiktokRoas(raw: string): number | null;
export function moneyText(v: number): string;
export type TiktokBidPlan = { refusal: string } | { wireMode?: string; conversionBidPrice?: string; roasBid?: string; bidKind: TiktokBidKind | "unknown"; label: string };
export function tiktokBidPlan(a: { kind: TiktokKind; mode: string; typedBid: string; budget?: string; supportedModes?: string[] }): TiktokBidPlan;

export const TIKTOK_NAME_MARK = "GC-Launcher", TIKTOK_NAME_SUFFIX_MAX = 80;
export function todaySaoPauloDotDDMM(now?: Date): string;
export function tiktokNameSuffix(a: { user: string; ddmm: string; tail?: string }): string;
export function tiktokLandingBase(raw: string): { base: string; host: string; path: string; strippedQuery: boolean } | null;
export function tiktokGeoLabel(countries: unknown): string;                       // "US+CA" | "WW" | ""
export function tiktokNameHeadPreview(a: { acr?: string; countries: unknown; language?: string; landing: string }): string;
export function tiktokNamePreview(a: { head: string; suffix: string; kind: TiktokKind; sourceId?: string; smartPlus?: "" | "adgroup" | "campaign" }): string;
export type TiktokLinkSegment = { text: string; role: "slug" | "params" | "pixel" };
export function tiktokLandingSegments(raw: string, ctx?: { acr?: string; pixel?: string }): TiktokLinkSegment[];

export const TIKTOK_CTAS: readonly { value: string; label: string }[];
export const TIKTOK_TITLE_MAX = 100, TIKTOK_IDENTITY_NAME_MAX = 100, TIKTOK_VIDEOS_MAX = 20, TIKTOK_AD_TEXTS_MAX = 5, TIKTOK_CTAS_MAX = 3;
export const TIKTOK_GEO_PRESETS: readonly { label: string; codes: string[] }[];
export type TiktokLocaleConfig = { countries: string[]; languages: string[] };      // codes only
export function tiktokLocalesWire(countries: unknown, language: unknown, cfg?: TiktokLocaleConfig): { locales: { countries: string[]; language?: string } } | { refusal: string };

export type TiktokLaunchShotIn = { advertiser: string; pixel?: string; mode: string; budget: string; bid: string; suffix: string; landingUrl: string;
  identityName: string; identityImageUrl: string; title: string; callToAction: string; videoUrls: string[]; countries: string[]; language?: string;
  mosh?: boolean; smartPlus?: boolean; budgetLevel?: string; adTexts?: string[]; callToActions?: string[]; label?: string; currency?: string };
export type TiktokLaunchWire = { advertiser_id: string; mode: string; budget: string; conversion_bid_price?: string; roas_bid?: string; pixel_code: string;
  name_suffix: string; landing_page_url: string; identity: { name: string; image_url: string };
  creative_data: { title: string; call_to_action: string; video_urls: string[]; ad_texts?: string[]; call_to_actions?: string[] };
  locales: { countries: string[]; language?: string }; mosh?: boolean; campaign_kind?: "smart_plus"; budget_level?: "campaign" | "adgroup"; client_reference?: string };
export type TiktokResolved = { advertiserId: string; pixelCode: string; supportedModes?: string[]; nameSuffix: string; clientReference?: string; config?: TiktokLocaleConfig };
export function tiktokLaunchWire(shot: TiktokLaunchShotIn, r: TiktokResolved): { wire: TiktokLaunchWire; label: string; bidKind: TiktokBidKind | "unknown" } | { refusal: string };

export type TiktokCloneShotIn = { campaignId: string; budget: string; bid: string; mode: string; suffix: string; advertiser?: string; pixel?: string;
  sourceName?: string; sourceAccount?: string; geo?: string; currency?: string };
export type TiktokCloneWire = { source_campaign_id: string; budget: string; pixel_code: string; name_suffix: string; advertiser_id?: string; mode?: string; conversion_bid_price?: string; roas_bid?: string };
export type TiktokJuroWire = { source_campaign_id: string; budget: string; conversion_bid_price?: string; name_suffix?: string };
export function tiktokCloneWire(shot: TiktokCloneShotIn, r: { advertiserId: string; pixelCode: string; supportedModes?: string[]; nameSuffix: string }): { wire: TiktokCloneWire; label: string } | { refusal: string };
export function tiktokJuroWire(shot: TiktokCloneShotIn, r: { nameSuffix: string }): { wire: TiktokJuroWire; label: string } | { refusal: string };

export function tiktokWeaponErrorMessage(status: number | undefined, body: unknown): string;
export type TiktokTaskLike = { status: string; campaignId: string | null; campaignName: string | null; errorMessage: string | null; errorStep: string | null };
export function tiktokTaskStage(status: string): "queue" | "lion" | "done" | "failed" | "unknown";
export function tiktokTaskOutcome(t: TiktokTaskLike): null | { status: "done"; stage: "created"; campaign_id: string; name?: string } | { status: "error"; stage: "lion"; error: string };
export function tiktokShotTaskId(kind: TiktokKind, waveId: string, index: number): string;
export const TIKTOK_WAVE_ID_RE: RegExp, TIKTOK_CAMPAIGN_ID_RE: RegExp, TIKTOK_ADVERTISER_ID_RE: RegExp;
export const TIKTOK_HIDDEN_LAUNCH_ACCOUNTS: ReadonlySet<string>;
export function isTiktokLaunchAccount(a: { name: string; advertiserId: string; launchEligible: boolean }): boolean;
```

- [ ] Write `tests/tiktok-launch.test.ts` first (fails: module missing). Cases: budget parsing (19,99 refused, "20" → "20.00", "20,5" → "20.50", 10001 refused); bid (0 refused, "0,46" → "0.46", 100,01 refused, bid ≥ budget refused); ROAS ("1,2" → "1.20", 0 refused, 1000,5 refused); bid plan for launch (mode missing → refusal; NORMAL_WITH_BID without bid → refusal; NORMAL_NO_BID with a typed bid → refusal naming "clear the bid"; VO_MIN_ROAS not in `supportedModes` → refusal; WARM_UP on launch → refusal); clone plan (inherit + bid → `conversion_bid_price`, inherit + no bid → label "inherit", WARM_UP accepted without value); juro plan (mode override refused; bid optional); suffix (shape, pipe replaced, cap 80 trims the tail only); landing base (query/hash stripped, http refused, host without dot refused); head preview (`{HS-____} (GLO-01) [cl|US,CA|EN] (ht/clothes/en/)`, WW, language missing → `ALL`); name preview (clone marker inside the head, Smart+ tags, juro marker); locales (WW exclusive, WW needs a language, code outside config refused, language lower-cased, dedupe + upper-case); launch wire happy path deep-equals the documented body; every refusal branch (title > 100, empty identity, non-https image, 0 and 21 videos, duplicate videos, unknown CTA, Smart+ extras without Smart+, > 5 texts, duplicate text, budget_level junk); `client_reference` rides; `targeting`/`postback_url` never appear; clone/juro wires deep-equal the documented bodies; error message (error, hint, allowed domains list, pixel list, 403 note); task outcome (pending → null, completed → created, failed → `error_step: message`, completed without campaign id → null); task ids; account predicate.
- [ ] `node --test tests/tiktok-launch.test.ts` → FAIL (cannot find module).
- [ ] Implement `lib/tiktok-launch.ts`.
- [ ] `node --test tests/tiktok-launch.test.ts` → all pass. Commit `tiktok: pure launch decisions — modes, money, naming, the launch/clone/JURO wires`.

### Task 2: `lib/tiktok-source.ts` — LION facts and name grammar

**Files:** Create `lib/tiktok-source.ts`, `tests/tiktok-source.test.ts`.

**Produces:**

```ts
export type LionTiktokRow = { campaignId: string; name: string; status: string; delivery: string; accountId: string; accountName: string; currency: string; budget: number | null; bid: number | null; landingUrl: string };
export function mapLionTiktokRow(r: Record<string, unknown>): LionTiktokRow;
export function saoPauloDate(offsetDays?: number, now?: Date): string;
export type TiktokNameParts = { head: string; suffix: string; cl: string; geo: string[]; language: string; landingPath: string; sourceKind: "" | "clone" | "juro"; sourceId: string; smartPlus: "" | "adgroup" | "campaign" };
export function parseTiktokName(name: string): TiktokNameParts;
export type TiktokDatasetState = "fetching" | "missing" | "error" | "unknown";
export type TiktokSourceInfo = { campaignId: string; known: boolean; name: string; status: string; delivery: string; accountId: string; accountName: string; currency: string;
  budget: number | null; bid: number | null; geo: string; language: string; landingPath: string; smartPlus: "" | "adgroup" | "campaign";
  dataset: { state: TiktokDatasetState; error?: string } };
export function rankTiktokLandings(rows: LionTiktokRow[], limit?: number): { url: string; count: number }[];
```

- [ ] Tests first, using REAL names captured 17–18.09: plain, `(CLONE_FROM=…)`, `(JURO_FROM=…)`, `| Smart+ CBO |`, `| Smart+ |`, multi-geo `US,GB,CA`, `WW`, `ALL` language, a name without brackets (all parts empty, never throws); row mapping with nulls/strings; `saoPauloDate` across the UTC midnight boundary; landing ranking (query stripped, grouped by host+path, empty URLs skipped, sorted by count then url, limit).
- [ ] Run → FAIL; implement; run → PASS. Commit.

### Task 3: `lib/tiktok-pump-core.ts` — the wave algorithm

**Files:** Create `lib/tiktok-pump-core.ts`, `tests/tiktok-pump-core.test.ts`.

**Produces:**

```ts
export const TIKTOK_PUMP_BUDGET_MS = 770_000;
export type TiktokPumpShot = { taskId: string; kind: TiktokKind; campaignId: string; body: unknown; rowKey: string };
export type TiktokPumpDeps = {
  submit(kind: TiktokKind, body: unknown): Promise<{ taskId: string }>;     // throws Error & { status?: number }
  datasetFetch(campaignId: string): Promise<void>;                            // throws Error & { status?: number }
  task(taskId: string): Promise<TiktokTaskLike>;
  write(taskId: string, fields: Record<string, unknown>): void;
  flush(): Promise<void>; sleep(ms: number): Promise<void>; now(): number; jitter?(): number;
};
export type TiktokPumpOpts = { firstWaitMs?: number; retryMs?: number; refetchAfterMs?: number; giveUpMs?: number; settleMs?: number; settlePollMs?: number; deadlineMarginMs?: number };
export function runTiktokPump(shots: TiktokPumpShot[], deadline: number, deps: TiktokPumpDeps, opts?: TiktokPumpOpts): Promise<void>;
```

- [ ] Tests first with a fake clock (`now` advanced by `sleep`): 201 → `done/sent` + `link`; jitter between shots but not before the first; clean 400 → error + identical-`rowKey` copies skipped with the same sentence and NOT submitted; 500 and a thrown network error → `interrupted`, exactly one submit; clone 404 → `datasetFetch` once, shot deferred, OTHER sources keep going, retried after `firstWaitMs`, succeeds; fetch re-triggered once after `refetchAfterMs`; give-up sentence after `giveUpMs`; `datasetFetch` 404 → every shot of that source fails at stage `dataset` with "LION never saw"; launch 404 is a plain refusal (no dataset path); deadline margin → un-submitted shots get "time budget ran out", none admitted; settle: completed → `done/created` + campaign id + name, failed → `error/lion` with `step: message`, a throwing `task()` never downgrades and polling continues, settle stops at `settleMs` leaving `sent`; `flush()` always awaited, even when a dep throws unexpectedly.
- [ ] Run → FAIL; implement; run → PASS. Commit.

### Task 4: `lib/tiktok-weapon.ts`, `lib/lion-tiktok.ts`, `lib/tiktok-pump.ts`

**Files:** Create the three modules + `tests/tiktok-partner.test.ts` (stubbed `globalThis.fetch`, env set before a dynamic import — the `tests/snap-api.test.ts` pattern).

**Produces:**

```ts
export class TiktokWeaponError extends Error { status?: number; detail?: unknown }
export const tiktokWeaponConfigured: () => boolean; export const tiktokRailEnabled: () => boolean; export function tiktokLiveLaunchAllowed(): boolean;
export type TwAdvertiser = { advertiserId: string; name: string; status: string; currency: string; country: string; timezone: string; bcId: string; launchEligible: boolean };
export type TwPixel = { pixelId: string; pixelCode: string; supportedModes: string[] };
export type TwConfig = { advertiserId: string; name: string; currency: string; pixels: TwPixel[]; countries: { code: string; name: string }[]; languages: { code: string; name: string }[] };
export function twAdvertisers(): Promise<TwAdvertiser[]>; export function twLaunchableAdvertisers(): Promise<TwAdvertiser[]>;
export function twAdvertiserConfig(advertiserId: string): Promise<TwConfig>;
export function twDatasetFetch(campaignId: string): Promise<{ runId: string }>;
export function twCampaignLaunch(body: TiktokLaunchWire): Promise<{ taskId: string }>; twCloneLaunch(body: TiktokCloneWire); twJuroLaunch(body: TiktokJuroWire);
export type TwTask = TiktokTaskLike & { taskId: string; kind: string; adgroupId: string | null; adIds: string[]; createdAt: string | null; updatedAt: string | null };
export function twTask(taskId: string): Promise<TwTask>; export function twTasks(ids: string[], limit?: number): Promise<TwTask[]>;
// lion-tiktok
export function lionTiktokMetrics(date: string): Promise<LionTiktokRow[]>; export function lionTiktokFindCampaigns(ids: string[], days?: number, now?: Date): Promise<Record<string, LionTiktokRow>>;
export function lionTiktokLandings(limit?: number): Promise<{ url: string; count: number }[]>;
// tiktok-pump
export const TIKTOK_PARTNER = "tt"; export function pumpTiktokWave(user: string, shots: TiktokPumpShot[], deadline: number): Promise<void>;
```

- [ ] Tests first: advertisers mapping + sort + 10-min cache (second call = no fetch) + empty answer never cached; config mapping; reads retry once on 5xx, launches do NOT (exactly one request on a 500); 4xx body → `TiktokWeaponError` with the partner's sentence and status; bearer header present; trailing slashes on every path; **live guard**: base = production host and no `TIKTOK_ALLOW_LIVE_LAUNCH`/`VERCEL_ENV` → the launch throws `tiktok_live_launch_blocked` with ZERO fetch calls, while reads still go out; mock base → allowed; `twTasks` isolates a per-id 404 as `not_found`.
- [ ] Run → FAIL; implement; run → PASS. Commit.

### Task 5: wave handlers + API routes

**Files:** Create `lib/tiktok-wave.ts`; `app/api/tiktok/{advertisers,config,sources,dataset,landings,launch,clone,juro,status}/route.ts`; `app/api/tiktok-tasks/route.ts`. Modify `app/api/launch-tasks/route.ts` (MO scope excludes `tt`), `lib/partners.ts` (`TIKTOK_ENABLED`), `.env.local` (flag + commented overrides).

**Produces:** `handleTiktokLaunch(req)`, `handleTiktokWave(req, "clone" | "juro")`, `TIKTOK_MAX_SHOTS`. Response shape = Google's (`{ok, queued, rows:[{taskId, campaignId}], alreadyAccepted?}`; refusals `{ok:false, error, availablePixels?}`).

- [ ] Every route: session → `tiktokRailEnabled()` 404 → `tiktokWeaponConfigured()` 500. Launch routes `maxDuration = 800`.
- [ ] Wave validation: advertiser in `twLaunchableAdvertisers()`, config per distinct target (≤5 in flight), pixel resolution (one → auto; several → required + must belong; none → refusal "no pixel on this advertiser"), `tiktokLaunchWire` / `tiktokCloneWire` / `tiktokJuroWire`, JURO target = source's account from LION (Smart+ source refused for JURO). Rows stamped before the claim; claim fail-closed.
- [ ] `tsc --noEmit` clean, `eslint` clean on new files. Commit.

### Task 6: contract mock + smoke

**Files:** Create `_e2e/_tiktok_mock.mjs` (:3197), `_e2e/_tiktok_advertisers_fixture.json` (cut from the live list), `_e2e/_adl_tiktok_smoke.mts`, `_e2e/README-tiktok.md` (untracked by repo convention — `_e2e/` is in `.git/info/exclude`).

- [ ] Mock: advertisers, config (403 for non-eligible), dataset fetch (202; ready `DATASET_MS` later; 404 for ids starting `404`), launch/clone/juro with the docs' validation order and 400/403/404 bodies, tasks lifecycle pending → running → completed|failed; knobs in `name_suffix`: `FAIL-400`, `FAIL-NET` (socket destroyed), `FAIL-BUILD`, `SLOW`; `GET /__calls` for assertions.
- [ ] Smoke against `next start -p 3127` with `TIKTOK_WEAPON_BASE=http://127.0.0.1:3197`: 401 without a session; catalogs; launch happy path → row `sent` → `created`; refusal matrix (budget 19, unknown advertiser, bad mode, WW without language, Smart+ extras without Smart+); idempotent waveId; clone with a cold dataset (404 → fetch → created); JURO; `FAIL-400` copies share the refusal; `FAIL-NET` → `interrupted` and exactly one POST; `FAIL-BUILD` → `error/lion`; tasks list/delete; MO scope doesn't see `tt` rows. Cleans its own rows.
- [ ] Run until green. Record the count in the README.

### Task 7: UI — launcher

**Files:** Create `components/tiktok-nav.tsx`, `components/use-tiktok.ts`, `components/tiktok-launch-card.tsx`, `components/tiktok-launch-board.tsx`, `components/tiktok-identity.ts` (256² PNG crop + remembered identities), `app/(app)/tiktok/page.tsx`, `tests/tiktok-launcher-ui.test.ts` (pure card helpers). Modify `components/header.tsx` (`platform="tiktok"`, live tab, queue button).

- [ ] Card helpers tested first: `freshTiktokCard`, `cloneTiktokCard`, `buildTiktokShot` (dry-run placeholders vs real uploads, copies fan-out), `tiktokCardRefusal`, `tiktokCardSignature`.
- [ ] Board: advertisers + per-card config hooks, Blob uploads 3 at a time (videos + avatar), one POST, unload guard only while uploading.

### Task 8: UI — task manager and Clone·JURO board

**Files:** Create `components/tiktok-task-manager.tsx` (adapted from `google-task-manager.tsx`), `components/tiktok-clone-board.tsx` (adapted from `google-clone-board.tsx`), `app/(app)/tiktok/clone/page.tsx`. Modify `app/(app)/layout.tsx` (mount `TiktokTaskManagerProvider`).

### Task 9: verification and review

- [ ] `node --test tests/*.test.ts` (whole suite — other rails untouched), `npx tsc --noEmit`, `npx eslint` on changed files, `npx next build`.
- [ ] Mock + smoke green twice in a row.
- [ ] Browser run of `/tiktok` and `/tiktok/clone` through `_e2e/_adl_session_proxy.mts` against the mock (screens in `_e2e/_ui_shots`).
- [ ] Flag OFF build check: tab disabled, `/tiktok` → `/`, `/api/tiktok/*` → 404.
- [ ] Code review (code-reviewer agent) → fix → re-verify. Update the spec status line.
