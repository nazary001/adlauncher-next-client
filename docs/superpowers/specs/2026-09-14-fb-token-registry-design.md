# FB token registry — design (2026-09-14)

Owner ask: manage the Facebook access tokens the launcher signs with **from the app itself** —
add / remove tokens, and pick, per partner (MO · AIF · HS) and per rail (launches · clones),
which token signs. The LION API token stays a fixed env var and is out of scope.

## Why

Every FB bearer today is a Vercel env var (`FB_MO_SOC_TOKENS`, `FB_AIF_LAUNCH_TOKEN`,
`FB_HS_LAUNCH_TOKEN[_2.._4]`, `FB_HS_DUP_TOKEN`, legacy `FB_LAUNCH_TOKEN`). Rotating one means
an env edit + a redeploy (the Vercel API token is dead since 09-11, so even that is manual).
The MO board worked around it with a per-buyer "soc signer" switch — which also let a buyer
silently route a wave onto a signer the owner did not intend.

## Model

```
TokenRegistry (ONE Strapi app-cache row, ckey "fb-token-registry:v1")
  tokens: TokenEntry[]        // sealed (AES-256-GCM, key = HKDF(AUTH_SECRET)); never leave the server
  slots:  { "mo.launch" | "mo.clone" | "aif.launch" | "aif.clone" | "hs.launch" | "hs.clone" : tokenId[] }
  events: last 40 changes (who / when / what)
```

- `TokenEntry`: `id` (`t_…`), `label`, `sealed`, `fp` (sha256 prefix — the same fingerprint the
  HS health row already keys on), `partners` (which partners it may sign for), `personal`
  (a personal soc profile → MO campaign names carry the `SOC - ` marker; system users don't),
  `note`, `addedBy/At`, `identity` (last probe: user, app, expiry, scopes, #accounts, #pages).
- **Slots** hold ordered token ids. MO/AIF slots hold exactly one token. HS slots are
  **pools**: first = primary, the rest = failover order (same-user bearers issued through
  different FB apps dodge the app-level (#4) limit — the 08-20 design, now owner-editable).
- Slot arrays may also reference **env seeds** (`env:…` ids): the tokens still provided by
  Vercel env show up read-only in the vault and can be assigned like any other.
- **Unassigned slot → env default** = exactly today's behaviour (MO: system-class soc first,
  else first soc; AIF: `FB_AIF_LAUNCH_TOKEN`; HS launch: T1..T4; HS clone: `FB_HS_DUP_TOKEN`
  else the launch pool). Deploying this change alters nothing until an owner assigns.
- An **assigned** token that cannot be decrypted (secret rotated) or was removed is a clean
  config error on that rail — never a silent fallback to another signer (the wave was aimed).

## Resolution (server)

`lib/fb-tokens.ts` reads the row (15 s per-instance cache, in-flight dedupe), decrypts the
tokens of one slot on demand and hands each rail a resolved signer:

- MO — `resolveMoSigner("launch" | "clone")` → `{ name, token, sys, cat }`; the launch route,
  the clone route, the source reader and the MO catalogs (`/api/fanpages?rail=`,
  `/api/adaccounts?rail=`) all use it. The client no longer picks a signer; a stale
  `channel` on the wire is ignored.
- AIF — `aifRail("launch" | "clone")` → bound Graph helpers + catalogs on that token.
- HS — the token pool (`lib/hs-token-launch`) resolves `hs.launch` / `hs.clone` at call
  time; gates, prober, cron and the header widget follow the resolved pools.

Catalog cache identity per token (`tok-<fp>`), so two signers' account/page lists never bleed.

## API

- `GET /api/fb-tokens` (owner) — tokens (registry + env seeds, identity, live health), slots,
  the effective signer per slot, events. No token material.
- `POST /api/fb-tokens` (owner) — `{ token, label, partners, personal, note, assign? }`:
  probes the token (`/me`, `/app`, `/me/permissions`, `/me/adaccounts`, `/me/accounts`),
  refuses dead or duplicate tokens, seals + stores, optionally assigns to slots at once.
- `PATCH /api/fb-tokens` (owner) — `{ op: "slot", slot, ids }` · `{ op: "update", id, patch }`
  · `{ op: "recheck", id }`.
- `DELETE /api/fb-tokens?id=` (owner) — removes the token and clears it from every slot.
- `POST /api/fb-tokens/probe` (owner) — identity preview before adding.
- `GET /api/fb-tokens/signers` (any session) — per-slot effective signer (label, source,
  health) for the boards' "Signs as …" badges.

Writes are read-modify-write on the single row and refuse to write over a row that could not
be read (same discipline as the account-assignment registry).

## UI

- Owner menu → **FB tokens** (`/tokens`): per-partner sections with a Launches card and a
  Clones card (effective signer, health, source, picker; HS = ordered failover list), an
  **Add token** flow (paste → Check → identity preview → label / partners / personal → Add,
  optionally assigning right away), the **vault** table (identity, expiry, scopes, counts,
  health, where used, re-check / edit / remove), recent changes.
- Boards: the MO signer picker is replaced by a read-only **Signs as** badge (launcher rail,
  clone board, auto-launch modal); AIF boards get the same badge; the HS widget shows labels.

## Testing

Pure modules (`lib/fb-token-vault.ts`, `lib/fb-token-registry.ts`) under `node --test`;
`tsc`, `eslint`, `next build`; a local `next dev` smoke against the real Strapi/Graph backends
(add → assign → catalogs on the assigned signer → remove → env fallback); prod smoke after
the Vercel deploy.
