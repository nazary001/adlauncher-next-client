# AIF (Airfind) link contract — RW + Quiz Flow

Two Airfind client accounts, two link shapes, ONE postback endpoint and ONE CAPI forwarder on our
side. The shapes live in `lib/aif-link.ts` (pure — the launch route, the card preview and
`node --test tests/aif-link.test.ts` share it).

| flow | partner account | link the ad points at |
| --- | --- | --- |
| `rw` (Google Rewarded Web) | clientId **52105**, `content.honeyandhues.com` | `https://content.honeyandhues.com/rewarded?destination=<slug>&clientId=52105&brand=testNN&ppid={{campaign.id}}[&pixel=<id>]` |
| `quiz` (Quiz Flow Rewarded Web, 23.09.2026) | clientId **52149**, `swiftsearch.co` | `https://swiftsearch.co/article/<slug>?layout=qcow&clientId=52149&brand=testNN&ppid={{campaign.id}}[&pixel=<id>]` |

- `brand` = the campaign's revenue key from the `aif-maps` registry (test01…test700, one per
  campaign, never reused — ONE unique-brand space across both flows; the registry note says
  `(RW · clientId 52105)` / `(Quiz Flow · clientId 52149)`).
- `ppid={{campaign.id}}` = Meta macro, literal in the link (the page echoes it into the postback;
  the forwarder puts it in `custom_data.ppid`).
- `pixel=<id>` = the pixel the ad set optimizes for; the forwarder routes the Purchase into it.
  Click launches carry none.
- Meta appends `fbclid`; the page turns it into `fbc`.

## Where the flow lives

The flow is a property of the ARTICLE: `Landing.flow` on the catalog entry in `lib/partners.ts`
(`AIF_LANDINGS`, section "Quiz Flow", tagged **QUIZ** in the picker). Nothing else changes:

- the card preview and the launched link both come from `landingUrlSegments` →
  `aifLinkSegments(aifFlowOf(landings, slug), …)`;
- `/api/aif/launch` validates the slug against the same catalog and derives the flow from it (a
  crafted POST cannot point a brand at the wrong partner account);
- clones swap `brand=` / `pixel=` by query param (`swapBrand`/`swapPixel` in `lib/clone-run.ts`),
  so a quiz link clones like an RW link;
- task rows, drafts and the Strapi schema need no new field.

**Adding a quiz article** = one line in `AIF_LANDINGS` with `niche: "Quiz Flow", flow: "quiz"`
(keep the section contiguous — the picker's group headers rely on it).

## Postback → CAPI

Both pages fire the partner's `rewardedRewardGrantedJS` slot when the user completes the reward
ad. Our snippet echoes every query param to `https://trackfl7.xyz/api/v1/airfind` via
`navigator.sendBeacon`; for the quiz flow it also sends `path=<pathname>` (the slug is in the path,
not in the query). The HS box (`fb_tools/func/pb_capi.py`, v4) gates on
`clientId ∈ {52105, 52149}` + `brand ~ ^test\d{1,3}$`, builds `event_source_url` per flow, and
sends a **Purchase** (value 0) into the pixel named by `pixel=`; `custom_data` carries `client_id`
and `flow` so RW and Quiz are tellable apart in Events Manager. Viewer: `/fb/pb/raw?partner=airfind`
and `/fb/pb/capi` on hs.gctracking.xyz.
