# Teams — one codebase, one launcher per team

Since 08.10.2026 the launcher serves more than one team. The code is the same; a **build** belongs to
exactly one team, chosen by `NEXT_PUBLIC_ADL_TEAM` (inlined at build time into the client bundle and
the server of that build). Unset = `glo-01` = the launcher as it always was.

| | GLO-01 | GLO-02 |
|---|---|---|
| Launcher | https://adlauncher.gcamazingtool.xyz | https://glo-02adlauncher.gcamazingtool.xyz |
| GitHub repo | `nazary001/adlauncher-next-client` | `nazary001/glo-02adLauncher-next-client` |
| Vercel project (team GlobeCoders) | `adlauncher-next-client` | `glo-02adlauncher-next-client` |
| Local folder | `GC-coding/adlauncher-mongo` | `GC-coding/adLauncher_glo-2` |
| Partners | HS, MO, AIF, AV | HS only |
| HS launch channels | LION, FB token, TOOL | LION only |
| Platform tabs | Facebook, TikTok, Google, Snapchat | Facebook only |
| Owner tools | all | Account access |
| Logins | the shared tools directory (`gc.up_users`) | its own list (`gc_glo02.up_users`) |
| Mongo database (same cluster) | `gc` | `gc_glo02` |
| LION key / acronym | GLO-01 | GLO-02 |
| LION profiles it works on | `glo-01-*`, `globecoders-RENT-*` | `glo-02-*` |
| hs-tools pages registry (fanka gate) | on | off — its pages are not tracked there |
| S3 creative bucket | `gc-adlauncher-creatives` | the same bucket, own key namespace |

Everything a team has is declared in **`lib/team.ts`** and nowhere else. The UI hides the rest; the
server refuses it (`proxy.ts` by route path, the launch queue by job kind, `lib/lion.ts` by profile
and by campaign, `lib/mongo.ts` by database, `lib/session.ts` by the team claim in the cookie).

## What "separated" means here

LION itself separates nothing: every team's API key lists **all** profiles of the company, reads any
of them, reads any campaign and duplicates any campaign (probed 08.10). The launcher keeps each team
on its own:

- **Profiles** — by the slug's prefix (`glo-02-3` is GLO-02's). The list is filtered and every read
  and campaign-creating write refuses a foreign slug before a request leaves.
- **Campaigns met by id** (clone / JURO sources, activation) — by the acronym LION stamps at the head
  of every name it builds (`[06/10] (GLO-01) API - …`), else by the ad account. GLO-02 works only on a
  campaign that is provably its own; GLO-01 on everything except a GLO-02 campaign.
- **Stored state** — users, the launch queue, the task registry, per-account launch limits and
  account assignments live in the team's own database. A build refuses to run on another team's.
- **Sessions** — own `AUTH_SECRET` per team, and the cookie carries the team as well.
- A LION key whose acronym names the other team is refused outright (`lion_team_mismatch`).

## Environment of a team other than GLO-01

Own values — never copied from another team: `NEXT_PUBLIC_ADL_TEAM`, `MONGODB_DB`, `AUTH_SECRET`,
`CRON_SECRET`, `LION_TOKEN`, `LION_ACR`, `ADL_SELF_ORIGIN`. Shared: `MONGODB_URI`, the four
`CREATIVES_S3_*`. Not set at all: every `FB_*` token, `HS_PAGES_API_*`, `TOOL_SESSIONS_*`,
`STRAPI_TOOLS_URL`, the `NEXT_PUBLIC_*_ENABLED` flags of rails the team does not have. See
`.env.example`.

## Logins (GLO-02)

Run from the team's own folder — the script reads its `.env.local` and lands in its database:

```bash
npm run add-user -- <username> --password '<password>'          # a buyer
npm run add-user -- <username> --password '<password>' --role owner
npm run add-user -- <username> --password '<new password>'      # an existing user: new password
npm run add-user -- <username> --block                          # no more logins   (--unblock)
npm run add-user -- --list
```

Usernames are exact and case-sensitive. A blocked or re-passworded user stays signed in until their
cookie runs out (7 days, renewed while they work) — to cut everyone off at once, change the team's
`AUTH_SECRET` and redeploy.

## Shipping an update to both launchers

The second launcher's repo is the first one's history plus nothing of its own — keep it that way.

```bash
# 1. the first launcher, as always
git -C GC-coding/adlauncher-mongo push origin feat/s3-server-queue:main

# 2. the second one: take the same commits, push to ITS repo (Vercel deploys it)
cd GC-coding/adLauncher_glo-2
git pull --ff-only upstream main          # or: git pull --ff-only main-launcher-local <branch> for commits not on GitHub yet
git push origin main
```

`upstream` (the first launcher's GitHub repo) is fetch-only in that folder on purpose.

## Giving GLO-02 more

Edit its entry in `lib/team.ts` — the tests in `tests/team.test.ts` pin what each team reaches and
must be updated in the same commit.

- **Another partner / the FB-token or TOOL rail / a platform tab** — add it to `partners` /
  `hsChannels` / `platforms`, give the Vercel project that rail's own credentials, redeploy. Google
  and TikTok additionally hard-code the first team's account book (`lib/google-bid.ts`,
  `GLO-HS-NNN`) — scope it per team before switching them on.
- **The fanka gate** — once hs-tools tracks the team's fanpages: `pagesRegistry: true` and set
  `HS_PAGES_API_URL` / `HS_PAGES_API_KEY`.

## A third team

Add it to `TEAMS` in `lib/team.ts` (its LION slugs must start with its id, e.g. `glo-03-`), create
its database (`npm run ensure-indexes` with `MONGODB_DB=gc_glo03`), its own secrets and LION key, a
Vercel project, and add its origin to the bucket CORS list in `scripts/creatives-bucket-setup.mjs`.
