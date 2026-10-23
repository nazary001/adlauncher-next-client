# VC (ValueClick) — the launcher partner (23.10.2026)

ValueClick (`app.valueclick.io`, partner login) monetizes **search-arb / RSOC** traffic. A buyer creates a
**Landingpage** in VC (Search Arb → Landingpages → Create: name `GC | RSOC | DE | FB | <buyer> | DDMMYY | GEO |
lang | Topic`, domain *QualityDays*, traffic source *Meta*, article title + keywords, country/language) and gets
one link per landingpage:

    https://www.qualitydays.com/rsp/<article-slug>/?cmpid=<landingpage id>[&sty=…&hl=…&sa=1&terms=…]

VC wants `adtitle=<the ad's title>` on it (its Link Generator: "Important: Enter the Title of the Ad /
Creative"). Clicks are matched by Meta's own `fbclid`; VC fires **Purchase** (value = a share of the click
revenue, Settings → Meta → *Conversion Value Percentage*) into the landingpage's pixel through the
**Conversions API** — the landingpage's *Tracking* holds Pixel-ID + token + event. VC also offers S2S
postbacks (Settings → Postbacks: `clickid`, `source_clickid`, `revenue`, `lpa_id`, …) — not used by the launcher.

## In the launcher (`lib/vc-link.ts`, `lib/vc-launch.ts`, `app/api/vc/*`)

| | |
|---|---|
| Partner | `vc`, label **VC**, name prefix `[DD/MM] (VC) - `, GLO-01 only (`lib/team.ts`) |
| Destination | the pasted landingpage link in `Campaign.landing` — `vcDestination` accepts only VC domains (`VC_HOSTS`: qualitydays.com) with a `cmpid`; the launch writes `adtitle` = the card's headline (else title) |
| Pixel | `VC_PIXEL` **1505591128290736** — never a pick (`vcDelivery`): Purchase / min-ROAS → Sales + `OFFSITE_CONVERSIONS`/`VALUE` on it; Clicks → Traffic + `LINK_CLICKS`, no pixel. The route refuses a Purchase launch on a cabinet the pixel is not shared to (`pixel_not_on_account`) |
| Signer | `/tokens` → **VC · Launches** (`vc.launch`), no env default. It must be a system user with `ads_management` on the VC cabinets — the token in VC's Tracking is a Conversions-API dataset token (`read_ads_dataset_quality` only) and cannot launch |
| Channels | FB Token (direct Graph, needs the VC token) or **TOOL** (`via:"tool"`, Ads Manager sessions) — TOOL needs **no VC token**: VC's cabinets in TOOL are the ones named `GC-VD-C1-DE-*` or seen by a session filed under TOOL's **"VC" project** (`lib/vc-tool.ts`, `/api/tool/ready?partner=vc`; with a token, its TOOL-visible cabinets count too). Without a token the card takes a **typed fanpage id** and TOOL checks page + pixel at publish |
| Languages | a static table of Meta ad-locale keys (`lib/locale-keys.ts`, read 23.10 with `locale=en_US`); a language Meta has no locale for (Amharic, Zulu) is refused, never dropped |
| Queue | scope `vc`, kind `vc.launch` (+ `tool.follow`), drawer **VC Tasks** (`partner:"vc"` rows; the marker column shows the `cmpid`) |
| Tracking hint | the card shows what the landingpage's Tracking in VC must say — Pixel-ID, the CAPI token (server env `VC_CAPI_TOKEN`, `GET /api/vc/tracking`, signed-in only) and Purchase — plus which events the pixel received (Meta dataset-quality API on the same token) |
| Clones | not built — `/clone?partner=vc` shows a notice, `/api/clone/*` answers `clone_not_available` |

Offline bench: `_e2e/_bench-vc.env.sh` + `GRAPH_MOCK_EXTRA_PIXELS="1505591128290736:VC pixel"` on the Graph
mock, then `_e2e/_adl_vc_smoke.mts` (token rail + queue) and `_e2e/_adl_vc_ui.mts` (browser). TOOL without a
token: `PORT=3197 node _e2e/_tool_mock.mjs` + `TOOL_SESSIONS_BASE=http://127.0.0.1:3197 TOOL_SESSIONS_API_KEY=x`
on the app, then `_e2e/_adl_vc_tool_smoke.mts` and `VC_UI_TOOL=1 … _adl_vc_ui.mts`. Unit tests:
`tests/vc-link.test.ts`, `tests/vc-tool.test.ts`, `tests/locale-keys.test.ts`.

TOOL API (23.10, `tool.gctracking.xyz/api/docs`, `/api/openapi.json`): launches are `POST /api/v1/accounts/{id}/campaigns`
(dry_run | validate | publish, optional `session_id`, `delay_seconds` / `start_at`), media `…/media/{videos|images}/from-url`,
jobs, duplicates; sessions are filed under team **projects** (`GET/POST/DELETE /api/v1/projects`; on 23.10: AV, HS — no VC yet,
and no session saw a VC cabinet).
