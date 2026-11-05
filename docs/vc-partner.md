# VC (ValueClick) — the launcher partner (23.10.2026)

ValueClick (`app.valueclick.io`, partner login) has two products — **Search Arb** (RSOC, `…/rsp/<article>/?cmpid=…`)
and **Content Arb** (quizzes / personality tests). The launcher runs **Content Arb only** (owner 23.10: «нужен content arb
только»); a Search Arb link is refused (`destination_search_arb`).

A buyer creates a Content Arb **Landingpage** in VC (Content Arb → Landingpages → Create: name `<Niche> | <quiz title>`,
domain *QualityDays*, traffic source *Meta*, content type *Personality Test*) and gets one link per landingpage, its
last slug word = the landingpage id:

    https://www.qualitydays.com/coa/<quiz-slug>-<landingpage id>/

Nothing of ours is added to it — the ad points at our DE Postback tracking link, which redirects to it (see *Tracking link*). Clicks are matched by Meta's own `fbclid`; VC fires **Purchase** (value = a share of
the page's ad revenue) into the landingpage's pixel through the **Conversions API** — the landingpage's *Tracking*
holds Pixel-ID + token + event (every active Content Arb landingpage on 23.10: pixel 1505591128290736 + Purchase).

**Ready landingpages** (`VC_READY_LINKS`, owner 23.10: «все активные … сразу по дефолту добавь в автовыбор»): the 9
landingpages VC listed *Active* on 23.10 (Relationships, 2× Dating, Fashion, Food, Home / Lifestyle, Money / Finance,
Automotive, Career / Jobs; all EN, all 200) — plus the three **Black Friday** landingpages the owner created on 05.11
(ask: «3 последние лендинга которые я создал по black friday, добавь их в наш адлаунчер»): `d3k4c7b7ek` *What Is Your
Black Friday Shopping Superpower?*, `kcvhp9yt0f` *Are You a Smart Planner or a Spontaneous Shopper?*, `yqj0on8cgc` *What
Does Your Black Friday Shopping Style Reveal About You?* (niche "Black Friday / Shopping", EN, all 200). Their VC Tracking
fires **Lead** into the S-1 nik pixel 2126539511577664, not Purchase into the VC pixel — each row carries `event`
(PURCHASE / LEAD), the picker tags them "EN · Lead" and the card's field hint says so: a launch on them should optimize
the Lead event on that dataset. The card's **"Pick a ready VC quiz"** list fills the link field; any other Content Arb
link can still be pasted. A new landingpage = one `ready(…)` row in `lib/vc-link.ts`.

## In the launcher (`lib/vc-link.ts`, `lib/vc-launch.ts`, `app/api/vc/*`)

| | |
|---|---|
| Partner | `vc`, label **VC**, name prefix `[DD/MM] (VC) - `, GLO-01 only (`lib/team.ts`) |
| Name | `[DD/MM] (VC) - <landingpage title> - <the buyer's tail>` (owner 05.11: «в нейминг добавлялось название самой статьи»): the title of the Content Arb landingpage the card points at — a ready one's own VC title, any other link's quiz slug as words — pinned into the card's LOCKED prefix by the board (`pinVcNamePrefix`) and rebuilt by the route from the resolved link (`vcServerName`; a tail that already carries the title as a segment is not doubled). The buyer types only the tail |
| Destination | the landingpage link in `Campaign.landing` (picked from the ready list or pasted) — `vcDestination` accepts only VC domains (`VC_HOSTS`: qualitydays.com) and only `/coa/<quiz>-<id>/`; launched as VC prints it (https, trailing slash, the buyer's own query params kept) |
| Tracking link | **DE Postback** (owner 26.10, `lib/vc-pb.ts`): before anything is claimed, the route asks `POST https://pb.gctracking.xyz/api/v1/pb/links` (`{url: <the landingpage link>, name: "VC · <quiz>-<id>"}`, Bearer `VC_PB_TOKEN`, server env) for the landingpage's tracking link — idempotent: 201 new / 200 the same link again — and the ad (Graph and TOOL) points at `https://trackwow3.xyz/r/<link_id>?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}` as is (Meta fills the macros). A click is logged and 302'd to the landingpage + `click_id` (fbclid passes through); DE posts conversions back by click_id → `GET /api/v1/pb/revenue?group_by=campaign_id,…` (USD; same token). No tracking link = no launch: `pb_not_configured` (no env), `pb_token_rejected` (401/403), `pb_link_refused` (400), `pb_unreachable` / `pb_failed` (one retry, then 502), `pb_link_invalid` / `pb_link_mismatch` (an answer without the macros / for another link) — all before any write, retryable from the task manager. The task row's `link` = the tracking link; the done line also carries `landing` + `pb_link_id` |
| Pixel / mode | never a pick — the card's **Optimization** is the mode (`VcMode`, `vcModeOf` = optimization + event; `vcDelivery` pins the rest): **Purchase (VC pixel)** = Sales + `OFFSITE_CONVERSIONS` PURCHASE on `VC_PIXEL` **1505591128290736** (min-ROAS → `VALUE` there, whatever the mode); **Lead (S-1 nik pixel)** (owner 05.11: «возможность заливать на событие Lead») = `OUTCOME_LEADS` + `OFFSITE_CONVERSIONS` LEAD on `VC_LEAD_PIXEL` **2126539511577664** (the dataset the Lead clones go on too — Meta allows LEAD only under Leads); **Link clicks** → Traffic + `LINK_CLICKS`, no pixel. Picking a ready landingpage sets the mode its VC Tracking asks for (`vcReadyMode`: the Black Friday three → Lead, the 23.10 nine → Purchase; a clicks / min-ROAS card is left alone), and a ready landingpage launched to optimize the OTHER event is named under Optimization, held by readiness and refused by the route (`vcReadyEventMismatch`, `event_mismatch`). The route refuses a Purchase / Lead launch on a cabinet its pixel is not shared to (`pixel_not_on_account`, named). Through TOOL a Lead launch is `OUTCOME_LEADS` / `OFFSITE_CONVERSIONS` / `WEBSITE` LEAD — TOOL's `/capabilities` (05.11) enables Leads with that goal and location but lists only `LEAD_GENERATION`/`ON_AD` as CONFIRMED, so the body rides with `allow_inferred` like every other non-confirmed combo |
| Signer | `/tokens` → **VC · Launches** (`vc.launch`), no env default. A system user with `ads_management` on the VC cabinets — on 23.10 «Lecarthelaouforvc» (app AV ANNA 10): GC-for-VC-BR-742 … -762 (21, BM VD-C1) + 10 fanpages. Only cabinets named `GC-for-VC-*` are offered (`isVcAccountName`; the user also holds a stray «rr»). The token in VC's Tracking is a Conversions-API dataset token (`read_ads_dataset_quality` only) and cannot launch |
| Channels | FB Token (direct Graph, needs the VC token) or **TOOL** (`via:"tool"`, Ads Manager sessions) — TOOL needs **no VC token**: VC's cabinets in TOOL are the ones named `GC-for-VC-*` or seen by a session filed under TOOL's **"VC" project** (`lib/vc-tool.ts`, `/api/tool/ready?partner=vc`; with a token, its TOOL-visible cabinets count too). Without a token the card takes a **typed fanpage id** and TOOL checks page + pixel at publish |
| Languages | a static table of Meta ad-locale keys (`lib/locale-keys.ts`, read 23.10 with `locale=en_US`); a language Meta has no locale for (Amharic, Zulu) is refused, never dropped |
| Queue | scope `vc`, kind `vc.launch` (+ `tool.follow`), drawer **VC Tasks** (`partner:"vc"` rows; the marker column shows the landingpage id, `LP …`) |
| ~~Tracking hint~~ | REMOVED 23.10 (owner: «это поле нужно его удалить») together with `GET /api/vc/tracking` — the ready landingpages already carry their Tracking. Was: the card showed what the landingpage's Tracking in VC must say — Pixel-ID, the CAPI token (server env `VC_CAPI_TOKEN`, `GET /api/vc/tracking`, signed-in only) and Purchase — plus which events the pixel received (Meta dataset-quality API on the same token) |
| Clones | **the VC clone board** (05.11, owner: «сделать клоны всех активных кампаний на этот новый пиксель … бид 0.5 … добавь слово Lead … лид оптимизацию»): `/clone?partner=vc` lists every ACTIVE campaign of the VC cabinets itself (`GET /api/vc/sources`, read with the clone signer — **VC · Clones** when assigned, else **VC · Launches**, `vcCloneRail`; or `?ids=` for a deep link) and clones the selected ones with ONE set of settings (`lib/vc-clone`): the **pixel** (the known VC datasets — `VC_LEAD_PIXEL` **2126539511577664 "S-1 nik pixel"** / `VC_PIXEL` — or any pixel of the cabinet), the **event** (Lead = `OUTCOME_LEADS` + LEAD — Meta allows LEAD only there; Purchase = Sales + PURCHASE), the **bid** (strategy + cap / ROAS goal, or the source's own), an optional **budget** (else the source's), a **name suffix** joined as its own ` - ` segment (`vcCloneName`, once). Defaults = the owner's ask (`VC_CLONE_DEFAULTS`: Lead on S-1, bid cap $0,50, " - Lead"). A clone is a faithful RECREATE in the source's own cabinet (`lib/vc-clone-run`, entered through `POST /api/clone/run` with `partnerId:"vc"` — the queue's `fb.clone` kind, scope `vc`, the VC drawer): one Graph read of the source tree (`VC_SOURCE_FIELDS`), the refusals (`vcCloneRefusal` + pixel on the cabinet + the token holds the source's page + a reusable ad) BEFORE any claim, the account slot, then campaign → ad set → one creative + ad **per source ad** (video or static image, same page / copy / media, the ad link — the DE Postback tracking link — untouched: Meta fills its macros per clone) — on the VC token, or **through TOOL** (`via:"tool"`: one CampaignRequest on the source's own account-local media; offered only when a live TOOL session sees VC's cabinets, `/api/tool/ready?partner=vc&rail=clone`). Clones are ACTIVE at birth. `/api/clone/sources?partner=vc` stays refused (the VC board has its own read) |

Offline bench: `_e2e/_bench-vc.env.sh` (+ the DE Postback mock: `PORT=3196 node _e2e/_pb_mock.mjs`, app env `VC_PB_BASE=http://127.0.0.1:3196 VC_PB_TOKEN=e2e-pb-token`) + `GRAPH_MOCK_ACCOUNT_PREFIX=GC-for-VC-BR-E2E- GRAPH_MOCK_EXTRA_PIXELS="1505591128290736:VC pixel"`
on the Graph mock (since 05.11 `GRAPH_MOCK_EXTRA_PIXELS="1505591128290736:VC pixel,2126539511577664:S-1 nik pixel"` — the Lead
launch needs the second), then `_e2e/_adl_vc_smoke.mts` (token rail + queue) and `_e2e/_adl_vc_ui.mts` (browser). TOOL without a
token: `PORT=3197 node _e2e/_tool_mock.mjs` + `TOOL_SESSIONS_BASE=http://127.0.0.1:3197 TOOL_SESSIONS_API_KEY=x`
on the app, then `_e2e/_adl_vc_tool_smoke.mts` and `VC_UI_TOOL=1 … _adl_vc_ui.mts`. Unit tests:
`tests/vc-link.test.ts`, `tests/vc-pb.test.ts`, `tests/vc-tool.test.ts`, `tests/locale-keys.test.ts`.

TOOL API (23.10, `tool.gctracking.xyz/api/docs`, `/api/openapi.json`): launches are `POST /api/v1/accounts/{id}/campaigns`
(dry_run | validate | publish, optional `session_id`, `delay_seconds` / `start_at`), media `…/media/{videos|images}/from-url`,
jobs, duplicates; sessions are filed under team **projects** (`GET/POST/DELETE /api/v1/projects`; on 23.10 (re-read in the
afternoon): AV, HS only — 17 sessions, none sees a GC-for-VC cabinet, so VC through TOOL waits for a session).

**Pixel (23.10):** 1505591128290736 is NOT shared to any GC-for-VC-BR cabinet and the VC system user cannot read it
(`Missing perms`) — until the pixel's owner shares it to those cabinets (Events Manager → the dataset → assign ad
accounts / the system user), a Purchase launch is refused before any write (`pixel_not_on_account`); Traffic (link
clicks) launches work.
