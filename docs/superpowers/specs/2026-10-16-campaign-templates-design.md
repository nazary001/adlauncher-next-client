# Campaign templates — a buyer's saved card, re-usable by the whole team

Owner ask, 16.10.2026 (verbatim, shortened): «добавить функционал темплейтов … каждый может создать свой
темплейт кампании для будущих запусков … все поля необходимые кроме креатива … применять его на все свои
запуски … все должны видеть темплейты всех, но свои должны быть … подсвечены … разбито по имени кто их
создал … каждый может управлять только своими … овнер роли могут всех редачить и удалять … выкати на прод».
Applies to BOTH launchers (glo-01 and glo-02 run this one codebase — `lib/team.ts`).

## 1. What a template is

A **template** is a named snapshot of a launcher card's settings — everything the card carries
EXCEPT its creatives — saved on the server (the team's own Mongo database), owned by the buyer who
saved it, visible to every login of the team, applicable to any card of the FB launcher board.

* **Scope: the Facebook launcher board** (`/`, `components/launcher-board.tsx`), every partner the
  team has (HS / MO / AIF / AV). A template belongs to the partner it was saved on: an HS template
  carries a LION profile, a redirect type and a pasted link; an MO template a landing slug and an
  account of the MO token — the pickers differ, so the picker only ever offers the active partner's
  templates. The Google / TikTok / Snapchat cards are not in this iteration (their own card shapes;
  the store is partner-keyed so they can join later under their own key).
* **Fields a template may carry** (`lib/templates.ts` `TEMPLATE_KEYS`): `name` (the typed tail),
  `profile`, `account`, `page`, `pixel`, `toolSession`, `objective`, `optimization`, `bidStrategy`,
  `conversionEvent`, `budget`, `bidCap`, `landing`, `link`, `title`, `copy`, `cta`, `redirectType`,
  `paramMode`, `headline`, `countries`, `locales`, `category`, `placement`, `platforms`, `ageMin`,
  `userOs`. **Never**: `files` (creatives — owner rule), `gcm` (every card claims its own marker),
  `id`, `collapsed`, `namePrefix` (derived from the partner and the day), `autoPage` (board memory).
* A template carries only the keys the buyer TICKED when saving (the save form lists the partner's
  fields, grouped like the card, every one ticked except `name`); applying it touches only those keys.
  Untouched keys keep what the card has.

## 2. Storage — `launch_templates` (per-team database)

```
{ id, documentId, createdAt, updatedAt, publishedAt,     // the Strapi envelope (lib/store insertFresh)
  platform: "facebook",
  partner: "br" | "in" | "us" | "av",
  owner: "<username>",                                   // the session's username, exact
  name: "Cars US lowest cost",                           // 1..60 chars, trimmed
  name_key: "cars us lowest cost",                       // lower-cased, spaces collapsed — the unique key
  description: "…",                                      // 0..240 chars
  fields: { countries: ["US"], budget: "7", … },         // TEMPLATE_KEYS only, validated
  uses: 12, last_used_at: Date | null,                   // bumped on every apply
  updated_by: "<username>" }
```

Indexes (`scripts/ensure-indexes.mjs`, `tests/_mongo.ts`): the envelope, `{partner, updatedAt}`,
`{owner, partner, name_key}` UNIQUE — one name per buyer per partner. A save under a name the buyer
already uses answers `409 template_exists` + the existing template, and the UI offers **Replace**.
`TEMPLATES_PER_USER_MAX = 100` per partner (`409 template_limit`).

`scripts/rename-user.mjs` moves `owner` / `updated_by` with the login, like task and queue rows.

## 3. API — `/api/templates` (need `always`: every team, every login)

| | | |
|---|---|---|
| `GET /api/templates?partner=in` | → `{ ok, templates: CampaignTemplate[], me, owner }` | any login; `partner` optional (then every partner of the team) |
| `POST /api/templates` | body `{ name, description?, partner, fields }` → `{ ok, template }` | any login; `partner` must be one of `TEAM.partners`; `fields` whitelisted + typed; 409 on a name the buyer already uses / the per-user cap |
| `PATCH /api/templates/<documentId>` | body `{ name?, description?, fields? }` → `{ ok, template }` | the template's owner, or an owner-role session (`lib/roles isOwnerSession`) — else 403 |
| `DELETE /api/templates/<documentId>` | → `{ ok }` | same rule as PATCH |
| `POST /api/templates/<documentId>/use` | → `{ ok }` | any login — bumps `uses` + `last_used_at` (best-effort, fire-and-forget from the client) |

Every write re-reads the row and answers it, so the client state is the server's. The server never
trusts a client-side "I am the owner" — the rule is `canManageTemplate(session, template)` on the
server; the client only mirrors it to show or hide buttons (`SessionUser.owner` is computed
server-side already).

## 4. The pure rules — `lib/templates.ts` (import-free apart from `lib/types` / `lib/catalog`)

* `templateFieldsFrom(card, keys)` — the snapshot: the ticked keys only, arrays copied.
* `sanitizeTemplateFields(raw)` — the server's whitelist: unknown keys dropped, every value a string
  (or `string[]` for `countries` / `locales`, the `optimization` enum), capped at the card's own
  maxLength (name 400, title 255, copy 2000, link / landing 2000, …).
* `parseTemplateInput(body, partners)` / `parseTemplatePatch(body)` — name required (trimmed, ≤ 60),
  description ≤ 240, partner ∈ the team's.
* `applyTemplate(card, template, me)` — the merge: the template's keys land on the card; arrays are
  fresh copies; `objective` ↔ `conversionEvent` stay a valid pair (an event the new objective does not
  allow falls back to that objective's first); a carried `page` clears `autoPage` (it is now the
  buyer's own pick, never moved by the fill); a carried `name` whose " - " segments repeat the
  template owner's login get the applying buyer's login instead (`lib/own-name` grammar — a template
  saved by Tima as "Tima - CARS" lands on Devich's card as "Devich - CARS"). `id`, `files`, `gcm`,
  `namePrefix`, `collapsed` never move.
* `canManageTemplate(me, template)` — own, or owner role.
* `groupTemplates(list, me)` — "Your templates" first (highlighted), then one group per other creator,
  creators A→Z, templates newest-updated first inside a group.
* `filterTemplates(list, query)` — every typed word must match the name, description or creator.
* `templateSummary(template)` — the chips a row shows: geo, $budget, bid kind + amount, event /
  optimization, profile / account / page presence, field count.

## 5. The UI

* **Card header** — two icon buttons next to Duplicate / Remove: **Apply template** (opens the picker
  for THIS card) and **Save as template** (opens the save form seeded from the card).
* **Board toolbar** — a **Templates** button (next to "Copy to all"): the picker in board mode —
  **Apply to all N cards**, **New card from template** (appends a prefilled card), and the library.
* **Save form** (`components/save-template-modal.tsx`): name, description, the field checklist with
  live previews (grouped Setup / Delivery / Creative / Targeting; `name` unticked by default, creatives
  named as never saved). On `409 template_exists`: "You already have «X» — Replace it?" → PATCH.
  Edit mode (from the picker): same form, seeded from the template, saves with PATCH.
* **Picker** (`components/templates-modal.tsx`): search box; the partner it is scoped to; groups as in
  §4 — the buyer's own group carries an accent border + a "you" tag, every row shows name,
  description, the summary chips, "used N× · updated <when>", and expands to the full field list.
  Row actions: **Apply** (primary — this card / all cards / new card by mode); for own templates (or
  an owner-role login): **Edit**, **Overwrite with this card** (card mode), **Delete** (confirm in
  place); for others': **Copy to mine** (a fork under the buyer's name). Empty state names the way in.
* After an apply the modal closes, the card(s) pulse (the Launch-bay jump highlight), the toolbar
  shows "Template «X» applied to N card(s)" for a few seconds, and `/use` is bumped.
* `components/use-templates.ts`: one hook per board — loads the active partner's list, refreshes on
  partner switch / focus (≥ 15 s) / after every write; create / update / remove / fork / use.

## 6. Team gates

`lib/team.ts` `API_NEEDS` += `["/api/templates", "always"]`; `tests/team.test.ts` glo-02 surface
+3 rows. Nothing else changes per team — a glo-02 buyer sees only HS templates because the team has
only HS; the server refuses a template for a partner the team does not have (`partner_not_available`).

## 7. Testing

* `tests/templates.test.ts` — the pure rules (§4), every branch.
* `tests/mongo-templates.test.ts` — the store on `gc_test`: create / list by partner / unique name
  (409) / per-user cap / patch / use bump / delete / fork.
* `tests/team.test.ts` — the new route rows.
* `tsc`, `eslint`, the full suite, a `next build` on the bench env.
* Bench (`_e2e/_templates_ui.mts`): dev server + fake LION, headless Chrome — save an HS card as a
  template, apply it to a fresh card, apply to all, rename, delete; API checks for the 403 / 409 paths.

## 8. Not in this iteration

Google / TikTok / Snapchat cards; sharing a template across partners; per-buyer favourites;
a template carrying creatives (owner rule: never).
