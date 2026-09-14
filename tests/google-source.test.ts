// Node's built-in runner (v24 strips types natively): `node --test tests/google-source.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — the pure source-campaign helpers (lib/google-source.ts): LION metrics row
// mapping, the São Paulo metrics-day clock, the geo/name readers, and the dataset-ensure state
// machine driven off FAKE deps with a virtual clock (no real sleeping).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureGoogleDataset,
  googleGeoFromName,
  googleSourceFromName,
  mapLionGoogleRow,
  saoPauloDate,
  splitGoogleName,
  type GoogleDatasetDeps,
} from "../lib/google-source.ts";

// ---- mapLionGoogleRow: a raw metrics row → board facts (numbers → strings, missing → ""/null) --

test("a full row maps numbers to strings and money to numbers", () => {
  assert.deepEqual(
    mapLionGoogleRow({
      campaign_id: 24240012365,
      campaign_name: "GLO-HS-007 - DEMANDA (YTB) - BE+CA - DIRETO",
      campaign_status: "ENABLED",
      account_id: 8434519748,
      account_name: "GLO-HS-007",
      account_status: "ENABLED",
      campaign_budget: 30,
      campaign_bid: 3.95,
    }),
    {
      campaignId: "24240012365",
      name: "GLO-HS-007 - DEMANDA (YTB) - BE+CA - DIRETO",
      status: "ENABLED",
      accountId: "8434519748",
      accountName: "GLO-HS-007",
      accountStatus: "ENABLED",
      budget: 30,
      bid: 3.95,
    },
  );
});

test("a sparse row fills strings with '' and money with null (never throws)", () => {
  assert.deepEqual(mapLionGoogleRow({}), {
    campaignId: "",
    name: "",
    status: "",
    accountId: "",
    accountName: "",
    accountStatus: "",
    budget: null,
    bid: null,
  });
  // an empty-string budget and a non-numeric bid both fall to null
  assert.deepEqual(
    { budget: mapLionGoogleRow({ campaign_budget: "" }).budget, bid: mapLionGoogleRow({ campaign_bid: "x" }).bid },
    { budget: null, bid: null },
  );
});

// ---- saoPauloDate: the metrics-day boundary (UTC-3), injectable clock -------------------------

test("saoPauloDate rolls the day back for a UTC time before 03:00Z and honours the offset", () => {
  // 01:00Z on the 14th is 22:00 on the 13th in São Paulo.
  assert.equal(saoPauloDate(0, new Date("2026-09-14T01:00:00Z")), "2026-09-13");
  // midday UTC stays the same day
  assert.equal(saoPauloDate(0, new Date("2026-09-14T12:00:00Z")), "2026-09-14");
  // offset walks back whole São Paulo days
  assert.equal(saoPauloDate(1, new Date("2026-09-14T12:00:00Z")), "2026-09-13");
  assert.equal(saoPauloDate(7, new Date("2026-09-14T12:00:00Z")), "2026-09-07");
});

// ---- googleGeoFromName: the geo segment of a LION Google name ---------------------------------

const NAME = (geo: string) => `{HS-1} GLO-HS-007 - (GLO-01) #ADX [HIGH] - DEMANDA (YTB) - ${geo} - SEARCH DIRETO`;

test("googleGeoFromName reads country codes, plus-joined pools and named pools", () => {
  assert.equal(googleGeoFromName(NAME("BE+CA")), "BE+CA");
  assert.equal(googleGeoFromName(NAME("AU+CA+IE+NZ+GB+US")), "AU+CA+IE+NZ+GB+US");
  assert.equal(googleGeoFromName(NAME("US")), "US");
  assert.equal(googleGeoFromName(NAME("LATAM")), "LATAM");
  assert.equal(googleGeoFromName("a name with no geo segment at all"), "");
});

// ---- splitGoogleName: generated head vs team suffix ------------------------------------------

test("splitGoogleName splits on the first ' | ': generated head vs the team suffix (pipe dropped)", () => {
  assert.deepEqual(splitGoogleName("HEAD PART | 14.09 nazar | CLONE_FROM=123456"), {
    head: "HEAD PART",
    suffix: "14.09 nazar | CLONE_FROM=123456",
  });
  assert.deepEqual(splitGoogleName("no suffix here"), { head: "no suffix here", suffix: "" });
  assert.deepEqual(splitGoogleName("  spaced head  | tail  "), { head: "spaced head", suffix: "tail" });
});

// ---- googleSourceFromName: the CLONE_FROM / JURO_FROM id --------------------------------------

test("googleSourceFromName reads the marker id, '' when absent", () => {
  assert.equal(googleSourceFromName("… | CLONE_FROM=24225047720"), "24225047720");
  assert.equal(googleSourceFromName("… | JURO_FROM=123456"), "123456");
  assert.equal(googleSourceFromName("no marker at all"), "");
});

// ---- ensureGoogleDataset: the fetch → poll → one-retry state machine (FAKE deps) -------------

/** A virtual clock: sleep() just advances `t`, so a 180 s budget resolves instantly. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("ready at once: the first fetch answers ready, status is never polled", async () => {
  const clock = fakeClock();
  let statusCalls = 0;
  const deps: GoogleDatasetDeps = {
    fetch: async () => ({ state: "ready", fetchedAt: "2026-09-14T00:00:00Z" }),
    status: async () => {
      statusCalls++;
      return { ready: false, fetchedAt: null };
    },
    sleep: clock.sleep,
    now: clock.now,
  };
  const r = await ensureGoogleDataset("24240012365", deps);
  assert.deepEqual(r, { ok: true, fetchedAt: "2026-09-14T00:00:00Z" });
  assert.equal(statusCalls, 0);
});

test("fetching then ready after 3 polls: the fetchedAt from status propagates", async () => {
  const clock = fakeClock();
  let statusCalls = 0;
  const deps: GoogleDatasetDeps = {
    fetch: async () => ({ state: "fetching", fetchedAt: null }),
    status: async () => {
      statusCalls++;
      return statusCalls >= 3 ? { ready: true, fetchedAt: "ready-at-3" } : { ready: false, fetchedAt: null };
    },
    sleep: clock.sleep,
    now: clock.now,
  };
  const r = await ensureGoogleDataset("24240012365", deps, { pollMs: 1000, maxWaitMs: 100_000 });
  assert.deepEqual(r, { ok: true, fetchedAt: "ready-at-3" });
  assert.equal(statusCalls, 3);
});

test("never ready: after the first wait a single re-fetch is fired, then it gives up naming the seconds", async () => {
  const clock = fakeClock();
  let fetchCalls = 0;
  const deps: GoogleDatasetDeps = {
    fetch: async () => {
      fetchCalls++;
      return { state: "fetching", fetchedAt: null };
    },
    status: async () => ({ ready: false, fetchedAt: null }),
    sleep: clock.sleep,
    now: clock.now,
  };
  const r = await ensureGoogleDataset("24240012365", deps, { maxWaitMs: 20_000, retryWaitMs: 10_000, pollMs: 5_000 });
  assert.equal(r.ok, false);
  assert.equal(fetchCalls, 2); // the initial fetch + exactly one re-trigger
  if (!r.ok) {
    assert.match(r.reason, /24240012365/);
    assert.match(r.reason, /30 s/); // (20000 + 10000) / 1000
  }
});

test("a thrown fetch (404 never-seen) is final and its message reaches the reason", async () => {
  const clock = fakeClock();
  const deps: GoogleDatasetDeps = {
    fetch: async () => {
      throw new Error("campaign not found");
    },
    status: async () => ({ ready: false, fetchedAt: null }),
    sleep: clock.sleep,
    now: clock.now,
  };
  const r = await ensureGoogleDataset("9999912345", deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /9999912345/);
    assert.match(r.reason, /campaign not found/);
  }
});

test("the second fetch answering ready recovers a slow snapshot", async () => {
  const clock = fakeClock();
  let fetchCalls = 0;
  const deps: GoogleDatasetDeps = {
    fetch: async () => {
      fetchCalls++;
      return fetchCalls >= 2 ? { state: "ready", fetchedAt: "ready-on-retry" } : { state: "fetching", fetchedAt: null };
    },
    status: async () => ({ ready: false, fetchedAt: null }),
    sleep: clock.sleep,
    now: clock.now,
  };
  const r = await ensureGoogleDataset("24240012365", deps, { maxWaitMs: 20_000, retryWaitMs: 10_000, pollMs: 5_000 });
  assert.deepEqual(r, { ok: true, fetchedAt: "ready-on-retry" });
  assert.equal(fetchCalls, 2);
});
