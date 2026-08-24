// Node's built-in runner (v24 strips types natively): `node --test tests/task-store.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTeamTasks } from "../lib/task-store.ts";

type Handler = (url: string) => Response;

/** Route fetches by the page number in the URL; counts calls. */
function stubFetch(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const page = /page=(\d+)/.exec(url)?.[1] ?? "1";
    const h = handlers[page];
    if (!h) throw new Error(`no handler for page ${page}`);
    return h(url);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const okPage = (rows: unknown[]) =>
  new Response(JSON.stringify({ data: rows }), { status: 200, headers: { "content-type": "application/json" } });

const fullPage = Array.from({ length: 100 }, (_, i) => ({ i }));

test("a mid-read page failure returns the partial list but does NOT cache it", async () => {
  let page2Fails = true;
  const stub = stubFetch({
    "1": () => okPage(page2Fails ? fullPage : [{ i: "only" }]),
    "2": () => (page2Fails ? new Response("", { status: 503 }) : okPage([])),
  });
  try {
    const first = await readTeamTasks("test-partial", (p) => `http://x/rows?page=${p}`, (r) => r, {
      pageSize: 100,
      maxPages: 3,
    });
    assert.equal(first.ok, true);
    assert.equal(first.tasks.length, 100); // partial pages are still served...

    page2Fails = false; // upstream healed
    const second = await readTeamTasks("test-partial", (p) => `http://x/rows?page=${p}`, (r) => r, {
      pageSize: 100,
      maxPages: 3,
    });
    // ...but the truncated list must not have been cached as authoritative: the next read
    // goes back to Strapi and sees the healed (here: 1-row complete) list, not the stale 100.
    assert.equal(second.tasks.length, 1);
  } finally {
    stub.restore();
  }
});

test("a complete read IS served from the short cache", async () => {
  const stub = stubFetch({ "1": () => okPage([{ i: 1 }, { i: 2 }]) });
  try {
    const first = await readTeamTasks("test-complete", (p) => `http://x/rows?page=${p}`, (r) => r, {
      pageSize: 100,
      maxPages: 3,
    });
    assert.equal(first.tasks.length, 2);
    const callsAfterFirst = stub.calls.length;
    const second = await readTeamTasks("test-complete", (p) => `http://x/rows?page=${p}`, (r) => r, {
      pageSize: 100,
      maxPages: 3,
    });
    assert.equal(second.tasks.length, 2);
    assert.equal(stub.calls.length, callsAfterFirst); // no new Strapi round-trip inside the TTL
  } finally {
    stub.restore();
  }
});
