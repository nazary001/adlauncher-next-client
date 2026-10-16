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
| Ready landings on the HS card | no — the link is pasted | a pick above the link field (Cars / MKD) |
| A profile's personal ad account | listed, as LION lists it | left out — business accounts only |
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
- **Clone / JURO sources** — not separated (owner 13.10): any campaign LION shows can be cloned,
  whichever team launched it. The copy is born on the team's own profile and ad account; a JURO copy
  re-uses the source's page posts, so the picked profile must carry their fanpage.
- **Campaigns the team changes** (an activation that arrives by id) — by the acronym LION stamps at
  the head of every name it builds (`[06/10] (GLO-01) API - …`), else by the ad account. GLO-02
  activates only a campaign that is provably its own; GLO-01 everything except a GLO-02 campaign.
- **Stored state** — users, the launch queue, the task registry, per-account launch limits,
  account assignments and campaign templates live in the team's own database. A build refuses to run
  on another team's.
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

### Renaming a login (either team)

The console writes the login into campaign names, so a login should be the name the team calls its
buyer by. Run from the team's own folder:

```bash
npm run rename-user -- <old> <new>            # dry run: what would change
npm run rename-user -- <old> <new> --apply
```

The account assignments, the keys and wave claims the login holds and the owner of its task rows
move with it; names of campaigns already launched are not rewritten. The buyer can still sign in
under the old name (and lands under the new one), and an open tab switches by itself within minutes.
Refused while the login has launches in the queue.

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

**A commit that is already in the second repo keeps its id.** A branch that holds such commits is
brought up to date with `git merge origin/main` — never `git rebase` / `git pull --rebase`: a rebase
renames them, the two histories part, and step 2 stops being a fast-forward (it fails loudly; the way
back is to reset the second folder to the first launcher's `main` and force-push it). Commits the
second repo has not seen can be rebased as usual. The habit that keeps this from ever coming up: the
second launcher takes its commits from `upstream main` — after the first one has shipped them. (It
came up on day one: the first launcher's `main` gained a Snapchat fix while this branch was already
the second repo's history — hence the merge commit `a8090bb`.)

A push to the second repo's `main` is a production deploy of the GLO-02 launcher (Vercel builds it
in about a minute); its every-minute queue sweep moves to the new build by itself.

## Ready landings on the HS card (GLO-02)

Above the link field the card offers the partner's landings that LION's Campaign URL Builder hands
out — Cars and Digital Marketing (MKD) in EN / ES / FR / PT: the direct article and the captcha
templates. The list follows the card's redirect type (HIGH ADX → `fast-flow.org`, META ADX →
`routerix.tech`; plain ADX has none). A pick only fills the link field, which stays free text: a
pasted landing launches exactly as before, and the tracking tail is appended either way.

The list is `lib/hs-ready-links.ts` (read off the builder 13.10, pinned by
`tests/hs-ready-links.test.ts`) — another template, niche or language is one more row there. To offer
it to GLO-01 as well, set `hsReadyLinks: true` in its entry in `lib/team.ts`.

The Creatives field of the GLO-02 card carries no "one ad per creative (LION)" note
(`hsCreativesNote: false`, owner ask 13.10); GLO-01 keeps it.

## Business accounts only (GLO-02)

LION lists, next to the team's business ad accounts, the personal ad account of each profile's
persona — under the persona's own name (`Адель Иванова` in the profile of persona `Адель Иванова`),
first in the list and with no pixel to launch on. A team with `personalAccounts: false` in
`lib/team.ts` never sees it: `lionProfileData` leaves it out at the source, so the launch card, the
clone boards and the Account access page do not offer it and the creating routes answer
`account_not_on_profile`. A campaign that already lives in such an account is still the team's own.

## Campaign templates (both teams)

Since 16.10 a buyer can save a launcher card — every field but the creatives — as a named **template**
(the card's "Save as template" button) and anyone on the team can apply it to a card, to every card,
or add a card from it (the card's "Apply template" button, the toolbar's **Templates**). Templates are
the partner's (an HS template never shows on MO), live in the team's database (`launch_templates`,
one name per buyer per partner), and are listed with the buyer's own first; only the creator or an
owner-role login edits or deletes one — everyone else gets "Copy to mine". `lib/templates.ts` holds
the rules, `lib/template-store.ts` the store, `/api/templates` the routes (need `always`);
`npm run ensure-indexes` creates the collection's indexes on a database that has none yet.

## Giving GLO-02 more

Edit its entry in `lib/team.ts` — the tests in `tests/team.test.ts` pin what each team reaches and
must be updated in the same commit.

- **Another partner / the FB-token or TOOL rail / a platform tab** — add it to `partners` /
  `hsChannels` / `platforms`, give the Vercel project that rail's own credentials, redeploy. Google
  and TikTok additionally hard-code the first team's account book (`lib/google-bid.ts`,
  `GLO-HS-NNN`) — scope it per team before switching them on.
- **The fanka gate** — the registry keeps one HS fanpage list per team and each launcher reads its
  own (`/fb/api/v1/pages?team=glo-02`, `lib/team.ts` `teamPagesQuery`). Once that list holds the
  team's fanpages (13.10: none of GLO-02's 5): `pagesRegistry: true` and set `HS_PAGES_API_URL` /
  `HS_PAGES_API_KEY`. Not before — the gate hides every page the registry has no OK row for.

## A third team

Add it to `TEAMS` in `lib/team.ts` (its LION slugs must start with its id, e.g. `glo-03-`), create
its database (`npm run ensure-indexes` with `MONGODB_DB=gc_glo03`), its own secrets and LION key, a
Vercel project, and add its origin to the bucket CORS list in `scripts/creatives-bucket-setup.mjs`.
