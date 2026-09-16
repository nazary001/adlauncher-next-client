# Snapchat Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dormant-by-default Snapchat platform to adlauncher that launches web campaigns on our own Snapchat Ads account through the Snapchat Marketing API, binds one partner key `glo-snp_001…100` per campaign, and shows the partner's daily revenue report per key — built and verified locally against a fake Snapchat API.

**Architecture:** Same shape as the Google rail: pure decision modules (`lib/snap-partner.ts`, `lib/snap-launch.ts`, `lib/snap-report.ts`, `lib/snap-pump-core.ts`) carry every rule and are unit-tested with `node --test`; a thin server client (`lib/snap-api.ts`) owns auth/retry; one wave route (`/api/snap/launch`) stamps rows into the shared Strapi `launch-task` store (partner tag `sn`) and runs an `after()` pump that builds media → campaign (PAUSED) → ad squad → creative → ad → activate, exactly-once per step; the key registry lives in Strapi `app-cache` rows (`snap-key:<key>`, unique `ckey` = atomic claim); the UI is a Snapchat platform tab with a launcher board, a compact task manager and a keys/report page.

**Tech Stack:** Next.js 16.3 (App Router, `after()`), React 19, TypeScript strict, Node 24 (`node --test` with native type stripping), Strapi REST (`STRAPI_API_URL`/`STRAPI_TOKEN`), Vercel Blob client upload, Snapchat Marketing API v1 (`adsapi.snapchat.com/v1`, `accounts.snapchat.com` OAuth, `businessapi.snapchat.com/v1` profiles), LION REST (`LION_TOKEN`).

**Spec:** `docs/superpowers/specs/2026-09-16-snapchat-rail-design.md`

## Global Constraints

- **Local only.** Work happens on the local feature branch `feat/snapchat-rail` in the owner's checkout: commit each task there (implementers commit their own work), but NEVER merge to `main`, never `git push`, no Vercel env, no prod flag. The owner merges/deploys on command. Every task ends with its verification step, then a commit on the feature branch.
- **Dormant on prod.** Client gate `SNAP_ENABLED = process.env.NEXT_PUBLIC_SNAP_ENABLED === "1"` (build-time, `lib/partners.ts`); server mirror `snapRailEnabled()` (`lib/snap-api.ts`) → every `/api/snap/*` and `/api/snap-tasks` answers `404 {ok:false,error:"snap_rail_disabled"}` when unset.
- **Partner constants (verbatim from the brief):** `utm_source=stone`; keys `glo-snp_001`…`glo-snp_100` (prefix `glo-snp_`, 3 digits, pool 100); landings `https://azmvhs.com/v/dmi-online-marketing-course/` (Digital marketing) and `https://azmvhs.com/v/auto-financing-by-ford/` (Cars); final link `<landing>?utm_source=stone&utm_campaign=<key>`; never put Snapchat macros (`{{…}}`) in the URL; `ScCid` is appended by Snap.
- **LION report:** `GET ${LION_BASE}/api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD`, bearer `LION_TOKEN`, body `{date, affiliate, utm_prefix, totals{revenue, forecasted_revenue, impressions, ecpm, triggered, fired, visitors, conversions}, campaigns[{utm_campaign, …same}]}`. Today = partial + forecast (São Paulo day).
- **Snapchat API facts (docs, 16.09):** base `https://adsapi.snapchat.com/v1`; batch bodies `{campaigns:[…]}` etc.; every entity `name` ≤375; creative `headline` ≤34, `brand_name` ≤32, `type:"WEB_VIEW"`, `profile_properties.profile_id` REQUIRED; ad `type:"REMOTE_WEBPAGE"`; ad squad `type:"SNAP_ADS"`, `billing_event:"IMPRESSION"`, `delivery_constraint:"DAILY_BUDGET"`, `daily_budget_micro ≥ 5_000_000`, `bid_micro` USD 10_000…500_000_000, ages are strings; bid strategies offered: `AUTO_BID`, `LOWEST_COST_WITH_MAX_BID`, `TARGET_COST` (**no `MIN_ROAS`** — deprecated 10.02.2025); media upload multipart field `file`, ≤32 MB single-part; campaign PUT needs the whole object.
- **Money:** micro = human × 1_000_000 (integer). Budget 5…10_000/day (default `"10,00"`), bid 0,01…500. Human strings use a decimal comma (`limitMoneyCents` on the cards).
- **Names:** `[DD.MM] (SNP) <niche> - <GEO> - <key> - <user> - GC-Launcher[ - <tail>]`, São Paulo date, whitespace squashed, pipes stripped, ≤375 chars (tail trimmed first). Same name on campaign, ad squad, creative, ad.
- **Store:** reuse `launch-task` columns only (`partner:"sn"`, `gcm`=key, `campaign_id`, `adset_id`=ad squad id, `ad_id`, `link`=final landing URL, `bid`=label ≤40 chars, `stage`, `geo`, `budget`, `name`). NO new Strapi columns.
- **Exactly-once:** every Snap create/update uses ONE attempt; 4xx = refusal (row `error`), 5xx/network = `interrupted`, never re-sent. Wave claim `snap-wave:<waveId>` in app-cache, fail CLOSED (503) when the store is down.
- **Task ids:** `snl-<waveId>-NN`; `SNAP_MAX_SHOTS = 45`; copies 1–20 per card.
- **Pure modules** (`lib/snap-partner.ts`, `lib/snap-launch.ts`, `lib/snap-report.ts`, `lib/snap-pump-core.ts`) must have NO `@/` imports and no extensionless relative imports so `node --test tests/<file>.test.ts` loads them; tests import with an explicit `.ts` extension.
- **Commands:** unit `node --test tests/snap-partner.test.ts` (one file per invocation — the Windows Node build does not take a directory); types `npx tsc --noEmit`; lint `npx eslint`; build `npx next build`. The dev server: `npx next dev -p 3124`.
- **Style:** match the Google rail files (comments explain WHY, Tailwind tokens `text-ink/text-dim/text-faint/border-line/bg-surface/bg-surface2/bg-raise/text-warn/text-danger/text-launch2/bg-accent`, icons from `components/icons.tsx`, `SearchSelect`/`MultiSelect`/`Select`/`Dropzone` from `components/`).

## File Structure

**Create (pure, tested — no runtime imports, `node --test`-loadable):**
- `lib/snap-launch.ts` — ONE pure module in two parts: (1) partner constants — keys codec, the two landings, landing base/URL/segments, the console campaign name, São Paulo dates; (2) the launch vocabulary (strategies, goals, CTAs, geo presets, ages), micro money, bid labels, task ids and `snapLaunchWire` (the ONE validator). Pure modules cannot import each other (Node needs `.ts` extensions the app's tsconfig forbids), hence one file.
- `lib/snap-report.ts` — LION report parser + date resolution (`today`/`yesterday`/ISO, partial flag).
- `lib/snap-pump-core.ts` — the deps-injected pump algorithm (key → media → campaign → adsquad → creative → ad → activate → done; refusal/ambiguous dispositions). Type-only import from `./snap-launch`.
- `lib/snap-api.ts` — Snapchat Marketing API client (OAuth refresh, bounded fetch, exactly-once writes, cached reads, error sentences), `snapRailEnabled`, `snapConfigured`, `snapDefaults`; type-only imports, so its pure parts are unit-tested with a stubbed fetch.
- `lib/snap-keys.ts` — key registry over Strapi `app-cache` rows (`snap-key:<key>`): list / claim / backfill / release / find; own bounded fetch, unit-tested with a stubbed fetch.

**Create (server, `@/` imports):**
- `lib/lion-snap.ts` — LION report reader with a per-date cache.
- `lib/snap-wave.ts` — `handleSnapLaunch` (validation, row stamping, wave claim, `after(pump)`).
- `lib/snap-pump.ts` — binds real I/O into `runSnapPump`.
- `lib/snap-oauth.ts` — signed OAuth state + redirect URI for the owner-only helper.
- `app/api/snap/launch/route.ts`, `app/api/snap/accounts/route.ts`, `app/api/snap/keys/route.ts`, `app/api/snap/report/route.ts`, `app/api/snap-tasks/route.ts`, `app/api/snap/oauth/start/route.ts`, `app/api/snap/oauth/callback/route.ts`.

**Create (client):**
- `components/use-snap.ts` — `useSnapCatalog()`, `useSnapKeys()`.
- `components/snap-launch-card.tsx` — card model + helpers + component.
- `components/snap-launch-board.tsx` — the launcher page body (cards + launch bay + fire).
- `components/snap-task-manager.tsx` — provider, header button, drawer.
- `components/snap-keys-board.tsx` — keys registry + report table.
- `components/snap-nav.tsx` — Launch / Keys sub-nav.
- `app/(app)/snap/page.tsx`, `app/(app)/snap/keys/page.tsx`.

**Modify:**
- `lib/partners.ts` — add `SNAP_ENABLED` next to `GOOGLE_ENABLED` (line ~262).
- `components/icons.tsx` — add `SnapMark`.
- `components/header.tsx` — `Platform` gains `"snapchat"`, Snapchat tab, locked switcher note, `SnapTaskManagerButton`.
- `app/(app)/layout.tsx` — mount `SnapTaskManagerProvider` innermost.
- `app/api/launch-tasks/route.ts` — MO scope excludes `partner=sn` (lines 84–86).

**Create (e2e + docs):**
- `_e2e/_snap_mock.mjs` — fake Snapchat API (auth + ads + business hosts) on :3198.
- `_e2e/_adl_snap_smoke.mts` — route smoke against the mock.
- `_e2e/README-snap.md` — setup checklist (account, Public Profile, pixel, OAuth app + refresh token, CAPI token for the partner, env), mock/smoke recipe, first live read-only check.

**Tests:** `tests/snap-partner.test.ts`, `tests/snap-launch.test.ts`, `tests/snap-report.test.ts`, `tests/snap-pump-core.test.ts`, `tests/snap-api.test.ts`, `tests/snap-keys.test.ts`.

**Task order:** 1 partner constants → 2 validator → 3 report parser → 4 pump core → 5 API client → 6 registry + keys route → 7 report reader + route → 8 wave/pump/launch route/tasks route/MO scope → 9 flag + mark + sub-nav + local env → 10 catalog route + hooks → 11 task manager + header/layout → 12 card → 13 board + `/snap` → 14 keys board + `/snap/keys` → 15 OAuth helper → 16 mock → 17 smoke + runbook → 18 whole-tree verification.

**Env (names; add to `.env.local` locally, never to Vercel in this plan):** `NEXT_PUBLIC_SNAP_ENABLED`, `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET`, `SNAP_REFRESH_TOKEN`, `SNAP_ORGANIZATION_ID`, `SNAP_AD_ACCOUNT_ID`, `SNAP_PIXEL_ID`, `SNAP_PROFILE_ID`, `SNAP_BRAND_NAME`, `SNAP_API_BASE`, `SNAP_AUTH_BASE`, `SNAP_BUSINESS_API_BASE`, `SNAP_OAUTH_REDIRECT_URI`.

---
### Task 1: Partner constants — keys, landings, link, name (`lib/snap-launch.ts`, part 1)

**Files:**
- Create: `lib/snap-launch.ts` (partner section; Task 2 appends the launch vocabulary + wire to the SAME file — one pure module, because pure modules cannot import each other without `.ts` extensions under `node --test`)
- Test: `tests/snap-partner.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `SNAP_UTM_SOURCE = "stone"`, `SNAP_KEY_PREFIX = "glo-snp_"`, `SNAP_KEY_POOL_MAX = 100`, `SNAP_KEY_RE`
  - `snapKeyCode(n: number): string` · `snapKeyIndex(key: string): number | null` · `isSnapKey(key: string): boolean` · `snapKeyPool(): string[]`
  - `type SnapLandingId = "dmi" | "cars"` · `type SnapLanding = { id: SnapLandingId; niche: string; url: string }` · `SNAP_LANDINGS` · `snapLandingById(id: string): SnapLanding | null`
  - `snapLandingBase(raw: string): { base: string; strippedQuery: boolean } | null` · `isPartnerLanding(base: string): boolean`
  - `snapLandingUrl(base: string, key: string): string` · `type SnapLinkSegment = { text: string; role: "landing" | "utm" | "keyName" | "key" | "sccid" }` · `snapLandingSegments(raw: string, key: string): SnapLinkSegment[]`
  - `SNAP_NAME_MARK = "GC-Launcher"`, `SNAP_NAME_MAX = 375`, `snapCampaignName(args: { ddmm: string; niche: string; geoLabel: string; key: string; user: string; tail?: string }): string`
  - `todaySaoPauloDotDDMM(now?: Date): string` · `saoPauloDateISO(offsetDays?: number, now?: Date): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-partner.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-partner.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the PARTNER decisions in lib/snap-launch.ts: the 100 fixed keys, the two
// landings, the exact link shape from the brief, the console campaign name, São Paulo dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_KEY_POOL_MAX,
  SNAP_LANDINGS,
  SNAP_NAME_MAX,
  isPartnerLanding,
  isSnapKey,
  saoPauloDateISO,
  snapCampaignName,
  snapKeyCode,
  snapKeyIndex,
  snapKeyPool,
  snapLandingBase,
  snapLandingById,
  snapLandingSegments,
  snapLandingUrl,
  todaySaoPauloDotDDMM,
} from "../lib/snap-launch.ts";

test("keys: 3-digit zero-padded, pool 1..100, nothing outside", () => {
  assert.equal(snapKeyCode(1), "glo-snp_001");
  assert.equal(snapKeyCode(7), "glo-snp_007");
  assert.equal(snapKeyCode(100), "glo-snp_100");
  assert.equal(snapKeyCode(0), "");
  assert.equal(snapKeyCode(101), "");
  assert.equal(snapKeyCode(1.5), "");
  assert.equal(SNAP_KEY_POOL_MAX, 100);
  assert.equal(snapKeyPool().length, 100);
  assert.equal(snapKeyPool()[99], "glo-snp_100");
});

test("keys: index parse is strict (prefix, 3 digits, 1..100)", () => {
  assert.equal(snapKeyIndex("glo-snp_042"), 42);
  assert.equal(snapKeyIndex(" glo-snp_100 "), 100);
  assert.equal(snapKeyIndex("glo-snp_000"), null);
  assert.equal(snapKeyIndex("glo-snp_101"), null);
  assert.equal(snapKeyIndex("glo-snp_42"), null);
  assert.equal(snapKeyIndex("GLO-SNP_042"), null);
  assert.equal(snapKeyIndex("gcm_042"), null);
  assert.equal(isSnapKey("glo-snp_001"), true);
  assert.equal(isSnapKey(""), false);
});

test("landings: exactly the two partner pages, addressable by id", () => {
  assert.deepEqual(
    SNAP_LANDINGS.map((l) => [l.id, l.niche, l.url]),
    [
      ["dmi", "Digital marketing", "https://azmvhs.com/v/dmi-online-marketing-course/"],
      ["cars", "Cars", "https://azmvhs.com/v/auto-financing-by-ford/"],
    ],
  );
  assert.equal(snapLandingById("cars")?.url, "https://azmvhs.com/v/auto-financing-by-ford/");
  assert.equal(snapLandingById("nope"), null);
  assert.equal(isPartnerLanding("https://azmvhs.com/v/auto-financing-by-ford/"), true);
  assert.equal(isPartnerLanding("https://example.com/"), false);
});

test("landing base: https only, pasted query/hash dropped and flagged", () => {
  assert.deepEqual(snapLandingBase("https://azmvhs.com/v/auto-financing-by-ford/"), {
    base: "https://azmvhs.com/v/auto-financing-by-ford/",
    strippedQuery: false,
  });
  assert.deepEqual(snapLandingBase("https://azmvhs.com/v/auto-financing-by-ford/?utm_source=x#top"), {
    base: "https://azmvhs.com/v/auto-financing-by-ford/",
    strippedQuery: true,
  });
  assert.equal(snapLandingBase("http://azmvhs.com/v/x/"), null);
  assert.equal(snapLandingBase("azmvhs.com/v/x/"), null);
  assert.equal(snapLandingBase("https://localhost/x"), null);
  assert.equal(snapLandingBase(""), null);
});

test("final link is EXACTLY the brief's example (utm_source=stone, one key, no macros)", () => {
  assert.equal(
    snapLandingUrl("https://azmvhs.com/v/dmi-online-marketing-course/", "glo-snp_001"),
    "https://azmvhs.com/v/dmi-online-marketing-course/?utm_source=stone&utm_campaign=glo-snp_001",
  );
  assert.equal(
    snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_002"),
    "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_002",
  );
  assert.doesNotMatch(snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_002"), /\{\{/);
});

test("preview segments: the real link first (roles landing/utm/keyName/key), then the ScCid note", () => {
  const segs = snapLandingSegments("https://azmvhs.com/v/auto-financing-by-ford/?x=1", "glo-snp_009");
  assert.deepEqual(
    segs.map((s) => s.role),
    ["landing", "utm", "keyName", "key", "sccid"],
  );
  const real = segs.filter((s) => s.role !== "sccid").map((s) => s.text).join("");
  assert.equal(real, snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_009"));
  assert.match(segs[4].text, /ScCid/);
  assert.deepEqual(snapLandingSegments("nope", "glo-snp_009"), []);
  assert.equal(snapLandingSegments("https://azmvhs.com/v/auto-financing-by-ford/", "")[3].text, "glo-snp_???");
});

test("campaign name: the console pattern with the key and the GC-Launcher marker", () => {
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US", key: "glo-snp_012", user: "nazar" }),
    "[16.09] (SNP) Cars - US - glo-snp_012 - nazar - GC-Launcher",
  );
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US+CA", key: "glo-snp_012", user: "nazar", tail: "  test  A | B " }),
    "[16.09] (SNP) Cars - US+CA - glo-snp_012 - nazar - GC-Launcher - test A / B",
  );
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "", geoLabel: "", key: "glo-snp_001", user: "" }),
    "[16.09] (SNP) Snap - ?? - glo-snp_001 - buyer - GC-Launcher",
  );
});

test("campaign name never exceeds 375 chars — the tail is trimmed first, the key/marker survive", () => {
  const name = snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US", key: "glo-snp_012", user: "nazar", tail: "x".repeat(500) });
  assert.ok(name.length <= SNAP_NAME_MAX);
  assert.match(name, /glo-snp_012 - nazar - GC-Launcher - x+$/);
});

test("São Paulo dates: DD.MM and YYYY-MM-DD with a day offset", () => {
  const at = new Date("2026-09-16T01:30:00Z"); // 22:30 on 15.09 in São Paulo (UTC-3)
  assert.equal(todaySaoPauloDotDDMM(at), "15.09");
  assert.equal(saoPauloDateISO(0, at), "2026-09-15");
  assert.equal(saoPauloDateISO(1, at), "2026-09-14");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-partner.test.ts`
Expected: FAIL — `Cannot find module '…/lib/snap-launch.ts'`.

- [ ] **Step 3: Write the partner section of the module**

Create `lib/snap-launch.ts`:

```ts
// Snapchat rail — pure decisions (docs/superpowers/specs/2026-09-16-snapchat-rail-design.md).
// Deliberately dependency-free (no "@/" imports, no relative imports) so `node --test` runs it
// straight off Node's type stripping. Part 1 (this task): the PARTNER contract — the 100 fixed
// revenue keys, the two landings, the exact link shape, the console name. Part 2 (Task 2): the
// launch vocabulary and `snapLaunchWire`, the ONE validator the board dry-runs and the pump runs.

// ---------- partner keys ----------

/** The partner tags every landing hit by this utm_source; it never changes per campaign. */
export const SNAP_UTM_SOURCE = "stone";
export const SNAP_KEY_PREFIX = "glo-snp_";
export const SNAP_KEY_POOL_MAX = 100;
export const SNAP_KEY_RE = /^glo-snp_(\d{3})$/;

/** Pool index 1..100 → the partner's fixed key ("glo-snp_007"); "" outside the pool. */
export function snapKeyCode(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > SNAP_KEY_POOL_MAX) return "";
  return `${SNAP_KEY_PREFIX}${String(n).padStart(3, "0")}`;
}

/** Key → pool index, null for anything that isn't one of the 100 keys (strict: prefix, 3 digits). */
export function snapKeyIndex(key: string): number | null {
  const m = SNAP_KEY_RE.exec(String(key ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= SNAP_KEY_POOL_MAX ? n : null;
}

export const isSnapKey = (key: string): boolean => snapKeyIndex(key) !== null;

/** Every key of the pool, in order (the keys page lists all 100, bound or free). */
export function snapKeyPool(): string[] {
  return Array.from({ length: SNAP_KEY_POOL_MAX }, (_, i) => snapKeyCode(i + 1));
}

// ---------- partner landings ----------

export type SnapLandingId = "dmi" | "cars";
export type SnapLanding = { id: SnapLandingId; niche: string; url: string };

/** The partner's pages (brief 16.09). Revenue is reported ONLY for hits on these. */
export const SNAP_LANDINGS: readonly SnapLanding[] = [
  { id: "dmi", niche: "Digital marketing", url: "https://azmvhs.com/v/dmi-online-marketing-course/" },
  { id: "cars", niche: "Cars", url: "https://azmvhs.com/v/auto-financing-by-ford/" },
] as const;

export const snapLandingById = (id: string): SnapLanding | null => SNAP_LANDINGS.find((l) => l.id === id) ?? null;

/**
 * The landing as the wire takes it: https only, a real hostname, and any pasted query/hash
 * DROPPED — our two utm params must be the only query (Snap appends ScCid itself; a stray
 * utm_source from a pasted link would override the partner's `stone`). Null = not an https URL.
 */
export function snapLandingBase(raw: string): { base: string; strippedQuery: boolean } | null {
  const v = String(raw ?? "").trim();
  if (!/^https:\/\//i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    const strippedQuery = Boolean(u.search || u.hash);
    u.search = "";
    u.hash = "";
    return { base: u.toString(), strippedQuery };
  } catch {
    return null;
  }
}

export const isPartnerLanding = (base: string): boolean => SNAP_LANDINGS.some((l) => l.url === base);

/** The final ad URL — EXACTLY the brief's shape, static params, no Snapchat macros. */
export function snapLandingUrl(base: string, key: string): string {
  return `${base}?utm_source=${SNAP_UTM_SOURCE}&utm_campaign=${key}`;
}

/** Role-tagged segments for the card's coloured preview. The first four joined ARE the real link
 *  (snapLandingUrl); the trailing `sccid` segment is a preview-only note — Snap appends the real
 *  `&ScCid=<click id>` on every swipe, nothing to send. */
export type SnapLinkRole = "landing" | "utm" | "keyName" | "key" | "sccid";
export type SnapLinkSegment = { text: string; role: SnapLinkRole };
export function snapLandingSegments(raw: string, key: string): SnapLinkSegment[] {
  const b = snapLandingBase(raw);
  if (!b) return [];
  return [
    { text: b.base, role: "landing" },
    { text: `?utm_source=${SNAP_UTM_SOURCE}`, role: "utm" },
    { text: "&utm_campaign=", role: "keyName" },
    { text: key || "glo-snp_???", role: "key" },
    { text: "&ScCid=<appended by Snap>", role: "sccid" },
  ];
}

// ---------- naming ----------

/** Owner rule 2026-09-14: every campaign born through this console carries a hardcoded marker. */
export const SNAP_NAME_MARK = "GC-Launcher";
/** Snapchat's cap on campaign / ad squad / creative / ad names. */
export const SNAP_NAME_MAX = 375;

const squash = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();
const noPipes = (s: string): string => s.replace(/\|/g, "/");

/**
 * The console name, used verbatim on the campaign, the ad squad, the creative and the ad:
 * `[DD.MM] (SNP) <niche> - <GEO> - <key> - <user> - GC-Launcher[ - <tail>]`. The key inside the
 * name makes LION's per-key report readable from Ads Manager; pipes are replaced so a tail can't
 * fake a segment; the tail is trimmed first when the whole thing would pass SNAP_NAME_MAX.
 */
export function snapCampaignName(args: { ddmm: string; niche: string; geoLabel: string; key: string; user: string; tail?: string }): string {
  const user = noPipes(squash(args.user)) || "buyer";
  const niche = noPipes(squash(args.niche)) || "Snap";
  const geo = squash(args.geoLabel) || "??";
  const head = `[${args.ddmm}] (SNP) ${niche} - ${geo} - ${args.key} - ${user} - ${SNAP_NAME_MARK}`;
  let tail = noPipes(squash(args.tail ?? ""));
  const room = SNAP_NAME_MAX - head.length - 3; // " - " between head and tail
  if (tail && tail.length > room) tail = room > 0 ? tail.slice(0, room).trim() : "";
  return `${head}${tail ? ` - ${tail}` : ""}`;
}

// ---------- São Paulo clock (LION's day boundary; the team's name date) ----------

function saoPauloParts(d: Date): Record<string, string> {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
}

/** Today as DD.MM in São Paulo (the name date). Injectable clock for tests. */
export function todaySaoPauloDotDDMM(now: Date = new Date()): string {
  const p = saoPauloParts(now);
  return `${p.day}.${p.month}`;
}

/** YYYY-MM-DD of (now − offsetDays) in São Paulo — LION's report day. */
export function saoPauloDateISO(offsetDays = 0, now: Date = new Date()): string {
  const p = saoPauloParts(new Date(now.getTime() - offsetDays * 86_400_000));
  return `${p.year}-${p.month}-${p.day}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd adlauncher && node --test tests/snap-partner.test.ts`
Expected: `# pass 9`, `# fail 0`.

- [ ] **Step 5: Type-check the new module**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors (the module has no imports; tests are excluded from tsconfig).

---

### Task 2: Launch vocabulary + the ONE validator (`lib/snap-launch.ts`, part 2)

**Files:**
- Modify: `lib/snap-launch.ts` (append below the São Paulo clock)
- Test: `tests/snap-launch.test.ts`

**Interfaces:**
- Consumes: Task 1 exports (`snapLandingBase`, `snapLandingById`, `snapLandingUrl`, `isSnapKey`, `SNAP_NAME_MAX`).
- Produces:
  - `type SnapBidKind = "none" | "bid"` · `SNAP_BID_STRATEGIES` (`AUTO_BID` none · `LOWEST_COST_WITH_MAX_BID` bid · `TARGET_COST` bid) · `snapBidKind(v: string): SnapBidKind | "unknown"` · `snapStrategyLabel(v: string): string`
  - `SNAP_OPTIMIZATION_GOALS: readonly { value: string; label: string; needsPixel: boolean }[]` · `snapGoalNeedsPixel(v: string): boolean`
  - `SNAP_CTAS: readonly { value: string; label: string }[]` · `SNAP_GEO_PRESETS: readonly { label: string; codes: string[] }[]` · `SNAP_MIN_AGES = ["18","21","25"]`
  - `SNAP_DEFAULT_BUDGET = "10,00"`, `SNAP_BUDGET_MIN = 5`, `SNAP_BUDGET_MAX = 10_000`, `SNAP_BID_MIN = 0.01`, `SNAP_BID_MAX = 500`, `SNAP_HEADLINE_MAX = 34`, `SNAP_BRAND_MAX = 32`, `SNAP_MEDIA_MAX_BYTES = 33_554_432`, `SNAP_MAX_SHOTS = 45`, `SNAP_MAX_COPIES = 20`, `SNAP_WAVE_ID_RE`
  - `parseDecimal(raw: string): number` · `snapMicro(human: string, min: number, max: number): number | null` · `snapMoneyText(v: number): string` · `snapBidLabel(strategy: string, bidMicro: number | undefined, currency: string): string` · `snapCurrencySymbol(code: string): string`
  - `snapGeoWire(geo: unknown): { geos: { country_code: string }[]; label: string } | { refusal: string }`
  - `snapShotTaskId(waveId: string, index: number): string` (`snl-<wave>-NN`)
  - `type SnapLaunchShotIn`, `type SnapCampaignWire`, `type SnapAdSquadWire`, `type SnapCreativeWire`, `type SnapAdWire`, `type SnapLaunchWire`, `type SnapResolved`
  - `snapShotNiche(shot: SnapLaunchShotIn): string`
  - `snapLaunchWire(shot: SnapLaunchShotIn, resolved: SnapResolved): { wire: SnapLaunchWire; label: string; geoLabel: string; landingBase: string; niche: string; bidMicro?: number } | { refusal: string }`

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-launch.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-launch.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the LAUNCH decisions in lib/snap-launch.ts: the strategy/goal/CTA vocabulary
// (no MIN_ROAS — deprecated by Snap 10.02.2025), micro money, geo wire, task ids, bid labels and
// snapLaunchWire — the ONE validator the board dry-runs and the pump runs for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_BID_STRATEGIES,
  SNAP_CTAS,
  SNAP_GEO_PRESETS,
  SNAP_OPTIMIZATION_GOALS,
  snapBidKind,
  snapBidLabel,
  snapGeoWire,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapMicro,
  snapMoneyText,
  snapShotTaskId,
  type SnapLaunchShotIn,
  type SnapResolved,
} from "../lib/snap-launch.ts";

test("vocabulary: three bid strategies (no MIN_ROAS), five goals, PIXEL_* need a pixel", () => {
  assert.deepEqual(SNAP_BID_STRATEGIES.map((s) => [s.value, s.kind]), [
    ["AUTO_BID", "none"],
    ["LOWEST_COST_WITH_MAX_BID", "bid"],
    ["TARGET_COST", "bid"],
  ]);
  assert.equal(snapBidKind("MIN_ROAS"), "unknown");
  assert.equal(snapBidKind("TARGET_COST"), "bid");
  assert.deepEqual(
    SNAP_OPTIMIZATION_GOALS.map((g) => g.value),
    ["PIXEL_PURCHASE", "PIXEL_PAGE_VIEW", "LANDING_PAGE_VIEW", "SWIPES", "IMPRESSIONS"],
  );
  assert.equal(snapGoalNeedsPixel("PIXEL_PURCHASE"), true);
  assert.equal(snapGoalNeedsPixel("SWIPES"), false);
  assert.equal(snapGoalNeedsPixel("NOPE"), false);
  assert.equal(SNAP_CTAS[0].value, "MORE");
  assert.ok(SNAP_CTAS.every((c) => /^[A-Z_]+$/.test(c.value)));
  assert.deepEqual(SNAP_GEO_PRESETS.map((p) => p.label), ["US", "Anglo", "LATAM", "Franco", "EU"]);
  assert.deepEqual(SNAP_GEO_PRESETS[1].codes, ["US", "CA", "GB", "AU", "NZ", "IE"]);
  assert.equal(SNAP_GEO_PRESETS[4].codes.length, 27);
});

test("micro money: decimal comma/point, cents rounding, min/max in the human unit", () => {
  assert.equal(snapMicro("10,00", 5, 10_000), 10_000_000);
  assert.equal(snapMicro("10", 5, 10_000), 10_000_000);
  assert.equal(snapMicro("7.5", 5, 10_000), 7_500_000);
  assert.equal(snapMicro("4,99", 5, 10_000), null);
  assert.equal(snapMicro("10000,01", 5, 10_000), null);
  assert.equal(snapMicro("", 5, 10_000), null);
  assert.equal(snapMicro("abc", 5, 10_000), null);
  assert.equal(snapMicro("0,50", 0.01, 500), 500_000);
  assert.equal(snapMicro("0", 0.01, 500), null);
  assert.equal(snapMicro("500,01", 0.01, 500), null);
  assert.equal(snapMoneyText(0.5), "0,5");
  assert.equal(snapMoneyText(10), "10");
  assert.equal(snapMoneyText(1.25), "1,25");
});

test("bid labels for the monitor tag", () => {
  assert.equal(snapBidLabel("AUTO_BID", undefined, "USD"), "auto");
  assert.equal(snapBidLabel("LOWEST_COST_WITH_MAX_BID", 500_000, "USD"), "max $0,5");
  assert.equal(snapBidLabel("TARGET_COST", 1_200_000, "USD"), "target $1,2");
  assert.equal(snapBidLabel("TARGET_COST", 1_200_000, "EUR"), "target €1,2");
  assert.equal(snapBidLabel("TARGET_COST", undefined, "USD"), "target ?");
});

test("geo wire: lower-cased ISO-2 for Snap, upper-cased label, WW and junk refused", () => {
  assert.deepEqual(snapGeoWire(["us", "CA", "us"]), { geos: [{ country_code: "us" }, { country_code: "ca" }], label: "US+CA" });
  const empty = snapGeoWire([]);
  assert.ok("refusal" in empty && /at least one country/i.test(empty.refusal));
  const ww = snapGeoWire(["WW"]);
  assert.ok("refusal" in ww && /worldwide/i.test(ww.refusal));
  const junk = snapGeoWire(["USA"]);
  assert.ok("refusal" in junk && /USA/.test(junk.refusal));
});

test("task ids are deterministic per wave: snl-<wave>-NN", () => {
  assert.equal(snapShotTaskId("wave-1234-abcd", 0), "snl-wave-1234-abcd-01");
  assert.equal(snapShotTaskId("wave-1234-abcd", 11), "snl-wave-1234-abcd-12");
});

// ---- snapLaunchWire ----------------------------------------------------------------------------

const shot = (over: Partial<SnapLaunchShotIn> = {}): SnapLaunchShotIn => ({
  adAccount: "acct-a",
  pixel: "px-1",
  optimizationGoal: "PIXEL_PURCHASE",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  startPaused: false,
  headline: "Drive it home today",
  brandName: "GC Cars",
  cta: "MORE",
  mediaUrl: "https://blob.vercel-storage.com/snap/x/v.mp4",
  mediaKind: "video",
  mediaName: "v.mp4",
  geo: ["US"],
  minAge: "18",
  landingId: "cars",
  landingUrl: "",
  suffix: "",
  ...over,
});

const resolved: SnapResolved = {
  adAccountId: "acct-a",
  pixelId: "px-1",
  profileId: "prof-1",
  name: "[16.09] (SNP) Cars - US - glo-snp_003 - nazar - GC-Launcher",
  key: "glo-snp_003",
  mediaId: "media-1",
  startTimeIso: "2026-09-16T12:00:00.000Z",
};

test("happy path: the four Snap bodies + the final landing URL, AUTO_BID sends no bid_micro", () => {
  const r = snapLaunchWire(shot(), resolved);
  assert.ok(!("refusal" in r), JSON.stringify(r));
  if ("refusal" in r) return;
  assert.equal(r.label, "auto");
  assert.equal(r.geoLabel, "US");
  assert.equal(r.niche, "Cars");
  assert.equal(r.landingBase, "https://azmvhs.com/v/auto-financing-by-ford/");
  assert.equal(r.bidMicro, undefined);
  assert.deepEqual(r.wire.campaign, {
    name: resolved.name,
    ad_account_id: "acct-a",
    status: "PAUSED",
    start_time: "2026-09-16T12:00:00.000Z",
  });
  assert.deepEqual(r.wire.adsquad, {
    name: resolved.name,
    type: "SNAP_ADS",
    billing_event: "IMPRESSION",
    delivery_constraint: "DAILY_BUDGET",
    daily_budget_micro: 10_000_000,
    bid_strategy: "AUTO_BID",
    optimization_goal: "PIXEL_PURCHASE",
    placement_v2: { config: "AUTOMATIC" },
    targeting: { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }] },
    pixel_id: "px-1",
    status: "ACTIVE",
    start_time: "2026-09-16T12:00:00.000Z",
  });
  assert.deepEqual(r.wire.creative, {
    ad_account_id: "acct-a",
    name: resolved.name,
    type: "WEB_VIEW",
    ad_product: "SNAP_AD",
    headline: "Drive it home today",
    brand_name: "GC Cars",
    call_to_action: "MORE",
    top_snap_media_id: "media-1",
    shareable: true,
    web_view_properties: {
      url: "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_003",
      block_preload: false,
      allow_snap_javascript_sdk: false,
      use_immersive_mode: false,
    },
    profile_properties: { profile_id: "prof-1" },
  });
  assert.deepEqual(r.wire.ad, { name: resolved.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" });
  assert.equal(r.wire.landingUrl, "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("a bid strategy carries bid_micro; a goal without a pixel sends no pixel_id", () => {
  const r = snapLaunchWire(shot({ bidStrategy: "LOWEST_COST_WITH_MAX_BID", bid: "0,50", optimizationGoal: "SWIPES", pixel: "" }), { ...resolved, pixelId: undefined });
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.equal(r.wire.adsquad.bid_micro, 500_000);
  assert.equal(r.wire.adsquad.pixel_id, undefined);
  assert.equal(r.label, "max $0,5");
  assert.equal(r.bidMicro, 500_000);
});

test("custom landing: https base with its own query dropped; niche 'Custom'", () => {
  const r = snapLaunchWire(shot({ landingId: "custom", landingUrl: "https://example.com/offer/?utm_source=bad#x" }), resolved);
  assert.ok(!("refusal" in r));
  if ("refusal" in r) return;
  assert.equal(r.niche, "Custom");
  assert.equal(r.wire.creative.web_view_properties.url, "https://example.com/offer/?utm_source=stone&utm_campaign=glo-snp_003");
});

test("refusal matrix names the field and the fix", () => {
  const refusal = (s: SnapLaunchShotIn, res: SnapResolved = resolved): string => {
    const r = snapLaunchWire(s, res);
    return "refusal" in r ? r.refusal : "";
  };
  assert.match(refusal(shot({ budget: "4,99" })), /budget.*5.*10000/i);
  assert.match(refusal(shot({ bidStrategy: "MIN_ROAS" })), /Unknown bidding strategy/);
  assert.match(refusal(shot({ bidStrategy: "TARGET_COST", bid: "" })), /Target cost needs a bid/);
  assert.match(refusal(shot({ bidStrategy: "TARGET_COST", bid: "600" })), /0,01.*500/);
  assert.match(refusal(shot({ bidStrategy: "AUTO_BID", bid: "1" })), /takes no bid/);
  assert.match(refusal(shot({ optimizationGoal: "NOPE" })), /Unknown optimization goal/);
  assert.match(refusal(shot(), { ...resolved, pixelId: undefined }), /Pixel purchase needs a conversion pixel/);
  assert.match(refusal(shot({ headline: "" })), /Headline is required/);
  assert.match(refusal(shot({ headline: "x".repeat(35) })), /Headline.*34/);
  assert.match(refusal(shot({ brandName: "" })), /Brand name is required/);
  assert.match(refusal(shot({ brandName: "x".repeat(33) })), /Brand name.*32/);
  assert.match(refusal(shot({ cta: "BUY_TICKETS" })), /Call to action/);
  assert.match(refusal(shot({ mediaUrl: "" })), /creative.*required/i);
  assert.match(refusal(shot({ mediaUrl: "http://x.com/v.mp4" })), /https/);
  assert.match(refusal(shot({ geo: [] })), /at least one country/i);
  assert.match(refusal(shot({ minAge: "16" })), /Minimum age/);
  assert.match(refusal(shot({ landingId: "custom", landingUrl: "http://example.com/" })), /https:\/\/ address/);
  assert.match(refusal(shot({ landingId: "nope" as "dmi" })), /Pick a landing/);
  assert.match(refusal(shot(), { ...resolved, profileId: "" }), /Public Profile/);
  assert.match(refusal(shot(), { ...resolved, key: "glo-snp_000" }), /not one of the partner keys/);
  assert.match(refusal(shot(), { ...resolved, mediaId: "" }), /media id/i);
  assert.match(refusal(shot(), { ...resolved, name: "x".repeat(376) }), /375/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-launch.test.ts`
Expected: FAIL — the vocabulary exports do not exist yet (`SyntaxError: The requested module … does not provide an export named 'SNAP_BID_STRATEGIES'`).

- [ ] **Step 3: Append the launch section to `lib/snap-launch.ts`**

Append after `saoPauloDateISO`:

```ts
// ======================================================================================
// Part 2 — launch vocabulary + the ONE validator
// ======================================================================================

// ---------- bidding ----------

/** What a Snapchat bid strategy takes: none = no bid_micro (sending one is a 400), bid = money. */
export type SnapBidKind = "none" | "bid";
export type SnapBidStrategy = { value: string; label: string; kind: SnapBidKind };

/** Snap's live vocabulary for web campaigns. MIN_ROAS is NOT offered — Snap deprecated it on
 *  10.02.2025 (docs read 16.09.2026). */
export const SNAP_BID_STRATEGIES: readonly SnapBidStrategy[] = [
  { value: "AUTO_BID", label: "Auto bid", kind: "none" },
  { value: "LOWEST_COST_WITH_MAX_BID", label: "Max bid", kind: "bid" },
  { value: "TARGET_COST", label: "Target cost", kind: "bid" },
] as const;
const STRATEGY_BY_VALUE = new Map(SNAP_BID_STRATEGIES.map((s) => [s.value, s]));
export const snapBidKind = (v: string): SnapBidKind | "unknown" => STRATEGY_BY_VALUE.get(v)?.kind ?? "unknown";
export const snapStrategyLabel = (v: string): string => STRATEGY_BY_VALUE.get(v)?.label ?? v;

/** Ad squad optimization goals the launcher offers; PIXEL_* need the account's pixel. */
export const SNAP_OPTIMIZATION_GOALS: readonly { value: string; label: string; needsPixel: boolean }[] = [
  { value: "PIXEL_PURCHASE", label: "Pixel purchase", needsPixel: true },
  { value: "PIXEL_PAGE_VIEW", label: "Pixel page view", needsPixel: true },
  { value: "LANDING_PAGE_VIEW", label: "Landing page view", needsPixel: false },
  { value: "SWIPES", label: "Swipes (clicks)", needsPixel: false },
  { value: "IMPRESSIONS", label: "Impressions", needsPixel: false },
] as const;
const GOAL_BY_VALUE = new Map(SNAP_OPTIMIZATION_GOALS.map((g) => [g.value, g]));
export const snapGoalNeedsPixel = (v: string): boolean => GOAL_BY_VALUE.get(v)?.needsPixel ?? false;
export const snapGoalLabel = (v: string): string => GOAL_BY_VALUE.get(v)?.label ?? v;

/** Calls to action Snap accepts on a WEB_VIEW creative (a curated ten of its list). */
export const SNAP_CTAS: readonly { value: string; label: string }[] = [
  { value: "MORE", label: "More" },
  { value: "SHOP_NOW", label: "Shop now" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "APPLY_NOW", label: "Apply now" },
  { value: "VIEW", label: "View" },
  { value: "READ", label: "Read" },
  { value: "GET_NOW", label: "Get now" },
  { value: "TRY", label: "Try" },
  { value: "SHOW", label: "Show" },
  { value: "WATCH", label: "Watch" },
] as const;
const CTA_SET = new Set(SNAP_CTAS.map((c) => c.value));

/** Geo presets. Snap has NO worldwide token — every ad squad names its countries. */
export const SNAP_GEO_PRESETS: readonly { label: string; codes: string[] }[] = [
  { label: "US", codes: ["US"] },
  { label: "Anglo", codes: ["US", "CA", "GB", "AU", "NZ", "IE"] },
  { label: "LATAM", codes: ["AR", "BO", "CL", "CO", "CR", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY"] },
  { label: "Franco", codes: ["FR", "BE", "CH", "LU", "MC", "CA"] },
  {
    label: "EU",
    codes: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
  },
] as const;

export const SNAP_MIN_AGES = ["18", "21", "25"] as const;

// ---------- limits ----------

export const SNAP_DEFAULT_BUDGET = "10,00";
/** Snap's own floor is USD 5/day (daily_budget_micro ≥ 5 000 000). */
export const SNAP_BUDGET_MIN = 5;
export const SNAP_BUDGET_MAX = 10_000;
/** Snap's USD bid_micro range 10 000 … 500 000 000. */
export const SNAP_BID_MIN = 0.01;
export const SNAP_BID_MAX = 500;
export const SNAP_HEADLINE_MAX = 34;
export const SNAP_BRAND_MAX = 32;
/** Single-part media upload cap (bigger needs Snap's chunked upload — not in v1). */
export const SNAP_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
export const SNAP_MAX_SHOTS = 45;
export const SNAP_MAX_COPIES = 20;
export const SNAP_WAVE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

// ---------- money ----------

/** Decimal-comma aware string → number (same rule as lib/types parseMoney, duplicated to stay
 *  import-pure): a lone comma is the decimal point; "1,234.56" reads the comma as thousands. */
export function parseDecimal(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  const normalized = s.includes(",") && s.includes(".") ? s.replace(/,/g, "") : s.replace(",", ".");
  if (!/^-?\d*(?:\.\d*)?$/.test(normalized) || normalized === "." || normalized === "-") return NaN;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/** Human money ("10,00") → Snap micro-currency (integer), null when unparsable or outside [min, max]. */
export function snapMicro(human: string, min: number, max: number): number | null {
  const n = parseDecimal(human);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (cents < Math.round(min * 100) || cents > Math.round(max * 100)) return null;
  return cents * 10_000;
}

/** Decimal-comma money text without trailing ",00" ("0,5", "10", "1,25"). */
export function snapMoneyText(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
}

const CUR_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", BRL: "R$" };
export const snapCurrencySymbol = (code: string): string => CUR_SYMBOL[String(code ?? "").toUpperCase()] || (code ? `${code} ` : "$");

/** Monitor tag (≤ 40 chars): "auto" / "max $0,5" / "target $1,2". */
export function snapBidLabel(strategy: string, bidMicro: number | undefined, currency: string): string {
  const kind = snapBidKind(strategy);
  if (kind !== "bid") return "auto";
  const word = strategy === "TARGET_COST" ? "target" : "max";
  if (bidMicro == null) return `${word} ?`;
  return `${word} ${snapCurrencySymbol(currency)}${snapMoneyText(bidMicro / 1_000_000)}`.slice(0, 40);
}

// ---------- geo ----------

/** Geo list → Snap targeting geos (lower-cased ISO-2, deduped) + the monitor label ("US+CA"). */
export function snapGeoWire(geo: unknown): { geos: { country_code: string }[]; label: string } | { refusal: string } {
  const codes = [...new Set((Array.isArray(geo) ? geo : []).map((g) => String(g ?? "").trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0) return { refusal: "Pick at least one country — Snapchat has no worldwide targeting" };
  if (codes.includes("WW")) return { refusal: "Snapchat has no worldwide token — pick the countries (or a preset)" };
  const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length) return { refusal: `Unknown country code${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}` };
  return { geos: codes.map((c) => ({ country_code: c.toLowerCase() })), label: codes.join("+") };
}

// ---------- task ids ----------

/** Deterministic per-shot task ids: `snl-<wave>-NN` (Snap launch). */
export function snapShotTaskId(waveId: string, index: number): string {
  return `snl-${waveId}-${String(index + 1).padStart(2, "0")}`;
}

// ---------- the wire ----------

/** One shot as the board sends it (money as HUMAN strings; copies expanded client-side, one
 *  shot = one campaign = one key). `mediaUrl` is the public Blob URL of the ONE creative. */
export type SnapLaunchShotIn = {
  label?: string;
  adAccount: string;
  pixel?: string;
  profileId?: string;
  optimizationGoal: string;
  bidStrategy: string;
  bid: string;
  budget: string;
  startPaused?: boolean;
  headline: string;
  brandName: string;
  cta: string;
  mediaUrl: string;
  mediaKind: "video" | "image";
  mediaName?: string;
  /** ISO-2 codes (Snap has no WW). */
  geo: string[];
  minAge: string;
  landingId: SnapLandingId | "custom";
  /** Custom landing (https, any query dropped); ignored for the partner landings. */
  landingUrl: string;
  /** The key the board previewed; the pump claims it or the next free one. */
  desiredKey?: string;
  suffix: string;
  /** Display material the board resolved (currency of the ad account). */
  currency?: string;
};

export type SnapCampaignWire = { name: string; ad_account_id: string; status: "PAUSED" | "ACTIVE"; start_time: string };
export type SnapAdSquadWire = {
  name: string;
  type: "SNAP_ADS";
  billing_event: "IMPRESSION";
  delivery_constraint: "DAILY_BUDGET";
  daily_budget_micro: number;
  bid_strategy: string;
  bid_micro?: number;
  optimization_goal: string;
  placement_v2: { config: "AUTOMATIC" };
  targeting: { geos: { country_code: string }[]; demographics: { min_age: string }[] };
  pixel_id?: string;
  status: "ACTIVE";
  start_time: string;
};
export type SnapCreativeWire = {
  ad_account_id: string;
  name: string;
  type: "WEB_VIEW";
  ad_product: "SNAP_AD";
  headline: string;
  brand_name: string;
  call_to_action: string;
  top_snap_media_id: string;
  shareable: true;
  web_view_properties: { url: string; block_preload: false; allow_snap_javascript_sdk: false; use_immersive_mode: false };
  profile_properties: { profile_id: string };
};
export type SnapAdWire = { name: string; type: "REMOTE_WEBPAGE"; status: "ACTIVE" };
/** The four Snap bodies of one campaign (parent ids — campaign_id, ad_squad_id, creative_id —
 *  are added by the pump as the chain proceeds) + the final landing URL for the row's `link`. */
export type SnapLaunchWire = { campaign: SnapCampaignWire; adsquad: SnapAdSquadWire; creative: SnapCreativeWire; ad: SnapAdWire; landingUrl: string };

/** What the route/pump resolved around the shot. The board dry-runs with placeholders
 *  (key "glo-snp_001", mediaId "pending", name "preview"). */
export type SnapResolved = { adAccountId: string; pixelId?: string; profileId: string; name: string; key: string; mediaId: string; startTimeIso: string };

const isHttps = (u: string): boolean => /^https:\/\/[^\s]+$/i.test(u);
/** A creative URL: public https — or a LOOPBACK http URL, which only the local e2e mock can serve
 *  (a loopback address can never be a real hosted creative on prod, so this relaxes nothing there). */
const isMediaUrl = (u: string): boolean => isHttps(u) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/[^\s]*$/i.test(u);
const squashText = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** Niche word for names/rows: the partner landing's niche, or "Custom". */
export function snapShotNiche(shot: SnapLaunchShotIn): string {
  return shot.landingId === "custom" ? "Custom" : (snapLandingById(shot.landingId)?.niche ?? "");
}

/**
 * Build the four Snap bodies for ONE shot, refusing with the exact fix when a field can't ride.
 * Order: budget → strategy/bid → goal (+pixel) → headline → brand → CTA → media → geo → age →
 * landing → Public Profile → key → name. Pure and deterministic: the board's dry-run (placeholder
 * key/media/name) and the pump's real run agree on every refusal.
 */
export function snapLaunchWire(
  shot: SnapLaunchShotIn,
  resolved: SnapResolved,
): { wire: SnapLaunchWire; label: string; geoLabel: string; landingBase: string; niche: string; bidMicro?: number } | { refusal: string } {
  const budgetMicro = snapMicro(String(shot.budget ?? ""), SNAP_BUDGET_MIN, SNAP_BUDGET_MAX);
  if (budgetMicro == null) return { refusal: `Daily budget must be between ${SNAP_BUDGET_MIN} and ${SNAP_BUDGET_MAX} in the account currency` };
  const strategy = String(shot.bidStrategy ?? "").trim();
  const kind = snapBidKind(strategy);
  if (kind === "unknown") return { refusal: `Unknown bidding strategy "${strategy}"` };
  const typedBid = String(shot.bid ?? "").trim();
  let bidMicro: number | undefined;
  if (kind === "bid") {
    if (!typedBid) return { refusal: `${snapStrategyLabel(strategy)} needs a bid in the account currency (e.g. 0,50)` };
    const b = snapMicro(typedBid, SNAP_BID_MIN, SNAP_BID_MAX);
    if (b == null) return { refusal: `Bid must be between 0,01 and 500 in the account currency` };
    bidMicro = b;
  } else if (typedBid) {
    return { refusal: `${snapStrategyLabel(strategy)} takes no bid — clear the bid` };
  }
  const goal = String(shot.optimizationGoal ?? "").trim();
  if (!GOAL_BY_VALUE.has(goal)) return { refusal: `Unknown optimization goal "${goal}"` };
  if (snapGoalNeedsPixel(goal) && !resolved.pixelId) return { refusal: `${snapGoalLabel(goal)} needs a conversion pixel — pick one or choose a non-pixel goal` };
  const headline = squashText(shot.headline);
  if (!headline) return { refusal: "Headline is required" };
  if (headline.length > SNAP_HEADLINE_MAX) return { refusal: `Headline is over ${SNAP_HEADLINE_MAX} characters (${headline.length})` };
  const brand = squashText(shot.brandName);
  if (!brand) return { refusal: "Brand name is required" };
  if (brand.length > SNAP_BRAND_MAX) return { refusal: `Brand name is over ${SNAP_BRAND_MAX} characters (${brand.length})` };
  const cta = String(shot.cta ?? "").trim();
  if (!CTA_SET.has(cta)) return { refusal: `Call to action must be one of ${SNAP_CTAS.map((c) => c.label).join(" / ")}` };
  const mediaUrl = String(shot.mediaUrl ?? "").trim();
  if (!mediaUrl) return { refusal: "One creative (a vertical video or image) is required" };
  if (!isMediaUrl(mediaUrl)) return { refusal: "The creative must be a public https:// file" };
  if (shot.mediaKind !== "video" && shot.mediaKind !== "image") return { refusal: "Creative kind must be video or image" };
  const geo = snapGeoWire(shot.geo);
  if ("refusal" in geo) return { refusal: geo.refusal };
  const minAge = String(shot.minAge ?? "").trim();
  if (!(SNAP_MIN_AGES as readonly string[]).includes(minAge)) return { refusal: `Minimum age must be one of ${SNAP_MIN_AGES.join(" / ")}` };
  let landingBase = "";
  if (shot.landingId === "custom") {
    const b = snapLandingBase(String(shot.landingUrl ?? ""));
    if (!b) return { refusal: "Custom landing must be an https:// address" };
    landingBase = b.base;
  } else {
    const l = snapLandingById(String(shot.landingId ?? ""));
    if (!l) return { refusal: "Pick a landing (Digital marketing / Cars / Custom)" };
    landingBase = l.url;
  }
  const profileId = String(resolved.profileId ?? "").trim();
  if (!profileId) return { refusal: "A Public Profile is required on every Snapchat ad — set SNAP_PROFILE_ID or pick one" };
  const key = String(resolved.key ?? "").trim();
  if (!isSnapKey(key)) return { refusal: `Key "${key}" is not one of the partner keys glo-snp_001…${SNAP_KEY_POOL_MAX}` };
  const mediaId = String(resolved.mediaId ?? "").trim();
  if (!mediaId) return { refusal: "Snap media id is missing — the creative was not uploaded" };
  const name = squashText(resolved.name);
  if (!name) return { refusal: "Campaign name is empty" };
  if (name.length > SNAP_NAME_MAX) return { refusal: `Campaign name is over ${SNAP_NAME_MAX} characters` };
  const adAccountId = String(resolved.adAccountId ?? "").trim();
  if (!adAccountId) return { refusal: "Ad account is required" };

  const landingUrl = snapLandingUrl(landingBase, key);
  const wire: SnapLaunchWire = {
    campaign: { name, ad_account_id: adAccountId, status: "PAUSED", start_time: resolved.startTimeIso },
    adsquad: {
      name,
      type: "SNAP_ADS",
      billing_event: "IMPRESSION",
      delivery_constraint: "DAILY_BUDGET",
      daily_budget_micro: budgetMicro,
      bid_strategy: strategy,
      ...(bidMicro != null ? { bid_micro: bidMicro } : {}),
      optimization_goal: goal,
      placement_v2: { config: "AUTOMATIC" },
      targeting: { geos: geo.geos, demographics: [{ min_age: minAge }] },
      ...(resolved.pixelId ? { pixel_id: resolved.pixelId } : {}),
      status: "ACTIVE",
      start_time: resolved.startTimeIso,
    },
    creative: {
      ad_account_id: adAccountId,
      name,
      type: "WEB_VIEW",
      ad_product: "SNAP_AD",
      headline,
      brand_name: brand,
      call_to_action: cta,
      top_snap_media_id: mediaId,
      shareable: true,
      web_view_properties: { url: landingUrl, block_preload: false, allow_snap_javascript_sdk: false, use_immersive_mode: false },
      profile_properties: { profile_id: profileId },
    },
    ad: { name, type: "REMOTE_WEBPAGE", status: "ACTIVE" },
    landingUrl,
  };
  return {
    wire,
    label: snapBidLabel(strategy, bidMicro, String(shot.currency ?? "USD")),
    geoLabel: geo.label,
    landingBase,
    niche: snapShotNiche(shot),
    ...(bidMicro != null ? { bidMicro } : {}),
  };
}
```

- [ ] **Step 4: Run both test files**

Run: `cd adlauncher && node --test tests/snap-launch.test.ts && node --test tests/snap-partner.test.ts`
Expected: both `# fail 0` (10 + 9 tests).

- [ ] **Step 5: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors.

---
### Task 3: LION report parser + date resolution (`lib/snap-report.ts`)

**Files:**
- Create: `lib/snap-report.ts` (pure, no imports)
- Test: `tests/snap-report.test.ts`

**Interfaces:**
- Consumes: nothing (the São Paulo helpers are re-implemented locally — pure modules cannot import each other).
- Produces:
  - `type SnapReportMetrics = { revenue: number; forecastedRevenue: number; impressions: number; ecpm: number; triggered: number; fired: number; visitors: number; conversions: number }`
  - `type SnapReport = { date: string; affiliate: string; utmPrefix: string; totals: SnapReportMetrics; byKey: Record<string, SnapReportMetrics> }`
  - `EMPTY_SNAP_METRICS: SnapReportMetrics` · `parseSnapReport(body: unknown, date: string): SnapReport` · `snapReportDate(param: string | null | undefined, now?: Date): string | null` (`today` / `yesterday` / `YYYY-MM-DD`, null when malformed or in the future) · `isSnapReportPartial(date: string, now?: Date): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-report.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-report.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the LION daily report (GET /api/high-adx-cluster-utms/snapchat-report/): the
// body shape probed live 16.09 (totals + 100 campaigns keyed by utm_campaign), tolerant parsing,
// and the today/yesterday/ISO date resolution with the São Paulo "partial day" rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SNAP_METRICS, isSnapReportPartial, parseSnapReport, snapReportDate } from "../lib/snap-report.ts";

const LIVE_SHAPE = {
  date: "2026-09-15",
  affiliate: "globecoders",
  utm_prefix: "glo-snp_",
  totals: { revenue: 12.5, forecasted_revenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 },
  campaigns: [
    { utm_campaign: "glo-snp_001", revenue: 12.5, forecasted_revenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 },
    { utm_campaign: "glo-snp_002", revenue: 0, forecasted_revenue: 0, impressions: 0, ecpm: 0, triggered: 0, fired: 0, visitors: 0, conversions: 0 },
  ],
};

test("parses the live shape: totals + a per-key map with camelCased metrics", () => {
  const r = parseSnapReport(LIVE_SHAPE, "2026-09-15");
  assert.equal(r.date, "2026-09-15");
  assert.equal(r.affiliate, "globecoders");
  assert.equal(r.utmPrefix, "glo-snp_");
  assert.deepEqual(r.totals, { revenue: 12.5, forecastedRevenue: 14, impressions: 300, ecpm: 41.67, triggered: 9, fired: 8, visitors: 120, conversions: 2 });
  assert.deepEqual(Object.keys(r.byKey), ["glo-snp_001", "glo-snp_002"]);
  assert.equal(r.byKey["glo-snp_001"].revenue, 12.5);
  assert.deepEqual(r.byKey["glo-snp_002"], EMPTY_SNAP_METRICS);
});

test("tolerant: strings become numbers, junk becomes 0, missing arrays become empty, date falls back", () => {
  const r = parseSnapReport({ totals: { revenue: "3.5", impressions: "x" }, campaigns: [{ utm_campaign: "glo-snp_007", revenue: "1" }, { revenue: 5 }, null] }, "2026-09-16");
  assert.equal(r.date, "2026-09-16");
  assert.equal(r.affiliate, "");
  assert.equal(r.totals.revenue, 3.5);
  assert.equal(r.totals.impressions, 0);
  assert.deepEqual(Object.keys(r.byKey), ["glo-snp_007"]);
  assert.equal(r.byKey["glo-snp_007"].revenue, 1);
  assert.deepEqual(parseSnapReport(null, "2026-09-16").byKey, {});
  assert.deepEqual(parseSnapReport("garbage", "2026-09-16").totals, EMPTY_SNAP_METRICS);
});

test("date resolution: today / yesterday in São Paulo, ISO passthrough, junk and future refused", () => {
  const at = new Date("2026-09-16T01:30:00Z"); // 15.09 22:30 in São Paulo
  assert.equal(snapReportDate("today", at), "2026-09-15");
  assert.equal(snapReportDate("yesterday", at), "2026-09-14");
  assert.equal(snapReportDate("", at), "2026-09-15");
  assert.equal(snapReportDate(undefined, at), "2026-09-15");
  assert.equal(snapReportDate("2026-09-01", at), "2026-09-01");
  assert.equal(snapReportDate("2026-09-16", at), null); // tomorrow in São Paulo
  assert.equal(snapReportDate("16.09.2026", at), null);
  assert.equal(snapReportDate("2026-13-01", at), null);
});

test("partial: today (São Paulo) is partial, every earlier day is final", () => {
  const at = new Date("2026-09-16T01:30:00Z");
  assert.equal(isSnapReportPartial("2026-09-15", at), true);
  assert.equal(isSnapReportPartial("2026-09-14", at), false);
  assert.equal(isSnapReportPartial("2026-09-16", at), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `lib/snap-report.ts`:

```ts
// Snapchat rail — the partner's DAILY REPORT as LION serves it, parsed into board rows. Pure and
// dependency-free (node --test). Live shape (probed 2026-09-16 with our LION_TOKEN):
//   GET /api/high-adx-cluster-utms/snapchat-report/?date=YYYY-MM-DD →
//   { date, affiliate:"globecoders", utm_prefix:"glo-snp_",
//     totals:    { revenue, forecasted_revenue, impressions, ecpm, triggered, fired, visitors, conversions },
//     campaigns: [ { utm_campaign:"glo-snp_001", …same metrics… } × 100 ] }
// "Today's numbers are partial and include a forecast; a day is final the next morning" — the
// day boundary is São Paulo like the rest of LION.

export type SnapReportMetrics = {
  revenue: number;
  forecastedRevenue: number;
  impressions: number;
  ecpm: number;
  /** Pixel events the partner triggered / actually fired on our pixel. */
  triggered: number;
  fired: number;
  visitors: number;
  conversions: number;
};

export type SnapReport = {
  date: string;
  affiliate: string;
  utmPrefix: string;
  totals: SnapReportMetrics;
  /** utm_campaign (our key) → its metrics. */
  byKey: Record<string, SnapReportMetrics>;
};

export const EMPTY_SNAP_METRICS: SnapReportMetrics = Object.freeze({
  revenue: 0,
  forecastedRevenue: 0,
  impressions: 0,
  ecpm: 0,
  triggered: 0,
  fired: 0,
  visitors: 0,
  conversions: 0,
}) as SnapReportMetrics;

const num = (v: unknown): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));

function metricsOf(r: Record<string, unknown> | null | undefined): SnapReportMetrics {
  if (!r) return { ...EMPTY_SNAP_METRICS };
  return {
    revenue: num(r.revenue),
    forecastedRevenue: num(r.forecasted_revenue),
    impressions: num(r.impressions),
    ecpm: num(r.ecpm),
    triggered: num(r.triggered),
    fired: num(r.fired),
    visitors: num(r.visitors),
    conversions: num(r.conversions),
  };
}

/** LION body → SnapReport. Never throws: junk → zeros/empties, `date` falls back to the requested day. */
export function parseSnapReport(body: unknown, date: string): SnapReport {
  const rec = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const totals = metricsOf(rec.totals && typeof rec.totals === "object" ? (rec.totals as Record<string, unknown>) : null);
  const byKey: Record<string, SnapReportMetrics> = {};
  for (const row of Array.isArray(rec.campaigns) ? rec.campaigns : []) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const key = str(r.utm_campaign).trim();
    if (!key) continue;
    byKey[key] = metricsOf(r);
  }
  return { date: str(rec.date) || date, affiliate: str(rec.affiliate), utmPrefix: str(rec.utm_prefix), totals, byKey };
}

// ---------- dates (São Paulo, LION's day) ----------

function saoPauloISO(offsetDays: number, now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now.getTime() - offsetDays * 86_400_000))
    .reduce<Record<string, string>>((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `today` / `yesterday` / `YYYY-MM-DD` / empty (= today) → the report day; null when malformed
 *  or later than today in São Paulo (LION has nothing for the future). */
export function snapReportDate(param: string | null | undefined, now: Date = new Date()): string | null {
  const p = String(param ?? "").trim().toLowerCase();
  const today = saoPauloISO(0, now);
  if (!p || p === "today") return today;
  if (p === "yesterday") return saoPauloISO(1, now);
  const m = ISO_RE.exec(p);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return p > today ? null : p;
}

/** Today (São Paulo) or later = still accumulating (+ the partner's forecast); earlier = final. */
export function isSnapReportPartial(date: string, now: Date = new Date()): boolean {
  return date >= saoPauloISO(0, now);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd adlauncher && node --test tests/snap-report.test.ts`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors.

---
### Task 4: The pump algorithm, deps-injected (`lib/snap-pump-core.ts`)

**Files:**
- Create: `lib/snap-pump-core.ts` (pure algorithm; only `import type` from `./snap-launch` — type imports are erased by Node's type stripping, so `node --test` still loads it)
- Test: `tests/snap-pump-core.test.ts`

**Interfaces:**
- Consumes (types only): `SnapLaunchShotIn`, `SnapLaunchWire`, `SnapResolved` from `lib/snap-launch.ts`.
- Produces:
  - `type SnapPumpShot = { taskId: string; shot: SnapLaunchShotIn; ctx: { adAccountId: string; pixelId?: string; profileId: string; currency: string; niche: string; geoLabel: string; tail: string; startPaused: boolean } }`
  - `type SnapPumpDeps = { claimKey(desired: string | undefined, meta: Record<string, unknown>): Promise<{ key: string; documentId: string }>; releaseKey(documentId: string): Promise<void>; backfillKey(key: string, patch: Record<string, unknown>): Promise<void>; fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string; size: number }>; createMedia(adAccountId: string, name: string, type: "VIDEO" | "IMAGE"): Promise<{ id: string }>; uploadMedia(mediaId: string, bytes: Uint8Array, filename: string, mime: string): Promise<void>; mediaReady(mediaId: string): Promise<boolean>; createCampaign(adAccountId: string, body: SnapLaunchWire["campaign"]): Promise<{ id: string }>; createAdSquad(campaignId: string, body: SnapLaunchWire["adsquad"] & { campaign_id: string }): Promise<{ id: string }>; createCreative(adAccountId: string, body: SnapLaunchWire["creative"]): Promise<{ id: string }>; createAd(adSquadId: string, body: SnapLaunchWire["ad"] & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }>; setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void>; buildWire(shot: SnapLaunchShotIn, resolved: SnapResolved): { wire: SnapLaunchWire; label: string } | { refusal: string }; buildName(args: { key: string; niche: string; geoLabel: string; tail: string }): string; write(taskId: string, fields: Record<string, unknown>): void; flush(): Promise<void>; sleep(ms: number): Promise<void>; now(): number; maxMediaBytes: number; mediaPollMs: number; mediaWaitMs: number }`
  - `SNAP_PUMP_BUDGET_MS = 770_000` · `SNAP_PUMP_STAGES = ["key","media","campaign","adsquad","creative","ad","activate","live","paused","failed"]`
  - `runSnapPump(user: string, shots: SnapPumpShot[], deadline: number, deps: SnapPumpDeps): Promise<void>`

**Algorithm (the spec's pump section):** shots run one at a time with a 1–3 s jitter between them (`deps.sleep`). Per shot: `key` (claim; exhausted → row `error`) → `media` (one upload per `${adAccountId}|${mediaUrl}` per wave; fetch bytes ≤ `maxMediaBytes`, create, upload, poll `mediaReady` every `mediaPollMs` up to `mediaWaitMs`; ANY failure → release key + row `error`) → build the real wire (name with the claimed key; a refusal here is a programming error → release + `error`) → `campaign` (4xx → release + `error`; ambiguous → `interrupted`, key retired "campaign may exist") → `adsquad` → `creative` → `ad` (4xx → row `error`, key retired with the ids so far, campaign stays PAUSED; ambiguous → `interrupted`, key retired) → `activate` unless `startPaused` (a failure here = row `done`, stage `paused`, error "activation failed: … — activate in Ads Manager") → `done` (backfill key with ids + `status:"active"`; row `{status:"done", stage: startPaused ? "paused" : "live", campaign_id, adset_id, ad_id, link, gcm, name, finished_at}`). Past the deadline (minus 20 s) a shot is failed with "time budget ran out — fire it again" without any Snap call. A refusal = an error object whose numeric `status` is 400–499; everything else is ambiguous.

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-pump-core.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-pump-core.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the after() pump algorithm with EVERY side effect injected: the stage order,
// media reuse across copies, the four dispositions (refusal before/after the campaign exists,
// ambiguous outcome, activation failure) and the time budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSnapPump, type SnapPumpDeps, type SnapPumpShot } from "../lib/snap-pump-core.ts";
import type { SnapLaunchShotIn } from "../lib/snap-launch.ts";

const shotIn = (over: Partial<SnapLaunchShotIn> = {}): SnapLaunchShotIn => ({
  adAccount: "acct-a",
  pixel: "px-1",
  optimizationGoal: "PIXEL_PURCHASE",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  headline: "Hello",
  brandName: "GC",
  cta: "MORE",
  mediaUrl: "https://blob/v.mp4",
  mediaKind: "video",
  mediaName: "v.mp4",
  geo: ["US"],
  minAge: "18",
  landingId: "cars",
  landingUrl: "",
  suffix: "",
  ...over,
});

const pumpShot = (taskId: string, over: Partial<SnapLaunchShotIn> = {}, startPaused = false): SnapPumpShot => ({
  taskId,
  shot: shotIn(over),
  ctx: { adAccountId: "acct-a", pixelId: "px-1", profileId: "prof-1", currency: "USD", niche: "Cars", geoLabel: "US", tail: "", startPaused },
});

type Call = [string, ...unknown[]];

/** A fake world: every dep records its call; failures are injected per step name. */
function world(fail: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const writes: Record<string, Record<string, unknown>[]> = {};
  let seq = 0;
  let keyN = 0;
  const throwIf = (step: string) => {
    const f = fail[step];
    if (f) throw f;
  };
  const deps: SnapPumpDeps = {
    claimKey: async (desired) => {
      calls.push(["claimKey", desired]);
      throwIf("claimKey");
      keyN += 1;
      return { key: `glo-snp_00${keyN}`, documentId: `doc-${keyN}` };
    },
    releaseKey: async (documentId) => {
      calls.push(["releaseKey", documentId]);
    },
    backfillKey: async (key, patch) => {
      calls.push(["backfillKey", key, patch]);
    },
    fetchBytes: async (url) => {
      calls.push(["fetchBytes", url]);
      throwIf("fetchBytes");
      return { bytes: new Uint8Array([1, 2, 3]), mime: "video/mp4", size: 3 };
    },
    createMedia: async (acct, name, type) => {
      calls.push(["createMedia", acct, name, type]);
      throwIf("createMedia");
      return { id: `media-${++seq}` };
    },
    uploadMedia: async (id) => {
      calls.push(["uploadMedia", id]);
      throwIf("uploadMedia");
    },
    mediaReady: async (id) => {
      calls.push(["mediaReady", id]);
      return true;
    },
    createCampaign: async (acct, body) => {
      calls.push(["createCampaign", acct, body]);
      throwIf("createCampaign");
      return { id: `cmp-${++seq}` };
    },
    createAdSquad: async (cmp, body) => {
      calls.push(["createAdSquad", cmp, body]);
      throwIf("createAdSquad");
      return { id: `sq-${++seq}` };
    },
    createCreative: async (acct, body) => {
      calls.push(["createCreative", acct, body]);
      throwIf("createCreative");
      return { id: `cr-${++seq}` };
    },
    createAd: async (sq, body) => {
      calls.push(["createAd", sq, body]);
      throwIf("createAd");
      return { id: `ad-${++seq}` };
    },
    setCampaignStatus: async (cmp, status) => {
      calls.push(["setCampaignStatus", cmp, status]);
      throwIf("setCampaignStatus");
    },
    buildWire: (shot, resolved) => ({
      wire: {
        campaign: { name: resolved.name, ad_account_id: resolved.adAccountId, status: "PAUSED", start_time: resolved.startTimeIso },
        adsquad: {
          name: resolved.name,
          type: "SNAP_ADS",
          billing_event: "IMPRESSION",
          delivery_constraint: "DAILY_BUDGET",
          daily_budget_micro: 10_000_000,
          bid_strategy: shot.bidStrategy,
          optimization_goal: shot.optimizationGoal,
          placement_v2: { config: "AUTOMATIC" },
          targeting: { geos: [{ country_code: "us" }], demographics: [{ min_age: "18" }] },
          status: "ACTIVE",
          start_time: resolved.startTimeIso,
        },
        creative: {
          ad_account_id: resolved.adAccountId,
          name: resolved.name,
          type: "WEB_VIEW",
          ad_product: "SNAP_AD",
          headline: shot.headline,
          brand_name: shot.brandName,
          call_to_action: shot.cta,
          top_snap_media_id: resolved.mediaId,
          shareable: true,
          web_view_properties: { url: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`, block_preload: false, allow_snap_javascript_sdk: false, use_immersive_mode: false },
          profile_properties: { profile_id: resolved.profileId },
        },
        ad: { name: resolved.name, type: "REMOTE_WEBPAGE", status: "ACTIVE" },
        landingUrl: `https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=${resolved.key}`,
      },
      label: "auto",
    }),
    buildName: ({ key, niche, geoLabel }) => `[16.09] (SNP) ${niche} - ${geoLabel} - ${key} - nazar - GC-Launcher`,
    write: (taskId, fields) => {
      (writes[taskId] ??= []).push(fields);
    },
    flush: async () => {},
    sleep: async () => {},
    now: () => 1_000_000,
    maxMediaBytes: 32 * 1024 * 1024,
    mediaPollMs: 1,
    mediaWaitMs: 10,
  };
  const last = (taskId: string) => Object.assign({}, ...(writes[taskId] ?? []));
  const stages = (taskId: string) => (writes[taskId] ?? []).map((w) => w.stage).filter(Boolean);
  return { deps, calls, writes, last, stages };
}

const refusal = (msg: string) => Object.assign(new Error(msg), { status: 400 });

test("happy path: two copies share ONE media upload, each gets its own key, chain in order, activated at the end", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1"), pumpShot("t2")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.stages("t1"), ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live"]);
  assert.deepEqual(w.stages("t2"), ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live"]);
  assert.equal(w.calls.filter((c) => c[0] === "createMedia").length, 1, "media created once per (account, url)");
  assert.equal(w.calls.filter((c) => c[0] === "uploadMedia").length, 1);
  const t1 = w.last("t1");
  const t2 = w.last("t2");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "live");
  assert.equal(t1.gcm, "glo-snp_001");
  assert.equal(t2.gcm, "glo-snp_002");
  assert.equal(t1.campaign_id, "cmp-2");
  assert.equal(t1.adset_id, "sq-3");
  assert.equal(t1.ad_id, "ad-5");
  assert.equal(t1.link, "https://azmvhs.com/v/x/?utm_source=stone&utm_campaign=glo-snp_001");
  assert.match(String(t1.name), /glo-snp_001 - nazar - GC-Launcher/);
  assert.equal(typeof t1.finished_at, "number");
  const activations = w.calls.filter((c) => c[0] === "setCampaignStatus");
  assert.deepEqual(activations, [["setCampaignStatus", "cmp-2", "ACTIVE"], ["setCampaignStatus", "cmp-6", "ACTIVE"]]);
  const backfills = w.calls.filter((c) => c[0] === "backfillKey");
  assert.equal(backfills.length, 2);
  assert.deepEqual(backfills[0][2], { status: "active", campaign_id: "cmp-2", adsquad_id: "sq-3", ad_id: "ad-5", name: t1.name });
  // the creative carried the claimed key and the real media id
  const creative = w.calls.find((c) => c[0] === "createCreative");
  assert.match(JSON.stringify(creative), /glo-snp_001/);
  assert.match(JSON.stringify(creative), /media-1/);
});

test("start paused: the chain is built, nothing is activated, row done at stage paused", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1", {}, true)], 1_000_000 + 700_000, w.deps);
  assert.equal(w.calls.some((c) => c[0] === "setCampaignStatus"), false);
  assert.equal(w.last("t1").status, "done");
  assert.equal(w.last("t1").stage, "paused");
});

test("key pool exhausted: row error at stage key, nothing else touched", async () => {
  const w = world({ claimKey: new Error("snap key pool exhausted — no free key glo-snp_001…100") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "key");
  assert.match(String(t1.error), /pool exhausted/);
  assert.equal(w.calls.some((c) => c[0] === "createMedia"), false);
});

test("media failure: the key goes back to the pool, row error at stage media", async () => {
  const w = world({ uploadMedia: refusal("media too large") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  assert.equal(w.last("t1").status, "error");
  assert.equal(w.last("t1").stage, "media");
  assert.equal(w.calls.some((c) => c[0] === "createCampaign"), false);
});

test("creative over the size cap is refused before any Snap call on that shot", async () => {
  const w = world();
  w.deps.fetchBytes = async () => ({ bytes: new Uint8Array(0), mime: "video/mp4", size: 40 * 1024 * 1024 });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.match(String(w.last("t1").error), /32 MB/);
  assert.equal(w.calls.some((c) => c[0] === "createMedia"), false);
});

test("4xx at the campaign: key released, row error with Snap's sentence", async () => {
  const w = world({ createCampaign: refusal("start_time must be in the future") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "campaign");
  assert.match(String(t1.error), /start_time must be in the future/);
});

test("4xx at the ad squad: campaign exists (PAUSED shell) → key RETIRED with the campaign id, row error", async () => {
  const w = world({ createAdSquad: refusal("daily_budget_micro below the minimum") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.equal(w.calls.some((c) => c[0] === "releaseKey"), false);
  const bf = w.calls.find((c) => c[0] === "backfillKey");
  assert.ok(bf);
  assert.equal(bf![1], "glo-snp_001");
  assert.equal((bf![2] as Record<string, unknown>).status, "retired");
  assert.equal((bf![2] as Record<string, unknown>).campaign_id, "cmp-2");
  const t1 = w.last("t1");
  assert.equal(t1.status, "error");
  assert.equal(t1.stage, "adsquad");
  assert.equal(t1.campaign_id, "cmp-2");
  assert.match(String(t1.error), /daily_budget_micro/);
  assert.equal(w.calls.some((c) => c[0] === "setCampaignStatus"), false, "never activated");
});

test("network cut at the creative: interrupted, key retired, never re-sent", async () => {
  const w = world({ createCreative: new Error("fetch failed") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "interrupted");
  assert.equal(t1.stage, "creative");
  assert.match(String(t1.error), /Ambiguous outcome/);
  assert.equal(w.calls.filter((c) => c[0] === "createCreative").length, 1);
  const bf = w.calls.find((c) => c[0] === "backfillKey");
  assert.equal((bf![2] as Record<string, unknown>).status, "retired");
});

test("activation failure is not a failed launch: done at stage paused with the reason", async () => {
  const w = world({ setCampaignStatus: refusal("policy review pending") });
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  const t1 = w.last("t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.stage, "paused");
  assert.match(String(t1.error), /activation failed.*policy review pending.*Ads Manager/);
  assert.equal((w.calls.find((c) => c[0] === "backfillKey")![2] as Record<string, unknown>).status, "active");
});

test("time budget: a shot past the deadline is failed without a single Snap call", async () => {
  const w = world();
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 10_000, w.deps);
  assert.equal(w.last("t1").status, "error");
  assert.match(String(w.last("t1").error), /time budget/);
  assert.equal(w.calls.length, 0);
});

test("media never READY within the wait: key released, row error", async () => {
  const w = world();
  w.deps.mediaReady = async () => false;
  await runSnapPump("nazar", [pumpShot("t1")], 1_000_000 + 700_000, w.deps);
  assert.equal(w.last("t1").status, "error");
  assert.match(String(w.last("t1").error), /not ready/);
  assert.deepEqual(w.calls.filter((c) => c[0] === "releaseKey"), [["releaseKey", "doc-1"]]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-pump-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `lib/snap-pump-core.ts`:

```ts
// Snapchat rail — the after() wave pump ALGORITHM with every side effect injected (lib/snap-pump.ts
// binds the real Snapchat client, the key registry and the task-store writer). Kept pure so
// `node --test tests/snap-pump-core.test.ts` proves the dispositions without a network:
//   key → media → campaign (PAUSED) → adsquad → creative → ad → activate → done
// A refusal (HTTP 4xx) before the campaign exists releases the key (pool capacity, not history);
// after it exists the key is RETIRED with the ids so far and the campaign stays a PAUSED shell
// (nothing delivers). An ambiguous outcome (5xx / network) is reported as "interrupted" and NEVER
// re-sent — a second attempt could build a second campaign. Activation failure is not a failed
// launch: the whole chain exists, the buyer flips it in Ads Manager.

import type { SnapLaunchShotIn, SnapLaunchWire, SnapResolved } from "./snap-launch";

export const SNAP_PUMP_BUDGET_MS = 770_000;
const DEADLINE_MARGIN_MS = 20_000;

export const SNAP_PUMP_STAGES = ["key", "media", "campaign", "adsquad", "creative", "ad", "activate", "live", "paused", "failed"] as const;
export type SnapPumpStage = (typeof SNAP_PUMP_STAGES)[number];

export type SnapPumpShot = {
  taskId: string;
  shot: SnapLaunchShotIn;
  /** What the route resolved and validated once for the whole shot. */
  ctx: { adAccountId: string; pixelId?: string; profileId: string; currency: string; niche: string; geoLabel: string; tail: string; startPaused: boolean };
};

export type SnapPumpDeps = {
  claimKey(desired: string | undefined, meta: Record<string, unknown>): Promise<{ key: string; documentId: string }>;
  releaseKey(documentId: string): Promise<void>;
  backfillKey(key: string, patch: Record<string, unknown>): Promise<void>;
  fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string; size: number }>;
  createMedia(adAccountId: string, name: string, type: "VIDEO" | "IMAGE"): Promise<{ id: string }>;
  uploadMedia(mediaId: string, bytes: Uint8Array, filename: string, mime: string): Promise<void>;
  mediaReady(mediaId: string): Promise<boolean>;
  createCampaign(adAccountId: string, body: SnapLaunchWire["campaign"]): Promise<{ id: string }>;
  createAdSquad(campaignId: string, body: SnapLaunchWire["adsquad"] & { campaign_id: string }): Promise<{ id: string }>;
  createCreative(adAccountId: string, body: SnapLaunchWire["creative"]): Promise<{ id: string }>;
  createAd(adSquadId: string, body: SnapLaunchWire["ad"] & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }>;
  setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  buildWire(shot: SnapLaunchShotIn, resolved: SnapResolved): { wire: SnapLaunchWire; label: string } | { refusal: string };
  buildName(args: { key: string; niche: string; geoLabel: string; tail: string }): string;
  write(taskId: string, fields: Record<string, unknown>): void;
  flush(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  maxMediaBytes: number;
  mediaPollMs: number;
  mediaWaitMs: number;
};

/** HTTP 4xx = a deterministic refusal (Snap's sentence); anything else is ambiguous. */
const isRefusal = (e: unknown): boolean => {
  const st = (e as { status?: unknown } | null)?.status;
  return typeof st === "number" && st >= 400 && st < 500;
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const jitter = () => 1000 + Math.floor(Math.random() * 2000);

export async function runSnapPump(user: string, shots: SnapPumpShot[], deadline: number, deps: SnapPumpDeps): Promise<void> {
  // One upload per (ad account, creative URL) per wave: copies of a card reuse the media id.
  const mediaByKey = new Map<string, string>();

  const ensureMedia = async (s: SnapPumpShot): Promise<string> => {
    const cacheKey = `${s.ctx.adAccountId}|${s.shot.mediaUrl}`;
    const hit = mediaByKey.get(cacheKey);
    if (hit) return hit;
    const file = await deps.fetchBytes(s.shot.mediaUrl);
    if (file.size > deps.maxMediaBytes) {
      throw Object.assign(new Error(`creative is ${Math.round(file.size / 1024 / 1024)} MB — Snapchat single upload takes at most 32 MB; trim the file`), { status: 400 });
    }
    const type = s.shot.mediaKind === "image" ? "IMAGE" : "VIDEO";
    const filename = s.shot.mediaName || (type === "IMAGE" ? "creative.jpg" : "creative.mp4");
    const { id } = await deps.createMedia(s.ctx.adAccountId, filename, type);
    await deps.uploadMedia(id, file.bytes, filename, file.mime);
    // Bounded by BOTH the wall clock and an attempt count (a frozen test clock must still end).
    const until = deps.now() + deps.mediaWaitMs;
    const attempts = Math.max(1, Math.ceil(deps.mediaWaitMs / deps.mediaPollMs));
    let ready = await deps.mediaReady(id);
    for (let i = 1; !ready && i < attempts && deps.now() < until; i++) {
      await deps.sleep(deps.mediaPollMs);
      ready = await deps.mediaReady(id);
    }
    if (!ready) throw Object.assign(new Error(`Snap media ${id} not ready after ${Math.round(deps.mediaWaitMs / 1000)} s — fire again`), { status: 400 });
    mediaByKey.set(cacheKey, id);
    return id;
  };

  let first = true;
  for (const s of shots) {
    if (deps.now() > deadline - DEADLINE_MARGIN_MS) {
      deps.write(s.taskId, { status: "error", stage: "failed", error: "Not built — the wave's time budget ran out before this copy; fire it again", finished_at: deps.now() });
      continue;
    }
    if (!first) await deps.sleep(jitter());
    first = false;

    // ---- key ----
    deps.write(s.taskId, { stage: "key", started_at: deps.now() });
    let claimed: { key: string; documentId: string };
    try {
      claimed = await deps.claimKey(s.shot.desiredKey, {
        user,
        ad_account: s.ctx.adAccountId,
        niche: s.ctx.niche,
        landing: s.shot.landingId === "custom" ? s.shot.landingUrl : s.shot.landingId,
        task_id: s.taskId,
      });
    } catch (e) {
      deps.write(s.taskId, { status: "error", stage: "key", error: messageOf(e).slice(0, 1000), finished_at: deps.now() });
      continue;
    }
    const key = claimed.key;
    const name = deps.buildName({ key, niche: s.ctx.niche, geoLabel: s.ctx.geoLabel, tail: s.ctx.tail });
    deps.write(s.taskId, { gcm: key, name: name.slice(0, 250) });

    // ---- media (nothing with money exists yet: any failure hands the key back) ----
    deps.write(s.taskId, { stage: "media" });
    let mediaId: string;
    try {
      mediaId = await ensureMedia(s);
    } catch (e) {
      await deps.releaseKey(claimed.documentId);
      deps.write(s.taskId, { status: "error", stage: "media", gcm: "", error: messageOf(e).slice(0, 1000), finished_at: deps.now() });
      continue;
    }

    // ---- the real wire (claimed key + real media id) ----
    const built = deps.buildWire(s.shot, {
      adAccountId: s.ctx.adAccountId,
      pixelId: s.ctx.pixelId,
      profileId: s.ctx.profileId,
      name,
      key,
      mediaId,
      startTimeIso: new Date(deps.now()).toISOString(),
    });
    if ("refusal" in built) {
      await deps.releaseKey(claimed.documentId);
      deps.write(s.taskId, { status: "error", stage: "failed", gcm: "", error: built.refusal.slice(0, 1000), finished_at: deps.now() });
      continue;
    }
    const wire = built.wire;

    // ---- campaign (born PAUSED — a partial chain can never spend) ----
    deps.write(s.taskId, { stage: "campaign", link: wire.landingUrl });
    let campaignId = "";
    try {
      campaignId = (await deps.createCampaign(s.ctx.adAccountId, wire.campaign)).id;
    } catch (e) {
      if (isRefusal(e)) {
        await deps.releaseKey(claimed.documentId);
        deps.write(s.taskId, { status: "error", stage: "campaign", gcm: "", error: messageOf(e).slice(0, 1000), finished_at: deps.now() });
      } else {
        await deps.backfillKey(key, { status: "retired", notes: `ambiguous campaign create: ${messageOf(e).slice(0, 200)}` });
        deps.write(s.taskId, { status: "interrupted", stage: "campaign", error: `Ambiguous outcome (${messageOf(e)}) — the campaign may exist on Snapchat; check Ads Manager before re-firing`.slice(0, 1000), finished_at: deps.now() });
      }
      continue;
    }
    deps.write(s.taskId, { campaign_id: campaignId });

    // ---- adsquad → creative → ad (the campaign exists: a failure retires the key, shell stays PAUSED) ----
    const ids: { adsquad_id?: string; ad_id?: string } = {};
    const failAfterCampaign = async (stage: SnapPumpStage, e: unknown) => {
      const ambiguous = !isRefusal(e);
      await deps.backfillKey(key, { status: "retired", campaign_id: campaignId, ...ids, notes: `${ambiguous ? "ambiguous" : "refused"} at ${stage}: ${messageOf(e).slice(0, 200)}` });
      deps.write(s.taskId, {
        status: ambiguous ? "interrupted" : "error",
        stage,
        error: (ambiguous ? `Ambiguous outcome (${messageOf(e)}) — the ${stage} may exist on Snapchat; the campaign is PAUSED, check Ads Manager` : messageOf(e)).slice(0, 1000),
        finished_at: deps.now(),
      });
    };
    let adSquadId = "";
    let creativeId = "";
    let adId = "";
    try {
      deps.write(s.taskId, { stage: "adsquad" });
      adSquadId = (await deps.createAdSquad(campaignId, { ...wire.adsquad, campaign_id: campaignId })).id;
      ids.adsquad_id = adSquadId;
      deps.write(s.taskId, { adset_id: adSquadId });
    } catch (e) {
      await failAfterCampaign("adsquad", e);
      continue;
    }
    try {
      deps.write(s.taskId, { stage: "creative" });
      creativeId = (await deps.createCreative(s.ctx.adAccountId, wire.creative)).id;
    } catch (e) {
      await failAfterCampaign("creative", e);
      continue;
    }
    try {
      deps.write(s.taskId, { stage: "ad" });
      adId = (await deps.createAd(adSquadId, { ...wire.ad, ad_squad_id: adSquadId, creative_id: creativeId })).id;
      ids.ad_id = adId;
      deps.write(s.taskId, { ad_id: adId });
    } catch (e) {
      await failAfterCampaign("ad", e);
      continue;
    }

    // ---- activate (unless the buyer wants to review first) ----
    let activationError = "";
    if (!s.ctx.startPaused) {
      deps.write(s.taskId, { stage: "activate" });
      try {
        await deps.setCampaignStatus(campaignId, "ACTIVE");
      } catch (e) {
        activationError = `activation failed: ${messageOf(e).slice(0, 300)} — activate in Ads Manager`;
      }
    }

    // ---- done ----
    await deps.backfillKey(key, { status: "active", campaign_id: campaignId, adsquad_id: adSquadId, ad_id: adId, name });
    const live = !s.ctx.startPaused && !activationError;
    deps.write(s.taskId, {
      status: "done",
      stage: live ? "live" : "paused",
      campaign_id: campaignId,
      adset_id: adSquadId,
      ad_id: adId,
      link: wire.landingUrl,
      gcm: key,
      name: name.slice(0, 250),
      error: activationError,
      finished_at: deps.now(),
    });
  }

  await deps.flush();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd adlauncher && node --test tests/snap-pump-core.test.ts`
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 5: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors (the type-only import resolves under the bundler resolution).

---
### Task 5: Snapchat Marketing API client (`lib/snap-api.ts`)

**Files:**
- Create: `lib/snap-api.ts` (server-only; NO runtime imports — type-only imports from `./snap-launch` — so the pure helpers are testable under `node --test` with a stubbed `fetch`)
- Test: `tests/snap-api.test.ts`

**Interfaces:**
- Consumes (types only): `SnapCampaignWire`, `SnapAdSquadWire`, `SnapCreativeWire`, `SnapAdWire` from `lib/snap-launch.ts`.
- Produces:
  - `class SnapApiError extends Error { status?: number; detail?: unknown }`
  - `snapRailEnabled(): boolean` · `snapConfigured(): boolean` · `snapDefaults(): { adAccount: string; pixel: string; profile: string; brandName: string; organization: string }`
  - `snapErrorMessage(status: number | undefined, body: unknown): string` · `snapBatchItem(body: unknown, key: string): Record<string, unknown>` (throws `SnapApiError` on `request_status`/`sub_request_status` ≠ SUCCESS)
  - `snapAccessToken(): Promise<string>` · `_resetSnapTokenCache(): void` (tests)
  - `type SnapAdAccount = { id: string; name: string; currency: string; timezone: string; status: string; organizationId: string }` · `type SnapPixel = { id: string; name: string; status: string }` · `type SnapProfile = { id: string; displayName: string; profileType: string }`
  - `snapAdAccounts(): Promise<SnapAdAccount[]>` · `snapPixels(adAccountId: string): Promise<SnapPixel[]>` · `snapProfiles(organizationId: string): Promise<SnapProfile[]>`
  - `snapCreateMedia(adAccountId, name, type: "VIDEO"|"IMAGE"): Promise<{ id: string }>` · `snapUploadMedia(mediaId, bytes: Uint8Array, filename, mime): Promise<void>` · `snapMediaReady(mediaId): Promise<boolean>`
  - `snapCreateCampaign(adAccountId, body: SnapCampaignWire): Promise<{ id: string }>` · `snapCreateAdSquad(campaignId, body: SnapAdSquadWire & { campaign_id: string }): Promise<{ id: string }>` · `snapCreateCreative(adAccountId, body: SnapCreativeWire): Promise<{ id: string }>` · `snapCreateAd(adSquadId, body: SnapAdWire & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }>` · `snapSetCampaignStatus(campaignId, status: "ACTIVE"|"PAUSED"): Promise<void>`
  - `snapAuthorizeUrl(state: string, redirectUri: string): string` · `snapExchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }>`
  - `snapFetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string; size: number }>` (public Blob URL → bytes, refuses over `maxBytes` by `content-length` or after reading)

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-api.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-api.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the client's PURE parts: Snap's error sentence, the batch envelope, the
// refresh-token grant + its cache, exactly-once writes, and the batch-create parsing — all with a
// stubbed globalThis.fetch (the real partner is never touched by a unit test).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SNAP_CLIENT_ID = "cid";
process.env.SNAP_CLIENT_SECRET = "csec";
process.env.SNAP_REFRESH_TOKEN = "rt-1";
process.env.SNAP_API_BASE = "https://ads.test/v1";
process.env.SNAP_AUTH_BASE = "https://auth.test";
process.env.SNAP_BUSINESS_API_BASE = "https://biz.test/v1";
process.env.NEXT_PUBLIC_SNAP_ENABLED = "1";

const api = await import("../lib/snap-api.ts");

type Rec = { url: string; method: string; headers: Record<string, string>; body: string | null };
function stubFetch(routes: Array<[RegExp, (r: Rec) => Response | Promise<Response>]>) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : init?.body ? "<binary>" : null;
    const rec = { url, method: init?.method ?? "GET", headers, body };
    calls.push(rec);
    for (const [re, h] of routes) if (re.test(url)) return h(rec);
    return new Response(JSON.stringify({ request_status: "ERROR", debug_message: `no stub for ${url}` }), { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const tokenRoute: [RegExp, (r: Rec) => Response] = [/auth\.test\/login\/oauth2\/access_token/, () => json({ access_token: "at-1", expires_in: 3600, token_type: "Bearer" })];

test("snapErrorMessage prefers display_message, then debug_message, then a status fallback", () => {
  assert.equal(api.snapErrorMessage(400, { request_status: "ERROR", display_message: "Budget too low", debug_message: "daily_budget_micro < 5000000" }), "Budget too low (daily_budget_micro < 5000000)");
  assert.equal(api.snapErrorMessage(400, { debug_message: "x" }), "x");
  assert.equal(api.snapErrorMessage(401, "Unauthorized"), "Unauthorized");
  assert.equal(api.snapErrorMessage(503, null), "Snapchat HTTP 503");
  assert.equal(api.snapErrorMessage(undefined, null), "Snapchat unreachable");
});

test("snapBatchItem unwraps {campaigns:[{sub_request_status, campaign}]} and throws on item errors", () => {
  assert.deepEqual(api.snapBatchItem({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "c1" } }] }, "campaigns"), { id: "c1" });
  assert.throws(() => api.snapBatchItem({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "ERROR", debug_message: "name too long" }] }, "campaigns"), (e: Error) => /name too long/.test(e.message) && (e as api.SnapApiError).status === 400);
  assert.throws(() => api.snapBatchItem({ request_status: "ERROR", display_message: "nope" }, "campaigns"), /nope/);
  assert.throws(() => api.snapBatchItem({ request_status: "SUCCESS", campaigns: [] }, "campaigns"), /empty/);
});

test("refresh grant is a form POST, cached until expiry, and rejected refresh → SnapApiError 401", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([tokenRoute]);
  try {
    assert.equal(await api.snapAccessToken(), "at-1");
    assert.equal(await api.snapAccessToken(), "at-1");
    assert.equal(stub.calls.length, 1, "second call served from the cache");
    const c = stub.calls[0];
    assert.equal(c.method, "POST");
    assert.match(c.body ?? "", /grant_type=refresh_token/);
    assert.match(c.body ?? "", /client_id=cid/);
    assert.match(c.body ?? "", /refresh_token=rt-1/);
  } finally {
    stub.restore();
  }
  api._resetSnapTokenCache();
  const bad = stubFetch([[/access_token/, () => json({ error: "invalid_grant" }, 400)]]);
  try {
    await assert.rejects(api.snapAccessToken(), (e: api.SnapApiError) => e.status === 401 && /refresh token rejected/.test(e.message));
  } finally {
    bad.restore();
  }
});

test("ad accounts come from /me/organizations?with_ad_accounts=true, flattened and sorted", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [
      /ads\.test\/v1\/me\/organizations\?with_ad_accounts=true/,
      () =>
        json({
          request_status: "SUCCESS",
          organizations: [
            {
              sub_request_status: "SUCCESS",
              organization: {
                id: "org-1",
                name: "GlobeCoders",
                ad_accounts: [
                  { id: "acct-b", name: "Snap USD 2", currency: "USD", timezone: "UTC", status: "ACTIVE" },
                  { id: "acct-a", name: "Snap USD 1", currency: "usd", timezone: "America/Sao_Paulo", status: "ACTIVE" },
                ],
              },
            },
          ],
        }),
    ],
  ]);
  try {
    const accounts = await api.snapAdAccounts();
    assert.deepEqual(accounts, [
      { id: "acct-a", name: "Snap USD 1", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organizationId: "org-1" },
      { id: "acct-b", name: "Snap USD 2", currency: "USD", timezone: "UTC", status: "ACTIVE", organizationId: "org-1" },
    ]);
    assert.equal(stub.calls.find((c) => /organizations/.test(c.url))?.headers.authorization, "Bearer at-1");
  } finally {
    stub.restore();
  }
});

test("creates are ONE attempt: a 500 is thrown as-is (never retried), a 4xx carries Snap's sentence", async () => {
  api._resetSnapTokenCache();
  let hits = 0;
  const stub = stubFetch([
    tokenRoute,
    [
      /adaccounts\/acct-a\/campaigns/,
      () => {
        hits += 1;
        return json({ request_status: "ERROR", debug_message: "internal" }, 500);
      },
    ],
  ]);
  try {
    await assert.rejects(
      api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }),
      (e: api.SnapApiError) => e.status === 500,
    );
    assert.equal(hits, 1, "no retry on a create");
  } finally {
    stub.restore();
  }
  const refuse = stubFetch([tokenRoute, [/adaccounts\/acct-a\/campaigns/, () => json({ request_status: "ERROR", display_message: "Name too long" }, 400)]]);
  try {
    await assert.rejects(
      api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }),
      (e: api.SnapApiError) => e.status === 400 && /Name too long/.test(e.message),
    );
  } finally {
    refuse.restore();
  }
});

test("a successful create returns the new id from the batch envelope; the body rides as {campaigns:[…]}", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [/adaccounts\/acct-a\/campaigns/, (r) => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { ...JSON.parse(r.body ?? "{}").campaigns[0], id: "cmp-1" } }] })],
  ]);
  try {
    const r = await api.snapCreateCampaign("acct-a", { name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" });
    assert.deepEqual(r, { id: "cmp-1" });
    const call = stub.calls.find((c) => /campaigns/.test(c.url))!;
    assert.deepEqual(JSON.parse(call.body ?? "{}"), { campaigns: [{ name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z" }] });
    assert.equal(call.headers["content-type"], "application/json");
  } finally {
    stub.restore();
  }
});

test("status flip: GET the campaign, PUT the whitelisted object with the new status", async () => {
  api._resetSnapTokenCache();
  const stub = stubFetch([
    tokenRoute,
    [/\/v1\/campaigns\/cmp-1$/, () => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: { id: "cmp-1", name: "n", ad_account_id: "acct-a", status: "PAUSED", start_time: "2026-09-16T00:00:00.000Z", buy_model: "AUCTION", created_at: "x", updated_at: "y", delivery_status: ["z"] } }] })],
    [/adaccounts\/acct-a\/campaigns$/, (r) => json({ request_status: "SUCCESS", campaigns: [{ sub_request_status: "SUCCESS", campaign: JSON.parse(r.body ?? "{}").campaigns[0] }] })],
  ]);
  try {
    await api.snapSetCampaignStatus("cmp-1", "ACTIVE");
    const put = stub.calls.find((c) => c.method === "PUT")!;
    assert.deepEqual(JSON.parse(put.body ?? "{}"), { campaigns: [{ id: "cmp-1", name: "n", ad_account_id: "acct-a", status: "ACTIVE", start_time: "2026-09-16T00:00:00.000Z", buy_model: "AUCTION" }] });
  } finally {
    stub.restore();
  }
});

test("snapFetchBytes refuses a file over the cap by content-length before downloading it", async () => {
  const stub = stubFetch([[/blob\.test/, () => new Response(new Uint8Array(10), { status: 200, headers: { "content-length": String(40 * 1024 * 1024), "content-type": "video/mp4" } })]]);
  try {
    await assert.rejects(api.snapFetchBytes("https://blob.test/v.mp4", 32 * 1024 * 1024), /32 MB/);
  } finally {
    stub.restore();
  }
  const ok = stubFetch([[/blob\.test/, () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } })]]);
  try {
    const f = await api.snapFetchBytes("https://blob.test/v.mp4", 32 * 1024 * 1024);
    assert.equal(f.size, 3);
    assert.equal(f.mime, "video/mp4");
  } finally {
    ok.restore();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the client**

Create `lib/snap-api.ts`:

```ts
// Snapchat rail — server-only client for the Snapchat Marketing API (our OWN ad account; no
// partner rail). One place holds the hosts, the OAuth refresh, the retry policy and the read
// caches — routes and the pump stay thin. Contract: docs/superpowers/specs/2026-09-16-snapchat-rail-design.md.
// No runtime imports on purpose (type-only from ./snap-launch) so `node --test` can load it with a
// stubbed fetch.
//
// Hosts (docs read 16.09.2026): ads API https://adsapi.snapchat.com/v1 · OAuth
// https://accounts.snapchat.com/login/oauth2/{authorize,access_token} · Public Profiles
// https://businessapi.snapchat.com/v1. Every write is a batch envelope ({campaigns:[…]} →
// {request_status, campaigns:[{sub_request_status, campaign}]}); errors are 4xx/5xx with
// request_status:"ERROR" + display_message/debug_message.

import type { SnapAdSquadWire, SnapAdWire, SnapCampaignWire, SnapCreativeWire } from "./snap-launch";

const API_BASE = (process.env.SNAP_API_BASE || "https://adsapi.snapchat.com/v1").replace(/\/+$/, "");
const AUTH_BASE = (process.env.SNAP_AUTH_BASE || "https://accounts.snapchat.com").replace(/\/+$/, "");
const BUSINESS_BASE = (process.env.SNAP_BUSINESS_API_BASE || "https://businessapi.snapchat.com/v1").replace(/\/+$/, "");
const CLIENT_ID = process.env.SNAP_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SNAP_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.SNAP_REFRESH_TOKEN || "";
const OAUTH_SCOPE = "snapchat-marketing-api";
const TIMEOUT_MS = 60_000;

export class SnapApiError extends Error {
  status?: number;
  detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "SnapApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The rail's dormancy switch read SERVER-side too (the NEXT_PUBLIC flag only hides the tab). */
export const snapRailEnabled = (): boolean => process.env.NEXT_PUBLIC_SNAP_ENABLED === "1";
export const snapConfigured = (): boolean => Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
/** Board defaults from env (all optional; the catalog route hands them to the pickers). */
export const snapDefaults = () => ({
  adAccount: process.env.SNAP_AD_ACCOUNT_ID || "",
  pixel: process.env.SNAP_PIXEL_ID || "",
  profile: process.env.SNAP_PROFILE_ID || "",
  brandName: process.env.SNAP_BRAND_NAME || "",
  organization: process.env.SNAP_ORGANIZATION_ID || "",
});

const str = (v: unknown): string => (v == null ? "" : String(v));
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Snap's sentence for a failed call: display_message (+ debug_message in parentheses when it
 *  adds something), else debug_message / error, else a plain-text body, else the status. */
export function snapErrorMessage(status: number | undefined, body: unknown): string {
  const r = rec(body);
  const display = str(r.display_message).trim();
  const debug = str(r.debug_message).trim();
  let msg = display && debug && display !== debug ? `${display} (${debug})` : display || debug || str(r.error).trim();
  if (!msg && typeof body === "string" && body) msg = body.slice(0, 300);
  if (!msg) msg = status ? `Snapchat HTTP ${status}` : "Snapchat unreachable";
  return msg;
}

/** Unwrap ONE entity from a batch envelope; item-level errors throw with Snap's sentence (400). */
export function snapBatchItem(body: unknown, key: string): Record<string, unknown> {
  const r = rec(body);
  if (str(r.request_status).toUpperCase() === "ERROR") throw new SnapApiError(snapErrorMessage(400, r), 400, body);
  const items = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];
  if (items.length === 0) throw new SnapApiError(`Snapchat answered an empty ${key} batch`, 502, body);
  const item = rec(items[0]);
  if (str(item.sub_request_status).toUpperCase() !== "SUCCESS") throw new SnapApiError(snapErrorMessage(400, item), 400, body);
  const singular = key.endsWith("s") ? key.slice(0, -1) : key;
  const entity = rec(item[singular] ?? item[key.replace(/s$/, "")]);
  return entity;
}

// ---------- OAuth ----------

let tokenCache: { token: string; expiresAt: number } | null = null;
let tokenInflight: Promise<string> | null = null;
export function _resetSnapTokenCache(): void {
  tokenCache = null;
  tokenInflight = null;
}

/** Refresh-token grant, cached per instance until 60 s before expiry; in-flight calls dedupe. */
export async function snapAccessToken(): Promise<string> {
  if (!snapConfigured()) throw new SnapApiError("Snapchat is not configured (SNAP_CLIENT_ID / SNAP_CLIENT_SECRET / SNAP_REFRESH_TOKEN)", 500);
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    try {
      const res = await fetch(`${AUTH_BASE}/login/oauth2/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.json().catch(() => ({}));
      const token = str(rec(body).access_token);
      if (!res.ok || !token) throw new SnapApiError(`Snapchat refresh token rejected (${snapErrorMessage(res.status, body)})`, 401, body);
      const ttl = Number(rec(body).expires_in) || 3600;
      tokenCache = { token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
      return token;
    } finally {
      tokenInflight = null;
    }
  })();
  return tokenInflight;
}

/** The consent URL for the owner-only OAuth helper (scope snapchat-marketing-api). */
export function snapAuthorizeUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: OAUTH_SCOPE, state });
  return `${AUTH_BASE}/login/oauth2/authorize?${q.toString()}`;
}

/** Authorization-code grant — used ONCE by the helper to mint the refresh token the owner pastes into env. */
export async function snapExchangeCode(code: string, redirectUri: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const res = await fetch(`${AUTH_BASE}/login/oauth2/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  const r = rec(body);
  if (!res.ok || !str(r.refresh_token)) throw new SnapApiError(`code exchange failed (${snapErrorMessage(res.status, body)})`, res.status || 502, body);
  return { refreshToken: str(r.refresh_token), accessToken: str(r.access_token), expiresIn: Number(r.expires_in) || 0 };
}

// ---------- bounded fetch ----------

/**
 * Bearer + JSON + 60 s timeout. `attempts=2` retries ONCE on 5xx/network (reads); `attempts=1` is
 * REQUIRED for every create/update — an ambiguous outcome must never be re-sent. 4xx bodies are
 * surfaced verbatim (they carry the actionable sentence); a 2xx whose request_status is ERROR is
 * an error too.
 */
async function snapFetch(url: string, init: RequestInit = {}, attempts = 2): Promise<unknown> {
  const token = await snapAccessToken();
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (res.ok) {
        if (str(rec(body).request_status).toUpperCase() === "ERROR") throw new SnapApiError(snapErrorMessage(400, body), 400, body);
        return body;
      }
      const err = new SnapApiError(snapErrorMessage(res.status, body), res.status, body);
      if (res.status >= 500 && attempt < attempts - 1) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof SnapApiError && e.status && e.status < 500) throw e;
      lastErr = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new SnapApiError(String(lastErr));
}

const jsonInit = (method: "POST" | "PUT", body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ---------- reads (cached 10 min per instance; empty answers never cached) ----------

export type SnapAdAccount = { id: string; name: string; currency: string; timezone: string; status: string; organizationId: string };
export type SnapPixel = { id: string; name: string; status: string };
export type SnapProfile = { id: string; displayName: string; profileType: string };

const TTL_MS = 10 * 60_000;
type Cached<T> = { at: number; value: T };
const caches = new Map<string, Cached<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await load();
      if (!(Array.isArray(value) && value.length === 0)) caches.set(key, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Every ad account under every organization the token can see (one call). */
export async function snapAdAccounts(): Promise<SnapAdAccount[]> {
  return cached("adaccounts", async () => {
    const body = await snapFetch(`${API_BASE}/me/organizations?with_ad_accounts=true`);
    const orgs = Array.isArray(rec(body).organizations) ? (rec(body).organizations as unknown[]) : [];
    const out: SnapAdAccount[] = [];
    for (const o of orgs) {
      const org = rec(rec(o).organization);
      const accts = Array.isArray(org.ad_accounts) ? (org.ad_accounts as unknown[]) : [];
      for (const a of accts) {
        const acc = rec(a);
        if (!str(acc.id)) continue;
        out.push({
          id: str(acc.id),
          name: str(acc.name),
          currency: str(acc.currency).toUpperCase(),
          timezone: str(acc.timezone),
          status: str(acc.status),
          organizationId: str(org.id),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  });
}

export async function snapPixels(adAccountId: string): Promise<SnapPixel[]> {
  return cached(`pixels:${adAccountId}`, async () => {
    const body = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/pixels`);
    const items = Array.isArray(rec(body).pixels) ? (rec(body).pixels as unknown[]) : [];
    return items
      .map((p) => rec(rec(p).pixel))
      .filter((p) => str(p.id))
      .map((p) => ({ id: str(p.id), name: str(p.name), status: str(p.status || p.effective_status) }));
  });
}

/** Public Profiles live on the business host; every ad must reference one (since 26.02.2024). */
export async function snapProfiles(organizationId: string): Promise<SnapProfile[]> {
  return cached(`profiles:${organizationId}`, async () => {
    const body = await snapFetch(`${BUSINESS_BASE}/organizations/${encodeURIComponent(organizationId)}/public_profiles`);
    const items = Array.isArray(rec(body).public_profiles) ? (rec(body).public_profiles as unknown[]) : [];
    return items
      .map((p) => rec(rec(p).public_profile))
      .filter((p) => str(p.id))
      .map((p) => ({ id: str(p.id), displayName: str(p.display_name), profileType: str(p.profile_type) }));
  });
}

// ---------- media ----------

export async function snapCreateMedia(adAccountId: string, name: string, type: "VIDEO" | "IMAGE"): Promise<{ id: string }> {
  const body = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/media`, jsonInit("POST", { media: [{ name, type, ad_account_id: adAccountId }] }), 1);
  return { id: str(snapBatchItem(body, "media").id) };
}

/** Multipart upload of the bytes (field `file`), one attempt. */
export async function snapUploadMedia(mediaId: string, bytes: Uint8Array, filename: string, mime: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime || "application/octet-stream" }), filename);
  await snapFetch(`${API_BASE}/media/${encodeURIComponent(mediaId)}/upload`, { method: "POST", body: form }, 1);
}

export async function snapMediaReady(mediaId: string): Promise<boolean> {
  const body = await snapFetch(`${API_BASE}/media/${encodeURIComponent(mediaId)}`);
  return str(snapBatchItem(body, "media").media_status).toUpperCase() === "READY";
}

// ---------- creates (exactly-once) ----------

export async function snapCreateCampaign(adAccountId: string, body: SnapCampaignWire): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, jsonInit("POST", { campaigns: [body] }), 1);
  return { id: str(snapBatchItem(res, "campaigns").id) };
}

export async function snapCreateAdSquad(campaignId: string, body: SnapAdSquadWire & { campaign_id: string }): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/adsquads`, jsonInit("POST", { adsquads: [body] }), 1);
  return { id: str(snapBatchItem(res, "adsquads").id) };
}

export async function snapCreateCreative(adAccountId: string, body: SnapCreativeWire): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/creatives`, jsonInit("POST", { creatives: [body] }), 1);
  return { id: str(snapBatchItem(res, "creatives").id) };
}

export async function snapCreateAd(adSquadId: string, body: SnapAdWire & { ad_squad_id: string; creative_id: string }): Promise<{ id: string }> {
  const res = await snapFetch(`${API_BASE}/adsquads/${encodeURIComponent(adSquadId)}/ads`, jsonInit("POST", { ads: [body] }), 1);
  return { id: str(snapBatchItem(res, "ads").id) };
}

/** Snap's PUT wants the WHOLE object (omitted attributes reset): read it, whitelist the writable
 *  fields, flip the status, send once. */
const CAMPAIGN_PUT_FIELDS = ["id", "name", "ad_account_id", "status", "start_time", "end_time", "buy_model", "objective_v2_properties", "daily_budget_micro", "lifetime_spend_cap_micro", "measurement_spec", "regulations"] as const;
export async function snapSetCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const read = await snapFetch(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}`);
  const cur = snapBatchItem(read, "campaigns");
  const next: Record<string, unknown> = {};
  for (const k of CAMPAIGN_PUT_FIELDS) if (cur[k] !== undefined && cur[k] !== null) next[k] = cur[k];
  next.status = status;
  const adAccountId = str(cur.ad_account_id);
  if (!adAccountId) throw new SnapApiError(`campaign ${campaignId} carries no ad_account_id`, 502, read);
  const res = await snapFetch(`${API_BASE}/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, jsonInit("PUT", { campaigns: [next] }), 1);
  snapBatchItem(res, "campaigns");
}

// ---------- creative bytes (public Blob URL → memory) ----------

export async function snapFetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string; size: number }> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new SnapApiError(`creative download failed (HTTP ${res.status})`, 400);
  const declared = Number(res.headers.get("content-length") || 0);
  const cap = Math.round(maxBytes / 1024 / 1024);
  if (declared > maxBytes) throw new SnapApiError(`creative is ${Math.round(declared / 1024 / 1024)} MB — Snapchat single upload takes at most ${cap} MB; trim the file`, 400);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new SnapApiError(`creative is ${Math.round(buf.byteLength / 1024 / 1024)} MB — Snapchat single upload takes at most ${cap} MB; trim the file`, 400);
  return { bytes: buf, mime: res.headers.get("content-type") || "", size: buf.byteLength };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd adlauncher && node --test tests/snap-api.test.ts`
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 5: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors.

---
### Task 6: Key registry over Strapi `app-cache` rows (`lib/snap-keys.ts`) + `/api/snap/keys`

**Files:**
- Create: `lib/snap-keys.ts` (server-only; NO runtime imports — reads `STRAPI_API_URL`/`STRAPI_TOKEN` and uses global `fetch` with its own 8 s bound, so it is testable with a stubbed fetch)
- Create: `app/api/snap/keys/route.ts`
- Test: `tests/snap-keys.test.ts`

**Interfaces:**
- Consumes: `snapRailEnabled` (Task 5), `sessionFromCookieHeader` (`lib/session.ts`), `isOwnerSession` (`lib/roles.ts`).
- Produces:
  - `SNAP_KEY_CKEY_PREFIX = "snap-key:"`
  - `type SnapKeyBinding = { key: string; status: "active" | "retired"; user: string; claimed_at: number; campaign_id?: string; adsquad_id?: string; ad_id?: string; ad_account?: string; niche?: string; landing?: string; name?: string; notes?: string; task_id?: string }` · `type SnapKeyRow = SnapKeyBinding & { documentId: string }`
  - `snapFreeKeys(used: Iterable<string>): string[]` · `snapNextKey(used: Iterable<string>, desired?: string): string | null` · `snapKeyCandidates(used: Iterable<string>, desired?: string): string[]`
  - `listSnapKeys(): Promise<SnapKeyRow[]>` (throws on a failed page) · `findSnapKey(key: string): Promise<SnapKeyRow | null>`
  - `claimSnapKey(desired: string | undefined, meta: Partial<SnapKeyBinding> & { user: string }): Promise<{ key: string; documentId: string }>` (throws `snap key pool exhausted — no free key glo-snp_001…100`)
  - `backfillSnapKey(key: string, patch: Partial<SnapKeyBinding>): Promise<void>` (best-effort read-merge-PUT) · `releaseSnapKey(documentId: string): Promise<void>` · `releaseSnapKeyByKey(key: string): Promise<boolean>`
  - Route `GET /api/snap/keys` → `{ ok: true, poolMax: 100, used: SnapKeyRow[], free: string[], next: string | null }`; `DELETE /api/snap/keys?key=glo-snp_007` (owner) → `{ ok: true, released: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/snap-keys.test.ts`:

```ts
// Node's built-in runner (v24 strips types natively): `node --test tests/snap-keys.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the key registry over Strapi `app-cache` rows (ckey "snap-key:<key>", unique →
// an atomic claim): free/next computation, the claim walk (unique-400 → next candidate, lost
// concurrent race → delete ours and walk on, pool exhausted → throw), backfill and release.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STRAPI_API_URL = "https://strapi.test";
process.env.STRAPI_TOKEN = "tok";
const keys = await import("../lib/snap-keys.ts");

type Rec = { url: string; method: string; body: Record<string, unknown> | null };
function stubFetch(handler: (r: Rec, n: number) => Response) {
  const calls: Rec[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rec = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(rec, calls.length);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const row = (key: string, documentId: string, extra: Record<string, unknown> = {}) => ({
  documentId,
  ckey: `snap-key:${key}`,
  cvalue: { key, status: "active", user: "nazar", claimed_at: 1, ...extra },
  refreshed_at: 1,
  createdAt: "2026-09-16T00:00:00.000Z",
});

test("free / next: the pool minus the used keys, desired-or-next with wrap-around", () => {
  const used = ["glo-snp_001", "glo-snp_003"];
  const free = keys.snapFreeKeys(used);
  assert.equal(free.length, 98);
  assert.equal(free[0], "glo-snp_002");
  assert.equal(keys.snapNextKey(used), "glo-snp_002");
  assert.equal(keys.snapNextKey(used, "glo-snp_003"), "glo-snp_004");
  assert.equal(keys.snapNextKey(used, "glo-snp_050"), "glo-snp_050");
  assert.equal(keys.snapNextKey(used, "glo-snp_100"), "glo-snp_100");
  assert.equal(keys.snapNextKey(keys.snapFreeKeys([]), "glo-snp_100"), null);
  assert.deepEqual(keys.snapKeyCandidates(["glo-snp_099"], "glo-snp_099").slice(0, 2), ["glo-snp_100", "glo-snp_001"]);
});

test("listSnapKeys reads the prefix filter, maps rows, and throws on a failed page", async () => {
  const stub = stubFetch((r) => (/\$startsWith\]=snap-key%3A/.test(r.url) ? json({ data: [row("glo-snp_002", "d2", { campaign_id: "cmp-1" }), row("glo-snp_001", "d1")] }) : json({}, 500)));
  try {
    const rows = await keys.listSnapKeys();
    assert.deepEqual(
      rows.map((x) => [x.key, x.documentId, x.status, x.campaign_id ?? null]),
      [["glo-snp_001", "d1", "active", null], ["glo-snp_002", "d2", "active", "cmp-1"]],
    );
    assert.match(stub.calls[0].url, /pagination\[pageSize\]=100/);
  } finally {
    stub.restore();
  }
  const bad = stubFetch(() => json({}, 503));
  try {
    await assert.rejects(keys.listSnapKeys(), /strapi 503/);
  } finally {
    bad.restore();
  }
});

test("claim: unique-400 on the desired key walks to the next; the winner is verified oldest-first", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /startsWith/.test(r.url)) return json({ data: [row("glo-snp_001", "d1")] });
    if (r.method === "POST") {
      const ckey = String((r.body?.data as Record<string, unknown>)?.ckey);
      if (ckey === "snap-key:glo-snp_002") return json({ error: { status: 400, message: "This attribute must be unique" } }, 400);
      return json({ data: { documentId: "mine-3" } });
    }
    if (r.method === "GET" && /\$eq\]=snap-key%3Aglo-snp_003/.test(r.url)) return json({ data: [{ documentId: "mine-3" }] });
    return json({}, 404);
  });
  try {
    const r = await keys.claimSnapKey("glo-snp_002", { user: "nazar", niche: "Cars" });
    assert.deepEqual(r, { key: "glo-snp_003", documentId: "mine-3" });
    const posts = stub.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts.map((p) => (p.body?.data as Record<string, unknown>).ckey), ["snap-key:glo-snp_002", "snap-key:glo-snp_003"]);
    const value = (posts[1].body?.data as Record<string, unknown>).cvalue as Record<string, unknown>;
    assert.equal(value.key, "glo-snp_003");
    assert.equal(value.status, "active");
    assert.equal(value.user, "nazar");
    assert.equal(value.niche, "Cars");
    assert.equal(typeof value.claimed_at, "number");
  } finally {
    stub.restore();
  }
});

test("claim: a lost concurrent race (an older twin row) deletes ours and walks on", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET" && /startsWith/.test(r.url)) return json({ data: [] });
    if (r.method === "POST") {
      const ckey = String((r.body?.data as Record<string, unknown>)?.ckey);
      return json({ data: { documentId: ckey.endsWith("001") ? "mine-1" : "mine-2" } });
    }
    if (r.method === "GET" && /glo-snp_001/.test(r.url)) return json({ data: [{ documentId: "theirs-1" }, { documentId: "mine-1" }] });
    if (r.method === "GET" && /glo-snp_002/.test(r.url)) return json({ data: [{ documentId: "mine-2" }] });
    if (r.method === "DELETE") return json({});
    return json({}, 404);
  });
  try {
    const r = await keys.claimSnapKey(undefined, { user: "nazar" });
    assert.deepEqual(r, { key: "glo-snp_002", documentId: "mine-2" });
    assert.deepEqual(stub.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["https://strapi.test/api/app-caches/mine-1"]);
  } finally {
    stub.restore();
  }
});

test("claim: every key used → pool exhausted without a single POST; a non-400 POST failure aborts", async () => {
  const all = Array.from({ length: 100 }, (_, i) => row(`glo-snp_${String(i + 1).padStart(3, "0")}`, `d${i + 1}`));
  const full = stubFetch((r) => (r.method === "GET" ? json({ data: all }) : json({}, 500)));
  try {
    await assert.rejects(keys.claimSnapKey(undefined, { user: "nazar" }), /pool exhausted/);
    assert.equal(full.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    full.restore();
  }
  const broken = stubFetch((r) => (r.method === "GET" ? json({ data: [] }) : json({ error: "boom" }, 503)));
  try {
    await assert.rejects(keys.claimSnapKey(undefined, { user: "nazar" }), /claim failed \(503\)/);
  } finally {
    broken.restore();
  }
});

test("backfill merges into the row's cvalue with a PUT that carries NO ckey; release deletes", async () => {
  const stub = stubFetch((r) => {
    if (r.method === "GET") return json({ data: [row("glo-snp_005", "d5", { niche: "Cars" })] });
    return json({});
  });
  try {
    await keys.backfillSnapKey("glo-snp_005", { status: "retired", campaign_id: "cmp-9", notes: "refused at adsquad" });
    const put = stub.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.url, "https://strapi.test/api/app-caches/d5");
    const data = put.body?.data as Record<string, unknown>;
    assert.equal(data.ckey, undefined);
    assert.deepEqual(data.cvalue, { key: "glo-snp_005", status: "retired", user: "nazar", claimed_at: 1, niche: "Cars", campaign_id: "cmp-9", notes: "refused at adsquad" });
    await keys.releaseSnapKey("d5");
    assert.deepEqual(stub.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["https://strapi.test/api/app-caches/d5"]);
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_005"), true);
  } finally {
    stub.restore();
  }
  const missing = stubFetch(() => json({ data: [] }));
  try {
    assert.equal(await keys.releaseSnapKeyByKey("glo-snp_077"), false);
  } finally {
    missing.restore();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd adlauncher && node --test tests/snap-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry module**

Create `lib/snap-keys.ts`:

```ts
// Snapchat rail — the partner-key REGISTRY (glo-snp_001…100, one key per campaign) over the
// existing Strapi `app-cache` collection: one row per claimed key, ckey "snap-key:<key>" (UNIQUE →
// a POST on a taken key is a 400 → the claim is atomic without a new Strapi collection), cvalue =
// the binding. Same race-safe claim-then-verify contract as lib/aif-claim (Strapi's app-level
// uniqueness has a TOCTOU window under concurrent POSTs — the OLDEST row wins). Server-only; no
// runtime imports (own 8 s-bounded fetch) so `node --test` covers it with a stubbed fetch.
// Moving to a dedicated `snap-map` collection later = replacing this one file.

const STRAPI = (process.env.STRAPI_API_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.STRAPI_TOKEN ?? "";
const H = () => ({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });

export const SNAP_KEY_CKEY_PREFIX = "snap-key:";
const POOL_MAX = 100;
const KEY_RE = /^glo-snp_(\d{3})$/;
const keyCode = (n: number): string => `glo-snp_${String(n).padStart(3, "0")}`;
const keyIndex = (key: string): number | null => {
  const m = KEY_RE.exec(String(key ?? "").trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= POOL_MAX ? n : null;
};

export type SnapKeyBinding = {
  key: string;
  /** active = the campaign runs on this key · retired = a campaign exists but the launch failed
   *  after it (kept so revenue stays attributable; the owner releases it by hand). */
  status: "active" | "retired";
  user: string;
  claimed_at: number;
  campaign_id?: string;
  adsquad_id?: string;
  ad_id?: string;
  ad_account?: string;
  niche?: string;
  landing?: string;
  name?: string;
  notes?: string;
  task_id?: string;
};
export type SnapKeyRow = SnapKeyBinding & { documentId: string };

/** Bounded Strapi call (8 s): the registry must fail FAST, never hang a launch. */
async function strapi(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...H(), ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
}

const str = (v: unknown): string => (v == null ? "" : String(v));

function rowOf(raw: Record<string, unknown>): SnapKeyRow | null {
  const documentId = str(raw.documentId);
  const v = (raw.cvalue && typeof raw.cvalue === "object" ? raw.cvalue : {}) as Record<string, unknown>;
  const key = str(v.key) || str(raw.ckey).replace(SNAP_KEY_CKEY_PREFIX, "");
  if (!documentId || keyIndex(key) == null) return null;
  return {
    ...(v as Partial<SnapKeyBinding>),
    key,
    status: v.status === "retired" ? "retired" : "active",
    user: str(v.user),
    claimed_at: Number(v.claimed_at) || 0,
    documentId,
  };
}

// ---------- pure pool arithmetic ----------

/** Keys not in `used`, in pool order. */
export function snapFreeKeys(used: Iterable<string>): string[] {
  const taken = new Set(used);
  const out: string[] = [];
  for (let n = 1; n <= POOL_MAX; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** Claim order: `desired` first (when it is a pool key), then forward from it, wrapping around. */
export function snapKeyCandidates(used: Iterable<string>, desired?: string): string[] {
  const taken = new Set(used);
  const start = keyIndex(desired ?? "") ?? 1;
  const out: string[] = [];
  for (let n = start; n <= POOL_MAX; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  for (let n = 1; n < start; n++) if (!taken.has(keyCode(n))) out.push(keyCode(n));
  return out;
}

/** The key a launch would take: desired when free, else the next free one (wrap), null when none. */
export function snapNextKey(used: Iterable<string>, desired?: string): string | null {
  return snapKeyCandidates(used, desired)[0] ?? null;
}

// ---------- reads ----------

/** Every registry row (any status). Paged ×100 (Strapi Cloud clamps pageSize); throws on a failed
 *  page — a partial registry must never masquerade as the whole. */
export async function listSnapKeys(): Promise<SnapKeyRow[]> {
  const out: SnapKeyRow[] = [];
  for (let page = 1; page <= 2; page++) {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$startsWith]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX)}&pagination[page]=${page}&pagination[pageSize]=100&sort[0]=ckey:asc`,
    );
    if (!res.ok) throw new Error(`strapi ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
    const rows = (body.data ?? []).map(rowOf).filter((r): r is SnapKeyRow => Boolean(r));
    out.push(...rows);
    if ((body.data ?? []).length < 100) break;
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export async function findSnapKey(key: string): Promise<SnapKeyRow | null> {
  const res = await strapi(`${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX + key)}&pagination[pageSize]=1`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>[] };
  return body.data?.[0] ? rowOf(body.data[0]) : null;
}

// ---------- claim ----------

/** Did WE win this key? Re-read its rows oldest-first; ours must be the earliest. Read failure →
 *  keep the row (best-effort). */
async function wonClaim(key: string, documentId: string): Promise<boolean> {
  try {
    const res = await strapi(
      `${STRAPI}/api/app-caches?filters[ckey][$eq]=${encodeURIComponent(SNAP_KEY_CKEY_PREFIX + key)}&sort[0]=createdAt:asc&sort[1]=documentId:asc&fields[0]=ckey&pagination[pageSize]=10`,
    );
    if (!res.ok) return true;
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ documentId?: string }> };
    const rows = body.data ?? [];
    if (rows.length <= 1) return true;
    return rows[0]?.documentId === documentId;
  } catch {
    return true;
  }
}

/**
 * Reserve one key: `desired` first, then the next free ones (wrap). A unique-ckey 400 = taken →
 * next candidate; a won POST is verified against a committed twin (older row wins → ours is
 * deleted and the walk continues). Throws when the pool is exhausted or Strapi fails otherwise.
 */
export async function claimSnapKey(desired: string | undefined, meta: Partial<SnapKeyBinding> & { user: string }): Promise<{ key: string; documentId: string }> {
  let used: string[] = [];
  try {
    used = (await listSnapKeys()).map((r) => r.key);
  } catch {
    used = []; // the POST's unique constraint is the real guard — a claim just walks through 400s
  }
  const candidates = snapKeyCandidates(used, desired);
  if (candidates.length === 0) throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
  for (const key of candidates) {
    const binding: SnapKeyBinding = { ...meta, key, status: "active", user: meta.user, claimed_at: Date.now() };
    const res = await strapi(`${STRAPI}/api/app-caches`, {
      method: "POST",
      body: JSON.stringify({ data: { ckey: SNAP_KEY_CKEY_PREFIX + key, cvalue: binding, refreshed_at: Date.now() } }),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: { documentId?: string } };
      const documentId = body.data?.documentId ?? "";
      if (!documentId || (await wonClaim(key, documentId))) return { key, documentId };
      await releaseSnapKey(documentId); // lost a concurrent race → next candidate
      continue;
    }
    if (res.status !== 400) {
      const text = await res.text().catch(() => "");
      throw new Error(`snap key claim failed (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  throw new Error(`snap key pool exhausted — no free key glo-snp_001…${POOL_MAX}`);
}

// ---------- writes ----------

/** Merge `patch` into the key's binding (PUT carries NO ckey — re-sending the unique key trips
 *  Strapi's uniqueness check). Best-effort: a missing row or a failed write is swallowed. */
export async function backfillSnapKey(key: string, patch: Partial<SnapKeyBinding>): Promise<void> {
  try {
    const row = await findSnapKey(key);
    if (!row) return;
    const { documentId, ...current } = row;
    const merged: SnapKeyBinding = { ...current, ...patch, key };
    await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "PUT", body: JSON.stringify({ data: { cvalue: merged, refreshed_at: Date.now() } }) });
  } catch {
    /* best-effort */
  }
}

/** Delete the row — the key returns to the pool (a key that never carried traffic is capacity, not history). */
export async function releaseSnapKey(documentId: string): Promise<void> {
  await strapi(`${STRAPI}/api/app-caches/${documentId}`, { method: "DELETE" }).catch(() => {});
}

/** Owner release from the keys page. True when a row existed and was deleted. */
export async function releaseSnapKeyByKey(key: string): Promise<boolean> {
  const row = await findSnapKey(key);
  if (!row) return false;
  await releaseSnapKey(row.documentId);
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd adlauncher && node --test tests/snap-keys.test.ts`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Write the keys route**

Create `app/api/snap/keys/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapRailEnabled } from "@/lib/snap-api";
import { SNAP_KEY_POOL_MAX, isSnapKey } from "@/lib/snap-launch";
import { listSnapKeys, releaseSnapKeyByKey, snapFreeKeys, snapNextKey } from "@/lib/snap-keys";

export const runtime = "nodejs";
export const maxDuration = 30;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** GET → the registry (bound rows), the free keys and the next one a launch would take. Works
 *  without Snapchat credentials (the registry is ours) — only the rail flag gates it. */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  try {
    const used = await listSnapKeys();
    const free = snapFreeKeys(used.map((r) => r.key));
    return NextResponse.json({ ok: true, poolMax: SNAP_KEY_POOL_MAX, used, free, next: snapNextKey(used.map((r) => r.key)) });
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}

/** DELETE ?key=glo-snp_NNN → owner-only release (the registry row only; Snapchat is not touched). */
export async function DELETE(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!isOwnerSession(session)) return bad("owner_only", 403);
  const key = String(new URL(req.url).searchParams.get("key") ?? "").trim();
  if (!isSnapKey(key)) return bad("bad_key");
  try {
    const released = await releaseSnapKeyByKey(key);
    return NextResponse.json({ ok: true, released });
  } catch (e) {
    return bad(`registry_unavailable: ${(e as Error).message}`, 502);
  }
}
```

- [ ] **Step 6: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors.

---
### Task 7: LION report reader + `/api/snap/report`

**Files:**
- Create: `lib/lion-snap.ts`
- Create: `app/api/snap/report/route.ts`

**Interfaces:**
- Consumes: `lionGet`, `lionConfigured` (`lib/lion.ts`); `parseSnapReport`, `snapReportDate`, `isSnapReportPartial`, `EMPTY_SNAP_METRICS`, `SnapReport` (Task 3); `listSnapKeys`, `SnapKeyRow` (Task 6); `snapKeyPool` (Task 1); `snapRailEnabled` (Task 5).
- Produces:
  - `lionSnapReport(date: string): Promise<SnapReport>` (10-min per-date cache, in-flight dedupe, an all-zero day cached ~1 min)
  - Route `GET /api/snap/report?date=today|yesterday|YYYY-MM-DD` → `{ ok: true, date, partial, affiliate, totals: SnapReportMetrics, rows: Array<{ key: string; metrics: SnapReportMetrics; binding: SnapKeyRow | null }>, registryError?: string }` (rows = all 100 keys in pool order); errors `400 bad_date`, `404 snap_rail_disabled`, `500 lion_not_configured`, `502 lion_unavailable: …`.

- [ ] **Step 1: Write the reader**

Create `lib/lion-snap.ts`:

```ts
// Server-only reader of the partner's Snapchat daily report as LION serves it (the ONLY revenue
// source for the Snap rail; probed live 2026-09-16 with our LION_TOKEN). One call per day, cached
// 10 min per instance — "one call per day" is the partner's ask, and every keys-page open of the
// team collapses onto this cache. Pure parsing lives in lib/snap-report.ts.

import { lionGet } from "./lion";
import { parseSnapReport, type SnapReport } from "./snap-report";

type CacheEntry = { at: number; report: SnapReport };
const TTL_MS = 10 * 60_000;
const SHORT_TTL_MS = 60_000;
const byDate = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SnapReport>>();

/** The report for `date` (YYYY-MM-DD, São Paulo). An all-zero answer is cached only briefly so a
 *  LION hiccup that answered zeros can't hide a day's revenue for 10 min. */
export async function lionSnapReport(date: string): Promise<SnapReport> {
  const hit = byDate.get(date);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.report;
  const running = inflight.get(date);
  if (running) return running;
  const p = (async () => {
    try {
      const body = await lionGet(`/api/high-adx-cluster-utms/snapchat-report/?date=${encodeURIComponent(date)}`);
      const report = parseSnapReport(body, date);
      const allZero = report.totals.revenue === 0 && report.totals.visitors === 0 && report.totals.impressions === 0;
      byDate.set(date, { at: allZero ? Date.now() - TTL_MS + SHORT_TTL_MS : Date.now(), report });
      return report;
    } finally {
      inflight.delete(date);
    }
  })();
  inflight.set(date, p);
  return p;
}
```

- [ ] **Step 2: Write the route**

Create `app/api/snap/report/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { lionConfigured } from "@/lib/lion";
import { lionSnapReport } from "@/lib/lion-snap";
import { snapRailEnabled } from "@/lib/snap-api";
import { snapKeyPool } from "@/lib/snap-launch";
import { EMPTY_SNAP_METRICS, isSnapReportPartial, snapReportDate } from "@/lib/snap-report";
import { listSnapKeys, type SnapKeyRow } from "@/lib/snap-keys";

export const runtime = "nodejs";
export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/**
 * GET ?date= → LION's per-key revenue for that São Paulo day joined with the key registry: one
 * row per pool key (100), bound or not. `partial` flags today (still accumulating + forecast).
 * The registry is best-effort here (a Strapi blip must not hide the revenue): bindings come back
 * null with `registryError` set.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!lionConfigured()) return bad("lion_not_configured", 500);
  const date = snapReportDate(new URL(req.url).searchParams.get("date"));
  if (!date) return bad("bad_date (today | yesterday | YYYY-MM-DD, not in the future)");

  let report;
  try {
    report = await lionSnapReport(date);
  } catch (e) {
    return bad(`lion_unavailable: ${(e as Error).message}`, 502);
  }
  let bindings = new Map<string, SnapKeyRow>();
  let registryError: string | undefined;
  try {
    bindings = new Map((await listSnapKeys()).map((r) => [r.key, r]));
  } catch (e) {
    registryError = (e as Error).message;
  }
  const rows = snapKeyPool().map((key) => ({ key, metrics: report.byKey[key] ?? EMPTY_SNAP_METRICS, binding: bindings.get(key) ?? null }));
  return NextResponse.json({
    ok: true,
    date,
    partial: isSnapReportPartial(date),
    affiliate: report.affiliate,
    totals: report.totals,
    rows,
    ...(registryError ? { registryError } : {}),
  });
}
```

- [ ] **Step 3: Type-check**

Run: `cd adlauncher && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Live read-only check of the reader (LION is real, nothing is written)**

Run (needs `.env.local` with `LION_TOKEN` + `LION_ACR`; the rail flag is irrelevant for a direct import):

```bash
cd adlauncher && node --input-type=module -e '
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local","utf8").split("\n")) { const m=/^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !(m[1] in process.env)) process.env[m[1]]=m[2].replace(/^"|"$/g,""); }
const { lionSnapReport } = await import("./lib/lion-snap.ts");
const r = await lionSnapReport("2026-09-15");
console.log(r.date, r.affiliate, r.utmPrefix, Object.keys(r.byKey).length, JSON.stringify(r.totals));
'
```

Expected: `2026-09-15 globecoders glo-snp_ 100 {"revenue":0,…}` (the numbers are whatever LION reports). If the `.ts` import fails under plain node because `lib/lion.ts` uses `@/`-style imports, skip this step — the smoke (Task 17) covers the route through Next.

---
### Task 8: The wave route, the pump binding and the task store scope

**Files:**
- Create: `lib/snap-wave.ts`, `lib/snap-pump.ts`, `app/api/snap/launch/route.ts`, `app/api/snap-tasks/route.ts`
- Modify: `app/api/launch-tasks/route.ts:84-86` (MO scope excludes `sn`)

**Interfaces:**
- Consumes: Task 1/2 (`SNAP_MAX_SHOTS`, `SNAP_WAVE_ID_RE`, `SNAP_MEDIA_MAX_BYTES`, `isSnapKey`, `snapCampaignName`, `snapGoalNeedsPixel`, `snapLaunchWire`, `snapShotTaskId`, `todaySaoPauloDotDDMM`, `SnapLaunchShotIn`), Task 4 (`runSnapPump`, `SNAP_PUMP_BUDGET_MS`, `SnapPumpShot`, `SnapPumpDeps`), Task 5 (`snapAdAccounts`, `snapPixels`, `snapConfigured`, `snapDefaults`, `snapRailEnabled`, `SnapApiError`, media/create/status functions, `snapFetchBytes`), Task 6 (`claimSnapKey`, `releaseSnapKey`, `backfillSnapKey`), existing `lib/app-cache.ts` (`readAppCache`, `writeAppCache`), `lib/task-store.ts` (`storeConfigured`, `upsertTaskRow`, `taskWriter`, `findTaskRow`, `pickTaskFields`, `readTeamTasks`, `strapiFetch`), `lib/session.ts`.
- Produces:
  - `SNAP_PARTNER = "sn"` (in `lib/snap-pump.ts`) · `pumpSnapWave(user: string, shots: SnapPumpShot[], deadline: number): Promise<void>`
  - `handleSnapLaunch(req: Request): Promise<NextResponse>` — `POST /api/snap/launch {waveId?, shots: SnapLaunchShotIn[]}` → `200 {ok:true, queued, rows:[{taskId}], alreadyAccepted?}`; errors `400 no_shots | too_many_shots (max 45) | bad_json | "shot N: <refusal>"` (+ `availablePixels` on pixel refusals), `401`, `404 snap_rail_disabled`, `500 snap_not_configured`, `502 snap_unavailable: …`, `503 task_store_not_configured_wave_not_fired | task_store_unavailable_wave_not_fired`.
  - `GET /api/snap-tasks` → `{ ok, now, tasks: SnapRemoteRow[] }` with `SnapRemoteRow = { id, owner, name, geo, budget, status, stage, key, campaignId, adSquadId, adId, link, bid, error, queued_at, started_at, finished_at, updated_ms }`; `POST /api/snap-tasks {tasks:[{task_id,…}]}` (batch ≤25, partner forced `sn`, done-is-terminal, zombie guard); `DELETE /api/snap-tasks?taskIds=a,b` (caller's rows).

- [ ] **Step 1: Write the pump binding**

Create `lib/snap-pump.ts`:

```ts
// Snapchat rail — binds the real world into the pure pump (lib/snap-pump-core.ts): the Snapchat
// client (exactly-once creates), the key registry (app-cache rows), the Blob download and the
// shared task-store writer. Runs inside after() from the wave route; rows are already stamped.

import { taskWriter, type TaskRowData } from "./task-store";
import { SNAP_MEDIA_MAX_BYTES, snapCampaignName, snapLaunchWire, todaySaoPauloDotDDMM } from "./snap-launch";
import {
  snapCreateAd,
  snapCreateAdSquad,
  snapCreateCampaign,
  snapCreateCreative,
  snapCreateMedia,
  snapFetchBytes,
  snapMediaReady,
  snapSetCampaignStatus,
  snapUploadMedia,
} from "./snap-api";
import { backfillSnapKey, claimSnapKey, releaseSnapKey } from "./snap-keys";
import { runSnapPump, type SnapPumpDeps, type SnapPumpShot } from "./snap-pump-core";

export const SNAP_PARTNER = "sn";

type Writer = ReturnType<typeof taskWriter>;

export function pumpSnapWave(user: string, shots: SnapPumpShot[], deadline: number): Promise<void> {
  const writers = new Map<string, Writer>();
  const writerOf = (taskId: string): Writer => {
    let w = writers.get(taskId);
    if (!w) {
      // partner:"sn" rides on EVERY write so even a row this writer creates lands in the Snap drawer.
      w = taskWriter(user, taskId, { partner: SNAP_PARTNER });
      writers.set(taskId, w);
    }
    return w;
  };
  const deps: SnapPumpDeps = {
    claimKey: (desired, meta) => claimSnapKey(desired, { ...(meta as Record<string, string>), user }),
    releaseKey: releaseSnapKey,
    backfillKey: backfillSnapKey,
    fetchBytes: (url) => snapFetchBytes(url, SNAP_MEDIA_MAX_BYTES),
    createMedia: snapCreateMedia,
    uploadMedia: snapUploadMedia,
    mediaReady: snapMediaReady,
    createCampaign: snapCreateCampaign,
    createAdSquad: snapCreateAdSquad,
    createCreative: snapCreateCreative,
    createAd: snapCreateAd,
    setCampaignStatus: snapSetCampaignStatus,
    buildWire: (shot, resolved) => {
      const b = snapLaunchWire(shot, resolved);
      return "refusal" in b ? b : { wire: b.wire, label: b.label };
    },
    buildName: ({ key, niche, geoLabel, tail }) => snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel, key, user, tail }),
    write: (taskId, fields) => writerOf(taskId).write(fields as TaskRowData),
    flush: async () => {
      await Promise.all([...writers.values()].map((w) => w.flush()));
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    maxMediaBytes: SNAP_MEDIA_MAX_BYTES,
    mediaPollMs: 5_000,
    mediaWaitMs: 120_000,
  };
  return runSnapPump(user, shots, deadline, deps);
}
```

- [ ] **Step 2: Write the wave handler**

Create `lib/snap-wave.ts`:

```ts
// Snapchat rail — the wave handler behind POST /api/snap/launch. Same skeleton as the Google
// wave: session → parse → validate EVERY shot against the live catalogs (ad accounts, pixels) and
// the shared validator (dry-run with placeholder key/media/name) → stamp rows into the shared
// store → claim the wave (idempotency, fail CLOSED) → after(pump) → answer at once.

import { NextResponse, after } from "next/server";
import { sessionFromCookieHeader } from "./session";
import { readAppCache, writeAppCache } from "./app-cache";
import { storeConfigured, upsertTaskRow } from "./task-store";
import {
  SNAP_MAX_SHOTS,
  SNAP_WAVE_ID_RE,
  isSnapKey,
  snapCampaignName,
  snapGoalNeedsPixel,
  snapLaunchWire,
  snapShotTaskId,
  todaySaoPauloDotDDMM,
  type SnapLaunchShotIn,
} from "./snap-launch";
import { SnapApiError, snapAdAccounts, snapConfigured, snapDefaults, snapPixels, snapRailEnabled, type SnapAdAccount, type SnapPixel } from "./snap-api";
import { SNAP_PARTNER, pumpSnapWave } from "./snap-pump";
import { SNAP_PUMP_BUDGET_MS, type SnapPumpShot } from "./snap-pump-core";

export type SnapLaunchWaveBody = { waveId?: string; shots?: SnapLaunchShotIn[] };

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error, ...extra }, { status });
const s = (v: unknown): string => (v == null ? "" : String(v)).trim();

const claimedWaves = new Set<string>();
const rememberWave = (id: string) => {
  claimedWaves.add(id);
  if (claimedWaves.size > 500) claimedWaves.delete(claimedWaves.values().next().value as string);
};

/** Pixel for the ad squad: required + validated when the goal is PIXEL_* (auto when the account
 *  has exactly one), otherwise optional but validated when given. */
function resolvePixel(pixels: SnapPixel[], picked: string, needed: boolean, accountName: string): { pixelId?: string } | { error: string } {
  const ids = pixels.map((p) => p.id);
  if (picked && !ids.includes(picked)) return { error: `pixel ${picked} is not on ${accountName}` };
  if (!needed) return picked ? { pixelId: picked } : {};
  if (ids.length === 0) return { error: `${accountName} has no Snap Pixel — pick a non-pixel goal or create a pixel in Ads Manager` };
  if (ids.length === 1) return { pixelId: ids[0] };
  if (!picked) return { error: `${accountName} has ${ids.length} pixels — pick one` };
  return { pixelId: picked };
}

/** The shot as the board sent it, normalized (strings trimmed, geo as strings, booleans coerced). */
function cleanShot(x: SnapLaunchShotIn): SnapLaunchShotIn {
  return {
    label: s(x.label),
    adAccount: s(x.adAccount),
    pixel: s(x.pixel),
    profileId: s(x.profileId),
    optimizationGoal: s(x.optimizationGoal),
    bidStrategy: s(x.bidStrategy),
    bid: s(x.bid),
    budget: s(x.budget),
    startPaused: Boolean(x.startPaused),
    headline: s(x.headline),
    brandName: s(x.brandName),
    cta: s(x.cta),
    mediaUrl: s(x.mediaUrl),
    mediaKind: x.mediaKind === "image" ? "image" : "video",
    mediaName: s(x.mediaName),
    geo: (Array.isArray(x.geo) ? x.geo : []).map(s).filter(Boolean),
    minAge: s(x.minAge) || "18",
    landingId: x.landingId === "custom" || x.landingId === "dmi" || x.landingId === "cars" ? x.landingId : ("" as SnapLaunchShotIn["landingId"]),
    landingUrl: s(x.landingUrl),
    desiredKey: s(x.desiredKey),
    suffix: s(x.suffix).replace(/[\r\n]+/g, " "),
  };
}

type ResolvedShot = { taskId: string; pump: SnapPumpShot; row: { name: string; geo: string; budget: string; bid: string; key: string } };

export async function handleSnapLaunch(req: Request): Promise<NextResponse> {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session?.username) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  const user = String(session.username);

  let body: SnapLaunchWaveBody;
  try {
    body = (await req.json()) as SnapLaunchWaveBody;
  } catch {
    return bad("bad_json");
  }
  const shotsIn = Array.isArray(body.shots) ? body.shots : [];
  if (shotsIn.length === 0) return bad("no_shots");
  if (shotsIn.length > SNAP_MAX_SHOTS) return bad(`too_many_shots (max ${SNAP_MAX_SHOTS})`);
  const waveId = SNAP_WAVE_ID_RE.test(s(body.waveId)) ? s(body.waveId) : crypto.randomUUID();

  let accounts: SnapAdAccount[];
  try {
    accounts = await snapAdAccounts();
  } catch (e) {
    const auth = e instanceof SnapApiError && e.status === 401;
    return bad(`${auth ? "snap_auth_failed" : "snap_unavailable"}: ${(e as Error).message}`, 502);
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const defaults = snapDefaults();
  const ddmm = todaySaoPauloDotDDMM();
  const nowIso = new Date().toISOString();

  const resolved: ResolvedShot[] = [];
  for (let i = 0; i < shotsIn.length; i++) {
    const x = cleanShot(shotsIn[i]);
    const at = `shot ${i + 1}`;
    const adAccountId = x.adAccount || defaults.adAccount;
    if (!adAccountId) return bad(`${at}: ad account is required`);
    const account = accountById.get(adAccountId);
    if (!account) return bad(`${at}: ad account ${adAccountId} is not one of our Snapchat ad accounts`, 400, { adAccount: adAccountId });

    const needsPixel = snapGoalNeedsPixel(x.optimizationGoal);
    let pixels: SnapPixel[] = [];
    if (needsPixel || x.pixel || defaults.pixel) {
      try {
        pixels = await snapPixels(adAccountId);
      } catch (e) {
        return bad(`snap_unavailable: pixels of ${account.name}: ${(e as Error).message}`, 502);
      }
    }
    const picked = x.pixel || (defaults.pixel && pixels.some((p) => p.id === defaults.pixel) ? defaults.pixel : "");
    const px = resolvePixel(pixels, picked, needsPixel, account.name);
    if ("error" in px) return bad(`${at}: ${px.error}`, 400, { availablePixels: pixels.map((p) => p.id) });

    const profileId = x.profileId || defaults.profile;
    if (!profileId) return bad(`${at}: a Public Profile is required on every Snapchat ad — set SNAP_PROFILE_ID or pick one`);

    const shot: SnapLaunchShotIn = { ...x, currency: account.currency };
    // Dry-run with placeholders: the validator is pure, so every refusal fires here, before any row exists.
    const dry = snapLaunchWire(shot, { adAccountId, pixelId: px.pixelId, profileId, name: "preview", key: "glo-snp_001", mediaId: "pending", startTimeIso: nowIso });
    if ("refusal" in dry) return bad(`${at}: ${dry.refusal}`);

    const desiredKey = isSnapKey(x.desiredKey ?? "") ? (x.desiredKey as string) : undefined;
    const cents = dry.wire.adsquad.daily_budget_micro / 10_000;
    const budget = `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
    const provisionalName = snapCampaignName({ ddmm, niche: dry.niche, geoLabel: dry.geoLabel, key: desiredKey ?? "glo-snp_???", user, tail: x.suffix });
    const taskId = snapShotTaskId(waveId, i);
    resolved.push({
      taskId,
      pump: {
        taskId,
        shot,
        ctx: { adAccountId, pixelId: px.pixelId, profileId, currency: account.currency, niche: dry.niche, geoLabel: dry.geoLabel, tail: x.suffix, startPaused: Boolean(x.startPaused) },
      },
      row: { name: provisionalName.slice(0, 250), geo: dry.geoLabel, budget, bid: dry.label, key: desiredKey ?? "" },
    });
  }
  return acceptSnapWave(user, waveId, resolved);
}

/**
 * Idempotency (same-instance set + app-cache claim), stamp rows BEFORE the claim and the answer
 * (the team sees queued rows even if the browser dies now), claim (fail CLOSED when unwritable —
 * a retry could otherwise pump twice), after(pump), answer.
 */
async function acceptSnapWave(user: string, waveId: string, resolved: ResolvedShot[]): Promise<NextResponse> {
  const waveKey = `snap-wave:${waveId}`;
  const alreadyAccepted = () => NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId })), alreadyAccepted: true });
  if (claimedWaves.has(waveId)) return alreadyAccepted();
  if (storeConfigured()) {
    const prior = await readAppCache<{ user: string; at: number }>(waveKey);
    if (prior) return alreadyAccepted();
  }
  if (!storeConfigured()) return bad("task_store_not_configured_wave_not_fired", 503);
  const now = Date.now();
  await Promise.all(
    resolved.map((r) =>
      upsertTaskRow(user, r.taskId, {
        partner: SNAP_PARTNER,
        name: r.row.name,
        geo: r.row.geo,
        budget: r.row.budget,
        status: "running",
        stage: "key",
        gcm: r.row.key,
        adset_id: "",
        ad_id: "",
        campaign_id: "",
        link: "",
        error: "",
        ...(r.row.bid ? { bid: r.row.bid } : {}),
        queued_at: now,
        started_at: now,
      }),
    ),
  );
  const claim = await writeAppCache(waveKey, { user, at: now });
  if (!claim) return bad("task_store_unavailable_wave_not_fired", 503);
  rememberWave(waveId);
  const shots = resolved.map((r) => r.pump);
  after(() => pumpSnapWave(user, shots, now + SNAP_PUMP_BUDGET_MS));
  return NextResponse.json({ ok: true, queued: resolved.length, rows: resolved.map((r) => ({ taskId: r.taskId })) });
}
```

- [ ] **Step 3: Write the launch route**

Create `app/api/snap/launch/route.ts`:

```ts
import { handleSnapLaunch } from "@/lib/snap-wave";

// Thin route: the whole lifecycle (validate → stamp → claim → after(pump)) lives in lib/snap-wave.
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request) {
  return handleSnapLaunch(req);
}
```

- [ ] **Step 4: Write the tasks route (clone of `app/api/google-tasks/route.ts`, partner `sn`)**

Create `app/api/snap-tasks/route.ts` — copy `app/api/google-tasks/route.ts` verbatim, then apply exactly these changes:
1. Header comment: Snapchat rows tagged `partner="sn"`; `const SNAP_PARTNER = "sn";` replaces `GOOGLE_PARTNER` everywhere (3 uses: the constant, the GET filter, the POST force).
2. Add `import { snapRailEnabled } from "@/lib/snap-api";` and, in GET/POST/DELETE right after the `unauthorized` check, `if (!snapRailEnabled()) return NextResponse.json({ ok: false, error: "snap_rail_disabled" }, { status: 404 });`.
3. `readTeamTasks("snap", …)` instead of `"google"`.
4. Replace `toClient` with:

```ts
/** Strapi row → Snap client task. Snap ids ride in reused columns: the partner key in `gcm`, the
 *  ad squad id in `adset_id`, the ad id in `ad_id`, the final landing URL in `link`. */
function toClient(r: Row): Row {
  const updated = typeof r.updatedAt === "string" ? Date.parse(r.updatedAt) : NaN;
  return {
    id: r.task_id,
    owner: r.owner ?? null,
    name: r.name ?? "",
    geo: r.geo ?? "",
    budget: r.budget ?? "",
    status: r.status ?? "queued",
    stage: r.stage ?? null,
    key: r.gcm ?? null,
    campaignId: r.campaign_id ?? null,
    adSquadId: r.adset_id ?? null,
    adId: r.ad_id ?? null,
    link: r.link ?? null,
    bid: r.bid ?? null,
    error: r.error ?? null,
    queued_at: num(r.queued_at) ?? null,
    started_at: num(r.started_at) ?? null,
    finished_at: num(r.finished_at) ?? null,
    updated_ms: Number.isFinite(updated) ? updated : null,
  };
}
```

- [ ] **Step 5: Exclude Snap rows from the MO drawer**

In `app/api/launch-tasks/route.ts` change the default scope filter (around lines 84–86) to:

```ts
      : `&filters[$or][0][partner][$null]=true` +
        `&filters[$or][1][$and][0][partner][$ne]=br&filters[$or][1][$and][1][partner][$ne]=us` +
        `&filters[$or][1][$and][2][partner][$ne]=gg&filters[$or][1][$and][3][partner][$ne]=sn`;
```

and extend the comment above it: `… Google ("gg", see /api/google-tasks) and Snapchat ("sn", see /api/snap-tasks) each run their OWN task manager over this one collection.`

- [ ] **Step 6: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint lib/snap-wave.ts lib/snap-pump.ts app/api/snap app/api/snap-tasks app/api/launch-tasks`
Expected: no errors.

---
### Task 9: Build-time flag, the Snapchat mark, the sub-nav

**Files:**
- Modify: `lib/partners.ts` (after `GOOGLE_ENABLED`, ~line 262)
- Modify: `components/icons.tsx` (append `SnapMark` after `GoogleMark`)
- Create: `components/snap-nav.tsx`

**Interfaces:**
- Produces: `SNAP_ENABLED: boolean` (`lib/partners.ts`) · `SnapMark({ mono, ...props }: SVGProps<SVGSVGElement> & { mono?: boolean })` · `SnapNav({ active }: { active: "launch" | "keys" })`.

- [ ] **Step 1: Add the flag**

In `lib/partners.ts`, right after the `GOOGLE_ENABLED` export:

```ts
/** Snapchat is a PLATFORM tab too (not a PartnerId): the rail launches on our OWN Snapchat ad
 *  account through the Marketing API — there is no partner rail to pin. Build-time gate, same
 *  dormant-on-prod pattern — set NEXT_PUBLIC_SNAP_ENABLED=1 in .env.local ONLY (never on Vercel
 *  in this phase). It unlocks the header's Snapchat tab + the /snap routes. */
export const SNAP_ENABLED = process.env.NEXT_PUBLIC_SNAP_ENABLED === "1";
```

- [ ] **Step 2: Add the mark**

Append to `components/icons.tsx` (after `GoogleMark`):

```tsx
/** Snapchat ghost — Snap yellow with a dark outline in colour, `currentColor` when mono (dormant tab). */
export function SnapMark({ mono, ...props }: P & { mono?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill={mono ? "currentColor" : "#FFFC00"}
        stroke={mono ? "none" : "#1f1f1f"}
        strokeWidth={mono ? 0 : 0.7}
        strokeLinejoin="round"
        d="M12 2.2c3.1 0 5.4 2.3 5.4 5.6v2c.5.2 1 .1 1.4-.1.4-.2.9 0 .9.4 0 .5-.6.8-1.3 1.1-.4.2-.8.4-.6.9.6 1.4 1.8 2.6 3.4 3 .4.1.5.5.3.8-.4.5-1.4.8-2.3.9-.2 0-.3.3-.4.7-.1.4-.3.6-.7.5-.6-.1-1.3-.3-2-.1-1.3.4-2.1 1.7-4.1 1.7s-2.8-1.3-4.1-1.7c-.7-.2-1.4 0-2 .1-.4.1-.6-.1-.7-.5-.1-.4-.2-.7-.4-.7-.9-.1-1.9-.4-2.3-.9-.2-.3-.1-.7.3-.8 1.6-.4 2.8-1.6 3.4-3 .2-.5-.2-.7-.6-.9C4.7 11 4.1 10.7 4.1 10.2c0-.4.5-.6.9-.4.4.2.9.3 1.4.1v-2C6.4 4.5 8.9 2.2 12 2.2z"
      />
    </svg>
  );
}
```

- [ ] **Step 3: Write the sub-nav**

Create `components/snap-nav.tsx`:

```tsx
"use client";

// The slim strip under the Header on the Snapchat platform: two pill-links between the LAUNCH
// board (/snap) and the KEYS · REPORT page (/snap/keys), with a one-line hint of the active side.
// Same texture as google-nav, Snap-yellow accent. Sticky under the sticky header (h-16 / z-40).

import Link from "next/link";

const PILLS = [
  { key: "launch", href: "/snap", label: "Launch", hint: "Web campaigns on our Snapchat ad account — one partner key per campaign" },
  { key: "keys", href: "/snap/keys", label: "Keys · report", hint: "The 100 partner keys, who holds them, and LION's daily revenue per key" },
] as const;

export function SnapNav({ active }: { active: "launch" | "keys" }) {
  const hint = PILLS.find((p) => p.key === active)?.hint ?? "";
  const base = "flex h-8 items-center rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-150";
  const on = "border border-[#FFFC00]/40 bg-[#FFFC00]/10 text-[#f3f0a3]";
  const off = "border border-transparent text-dim hover:bg-raise hover:text-ink";
  return (
    <div className="sticky top-16 z-30 border-b border-line bg-bg/75 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-4 py-2 sm:px-6">
        <nav aria-label="Snapchat board" className="flex items-center gap-1 rounded-full border border-line bg-surface p-1">
          {PILLS.map((p) => {
            const isOn = p.key === active;
            return (
              <Link key={p.key} href={p.href} aria-current={isOn ? "page" : undefined} className={`${base} ${isOn ? on : off}`}>
                {p.label}
              </Link>
            );
          })}
        </nav>
        <span className="ml-auto hidden truncate text-[11px] leading-snug text-faint sm:block">{hint}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the local flag + mock env to `.env.local`** (local only; never Vercel)

Append to `adlauncher/.env.local`:

```
NEXT_PUBLIC_SNAP_ENABLED=1
SNAP_CLIENT_ID=local-mock
SNAP_CLIENT_SECRET=local-mock
SNAP_REFRESH_TOKEN=local-mock
SNAP_API_BASE=http://127.0.0.1:3198/v1
SNAP_AUTH_BASE=http://127.0.0.1:3198
SNAP_BUSINESS_API_BASE=http://127.0.0.1:3198/business/v1
SNAP_BRAND_NAME=GC
```

(When real credentials arrive: replace the three `local-mock` values, delete the three `*_BASE` lines, add `SNAP_PROFILE_ID` / `SNAP_PIXEL_ID` / `SNAP_AD_ACCOUNT_ID` — see `_e2e/README-snap.md`, Task 17.)

- [ ] **Step 5: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint components/snap-nav.tsx components/icons.tsx lib/partners.ts`
Expected: no errors.

---

### Task 10: Catalog route + client hooks (`/api/snap/accounts`, `components/use-snap.ts`)

**Files:**
- Create: `app/api/snap/accounts/route.ts`
- Create: `components/use-snap.ts`

**Interfaces:**
- Consumes: Task 5 (`snapAdAccounts`, `snapPixels`, `snapProfiles`, `snapDefaults`, `snapConfigured`, `snapRailEnabled`, `SnapApiError`, types), Task 6 route shape.
- Produces:
  - `type SnapCatalogAccount = SnapAdAccount & { pixels: SnapPixel[]; pixelsError?: string }` · `type SnapCatalog = { accounts: SnapCatalogAccount[]; profiles: SnapProfile[]; profilesError?: string; defaults: { adAccount: string; pixel: string; profile: string; brandName: string } }`
  - Route `GET /api/snap/accounts` → `{ ok: true } & SnapCatalog`; errors `401`, `404 snap_rail_disabled`, `500 snap_not_configured`, `502 snap_auth_failed: … | snap_unavailable: …`.
  - `useSnapCatalog(): { catalog: SnapCatalog | null; error: string | null; retry: () => void }`
  - `type SnapKeysState = { poolMax: number; used: SnapKeyRow[]; free: string[]; next: string | null }` · `useSnapKeys(): { keys: SnapKeysState | null; error: string | null; refresh: () => void }`

- [ ] **Step 1: Write the catalog route**

Create `app/api/snap/accounts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import {
  SnapApiError,
  snapAdAccounts,
  snapConfigured,
  snapDefaults,
  snapPixels,
  snapProfiles,
  snapRailEnabled,
  type SnapAdAccount,
  type SnapPixel,
  type SnapProfile,
} from "@/lib/snap-api";

export const runtime = "nodejs";
export const maxDuration = 60;

export type SnapCatalogAccount = SnapAdAccount & { pixels: SnapPixel[]; pixelsError?: string };
export type SnapCatalog = {
  accounts: SnapCatalogAccount[];
  profiles: SnapProfile[];
  profilesError?: string;
  defaults: { adAccount: string; pixel: string; profile: string; brandName: string };
};

const bad = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

/** Run a batch of async jobs with at most `limit` in flight. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * GET → everything the launcher's pickers need in ONE call: our ad accounts (each with its
 * pixels), the organization's Public Profiles and the env defaults. Per-account pixel reads and
 * the profiles read are best-effort (an error string rides along instead of sinking the call).
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (!sessionFromCookieHeader(req.headers.get("cookie"))) return bad("unauthorized", 401);
  if (!snapRailEnabled()) return bad("snap_rail_disabled", 404);
  if (!snapConfigured()) return bad("snap_not_configured", 500);
  let accounts: SnapAdAccount[];
  try {
    accounts = await snapAdAccounts();
  } catch (e) {
    const auth = e instanceof SnapApiError && e.status === 401;
    return bad(`${auth ? "snap_auth_failed" : "snap_unavailable"}: ${(e as Error).message}`, 502);
  }
  const withPixels: SnapCatalogAccount[] = accounts.map((a) => ({ ...a, pixels: [] }));
  await eachLimit(withPixels, 5, async (a) => {
    try {
      a.pixels = await snapPixels(a.id);
    } catch (e) {
      a.pixelsError = (e as Error).message;
    }
  });
  const defaults = snapDefaults();
  const orgId = defaults.organization || accounts[0]?.organizationId || "";
  let profiles: SnapProfile[] = [];
  let profilesError: string | undefined;
  if (orgId) {
    try {
      profiles = await snapProfiles(orgId);
    } catch (e) {
      profilesError = (e as Error).message;
    }
  } else {
    profilesError = "no organization id (no ad accounts and SNAP_ORGANIZATION_ID unset)";
  }
  const body: { ok: true } & SnapCatalog = {
    ok: true,
    accounts: withPixels,
    profiles,
    ...(profilesError ? { profilesError } : {}),
    defaults: { adAccount: defaults.adAccount, pixel: defaults.pixel, profile: defaults.profile, brandName: defaults.brandName },
  };
  return NextResponse.json(body);
}
```

- [ ] **Step 2: Write the hooks**

Create `components/use-snap.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SnapCatalog } from "@/app/api/snap/accounts/route";
import type { SnapKeyRow } from "@/lib/snap-keys";

// Type-only re-exports so the boards import every Snap client type from one place (erased at
// build time — the server modules never enter the client bundle).
export type { SnapCatalog, SnapCatalogAccount } from "@/app/api/snap/accounts/route";
export type { SnapAdAccount, SnapPixel, SnapProfile } from "@/lib/snap-api";
export type { SnapKeyRow } from "@/lib/snap-keys";

const RETRY_COOLDOWN_MS = 8_000;
const MAX_AUTO_ATTEMPTS = 4;

/** One-shot loader with a bounded auto-retry and a manual retry (the useGoogleCustomers discipline:
 *  refs guard the in-flight/done state so a re-render can't start a second fetch). */
function useOneShot<T>(url: string, pick: (d: Record<string, unknown>) => T): { data: T | null; error: string | null; retry: () => void; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  const doneRef = useRef(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    if (inflightRef.current || doneRef.current) return;
    inflightRef.current = true;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || !d?.ok) throw new Error(String(d?.error || `HTTP ${res.status}`));
      doneRef.current = true;
      setData(pick(d));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      attemptRef.current += 1;
      if (attemptRef.current < MAX_AUTO_ATTEMPTS) timerRef.current = setTimeout(() => loadRef.current?.(), RETRY_COOLDOWN_MS);
    } finally {
      inflightRef.current = false;
    }
  }, [url, pick]);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const retry = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    attemptRef.current = 0;
    doneRef.current = false;
    setError(null);
    void load();
  }, [load]);
  /** Silent re-read (keeps the current data on screen while it runs). */
  const reload = useCallback(() => {
    doneRef.current = false;
    void load();
  }, [load]);

  useEffect(() => {
    // load() only setStates AFTER its fetch resolves (an async callback update, the rule's own exception).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  return { data, error, retry, reload };
}

const pickCatalog = (d: Record<string, unknown>): SnapCatalog => ({
  accounts: Array.isArray(d.accounts) ? (d.accounts as SnapCatalog["accounts"]) : [],
  profiles: Array.isArray(d.profiles) ? (d.profiles as SnapCatalog["profiles"]) : [],
  ...(d.profilesError ? { profilesError: String(d.profilesError) } : {}),
  defaults: (d.defaults as SnapCatalog["defaults"]) ?? { adAccount: "", pixel: "", profile: "", brandName: "" },
});

/** GET /api/snap/accounts — the launcher's whole catalog (accounts + pixels, profiles, defaults). */
export function useSnapCatalog(): { catalog: SnapCatalog | null; error: string | null; retry: () => void } {
  const { data, error, retry } = useOneShot<SnapCatalog>("/api/snap/accounts", pickCatalog);
  return { catalog: data, error, retry };
}

export type SnapKeysState = { poolMax: number; used: SnapKeyRow[]; free: string[]; next: string | null };
const pickKeys = (d: Record<string, unknown>): SnapKeysState => ({
  poolMax: Number(d.poolMax) || 100,
  used: Array.isArray(d.used) ? (d.used as SnapKeyRow[]) : [],
  free: Array.isArray(d.free) ? (d.free as string[]) : [],
  next: typeof d.next === "string" ? d.next : null,
});

/** GET /api/snap/keys — the registry view (free keys drive the card preview + the fire gate). */
export function useSnapKeys(): { keys: SnapKeysState | null; error: string | null; refresh: () => void } {
  const { data, error, retry, reload } = useOneShot<SnapKeysState>("/api/snap/keys", pickKeys);
  return { keys: data, error, refresh: error ? retry : reload };
}
```

- [ ] **Step 3: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint app/api/snap/accounts/route.ts components/use-snap.ts`
Expected: no errors. (If ESLint flags the type import from a route file in a client component, move the two `SnapCatalog*` types into `lib/snap-api.ts` and re-export them from there — types are erased either way.)

---
### Task 11: Snap task manager (provider, button, drawer) + header/layout wiring

**Files:**
- Create: `components/snap-task-manager.tsx`
- Modify: `components/header.tsx` (Platform union, Snapchat tab, locked note, queue button)
- Modify: `app/(app)/layout.tsx` (mount `SnapTaskManagerProvider` innermost)

**Interfaces:**
- Consumes: `GET/POST /api/snap-tasks` (Task 8), `STALE_MS`, `ownerHue` (`lib/task-view.ts`), `moneyLabel` (`lib/types.ts`), `snapCurrencySymbol` (Task 2), icons (`SnapMark` from Task 9, `AlertIcon`, `CheckIcon`, `CopyIcon`, `RocketIcon`, `TasksIcon`, `XIcon`).
- Produces: `type SnapTask` · `SnapTaskManagerProvider({ children, user })` · `useSnapTaskManager(): { tasks: SnapTask[]; counts: { active; done; failed; running; total }; me: string | null; open: boolean; setOpen(v: boolean): void; refresh(): void; estServerNow: number }` · `SnapTaskManagerButton()`.

- [ ] **Step 1: Write the task manager**

Create `components/snap-task-manager.tsx`:

```tsx
"use client";

// Task manager for the Snapchat platform tab — the compact Google-manager shape (no client
// uploads beyond the board's Blob step, no token channel, no partner finisher). The board fires
// ONE wave POST (/api/snap/launch); the server's after() pump claims a key, uploads the creative
// to Snapchat and builds campaign → ad squad → creative → ad → activate, writing the shared
// Strapi row at every stage — so this provider never runs work: it MIRRORS the team's rows
// (partner="sn" scope via /api/snap-tasks). Own-row authority as in the Google manager: a row I
// patched locally (the 3 h age-out) stays until the server echoes a newer updatedMs. No retry
// (creates are exactly-once — re-fire from the board), no dismiss (errors are the team record).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { moneyLabel } from "@/lib/types";
import { STALE_MS, ownerHue } from "@/lib/task-view";
import { snapCurrencySymbol } from "@/lib/snap-launch";
import { AlertIcon, CheckIcon, CopyIcon, RocketIcon, SnapMark, TasksIcon, XIcon } from "./icons";

// ---------- model ----------

export type SnapTask = {
  id: string;
  name: string;
  owner: string | null;
  /** The partner key (Strapi gcm column) — "" until the pump claimed one. */
  key: string;
  campaignId?: string;
  adSquadId?: string;
  adId?: string;
  /** The final landing URL with the key (Strapi link column). */
  link?: string;
  geo: string;
  budget: string;
  bid?: string;
  status: "queued" | "running" | "done" | "error" | "interrupted";
  /** key | media | campaign | adsquad | creative | ad | activate | live | paused | failed */
  stage: string | null;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedMs?: number;
};

/** GET /api/snap-tasks row shape (verbatim wire contract). */
type SnapRemoteRow = {
  id: string;
  owner: string | null;
  name: string;
  geo: string;
  budget: string;
  status: string;
  stage: string | null;
  key: string | null;
  campaignId: string | null;
  adSquadId: string | null;
  adId: string | null;
  link: string | null;
  bid: string | null;
  error: string | null;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  updated_ms: number | null;
};

const SHARED_POLL_OPEN_MS = 6_000;
const SHARED_POLL_CLOSED_MS = 20_000;
/** My running row still not terminal after this long → interrupted (the pump's budget is 13 min;
 *  3 h means the row is wedged for good). */
const AGE_OUT_MS = 3 * 60 * 60_000;

// ---------- pure helpers ----------

const n = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

function fromRemote(r: SnapRemoteRow): SnapTask {
  const raw = r.status;
  const status: SnapTask["status"] = raw === "done" || raw === "error" || raw === "interrupted" || raw === "running" ? raw : "queued";
  return {
    id: r.id,
    name: r.name || "",
    owner: r.owner ?? null,
    key: r.key || "",
    campaignId: r.campaignId || undefined,
    adSquadId: r.adSquadId || undefined,
    adId: r.adId || undefined,
    link: r.link || undefined,
    geo: r.geo || "",
    budget: r.budget || "",
    bid: r.bid || undefined,
    status,
    stage: r.stage || null,
    error: r.error || undefined,
    queuedAt: n(r.queued_at) ?? Date.now(),
    startedAt: n(r.started_at),
    finishedAt: n(r.finished_at),
    updatedMs: n(r.updated_ms),
  };
}

/** Same merge as the Google manager: my newer local patch outranks a stale echo; unchanged rows
 *  keep object identity; everything else mirrors the fetch. Newest first. */
function mergeShared(cur: SnapTask[], fetched: SnapTask[], tombstones: ReadonlySet<string>): SnapTask[] {
  const curById = new Map(cur.map((c) => [c.id, c]));
  const byId = new Map<string, SnapTask>();
  for (const f of fetched) {
    if (!f.id || tombstones.has(f.id)) continue;
    const prev = curById.get(f.id);
    if (prev && prev.updatedMs != null && (f.updatedMs == null || prev.updatedMs > f.updatedMs)) byId.set(f.id, prev);
    else if (prev && prev.updatedMs != null && prev.updatedMs === f.updatedMs) byId.set(f.id, prev);
    else byId.set(f.id, f);
  }
  const next = [...byId.values()].sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
  return next.length === cur.length && next.every((t, i) => t === cur[i]) ? cur : next;
}

function ownerLastWrite(tasks: readonly SnapTask[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const t of tasks) {
    if (!t.owner || t.updatedMs == null) continue;
    if ((last.get(t.owner) ?? 0) < t.updatedMs) last.set(t.owner, t.updatedMs);
  }
  return last;
}

const isTerminal = (st: SnapTask["status"]) => st === "done" || st === "error" || st === "interrupted";

function isStaleRow(t: SnapTask, me: string | null, lastWriteByOwner: ReadonlyMap<string, number>, estServerNow: number): boolean {
  const mine = !!me && t.owner === me;
  if (mine || isTerminal(t.status)) return false;
  const last = t.owner ? lastWriteByOwner.get(t.owner) : undefined;
  if (!last) return true;
  return estServerNow - last > STALE_MS;
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

/** The stage/status one-liner for a row. */
export function snapStageLabel(t: SnapTask): string {
  if (t.status === "done") {
    const where = t.stage === "paused" ? "Built · PAUSED" : "Live";
    return t.error ? `${where} · ${t.error}` : `${where} on Snapchat${t.key ? ` · ${t.key}` : ""}`;
  }
  if (t.status === "error") return t.error || "Failed";
  if (t.status === "interrupted") return t.error || "Check Ads Manager";
  switch (t.stage) {
    case "key":
      return "Claiming a partner key…";
    case "media":
      return "Uploading the creative to Snapchat…";
    case "campaign":
      return "Creating the campaign (paused)…";
    case "adsquad":
      return "Creating the ad squad…";
    case "creative":
      return "Creating the creative…";
    case "ad":
      return "Creating the ad…";
    case "activate":
      return "Activating the campaign…";
    default:
      return t.status === "queued" ? "Queued — safe to close the tab" : "Working…";
  }
}

// ---------- context ----------

export type SnapTaskManagerValue = {
  tasks: SnapTask[];
  counts: { active: number; done: number; failed: number; running: number; total: number };
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  refresh: () => void;
  estServerNow: number;
};

const Ctx = createContext<SnapTaskManagerValue | null>(null);

export function useSnapTaskManager(): SnapTaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSnapTaskManager must be used within SnapTaskManagerProvider");
  return v;
}

// ---------- provider ----------

export function SnapTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: { username: string; role?: string | null } }) {
  const me = user?.username ?? null;
  const [tasks, setTasks] = useState<SnapTask[]>([]);
  const [open, setOpen] = useState(false);
  const [skew, setSkew] = useState(0);
  const skewRef = useRef(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const tasksRef = useRef<SnapTask[]>([]);
  const openRef = useRef(false);
  const lastSharedPollRef = useRef(0);
  const saveChains = useRef(new Map<string, Promise<unknown>>());
  const tombstones = useRef<Set<string>>(new Set());

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const k of [...saveChains.current.keys()]) if (!ids.has(k)) saveChains.current.delete(k);
  }, [tasks]);

  const isMine = useCallback((t: SnapTask) => !!me && t.owner === me, [me]);

  const noteSkew = useCallback((serverNow: number) => {
    const sk = serverNow - Date.now();
    skewRef.current = sk;
    setSkew((prev) => (Math.abs(prev - sk) > 3000 ? sk : prev));
  }, []);

  const patch = useCallback((id: string, p: Partial<SnapTask>) => {
    const stamp = Date.now() + skewRef.current;
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p, updatedMs: Math.max(t.updatedMs ?? 0, stamp) } : t)));
  }, []);

  const saveRemote = useCallback((id: string, dyn: Record<string, unknown>) => {
    const body = JSON.stringify({ tasks: [{ task_id: id, ...dyn }] });
    const post = () => fetch("/api/snap-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(20_000) });
    const prev = saveChains.current.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        try {
          const res = await post();
          if (res.ok || (res.status >= 400 && res.status < 500)) return;
        } catch {
          /* network — retry once */
        }
        await new Promise((r) => setTimeout(r, 4000));
        await post().catch(() => {});
      });
    saveChains.current.set(id, next);
  }, []);

  const loadRemote = useCallback(() => {
    fetch("/api/snap-tasks", { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json().catch(() => null)) as { ok?: boolean; now?: number; tasks?: SnapRemoteRow[] } | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        if (typeof d.now === "number") noteSkew(d.now);
        const fetched = d.tasks.map(fromRemote);
        setTasks((cur) => mergeShared(cur, fetched, tombstones.current));
      })
      .catch(() => {});
  }, [noteSkew]);

  useEffect(() => {
    loadRemote();
  }, [loadRemote]);

  // Shared-store polling (faster while open) + a coarse clock for stale detection + the age-out
  // of MY wedged running rows (the pump's budget is 13 min; 3 h of "running" is a dead row).
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      const interval = openRef.current ? SHARED_POLL_OPEN_MS : SHARED_POLL_CLOSED_MS;
      if (Date.now() - lastSharedPollRef.current < interval - 300) return;
      lastSharedPollRef.current = Date.now();
      loadRemote();
      const now = Date.now();
      for (const t of tasksRef.current) {
        if (!isMine(t) || t.status !== "running") continue;
        const from = t.startedAt ?? t.queuedAt;
        if (from && now - from > AGE_OUT_MS) {
          const error = "Still not finished after 3 h — check Ads Manager and the key registry";
          const finishedAt = from + AGE_OUT_MS;
          patch(t.id, { status: "interrupted", error, finishedAt });
          saveRemote(t.id, { status: "interrupted", stage: t.stage ?? "failed", error, finished_at: finishedAt });
        }
      }
    };
    const iv = window.setInterval(tick, SHARED_POLL_OPEN_MS);
    const onVis = () => {
      if (!document.hidden) {
        lastSharedPollRef.current = Date.now();
        loadRemote();
      }
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    const clock = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(clock);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote, isMine, patch, saveRemote]);

  useEffect(() => {
    if (!open) return;
    lastSharedPollRef.current = Date.now();
    loadRemote();
  }, [open, loadRemote]);

  const estServerNow = nowTick + skew;

  const counts = useMemo(() => {
    const lastWrite = ownerLastWrite(tasks);
    let active = 0,
      done = 0,
      failed = 0,
      running = 0;
    for (const t of tasks) {
      if (isStaleRow(t, me, lastWrite, estServerNow)) {
        failed++;
        continue;
      }
      if (t.status === "queued" || t.status === "running") active++;
      if (t.status === "running") running++;
      if (t.status === "done") done++;
      if (t.status === "error" || t.status === "interrupted") failed++;
    }
    return { active, done, failed, running, total: tasks.length };
  }, [tasks, me, estServerNow]);

  const value: SnapTaskManagerValue = { tasks, counts, me, open, setOpen, refresh: loadRemote, estServerNow };
  return (
    <Ctx.Provider value={value}>
      {children}
      <SnapTaskManagerPanel />
    </Ctx.Provider>
  );
}

// ---------- header button ----------

export function SnapTaskManagerButton() {
  const { counts, setOpen } = useSnapTaskManager();
  const badge = counts.active > 0 ? counts.active : counts.failed > 0 ? counts.failed : 0;
  const tone =
    counts.active > 0
      ? "border-launch/40 bg-launch/10 text-launch2"
      : counts.failed > 0
        ? "border-danger/40 bg-danger/10 text-danger"
        : "border-line bg-surface text-dim hover:border-line2 hover:bg-surface2 hover:text-ink";
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open Snapchat Task Manager"
      className={"relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-all duration-200 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch/40 " + tone}
    >
      <span className="relative">
        <TasksIcon className="h-4 w-4" />
        {counts.running > 0 ? <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" /> : null}
      </span>
      <span className="hidden whitespace-nowrap sm:inline">Snap tasks</span>
      {badge > 0 ? (
        <span key={badge} className={"animate-badge-pop grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold " + (counts.active > 0 ? "bg-launch text-[#032e20]" : "bg-danger text-white")}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------- drawer ----------

type Filter = "all" | "active" | "done" | "failed";

function SnapTaskManagerPanel() {
  const { tasks, counts, me, open, setOpen, refresh, estServerNow } = useSnapTaskManager();
  const [filter, setFilter] = useState<Filter>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || counts.running === 0) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [open, counts.running]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, setOpen]);

  const lastWrite = useMemo(() => ownerLastWrite(tasks), [tasks]);
  if (!open) return null;

  const staleOf = (t: SnapTask) => isStaleRow(t, me, lastWrite, estServerNow);
  const inBucket = (t: SnapTask): boolean =>
    filter === "all" ? true : filter === "active" ? (t.status === "queued" || t.status === "running") && !staleOf(t) : filter === "done" ? t.status === "done" : t.status === "error" || t.status === "interrupted" || staleOf(t);
  const isMineRow = (t: SnapTask) => !!me && t.owner === me;
  const shown = (mineOnly ? tasks.filter(isMineRow) : tasks).filter(inBucket);
  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: tasks.length },
    { key: "active", label: "Active", n: counts.active },
    { key: "done", label: "Done", n: counts.done },
    { key: "failed", label: "Failed", n: counts.failed },
  ];

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <aside className="animate-drawer-in absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-20px_0_60px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#FFFC00]/15">
              <SnapMark className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">Snapchat Task Manager</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">Launches on our ad account · one key per campaign</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={refresh} aria-label="Refresh" data-tip="Refresh" className="tip flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <RocketIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Active" n={counts.active} tone="text-[#9db8ff]" />
          <Stat label="Done" n={counts.done} tone="text-launch2" />
          <Stat label="Failed" n={counts.failed} tone="text-danger" />
        </div>
        <div className="flex items-center gap-1 px-3 pt-3">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setFilter(tab.key)} className={"flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " + (filter === tab.key ? "bg-raise text-ink" : "text-faint hover:text-dim")}>
              {tab.label}
              <span className="font-mono text-[10.5px] text-faint">{tab.n}</span>
            </button>
          ))}
          <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)} className={"ml-auto rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " + (mineOnly ? "bg-accent/15 text-[#9db8ff]" : "text-faint hover:text-dim")}>
            Mine
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface2 text-faint">
                <SnapMark className="h-5 w-5" mono />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-faint">Snapchat launches land here. A green row means the campaign is built on Snapchat — the wave runs server-side, so this tab may be closed.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <SnapTaskRow key={t.id} task={t} mine={isMineRow(t)} stale={staleOf(t)} now={now} />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] leading-relaxed text-faint">Rows are shared with the team; campaigns are born PAUSED and activated once the ad exists.</span>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface2/50 px-2 py-1 text-[11px]">
      <span className="text-faint">{label}</span>
      <span className={"font-mono text-[11.5px] font-semibold tabular-nums " + tone}>{n}</span>
    </span>
  );
}

function SnapTaskRow({ task: t, mine, stale, now }: { task: SnapTask; mine: boolean; stale: boolean; now: number }) {
  const done = t.status === "done";
  const error = t.status === "error";
  const interrupted = t.status === "interrupted";
  const running = t.status === "running" && !stale;
  const end = t.finishedAt ?? now;
  const elapsed = t.startedAt ? Math.max(0, end - t.startedAt) : 0;
  const label = stale ? (t.error ?? "Session went offline before this run finished") : snapStageLabel(t);
  const budget = `${snapCurrencySymbol("USD")}${moneyLabel(t.budget)}`;
  return (
    <div className={"animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " + (error ? "border-danger/30" : interrupted || stale ? "border-warn/30" : done ? "border-launch/25" : "border-line")}>
      <div className="flex items-start gap-2.5">
        <SnapStatusDot status={t.status} stale={stale} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={t.name}>
            {t.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-faint">
            <OwnerChip owner={t.owner} mine={mine} />
            {t.key ? <span className="shrink-0 rounded bg-[#FFFC00]/15 px-1 py-[1px] text-[9.5px] font-semibold text-[#f3f0a3]">{t.key}</span> : null}
            <span className="truncate">
              {t.geo || "—"} · {budget}
              {t.bid ? ` · ${t.bid}` : ""}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale ? <span className="rounded-md border border-warn/25 bg-warn/5 px-1.5 py-0.5 text-[9.5px] font-medium text-warn">session offline</span> : null}
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={"flex min-w-0 items-center gap-1.5 truncate text-[11px] " + (done ? "text-launch2" : error ? "text-danger" : interrupted || stale ? "text-warn" : "text-dim")}>
          {error || interrupted || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={label}>
            {label}
          </span>
        </span>
      </div>
      {t.campaignId || t.adSquadId || t.adId || t.link ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.campaignId ? <CopyId prefix="cmp" id={t.campaignId} /> : null}
          {t.adSquadId ? <CopyId prefix="squad" id={t.adSquadId} /> : null}
          {t.adId ? <CopyId prefix="ad" id={t.adId} /> : null}
          {t.link ? <CopyId prefix="link" id={t.link} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function SnapStatusDot({ status, stale }: { status: SnapTask["status"]; stale: boolean }) {
  if (status === "running" && !stale)
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color = stale ? "bg-warn" : status === "done" ? "bg-launch2" : status === "error" ? "bg-danger" : status === "interrupted" ? "bg-warn" : "bg-line2";
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

function OwnerChip({ owner, mine }: { owner: string | null; mine: boolean }) {
  if (mine) return <span className="shrink-0 text-dim">you</span>;
  const name = owner || "—";
  const h = ownerHue(name);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px]" style={{ color: `hsl(${h} 75% 72%)`, background: `hsl(${h} 70% 60% / 0.14)` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${h} 75% 62%)` }} />
      {name}
    </span>
  );
}

function CopyId({ prefix, id }: { prefix: string; id: string }) {
  const [copied, setCopied] = useState(false);
  const short = id.length > 28 ? `${id.slice(0, 26)}…` : id;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex max-w-full shrink-0 items-center gap-1 rounded-md border border-line bg-surface2/60 px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-line2 hover:text-ink"
      title={`Copy ${prefix}: ${id}`}
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      <span className="truncate">
        {prefix} {short}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Wire the header**

In `components/header.tsx`:
1. `type Platform = "facebook" | "google" | "snapchat";`
2. Imports: add `SnapMark` to the icons import, `SnapTaskManagerButton` from `./snap-task-manager`, and `SNAP_ENABLED` to the `@/lib/partners` import.
3. In `PlatformTabs`, add `const onSnap = platform === "snapchat";` and the pill class `const snapActive = "border border-[#FFFC00]/40 bg-[#FFFC00]/10 text-[#f3f0a3] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_18px_rgba(255,252,0,0.12)]";`, then append AFTER the Google tab block (inside the `<nav>`):

```tsx
      {SNAP_ENABLED ? (
        <Link href="/snap" aria-current={onSnap ? "page" : undefined} className={`${base} ${onSnap ? snapActive : inactive}`}>
          <SnapMark className="h-4 w-4" />
          <span className="hidden sm:inline">Snapchat</span>
        </Link>
      ) : (
        <button type="button" aria-disabled="true" tabIndex={-1} data-tip="Snapchat — in development" className={`${base} tip tip-b cursor-not-allowed text-faint opacity-60 hover:opacity-80`}>
          <SnapMark mono className="h-4 w-4" />
          <span className="hidden sm:inline">Snapchat</span>
          <span className="animate-pulse-soft absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />
        </button>
      )}
```
4. In `Header`: `const isSnap = platform === "snapchat"; const pinned = isGoogle || isSnap;`. On Snapchat there is NO partner axis at all (our own ad account), so the switcher is replaced by a static label — change the switcher block to:

```tsx
        {isSnap ? (
          <span className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-dim" title="Snapchat runs on our own ad account — there is no partner rail to pick">
            <SnapMark className="h-3.5 w-3.5" />
            Own Snapchat ad account
          </span>
        ) : (
          <PartnerSwitcher value={partner} onChange={onPartnerChange} {...(isGoogle ? { lockedNote: "Google runs through LION (HS) only" } : {})} />
        )}
```

The two FB widgets use `!pinned` instead of `!isGoogle`; the queue button becomes `isSnap ? <SnapTaskManagerButton /> : isGoogle ? <GoogleTaskManagerButton /> : …` (rest unchanged). Update the `platform` prop comment to mention Snapchat.

- [ ] **Step 3: Mount the provider**

In `app/(app)/layout.tsx`: import `SnapTaskManagerProvider` from `@/components/snap-task-manager` and wrap `{children}` inside the Google provider:

```tsx
            <GoogleTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>
              {/* Snapchat rail queue — innermost, same reason. */}
              <SnapTaskManagerProvider user={{ username: session.username, role: session.role ?? null }}>{children}</SnapTaskManagerProvider>
            </GoogleTaskManagerProvider>
```

- [ ] **Step 4: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint components/snap-task-manager.tsx components/header.tsx "app/(app)/layout.tsx"`
Expected: no errors.

---
### Task 12: The launch card (`components/snap-launch-card.tsx`)

**Files:**
- Create: `components/snap-launch-card.tsx`

**Interfaces:**
- Consumes: Task 2 vocabulary + `snapLaunchWire` (dry-run), Task 1 landings/link/name helpers, `Dropzone`, `Select` (`./ui`), `SearchSelect`, `MultiSelect`, `COUNTRIES`/`RichOption` (`@/lib/catalog`), `limitMoneyCents`/`FileItem` (`@/lib/types`), icons.
- Produces:
  - `FIRST_SNAP_CARD_ID = "sn-1"` · `type SnapCard = { id; collapsed; suffix; adAccount; pixel; profileId; optimizationGoal; bidStrategy; bid; budget; startPaused; headline; brandName; cta; files: FileItem[]; mediaDims: { w: number; h: number } | null; geo: string[]; minAge; landingId: "dmi" | "cars" | "custom"; landingUrl; copies: string; state: "idle" | "uploading" | "sending" | "ok" | "error"; msg?; progress? }`
  - `freshSnapCard(id?: string, defaults?: { adAccount?: string; pixel?: string; profileId?: string; brandName?: string }): SnapCard` · `cloneSnapCard(src: SnapCard): SnapCard` · `snapCardCopies(card: SnapCard): number`
  - `buildSnapShot(card: SnapCard, ctx: { currency?: string; mediaUrl?: string; desiredKey?: string; accountName?: string }): SnapLaunchShotIn` (no `mediaUrl` = DRY-RUN placeholder `https://pending.local/creative.mp4`)
  - `snapCardRefusal(card: SnapCard, ctx: { pixelId?: string; profileId: string }): string | null` · `snapCardSignature(card: SnapCard): string` · `snapMediaIssue(card: SnapCard): string | null` (hard: no file / >32 MB; soft 9:16 note is rendered, not refused)
  - `SnapLaunchCard(props)` — see the component signature below.

- [ ] **Step 1: Write the card**

Create `components/snap-launch-card.tsx`:

```tsx
"use client";

// One Snapchat web-campaign card for the launcher (the Google card's structure, Snap's fields):
// SETUP (ad account · pixel · Public Profile · name tail) · DELIVERY (goal · bidding · bid ·
// budget · start paused) · CREATIVE (ONE vertical video/image ≤32 MB · headline ≤34 · brand ≤32 ·
// CTA) · TARGETING (countries + presets · min age) · LANDING (partner niche or custom https, the
// final link with the NEXT free key highlighted) · COPIES (N campaigns = N keys). Every gate is
// delegated to the SAME validator the server runs (snapLaunchWire) so the readiness dot can never
// disagree with the route's refusal. Files stay session object URLs here and ride Vercel Blob at
// launch (the board uploads, one file per card, reused by every copy).

import { useState } from "react";
import { Dropzone } from "./dropzone";
import { Select } from "./ui";
import { SearchSelect } from "./search-select";
import { MultiSelect } from "./multi-select";
import { CheckIcon, ChevronsIcon, CopyIcon, GlobeIcon, TrashIcon } from "./icons";
import { COUNTRIES, type RichOption } from "@/lib/catalog";
import { limitMoneyCents, type FileItem } from "@/lib/types";
import {
  SNAP_BID_MAX,
  SNAP_BID_STRATEGIES,
  SNAP_BRAND_MAX,
  SNAP_BUDGET_MAX,
  SNAP_CTAS,
  SNAP_DEFAULT_BUDGET,
  SNAP_GEO_PRESETS,
  SNAP_HEADLINE_MAX,
  SNAP_LANDINGS,
  SNAP_MAX_COPIES,
  SNAP_MEDIA_MAX_BYTES,
  SNAP_MIN_AGES,
  SNAP_OPTIMIZATION_GOALS,
  snapBidKind,
  snapCampaignName,
  snapCurrencySymbol,
  snapGoalNeedsPixel,
  snapLandingBase,
  snapLandingSegments,
  snapLandingUrl,
  snapLaunchWire,
  todaySaoPauloDotDDMM,
  type SnapLaunchShotIn,
} from "@/lib/snap-launch";
import type { SessionUser } from "./user-menu";

export const FIRST_SNAP_CARD_ID = "sn-1";
let cardSeq = 1;

export type SnapCard = {
  id: string;
  collapsed: boolean;
  suffix: string;
  adAccount: string;
  pixel: string;
  profileId: string;
  optimizationGoal: string;
  bidStrategy: string;
  bid: string;
  budget: string;
  startPaused: boolean;
  headline: string;
  brandName: string;
  cta: string;
  /** ONE creative (video mp4/mov or image png/jpg), session object URL until launch. */
  files: FileItem[];
  /** Pixel size read client-side after the drop (Snap wants 1080×1920, 9:16). */
  mediaDims: { w: number; h: number } | null;
  geo: string[];
  minAge: string;
  landingId: "dmi" | "cars" | "custom";
  landingUrl: string;
  /** "1".."20" — N campaigns from this card, each with its own key. */
  copies: string;
  state: "idle" | "uploading" | "sending" | "ok" | "error";
  msg?: string;
  progress?: string;
};

export function freshSnapCard(id?: string, defaults: { adAccount?: string; pixel?: string; profileId?: string; brandName?: string } = {}): SnapCard {
  return {
    id: id ?? `sn-${++cardSeq}`,
    collapsed: false,
    suffix: "",
    adAccount: defaults.adAccount ?? "",
    pixel: defaults.pixel ?? "",
    profileId: defaults.profileId ?? "",
    optimizationGoal: "PIXEL_PURCHASE",
    bidStrategy: "AUTO_BID",
    bid: "",
    budget: SNAP_DEFAULT_BUDGET,
    startPaused: false,
    headline: "",
    brandName: defaults.brandName ?? "",
    cta: "MORE",
    files: [],
    mediaDims: null,
    geo: ["US"],
    minAge: "18",
    landingId: "dmi",
    landingUrl: "",
    copies: "1",
    state: "idle",
  };
}

export function cloneSnapCard(src: SnapCard): SnapCard {
  return { ...src, id: `sn-${++cardSeq}`, collapsed: false, geo: [...src.geo], files: src.files.map((f) => ({ ...f })), state: "idle", msg: undefined, progress: undefined };
}

export function snapCardCopies(card: SnapCard): number {
  const n = Math.round(Number(card.copies) || 1);
  return Math.min(SNAP_MAX_COPIES, Math.max(1, n));
}

/** Hard creative gates: exactly one file, ≤32 MB. (9:16 is a soft note — Snap has the last word.) */
export function snapMediaIssue(card: SnapCard): string | null {
  const f = card.files[0];
  if (!f) return "Attach one vertical video (mp4/mov) or image (png/jpg)";
  if (f.kind !== "video" && f.kind !== "image") return "The creative must be a video or an image";
  if (f.size > SNAP_MEDIA_MAX_BYTES) return `Creative is ${Math.round(f.size / 1024 / 1024)} MB — Snapchat single upload takes at most 32 MB`;
  return null;
}

/** Soft 9:16 note (null when it fits or is unknown). */
export function snapDimsNote(dims: { w: number; h: number } | null): string | null {
  if (!dims || !dims.w || !dims.h) return null;
  const ratio = dims.w / dims.h;
  if (Math.abs(ratio - 9 / 16) > 0.02) return `${dims.w}×${dims.h} is not 9:16 — Snap wants 1080×1920 (it may crop or refuse)`;
  if (dims.w < 1080 || dims.h < 1920) return `${dims.w}×${dims.h} is under 1080×1920 — Snap may refuse it`;
  return null;
}

/** The wire shot (real at launch with `mediaUrl`, otherwise the DRY-RUN with a placeholder). */
export function buildSnapShot(card: SnapCard, ctx: { currency?: string; mediaUrl?: string; desiredKey?: string; accountName?: string }): SnapLaunchShotIn {
  const f = card.files[0];
  return {
    label: `Snap launch · ${ctx.accountName || "account"}`,
    adAccount: card.adAccount,
    ...(card.pixel ? { pixel: card.pixel } : {}),
    ...(card.profileId ? { profileId: card.profileId } : {}),
    optimizationGoal: card.optimizationGoal,
    bidStrategy: card.bidStrategy,
    bid: card.bid.trim(),
    budget: card.budget,
    startPaused: card.startPaused,
    headline: card.headline.trim(),
    brandName: card.brandName.trim(),
    cta: card.cta,
    mediaUrl: ctx.mediaUrl ?? (f?.kind === "image" ? "https://pending.local/creative.jpg" : "https://pending.local/creative.mp4"),
    mediaKind: f?.kind === "image" ? "image" : "video",
    ...(f?.name ? { mediaName: f.name } : {}),
    geo: card.geo,
    minAge: card.minAge,
    landingId: card.landingId,
    landingUrl: card.landingId === "custom" ? card.landingUrl.trim() : "",
    ...(ctx.desiredKey ? { desiredKey: ctx.desiredKey } : {}),
    suffix: card.suffix.trim(),
    ...(ctx.currency ? { currency: ctx.currency } : {}),
  };
}

/** The card's blocking refusal (null = launchable): creative gates first, then the shared validator. */
export function snapCardRefusal(card: SnapCard, ctx: { pixelId?: string; profileId: string }): string | null {
  const media = snapMediaIssue(card);
  if (media) return media;
  const built = snapLaunchWire(buildSnapShot(card, {}), {
    adAccountId: card.adAccount || "pending",
    pixelId: ctx.pixelId,
    profileId: ctx.profileId,
    name: "preview",
    key: "glo-snp_001",
    mediaId: "pending",
    startTimeIso: new Date(0).toISOString(),
  });
  return "refusal" in built ? built.refusal : null;
}

export function snapCardSignature(card: SnapCard): string {
  return JSON.stringify({
    a: card.adAccount,
    px: card.pixel,
    pr: card.profileId,
    g: card.optimizationGoal,
    bs: card.bidStrategy,
    bd: card.bid,
    b: card.budget,
    sp: card.startPaused,
    h: card.headline,
    br: card.brandName,
    c: card.cta,
    f: card.files.map((x) => x.id),
    geo: card.geo,
    age: card.minAge,
    l: card.landingId,
    lu: card.landingUrl,
    n: card.copies,
    s: card.suffix,
  });
}

/** Pixel size of a dropped creative (video metadata or image), null when unreadable. */
export function readMediaDims(f: FileItem): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    if (f.kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = f.url;
      return;
    }
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => resolve(null);
    v.src = f.url;
  });
}

// ---------- shared classes ----------

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";

const COUNTRY_OPTIONS = COUNTRIES.filter((c) => c.code !== "WW").map((c) => ({ value: c.code, label: c.name }));
const GOAL_OPTIONS = SNAP_OPTIMIZATION_GOALS.map((g) => ({ value: g.value, label: g.label }));
const STRATEGY_OPTIONS = SNAP_BID_STRATEGIES.map((s) => ({ value: s.value, label: s.label }));
const CTA_OPTIONS = SNAP_CTAS.map((c) => ({ value: c.value, label: c.label }));
const AGE_OPTIONS = SNAP_MIN_AGES.map((a) => ({ value: a, label: `${a}+` }));
const LANDING_OPTIONS: { key: SnapCard["landingId"]; label: string }[] = [...SNAP_LANDINGS.map((l) => ({ key: l.id, label: l.niche })), { key: "custom", label: "Custom URL" }];

function Seg<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="inline-grid grid-flow-col overflow-hidden rounded-lg border border-line bg-surface2/50 p-0.5">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" aria-pressed={on} onClick={() => onChange(o.key)} className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " + (on ? "bg-[#FFFC00]/15 text-[#f3f0a3]" : "text-dim hover:text-ink")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Counted({ label, value, onChange, max, placeholder }: { label: string; value: string; onChange: (v: string) => void; max: number; placeholder: string }) {
  const over = value.trim().length > max;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={micro}>{label}</span>
        <span className={"font-mono text-[10px] tabular-nums " + (over ? "text-warn" : "text-faint")}>
          {value.trim().length}/{max}
        </span>
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))} placeholder={placeholder} aria-label={label} className={inp + (over ? " border-warn/60 focus:border-warn focus:ring-warn/15" : "")} />
    </div>
  );
}

// ---------- the card ----------

export function SnapLaunchCard({
  card,
  index,
  user,
  accountOptions,
  pixelOptions,
  profileOptions,
  currency,
  accountName,
  effPixel,
  pixelNeeded,
  noPixel,
  refusal,
  ready,
  catalogLoading,
  nextKeys,
  highlight,
  onPatch,
  onDuplicate,
  onRemove,
  onToggleCollapse,
}: {
  card: SnapCard;
  index: number;
  user?: SessionUser;
  accountOptions: RichOption[];
  pixelOptions: RichOption[];
  profileOptions: RichOption[];
  currency: string;
  accountName: string;
  /** The pixel that will ride (the card's pick, or the account's only pixel). */
  effPixel: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  refusal: string | null;
  ready: boolean;
  catalogLoading: boolean;
  /** The keys this card's copies would take, in order (from the board's registry view). */
  nextKeys: string[];
  highlight?: boolean;
  onPatch: (id: string, p: Partial<SnapCard>) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const patch = (p: Partial<SnapCard>) => onPatch(card.id, p);
  const kind = snapBidKind(card.bidStrategy);
  const sym = snapCurrencySymbol(currency || "USD");
  const copies = snapCardCopies(card);
  const needsPixel = snapGoalNeedsPixel(card.optimizationGoal);
  const [copied, setCopied] = useState(false);
  const [dropNote, setDropNote] = useState("");

  const landingBase = card.landingId === "custom" ? (snapLandingBase(card.landingUrl)?.base ?? "") : (SNAP_LANDINGS.find((l) => l.id === card.landingId)?.url ?? "");
  const firstKey = nextKeys[0] ?? "";
  const segments = landingBase ? snapLandingSegments(landingBase, firstKey) : [];
  const stripped = card.landingId === "custom" ? (snapLandingBase(card.landingUrl)?.strippedQuery ?? false) : false;
  const niche = card.landingId === "custom" ? "Custom" : (SNAP_LANDINGS.find((l) => l.id === card.landingId)?.niche ?? "");
  const namePreview = snapCampaignName({ ddmm: todaySaoPauloDotDDMM(), niche, geoLabel: card.geo.join("+"), key: firstKey || "glo-snp_???", user: user?.username ?? "", tail: card.suffix });

  const copyLink = () => {
    if (!landingBase) return;
    void navigator.clipboard?.writeText(snapLandingUrl(landingBase, firstKey || "glo-snp_???")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const onFiles = (files: FileItem[]) => {
    const one = files.filter((f) => f.kind === "video" || f.kind === "image").slice(0, 1);
    setDropNote("");
    patch({ files: one, mediaDims: null });
    if (one[0]) void readMediaDims(one[0]).then((dims) => (dims ? patch({ mediaDims: dims }) : setDropNote("Couldn't read the creative's size — Snap will validate it")));
  };

  const geoSet = new Set(card.geo);
  const presetActive = (codes: string[]) => codes.length === card.geo.length && codes.every((c) => geoSet.has(c));
  const dimsNote = snapDimsNote(card.mediaDims);
  const stateTone = card.state === "error" ? "text-danger" : card.state === "ok" ? "text-launch2" : card.state === "uploading" || card.state === "sending" ? "text-[#9db8ff]" : "text-faint";

  return (
    <div id={`sncard-${card.id}`} className={"animate-row-in overflow-hidden rounded-2xl border bg-surface transition-shadow " + (highlight ? "border-[#FFFC00]/60 shadow-[0_0_0_2px_rgba(255,252,0,0.2)]" : "border-line")}>
      {/* header */}
      <div className="flex items-center gap-2.5 border-b border-line/70 bg-surface2/30 px-3.5 py-2.5">
        <span className="font-mono text-[12px] text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className={"h-2 w-2 shrink-0 rounded-full " + (ready ? "bg-launch2" : "bg-warn")} title={ready ? "Ready" : "Not ready"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink">Snapchat web campaign</p>
          <p className="truncate font-mono text-[10px] text-faint" title={namePreview}>
            {namePreview}
          </p>
        </div>
        <span className="hidden shrink-0 rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-faint sm:inline">
          ×{copies}
        </span>
        <button type="button" onClick={() => onToggleCollapse(card.id)} aria-label={card.collapsed ? "Expand" : "Collapse"} className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <ChevronsIcon className={"h-4 w-4 transition-transform " + (card.collapsed ? "rotate-180" : "")} />
        </button>
        <button type="button" onClick={() => onDuplicate(card.id)} aria-label="Duplicate campaign" title="Duplicate this card" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <CopyIcon className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => onRemove(card.id)} aria-label="Remove campaign" title="Remove from the wave" className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40">
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      </div>

      {card.collapsed ? (
        <div className="flex items-center gap-2 px-3.5 py-2.5 text-[11px] text-faint">
          <span className="truncate">
            {accountName || "no account"} · {niche} · {card.geo.join("+") || "no geo"} · {sym}
            {card.budget} · ×{copies}
          </span>
          {card.state !== "idle" ? <span className={"ml-auto truncate font-mono text-[10.5px] " + stateTone}>{card.msg ?? "—"}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          {/* ---- SETUP ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Ad account</span>
              <SearchSelect value={card.adAccount} onChange={(v) => patch({ adAccount: v, pixel: "" })} options={accountOptions} placeholder="Search account" metaWhenClosed warn={!card.adAccount} emptyHint={catalogLoading ? "Loading accounts…" : "No accounts"} ariaLabel="Ad account" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Pixel</span>
              <SearchSelect value={effPixel} onChange={(v) => patch({ pixel: v })} options={pixelOptions} placeholder="Search pixel" warn={pixelNeeded} emptyHint={!card.adAccount ? "Pick an account first" : "No pixels on this account"} ariaLabel="Snap Pixel" />
              <p className="text-[10px] leading-snug text-faint">
                {!card.adAccount ? "Pick an account first" : !needsPixel ? "This goal needs no pixel" : noPixel ? "No pixel — pick a non-pixel goal" : pixelNeeded ? "Several pixels — pick one" : "One pixel — auto-picked"}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Public Profile</span>
              <SearchSelect value={card.profileId} onChange={(v) => patch({ profileId: v })} options={profileOptions} placeholder="Search profile" warn={!card.profileId} emptyHint={catalogLoading ? "Loading…" : "No Public Profile — create one in Ads Manager"} ariaLabel="Public Profile" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Name tail</span>
              <input value={card.suffix} onChange={(e) => patch({ suffix: e.target.value.replace(/[\r\n]+/g, " ") })} maxLength={80} placeholder="notes (optional)" aria-label="Campaign name tail" className={inp} />
            </div>
          </div>

          {/* ---- DELIVERY ---- */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Optimization goal</span>
              <Select value={card.optimizationGoal} onChange={(e) => patch({ optimizationGoal: e.target.value })} options={GOAL_OPTIONS} aria-label="Optimization goal" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Bidding</span>
              <Select value={card.bidStrategy} onChange={(e) => patch({ bidStrategy: e.target.value, bid: snapBidKind(e.target.value) === kind ? card.bid : "" })} options={STRATEGY_OPTIONS} aria-label="Bidding strategy" />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>{card.bidStrategy === "TARGET_COST" ? "Target cost" : "Max bid"}</span>
              {kind === "bid" ? (
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-faint">{sym}</span>
                  <input value={card.bid} onChange={(e) => patch({ bid: limitMoneyCents(e.target.value, SNAP_BID_MAX) })} inputMode="decimal" placeholder="0,50" aria-label="Bid" title={`Bid in ${currency || "USD"} — digits fill cents (50 → 0,50)`} className={inp + " pl-8"} />
                </div>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-line bg-surface2/40 px-3 text-[11.5px] text-faint">Automatic — Snap sets the bid</div>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Daily budget</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint">{sym}</span>
                <input value={card.budget} onChange={(e) => patch({ budget: limitMoneyCents(e.target.value, SNAP_BUDGET_MAX) })} inputMode="decimal" placeholder={SNAP_DEFAULT_BUDGET} aria-label="Daily budget" title="Daily budget — digits fill cents (1000 → 10,00); Snap's floor is 5/day" className={inp + " pl-8"} />
              </div>
              <label className="flex w-fit cursor-pointer items-center gap-2 pt-1 text-[11px] text-dim">
                <input type="checkbox" checked={card.startPaused} onChange={(e) => patch({ startPaused: e.target.checked })} className="h-3.5 w-3.5 accent-[#FFFC00]" />
                Start paused (review in Ads Manager first)
              </label>
            </div>
          </div>

          {/* ---- CREATIVE ---- */}
          <section className="grid gap-3 border-t border-line/60 pt-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className={micro}>Creative</span>
                <span className="font-mono text-[10px] text-faint">{card.files[0] ? `${Math.round(card.files[0].size / 1024 / 1024)} MB` : "9:16 · ≤32 MB"}</span>
              </div>
              <Dropzone id={`media-${card.id}`} files={card.files} onChange={onFiles} maxFiles={1} accept="any" compact />
              {dimsNote ? <p className="text-[10px] leading-snug text-warn">{dimsNote}</p> : card.mediaDims ? <p className="text-[10px] leading-snug text-faint">{card.mediaDims.w}×{card.mediaDims.h} · 9:16 ✓</p> : <p className="text-[10px] leading-snug text-faint">One vertical video (mp4/mov, 3–180 s) or image (png/jpg), 1080×1920.</p>}
              {dropNote ? <p className="text-[10px] leading-snug text-warn">{dropNote}</p> : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Counted label="Headline" value={card.headline} onChange={(v) => patch({ headline: v })} max={SNAP_HEADLINE_MAX} placeholder="Drive it home today" />
              <Counted label="Brand name" value={card.brandName} onChange={(v) => patch({ brandName: v })} max={SNAP_BRAND_MAX} placeholder="GC" />
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Call to action</span>
                <Select value={card.cta} onChange={(e) => patch({ cta: e.target.value })} options={CTA_OPTIONS} aria-label="Call to action" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className={micro}>Minimum age</span>
                <Select value={card.minAge} onChange={(e) => patch({ minAge: e.target.value })} options={AGE_OPTIONS} aria-label="Minimum age" />
              </div>
            </div>
          </section>

          {/* ---- TARGETING ---- */}
          <section className="flex flex-col gap-1.5">
            <span className={micro}>Countries</span>
            <MultiSelect id={`geo-${card.id}`} values={card.geo} onChange={(v) => patch({ geo: v })} options={COUNTRY_OPTIONS} placeholder="Countries — Snapchat has no worldwide targeting" chipMode="code" />
            <div className="flex flex-wrap gap-1">
              {SNAP_GEO_PRESETS.map((p) => {
                const on = presetActive(p.codes);
                return (
                  <button key={p.label} type="button" onClick={() => patch({ geo: [...p.codes] })} aria-pressed={on} className={"rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 active:scale-95 " + (on ? "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]" : "border-line bg-surface2 text-dim hover:border-line2 hover:text-ink")}>
                    {p.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ---- LANDING ---- */}
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className={micro}>Landing</span>
              <Seg options={LANDING_OPTIONS} value={card.landingId} onChange={(k) => patch({ landingId: k })} />
            </div>
            {card.landingId === "custom" ? (
              <div className="relative">
                <GlobeIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <input value={card.landingUrl} onChange={(e) => patch({ landingUrl: e.target.value.trim() })} placeholder="https://…" aria-label="Custom landing URL" className={inp + " pl-9"} />
              </div>
            ) : null}
            {segments.length ? (
              <div className="overflow-hidden rounded-lg border border-line bg-surface2/50">
                <div className="max-h-24 select-all overflow-y-auto break-all px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {segments.map((seg, i) => (
                    <span key={i} className={seg.role === "landing" ? "text-ink" : seg.role === "key" ? "font-semibold text-[#f3f0a3]" : seg.role === "sccid" ? "text-faint/60" : "text-faint"}>
                      {seg.text}
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line bg-surface/50 px-2 py-1.5">
                  <span className="select-none font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                    Final link · key {firstKey || "next free"}{stripped ? " · pasted query dropped" : ""}
                    {card.landingId === "custom" ? " · revenue is reported only for the partner's pages" : ""}
                  </span>
                  <button type="button" onClick={copyLink} aria-label="Copy the final link" className={"group inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-all duration-200 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " + (copied ? "animate-copy-flash border-launch/40 bg-launch/15 text-launch2" : "border-line2 bg-raise text-dim hover:border-accent/50 hover:bg-accent/10 hover:text-ink")}>
                    {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          {/* ---- COPIES ---- */}
          <section className="flex flex-wrap items-center gap-3 border-t border-line/60 pt-4">
            <span className={micro}>Copies</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => patch({ copies: String(Math.max(1, copies - 1)) })} disabled={copies <= 1} className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="Fewer copies">
                −
              </button>
              <input value={card.copies} onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
                patch({ copies: raw !== "" && Number(raw) > SNAP_MAX_COPIES ? String(SNAP_MAX_COPIES) : raw });
              }} inputMode="numeric" aria-label="Number of copies" className={inp + " w-14 text-center"} />
              <button type="button" onClick={() => patch({ copies: String(Math.min(SNAP_MAX_COPIES, copies + 1)) })} disabled={copies >= SNAP_MAX_COPIES} className="h-8 w-8 rounded-lg border border-line bg-surface2 text-[13px] text-dim hover:text-ink disabled:opacity-40" aria-label="More copies">
                +
              </button>
            </div>
            <span className="text-[11px] text-faint">
              {copies} campaign{copies === 1 ? "" : "s"} · keys {nextKeys.length ? nextKeys.join(", ") : "—"}
            </span>
          </section>

          {card.state === "idle" && refusal ? <p className="text-[11px] leading-snug text-warn">{refusal}</p> : null}
          {card.state !== "idle" ? <p className={"break-words font-mono text-[11px] leading-snug " + stateTone}>{card.state === "uploading" ? card.progress ?? "Uploading…" : card.state === "sending" ? "Submitting…" : card.msg ?? "—"}</p> : null}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint components/snap-launch-card.tsx`
Expected: no errors. (`readMediaDims` uses `Image`/`document` — client component, fine.)

---
### Task 13: The launch board + `/snap` page

**Files:**
- Create: `components/snap-launch-board.tsx`
- Create: `app/(app)/snap/page.tsx`

**Interfaces:**
- Consumes: Task 12 card API, Task 10 hooks (`useSnapCatalog`, `useSnapKeys`), Task 11 (`useSnapTaskManager`), Task 9 (`SnapNav`, `SNAP_ENABLED`), `Header` (Task 11 wiring), `readCreative`/`uploadCreativeFile`/`safeBlobName` (`components/blob-uploader.ts`), `UploadingNotice`/`useUnloadGuard` (`components/upload-guard.tsx`), `makeGate` (`lib/launch-guards.ts`), `moneyLabel`/`parseMoney` (`lib/types.ts`), `SNAP_MAX_SHOTS`, `snapGoalNeedsPixel`, `snapCurrencySymbol` (Task 2), `POST /api/snap/launch` (Task 8).
- Produces: `SnapLaunchBoard({ user }: { user?: SessionUser })`; the page at `/snap`.

- [ ] **Step 1: Write the board**

Create `components/snap-launch-board.tsx`:

```tsx
"use client";

// Snapchat LAUNCH board — the Google launcher's shape: a column of campaign CARDS on the left, a
// sticky Launch bay on the right (readiness per card, keys the wave takes, total/day, Preview →
// Launch). One card = N copies = N campaigns = N partner keys. The create is SERVER-side: one POST
// /api/snap/launch stamps the rows and an after() pump builds every campaign on Snapchat, so once
// the wave is accepted the tab is safe to close. The one client-side phase is the creative UPLOAD
// (one file per card → Vercel Blob, reused by every copy) — the unload guard + notice mount then.
// Gating is delegated to snapLaunchWire (the server's own validator) so the bay can never disagree
// with the route's refusal; the keys gate mirrors the registry (free keys ≥ shots).

import { useRef, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { useSnapCatalog, useSnapKeys, type SnapCatalogAccount } from "./use-snap";
import { useSnapTaskManager } from "./snap-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { moneyLabel, parseMoney } from "@/lib/types";
import { SNAP_MAX_SHOTS, snapCurrencySymbol, snapGoalNeedsPixel, type SnapLaunchShotIn } from "@/lib/snap-launch";
import { readCreative, safeBlobName, uploadCreativeFile } from "./blob-uploader";
import { UploadingNotice, useUnloadGuard } from "./upload-guard";
import { CopyIcon, EyeIcon, PlusIcon } from "./icons";
import { FIRST_SNAP_CARD_ID, SnapLaunchCard, buildSnapShot, cloneSnapCard, freshSnapCard, snapCardCopies, snapCardRefusal, snapCardSignature, type SnapCard } from "./snap-launch-card";
import type { RichOption } from "@/lib/catalog";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

const MAX_CARDS = 45;

type CardView = {
  card: SnapCard;
  account: SnapCatalogAccount | null;
  currency: string;
  effPixel: string;
  pixelNeeded: boolean;
  noPixel: boolean;
  profileId: string;
  refusal: string | null;
  ready: boolean;
  why: string;
  copies: number;
  keys: string[];
  pixelOptions: RichOption[];
};

export function SnapLaunchBoard({ user }: { user?: SessionUser }) {
  const { catalog, error: catError, retry: retryCatalog } = useSnapCatalog();
  const { keys, error: keysError, refresh: refreshKeys } = useSnapKeys();
  const { setOpen, counts, refresh } = useSnapTaskManager();

  const defaults = catalog?.defaults;
  const [cards, setCards] = useState<SnapCard[]>(() => [freshSnapCard(FIRST_SNAP_CARD_ID)]);
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const fireGate = useRef(makeGate());
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  const username = user?.username ?? "";

  const accountById = new Map((catalog?.accounts ?? []).map((a) => [a.id, a]));
  const catalogLoading = catalog === null && !catError;
  const accountOptions: RichOption[] = (catalog?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name || a.id,
    subLabel: a.id,
    meta: a.currency,
    tag: a.pixelsError ? "px ?" : `${a.pixels.length} px`,
    tagTone: a.pixels.length === 0 ? "warn" : "dim",
  }));
  const profileOptions: RichOption[] = (catalog?.profiles ?? []).map((p) => ({ value: p.id, label: p.displayName || p.id, subLabel: p.id }));
  const pixelOptionsFor = (a: SnapCatalogAccount | null): RichOption[] => (a?.pixels ?? []).map((p) => ({ value: p.id, label: p.name || p.id, subLabel: p.id }));

  const patch = (id: string, p: Partial<SnapCard>) => {
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
    setPreviewed(false);
  };
  const setCardState = (id: string, p: Partial<SnapCard>) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const fresh = () => freshSnapCard(undefined, { adAccount: defaults?.adAccount, pixel: defaults?.pixel, profileId: defaults?.profile, brandName: defaults?.brandName });
  const add = () => {
    setCards((cs) => (cs.length >= MAX_CARDS ? cs : [...cs, fresh()]));
    setPreviewed(false);
  };
  const duplicate = (id: string) => {
    setCards((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1 || cs.length >= MAX_CARDS) return cs;
      return [...cs.slice(0, i + 1), cloneSnapCard(cs[i]), ...cs.slice(i + 1)];
    });
    setPreviewed(false);
  };
  const remove = (id: string) => {
    setCards((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
    setPreviewed(false);
  };
  const toggleCollapse = (id: string) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)));

  // ---- per-card derived view; keys are handed out in card order from the registry's free list ----
  let keyCursor = 0;
  const freeKeys = keys?.free ?? [];
  const view: CardView[] = cards.map((card) => {
    const account = card.adAccount ? (accountById.get(card.adAccount) ?? null) : null;
    const currency = account?.currency ?? "";
    const needsPixel = snapGoalNeedsPixel(card.optimizationGoal);
    const effPixel = card.pixel || (account && account.pixels.length === 1 ? account.pixels[0].id : "") || (account && defaults?.pixel && account.pixels.some((p) => p.id === defaults.pixel) ? defaults.pixel : "");
    const pixelNeeded = Boolean(needsPixel && account && account.pixels.length > 1 && !effPixel);
    const noPixel = Boolean(needsPixel && account && account.pixels.length === 0);
    const profileId = card.profileId || defaults?.profile || "";
    const refusal = snapCardRefusal(card, { pixelId: effPixel || undefined, profileId });
    const copies = snapCardCopies(card);
    const ready = Boolean(card.adAccount && account && !pixelNeeded && !noPixel && !refusal);
    const cardKeys = ready ? freeKeys.slice(keyCursor, keyCursor + copies) : [];
    if (ready) keyCursor += copies;
    const why = !card.adAccount ? "pick an ad account" : !account ? "account not in our list" : noPixel ? "no pixel on this account — pick a non-pixel goal" : pixelNeeded ? "pick a Snap Pixel" : refusal ? refusal : "";
    return { card, account, currency, effPixel, pixelNeeded, noPixel, profileId, refusal, ready, why, copies, keys: cardKeys, pixelOptions: pixelOptionsFor(account) };
  });

  const readyViews = view.filter((v) => v.ready);
  const totalShots = readyViews.reduce((n, v) => n + v.copies, 0);
  const overShotCap = totalShots > SNAP_MAX_SHOTS;
  const keysShort = keys !== null && freeKeys.length < totalShots;
  const totalsByCur = new Map<string, number>();
  for (const v of readyViews) totalsByCur.set(v.currency || "USD", (totalsByCur.get(v.currency || "USD") ?? 0) + parseMoney(v.card.budget) * v.copies);

  const uploadingN = cards.filter((c) => c.state === "uploading").length;
  useUnloadGuard(uploadingN > 0);
  const fireBlocked = firing || readyViews.length === 0 || catalogLoading || Boolean(catError) || overShotCap || keysShort || keys === null;

  const jumpTo = (id: string) => {
    setCards((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null);
    window.setTimeout(() => {
      document.getElementById(`sncard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  // ---- fire: upload each ready card's creative once, fan the copies out, one POST ----
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const ready = view.filter((v) => v.ready);
    const sig = JSON.stringify(ready.map((v) => snapCardSignature(v.card)));
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    const waveId = waveRef.current.id;
    try {
      const shots: SnapLaunchShotIn[] = [];
      const shotCard: string[] = [];
      for (const v of ready) {
        const c = v.card;
        const f = c.files[0];
        if (!f) continue;
        let mediaUrl = "";
        setCardState(c.id, { state: "uploading", progress: "Uploading the creative…" });
        try {
          const file = await readCreative(f.url, f.name, f.kind === "image" ? "image" : "video", "Creative");
          mediaUrl = await uploadCreativeFile(`snap/${username}/${waveId}/${c.id}-${safeBlobName(f.name, f.kind === "image" ? "creative.jpg" : "creative.mp4")}`, file, "Creative");
        } catch (e) {
          setCardState(c.id, { state: "error", msg: String((e as Error).message ?? e) });
          continue;
        }
        for (let j = 0; j < v.copies; j++) {
          shots.push(buildSnapShot(c, { currency: v.currency, mediaUrl, desiredKey: v.keys[j], accountName: v.account?.name }));
          shotCard.push(c.id);
        }
        setCardState(c.id, { state: "sending", msg: "queuing on server…" });
      }
      if (shots.length === 0) {
        setFireNote("Nothing was launched — every card failed to upload its creative. Re-attach the files and try again.");
        return;
      }
      const res = await fetch("/api/snap/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ waveId, shots }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null;
        setPreviewed(false);
        for (const id of new Set(shotCard)) setCardState(id, { state: "ok", msg: "queued — safe to close the tab (the server builds it)" });
        refresh();
        refreshKeys();
        setOpen(true);
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        setFireNote(msg);
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotCard[Number(m[1]) - 1] : null;
        for (const id of new Set(shotCard)) setCardState(id, culprit ? (id === culprit ? { state: "error", msg } : { state: "error", msg: "wave refused — fix the flagged card" }) : { state: "error", msg });
      }
    } catch (e) {
      setFireNote(String((e as Error).message ?? e));
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const noAccountCount = view.filter((v) => !v.card.adAccount).length;
  const pixelNeededCount = view.filter((v) => v.pixelNeeded || v.noPixel).length;
  const refusalCount = view.filter((v) => v.card.adAccount && v.account && !v.pixelNeeded && !v.noPixel && v.refusal).length;

  return (
    <>
      <Header partner="in" onPartnerChange={changePartner} user={user} platform="snapchat" />
      <SnapNav active="launch" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 xl:px-6">
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{cards.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">Snap Ads · web</span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={add} disabled={cards.length >= MAX_CARDS} className="flex h-9 items-center gap-2 rounded-lg border border-[#FFFC00]/40 bg-[#FFFC00]/10 px-3.5 text-[13px] font-semibold text-[#f3f0a3] transition-all duration-150 hover:bg-[#FFFC00]/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>
            {view.map((v, i) => (
              <SnapLaunchCard
                key={v.card.id}
                card={v.card}
                index={i}
                user={user}
                accountOptions={accountOptions}
                pixelOptions={v.pixelOptions}
                profileOptions={profileOptions}
                currency={v.currency}
                accountName={v.account?.name ?? ""}
                effPixel={v.effPixel}
                pixelNeeded={v.pixelNeeded}
                noPixel={v.noPixel}
                refusal={v.refusal}
                ready={v.ready}
                catalogLoading={catalogLoading}
                nextKeys={v.keys}
                highlight={highlightId === v.card.id}
                onPatch={patch}
                onDuplicate={duplicate}
                onRemove={remove}
                onToggleCollapse={toggleCollapse}
              />
            ))}
            <button type="button" onClick={add} disabled={cards.length >= MAX_CARDS} className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line2 py-3 text-[13px] font-medium text-dim transition-all duration-200 hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="flex shrink-0 items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Launch bay</span>
                <span className={"rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] " + (readyViews.length === cards.length ? "border-launch/30 bg-launch/10 text-launch2" : "border-warn/25 bg-warn/5 text-warn")}>
                  {readyViews.length}/{cards.length} ready
                </span>
              </div>
              <p className="text-[10.5px] leading-snug text-faint">Each copy takes one partner key and becomes its own campaign, born PAUSED and activated once the ad exists. Creative uploads run from this tab; keep it open until they finish.</p>
              <div className="-mx-2 flex flex-col">
                {view.map((v, i) => (
                  <button key={v.card.id} type="button" onClick={() => jumpTo(v.card.id)} title="Jump to this campaign" className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <span className="w-5 shrink-0 font-mono text-[10.5px] text-faint group-hover:text-[#f3f0a3]">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{v.account?.name || "No account"}</span>
                      <span className={"block truncate text-[10.5px] " + (v.ready ? "text-faint" : "text-warn")}>{v.ready ? `×${v.copies} · ${v.keys.join(", ") || "keys pending"}` : v.why}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-dim">
                      {snapCurrencySymbol(v.currency || "USD")}
                      {moneyLabel(v.card.budget)}
                    </span>
                    <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (v.ready ? "bg-launch2" : "bg-warn")} />
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Campaigns</span>
                  <span className="font-mono tabular-nums">{totalShots}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-faint">Free keys</span>
                  <span className={"font-mono tabular-nums " + (keysShort ? "text-warn" : "")}>{keys ? `${freeKeys.length}/${keys.poolMax}` : keysError ? "?" : "…"}</span>
                </div>
                {[...totalsByCur.entries()].map(([cur, total]) => (
                  <div key={cur} className="flex items-center justify-between">
                    <span className="text-faint">Total/day{totalsByCur.size > 1 ? ` (${cur})` : ""}</span>
                    <span className="font-mono tabular-nums">
                      {snapCurrencySymbol(cur)}
                      {moneyLabel(total)}
                    </span>
                  </div>
                ))}
              </div>
              <UploadingNotice n={uploadingN} compact />
              <button type="button" onClick={() => { setPreviewed(true); setFireNote(null); }} disabled={readyViews.length === 0} className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>
              {previewed ? (
                <button type="button" onClick={() => void fireWave()} disabled={fireBlocked} className="animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2">
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Launching…" : `Launch ${totalShots}`}
                </button>
              ) : null}
              {fireNote ? <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">{fireNote}</div> : null}
              {catError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the Snapchat accounts — {catError}.</span>
                  <button type="button" onClick={retryCatalog} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Retry
                  </button>
                </div>
              ) : null}
              {keysError ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t read the key registry — {keysError}.</span>
                  <button type="button" onClick={refreshKeys} className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    Retry
                  </button>
                </div>
              ) : null}
              {catalog?.profilesError ? <p className="text-center text-[10.5px] leading-relaxed text-warn">Public Profiles didn&apos;t load ({catalog.profilesError}) — set SNAP_PROFILE_ID or retry.</p> : null}
              {noAccountCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{noAccountCount} campaign{noAccountCount === 1 ? " needs" : "s need"} an ad account.</p> : null}
              {pixelNeededCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{pixelNeededCount} campaign{pixelNeededCount === 1 ? " needs" : "s need"} a pixel decision — see the card.</p> : null}
              {refusalCount > 0 ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{refusalCount} campaign{refusalCount === 1 ? " is" : "s are"} incomplete — see the note on the card.</p> : null}
              {overShotCap ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">{totalShots} campaigns — one wave carries at most {SNAP_MAX_SHOTS}. Lower the copies or split into two waves.</p> : null}
              {keysShort ? <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">Only {freeKeys.length} free key{freeKeys.length === 1 ? "" : "s"} for {totalShots} campaigns — release keys on the Keys page or lower the copies.</p> : null}
              {previewed ? (
                <div className="animate-pop-in flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/40 p-3">
                  <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                  {readyViews.map((v) => (
                    <p key={v.card.id} className="text-[11.5px] leading-snug text-dim">
                      <span className="text-ink">{v.account?.name}</span> → ×{v.copies} · {snapCurrencySymbol(v.currency || "USD")}
                      {moneyLabel(v.card.budget)}/day · {v.card.geo.join("+")} · <span className="text-[#f3f0a3]">{v.keys.join(", ")}</span>
                    </p>
                  ))}
                  <div className="mt-1 border-t border-line pt-1.5 text-[11.5px] text-ink">{totalShots} campaign{totalShots === 1 ? "" : "s"} · fires ONE wave · the tab is safe to close once accepted (uploads finish first).</div>
                </div>
              ) : null}
              {counts.active > 0 ? <p className="text-center text-[10.5px] leading-relaxed text-faint">{counts.active} Snapchat build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.</p> : null}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Write the page**

Create `app/(app)/snap/page.tsx`:

```tsx
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { SNAP_ENABLED } from "@/lib/partners";
import { SnapLaunchBoard } from "@/components/snap-launch-board";

export const metadata: Metadata = {
  title: "Snapchat — launch — Ad Launcher",
};

export default async function SnapLaunchPage() {
  const jar = await cookies();
  const session = verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  // Dormant on prod (NEXT_PUBLIC_SNAP_ENABLED unset there): a stale link must not open a
  // half-wired board — bounce to the launcher home.
  if (!SNAP_ENABLED) redirect("/");

  return (
    <>
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-44 left-1/2 h-[480px] w-[920px] -translate-x-1/2 rounded-full bg-[#FFFC00]/[0.05] blur-[120px]" />
        <div className="absolute -top-24 right-[8%] h-[320px] w-[440px] rounded-full bg-accent2/[0.06] blur-[110px]" />
        <div
          className={
            "absolute inset-x-0 top-0 h-[540px] " +
            "bg-[linear-gradient(rgba(255,255,255,0.028)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.028)_1px,transparent_1px)] " +
            "bg-[size:44px_44px] " +
            "[mask-image:radial-gradient(ellipse_60%_60%_at_50%_0%,black,transparent)]"
          }
        />
      </div>
      <SnapLaunchBoard user={{ username: session.username, role: session.role ?? null, owner: isOwnerSession(session) }} />
    </>
  );
}
```

- [ ] **Step 3: Type-check + lint + a first render**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint components/snap-launch-board.tsx "app/(app)/snap/page.tsx"`
Expected: no errors. Then `npx next dev -p 3124`, sign in, open `http://localhost:3124/snap` (with the Task 9 env + the mock from Task 16 running, or without it — the bay then shows the "Couldn't load the Snapchat accounts" retry state, which is the expected dormant-credentials behaviour).

---
### Task 14: The keys + report page

**Files:**
- Create: `components/snap-keys-board.tsx`
- Create: `app/(app)/snap/keys/page.tsx`

**Interfaces:**
- Consumes: `GET /api/snap/report?date=` (Task 7), `GET/DELETE /api/snap/keys` (Task 6), `useSnapKeys` (Task 10), `SnapNav`, `Header`, `snapKeyPool` (Task 1), `SnapReportMetrics` (Task 3 type), `SnapKeyRow` (Task 6 type).
- Produces: `SnapKeysBoard({ user })`; the page at `/snap/keys`.

- [ ] **Step 1: Write the board**

Create `components/snap-keys-board.tsx`:

```tsx
"use client";

// Snapchat KEYS · REPORT page — the 100 partner keys as one table: who holds each (registry),
// what it earned on the picked São Paulo day (LION's report: revenue, forecast while the day is
// partial, impressions, eCPM, visitors, pixel events, conversions) and, for the owner, a Release
// button that deletes the registry row (Snapchat itself is never touched here — pause/delete the
// campaign in Ads Manager). Today is partial + forecast; earlier days are final.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./header";
import { SnapNav } from "./snap-nav";
import { useSnapKeys, type SnapKeyRow } from "./use-snap";
import type { SnapReportMetrics } from "@/lib/snap-report";
import { CheckIcon, CopyIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

type ReportRow = { key: string; metrics: SnapReportMetrics; binding: SnapKeyRow | null };
type Report = { date: string; partial: boolean; affiliate: string; totals: SnapReportMetrics; rows: ReportRow[]; registryError?: string };
type StatusFilter = "all" | "free" | "active" | "retired";

const money = (v: number) => `$${v.toFixed(2)}`;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const dateLabel = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3.$2.$1");

export function SnapKeysBoard({ user }: { user?: SessionUser }) {
  const { keys, error: keysError, refresh: refreshKeys } = useSnapKeys();
  const [dateParam, setDateParam] = useState<"today" | "yesterday" | string>("yesterday");
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [releasing, setReleasing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadReport = useCallback(async (param: string) => {
    setLoading(true);
    setReportError(null);
    try {
      const res = await fetch(`/api/snap/report?date=${encodeURIComponent(param)}`, { signal: AbortSignal.timeout(60_000) });
      const d = (await res.json().catch(() => ({}))) as Partial<Report> & { ok?: boolean; error?: string };
      if (!res.ok || !d.ok || !Array.isArray(d.rows)) throw new Error(d.error || `HTTP ${res.status}`);
      setReport({ date: String(d.date), partial: Boolean(d.partial), affiliate: String(d.affiliate ?? ""), totals: d.totals as SnapReportMetrics, rows: d.rows as ReportRow[], ...(d.registryError ? { registryError: String(d.registryError) } : {}) });
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The fetch resolves later (an async callback update) — the analyzer can't see through it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReport(dateParam);
  }, [dateParam, loadReport]);

  // The registry view wins for bindings (it refreshes after a release); the report brings the money.
  const bindingByKey = useMemo(() => new Map((keys?.used ?? []).map((r) => [r.key, r])), [keys]);
  const rows = useMemo(() => {
    const base = report?.rows ?? (keys ? keys.free.concat(keys.used.map((r) => r.key)).sort().map((key) => ({ key, metrics: null as SnapReportMetrics | null, binding: null })) : []);
    return base.map((r) => ({ key: r.key, metrics: r.metrics, binding: bindingByKey.get(r.key) ?? r.binding ?? null }));
  }, [report, keys, bindingByKey]);
  const shown = rows.filter((r) => (filter === "all" ? true : filter === "free" ? !r.binding : r.binding?.status === filter));
  const freeCount = rows.filter((r) => !r.binding).length;
  const activeCount = rows.filter((r) => r.binding?.status === "active").length;
  const retiredCount = rows.filter((r) => r.binding?.status === "retired").length;

  const release = async (key: string) => {
    if (!window.confirm(`Release ${key}? The registry row is deleted and the key returns to the pool. The Snapchat campaign is NOT touched — pause it in Ads Manager if it still runs.`)) return;
    setReleasing(key);
    try {
      const res = await fetch(`/api/snap/keys?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
      refreshKeys();
      void loadReport(dateParam);
    } catch (e) {
      window.alert(`Release failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReleasing(null);
    }
  };

  const copyFree = () => {
    const free = rows.filter((r) => !r.binding).map((r) => r.key).join("\n");
    void navigator.clipboard?.writeText(free).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const chip = "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors";
  const on = "border-[#FFFC00]/50 bg-[#FFFC00]/10 text-[#f3f0a3]";
  const off = "border-line bg-surface2 text-dim hover:text-ink";

  return (
    <>
      <Header partner="in" onPartnerChange={changePartner} user={user} platform="snapchat" />
      <SnapNav active="keys" />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pb-24 pt-6 sm:px-5 xl:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-semibold text-ink">Partner keys</h1>
            <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{keys ? `${freeCount} free · ${activeCount} active · ${retiredCount} retired` : keysError ? "registry unavailable" : "…"}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-0.5">
                {(["yesterday", "today"] as const).map((p) => (
                  <button key={p} type="button" onClick={() => setDateParam(p)} className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium " + (dateParam === p ? "bg-[#FFFC00]/15 text-[#f3f0a3]" : "text-dim hover:text-ink")}>
                    {p === "today" ? "Today (partial)" : "Yesterday"}
                  </button>
                ))}
                <input type="date" value={/^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : ""} onChange={(e) => e.target.value && setDateParam(e.target.value)} aria-label="Report date" className="h-7 rounded-md border border-line bg-surface2 px-2 text-[11.5px] text-ink" />
              </div>
              <button type="button" onClick={copyFree} className={chip + " " + off}>
                {copied ? <CheckIcon className="mr-1 inline h-3 w-3 text-launch2" /> : <CopyIcon className="mr-1 inline h-3 w-3" />}
                {copied ? "Copied" : "Copy free keys"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["all", "free", "active", "retired"] as StatusFilter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={chip + " " + (filter === f ? on : off)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-faint">
              {report ? `${dateLabel(report.date)} · ${report.partial ? "partial day — includes the partner's forecast" : "final"} · LION` : loading ? "Loading the report…" : reportError ? `Report: ${reportError}` : ""}
              {report?.registryError ? ` · registry: ${report.registryError}` : ""}
            </span>
          </div>

          {report ? (
            <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {[
                ["Revenue", money(report.totals.revenue)],
                ["Forecast", report.partial ? money(report.totals.forecastedRevenue) : "—"],
                ["Impressions", int(report.totals.impressions)],
                ["eCPM", money(report.totals.ecpm)],
                ["Visitors", int(report.totals.visitors)],
                ["Triggered", int(report.totals.triggered)],
                ["Fired", int(report.totals.fired)],
                ["Conversions", int(report.totals.conversions)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line bg-surface px-3 py-2">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</p>
                  <p className="font-mono text-[14px] tabular-nums text-ink">{value}</p>
                </div>
              ))}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full text-[12px]">
              <thead className="bg-surface2/50 text-[10px] uppercase tracking-[0.12em] text-faint">
                <tr>
                  {["Key", "Status", "Campaign", "Buyer", "Claimed", "Revenue", "Impr.", "eCPM", "Visitors", "Trig/Fired", "Conv.", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const b = r.binding;
                  const m = r.metrics;
                  return (
                    <tr key={r.key} className="border-t border-line/60 hover:bg-raise/40">
                      <td className="px-3 py-2 font-mono text-[#f3f0a3]">{r.key}</td>
                      <td className="px-3 py-2">
                        <span className={"rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase " + (!b ? "bg-surface2 text-faint" : b.status === "active" ? "bg-launch/15 text-launch2" : "bg-warn/15 text-warn")}>{b ? b.status : "free"}</span>
                      </td>
                      <td className="max-w-[360px] px-3 py-2">
                        {b ? (
                          <div className="min-w-0">
                            <p className="truncate text-ink" title={b.name || ""}>
                              {b.name || b.niche || "—"}
                            </p>
                            <p className="truncate font-mono text-[10px] text-faint">
                              {b.campaign_id ? `cmp ${b.campaign_id}` : "no campaign id"}
                              {b.notes ? ` · ${b.notes}` : ""}
                            </p>
                          </div>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-dim">{b?.user || "—"}</td>
                      <td className="px-3 py-2 font-mono text-[10.5px] text-faint">{b?.claimed_at ? new Date(b.claimed_at).toLocaleDateString("en-GB") : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-ink">
                        {m ? money(m.revenue) : "—"}
                        {m && report?.partial && m.forecastedRevenue ? <span className="text-faint"> / {money(m.forecastedRevenue)}</span> : null}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.impressions) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? money(m.ecpm) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.visitors) : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? `${int(m.triggered)}/${int(m.fired)}` : "—"}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-dim">{m ? int(m.conversions) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {b && user?.owner ? (
                          <button type="button" onClick={() => void release(r.key)} disabled={releasing === r.key} className="rounded-md border border-danger/30 px-2 py-1 text-[10.5px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50">
                            {releasing === r.key ? "Releasing…" : "Release"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-3 py-8 text-center text-[12px] text-faint">
                      {keysError ? `Registry unavailable — ${keysError}` : "Nothing to show"}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-[10.5px] leading-relaxed text-faint">Release deletes the registry row only. A retired key still owns a campaign shell on Snapchat (PAUSED) — clean it in Ads Manager, then release. Revenue is reported per key by the partner through LION; today is partial and carries the partner&apos;s forecast, a day is final the next morning.</p>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Write the page**

Create `app/(app)/snap/keys/page.tsx` — identical to `app/(app)/snap/page.tsx` (Task 13) with `title: "Snapchat — keys & report — Ad Launcher"`, the import `SnapKeysBoard` from `@/components/snap-keys-board`, the function name `SnapKeysPage`, and `<SnapKeysBoard user={…} />` in place of the launch board.

- [ ] **Step 3: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint components/snap-keys-board.tsx "app/(app)/snap/keys/page.tsx"`
Expected: no errors.

---
### Task 15: Owner-only OAuth helper (mint the refresh token)

**Files:**
- Create: `lib/snap-oauth.ts`, `app/api/snap/oauth/start/route.ts`, `app/api/snap/oauth/callback/route.ts`

**Interfaces:**
- Consumes: `snapAuthorizeUrl`, `snapExchangeCode`, `snapRailEnabled` (Task 5), `sessionFromCookieHeader`, `isOwnerSession`, `AUTH_SECRET`.
- Produces: `GET /api/snap/oauth/start` → 302 to Snap's consent page; `GET /api/snap/oauth/callback?code&state` → an HTML page showing the refresh token to paste into `.env.local`. Never stores or logs the token.

- [ ] **Step 1: Write the state helper**

Create `lib/snap-oauth.ts`:

```ts
// Snapchat rail — the one-time OAuth dance that mints the REFRESH TOKEN the rail runs on. Owner
// only. The token is shown once in the browser and pasted into .env.local by hand (single-account
// rail → no vault); the same page is how it gets rotated. State = HMAC-signed nonce in a
// short-lived cookie so a forged callback can't hand the owner someone else's code.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET = process.env.AUTH_SECRET ?? "";
export const SNAP_OAUTH_STATE_COOKIE = "snap_oauth_state";

/** The client app pair exists before any refresh token does — this is the helper's own gate. */
export const snapClientConfigured = (): boolean => Boolean(process.env.SNAP_CLIENT_ID && process.env.SNAP_CLIENT_SECRET);

export function snapOauthRedirectUri(req: Request): string {
  return process.env.SNAP_OAUTH_REDIRECT_URI || `${new URL(req.url).origin}/api/snap/oauth/callback`;
}

export function signOauthState(): string {
  const nonce = randomBytes(16).toString("hex");
  return `${nonce}.${createHmac("sha256", SECRET).update(nonce).digest("hex")}`;
}

export function verifyOauthState(state: string | null, cookie: string | null): boolean {
  if (!SECRET || !state || !cookie || state !== cookie) return false;
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = createHmac("sha256", SECRET).update(nonce).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
```

- [ ] **Step 2: Write the start route**

Create `app/api/snap/oauth/start/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapAuthorizeUrl, snapRailEnabled } from "@/lib/snap-api";
import { SNAP_OAUTH_STATE_COOKIE, signOauthState, snapClientConfigured, snapOauthRedirectUri } from "@/lib/snap-oauth";

export const runtime = "nodejs";

/** GET → 302 to Snapchat's consent page (scope snapchat-marketing-api). Owner only. */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!snapRailEnabled()) return NextResponse.json({ ok: false, error: "snap_rail_disabled" }, { status: 404 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "owner_only" }, { status: 403 });
  if (!snapClientConfigured()) return NextResponse.json({ ok: false, error: "snap_client_not_configured (SNAP_CLIENT_ID / SNAP_CLIENT_SECRET)" }, { status: 500 });
  const state = signOauthState();
  const res = NextResponse.redirect(snapAuthorizeUrl(state, snapOauthRedirectUri(req)));
  res.cookies.set(SNAP_OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/snap/oauth", maxAge: 600 });
  return res;
}
```

- [ ] **Step 3: Write the callback route**

Create `app/api/snap/oauth/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/session";
import { isOwnerSession } from "@/lib/roles";
import { snapExchangeCode, snapRailEnabled } from "@/lib/snap-api";
import { SNAP_OAUTH_STATE_COOKIE, snapClientConfigured, snapOauthRedirectUri, verifyOauthState } from "@/lib/snap-oauth";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;background:#0b0d12;color:#e6e8ef;padding:32px;max-width:760px;margin:auto}code{display:block;white-space:pre-wrap;word-break:break-all;background:#151925;border:1px solid #2a3040;border-radius:8px;padding:12px;margin:12px 0;font-size:13px}b{color:#f3f0a3}</style></head><body>${body}</body></html>`;
  const res = new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  res.cookies.set(SNAP_OAUTH_STATE_COOKIE, "", { path: "/api/snap/oauth", maxAge: 0 });
  return res;
}

/** GET ?code&state → exchange once, SHOW the refresh token, store nothing. Owner only. */
export async function GET(req: Request) {
  const session = sessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!snapRailEnabled()) return NextResponse.json({ ok: false, error: "snap_rail_disabled" }, { status: 404 });
  if (!isOwnerSession(session)) return NextResponse.json({ ok: false, error: "owner_only" }, { status: 403 });
  if (!snapClientConfigured()) return page("Snapchat OAuth", "<h2>Client not configured</h2><p>Set SNAP_CLIENT_ID and SNAP_CLIENT_SECRET first.</p>", 500);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = /(?:^|;\s*)snap_oauth_state=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
  if (url.searchParams.get("error")) return page("Snapchat OAuth", `<h2>Snapchat refused</h2><p>${esc(url.searchParams.get("error_description") || url.searchParams.get("error") || "")}</p>`, 400);
  if (!code || !verifyOauthState(state, cookie ? decodeURIComponent(cookie) : null)) return page("Snapchat OAuth", "<h2>State mismatch</h2><p>Start again from <a href=\"/api/snap/oauth/start\">/api/snap/oauth/start</a> in the same browser.</p>", 400);
  try {
    const t = await snapExchangeCode(code, snapOauthRedirectUri(req));
    return page(
      "Snapchat OAuth",
      `<h2>Refresh token minted</h2><p>Paste this line into <b>.env.local</b> (locally) — it is shown ONCE and stored nowhere:</p><code>SNAP_REFRESH_TOKEN=${esc(t.refreshToken)}</code><p>Then restart the dev server. The access token (${t.expiresIn}s) is derived from it automatically.</p>`,
    );
  } catch (e) {
    return page("Snapchat OAuth", `<h2>Exchange failed</h2><p>${esc((e as Error).message)}</p>`, 502);
  }
}
```

- [ ] **Step 4: Type-check + lint**

Run: `cd adlauncher && npx tsc --noEmit && npx eslint lib/snap-oauth.ts app/api/snap/oauth`
Expected: no errors. (The proxy passes `/api/snap/oauth/*` normally — the callback is a browser navigation carrying the session cookie.)

---
### Task 16: The fake Snapchat API (`_e2e/_snap_mock.mjs`)

**Files:**
- Create: `_e2e/_snap_mock.mjs` (dependency-free `node:http`)

**Interfaces:**
- Serves on `PORT` (default 3198) the three hosts the client uses when pointed at it: auth (`/login/oauth2/access_token`), ads (`/v1/...`) and business (`/business/v1/...`). Fixtures: organization `org-mock-1`; ad accounts `acct-mock-a` (USD, 1 pixel `px-mock-a1`) and `acct-mock-b` (USD, 2 pixels `px-mock-b1`/`px-mock-b2`); Public Profile `prof-mock-1`. Media becomes `READY` `MEDIA_DELAY_MS` (default 1500) after its upload. Failure knobs: an ad squad whose name contains `FAIL-ADSQUAD` → 400; a creative whose name contains `FAIL-NET` → the socket is destroyed (no answer). Hooks: `GET /__mock/state`, `POST /__mock/reset`, `GET /__mock/media/sample.mp4` and `sample.jpg` (bytes for the pump to download).

- [ ] **Step 1: Write the mock**

Create `_e2e/_snap_mock.mjs`:

```js
// A dependency-free fake of the Snapchat Marketing API (+ its OAuth host + the business host) for
// the Snap-rail route smoke (_e2e/_adl_snap_smoke.mts). Point the app at it with
//   SNAP_API_BASE=http://127.0.0.1:3198/v1  SNAP_AUTH_BASE=http://127.0.0.1:3198
//   SNAP_BUSINESS_API_BASE=http://127.0.0.1:3198/business/v1
//   SNAP_CLIENT_ID=x SNAP_CLIENT_SECRET=x SNAP_REFRESH_TOKEN=x  (any non-empty values)
// It mirrors the documented contract (docs read 16.09.2026): batch envelopes
// {campaigns:[…]} → {request_status, campaigns:[{sub_request_status, campaign}]}, errors as HTTP
// 4xx with request_status:"ERROR" + display_message/debug_message, media PENDING_UPLOAD → READY,
// Public Profile REQUIRED on creatives, whole-object campaign PUT.
//
//   node _e2e/_snap_mock.mjs            # PORT 3198, MEDIA_DELAY_MS 1500
// Test hooks: GET /__mock/state, POST /__mock/reset, GET /__mock/media/sample.(mp4|jpg).

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3198);
const MEDIA_DELAY_MS = Number(process.env.MEDIA_DELAY_MS || 1500);

const ORG = { id: "org-mock-1", name: "GlobeCoders (mock)", type: "ENTERPRISE" };
const ACCOUNTS = [
  { id: "acct-mock-a", name: "GC Snap USD 1", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organization_id: ORG.id },
  { id: "acct-mock-b", name: "GC Snap USD 2", currency: "USD", timezone: "America/Sao_Paulo", status: "ACTIVE", organization_id: ORG.id },
];
const PIXELS = {
  "acct-mock-a": [{ id: "px-mock-a1", name: "GC Pixel A", status: "ACTIVE" }],
  "acct-mock-b": [
    { id: "px-mock-b1", name: "GC Pixel B1", status: "ACTIVE" },
    { id: "px-mock-b2", name: "GC Pixel B2", status: "ACTIVE" },
  ],
};
const PROFILES = [{ id: "prof-mock-1", display_name: "GC (mock)", profile_type: "PUBLIC_PROFILE", organization_id: ORG.id }];
const STRATEGIES = new Set(["AUTO_BID", "LOWEST_COST_WITH_MAX_BID", "TARGET_COST"]);
const GOALS = new Set(["PIXEL_PURCHASE", "PIXEL_PAGE_VIEW", "LANDING_PAGE_VIEW", "SWIPES", "IMPRESSIONS"]);
const SAMPLE_BYTES = Buffer.alloc(4096, 7);

const fresh = () => ({ media: new Map(), campaigns: new Map(), adsquads: new Map(), creatives: new Map(), ads: new Map(), tokens: 0, uploads: 0 });
let state = fresh();

const send = (res, status, obj) => {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const err = (res, status, msg, code = "E1000") => send(res, status, { request_status: "ERROR", request_id: randomUUID(), display_message: msg, debug_message: msg, error_code: code });
const okOne = (res, key, singular, entity) => send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), [key]: [{ sub_request_status: "SUCCESS", [singular]: entity }] });
const okMany = (res, key, singular, entities) => send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), [key]: entities.map((e) => ({ sub_request_status: "SUCCESS", [singular]: e })) });
const readRaw = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
const readJson = async (req) => { try { return JSON.parse((await readRaw(req)).toString("utf8") || "{}"); } catch { return {}; } };
const first = (body, key) => (Array.isArray(body?.[key]) ? body[key][0] ?? {} : {});
const str = (v) => (v == null ? "" : String(v));
const isoOk = (v) => !Number.isNaN(Date.parse(str(v)));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";
  console.log(`${new Date().toISOString()} ${method} ${req.url}`);

  // ---- hooks ----
  if (path === "/__mock/state" && method === "GET") {
    return send(res, 200, {
      uploads: state.uploads,
      tokens: state.tokens,
      media: [...state.media.values()],
      campaigns: [...state.campaigns.values()],
      adsquads: [...state.adsquads.values()],
      creatives: [...state.creatives.values()],
      ads: [...state.ads.values()],
    });
  }
  if (path === "/__mock/reset" && method === "POST") {
    state = fresh();
    return send(res, 200, { ok: true });
  }
  if (path.startsWith("/__mock/media/") && method === "GET") {
    const mp4 = path.endsWith(".mp4");
    res.writeHead(200, { "content-type": mp4 ? "video/mp4" : "image/jpeg", "content-length": SAMPLE_BYTES.length });
    return res.end(SAMPLE_BYTES);
  }

  // ---- OAuth host ----
  if (path === "/login/oauth2/access_token" && method === "POST") {
    const form = new URLSearchParams((await readRaw(req)).toString("utf8"));
    const grant = form.get("grant_type");
    if (!form.get("client_id") || !form.get("client_secret")) return send(res, 400, { error: "invalid_client" });
    if (grant === "refresh_token" && form.get("refresh_token")) {
      state.tokens += 1;
      return send(res, 200, { access_token: `mock-access-${state.tokens}`, expires_in: 3600, token_type: "Bearer", refresh_token: form.get("refresh_token"), scope: "snapchat-marketing-api" });
    }
    if (grant === "authorization_code" && form.get("code")) {
      state.tokens += 1;
      return send(res, 200, { access_token: `mock-access-${state.tokens}`, expires_in: 3600, token_type: "Bearer", refresh_token: "mock-refresh-from-code", scope: "snapchat-marketing-api" });
    }
    return send(res, 400, { error: "invalid_grant" });
  }
  if (path === "/login/oauth2/authorize" && method === "GET") {
    return send(res, 200, { note: "mock consent page", redirect: `${url.searchParams.get("redirect_uri")}?code=mock-code&state=${url.searchParams.get("state")}` });
  }

  // ---- everything else needs the bearer ----
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return err(res, 401, "Unauthorized", "E401");

  // ---- business host ----
  let m = path.match(/^\/business\/v1\/organizations\/([^/]+)\/public_profiles$/);
  if (m && method === "GET") {
    if (m[1] !== ORG.id) return err(res, 404, "organization not found", "E404");
    return send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), public_profiles: PROFILES.map((p) => ({ sub_request_status: "SUCCESS", public_profile: p })), paging: {} });
  }

  // ---- ads host: reads ----
  if (path === "/v1/me/organizations" && method === "GET") {
    const withAccounts = url.searchParams.get("with_ad_accounts") === "true";
    return send(res, 200, { request_status: "SUCCESS", request_id: randomUUID(), organizations: [{ sub_request_status: "SUCCESS", organization: { ...ORG, ...(withAccounts ? { ad_accounts: ACCOUNTS } : {}) } }] });
  }
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/pixels$/);
  if (m && method === "GET") {
    if (!PIXELS[m[1]]) return err(res, 404, "ad account not found", "E404");
    return okMany(res, "pixels", "pixel", PIXELS[m[1]]);
  }
  m = path.match(/^\/v1\/media\/([^/]+)$/);
  if (m && method === "GET") {
    const media = state.media.get(m[1]);
    if (!media) return err(res, 404, "media not found", "E404");
    if (media.media_status !== "READY" && media.uploaded_at && Date.now() - media.uploaded_at >= MEDIA_DELAY_MS) media.media_status = "READY";
    return okOne(res, "media", "media", media);
  }
  m = path.match(/^\/v1\/campaigns\/([^/]+)$/);
  if (m && method === "GET") {
    const c = state.campaigns.get(m[1]);
    return c ? okOne(res, "campaigns", "campaign", c) : err(res, 404, "campaign not found", "E404");
  }

  // ---- media ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/media$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "media");
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (body.type !== "VIDEO" && body.type !== "IMAGE") return err(res, 400, "media.type must be VIDEO or IMAGE");
    if (!str(body.name)) return err(res, 400, "media.name is required");
    const media = { id: `media-${randomUUID()}`, ad_account_id: m[1], name: body.name, type: body.type, media_status: "PENDING_UPLOAD", uploaded_at: null, bytes: 0, created_at: new Date().toISOString() };
    state.media.set(media.id, media);
    return okOne(res, "media", "media", media);
  }
  m = path.match(/^\/v1\/media\/([^/]+)\/upload$/);
  if (m && method === "POST") {
    const media = state.media.get(m[1]);
    if (!media) return err(res, 404, "media not found", "E404");
    if (!/multipart\/form-data/i.test(req.headers["content-type"] || "")) return err(res, 400, "upload must be multipart/form-data with a `file` field");
    const raw = await readRaw(req);
    if (raw.length === 0) return err(res, 400, "empty upload");
    media.bytes = raw.length;
    media.uploaded_at = Date.now();
    state.uploads += 1;
    return okOne(res, "media", "media", media);
  }

  // ---- campaigns ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/campaigns$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "campaigns");
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (!str(body.name)) return err(res, 400, "campaign.name is required");
    if (str(body.name).length > 375) return err(res, 400, "campaign.name must be at most 375 characters");
    if (body.ad_account_id !== m[1]) return err(res, 400, "campaign.ad_account_id must match the path");
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "campaign.status must be ACTIVE or PAUSED");
    if (!isoOk(body.start_time)) return err(res, 400, "campaign.start_time must be ISO-8601");
    const c = { id: `cmp-${randomUUID()}`, ...body, buy_model: body.buy_model || "AUCTION", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    state.campaigns.set(c.id, c);
    return okOne(res, "campaigns", "campaign", c);
  }
  if (m && method === "PUT") {
    const body = first(await readJson(req), "campaigns");
    const c = state.campaigns.get(str(body.id));
    if (!c) return err(res, 404, "campaign not found", "E404");
    for (const k of ["name", "ad_account_id", "status", "start_time"]) if (body[k] === undefined) return err(res, 400, `campaign.${k} is required on update (whole object)`);
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "campaign.status must be ACTIVE or PAUSED");
    Object.assign(c, body, { updated_at: new Date().toISOString() });
    return okOne(res, "campaigns", "campaign", c);
  }

  // ---- ad squads ----
  m = path.match(/^\/v1\/campaigns\/([^/]+)\/adsquads$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "adsquads");
    const c = state.campaigns.get(m[1]);
    if (!c) return err(res, 404, "campaign not found", "E404");
    if (str(body.name).includes("FAIL-ADSQUAD")) return err(res, 400, "Ad Squad refused by the mock (FAIL-ADSQUAD): daily_budget_micro below the account minimum");
    if (!str(body.name)) return err(res, 400, "adsquad.name is required");
    if (body.type !== "SNAP_ADS") return err(res, 400, "adsquad.type must be SNAP_ADS");
    if (!(Number(body.daily_budget_micro) >= 5_000_000)) return err(res, 400, "daily_budget_micro must be at least 5000000");
    if (!STRATEGIES.has(body.bid_strategy)) return err(res, 400, `bid_strategy must be one of ${[...STRATEGIES].join(", ")}`);
    if (body.bid_strategy !== "AUTO_BID" && !(Number(body.bid_micro) >= 10_000)) return err(res, 400, "bid_micro is required for this bid_strategy (min 10000)");
    if (body.bid_strategy === "AUTO_BID" && body.bid_micro != null) return err(res, 400, "bid_micro is not allowed with AUTO_BID");
    if (!GOALS.has(body.optimization_goal)) return err(res, 400, "unknown optimization_goal");
    if (!Array.isArray(body.targeting?.geos) || body.targeting.geos.length === 0) return err(res, 400, "targeting.geos must name at least one country");
    if (String(body.optimization_goal).startsWith("PIXEL_")) {
      const px = PIXELS[c.ad_account_id] || [];
      if (!body.pixel_id || !px.some((p) => p.id === body.pixel_id)) return err(res, 400, "pixel_id is required for a PIXEL_* optimization_goal and must belong to the ad account");
    }
    const sq = { id: `sq-${randomUUID()}`, ...body, campaign_id: c.id, created_at: new Date().toISOString() };
    state.adsquads.set(sq.id, sq);
    return okOne(res, "adsquads", "adsquad", sq);
  }

  // ---- creatives ----
  m = path.match(/^\/v1\/adaccounts\/([^/]+)\/creatives$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "creatives");
    if (str(body.name).includes("FAIL-NET")) return req.socket.destroy(); // the AMBIGUOUS path: no answer at all
    if (!ACCOUNTS.some((a) => a.id === m[1])) return err(res, 404, "ad account not found", "E404");
    if (body.type !== "WEB_VIEW") return err(res, 400, "creative.type must be WEB_VIEW");
    const headline = str(body.headline);
    if (!headline || headline.length > 34) return err(res, 400, "headline is required and at most 34 characters");
    if (str(body.brand_name).length > 32) return err(res, 400, "brand_name must be at most 32 characters");
    if (!PROFILES.some((p) => p.id === body.profile_properties?.profile_id)) return err(res, 400, "profile_properties.profile_id is required (a Public Profile of the organization)");
    const media = state.media.get(str(body.top_snap_media_id));
    if (!media) return err(res, 400, "top_snap_media_id not found");
    if (media.media_status !== "READY") return err(res, 400, "top_snap_media_id is not READY yet");
    if (!/^https:\/\//.test(str(body.web_view_properties?.url))) return err(res, 400, "web_view_properties.url must be https");
    const cr = { id: `cr-${randomUUID()}`, ...body, review_status: "PENDING_REVIEW", packaging_status: "PENDING", created_at: new Date().toISOString() };
    state.creatives.set(cr.id, cr);
    return okOne(res, "creatives", "creative", cr);
  }

  // ---- ads ----
  m = path.match(/^\/v1\/adsquads\/([^/]+)\/ads$/);
  if (m && method === "POST") {
    const body = first(await readJson(req), "ads");
    if (!state.adsquads.has(m[1])) return err(res, 404, "ad squad not found", "E404");
    if (!state.creatives.has(str(body.creative_id))) return err(res, 400, "creative_id not found");
    if (body.type !== "REMOTE_WEBPAGE") return err(res, 400, "ad.type must be REMOTE_WEBPAGE");
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return err(res, 400, "ad.status must be ACTIVE or PAUSED");
    const ad = { id: `ad-${randomUUID()}`, ...body, ad_squad_id: m[1], review_status: "PENDING", created_at: new Date().toISOString() };
    state.ads.set(ad.id, ad);
    return okOne(res, "ads", "ad", ad);
  }

  return err(res, 404, `no route for ${method} ${path}`, "E404");
});

server.listen(PORT, () => {
  console.log(`snapchat MOCK on http://127.0.0.1:${PORT}  (accounts=${ACCOUNTS.length}, MEDIA_DELAY_MS=${MEDIA_DELAY_MS})`);
});
```

- [ ] **Step 2: Smoke the mock by hand**

Run: `cd adlauncher && node _e2e/_snap_mock.mjs` and, in another shell:

```bash
curl -s -X POST http://127.0.0.1:3198/login/oauth2/access_token -d "grant_type=refresh_token&client_id=x&client_secret=x&refresh_token=x"
curl -s -H "Authorization: Bearer t" "http://127.0.0.1:3198/v1/me/organizations?with_ad_accounts=true"
curl -s -H "Authorization: Bearer t" http://127.0.0.1:3198/v1/adaccounts/acct-mock-b/pixels
curl -s http://127.0.0.1:3198/__mock/state
```

Expected: an access token; the organization with 2 ad accounts; 2 pixels; an empty state.

---
### Task 17: Route smoke against the mock + the runbook

**Files:**
- Create: `_e2e/_adl_snap_smoke.mts`
- Create: `_e2e/README-snap.md`

**Interfaces:**
- Consumes: `_e2e/_adl_lib.mts` (`api`, `ok`, `summary`, `sleep`, `USER` — signs an owner session for `e2e-nazar`), the mock (Task 16), every `/api/snap*` route.
- Produces: a runnable end-to-end proof; `_e2e/_snap_smoke_last.json` (ids it created, for manual cleanup if it dies mid-way).

- [ ] **Step 1: Write the smoke**

Create `_e2e/_adl_snap_smoke.mts`:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any -- live-JSON harness script; route bodies arrive untyped. */
// Snap-rail ROUTE SMOKE — drives /api/snap/* + /api/snap-tasks end to end against the fake
// Snapchat API (_e2e/_snap_mock.mjs) while Strapi (task store + key registry) and LION (report)
// run LIVE. Proves: the catalog, the registry view, the refusal matrix, a happy wave (2 copies →
// ONE media upload → 2 campaigns PAUSED→ACTIVE, 2 keys bound), start-paused, the two failure
// dispositions (4xx after the campaign → key retired + PAUSED shell; network cut → interrupted),
// idempotent re-POST, the report join — then releases its keys and deletes its rows.
//
// PREREQUISITES (see _e2e/README-snap.md):
//   1) node _e2e/_snap_mock.mjs                                   # fake Snapchat on :3198
//   2) .env.local carries NEXT_PUBLIC_SNAP_ENABLED=1 + the SNAP_* mock values (Task 9), then
//      npx next build && npx next start -p 3124   (or npx next dev -p 3124)
//   3) node _e2e/_adl_snap_smoke.mts
//
// ⚠️ Keys are claimed in the REAL shared registry (Strapi app-cache) while the smoke runs — it
// releases them at the end. Never point SNAP_API_BASE at the real Snapchat for this script.
import { writeFileSync } from "node:fs";
import { api, ok, summary, sleep, USER } from "./_adl_lib.mts";

const MOCK = process.env.SNAP_MOCK_BASE ?? "http://127.0.0.1:3198";
const MEDIA = `${MOCK}/__mock/media/sample.mp4`;
const ACCT_A = "acct-mock-a";
const ACCT_B = "acct-mock-b";
const PROFILE = "prof-mock-1";

const createdTaskIds: string[] = [];
const claimedKeys: string[] = [];
const record = (rows: { taskId: string }[] = []) => {
  for (const r of rows) if (r?.taskId && !createdTaskIds.includes(r.taskId)) createdTaskIds.push(r.taskId);
  writeFileSync("./_e2e/_snap_smoke_last.json", JSON.stringify({ user: USER, taskIds: createdTaskIds, keys: claimedKeys }, null, 2));
};
const noteKey = (k: unknown) => {
  if (typeof k === "string" && /^glo-snp_\d{3}$/.test(k) && !claimedKeys.includes(k)) claimedKeys.push(k);
};
const mockState = async (): Promise<any> => (await fetch(`${MOCK}/__mock/state`)).json();

async function pollRows(ids: string[], maxMs: number): Promise<Record<string, any>> {
  const t0 = Date.now();
  const terminal: Record<string, any> = {};
  while (Date.now() - t0 < maxMs) {
    const r = await api("/api/snap-tasks");
    for (const row of (r.body.tasks ?? []) as any[]) {
      if (ids.includes(row.id) && ["done", "error", "interrupted"].includes(String(row.status))) terminal[row.id] = row;
    }
    if (Object.keys(terminal).length === ids.length) break;
    await sleep(5000);
  }
  return terminal;
}

const shot = (over: Record<string, unknown> = {}) => ({
  adAccount: ACCT_A,
  profileId: PROFILE,
  optimizationGoal: "PIXEL_PURCHASE",
  bidStrategy: "AUTO_BID",
  bid: "",
  budget: "10,00",
  startPaused: false,
  headline: "Smoke headline",
  brandName: "GC",
  cta: "MORE",
  mediaUrl: MEDIA,
  mediaKind: "video",
  mediaName: "sample.mp4",
  geo: ["US"],
  minAge: "18",
  landingId: "cars",
  landingUrl: "",
  suffix: "smoke",
  ...over,
});
const launch = (body: unknown) => api("/api/snap/launch", { method: "POST", body: JSON.stringify(body) });
const wv = () => crypto.randomUUID();

async function main() {
  await fetch(`${MOCK}/__mock/reset`, { method: "POST" });

  // ---- 1. catalog ----
  const cat = await api("/api/snap/accounts");
  const accounts: any[] = cat.body.accounts ?? [];
  ok("GET /api/snap/accounts ok with the 2 mock accounts", cat.status === 200 && cat.body.ok === true && accounts.length === 2, `HTTP ${cat.status} n=${accounts.length} ${cat.body.error ?? ""}`);
  const a = accounts.find((x) => x.id === ACCT_A);
  const b = accounts.find((x) => x.id === ACCT_B);
  ok("acct-a: USD, 1 pixel · acct-b: 2 pixels", a?.currency === "USD" && a?.pixels?.length === 1 && b?.pixels?.length === 2, JSON.stringify({ a: a?.pixels?.length, b: b?.pixels?.length }));
  ok("one Public Profile + defaults object", (cat.body.profiles ?? []).length === 1 && cat.body.defaults && typeof cat.body.defaults.brandName === "string", JSON.stringify(cat.body.defaults));
  const envProfile = String(cat.body.defaults?.profile ?? "");

  // ---- 2. registry view ----
  const k0 = await api("/api/snap/keys");
  ok("GET /api/snap/keys ok, pool 100 = free + used", k0.status === 200 && k0.body.ok === true && k0.body.poolMax === 100 && (k0.body.free?.length ?? 0) + (k0.body.used?.length ?? 0) === 100, `HTTP ${k0.status} free=${k0.body.free?.length} used=${k0.body.used?.length}`);
  ok("at least 4 free keys for this smoke", (k0.body.free?.length ?? 0) >= 4, String(k0.body.free?.length));

  // ---- 3. refusal matrix ----
  const noShots = await launch({ waveId: wv(), shots: [] });
  ok("no shots → 400 no_shots", noShots.status === 400 && noShots.body.error === "no_shots", `${noShots.status} ${noShots.body.error}`);
  const badAcct = await launch({ waveId: wv(), shots: [shot({ adAccount: "acct-nope" })] });
  ok("unknown ad account → 400", badAcct.status === 400 && /Snapchat ad accounts/.test(badAcct.body.error ?? ""), badAcct.body.error);
  const noPx = await launch({ waveId: wv(), shots: [shot({ adAccount: ACCT_B, pixel: "" })] });
  ok("acct-b (2 pixels) PIXEL_PURCHASE without a pixel → 400 'pick one' + 2 availablePixels", noPx.status === 400 && /pick one/.test(noPx.body.error ?? "") && noPx.body.availablePixels?.length === 2, `${noPx.body.error} px=${noPx.body.availablePixels?.length}`);
  const longHead = await launch({ waveId: wv(), shots: [shot({ headline: "x".repeat(35) })] });
  ok("35-char headline → 400", longHead.status === 400 && /Headline/.test(longHead.body.error ?? ""), longHead.body.error);
  const lowBudget = await launch({ waveId: wv(), shots: [shot({ budget: "4,99" })] });
  ok("budget 4,99 → 400 (Snap floor 5)", lowBudget.status === 400 && /budget/i.test(lowBudget.body.error ?? ""), lowBudget.body.error);
  const noBid = await launch({ waveId: wv(), shots: [shot({ bidStrategy: "LOWEST_COST_WITH_MAX_BID", bid: "" })] });
  ok("Max bid without a bid → 400", noBid.status === 400 && /needs a bid/.test(noBid.body.error ?? ""), noBid.body.error);
  const noGeo = await launch({ waveId: wv(), shots: [shot({ geo: [] })] });
  ok("empty geo → 400", noGeo.status === 400 && /country/i.test(noGeo.body.error ?? ""), noGeo.body.error);
  const httpLanding = await launch({ waveId: wv(), shots: [shot({ landingId: "custom", landingUrl: "http://example.com/" })] });
  ok("custom http landing → 400", httpLanding.status === 400 && /https/.test(httpLanding.body.error ?? ""), httpLanding.body.error);
  if (!envProfile) {
    const noProfile = await launch({ waveId: wv(), shots: [shot({ profileId: "" })] });
    ok("no Public Profile (and no env default) → 400", noProfile.status === 400 && /Public Profile/.test(noProfile.body.error ?? ""), noProfile.body.error);
  }

  // ---- 4. happy wave: 2 copies of one card → one media upload, two campaigns, two keys ----
  const wave = wv();
  const body = { waveId: wave, shots: [shot(), shot()] };
  const fired = await launch(body);
  const rows: any[] = fired.body.rows ?? [];
  record(rows);
  ok("wave accepted, queued 2, ids snl-<wave>-01/02", fired.status === 200 && fired.body.ok === true && fired.body.queued === 2 && rows[0]?.taskId === `snl-${wave}-01` && rows[1]?.taskId === `snl-${wave}-02`, `HTTP ${fired.status} ${JSON.stringify(fired.body).slice(0, 200)}`);
  const refired = await launch(body);
  ok("re-POST the same wave → alreadyAccepted (idempotent)", refired.status === 200 && refired.body.alreadyAccepted === true, JSON.stringify(refired.body).slice(0, 120));
  const ids = rows.map((r) => r.taskId);
  const done = await pollRows(ids, 150_000);
  const happyKeys: string[] = [];
  for (const id of ids) {
    const row = done[id];
    console.log(`    row ${id}: ${JSON.stringify(row ?? "(unsettled)").slice(0, 320)}`);
    ok(`${id} → done / live`, row?.status === "done" && row?.stage === "live", `${row?.status}/${row?.stage} ${row?.error ?? ""}`);
    if (row?.key) {
      happyKeys.push(row.key);
      noteKey(row.key);
    }
    ok(`${id}: key + campaign/adsquad/ad ids + link with the key`, /^glo-snp_\d{3}$/.test(row?.key ?? "") && Boolean(row?.campaignId && row?.adSquadId && row?.adId) && String(row?.link ?? "").endsWith(`?utm_source=stone&utm_campaign=${row?.key}`), `${row?.key} ${row?.link}`);
    ok(`${id}: name carries the key and GC-Launcher`, String(row?.name ?? "").includes(String(row?.key)) && /GC-Launcher/.test(String(row?.name ?? "")), String(row?.name ?? "").slice(0, 90));
  }
  record(rows);
  ok("the two copies took two DIFFERENT keys", happyKeys.length === 2 && happyKeys[0] !== happyKeys[1], happyKeys.join(","));
  let st = await mockState();
  ok("mock: ONE media upload reused by both copies", st.uploads === 1 && st.media.length === 1 && st.media[0].media_status === "READY", `uploads=${st.uploads} media=${st.media.length}`);
  ok("mock: 2 campaigns ACTIVE (born PAUSED, activated last), 2 ad squads, 2 creatives, 2 ads", st.campaigns.length === 2 && st.campaigns.every((c: any) => c.status === "ACTIVE") && st.adsquads.length === 2 && st.creatives.length === 2 && st.ads.length === 2, JSON.stringify({ c: st.campaigns.map((c: any) => c.status), sq: st.adsquads.length, cr: st.creatives.length, ad: st.ads.length }));
  ok("mock: ad squad = SNAP_ADS · $10 · AUTO_BID (no bid_micro) · PIXEL_PURCHASE on px-mock-a1 · geo us · age 18", st.adsquads.every((s: any) => s.type === "SNAP_ADS" && s.daily_budget_micro === 10_000_000 && s.bid_strategy === "AUTO_BID" && s.bid_micro === undefined && s.pixel_id === "px-mock-a1" && s.targeting?.geos?.[0]?.country_code === "us" && s.targeting?.demographics?.[0]?.min_age === "18"), JSON.stringify(st.adsquads[0]).slice(0, 300));
  ok("mock: creatives are WEB_VIEW on the Public Profile with the key in the url; ads are REMOTE_WEBPAGE", st.creatives.every((c: any) => c.type === "WEB_VIEW" && c.profile_properties?.profile_id === PROFILE && /utm_source=stone&utm_campaign=glo-snp_\d{3}$/.test(c.web_view_properties?.url ?? "")) && st.ads.every((x: any) => x.type === "REMOTE_WEBPAGE"), JSON.stringify(st.creatives[0]?.web_view_properties));
  const k1 = await api("/api/snap/keys");
  const bound = (k1.body.used ?? []).filter((u: any) => happyKeys.includes(u.key));
  ok("registry: both keys active with campaign ids and the smoke user", bound.length === 2 && bound.every((u: any) => u.status === "active" && u.campaign_id && u.user === USER), JSON.stringify(bound.map((u: any) => [u.key, u.status, u.campaign_id])));

  // ---- 5. start paused ----
  const pausedWave = wv();
  const pausedFired = await launch({ waveId: pausedWave, shots: [shot({ startPaused: true, suffix: "smoke-paused" })] });
  record(pausedFired.body.rows);
  const pausedId = pausedFired.body.rows?.[0]?.taskId;
  const pausedRow = (await pollRows([pausedId], 120_000))[pausedId];
  noteKey(pausedRow?.key);
  ok("start paused → done / paused, campaign left PAUSED on the mock", pausedRow?.status === "done" && pausedRow?.stage === "paused" && (await mockState()).campaigns.find((c: any) => c.id === pausedRow?.campaignId)?.status === "PAUSED", `${pausedRow?.status}/${pausedRow?.stage}`);

  // ---- 6. 4xx after the campaign (FAIL-ADSQUAD in the name) → key retired, PAUSED shell ----
  const failWave = wv();
  const failFired = await launch({ waveId: failWave, shots: [shot({ suffix: "FAIL-ADSQUAD" })] });
  record(failFired.body.rows);
  const failId = failFired.body.rows?.[0]?.taskId;
  const failRow = (await pollRows([failId], 120_000))[failId];
  noteKey(failRow?.key);
  console.log(`    fail row: ${JSON.stringify(failRow ?? "(unsettled)").slice(0, 300)}`);
  ok("fail path → error at stage adsquad with the mock's sentence, campaign id kept", failRow?.status === "error" && failRow?.stage === "adsquad" && /FAIL-ADSQUAD/.test(failRow?.error ?? "") && Boolean(failRow?.campaignId), `${failRow?.status}/${failRow?.stage} ${failRow?.error}`);
  st = await mockState();
  ok("mock: the shell campaign exists and stays PAUSED, no extra ad squad", st.campaigns.find((c: any) => c.id === failRow?.campaignId)?.status === "PAUSED" && st.adsquads.length === 3, `sq=${st.adsquads.length}`);
  const k2 = await api("/api/snap/keys");
  const retired = (k2.body.used ?? []).find((u: any) => u.key === failRow?.key);
  ok("registry: the key is RETIRED with the campaign id", retired?.status === "retired" && retired?.campaign_id === failRow?.campaignId, JSON.stringify(retired));

  // ---- 7. network cut at the creative (FAIL-NET) → interrupted, key retired ----
  const netWave = wv();
  const netFired = await launch({ waveId: netWave, shots: [shot({ suffix: "FAIL-NET" })] });
  record(netFired.body.rows);
  const netId = netFired.body.rows?.[0]?.taskId;
  const netRow = (await pollRows([netId], 150_000))[netId];
  noteKey(netRow?.key);
  console.log(`    net row: ${JSON.stringify(netRow ?? "(unsettled)").slice(0, 300)}`);
  ok("network cut → interrupted at stage creative (never re-sent)", netRow?.status === "interrupted" && netRow?.stage === "creative" && /Ambiguous/.test(netRow?.error ?? ""), `${netRow?.status}/${netRow?.stage}`);
  const k3 = await api("/api/snap/keys");
  ok("registry: that key is retired too", (k3.body.used ?? []).find((u: any) => u.key === netRow?.key)?.status === "retired");

  // ---- 8. report join (LION is LIVE) ----
  const rep = await api("/api/snap/report?date=yesterday");
  ok("GET /api/snap/report?date=yesterday → 100 rows, final day", rep.status === 200 && rep.body.ok === true && rep.body.rows?.length === 100 && rep.body.partial === false, `HTTP ${rep.status} ${rep.body.error ?? ""} n=${rep.body.rows?.length}`);
  ok("report rows of our keys carry their binding", happyKeys.every((k) => (rep.body.rows ?? []).find((r: any) => r.key === k)?.binding?.status === "active"));
  const today = await api("/api/snap/report?date=today");
  ok("today is partial", today.status === 200 && today.body.partial === true, `HTTP ${today.status}`);
  const badDate = await api("/api/snap/report?date=16.09.2026");
  ok("junk date → 400", badDate.status === 400);

  // ---- 9. cleanup ----
  let released = 0;
  for (const k of claimedKeys) {
    const d = await api(`/api/snap/keys?key=${encodeURIComponent(k)}`, { method: "DELETE" });
    if (d.status === 200 && d.body.released === true) released += 1;
  }
  ok(`released ${released}/${claimedKeys.length} keys`, released === claimedKeys.length, claimedKeys.join(","));
  const del = await api(`/api/snap-tasks?taskIds=${encodeURIComponent(createdTaskIds.join(","))}`, { method: "DELETE" });
  ok(`deleted ${createdTaskIds.length} rows`, del.status === 200 && del.body.ok === true, `HTTP ${del.status}`);
  const k4 = await api("/api/snap/keys");
  ok("none of the smoke's keys remain in the registry", !(k4.body.used ?? []).some((u: any) => claimedKeys.includes(u.key)));
}

main()
  .catch((e) => {
    console.error("smoke crashed:", e);
    ok("smoke ran to the end", false, String(e?.message ?? e));
  })
  .finally(() => {
    process.exitCode = summary() > 0 ? 1 : 0;
  });
```

- [ ] **Step 2: Run the three shells**

```bash
# shell 1
cd adlauncher && node _e2e/_snap_mock.mjs
# shell 2 (after the Task 9 env is in .env.local)
cd adlauncher && npx next build && npx next start -p 3124
# shell 3
cd adlauncher && node _e2e/_adl_snap_smoke.mts
```

Expected: `N passed, 0 failed` (about 36 checks). If a row stays `running` past the poll budget, read `GET http://127.0.0.1:3198/__mock/state` and the app's terminal — the pump logs nothing by design, so the mock's request log is the trace.

- [ ] **Step 3: Write the runbook**

Create `_e2e/README-snap.md`:

```markdown
# Snapchat rail — runbook

The rail launches on OUR Snapchat ad account through the Marketing API; the partner supplies the
landings, the 100 keys `glo-snp_001…100` and the daily report (via LION). Spec:
`docs/superpowers/specs/2026-09-16-snapchat-rail-design.md`. Ships DORMANT: prod has no
`NEXT_PUBLIC_SNAP_ENABLED`, so the tab stays "in development" and every `/api/snap/*` answers 404.

## 1. One-time manual setup (owner, Ads Manager) — before the first live launch

1. Snapchat Business account + an ad account (USD) in the organization.
2. A **Public Profile** for the organization (every ad must reference one since 26.02.2024) —
   Ads Manager → Public Profiles. Copy its id → `SNAP_PROFILE_ID`.
3. A **Snap Pixel** on the ad account (Events Manager). Copy its id → `SNAP_PIXEL_ID` (the board
   also lists pixels per account).
4. A **Marketing API OAuth app**: Business Details → OAuth Apps → create; redirect URI =
   `http://localhost:3124/api/snap/oauth/callback` (local) — later also the prod URL. Copy
   `SNAP_CLIENT_ID` / `SNAP_CLIENT_SECRET`.
5. Mint the refresh token: with the dev server running and the flag on, open
   `http://localhost:3124/api/snap/oauth/start` as the owner → consent → the callback page shows
   `SNAP_REFRESH_TOKEN=…` once → paste into `.env.local`, restart.
6. **For the partner**: Business Details → OAuth Apps → Conversions API Tokens → Generate. Send
   them the pixel id + that token (they fire purchase events on our pixel). Nothing in the app.
7. Snap Click ID (`ScCid`) is appended by Snapchat automatically — no toggle. Do NOT enable any
   Ads Manager "auto URL parameters" that could rewrite `utm_source` / `utm_campaign`: the
   creative URLs already carry `utm_source=stone&utm_campaign=<key>` statically.

## 2. Env (`.env.local` only — never Vercel in this phase)

```
NEXT_PUBLIC_SNAP_ENABLED=1
SNAP_CLIENT_ID=…            SNAP_CLIENT_SECRET=…        SNAP_REFRESH_TOKEN=…
SNAP_PROFILE_ID=…           SNAP_PIXEL_ID=…  (optional) SNAP_AD_ACCOUNT_ID=… (optional)
SNAP_BRAND_NAME=GC          SNAP_ORGANIZATION_ID=…      (optional; first org otherwise)
# mock only (delete for live):
SNAP_API_BASE=http://127.0.0.1:3198/v1
SNAP_AUTH_BASE=http://127.0.0.1:3198
SNAP_BUSINESS_API_BASE=http://127.0.0.1:3198/business/v1
```

## 3. Unit tests (pure decisions, no network)

```
node --test tests/snap-partner.test.ts
node --test tests/snap-launch.test.ts
node --test tests/snap-report.test.ts
node --test tests/snap-pump-core.test.ts
node --test tests/snap-api.test.ts
node --test tests/snap-keys.test.ts
```

## 4. Route smoke (app + FAKE Snapchat; Strapi + LION LIVE)

```
node _e2e/_snap_mock.mjs                                  # :3198
npx next build && npx next start -p 3124                  # with the mock env above
node _e2e/_adl_snap_smoke.mts
```
The smoke claims keys in the REAL registry and releases them; it deletes its task rows. If it
dies mid-way, `_e2e/_snap_smoke_last.json` lists the ids to clean by hand
(`DELETE /api/snap/keys?key=` · `DELETE /api/snap-tasks?taskIds=`).

## 5. First LIVE check (read-only — no campaign is created)

With real credentials in env and the `*_BASE` lines removed: open `/snap` — the pickers must list
the real ad account(s), pixels and Public Profile (`GET /api/snap/accounts`). `/snap/keys` must
show 100 keys and LION's report. A live launch happens only on the owner's word: it creates a REAL
campaign (born PAUSED, activated after the ad exists unless "Start paused").

## 6. What a launch does

Card → N copies → `POST /api/snap/launch` (one wave) → rows in the shared store (partner `sn`) →
server pump per copy: claim key → upload creative → campaign PAUSED → ad squad → creative
(WEB_VIEW, Public Profile) → ad (REMOTE_WEBPAGE) → activate → row `done/live`. A refusal before
the campaign exists releases the key; after it, the key is retired and the shell stays PAUSED. An
ambiguous outcome is `interrupted` and never re-sent. The Keys page joins the registry with
LION's per-key revenue (today partial + forecast, earlier days final).
```

---
### Task 18: Whole-tree verification + closing notes

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-snapchat-rail-design.md` (status line)

- [ ] **Step 1: Every unit test, one file per invocation**

```bash
cd adlauncher
for f in snap-partner snap-launch snap-report snap-pump-core snap-api snap-keys; do node --test tests/$f.test.ts || exit 1; done
# and the pre-existing suites still pass:
for f in google-bid google-launch google-launcher-ui google-source task-store; do node --test tests/$f.test.ts || exit 1; done
```
Expected: every file `# fail 0`.

- [ ] **Step 2: Types, lint, build**

```bash
cd adlauncher && npx tsc --noEmit && npx eslint && npx next build
```
Expected: tsc clean; eslint clean (pre-existing `react-hooks` warnings elsewhere are not ours); the build lists `/snap`, `/snap/keys`, `/api/snap/accounts`, `/api/snap/keys`, `/api/snap/launch`, `/api/snap/report`, `/api/snap/oauth/start`, `/api/snap/oauth/callback`, `/api/snap-tasks`.

- [ ] **Step 3: The smoke (Task 17) green end to end**

Run the three shells from Task 17. Expected: `0 failed`, the registry left without the smoke's keys, the store without its rows.

- [ ] **Step 4: Browser pass (one look, the dev server + mock)**

`npx next dev -p 3124` with the mock running: sign in → the header shows the Snapchat tab → `/snap` lists the mock accounts/profile, a card with the Cars landing previews `…/auto-financing-by-ford/?utm_source=stone&utm_campaign=<next free key>&ScCid=…`, attaching any small mp4 turns the card ready, Preview → Launch → the drawer opens with two `snl-…` rows that go key → media → … → live; `/snap/keys` shows the two keys bound to the smoke user with yesterday's (zero) revenue; owner Release works. Then release those keys.

- [ ] **Step 5: Dormancy proof**

Remove `NEXT_PUBLIC_SNAP_ENABLED` from `.env.local`, restart `next dev`: the tab reads "Snapchat — in development", `/snap` redirects to `/`, `curl -b <cookie> localhost:3124/api/snap/keys` → `404 snap_rail_disabled`. Put the flag back.

- [ ] **Step 6: Close the loop**

1. In the spec, change the `**Status:**` line to: `built + verified locally (unit suites, mock smoke, browser pass) on <date>; NOT committed, NOT deployed, prod flag unset — awaiting a real Snapchat account (see _e2e/README-snap.md §1)`.
2. Do NOT commit or push — the owner decides. Report the file list (`git status --short`) in the closing message, with the manual-setup checklist and the two facts the owner must act on: the partner needs our pixel id + CAPI token; the refresh token is minted through `/api/snap/oauth/start`.

---

## Self-review notes (writing-plans)

- **Spec coverage:** navigation/gating (Tasks 9, 11, 13, 14, 18 §5) · partner constants (1) · registry (6) · client (5) · OAuth helper (15) · validator (2) · wave route + pump + store scope (4, 8) · task manager (11) · launcher (12, 13) · keys page (7, 14) · report reader (7) · mock/smoke/runbook (16, 17) · verification (18). The "Sent"-style drawer labels, the `sn` partner tag and the no-new-columns rule are honoured in Tasks 8 and 11.
- **Type consistency:** `SnapLaunchShotIn` (Task 2) is the wire for the board (12/13), the route (8) and the pump (4); `SnapResolved` is shared by 2/4/8; `SnapKeyRow`/`SnapKeyBinding` (6) are consumed by 7/10/14; `SnapPumpShot.ctx` fields match what `handleSnapLaunch` fills; `snapBidLabel(strategy, bidMicro, currency)` is the one label builder (2/8); the drawer's `SnapRemoteRow` matches `toClient` in Task 8.
- **Known judgement calls:** the drawer shows budgets with the USD symbol (the rail's accounts are USD; the row does not store a currency); creatives are limited to 32 MB single-part uploads; the mock returns HTTP 400 top-level errors (the client also understands item-level `sub_request_status: ERROR`).
