// Node's built-in runner (v24 strips types natively): `node --test tests/tiktok-source.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// TikTok rail — LION metrics rows → board facts, and LION's campaign-name grammar. Every name
// below is a REAL team campaign read from `GET /api/tiktok/campaigns/metrics/` on 17–18.09.2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLionTiktokRow, parseTiktokName, rankTiktokLandings, saoPauloDate, type LionTiktokRow } from "../lib/tiktok-source.ts";

test("metrics row mapping tolerates strings, nulls and missing fields", () => {
  assert.deepEqual(
    mapLionTiktokRow({
      campaign_id: 1876492448710785,
      campaign_name: "{HS-iQLx} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) | 16.09 - Katya - CREO - APRUV",
      campaign_status: "DISABLE",
      delivery: "CAMPAIGN_STATUS_DISABLE",
      campaign_budget: "20",
      campaign_bid: 0.46,
      landing_page_url: "https://guide-choice.com/ht/age-gate/digital-marketing/en/?utm_source=tiktok",
      account_id: "7681273820386017288",
      account_name: "GC MEDIACORE - HS - BR - 5 - Aleph GC S UAE USD",
      account_currency: "usd",
    }),
    {
      campaignId: "1876492448710785",
      name: "{HS-iQLx} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) | 16.09 - Katya - CREO - APRUV",
      status: "DISABLE",
      delivery: "CAMPAIGN_STATUS_DISABLE",
      accountId: "7681273820386017288",
      accountName: "GC MEDIACORE - HS - BR - 5 - Aleph GC S UAE USD",
      currency: "USD",
      budget: 20,
      bid: 0.46,
      landingUrl: "https://guide-choice.com/ht/age-gate/digital-marketing/en/?utm_source=tiktok",
    },
  );
  const empty = mapLionTiktokRow({});
  assert.equal(empty.campaignId, "");
  assert.equal(empty.budget, null);
  assert.equal(empty.bid, null);
  assert.equal(empty.landingUrl, "");
});

test("name grammar: plain launch", () => {
  assert.deepEqual(parseTiktokName("{HS-iQLx} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) | 16.09 - Katya - CREO - APRUV"), {
    head: "{HS-iQLx} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/)",
    suffix: "16.09 - Katya - CREO - APRUV",
    cl: "1",
    geo: ["US"],
    language: "EN",
    landingPath: "ht/age-gate/digital-marketing/en/",
    sourceKind: "",
    sourceId: "",
    smartPlus: "",
  });
});

test("name grammar: clone and JURO markers sit inside the head", () => {
  const clone = parseTiktokName("{HS-yXHO} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) (CLONE_FROM=1876493655273793) | 17.09 - Katya - CREO - APRUV - ANNA");
  assert.equal(clone.sourceKind, "clone");
  assert.equal(clone.sourceId, "1876493655273793");
  assert.equal(clone.suffix, "17.09 - Katya - CREO - APRUV - ANNA");
  assert.equal(clone.head, "{HS-yXHO} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) (CLONE_FROM=1876493655273793)");
  const juro = parseTiktokName("{HS-FlvG} (GLO-01) [1|US|EN] (ht/age-gate/digital-marketing/en/) (JURO_FROM=1876492448710785) | 16.09 - Katya - CREO - APRUV - ANNA");
  assert.equal(juro.sourceKind, "juro");
  assert.equal(juro.sourceId, "1876492448710785");
  assert.equal(juro.landingPath, "ht/age-gate/digital-marketing/en/");
});

test("name grammar: Smart+ tag is a segment of its own, not part of the buyer's suffix", () => {
  const cbo = parseTiktokName("{HS-Im7M} (GLO-01) [103|US|EN] (ht/age-gate/digital-marketing/en/) | Smart+ CBO | 18.09 - Katya - CREO - SMARTS");
  assert.equal(cbo.smartPlus, "campaign");
  assert.equal(cbo.suffix, "18.09 - Katya - CREO - SMARTS");
  assert.equal(cbo.cl, "103");
  const adgroup = parseTiktokName("{HS-Im7M} (GLO-01) [103|US|EN] (ht/x/) | Smart+ | 18.09 - Katya");
  assert.equal(adgroup.smartPlus, "adgroup");
  assert.equal(adgroup.suffix, "18.09 - Katya");
});

test("name grammar: multi-geo, worldwide and ALL languages", () => {
  const multi = parseTiktokName("{HS-r3ou} (GLO-01) [103|US,GB,CA,AU,NZ|EN] (ht/captcha-9/digital-marketing/en/) | 21.08 - Mykola - Footage - POP_UP_course");
  assert.deepEqual(multi.geo, ["US", "GB", "CA", "AU", "NZ"]);
  const ww = parseTiktokName("{HS-e7Fr} (GLO-01) [1|WW|EN] (ht/captcha-6/digital-marketing/en/) | [EN] - MKDIGITAL - Margo - CREO - DARK");
  assert.deepEqual(ww.geo, ["WW"]);
  // The buyer's suffix may itself start with a bracket — the FIRST bracket group is LION's.
  assert.equal(ww.suffix, "[EN] - MKDIGITAL - Margo - CREO - DARK");
  const all = parseTiktokName("{HS-zWvf} (GLO-01) [104|PL|ALL] (ht/age-gate/cars/en/) | 17.09 - Mykola - APRUV");
  assert.equal(all.language, "ALL");
  assert.deepEqual(all.geo, ["PL"]);
});

test("name grammar: a name LION didn't build parses to empty parts, never throws", () => {
  assert.deepEqual(parseTiktokName("some manual campaign"), {
    head: "some manual campaign",
    suffix: "",
    cl: "",
    geo: [],
    language: "",
    landingPath: "",
    sourceKind: "",
    sourceId: "",
    smartPlus: "",
  });
  assert.equal(parseTiktokName("").head, "");
  assert.equal(parseTiktokName(undefined as unknown as string).head, "");
});

test("São Paulo metrics day", () => {
  assert.equal(saoPauloDate(0, new Date("2026-09-18T02:30:00Z")), "2026-09-17");
  assert.equal(saoPauloDate(0, new Date("2026-09-18T03:30:00Z")), "2026-09-18");
  assert.equal(saoPauloDate(1, new Date("2026-09-18T12:00:00Z")), "2026-09-17");
});

test("landing suggestions: bare bases grouped and ranked by how often the team runs them", () => {
  const row = (landingUrl: string): LionTiktokRow => ({ campaignId: "1", name: "", status: "", delivery: "", accountId: "", accountName: "", currency: "USD", budget: null, bid: null, landingUrl });
  const ranked = rankTiktokLandings(
    [
      row("https://fast-flow.org/ht/cars/en/?utm_source=tiktok&cl=1"),
      row("https://fast-flow.org/ht/cars/en/?utm_source=tiktok&cl=104"),
      row("https://guide-choice.com/ht/age-gate/digital-marketing/en/?x=1"),
      row(""),
      row("http://insecure.org/x/"),
      row("https://fast-flow.org/ht/cars/en/"),
      row("https://a-first.org/ht/z/"),
    ],
    2,
  );
  assert.deepEqual(ranked, [
    { url: "https://fast-flow.org/ht/cars/en/", count: 3 },
    { url: "https://a-first.org/ht/z/", count: 1 },
  ]);
});
