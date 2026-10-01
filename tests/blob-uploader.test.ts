// Node's built-in runner (v24 strips types natively): `node --test tests/blob-uploader.test.ts`.
// The upload harness's error classification (owner 01.10): a dead launcher session made the token
// broker answer non-OK, the Blob SDK turned that into "Vercel Blob: Failed to retrieve the client
// token", and the harness labelled it "upload rejected by the media store" — pointing the buyer at
// the FILE. With a session probe the error now says what actually happened and what to do.
import { test } from "node:test";
import assert from "node:assert/strict";

// The harness bounds attempts with window timers — Node has the same timers on globalThis.
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const { withUploadRetries } = await import("../components/blob-uploader.ts");

// The SDK's own message (note its double space) and the single-space variant it throws for a bad body.
const TOKEN_FAIL = "Vercel Blob: Failed to  retrieve the client token";

test("token refused + session dead → the error says to log in again, not that the file was rejected", async () => {
  let attempts = 0;
  await assert.rejects(
    withUploadRetries(
      async () => {
        attempts++;
        throw new Error(TOKEN_FAIL);
      },
      'creative "1001(2).mp4"',
      async () => true,
      async () => false,
    ),
    (e: Error) => {
      assert.match(e.message, /^creative "1001\(2\)\.mp4": /);
      assert.match(e.message, /login expired/i);
      assert.match(e.message, /log in again/i);
      assert.doesNotMatch(e.message, /media store/);
      return true;
    },
  );
  assert.equal(attempts, 1); // an auth failure never burns retries
});

test("token refused but the session is alive → the real broker message surfaces as before", async () => {
  await assert.rejects(
    withUploadRetries(
      async () => {
        throw new Error("Vercel Blob: Failed to retrieve the client token");
      },
      'creative "a.mp4"',
      async () => true,
      async () => true,
    ),
    /creative "a\.mp4": upload rejected by the media store — Vercel Blob: Failed to retrieve the client token/,
  );
});

test("other store rejections never probe the session", async () => {
  let probed = 0;
  await assert.rejects(
    withUploadRetries(
      async () => {
        throw new Error("Vercel Blob: Content type mismatch, Content type application/x-foo is not allowed.");
      },
      'creative "x.bin"',
      async () => true,
      async () => {
        probed++;
        return false;
      },
    ),
    /upload rejected by the media store — Vercel Blob: Content type mismatch/,
  );
  assert.equal(probed, 0);
});

test("a dead file handle still wins over everything (re-attach remedy)", async () => {
  await assert.rejects(
    withUploadRetries(
      async () => {
        throw new Error(TOKEN_FAIL);
      },
      'creative "gone.mp4"',
      async () => false,
      async () => false,
    ),
    /no longer readable in this tab/,
  );
});

test("success passes straight through", async () => {
  const url = await withUploadRetries(async () => "https://blob.test/x.mp4", 'creative "ok.mp4"', async () => true, async () => true);
  assert.equal(url, "https://blob.test/x.mp4");
});
