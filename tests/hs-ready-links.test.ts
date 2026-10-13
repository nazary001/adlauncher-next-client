// Node's built-in runner (v24 strips types natively): `node --test tests/hs-ready-links.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
// The HS card's ready landings (lib/hs-ready-links.ts): the partner pages LION's Campaign URL
// Builder hands a buyer, as read off the builder on 13.10 under the GLO-02 login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HS_READY_LINKS, hsReadyLinkOf, hsReadyLinksFor } from "../lib/hs-ready-links.ts";
import { teamConfig } from "../lib/team.ts";

const LANGS = ["EN", "ES", "FR", "PT"];
const row = (l: { niche: string; lang: string; kind: string; url: string }) => [l.niche, l.lang, l.kind, l.url];

test("HIGH ADX: Cars and MKD in four languages — the direct article and every captcha template, as the builder prints them", () => {
  const high = hsReadyLinksFor("HIGH ADX");
  assert.equal(high.length, 2 * 4 * 12);
  const url = (niche: string, lang: string, kind: string) => high.find((l) => l.niche === niche && l.lang === lang && l.kind === kind)?.url;
  assert.equal(url("Cars", "EN", "Direct article"), "https://fast-flow.org/htd/cars/en/");
  assert.equal(url("Digital Marketing", "PT", "Direct article"), "https://fast-flow.org/htd/digital-marketing/pt/");
  assert.equal(url("Cars", "EN", "Captcha 1"), "https://fast-flow.org/ht/captcha-1/cars/en/");
  assert.equal(url("Cars", "ES", "Captcha 3"), "https://fast-flow.org/ht/captcha-3/cars/es/");
  assert.equal(url("Digital Marketing", "FR", "Captcha 10"), "https://fast-flow.org/ht/captcha-10/digital-marketing/fr/");
  assert.equal(url("Cars", "PT", "Captcha (legacy)"), "https://fast-flow.org/ht/captcha/cars/pt/");
  // every niche × language carries the same twelve picks, the article first
  const kinds = ["Direct article", ...Array.from({ length: 10 }, (_, i) => `Captcha ${i + 1}`), "Captcha (legacy)"];
  for (const niche of ["Cars", "Digital Marketing"]) {
    for (const lang of LANGS) {
      assert.deepEqual(high.filter((l) => l.niche === niche && l.lang === lang).map((l) => l.kind), kinds, `${niche} ${lang}`);
    }
  }
  assert.ok(high.every((l) => l.redirectType === "HIGH ADX"));
});

test("META ADX: the builder's own map — one direct article and one captcha per niche and language", () => {
  assert.deepEqual(hsReadyLinksFor("META ADX").map(row), [
    ["Cars", "EN", "Direct article", "https://routerix.tech/direct/carros-en/"],
    ["Cars", "EN", "Captcha", "https://routerix.tech/captcha/cars/en/"],
    ["Cars", "ES", "Direct article", "https://routerix.tech/direct/carros-es/"],
    ["Cars", "ES", "Captcha", "https://routerix.tech/captcha/cars/es/"],
    ["Cars", "FR", "Direct article", "https://routerix.tech/direct/carros-fr/"],
    ["Cars", "FR", "Captcha", "https://routerix.tech/captcha/cars/fr/"],
    ["Cars", "PT", "Direct article", "https://routerix.tech/direct/carros-br/"],
    ["Cars", "PT", "Captcha", "https://routerix.tech/captcha/cars/pt/"],
    ["Digital Marketing", "EN", "Direct article", "https://routerix.tech/direct/marketing-digital-en/"],
    ["Digital Marketing", "EN", "Captcha", "https://routerix.tech/captcha/mkt/en/"],
    ["Digital Marketing", "ES", "Direct article", "https://routerix.tech/direct/marketing-digital-es/"],
    ["Digital Marketing", "ES", "Captcha", "https://routerix.tech/captcha/mkt/es/"],
    ["Digital Marketing", "FR", "Direct article", "https://routerix.tech/direct/marketing-digital-fr/"],
    ["Digital Marketing", "FR", "Captcha", "https://routerix.tech/captcha/mkt/fr/"],
    ["Digital Marketing", "PT", "Direct article", "https://routerix.tech/direct/marketing-digital-br/"],
    ["Digital Marketing", "PT", "Captcha", "https://routerix.tech/captcha/mkt/pt/"],
  ]);
});

test("a redirect type the builder has no tab for has no ready landings", () => {
  assert.deepEqual(hsReadyLinksFor("#ADX"), []);
  assert.deepEqual(hsReadyLinksFor(""), []);
  assert.deepEqual(hsReadyLinksFor("high adx"), []);
  // the two tabs are the whole catalog, and a type's list is the same array on every call
  assert.equal(hsReadyLinksFor("HIGH ADX").length + hsReadyLinksFor("META ADX").length, HS_READY_LINKS.length);
  assert.equal(hsReadyLinksFor("HIGH ADX"), hsReadyLinksFor("HIGH ADX"));
});

test("every ready landing is a bare https page — no query, no hash, a trailing slash — and is listed once", () => {
  for (const l of HS_READY_LINKS) {
    const u = new URL(l.url);
    assert.equal(u.protocol, "https:", l.url);
    assert.equal(u.search + u.hash, "", l.url);
    assert.ok(u.pathname.endsWith("/"), l.url);
    assert.equal(u.toString(), l.url, l.url);
    assert.equal(u.host, l.redirectType === "HIGH ADX" ? "fast-flow.org" : "routerix.tech", l.url);
    // the page is in the language its row says (the Brazilian direct articles spell it "br")
    assert.match(u.pathname, new RegExp(`[/-](${l.lang === "PT" ? "pt|br" : l.lang.toLowerCase()})/$`), l.url);
  }
  assert.equal(new Set(HS_READY_LINKS.map((l) => l.url)).size, HS_READY_LINKS.length);
});

test("picker order: a niche is one unbroken run (the picker prints its header on change), languages EN → ES → FR → PT inside it", () => {
  for (const type of ["HIGH ADX", "META ADX"]) {
    const list = hsReadyLinksFor(type);
    const niches = list.map((l) => l.niche).filter((n, i, a) => i === 0 || a[i - 1] !== n);
    assert.deepEqual(niches, ["Cars", "Digital Marketing"], type);
    for (const niche of niches) {
      const langs = list.filter((l) => l.niche === niche).map((l) => l.lang).filter((n, i, a) => i === 0 || a[i - 1] !== n);
      assert.deepEqual(langs, LANGS, `${type} ${niche}`);
    }
    // a row names its niche the way the team does, so the closed field reads "MKD · Captcha 3"
    assert.deepEqual([...new Set(list.map((l) => `${l.niche}=${l.short}`))], ["Cars=Cars", "Digital Marketing=MKD"], type);
  }
});

test("hsReadyLinkOf: the link field holds a ready landing only when it is exactly one — anything else is a pasted link", () => {
  assert.equal(hsReadyLinkOf("https://fast-flow.org/ht/captcha-3/cars/es/")?.kind, "Captcha 3");
  assert.equal(hsReadyLinkOf("  https://fast-flow.org/htd/digital-marketing/fr/ \n")?.short, "MKD");
  assert.equal(hsReadyLinkOf("https://routerix.tech/captcha/mkt/pt/")?.redirectType, "META ADX");
  for (const pasted of [
    "",
    "https://fast-flow.org/ht/captcha-3/cars/es",
    "https://fast-flow.org/ht/captcha-3/cars/es/?utm_source=facebook",
    "http://fast-flow.org/ht/captcha-3/cars/es/",
    "https://quick-flow.net/ht/captcha-3/cars/es/",
    "https://fast-flow.org/ht/captcha-11/cars/es/",
    "https://fast-flow.org/ht/age-gate/digital-marketing/en/",
    "https://routerix.tech/worldcars/pt/",
  ]) {
    assert.equal(hsReadyLinkOf(pasted), null, pasted);
  }
  assert.equal(hsReadyLinkOf(undefined as unknown as string), null);
});

test("only a team that has them is offered ready landings — the first team's card stays a pasted link", () => {
  assert.equal(teamConfig("glo-02").hsReadyLinks, true);
  assert.equal(teamConfig("glo-01").hsReadyLinks, false);
});
