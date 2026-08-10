# Cross-account clones (2026-08-10)

## Problem

A clone reuses the source's media by id (`video_id` / `image_hash`) — an **account-library asset**,
invalid in any other ad account. So clones were pinned to the source campaign's own account
("Account: From each source"), and there was no way to duplicate a campaign into another account.
FB's native `/copies` cannot cross accounts either.

## Design

**Media migration.** When the buyer picks a target account, the server re-homes the media there
before building anything:

- **Video**: `GET <video_id>?fields=source` (CDN mp4 URL, verified readable with the launch token)
  → `POST act_<target>/advideos {file_url}` (FB fetches the bytes itself — same mechanism as the
  Blob launch flow) → poll until `video_status=ready` → take the NEW video's own auto-thumbnail.
  The source's `image_hash`/`image_url` (old account's assets) are dropped.
- **Image**: official cross-account `POST act_<target>/adimages {copy_from: {source_account_id,
  hash}}` → creative uses the returned target-local hash. Picture-URL-only sources need no
  migration (URLs are account-agnostic).
- Migration is **cached per (source campaign → target account)** within a batch — ×N copies of one
  source upload once. It runs BEFORE the gcm claim, so a failed migration burns no code and
  orphans nothing.

**Pixel.** A conversion-optimized source cloned cross-account cannot keep its pixel (it lives on
the source's account). The buyer picks a pixel of the TARGET account (UI auto-picks FARM-1 when
the account carries it, mirroring the launch card); it lands on the adset's `promoted_object` AND
in the tracking link's `&pixel=` (the funnel then fires the same pixel the adset optimizes for).
Click sources stay pixel-less. Same-account clones keep the source pixel unless one is explicitly
picked. Resolution is pure (`resolveCloneBinds`) and unit-tested.

**gcm.** Unchanged by design: every clone claims its own fresh code via the race-safe
claim-then-verify lib (pool 01–200), the link is rewritten with `swapGcm`, FB ids are backfilled,
and failed clones release/retire their codes exactly as before — target account plays no role.

**Validation (fail-fast).** Batch-level, before any FB work: target account ∈ token accounts,
picked pixel ∈ that account (same guards as `/api/launch`). Per-clone, before migration/claim:
conversion source + cross-account + no valid pixel → error. Source account is still re-checked
(its media is about to be read).

**UI (clone board).** Destination gains an Account picker (default **"From each source"** — the
exact pre-feature behaviour) with the same two-line options/FARM-1 tags as the launch card, and a
dependent Pixel picker fed by the target's own pixels. Duplicate is gated until a pixel is picked
whenever an account is. Task Manager clone pipeline gains a **"Migrating media"** stage (skipped
for same-account clones).

## Limits / notes

- Cross-account clones are slower (upload + FB processing per unique source) and spend more Graph
  quota; the per-batch migration cache keeps ×N waves at one upload per source.
- Migrated videos are new PERMANENT assets in the target account's library (ad videos are not
  deletable with this token — known gotcha).
- Accounts without HS-Pixel-FARM-1 optimize conversions blind (their pixels never fire) until the
  partner shares FARM-1 wider — the picker's existing FARM-1/no-pixel tags carry that signal.
