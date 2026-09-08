# Clone boards — per-row destination, cash-register budgets, token-free geo override

2026-09-08 · owner ask (three items in one message); built in a worktree, deploy on the owner's
explicit go.

## Ask

1. When several campaigns are cloned at once, every clone must be able to carry ITS OWN fanka /
   account / everything else — not one Settings pick for the whole wave.
2. The clone rows' **Daily budget** field must work like the ROAS/bid field: cash-register entry,
   cents always visible ("10,00", digits fill from the right).
3. When our FB token is dead, cloning with a changed country stops working on the LION rail —
   make it work through the LION API where possible.

## 1. Per-row destination

### HS clone board (Cloner + JURO, LION and FB-Token channels)

- `Row` gains `dest: HsRowDest | null` (profile · account · page · pixel — a FULL tuple or
  nothing: a half chain is meaningless, an account belongs to a profile, a page to a profile, a
  pixel to an account) and `copies: string` ("" = the wave default).
- The Settings column becomes the **wave defaults**. A new table column **Destination · copies**
  shows each row's effective tuple (catalog names from the row's OWN profile), an `own` /
  `defaults` chip, an inline copies input (empty = default) and a **Destination** button that
  opens `HsDestinationModal` — the same profile → account → page → pixel cascade as Settings
  (token-rail account filter included) + copies, with *Use wave defaults*, *Apply to this row*
  and *Apply to all N rows*.
- Every wave number is built from the EFFECTIVE values: clones per account (launch limit 5/30
  min, per account), ads per fanka (cloner: per bound page; JURO: per source page), the per-fire
  cap, the shots. Rows with an incomplete tuple, or an own account the token rail can't act on,
  are flagged in the column and block the fire with a named message.
- Wire: every shot carries `profile / account / page / pixel`; the wave-level body fields stay as
  the defaults for bind-less shots (old contract). The four routes (`duplicate`,
  `token-duplicate`, `jurar`, `token-jurar`) resolve each shot's binds (`lib/hs-shot-binds.ts`:
  shot field wins, wave fills the gap, missing → the old `*_required` codes), validate ONCE per
  distinct tuple against LION's catalog (refusals now name the ids), check `/accounts`
  assignments and token visibility per distinct account, run the launch-limit precheck per
  account (`acctLimitRefusal`), and pump with each shot's own binds. A full account window now
  settles only that account's remaining shots — other accounts' shots keep going.

### MO / AIF clone board

- `CloneRow` gains `dest: CloneRowDest | null` (pageId · accountId · pixelId) and
  `copies: number | null`. The Destination column + `CloneDestinationModal` mirror the HS board
  (fanpage / account incl. "From each source" / pixel / copies). `/api/clone/run` already took
  per-edit `pageId / accountId / pixelId`, so the server needed no change; the board now sends
  each row's effective tuple and copies.

## 2. Cash-register budget

`moneyCentsLabel()` (lib/types) formats any seed ("10", a source's "12,5") as "12,50"; the clone
rows' budget cells switch from `limitMoney` to `limitMoneyCents` (max $10 000). The launcher
card's budget field is unchanged (out of the ask).

## 3. Geo override without the token (LION rail)

Facts (probed 08-20, re-checked 09-08): LION's `duplicate/` ignores targeting fields; LION has no
targeting-update endpoint; `details/` exposes no creative URLs or copy, so a `create/`-based
rebuild is impossible from LION data alone. The only LION-native carrier of an explicit geo is
`/jurar/` (JURO) — which the board already offers with per-row geo/locales and no token.

What changed:

- The LION rail's Graph patch signs with **any** configured bearer — the dedicated duplicate
  signer first, then the launch pool (`hsAnyFbGet/Post`, account-aware ordering, failover on
  rate limits, dead tokens AND per-account permission misses). The route gate (`hsAnyTokenGate`)
  and the visibility check (union of both sweeps) follow. Before, the pool alone did the patch
  while the board judged by the dedicated signer alone — one dead token blocked overrides either
  way.
- Only when EVERY bearer is down does the board block a LION-rail override wave — and the note
  offers a one-click **Switch to JURO (LION API)**, which keeps the rows and their geo overrides
  (JURO takes the geo natively). The server refusal names the same way out. Rows with an override
  show "needs an FB token — or JURO" while all bearers are down.

## Verification

- `node --test tests/*.test.ts` (unit: money format, shot binds, precheck, clone dest helpers)
- `tsc --noEmit`, `eslint`, `next build`
- local dev server (port 3123): API contract checks with a minted session (per-shot binds
  resolution, refusals name ids/accounts, mixed-account precheck); browser smoke of both boards.
