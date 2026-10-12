// Node's built-in runner (v24 strips types natively): `node --test tests/own-name.test.ts`.
// One buyer, one name (owner 12.10). The console prints the login into the names it builds, and
// buyers type their own name into the tail as well — live names of 09.10:
//   Google   `… | 09.10 Katya GC-Launcher Katya - CREO - Lakshmi0910`
//   Snapchat `[09.10] (SNP) … - glo-snp_172 - Katya - GC-Launcher - Katya - CREO - Lakshmi0910`
//   FB clone `… - MKDIGITAL - Katya - CREO - GIRLS b51GH - Katya`
// The tail loses the segment that only repeats the login; a clone of your own campaign does not get
// your name appended a second time. Nothing else in a name moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesOwnName, dropOwnName } from "../lib/own-name.ts";
import { googleNameSuffix } from "../lib/google-bid.ts";
import { tiktokNameSuffix } from "../lib/tiktok-launch.ts";
import { snapCampaignName } from "../lib/snap-launch.ts";
import { withOwner } from "../lib/clone.ts";

test("dropOwnName: a segment that is only the login again goes, in any letter case, wherever it stands", () => {
  assert.equal(dropOwnName("Katya - CREO - Lakshmi0910", "Katya"), "CREO - Lakshmi0910");
  assert.equal(dropOwnName("[IT] - MKDIGITAL - DEVICH - BOXING", "Devich"), "[IT] - MKDIGITAL - BOXING");
  assert.equal(dropOwnName("CREO - GIRLS - katya", "Katya"), "CREO - GIRLS");
  assert.equal(dropOwnName("Katya", "Katya"), "");
  assert.equal(dropOwnName("Katya - Katya", "Katya"), "");
});

test("dropOwnName: anything that is not exactly the login stays as typed", () => {
  assert.equal(dropOwnName("[IT] - MKDIGITAL - DEVICH - BOXING", "Katya_M"), "[IT] - MKDIGITAL - DEVICH - BOXING");
  assert.equal(dropOwnName("KatyaBest - CREO", "Katya"), "KatyaBest - CREO");
  assert.equal(dropOwnName("Katya CREO Lakshmi", "Katya"), "Katya CREO Lakshmi");
  assert.equal(dropOwnName("CREO - Anna", "Katya"), "CREO - Anna"); // somebody else's name is theirs to keep
  assert.equal(dropOwnName("Katya-CREO", "Katya"), "Katya-CREO"); // a hyphen inside a word is not a separator
  assert.equal(dropOwnName("", "Katya"), "");
  assert.equal(dropOwnName("CREO - X", ""), "CREO - X");
});

test("carriesOwnName: a whole segment, not a substring", () => {
  assert.equal(carriesOwnName("MKDIGITAL - Katya - CREO - GIRLS b51GH", "Katya"), true);
  assert.equal(carriesOwnName("MKDIGITAL - DEVICH - BOXING", "devich"), true);
  assert.equal(carriesOwnName("MKDIGITAL - Katya_M - CREO", "Katya"), false);
  assert.equal(carriesOwnName("MKDIGITAL - CREO", ""), false);
});

test("Google suffix: the buyer's name is printed once", () => {
  assert.equal(googleNameSuffix({ mode: "launch", user: "Katya", ddmm: "09.10", tail: "Katya - CREO - Lakshmi0910" }), "09.10 Katya GC-Launcher CREO - Lakshmi0910");
  assert.equal(googleNameSuffix({ mode: "launch", user: "Devich", ddmm: "08.10", tail: "[EN] - CARS - DEVICH - BOXING - 24338092012" }), "08.10 Devich GC-Launcher [EN] - CARS - BOXING - 24338092012");
  assert.equal(googleNameSuffix({ mode: "launch", user: "Katya", ddmm: "09.10", tail: "Katya" }), "09.10 Katya GC-Launcher");
  // a tail without the buyer's name is untouched
  assert.equal(googleNameSuffix({ mode: "clone", sourceId: "1", user: "Anna", ddmm: "09.10", tail: "DEVICH - BOXING" }), "09.10 Anna GC-Launcher DEVICH - BOXING");
});

test("TikTok suffix: the buyer's name is printed once", () => {
  assert.equal(tiktokNameSuffix({ user: "Katya", ddmm: "16.09", tail: "Katya - CREO - APRUV" }), "16.09 - Katya - GC-Launcher - CREO - APRUV");
  assert.equal(tiktokNameSuffix({ user: "Katya", ddmm: "16.09", tail: "CREO - APRUV - ANNA" }), "16.09 - Katya - GC-Launcher - CREO - APRUV - ANNA");
});

test("Snapchat name: the buyer's name is printed once, the clone marker stays", () => {
  assert.equal(
    snapCampaignName({ ddmm: "09.10", niche: "Digital marketing", geoLabel: "FR", key: "glo-snp_172", user: "Katya", tail: "Katya - CREO - Lakshmi0910" }),
    "[09.10] (SNP) Digital marketing - FR - glo-snp_172 - Katya - GC-Launcher - CREO - Lakshmi0910",
  );
  assert.equal(
    snapCampaignName({ ddmm: "09.10", niche: "Cars", geoLabel: "MX", key: "glo-snp_113", user: "Devich", tail: "[ES] - [MKDIGITAL] - DEVICH - BOXING", cloneOf: "glo-snp_112" }),
    "[09.10] (SNP) Cars - MX - glo-snp_113 - Devich - GC-Launcher - [ES] - [MKDIGITAL] - BOXING - CLONE_FROM=glo-snp_112",
  );
});

test("FB clone default name: your own campaign does not get your name a second time", () => {
  assert.equal(withOwner("MKDIGITAL - Katya - CREO - GIRLS b51GH", "Katya"), "MKDIGITAL - Katya - CREO - GIRLS b51GH");
  assert.equal(withOwner("MKDIGITAL - DEVICH - BOXING", "Devich"), "MKDIGITAL - DEVICH - BOXING");
  assert.equal(withOwner("Cars - Nazar", "nazar"), "Cars - Nazar");
  // somebody else's campaign still gets the cloner's name
  assert.equal(withOwner("MKDIGITAL - DEVICH - BOXING", "anna"), "MKDIGITAL - DEVICH - BOXING - Anna");
  assert.equal(withOwner("MKDIGITAL - DEVICH - BOXING", ""), "MKDIGITAL - DEVICH - BOXING");
});
