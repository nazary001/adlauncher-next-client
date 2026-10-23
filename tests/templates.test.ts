// `node --test tests/templates.test.ts` — campaign templates (owner ask 16.10: a buyer saves a card's
// settings — everything but the creatives — and anyone on the team applies it; own templates are
// marked, every template is filed under its creator, only the creator or an owner-role login changes
// or deletes one). The pure rules of lib/templates.ts: what a template may carry, how a card takes it,
// who may manage it, how the picker groups and finds them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCampaign, type Campaign } from "../lib/types.ts";
import {
  TEMPLATE_KEYS,
  TEMPLATE_NAME_MAX,
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATES_PER_USER_MAX,
  type TemplateFields,
  agoLabel,
  applyTemplate,
  canManageTemplate,
  filterTemplates,
  groupTemplates,
  parseTemplateInput,
  parseTemplatePatch,
  sanitizeTemplateFields,
  swapOwnName,
  templateFieldDefsFor,
  templateFieldsFrom,
  templateNameKey,
  templateSummary,
} from "../lib/templates.ts";

const card = (over: Partial<Campaign> = {}): Campaign => ({
  ...makeCampaign("c1", "[16/10] (MO) - ", "Tima"),
  countries: ["US", "CA"],
  locales: ["6"],
  files: [{ id: "f1", name: "v.mp4", size: 10, kind: "video", url: "blob:x" }],
  gcm: "07",
  ...over,
});

// ---- what a template may carry -------------------------------------------------------------------

test("the template keys are the card's settings — never the creatives, the marker, the identity or the board memory", () => {
  for (const k of ["files", "gcm", "id", "collapsed", "namePrefix", "autoPage", "paramMode"]) {
    assert.ok(!(TEMPLATE_KEYS as readonly string[]).includes(k), `${k} is not a template key`);
  }
  for (const k of ["name", "profile", "account", "page", "pixel", "objective", "bidStrategy", "conversionEvent", "budget", "bidCap", "link", "landing", "title", "copy", "cta", "countries", "locales", "ageMin", "userOs", "platforms", "toolSession", "redirectType", "headline", "category", "placement", "optimization"]) {
    assert.ok((TEMPLATE_KEYS as readonly string[]).includes(k), `${k} is a template key`);
  }
  assert.equal(TEMPLATE_NAME_MAX, 60);
  assert.equal(TEMPLATE_DESCRIPTION_MAX, 240);
  assert.equal(TEMPLATES_PER_USER_MAX, 100);
});

test("templateFieldsFrom takes the ticked keys only, arrays as fresh copies", () => {
  const c = card({ budget: "25", bidStrategy: "COST_CAP", bidCap: "0,50" });
  const f = templateFieldsFrom(c, ["countries", "budget", "bidStrategy", "bidCap"]);
  assert.deepEqual(f, { countries: ["US", "CA"], budget: "25", bidStrategy: "COST_CAP", bidCap: "0,50" });
  assert.notEqual(f.countries, c.countries);
  // a key that is not a template key is ignored even if asked for
  const g = templateFieldsFrom(c, ["files", "gcm", "title"] as never);
  assert.deepEqual(Object.keys(g), ["title"]);
  // an absent optional stays absent (not "undefined")
  const h = templateFieldsFrom({ ...c, platforms: undefined }, ["platforms", "name"]);
  assert.deepEqual(h, { name: "Tima" });
});

test("templateNameKey: trimmed, spaces collapsed, lower-cased — the one-name-per-buyer key", () => {
  assert.equal(templateNameKey("  Cars   US  "), "cars us");
  assert.equal(templateNameKey("CARS us"), "cars us");
  assert.equal(templateNameKey(""), "");
});

// ---- the server's whitelist ----------------------------------------------------------------------

test("sanitizeTemplateFields keeps template keys, drops unknown ones, refuses wrong shapes", () => {
  const ok = sanitizeTemplateFields({ countries: ["US", " us ", "", "CA"], budget: 7, title: " Hello ", files: [{}], gcm: "01", id: "x", bogus: 1 });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.fields, { countries: ["US", "CA"], budget: "7", title: " Hello " });
  assert.deepEqual(ok.dropped.sort(), ["bogus", "files", "gcm", "id"]);
  // arrays must be arrays of strings; strings must be strings (numbers are tolerated, objects are not)
  assert.deepEqual(sanitizeTemplateFields({ countries: "US" }), { ok: false, error: "bad_field:countries" });
  assert.deepEqual(sanitizeTemplateFields({ locales: [1, 2] }), { ok: false, error: "bad_field:locales" });
  assert.deepEqual(sanitizeTemplateFields({ title: { a: 1 } }), { ok: false, error: "bad_field:title" });
  assert.deepEqual(sanitizeTemplateFields({ optimization: "both" }), { ok: false, error: "bad_field:optimization" });
  assert.deepEqual(sanitizeTemplateFields({ optimization: "clicks" }), { ok: true, fields: { optimization: "clicks" }, dropped: [] });
  assert.deepEqual(sanitizeTemplateFields(null), { ok: false, error: "fields_required" });
  assert.deepEqual(sanitizeTemplateFields([]), { ok: false, error: "fields_required" });
  // a too-long value is cut at the card's own maxLength, never refused
  const long = sanitizeTemplateFields({ title: "x".repeat(300), copy: "y".repeat(3000), link: "z".repeat(2500), name: "n".repeat(500) });
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.fields.title?.length, 255);
  assert.equal(long.fields.copy?.length, 2000);
  assert.equal(long.fields.link?.length, 2000);
  assert.equal(long.fields.name?.length, 400);
  // array caps: 300 entries, de-duplicated
  const many = sanitizeTemplateFields({ countries: Array.from({ length: 400 }, (_, i) => `C${i}`) });
  assert.equal(many.ok && many.fields.countries?.length, 300);
});

test("parseTemplateInput: name required (trimmed, ≤ 60), description ≤ 240, partner one of the team's, fields non-empty", () => {
  const partners = ["br", "in"];
  const good = parseTemplateInput({ name: "  Cars US  ", description: " lowest cost ", partner: "in", fields: { budget: "7" } }, partners);
  assert.deepEqual(good, { ok: true, value: { name: "Cars US", description: "lowest cost", partner: "in", fields: { budget: "7" } } });
  assert.deepEqual(parseTemplateInput({ partner: "in", fields: { budget: "7" } }, partners), { ok: false, error: "name_required" });
  assert.deepEqual(parseTemplateInput({ name: "   ", partner: "in", fields: { budget: "7" } }, partners), { ok: false, error: "name_required" });
  assert.deepEqual(parseTemplateInput({ name: "x".repeat(61), partner: "in", fields: { budget: "7" } }, partners), { ok: false, error: "name_too_long" });
  assert.deepEqual(parseTemplateInput({ name: "ok", description: "d".repeat(241), partner: "in", fields: { budget: "7" } }, partners), { ok: false, error: "description_too_long" });
  assert.deepEqual(parseTemplateInput({ name: "ok", fields: { budget: "7" } }, partners), { ok: false, error: "partner_required" });
  assert.deepEqual(parseTemplateInput({ name: "ok", partner: "us", fields: { budget: "7" } }, partners), { ok: false, error: "partner_not_available" });
  assert.deepEqual(parseTemplateInput({ name: "ok", partner: "xx", fields: { budget: "7" } }, partners), { ok: false, error: "partner_not_available" });
  assert.deepEqual(parseTemplateInput({ name: "ok", partner: "in" }, partners), { ok: false, error: "fields_required" });
  assert.deepEqual(parseTemplateInput({ name: "ok", partner: "in", fields: { files: [1] } }, partners), { ok: false, error: "fields_empty" });
  assert.deepEqual(parseTemplateInput({ name: "ok", partner: "in", fields: { countries: "US" } }, partners), { ok: false, error: "bad_field:countries" });
  assert.deepEqual(parseTemplateInput("junk", partners), { ok: false, error: "bad_body" });
  // a missing description is an empty one
  const noDesc = parseTemplateInput({ name: "ok", partner: "br", fields: { link: "https://a.b" } }, partners);
  assert.equal(noDesc.ok && noDesc.value.description, "");
});

test("parseTemplatePatch: only the given parts, the same rules; nothing given = nothing to change", () => {
  assert.deepEqual(parseTemplatePatch({ name: " New " }), { ok: true, patch: { name: "New" } });
  assert.deepEqual(parseTemplatePatch({ description: "" }), { ok: true, patch: { description: "" } });
  assert.deepEqual(parseTemplatePatch({ fields: { budget: "9", bogus: 1 } }), { ok: true, patch: { fields: { budget: "9" } } });
  assert.deepEqual(parseTemplatePatch({ name: "a", description: "b", fields: { countries: ["BR"] } }), { ok: true, patch: { name: "a", description: "b", fields: { countries: ["BR"] } } });
  assert.deepEqual(parseTemplatePatch({}), { ok: false, error: "nothing_to_change" });
  assert.deepEqual(parseTemplatePatch({ partner: "in" }), { ok: false, error: "nothing_to_change" }); // the partner never moves
  assert.deepEqual(parseTemplatePatch({ name: "" }), { ok: false, error: "name_required" });
  assert.deepEqual(parseTemplatePatch({ name: "x".repeat(61) }), { ok: false, error: "name_too_long" });
  assert.deepEqual(parseTemplatePatch({ fields: {} }), { ok: false, error: "fields_empty" });
  assert.deepEqual(parseTemplatePatch({ fields: { countries: 1 } }), { ok: false, error: "bad_field:countries" });
  assert.deepEqual(parseTemplatePatch(null), { ok: false, error: "bad_body" });
});

// ---- how a card takes a template ---------------------------------------------------------------

test("applyTemplate lands the template's keys on the card and leaves the rest — identity, creatives, marker, prefix and collapse never move", () => {
  const c = card({ collapsed: true });
  const t: TemplateFields = { countries: ["BR"], locales: ["23"], budget: "15", bidStrategy: "LOWEST_COST_WITH_BID_CAP", bidCap: "0,40", title: "T", copy: "C", landing: "auto-loans-2026" };
  const out = applyTemplate(c, { fields: t });
  assert.notEqual(out, c);
  assert.equal(out.id, "c1");
  assert.equal(out.collapsed, true);
  assert.equal(out.namePrefix, "[16/10] (MO) - ");
  assert.equal(out.gcm, "07");
  assert.deepEqual(out.files, c.files);
  assert.equal(out.files, c.files); // the same creatives, untouched
  assert.deepEqual(out.countries, ["BR"]);
  assert.notEqual(out.countries, t.countries); // the card's own array
  assert.deepEqual(out.locales, ["23"]);
  assert.equal(out.budget, "15");
  assert.equal(out.bidCap, "0,40");
  assert.equal(out.title, "T");
  assert.equal(out.landing, "auto-loans-2026");
  assert.equal(out.name, "Tima"); // not in the template → kept
  assert.equal(out.account, c.account);
  // the source template is not mutated and junk keys are ignored
  const junk = applyTemplate(c, { fields: { files: [], gcm: "99", id: "zzz" } as unknown as TemplateFields });
  assert.equal(junk.gcm, "07");
  assert.equal(junk.id, "c1");
  assert.equal(junk.files, c.files);
});

test("applyTemplate keeps objective and conversion event a valid pair", () => {
  // the template carries an objective whose events do not include the card's event
  const c = card({ objective: "OUTCOME_SALES", conversionEvent: "PURCHASE" });
  const leads = applyTemplate(c, { fields: { objective: "OUTCOME_LEADS" } });
  assert.equal(leads.objective, "OUTCOME_LEADS");
  assert.equal(leads.conversionEvent, "LEAD"); // the first event Leads allows
  // the template carries both — taken as they are
  const both = applyTemplate(c, { fields: { objective: "OUTCOME_LEADS", conversionEvent: "SCHEDULE" } });
  assert.deepEqual([both.objective, both.conversionEvent], ["OUTCOME_LEADS", "SCHEDULE"]);
  // the template carries an event the card's objective does not allow → the objective's first
  const ev = applyTemplate(c, { fields: { conversionEvent: "LEAD" } });
  assert.deepEqual([ev.objective, ev.conversionEvent], ["OUTCOME_SALES", "PURCHASE"]);
  // a shared event stays
  const shared = applyTemplate(c, { fields: { objective: "OUTCOME_LEADS", conversionEvent: "COMPLETE_REGISTRATION" } });
  assert.equal(shared.conversionEvent, "COMPLETE_REGISTRATION");
});

test("applyTemplate: a carried page is the buyer's own pick (the board's auto memory is cleared); without one the memory stays", () => {
  const c = card({ page: "111", autoPage: "111" });
  const picked = applyTemplate(c, { fields: { page: "222" } });
  assert.equal(picked.page, "222");
  assert.equal("autoPage" in picked, false);
  const untouched = applyTemplate(c, { fields: { budget: "9" } });
  assert.equal(untouched.autoPage, "111");
});

test("applyTemplate: a carried name repeats the creator's login as the applying buyer's login", () => {
  const c = card({ name: "Devich" });
  const own = applyTemplate(c, { fields: { name: "Tima - CARS" }, owner: "Tima" }, "Tima");
  assert.equal(own.name, "Tima - CARS");
  const other = applyTemplate(c, { fields: { name: "Tima - CARS" }, owner: "Tima" }, "Devich");
  assert.equal(other.name, "Devich - CARS");
  const bare = applyTemplate(c, { fields: { name: "tima" }, owner: "Tima" }, "Devich");
  assert.equal(bare.name, "Devich");
  const pipe = applyTemplate(c, { fields: { name: "Auto | Tima | vd-01" }, owner: "Tima" }, "Devich");
  assert.equal(pipe.name, "Auto | Devich | vd-01");
  const inside = applyTemplate(c, { fields: { name: "TimaBest - CARS" }, owner: "Tima" }, "Devich");
  assert.equal(inside.name, "TimaBest - CARS"); // a name inside a longer segment is not the login
  // no owner / no buyer known → the name lands as saved
  assert.equal(applyTemplate(c, { fields: { name: "Tima - CARS" } }).name, "Tima - CARS");
  assert.equal(applyTemplate(c, { fields: { name: "Tima - CARS" }, owner: "Tima" }).name, "Tima - CARS");
});

test("swapOwnName: whole segments only, either separator, any letter case; nothing else moves", () => {
  assert.equal(swapOwnName("Tima - CARS - vd-01", "Tima", "Devich"), "Devich - CARS - vd-01");
  assert.equal(swapOwnName("tima", "Tima", "Devich"), "Devich");
  assert.equal(swapOwnName("Cars | TIMA", "Tima", "Devich"), "Cars | Devich");
  assert.equal(swapOwnName("Tima CREO - x", "Tima", "Devich"), "Tima CREO - x");
  assert.equal(swapOwnName("", "Tima", "Devich"), "");
  assert.equal(swapOwnName("Tima - x", "", "Devich"), "Tima - x");
  assert.equal(swapOwnName("Tima - x", "Tima", ""), "Tima - x");
  assert.equal(swapOwnName("Tima - x", "Tima", "Tima"), "Tima - x");
});

// ---- who may manage ------------------------------------------------------------------------------

test("canManageTemplate: the creator (any letter case) and an owner-role login; nobody else", () => {
  const t = { owner: "Tima" };
  assert.equal(canManageTemplate({ username: "Tima" }, t), true);
  assert.equal(canManageTemplate({ username: "tima " }, t), true);
  assert.equal(canManageTemplate({ username: "Devich" }, t), false);
  assert.equal(canManageTemplate({ username: "Devich", owner: true }, t), true);
  assert.equal(canManageTemplate({ username: "", owner: false }, t), false);
  assert.equal(canManageTemplate(null, t), false);
});

// ---- the picker: groups, search, summary -------------------------------------------------------

type Row = { owner: string; name: string; description: string; updatedAt: string };
const row = (owner: string, name: string, updatedAt: string, description = ""): Row => ({ owner, name, description, updatedAt });

test("groupTemplates: the buyer's own group first and marked, other creators A→Z, newest-updated first inside a group", () => {
  const list = [
    row("Zed", "z1", "2026-10-10T00:00:00Z"),
    row("tima", "mine-old", "2026-10-01T00:00:00Z"),
    row("Alex", "a1", "2026-10-12T00:00:00Z"),
    row("Tima", "mine-new", "2026-10-15T00:00:00Z"),
    row("alex", "a2", "2026-10-14T00:00:00Z"),
  ];
  const groups = groupTemplates(list, "Tima");
  assert.deepEqual(groups.map((g) => [g.owner, g.mine, g.items.map((i) => i.name)]), [
    ["Tima", true, ["mine-new", "mine-old"]],
    ["Alex", false, ["a2", "a1"]],
    ["Zed", false, ["z1"]],
  ]);
  // no own templates → no own group (the UI shows the way in); case-insensitive owner merge keeps the first spelling seen
  const none = groupTemplates(list.filter((r) => r.owner.toLowerCase() !== "tima"), "Tima");
  assert.deepEqual(none.map((g) => g.owner), ["Alex", "Zed"]);
  assert.deepEqual(groupTemplates([], "Tima"), []);
});

test("filterTemplates: every typed word must match the name, the description or the creator", () => {
  const list = [row("Tima", "Cars US", "2026-10-10T00:00:00Z", "lowest cost"), row("Alex", "MKD Brazil", "2026-10-10T00:00:00Z", "roas 0,30"), row("Alex", "Cars BR", "2026-10-10T00:00:00Z")];
  assert.deepEqual(filterTemplates(list, "").map((r) => r.name), ["Cars US", "MKD Brazil", "Cars BR"]);
  assert.deepEqual(filterTemplates(list, "cars").map((r) => r.name), ["Cars US", "Cars BR"]);
  assert.deepEqual(filterTemplates(list, "cars alex").map((r) => r.name), ["Cars BR"]);
  assert.deepEqual(filterTemplates(list, "ROAS").map((r) => r.name), ["MKD Brazil"]);
  assert.deepEqual(filterTemplates(list, "  lowest   cost ").map((r) => r.name), ["Cars US"]);
  assert.deepEqual(filterTemplates(list, "nothing"), []);
});

test("templateSummary: the chips a row shows, in a fixed order, only for what the template carries", () => {
  assert.deepEqual(templateSummary({ countries: ["US"], budget: "7", bidStrategy: "LOWEST_COST_WITHOUT_CAP", conversionEvent: "PURCHASE", objective: "OUTCOME_SALES" }), ["United States", "$7/day", "auto", "Sales · Purchase"]);
  assert.deepEqual(templateSummary({ countries: ["WW"], budget: "50", bidStrategy: "LOWEST_COST_WITH_MIN_ROAS", bidCap: "0,30" }), ["World", "$50/day", "ROAS 0,3"]);
  assert.deepEqual(templateSummary({ countries: ["BR", "MX", "AR"], bidStrategy: "COST_CAP", bidCap: "0,5", profile: "glo-01-41", account: "act_1", page: "2" }), ["3 geos", "bid $0,5", "glo-01-41", "account · page"]);
  assert.deepEqual(templateSummary({ optimization: "clicks", title: "x" }), ["Clicks"]);
  assert.deepEqual(templateSummary({}), []);
});

test("templateFieldDefsFor: the partner's own fields, one entry per key, creatives never listed", () => {
  const mo = templateFieldDefsFor({ usesGcm: true, usesProfile: false, fanpagesFromToken: true, accountsFromToken: true });
  const moKeys = mo.map((d) => d.key);
  assert.ok(moKeys.includes("landing") && !moKeys.includes("link") && !moKeys.includes("redirectType") && !moKeys.includes("profile"));
  assert.ok(moKeys.includes("headline") && moKeys.includes("optimization"));
  assert.equal(new Set(moKeys).size, moKeys.length);
  assert.ok(!(moKeys as string[]).includes("files"));
  const hs = templateFieldDefsFor({ lionLaunch: true, usesProfile: true });
  const hsKeys = hs.map((d) => d.key);
  assert.ok(hsKeys.includes("profile") && hsKeys.includes("link") && hsKeys.includes("redirectType"));
  assert.ok(!hsKeys.includes("landing") && !hsKeys.includes("headline") && !hsKeys.includes("optimization") && !hsKeys.includes("platforms"));
  const av = templateFieldDefsFor({ avLaunch: true, fanpagesFromToken: true, accountsFromToken: true });
  const avKeys = av.map((d) => d.key);
  assert.ok(avKeys.includes("platforms") && avKeys.includes("toolSession") && avKeys.includes("landing") && !avKeys.includes("pixel"));
  // VC (23.10): the pasted landingpage link rides `landing`; pixel / objective / event are pinned (vcDelivery)
  const vcKeys = templateFieldDefsFor({ vcLaunch: true, fanpagesFromToken: true, accountsFromToken: true }).map((d) => d.key);
  assert.ok(vcKeys.includes("landing") && vcKeys.includes("optimization") && vcKeys.includes("headline"));
  assert.ok(!vcKeys.includes("pixel") && !vcKeys.includes("objective") && !vcKeys.includes("conversionEvent") && !vcKeys.includes("link") && !vcKeys.includes("platforms"));
  // the name is offered but off by default; everything else on
  const nameDef = mo.find((d) => d.key === "name");
  assert.equal(nameDef?.defaultOn, false);
  assert.ok(mo.filter((d) => d.key !== "name").every((d) => d.defaultOn !== false));
  // previews read the template's own values
  const geo = mo.find((d) => d.key === "countries");
  assert.equal(geo?.preview({ countries: ["US", "CA"] }), "United States, Canada");
  assert.equal(geo?.preview({}), "—");
  const strategy = mo.find((d) => d.key === "bidStrategy");
  assert.equal(strategy?.preview({ bidStrategy: "COST_CAP" }), "Cost cap");
});

test("agoLabel: a short relative age", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(agoLabel("2026-10-16T11:59:40Z", now), "just now");
  assert.equal(agoLabel("2026-10-16T11:45:00Z", now), "15 min ago");
  assert.equal(agoLabel("2026-10-16T09:00:00Z", now), "3 h ago");
  assert.equal(agoLabel("2026-10-13T12:00:00Z", now), "3 d ago");
  assert.equal(agoLabel("2026-09-01T12:00:00Z", now), "01.09");
  assert.equal(agoLabel("garbage", now), "");
  assert.equal(agoLabel("2026-10-16T13:00:00Z", now), "just now"); // a clock ahead of ours
});
