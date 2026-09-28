# ActiveView (AV) — findings from exploring app.activeview.io (2026-09-25)

Explored while logged in as owner "Danil Kuprin", company **Globecoders** (ID 1bab17a5-…). Nothing was created or changed.

## 1. What ActiveView is

ActiveView is a **Google Ad Manager (GAM) monetization partner** for arbitrage publishers (MCM child-publisher model). The publisher (us) runs content sites; AV supplies:

- a GAM network (they are the MCM parent, ad-unit paths are `/198073784/<script_name>_<device>_<slot>`; our **child network code = 2550370616**),
- the on-page JS ("ActiveView script") that renders ad units, does rebids, sends session data to their CDP (`api-stream-service-production.activeview.app/send-data`),
- optional **ActiveHost**: they host the site itself (thecadrion.com is served via their Astro "active-press" skin with images on Cloudflare R2). ActiveHost = Yes for our site,
- dashboards + an external REST API for reports / pricing rules / redirects.

Revenue share: **MCM Revshare 10%** (Company → Fixed cost setup). Net revenue = gross − 10% (+ taxes/other costs if set).

Our current state: **1 GAM, 1 site, revenue $0**, no traffic sources connected, no UTM values registered, no redirects, pricing rules NOT_REQUESTED (unlock needs ≥ $350 avg revenue / 7 days).

## 2. Our site: thecadrion.com

Websites List (Settings → Websites List):

| Site URL | GAM account | Network code | ActiveHost | Pricing rule | Management model | Script name |
|---|---|---|---|---|---|---|
| thecadrion.com | 2550370616 | 2550370616 | Yes | Inactive | MP | thecadrion |

Management models counters: MI 00 / MA 00 / MP 01 (MP = ours; `/me` API returns `delegation_type` e.g. "MA"; MI/MA/MP = Manage-Inventory / Manage-Account / (MP likely their newest "Managed Publisher/Platform" model)).

Site content: niche "government surplus / liquidation auctions" articles (GovDeals, B-Stock, …). Article URL pattern seen: `/cow-long-rec-govdeals-surplus-auctions-1-twjmh` → prefix encodes template: `cow` (Content Offer Wall?) + `long` + `rec` + slug + index + random suffix. Home page: category nav "Bidding Strategies / Liquidation Marketplaces / Buying Guides / Sourcing & Reselling".

### Ad units published on thecadrion.com (Ad Inventory → Ad Units Setup)

| Type | Blocks |
|---|---|
| Interstitial (2) | `/198073784/tcn_mobile_interstitial`, `/198073784/tcn_desktop_interstitial` |
| Anchor (2) | `/198073784/tcn_mobile_anchor`, `/198073784/tcn_desktop_anchor` |
| Static Content (6) | `tcn_mobile_top`, `tcn_mobile_content_1`, `tcn_mobile_content_2`, `tcn_desktop_top`, `tcn_desktop_content_1`, `tcn_desktop_content_2` |
| Offerwall / COW / Fixed / Rewarded | none created (buttons "New Offerwall / New COW / New Fixed / New Rewarded") |

Each block has: Country (multi, default any), Rebid ON/OFF, **UTM Source Key targeting** (choose key: utmSource / utmCampaign / utmMedium / utmContent / utmTerm / utmOw / utmCampaignTerm / utmCampaignMedium + value, default any), **URL Pattern** (default any), plus type-specific: Drift (follow scroll), "Show Ad after COW/OW", Anchor position Top/Bottom, Delay (seconds or scroll %), Ad Display Condition before/after interstitial. Changes autosave but need **Publish**.

→ Ad delivery can be segmented per traffic source / campaign via UTM key targeting. This means AV expects **UTM parameters on every landing URL**.

### What the AV script actually sends to GAM (observed on an article page)

GAM ad request (`securepubads.g.doubleclick.net/gampad/ads`) carried:

```
iu_parts=198073784,tcn_desktop_content_1   (and _rebid variants, tcn_desktop_top_rebid …)
prev_scp = price_rule=0.0X&marketplace=adexchange
cust_params =
  experiment=control
  utm_source=null
  utm_medium=null
  utm_campaign=null
  utm_content=null
  utm_term=null
  request_uri=/cow-long-rec-govdeals-surplus-auctions-
  land_uri=/cow-long-rec-govdeals-surplus-auctions-
  utm_campaign_medium=null_null
  utm_campaign_term=null_null
  utm_source_land_uri=null_/cow-long-rec-govdeals-surplus-auct
```

So GAM key-values are: `utm_source, utm_medium, utm_campaign, utm_content, utm_term, request_uri, land_uri, utm_campaign_medium, utm_campaign_term, utm_source_land_uri, experiment, price_rule, marketplace`. All the `utm_*` are read straight from the landing URL query string. `utm_campaign` is THE key for per-campaign revenue attribution (KVP report `key=utm_campaign`). Ad requests returned 503 in my session (probably no fill for my geo/session or a bot filter) — not relevant.

## 3. UI sections (sidebar)

- **Dashboard** (/overview): Net Revenue / Gross Revenue, ROI, Traffic Acquisition Breakdown (Google %, Facebook %) — needs connected ad accounts; Main metrics RPS, eCPM, PMR, Viewability, CPC, CTR; Rankings top-3 Sites/URIs. Data refreshes hourly after script is live.
- **Reports**:
  - Key Values (/reports/key-values): Network code → Site → Date → table of GAM key-values (utm_* etc.).
  - Ranking (/reports/ranking-top-uri): revenue/RPS/eCPM/CPC/CTR/clicks/impressions ranking by URIs or sites, date range.
  - Ad Optimizations (/reports/adops): metrics comparison of two date ranges.
  - Hourly (/reports/hourly): by date, network, site, channel; group Raw / Ad unit / Channel.
  - CDP Data Analysis (/reports/data-analysis): GCLID list, FBCLID list (exportable, segmentable by campaign source/date), User Behavior Sankey.
  - Exposure (BETA), AdUnit Performance.
- **Campaign Analysis** (/campaign-analysis/google-ads → onboarding/connect): connect **Meta Ads** (Facebook OAuth) and **Google Ads** accounts; AV imports campaigns hourly and matches them to revenue. Requirement: Google — UTM must include Campaign ID (`utm_campaign={campaignid}` via account-level tracking template); Meta — follow their URL dynamic params (`{{campaign.id}}` etc.). Same connectors are in Settings → General → Connections.
- **UTM Campaign Values** (/utm-campaign-values): registry of values for the `utm_campaign` key ("All new values will be associated with the utm_campaign key. If you would like to register additional keys, contact the AdOps team"). Create page: pick Website + Method (`Add values manually` | `Upload file`). Only values created in the app are listed (values created directly in GAM are not shown). This is GAM's "predefined key-value values" — GAM KVP reporting only reports on registered values, so **every campaign name we send as utm_campaign should be registered here** (or via Meta/Google connectors which auto-register campaign IDs).
- **Pricing Rules** (/price-rules): per-site floor-price rules (ad_unit × country × device × utm_source × request_uri → rule/floor). Locked until the site makes avg $350/7d; button "Request access". Modes: hybrid / automatic / off (API "rule-mode").
- **Chat Builder (BETA)**: chatbot on a subdomain (GAM Domain Manager root domain + subdomain + DNS keys). Not relevant now.
- **Redirect** (/redirect): traffic-splitting subdomain. Our setup is **stuck at step 2**: subdomain `redirect.thecadrion.com` was created (domain id `cmue7hk5p000ts60oo7x9557n`), waiting for DNS keys to be added in Cloudflare and verified. Once active: create "paths" (`/test`) with fallback URL, each path has "mappings" = list of {url, percentage} (up to 3 destinations, weights). Parameters from the redirect link and from the experiment are merged; fallback goes as `&fllb=<encoded>`. Tabs: Analysis (per redirect/experiment metrics), Experiments (list, "Add new Redirect", gear settings), Help.
- **Benchmark (BETA)**: Compare (vertical × country vs our GAM/site KPIs), Discover (country/vertical niche benchmarks over AV network).
- **Ad Inventory**: Ad Units Setup (see above).
- **Compliance**: Website Compliance Analysis (occurrences open/resolved/urgent) + Compliance Bot (background scans).
- **Notifications**, **Finance (BETA)** (/transfers: bank accounts, payments), **Settings** (General: profile/company/password/connections; Access management (invite members); Activity log; APIs; Websites List).

Front-end: Next.js app; internal API host `av-app-api-fkpjymecua-ue.a.run.app` (Cloud Run); Amplitude + HubSpot tracking.

## 4. External REST API (Settings → APIs)

Base URL: `https://external-api.activeview.app` — HTTPS only. Auth: `Authorization: Bearer <API_KEY>`; the key is shown in Settings → APIs → Authentication (format `<64hex>:<20hex>`). Do not put the key in code; store in the adlauncher token vault. Response codes: 200/400/401/403/404/429/5xx. Postman collection downloadable. LLM docs: `/llms.txt`, `/llms/guide.txt`, `/llms/full.txt`, `/llms/<topic>.txt` (need Bearer too).

All routes except healthcheck wrap the payload in `{ "response": … }` (redirect routes use their own top-level keys).

| # | Endpoint | Purpose / notes |
|---|---|---|
| 1 | `GET /healthcheck/` | public liveness, `{status:"OK",date}` (no envelope) |
| 2 | `GET /me` | sites reachable with the token: `{response:{publisher_id, sites:[{domain, site_name, network_code, parent_network_code, delegation_type}]}}`. 200 = token valid |
| 3 | `GET /rules/:NETWORK_CODE/:DOMAIN` | list price rules: `[{ad_unit,aggressiveness,country,desired_match_rate,device,domain,ecpm,impressions,match_rate,request_uri,revenue,rule,state:"MANUAL"|"AUTO",utm_source}]` |
| 4 | `POST /upsert/:NETWORK_CODE/:DOMAIN` | upsert rules, body `[{ad_unit,country,device,utm_source,request_uri,rule}]` (key = ad_unit+country+device+utm_source+request_uri) |
| 5 | `GET /buckets/:NETWORK_CODE/:DOMAIN` | allowed floor buckets e.g. `[1.0,1.25,1.5,2.0]` (upsert rounds UP) |
| 6 | `DELETE /delete/:NETWORK_CODE/:DOMAIN?dry_run=true` | delete rules by key; dry_run previews |
| 7 | `GET /v1/price-rules/rule-mode/:NETWORK_CODE/:DOMAIN` | `{response:{networkCode,domain,ruleMode:"hybrid"|"automatic"|"off"}}` |
| 8 | `GET /report/:NETWORK_CODE/:DOMAIN?start_date&end_date` | metrics per `request_uri` (same data pricing rules use): `[{ad_unit,country,device,domain,ecpm,eligible_ad_requests,impressions,match_rate,request_uri,responses_served,revenue,utm_source}]` |
| 9 | `GET /report/kvp/:NETWORK_CODE/:DOMAIN?start_date&end_date&key=utm_campaign[&timezone=gam|pacific|gmt_3|cet|eastern]` | **GAM key-value report**: `[{key,value,ad_exchange_line_item_level_revenue (MICROS!), ad_exchange_line_item_level_impressions, _clicks, _ctr, ad_exchange_responses_served, active_view_measurable/viewable_impressions}]` |
| 10 | `GET /report/session/kvp/:NETWORK_CODE/:DOMAIN?key=utm_campaign&start_date&end_date[&timezone]` | **Sessions by key value from their CDP (Snowflake)**: `[{COUNTRY_CODE,COUNTRY_NAME,KEY,RECORDED_DATE,TOTAL,VALUE}]` — no GAM registration needed |
| 11 | `GET /report/gam/custom/:NETWORK_CODE/:DOMAIN?start_date&end_date&dimensions=DATE,HOUR,DOMAIN&metrics=AD_EXCHANGE_LINE_ITEM_LEVEL_REVENUE,…[&key&site_name&order_id]` | custom GAM report with GAM API dimension/metric names (v202308). Revenue in micros |
| 12–14 | `GET /report/:NETWORK_CODE?…&domains=a.com,b.com`, `/report/kvp/:NETWORK_CODE?…&key&domains=`, `/report/gam/custom/:NETWORK_CODE?…&domains=` | multi-domain variants: one GAM report job for all listed domains; include DOMAIN dimension to split |
| 15 | `GET /v1/redirects` | `{redirectDomains:[{id,name:"redirect.test.com",createdAt,redirectPaths:[{id,path}]}]}` |
| 16 | `POST /v1/redirects/:REDIRECT_DOMAIN_ID/path` body `{path:"/test", fallback:"https://…"}` | create path → `{redirectDomains:{id,path,fallbackUrl,redirectType:"FIXED",redirectMappings:[]}}` |
| 17 | `GET /v1/redirects/paths/:REDIRECT_PATH_ID` | path detail incl. mappings `[{percentage,url}]` |
| 18 | `GET /v1/redirects/paths/:REDIRECT_PATH_ID/mappings` | mappings `[{id,percentage,url,redirectPathId,createdAt,updatedAt}]` |
| 19 | `GET /v1/redirects/paths/:REDIRECT_PATH_ID/mappings/logs` | audit log `[{action:CREATE|UPDATE|DELETE,percentage,url,user,timestamp}]` |
| 20 | `PUT /v1/redirects/paths/:REDIRECT_PATH_ID/mappings` body `[{url,percentage},…]` | replace mappings (weights) |

Notes: dates `YYYY-MM-DD`; data is hourly-refreshed, treat as D+1 for finance; revenue in KVP/custom reports is **micros** (÷1,000,000); `/report` revenue is plain currency. No API for: registering UTM campaign values, creating sites/ad units, connecting ad accounts (UI only).

## 5. How a launch would flow with AV (what AV expects)

1. Landing = a page on an AV-approved site running their script (thecadrion.com/…), served by ActiveHost.
2. Every ad URL must carry UTMs; at minimum `utm_source` (google|facebook|tiktok…) and `utm_campaign` (unique per campaign; for Google they want the Campaign ID; for Meta `{{campaign.id}}`/`{{campaign.name}}` dynamic params). Optional `utm_medium`, `utm_term`, `utm_content` (AV also builds combos `utm_campaign_term`, `utm_campaign_medium`, `utm_source_land_uri`).
3. Register the `utm_campaign` value in UTM Campaign Values (UI, manual or file) so the GAM KVP report shows it — or connect the Meta/Google account so AV auto-imports campaigns (Campaign Analysis).
4. Optionally route through `redirect.thecadrion.com/<path>?utm_…` to A/B split landings with weights (API-manageable), fallback via `fllb`.
5. Pull results: `/report/session/kvp?key=utm_campaign` (sessions per campaign per day/country) + `/report/kvp?key=utm_campaign` (revenue/impressions/clicks per campaign, micros) + `/report/:nc/:domain` (per request_uri economics). Net = gross × 0.9.
6. Later: pricing rules per utm_source × request_uri × country × device (needs $350/7d unlock).

## 6. Blockers / to-dos on the AV side (not code)

- Redirect DNS verification not finished (step 2 of 3) — needs the CNAME/TXT keys in Cloudflare for `redirect.thecadrion.com`.
- No Meta/Google account connected in Campaign Analysis.
- No UTM campaign values registered.
- Only one site; ActiveHost content is AV-hosted (we can't deploy our own landing HTML there — unknown whether AV allows uploading custom pages; article pages come from their CMS).
