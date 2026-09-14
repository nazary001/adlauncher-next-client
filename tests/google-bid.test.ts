// Node's built-in runner (v24 strips types natively): `node --test tests/google-bid.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// Google Ads rail — the pure decisions behind the clone / JURO launches (lib/google-bid.ts):
// strategy vocabulary, bid/budget parsing, the wire plan, the team naming pattern, the São Paulo
// clock, the task-stage map, the error classifier, the deterministic task ids and the id regexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_BID_STRATEGIES,
  GOOGLE_CAMPAIGN_ID_RE,
  GOOGLE_CUSTOMER_ID_RE,
  GOOGLE_WAVE_ID_RE,
  googleBidKind,
  googleBidLabel,
  googleBidPlan,
  googleBudgetWire,
  googleNamePreview,
  googleNameSuffix,
  googleShotTaskId,
  googleTaskStage,
  googleWeaponErrorMessage,
  moneyText,
  parseDecimal,
  parseGoogleBid,
  parseGoogleBidLoose,
  todaySaoPauloDotDDMM,
  type GoogleBidKind,
} from "../lib/google-bid.ts";

// ---- GOOGLE_BID_STRATEGIES + googleBidKind: the partner vocabulary, 7 entries -----------------

test("the picker carries exactly the 7 google-weapon strategies with their kinds", () => {
  assert.deepEqual(
    GOOGLE_BID_STRATEGIES.map((s) => [s.value, s.kind]),
    [
      ["maximize_conversions", "none"],
      ["maximize_conversions_cap", "cpa"],
      ["target_cpa", "cpa"],
      ["target_roas", "roas"],
      ["maximize_conversion_value", "none"],
      ["maximize_conversion_value_target", "roas"],
      ["manual_cpc", "none"],
    ],
  );
});

test("googleBidKind maps each known strategy and 'unknown' for anything else", () => {
  for (const s of GOOGLE_BID_STRATEGIES) assert.equal(googleBidKind(s.value), s.kind, s.value);
  assert.equal(googleBidKind("target_cpa"), "cpa");
  assert.equal(googleBidKind("target_roas"), "roas");
  assert.equal(googleBidKind("maximize_conversions"), "none");
  assert.equal(googleBidKind("manual_cpc"), "none");
  assert.equal(googleBidKind("bogus"), "unknown");
  assert.equal(googleBidKind(""), "unknown");
});

// ---- parseDecimal: comma / dot / mixed / junk -------------------------------------------------

test("parseDecimal reads a lone comma as the decimal point", () => {
  assert.equal(parseDecimal("3,95"), 3.95);
  assert.equal(parseDecimal("0,5"), 0.5);
  assert.equal(parseDecimal("30,00"), 30);
  assert.equal(parseDecimal("30"), 30);
});

test("parseDecimal reads a plain dot as the decimal point", () => {
  assert.equal(parseDecimal("3.95"), 3.95);
  assert.equal(parseDecimal("10.5"), 10.5);
});

test("parseDecimal treats a comma-with-dot as a thousands separator", () => {
  assert.equal(parseDecimal("1,234.56"), 1234.56);
  assert.equal(parseDecimal("12,000.00"), 12000);
});

test("parseDecimal returns NaN for junk / empty / bare sign / bare dot", () => {
  assert.ok(Number.isNaN(parseDecimal("abc")));
  assert.ok(Number.isNaN(parseDecimal("")));
  assert.ok(Number.isNaN(parseDecimal("   ")));
  assert.ok(Number.isNaN(parseDecimal(".")));
  assert.ok(Number.isNaN(parseDecimal("-")));
  assert.ok(Number.isNaN(parseDecimal("3,,9")));
});

// ---- googleBudgetWire: human → 2-place decimal STRING or null ---------------------------------

test("googleBudgetWire formats to two places and gates the [1, 10000] range", () => {
  assert.equal(googleBudgetWire("30,00"), "30.00");
  assert.equal(googleBudgetWire("30"), "30.00");
  assert.equal(googleBudgetWire("30.5"), "30.50");
  assert.equal(googleBudgetWire("1"), "1.00");
  assert.equal(googleBudgetWire("10000"), "10000.00");
  assert.equal(googleBudgetWire("0,5"), null); // below the floor
  assert.equal(googleBudgetWire("10001"), null); // above the ceiling
  assert.equal(googleBudgetWire("abc"), null); // unparsable
  assert.equal(googleBudgetWire(""), null);
});

// ---- parseGoogleBid: CPA money vs ROAS integer percent ---------------------------------------

test("parseGoogleBid CPA: positive money ≤ 10000, comma-aware; 0 and over-cap refused", () => {
  assert.equal(parseGoogleBid("3,95", "cpa"), 3.95);
  assert.equal(parseGoogleBid("3.95", "cpa"), 3.95);
  assert.equal(parseGoogleBid("10000", "cpa"), 10000);
  assert.equal(parseGoogleBid("0", "cpa"), null);
  assert.equal(parseGoogleBid("10000,01", "cpa"), null);
  assert.equal(parseGoogleBid("abc", "cpa"), null);
});

test("parseGoogleBid ROAS: whole percent 1–200 only; decimals and out-of-range refused", () => {
  assert.equal(parseGoogleBid("90", "roas"), 90);
  assert.equal(parseGoogleBid("1", "roas"), 1);
  assert.equal(parseGoogleBid("200", "roas"), 200);
  assert.equal(parseGoogleBid("0", "roas"), null);
  assert.equal(parseGoogleBid("201", "roas"), null);
  assert.equal(parseGoogleBid("0,9", "roas"), null); // the FB decimal habit would land as 1 %
  assert.equal(parseGoogleBid("90,5", "roas"), null);
});

test("parseGoogleBid returns null for the no-value kind whatever is typed", () => {
  assert.equal(parseGoogleBid("3,95", "none"), null);
  assert.equal(parseGoogleBid("", "none"), null);
});

// ---- parseGoogleBidLoose: any positive number ≤ 10000 (inherit / JURO's unread strategy) -----

test("parseGoogleBidLoose accepts any positive money ≤ 10000, refuses 0 / empty / junk / over-cap", () => {
  assert.equal(parseGoogleBidLoose("3,95"), 3.95);
  assert.equal(parseGoogleBidLoose("90"), 90);
  assert.equal(parseGoogleBidLoose("0"), null);
  assert.equal(parseGoogleBidLoose(""), null);
  assert.equal(parseGoogleBidLoose("abc"), null);
  assert.equal(parseGoogleBidLoose("10000,01"), null);
});

// ---- googleBidLabel + moneyText: the monitor tag ---------------------------------------------

test("googleBidLabel covers every kind including unknown and null", () => {
  assert.equal(googleBidLabel("none", 5), "auto"); // none wins even with a value
  assert.equal(googleBidLabel("none", null), "auto");
  assert.equal(googleBidLabel("cpa", null), "inherit"); // null value → inherit before the kind
  assert.equal(googleBidLabel("roas", null), "inherit");
  assert.equal(googleBidLabel("unknown", null), "inherit");
  assert.equal(googleBidLabel("roas", 90), "ROAS 90%");
  assert.equal(googleBidLabel("roas", 90.4), "ROAS 90%"); // rounded whole percent
  assert.equal(googleBidLabel("cpa", 3.95), "CPA 3,95");
  assert.equal(googleBidLabel("cpa", 4), "CPA 4");
  assert.equal(googleBidLabel("unknown", 3.95), "bid 3,95"); // a typed bid we can't classify
});

test("moneyText drops a whole ,00 and uses the decimal comma otherwise", () => {
  assert.equal(moneyText(4), "4");
  assert.equal(moneyText(3.95), "3,95");
  assert.equal(moneyText(3.5), "3,5");
  assert.equal(moneyText(3.956), "3,96"); // rounded to 2 places
});

// ---- googleBidPlan: the wire decision matrix --------------------------------------------------

const plan = (mode: "clone" | "juro", override: string, typedBid: string) => googleBidPlan({ mode, override, typedBid });
const refusalOf = (p: ReturnType<typeof plan>): string => ("refusal" in p ? p.refusal : "");

test("JURO: a strategy override is a refusal (the source's strategy is fixed)", () => {
  const p = plan("juro", "target_cpa", "");
  assert.match(refusalOf(p), /JURO keeps the source's bidding strategy/);
});

test("JURO: empty bid inherits, a typed bid rides as an unclassified value, junk refuses", () => {
  assert.deepEqual(plan("juro", "", ""), { kind: "unknown", label: "inherit" });
  assert.deepEqual(plan("juro", "", "3,95"), { wireBid: 3.95, kind: "unknown", label: "bid 3,95" });
  assert.match(refusalOf(plan("juro", "", "abc")), /positive number/);
});

test("clone inherit (no strategy override): empty → inherit, typed → the value rides, no strategy", () => {
  assert.deepEqual(plan("clone", "", ""), { kind: "unknown", label: "inherit" });
  const p = plan("clone", "", "3,95");
  assert.deepEqual(p, { wireBid: 3.95, kind: "unknown", label: "bid 3,95" });
  assert.equal("wireStrategy" in p, false);
  assert.match(refusalOf(plan("clone", "", "abc")), /positive number/);
});

test("clone explicit no-value strategy: a bid is refused ('takes no bid value'), empty → auto", () => {
  assert.match(refusalOf(plan("clone", "maximize_conversions", "3,95")), /takes no bid value/);
  assert.deepEqual(plan("clone", "maximize_conversions", ""), {
    wireStrategy: "maximize_conversions",
    kind: "none",
    label: "auto",
  });
  assert.deepEqual(plan("clone", "manual_cpc", ""), { wireStrategy: "manual_cpc", kind: "none", label: "auto" });
});

test("clone Target CPA: missing bid names CPA; a typed CPA rides strategy + value + label", () => {
  assert.match(refusalOf(plan("clone", "target_cpa", "")), /CPA/);
  assert.deepEqual(plan("clone", "target_cpa", "3,95"), {
    wireStrategy: "target_cpa",
    wireBid: 3.95,
    kind: "cpa",
    label: "CPA 3,95",
  });
});

test("clone Target ROAS: '90' → ROAS 90%; a decimal '0,9' is refused naming 1–200", () => {
  assert.deepEqual(plan("clone", "target_roas", "90"), {
    wireStrategy: "target_roas",
    wireBid: 90,
    kind: "roas",
    label: "ROAS 90%",
  });
  assert.match(refusalOf(plan("clone", "target_roas", "0,9")), /1[–-]200/);
});

test("clone unknown strategy → refusal naming the value", () => {
  assert.match(refusalOf(plan("clone", "totally_made_up", "3,95")), /Unknown bidding strategy "totally_made_up"/);
});

test("for every strategy the plan's kind agrees with googleBidKind", () => {
  const bidFor = (kind: GoogleBidKind): string => (kind === "cpa" ? "3,95" : kind === "roas" ? "90" : "");
  for (const st of GOOGLE_BID_STRATEGIES) {
    const p = plan("clone", st.value, bidFor(st.kind));
    assert.equal("refusal" in p, false, `${st.value} should plan cleanly`);
    if (!("refusal" in p)) assert.equal(p.kind, googleBidKind(st.value), st.value);
  }
});

// ---- googleNameSuffix: the BARE suffix LION wraps (live-verified 14.09: LION appends
//      " | <suffix> | CLONE_FROM=<id>" itself — pipes/markers in ours were doubled) ---------------

test("clone suffix is bare 'DD.MM user' — no pipes, no marker (LION adds those)", () => {
  assert.equal(googleNameSuffix({ mode: "clone", sourceId: "24225047720", user: "nazar", ddmm: "14.09" }), "14.09 nazar GC-Launcher");
});

test("JURO and launch suffixes are the same bare shape", () => {
  assert.equal(googleNameSuffix({ mode: "juro", sourceId: "24225047720", user: "nazar", ddmm: "14.09" }), "14.09 nazar GC-Launcher");
  assert.equal(googleNameSuffix({ mode: "launch", user: "nazar", ddmm: "14.09" }), "14.09 nazar GC-Launcher");
});

test("the tail lands after the buyer, whitespace is squashed and pipes become slashes", () => {
  assert.equal(googleNameSuffix({ mode: "clone", sourceId: "12345", user: "  naz  ar ", ddmm: "14.09", tail: "promo   run" }), "14.09 naz ar GC-Launcher promo run");
  assert.equal(googleNameSuffix({ mode: "clone", sourceId: "12345", user: "nazar", ddmm: "14.09", tail: "a|b|c" }), "14.09 nazar GC-Launcher a/b/c");
});

test("an over-long tail is trimmed so the suffix stays ≤ 80", () => {
  const out = googleNameSuffix({ mode: "clone", sourceId: "24225047720", user: "nazar", ddmm: "14.09", tail: "x".repeat(120) });
  assert.ok(out.length <= 80, `length ${out.length}`);
  assert.ok(out.startsWith("14.09 nazar GC-Launcher x"), out);
});

test("an empty buyer falls back to 'buyer'", () => {
  assert.equal(googleNameSuffix({ mode: "clone", sourceId: "12345", user: "   ", ddmm: "14.09" }), "14.09 buyer GC-Launcher");
});

test("googleNamePreview reproduces LION's final name: head | suffix | CLONE_FROM / JURO_FROM / nothing", () => {
  assert.equal(googleNamePreview({ mode: "clone", head: "HEAD", suffix: "14.09 nazar", sourceId: "1" }), "HEAD | 14.09 nazar | CLONE_FROM=1");
  assert.equal(googleNamePreview({ mode: "juro", head: "HEAD", suffix: "14.09 nazar", sourceId: "1" }), "HEAD | 14.09 nazar | JURO_FROM=1");
  assert.equal(googleNamePreview({ mode: "launch", head: "HEAD", suffix: "14.09 nazar" }), "HEAD | 14.09 nazar");
});

// ---- todaySaoPauloDotDDMM: the injectable São Paulo clock (UTC-3) -----------------------------

test("São Paulo DD.MM crosses midnight correctly for a UTC time just past it", () => {
  // 02:00 UTC on the 14th is 23:00 on the 13th in São Paulo (UTC-3).
  assert.equal(todaySaoPauloDotDDMM(new Date("2026-09-14T02:00:00Z")), "13.09");
  // Midday UTC stays the same calendar day.
  assert.equal(todaySaoPauloDotDDMM(new Date("2026-09-14T12:00:00Z")), "14.09");
});

// ---- googleTaskStage: partner status → monitor stage -----------------------------------------

test("googleTaskStage maps the lifecycle and is case-insensitive; junk → unknown", () => {
  assert.equal(googleTaskStage("pending"), "queue");
  assert.equal(googleTaskStage("running"), "lion");
  assert.equal(googleTaskStage("completed"), "done");
  assert.equal(googleTaskStage("failed"), "failed");
  assert.equal(googleTaskStage("COMPLETED"), "done");
  assert.equal(googleTaskStage("weird"), "unknown");
  assert.equal(googleTaskStage(""), "unknown");
});

// ---- googleWeaponErrorMessage: the partner-refusal classifier ---------------------------------

test("a {error} body is surfaced verbatim", () => {
  assert.equal(googleWeaponErrorMessage(400, { error: "source not in dataset" }), "source not in dataset");
});

test("available_pixels is appended — as a list, or the no-pixel note when empty", () => {
  assert.equal(
    googleWeaponErrorMessage(400, { error: "pixel is required", available_pixels: ["AW-1/a", "AW-1/b"] }),
    "pixel is required · available pixels: AW-1/a, AW-1/b",
  );
  assert.equal(
    googleWeaponErrorMessage(400, { error: "pixel is required", available_pixels: [] }),
    "pixel is required · the account has no conversion pixel",
  );
});

test("a hint is appended once and not duplicated when already inside the message", () => {
  assert.equal(googleWeaponErrorMessage(404, { error: "source not in dataset", hint: "fetch it first" }), "source not in dataset (fetch it first)");
  const already = googleWeaponErrorMessage(404, { error: "please fetch it first", hint: "fetch it first" });
  assert.equal(already, "please fetch it first");
});

test("a 403 without the word 'customer' gains the customer note; one that has it does not", () => {
  assert.equal(googleWeaponErrorMessage(403, { error: "Access denied" }), "Access denied — customer not allowed for the LION user");
  assert.equal(googleWeaponErrorMessage(403, { error: "Access denied for customer(s)" }), "Access denied for customer(s)");
});

test("a string body is surfaced; an empty body falls back to the status or 'unreachable'", () => {
  assert.equal(googleWeaponErrorMessage(400, "plain text error"), "plain text error");
  assert.equal(googleWeaponErrorMessage(500, null), "google-weapon HTTP 500");
  assert.equal(googleWeaponErrorMessage(undefined, null), "google-weapon unreachable");
});

// ---- googleShotTaskId: deterministic per-shot ids --------------------------------------------

test("googleShotTaskId prefixes by mode and zero-pads the 1-based index", () => {
  assert.equal(googleShotTaskId("clone", "wave", 0), "ggc-wave-01");
  assert.equal(googleShotTaskId("juro", "wave", 0), "ggj-wave-01");
  assert.equal(googleShotTaskId("clone", "w", 9), "ggc-w-10");
  assert.equal(googleShotTaskId("clone", "w", 99), "ggc-w-100");
});

// ---- id regexes -------------------------------------------------------------------------------

test("the wave / campaign / customer id regexes gate their shapes", () => {
  assert.ok(GOOGLE_WAVE_ID_RE.test("3f2a91bc-1234-4c56-89ab-0123456789ab"));
  assert.ok(GOOGLE_WAVE_ID_RE.test("abcd1234"));
  assert.equal(GOOGLE_WAVE_ID_RE.test("abc"), false); // too short
  assert.equal(GOOGLE_WAVE_ID_RE.test("has space"), false);
  assert.equal(GOOGLE_WAVE_ID_RE.test("has_underscore_but_len_ok"), false); // underscore not allowed

  assert.ok(GOOGLE_CAMPAIGN_ID_RE.test("12345"));
  assert.ok(GOOGLE_CAMPAIGN_ID_RE.test("24240012365"));
  assert.equal(GOOGLE_CAMPAIGN_ID_RE.test("1234"), false); // < 5 digits
  assert.equal(GOOGLE_CAMPAIGN_ID_RE.test("12a45"), false);

  assert.ok(GOOGLE_CUSTOMER_ID_RE.test("123456"));
  assert.ok(GOOGLE_CUSTOMER_ID_RE.test("5378080027"));
  assert.equal(GOOGLE_CUSTOMER_ID_RE.test("12345"), false); // < 6 digits
  assert.equal(GOOGLE_CUSTOMER_ID_RE.test("12345a"), false);
});
