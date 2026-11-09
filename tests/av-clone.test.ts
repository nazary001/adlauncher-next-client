// Node's built-in runner (v24 strips types natively): `node --test tests/av-clone.test.ts`.
// lib/av-clone.ts imports only the SourceMedia TYPE (erased), so it loads straight off Node without
// dragging in the `@/`-aliased Graph stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceMediaLink } from "../lib/av-clone.ts";

const ART = "https://thecadrion.com/cow-long-rec-govdeals-surplus-auctions-1-twjmh";

test("video source link comes from the CTA's value.link", () => {
  const media = {
    kind: "video" as const,
    data: {
      video_id: "123",
      message: "hi",
      call_to_action: { type: "LEARN_MORE", value: { link: `${ART}?utm_campaign=av007` } },
    },
  };
  assert.equal(sourceMediaLink(media), `${ART}?utm_campaign=av007`);
});

test("image source link comes from link_data.link", () => {
  const media = { kind: "image" as const, data: { link: `${ART}?gcm=42`, image_hash: "h" } };
  assert.equal(sourceMediaLink(media), `${ART}?gcm=42`);
});

test("video with no CTA (or no link) yields empty string — treated as not-an-AV-destination", () => {
  assert.equal(sourceMediaLink({ kind: "video", data: { video_id: "123" } }), "");
  assert.equal(
    sourceMediaLink({ kind: "video", data: { call_to_action: { type: "LEARN_MORE", value: {} } } }),
    "",
  );
});

test("non-string / missing link fields never throw, always return a string", () => {
  assert.equal(sourceMediaLink({ kind: "image", data: {} }), "");
  assert.equal(sourceMediaLink({ kind: "image", data: { link: 42 } }), "");
  assert.equal(
    sourceMediaLink({ kind: "video", data: { call_to_action: { value: { link: null } } } }),
    "",
  );
});

// ---- AV clones through TOOL (owner ask 09.11: «сделай чтобы работал через Tool») — the clone keeps the
// SOURCE's platforms (an AV launch picks them on the card, Facebook only by default): the ad set's
// targeting.publisher_platforms, read off the source, onto TOOL's targeting.
import { sourcePlatformsOf } from "../lib/av-clone.ts";

test("the source's publisher_platforms carry over; no list = automatic placements ([])", () => {
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: ["facebook"] }), ["facebook"]);
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed"] }), ["facebook", "instagram"]);
  assert.deepEqual(sourcePlatformsOf({}), []);
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: [] }), []);
  assert.deepEqual(sourcePlatformsOf(undefined), []);
  assert.deepEqual(sourcePlatformsOf(null), []);
});

test("platform words are lower-cased, deduped, and anything that is not a word is dropped", () => {
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: ["Facebook", "facebook", " instagram "] }), ["facebook", "instagram"]);
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: ["facebook", 7, null, "", "audience network!"] }), ["facebook"]);
  assert.deepEqual(sourcePlatformsOf({ publisher_platforms: "facebook" }), []);
});
