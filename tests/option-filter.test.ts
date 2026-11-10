// Node's built-in runner (v24 strips types natively): `node --test tests/option-filter.test.ts`.
// What the article / landing / quiz picker (components/search-select) lists and what its filter bar
// counts (owner 10.11: «сделай же менюшку выбора … чтобы она не занимала так много места и была удобнее
// намного»). The picker's menu is a narrow column of niches beside the list and one row of languages
// above it; this is the pure part behind both — which rows a query + a niche + a language leave, and
// how many rows each niche / language would show right now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { facetBar, filterOptions, segmentOf, tagWords } from "../lib/option-filter.ts";
import type { RichOption } from "../lib/catalog.ts";

// A cut of the VC ready list: a language in three tags ("EN" Purchase, "EN · Lead"), niches of 1–3 rows.
const ROWS: RichOption[] = [
  { value: "u/fire-en", label: "Are You More Fire, Earth, Air, or Water?", group: "Astrology / Zodiac", tag: "EN · Lead", segment: "EN" },
  { value: "u/fire-es", label: "¿Eres más fuego, tierra, aire o agua?", group: "Astrology / Zodiac", tag: "ES · Lead", segment: "ES" },
  { value: "u/fire-pt", label: "Você é mais fogo, terra, ar ou água?", group: "Astrology / Zodiac", tag: "PT · Lead", segment: "PT" },
  { value: "u/love-en", label: "Are You a Romantic Dreamer or a Practical Partner?", group: "Love / Relationships", tag: "EN · Lead", segment: "EN" },
  { value: "u/love-es", label: "¿Eres un alma romántica o un corazón práctico?", group: "Love / Relationships", tag: "ES · Lead", segment: "ES" },
  { value: "u/captcha", label: "Captcha Styles Explained", group: "Fashion", tag: "EN", segment: "EN" },
  { value: "u/food", label: "Which Dessert Matches You?", group: "Food", tag: "EN", segment: "EN" },
];
const values = (rows: RichOption[]) => rows.map((o) => o.value);
const all = { query: "", group: null, segment: null } as const;

test("tagWords: a tag's words, lower-cased — 'ES · Lead' is both the language and the event", () => {
  assert.deepEqual(tagWords("ES · Lead"), ["es", "lead"]);
  assert.deepEqual(tagWords("EN"), ["en"]);
  assert.deepEqual(tagWords("12/250"), ["12/250"]);
  assert.deepEqual(tagWords(undefined), []);
  assert.deepEqual(tagWords(""), []);
});

test("segmentOf: the language segment is the option's own segment, else its whole tag", () => {
  assert.equal(segmentOf({ value: "a", label: "A", tag: "ES · Lead", segment: "ES" }), "ES");
  assert.equal(segmentOf({ value: "a", label: "A", tag: "ES" }), "ES");
  assert.equal(segmentOf({ value: "a", label: "A" }), undefined);
});

test("filterOptions: nothing set → every row, in the catalog's order", () => {
  assert.deepEqual(values(filterOptions(ROWS, all)), values(ROWS));
});

test("filterOptions: a niche and a language compose with each other and with the typed query", () => {
  assert.deepEqual(values(filterOptions(ROWS, { ...all, group: "Astrology / Zodiac" })), ["u/fire-en", "u/fire-es", "u/fire-pt"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...all, segment: "ES" })), ["u/fire-es", "u/love-es"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...all, group: "Love / Relationships", segment: "ES" })), ["u/love-es"]);
  assert.deepEqual(values(filterOptions(ROWS, { query: "romantic", group: null, segment: "EN" })), ["u/love-en"]);
  assert.deepEqual(values(filterOptions(ROWS, { query: "romantic", group: "Food", segment: null })), []);
});

test("filterOptions: the language segment takes English whole — the Lead quizzes and the Purchase ones", () => {
  assert.deepEqual(values(filterOptions(ROWS, { ...all, segment: "EN" })), ["u/fire-en", "u/love-en", "u/captcha", "u/food"]);
});

test("filterOptions: the query reads the label, the meta, the value and the niche, case-blind", () => {
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "  DESSERT " })), ["u/food"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "zodiac" })), ["u/fire-en", "u/fire-es", "u/fire-pt"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "u/love" })), ["u/love-en", "u/love-es"]);
  const withMeta: RichOption[] = [{ value: "1", label: "Page", meta: "id 778899" }, { value: "2", label: "Other" }];
  assert.deepEqual(values(filterOptions(withMeta, { ...all, query: "7788" })), ["1"]);
});

test("filterOptions: a query that is a word of a tag also finds that tag's rows (every list)", () => {
  // "lead" is in no label here — the rows come from the tag's word alone.
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "lead" })), ["u/fire-en", "u/fire-es", "u/fire-pt", "u/love-en", "u/love-es"]);
  // …and the whole tag still works, as it always did.
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "pt · lead" })), ["u/fire-pt"]);
});

test("filterOptions: without tagQuery a language code also matches every label that holds it", () => {
  // "es" is in "Styl-es" and "D-es-sert" — the plain lists keep finding such a query everywhere.
  assert.deepEqual(values(filterOptions(ROWS, { ...all, query: "es" })), ["u/fire-es", "u/love-es", "u/captcha", "u/food"]);
});

test("filterOptions: with tagQuery a typed language is that language alone — 'pt' is not 'Captcha'", () => {
  const on = { ...all, tagQuery: true };
  assert.deepEqual(values(filterOptions(ROWS, { ...on, query: "pt" })), ["u/fire-pt"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...on, query: "ES" })), ["u/fire-es", "u/love-es"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...on, query: "en" })), ["u/fire-en", "u/love-en", "u/captcha", "u/food"]);
  assert.deepEqual(values(filterOptions(ROWS, { ...on, query: "lead" })), ["u/fire-en", "u/fire-es", "u/fire-pt", "u/love-en", "u/love-es"]);
  // a query that is no tag word is an ordinary search, tagQuery or not
  assert.deepEqual(values(filterOptions(ROWS, { ...on, query: "captcha" })), ["u/captcha"]);
});

test("facetBar: niches and languages in catalog order, with their totals and the number in the list now", () => {
  const bar = facetBar(ROWS, all);
  assert.deepEqual(bar.groups, [
    { name: "Astrology / Zodiac", total: 3, count: 3 },
    { name: "Love / Relationships", total: 2, count: 2 },
    { name: "Fashion", total: 1, count: 1 },
    { name: "Food", total: 1, count: 1 },
  ]);
  assert.deepEqual(bar.segments, [
    { name: "EN", total: 4, count: 4 },
    { name: "ES", total: 2, count: 2 },
    { name: "PT", total: 1, count: 1 },
  ]);
  assert.equal(bar.total, 7);
  assert.equal(bar.shown, 7);
});

test("facetBar: a niche's count follows the language and the query — never the picked niche itself", () => {
  // Spanish picked: the column says where the Spanish quizzes are; a niche with none stays listed at 0.
  const es = facetBar(ROWS, { ...all, segment: "ES", group: "Love / Relationships" });
  assert.deepEqual(es.groups.map((g) => [g.name, g.count]), [
    ["Astrology / Zodiac", 1],
    ["Love / Relationships", 1],
    ["Fashion", 0],
    ["Food", 0],
  ]);
  assert.equal(es.shown, 1);
  assert.equal(es.total, 7);
  const typed = facetBar(ROWS, { ...all, query: "romantic" });
  assert.deepEqual(typed.groups.map((g) => g.count), [0, 1, 0, 0]);
});

test("facetBar: a language's count follows the niche and the query — never the picked language itself", () => {
  const love = facetBar(ROWS, { ...all, group: "Love / Relationships", segment: "ES" });
  assert.deepEqual(love.segments.map((s) => [s.name, s.count]), [["EN", 1], ["ES", 1], ["PT", 0]]);
  assert.equal(love.shown, 1);
});

test("facetBar: rows without a niche or a tag are counted in the list and in no facet", () => {
  const plain: RichOption[] = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta", group: "G" }];
  const bar = facetBar(plain, all);
  assert.deepEqual(bar.groups, [{ name: "G", total: 1, count: 1 }]);
  assert.deepEqual(bar.segments, []);
  assert.equal(bar.total, 2);
  assert.equal(bar.shown, 2);
});
