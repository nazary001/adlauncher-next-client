// Node's built-in runner (v24 strips types natively): `node --test tests/snap-partner.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Snapchat rail — the PARTNER decisions in lib/snap-launch.ts: the 500 fixed keys (100 until 23.09), the pasted
// landing (no presets since 22.09), the exact link shape from the brief, the console campaign
// name, São Paulo dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SNAP_KEY_POOL_MAX,
  SNAP_NAME_MAX,
  isSnapKey,
  saoPauloDateISO,
  snapCampaignName,
  snapKeyCode,
  snapKeyIndex,
  snapKeyPool,
  snapLandingBase,
  snapLandingSegments,
  snapLandingUrl,
  todaySaoPauloDotDDMM,
} from "../lib/snap-launch.ts";

test("keys: 3-digit zero-padded, pool 1..500 (100 until 23.09), nothing outside", () => {
  assert.equal(snapKeyCode(1), "glo-snp_001");
  assert.equal(snapKeyCode(7), "glo-snp_007");
  assert.equal(snapKeyCode(100), "glo-snp_100");
  assert.equal(snapKeyCode(500), "glo-snp_500");
  assert.equal(snapKeyCode(0), "");
  assert.equal(snapKeyCode(501), "");
  assert.equal(snapKeyCode(1.5), "");
  assert.equal(SNAP_KEY_POOL_MAX, 500);
  assert.equal(snapKeyPool().length, 500);
  assert.equal(snapKeyPool()[99], "glo-snp_100");
  assert.equal(snapKeyPool()[499], "glo-snp_500");
});

test("keys: index parse is strict (prefix, 3 digits, 1..500)", () => {
  assert.equal(snapKeyIndex("glo-snp_042"), 42);
  assert.equal(snapKeyIndex(" glo-snp_100 "), 100);
  assert.equal(snapKeyIndex("glo-snp_101"), 101);
  assert.equal(snapKeyIndex("glo-snp_500"), 500);
  assert.equal(snapKeyIndex("glo-snp_000"), null);
  assert.equal(snapKeyIndex("glo-snp_501"), null);
  assert.equal(snapKeyIndex("glo-snp_42"), null);
  assert.equal(snapKeyIndex("GLO-SNP_042"), null);
  assert.equal(snapKeyIndex("gcm_042"), null);
  assert.equal(isSnapKey("glo-snp_001"), true);
  assert.equal(isSnapKey(""), false);
});

test("landing base: https only, pasted query/hash dropped and flagged", () => {
  assert.deepEqual(snapLandingBase("https://azmvhs.com/v/auto-financing-by-ford/"), {
    base: "https://azmvhs.com/v/auto-financing-by-ford/",
    strippedQuery: false,
  });
  assert.deepEqual(snapLandingBase("https://azmvhs.com/v/auto-financing-by-ford/?utm_source=x#top"), {
    base: "https://azmvhs.com/v/auto-financing-by-ford/",
    strippedQuery: true,
  });
  assert.equal(snapLandingBase("http://azmvhs.com/v/x/"), null);
  assert.equal(snapLandingBase("azmvhs.com/v/x/"), null);
  assert.equal(snapLandingBase("https://localhost/x"), null);
  assert.equal(snapLandingBase(""), null);
});

test("final link is EXACTLY the brief's example (utm_source=stone, one key, no macros)", () => {
  assert.equal(
    snapLandingUrl("https://azmvhs.com/v/dmi-online-marketing-course/", "glo-snp_001"),
    "https://azmvhs.com/v/dmi-online-marketing-course/?utm_source=stone&utm_campaign=glo-snp_001",
  );
  assert.equal(
    snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_002"),
    "https://azmvhs.com/v/auto-financing-by-ford/?utm_source=stone&utm_campaign=glo-snp_002",
  );
  assert.doesNotMatch(snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_002"), /\{\{/);
});

test("preview segments: the real link first (roles landing/utm/keyName/key), then the ScCid note", () => {
  const segs = snapLandingSegments("https://azmvhs.com/v/auto-financing-by-ford/?x=1", "glo-snp_009");
  assert.deepEqual(
    segs.map((s) => s.role),
    ["landing", "utm", "keyName", "key", "sccid"],
  );
  const real = segs.filter((s) => s.role !== "sccid").map((s) => s.text).join("");
  assert.equal(real, snapLandingUrl("https://azmvhs.com/v/auto-financing-by-ford/", "glo-snp_009"));
  assert.match(segs[4].text, /ScCid/);
  assert.deepEqual(snapLandingSegments("nope", "glo-snp_009"), []);
  assert.equal(snapLandingSegments("https://azmvhs.com/v/auto-financing-by-ford/", "")[3].text, "glo-snp_???");
});

test("campaign name: the console pattern with the key and the GC-Launcher marker", () => {
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US", key: "glo-snp_012", user: "nazar" }),
    "[16.09] (SNP) Cars - US - glo-snp_012 - nazar - GC-Launcher",
  );
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US+CA", key: "glo-snp_012", user: "nazar", tail: "  test  A | B " }),
    "[16.09] (SNP) Cars - US+CA - glo-snp_012 - nazar - GC-Launcher - test A / B",
  );
  assert.equal(
    snapCampaignName({ ddmm: "16.09", niche: "", geoLabel: "", key: "glo-snp_001", user: "" }),
    "[16.09] (SNP) Snap - ?? - glo-snp_001 - buyer - GC-Launcher",
  );
});

test("campaign name never exceeds 375 chars — the tail is trimmed first, the key/marker survive", () => {
  const name = snapCampaignName({ ddmm: "16.09", niche: "Cars", geoLabel: "US", key: "glo-snp_012", user: "nazar", tail: "x".repeat(500) });
  assert.ok(name.length <= SNAP_NAME_MAX);
  assert.match(name, /glo-snp_012 - nazar - GC-Launcher - x+$/);
});

test("São Paulo dates: DD.MM and YYYY-MM-DD with a day offset", () => {
  const at = new Date("2026-09-16T01:30:00Z"); // 22:30 on 15.09 in São Paulo (UTC-3)
  assert.equal(todaySaoPauloDotDDMM(at), "15.09");
  assert.equal(saoPauloDateISO(0, at), "2026-09-15");
  assert.equal(saoPauloDateISO(1, at), "2026-09-14");
});
