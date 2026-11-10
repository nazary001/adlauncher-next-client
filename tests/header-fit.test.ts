// Node's built-in runner (v24 strips types natively): `node --test tests/header-fit.test.ts`.
// The header fits itself to whatever width it is given (owner ask 10.11: «чтобы всегда все помещалось
// там … чтобы на меньших экранах ничего не наезжало друг на друга»). The pure part is held here:
// which layouts there are, the walk that settles on the roomiest one that fits, the attributes the
// CSS reads, and the pre-paint script — which must answer exactly what the walk answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_PREFIT_SCRIPT,
  MAX_SQUEEZE,
  ROOMY_FIT,
  fitAttrs,
  fitFromAttrs,
  midLineFits,
  oneRowFits,
  settleFit,
  squeezeTokens,
  topLineFits,
  type FitProbe,
  type HeaderFit,
} from "../lib/header-fit.ts";

const GAP = 12;

/** A header made of numbers: each part's width depends on how much of it is folded away. */
const PARTS = {
  logo: (s: number) => (s >= 4 ? 40 : 205),
  mid: (s: number) => 640 - (s >= 1 ? 60 : 0) - (s >= 2 ? 55 : 0) - (s >= 3 ? 130 : 0) - (s >= 5 ? 70 : 0),
  right: (s: number) => 470 - (s >= 1 ? 50 : 0) - (s >= 2 ? 120 : 0) - (s >= 5 ? 34 : 0),
};

/** The probe over that header at `inner` px; `seen` lists every layout that was measured. */
function world(inner: number, scale = 1) {
  const seen: string[] = [];
  const probe: FitProbe = {
    oneRow: (s) => (seen.push(`one${s}`), oneRowFits(PARTS.logo(s) * scale, PARTS.mid(s) * scale, PARTS.right(s) * scale, inner, GAP)),
    top: (s) => (seen.push(`top${s}`), topLineFits(PARTS.logo(s) * scale, PARTS.right(s) * scale, inner, GAP)),
    mid: (s) => (seen.push(`mid${s}`), midLineFits(PARTS.mid(s) * scale, inner)),
  };
  return { probe, seen };
}
const one = (s: number): HeaderFit => ({ rows: 1, top: s, mid: s, wrapTop: false, wrapMid: false });
const two = (top: number, mid: number, wrapTop = false, wrapMid = false): HeaderFit => ({ rows: 2, top, mid, wrapTop, wrapMid });

// One line needs logo + mid + right + 2 gaps:  s0 1339 · s1 1229 · s2 1054 · s3 924 · s4 759 · s5 655.
// Two lines: the top needs logo + right + gap: s0 687 · s1 637 · s2-3 517 · s4 352 · s5 318;
//            the partner line needs mid:       s0 640 · s1 580 · s2 525 · s3-4 395 · s5 325.

test("one line while it fits, squeezed only as far as needed", () => {
  for (const [inner, want] of [[1500, 0], [1339, 0], [1338, 1], [1229, 1], [1228, 2], [1000, 3], [800, 4], [700, 5], [655, 5]] as const) {
    assert.deepEqual(settleFit(ROOMY_FIT, world(inner).probe), one(want), `inner ${inner}`);
  }
});

test("two lines below that — each line squeezed on its own", () => {
  // 654: the top line needs step 1 (637), the partner line fits untouched (640).
  assert.deepEqual(settleFit(ROOMY_FIT, world(654).probe), two(1, 0));
  // 638: top still step 1, the partner line needs step 1 (580).
  assert.deepEqual(settleFit(ROOMY_FIT, world(638).probe), two(1, 1));
  // 600: the top line needs step 2 (517) — 637 does not fit.
  assert.deepEqual(settleFit(ROOMY_FIT, world(600).probe), two(2, 1));
  // 520: top step 2 (517), partner line step 3 (395) — 525 does not fit.
  assert.deepEqual(settleFit(ROOMY_FIT, world(520).probe), two(2, 3));
  // 400: top step 4 (352), partner line step 3 (395).
  assert.deepEqual(settleFit(ROOMY_FIT, world(400).probe), two(4, 3));
});

test("a line that cannot fit even at the last step wraps — the other one does not have to", () => {
  assert.deepEqual(settleFit(ROOMY_FIT, world(324).probe), two(5, MAX_SQUEEZE, false, true)); // 318 fits, 325 does not
  assert.deepEqual(settleFit(ROOMY_FIT, world(300).probe), two(MAX_SQUEEZE, MAX_SQUEEZE, true, true));
  assert.deepEqual(settleFit(ROOMY_FIT, world(10).probe), two(MAX_SQUEEZE, MAX_SQUEEZE, true, true));
});

test("the answer does not depend on where the walk starts", () => {
  const starts: HeaderFit[] = [];
  for (let s = 0; s <= MAX_SQUEEZE; s++) starts.push(one(s));
  for (let t = 0; t <= MAX_SQUEEZE; t++) for (let m = 0; m <= MAX_SQUEEZE; m++) starts.push(two(t, m));
  starts.push(two(MAX_SQUEEZE, MAX_SQUEEZE, true, true), two(MAX_SQUEEZE, 2, true, false), two(1, MAX_SQUEEZE, false, true));
  for (const scale of [1, 0.6]) {
    for (let inner = 200; inner <= 1400; inner += 9) {
      const want = settleFit(ROOMY_FIT, world(inner, scale).probe);
      for (const from of starts) assert.deepEqual(settleFit(from, world(inner, scale).probe), want, `inner ${inner} ×${scale} from ${JSON.stringify(from)}`);
    }
  }
});

test("a steady header costs two measurements on one line, five on two", () => {
  const a = world(1100);
  assert.deepEqual(settleFit(one(2), a.probe), one(2));
  assert.deepEqual(a.seen, ["one2", "one1"]);
  const roomy = world(2000);
  assert.deepEqual(settleFit(one(0), roomy.probe), one(0));
  assert.deepEqual(roomy.seen, ["one0"]);
  // Two lines: is the tightest single line possible yet (1), then each line: its step, the one above.
  const b = world(638);
  assert.deepEqual(settleFit(two(1, 1), b.probe), two(1, 1));
  assert.deepEqual(b.seen, ["one5", "top1", "top0", "mid1", "mid0"]);
});

test("growing back from two lines to one goes through the tightest single line", () => {
  const w = world(760);
  assert.deepEqual(settleFit(two(1, 1), w.probe), one(4));
  assert.deepEqual(w.seen, ["one5", "one4", "one3"]);
});

test("nonsense steps in the starting layout are clamped", () => {
  const want = settleFit(ROOMY_FIT, world(1100).probe);
  assert.deepEqual(settleFit({ rows: 1, top: -3, mid: 99, wrapTop: false, wrapMid: false }, world(1100).probe), want);
  assert.deepEqual(settleFit({ rows: 1, top: Number.NaN, mid: 0, wrapTop: false, wrapMid: false }, world(1100).probe), want);
  assert.deepEqual(settleFit({ rows: 2, top: 99, mid: -1, wrapTop: true, wrapMid: true }, world(1100).probe), want);
});

test("squeezeTokens lists every step up to the level (CSS matches them with ~=)", () => {
  assert.equal(squeezeTokens(0), "");
  assert.equal(squeezeTokens(1), "1");
  assert.equal(squeezeTokens(3), "1 2 3");
  assert.equal(squeezeTokens(99), "1 2 3 4 5");
});

test("the attributes say the layout, and read back to it", () => {
  assert.deepEqual(fitAttrs(one(0)), { rows: "1", sq: "", sqm: "", wrap: null });
  assert.deepEqual(fitAttrs(two(2, 3)), { rows: "2", sq: "1 2", sqm: "1 2 3", wrap: null });
  assert.deepEqual(fitAttrs(two(5, 5, true, true)), { rows: "2", sq: "1 2 3 4 5", sqm: "1 2 3 4 5", wrap: "top mid" });
  assert.deepEqual(fitAttrs(two(1, 5, false, true)).wrap, "mid");
  for (const fit of [one(0), one(4), two(2, 3), two(5, 5, true, true), two(1, 5, false, true), two(5, 0, true, false)]) {
    assert.deepEqual(fitFromAttrs(fitAttrs(fit)), fit);
  }
  // Not measured yet (the attributes are simply not there).
  assert.equal(fitFromAttrs({ rows: null, sq: null, sqm: null, wrap: null }), null);
});

test("fit checks: gaps counted, half a pixel of slack", () => {
  assert.equal(oneRowFits(100, 300, 200, 624, 12), true); // 600 + 24
  assert.equal(oneRowFits(100, 300, 200, 623, 12), false);
  assert.equal(oneRowFits(100, 300, 200, 623.6, 12), true);
  assert.equal(topLineFits(100, 200, 312, 12), true);
  assert.equal(topLineFits(101, 200, 312, 12), false);
  assert.equal(midLineFits(300, 300), true);
  assert.equal(midLineFits(301, 300), false);
});

// ---- the pre-paint script (the server's HTML) against the walk ----

test("the pre-paint script leaves the very layout the walk settles on, at every width", () => {
  for (const scale of [1, 0.6]) {
    for (let viewport = 240; viewport <= 1500; viewport += 7) {
      const attrs = new Map<string, string>();
      const steps = (k: string) => (attrs.get(k) ?? "").split(" ").filter(Boolean).length;
      const part = (w: (s: number) => number, attr: string) => ({ getBoundingClientRect: () => ({ width: w(steps(attr)) * scale }) });
      const parts: Record<string, unknown> = {
        ".hdr-row": { clientWidth: viewport },
        ".hdr-logo": part(PARTS.logo, "data-sq"),
        ".hdr-mid-in": part(PARTS.mid, "data-sqm"),
        ".hdr-right": part(PARTS.right, "data-sq"),
      };
      const hdr = {
        setAttribute: (k: string, v: unknown) => void attrs.set(k, String(v)),
        removeAttribute: (k: string) => void attrs.delete(k),
        querySelector: (sel: string) => parts[sel] ?? null,
      };
      // Nothing but the header is handed over: the script must not reach for <html> (hydration).
      const doc = { querySelectorAll: () => [hdr] };
      new Function("document", "getComputedStyle", HEADER_PREFIT_SCRIPT)(doc, () => ({ paddingLeft: "24px", paddingRight: "24px", columnGap: `${GAP}px` }));
      const scripted = fitFromAttrs({ rows: attrs.get("data-rows") ?? null, sq: attrs.get("data-sq") ?? null, sqm: attrs.get("data-sqm") ?? null, wrap: attrs.get("data-wrap") ?? null });
      assert.deepEqual(scripted, settleFit(ROOMY_FIT, world(viewport - 48, scale).probe), `viewport ${viewport} ×${scale}`);
    }
  }
});

test("the pre-paint script leaves a page without the header alone", () => {
  new Function("document", "getComputedStyle", HEADER_PREFIT_SCRIPT)({ querySelectorAll: () => [] }, () => assert.fail("nothing to measure"));
  const bare = { querySelector: () => null, setAttribute: () => assert.fail("not a board header"), removeAttribute: () => assert.fail("not a board header") };
  new Function("document", "getComputedStyle", HEADER_PREFIT_SCRIPT)({ querySelectorAll: () => [bare] }, () => assert.fail("nothing to measure"));
});
