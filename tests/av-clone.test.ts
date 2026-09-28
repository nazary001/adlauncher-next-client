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
