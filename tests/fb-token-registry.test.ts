// Node's built-in runner (v24 strips types natively): `node --test tests/fb-token-registry.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_IDS,
  addToken,
  effectiveSlot,
  emptyRegistry,
  envDefaultIds,
  envSeeds,
  looksLikeFbToken,
  newTokenId,
  normalizeToken,
  parseMoSocTokensEnv,
  removeToken,
  sanitizeRegistry,
  setIdentity,
  setSlot,
  updateToken,
  validateLabel,
  validatePartners,
  type TokenEntry,
} from "../lib/fb-token-registry.ts";

const fp = (t: string) => `fp-${t.slice(0, 6)}`;
const NOW = 1_700_000_000_000;

const entry = (over: Partial<TokenEntry> = {}): Omit<TokenEntry, "id"> => ({
  label: "Harvmo",
  sealed: "v1.a.b.c",
  fp: "fp-EAAtok",
  partners: ["mo"],
  personal: false,
  note: "",
  addedBy: "nazar",
  addedAt: NOW,
  identity: null,
  ...over,
});

// ---- input validation ------------------------------------------------------------------------

test("normalizeToken strips Bearer/quotes/whitespace; looksLikeFbToken rejects junk", () => {
  assert.equal(normalizeToken("  Bearer EAABtoken123  "), "EAABtoken123");
  assert.equal(normalizeToken('"EAABtoken123"'), "EAABtoken123");
  assert.equal(normalizeToken("EAAB\ntoken"), "EAABtoken");
  assert.equal(normalizeToken(null), "");
  assert.ok(looksLikeFbToken("EAAB" + "x".repeat(60)));
  assert.ok(!looksLikeFbToken("EAAB short"));
  assert.ok(!looksLikeFbToken("EAAB" + "x".repeat(30))); // too short
  assert.ok(!looksLikeFbToken("EAAB" + "x".repeat(60) + "!")); // bad char
});

test("validateLabel / validatePartners", () => {
  assert.equal(validateLabel("  Harvmo (AIF) "), "Harvmo (AIF)");
  assert.equal(validateLabel(""), null);
  assert.equal(validateLabel("x".repeat(41)), null);
  assert.equal(validateLabel("bad<script>"), null);
  assert.deepEqual(validatePartners(["mo", "mo", "hs"]), ["mo", "hs"]);
  assert.equal(validatePartners([]), null);
  assert.equal(validatePartners(["tt"]), null);
  assert.equal(validatePartners("mo"), null);
});

test("newTokenId is t_ + 10 base36 chars", () => {
  assert.match(newTokenId(), /^t_[a-z0-9]{10}$/);
  assert.notEqual(newTokenId(), newTokenId());
});

// ---- sanitize --------------------------------------------------------------------------------

test("sanitizeRegistry: shape-guards a corrupt row, keeps valid entries, drops dangling slot ids", () => {
  const reg = sanitizeRegistry({
    v: 1,
    tokens: [
      { ...entry(), id: "t_abcdefghij" },
      { id: "bad id", label: "x", sealed: "v1.a.b.c", fp: "f", partners: ["mo"] }, // bad id → dropped
      { id: "t_kkkkkkkkkk", label: "", sealed: "v1.a.b.c", fp: "f2", partners: ["hs"] }, // empty label → dropped
      { id: "t_zzzzzzzzzz", label: "Nopartner", sealed: "v1", fp: "f3", partners: [] }, // no partner → dropped
      "junk",
    ],
    slots: { "mo.launch": ["t_abcdefghij", "ghost", "t_abcdefghij"], "hs.launch": "not-a-list", bogus: ["x"] },
    events: [{ at: 1, by: "n", kind: "add", text: "ok" }, { kind: "??" }],
  });
  assert.equal(reg.tokens.length, 1);
  assert.equal(reg.tokens[0].id, "t_abcdefghij");
  assert.deepEqual(reg.slots["mo.launch"], ["t_abcdefghij"]); // dangling + dup dropped
  assert.deepEqual(reg.slots["hs.launch"], []);
  assert.deepEqual(Object.keys(reg.slots).sort(), [...SLOT_IDS].sort());
  assert.equal(reg.events.length, 1);
  // env ids survive in slots (they are validated against the live seeds, not the token list)
  const reg2 = sanitizeRegistry({ v: 1, tokens: [], slots: { "aif.clone": ["env:FB_AIF_LAUNCH_TOKEN"] } });
  assert.deepEqual(reg2.slots["aif.clone"], ["env:FB_AIF_LAUNCH_TOKEN"]);
  assert.deepEqual(sanitizeRegistry(null), emptyRegistry());
});

// ---- env seeds -------------------------------------------------------------------------------

test("parseMoSocTokensEnv: valid names only, dedupe, malformed json = none", () => {
  const raw = JSON.stringify([
    { name: "aleph", token: "EAAB-test" },
    { name: "Harvmo", token: "EAAY-test", system: true },
    { name: "bad name!", token: "x" },
    { name: "aleph", token: "dup" },
    { name: "notoken" },
  ]);
  assert.deepEqual(parseMoSocTokensEnv(raw), [
    { name: "aleph", token: "EAAB-test", system: false },
    { name: "Harvmo", token: "EAAY-test", system: true },
  ]);
  assert.deepEqual(parseMoSocTokensEnv("{oops"), []);
  assert.deepEqual(parseMoSocTokensEnv(undefined), []);
});

const ENV = {
  FB_MO_SOC_TOKENS: JSON.stringify([
    { name: "MO-1", token: "EAAmo1" },
    { name: "Harvmo", token: "EAAharv", system: true },
  ]),
  FB_LAUNCH_TOKEN: "EAAlegacy",
  FB_AIF_LAUNCH_TOKEN: "EAAaif",
  FB_HS_LAUNCH_TOKEN: "EAAhs1",
  FB_HS_LAUNCH_TOKEN_2: "EAAhs2",
  FB_HS_LAUNCH_TOKEN_3: "EAAhs1", // duplicate bearer → collapsed
  FB_HS_DUP_TOKEN: "EAAdup",
};

test("envSeeds: every env bearer becomes a read-only seed with the right partner tag", () => {
  const seeds = envSeeds(ENV, fp);
  const ids = seeds.map((s) => s.id);
  assert.deepEqual(ids, [
    "env:mo-soc:MO-1",
    "env:mo-soc:Harvmo",
    "env:FB_LAUNCH_TOKEN",
    "env:FB_AIF_LAUNCH_TOKEN",
    "env:FB_HS_LAUNCH_TOKEN",
    "env:FB_HS_LAUNCH_TOKEN_2",
    "env:FB_HS_DUP_TOKEN",
  ]);
  const harv = seeds.find((s) => s.id === "env:mo-soc:Harvmo")!;
  assert.equal(harv.personal, false);
  assert.deepEqual(harv.partners, ["mo"]);
  assert.equal(seeds.find((s) => s.id === "env:mo-soc:MO-1")!.personal, true);
  assert.deepEqual(seeds.find((s) => s.id === "env:FB_HS_DUP_TOKEN")!.partners, ["hs"]);
  // FB_HS_VOLUME_TOKEN stands in for T1 when the launch var is absent (legacy pool rule)
  const alt = envSeeds({ FB_HS_VOLUME_TOKEN: "EAAvol" }, fp);
  assert.deepEqual(alt.map((s) => s.id), ["env:FB_HS_LAUNCH_TOKEN"]);
  assert.deepEqual(envSeeds({}, fp), []);
});

test("envDefaultIds: today's per-rail defaults (MO system-class first; HS dup falls back to the pool)", () => {
  const seeds = envSeeds(ENV, fp);
  assert.deepEqual(envDefaultIds(seeds, "mo.launch"), ["env:mo-soc:Harvmo"]);
  assert.deepEqual(envDefaultIds(seeds, "mo.clone"), ["env:mo-soc:Harvmo"]);
  assert.deepEqual(envDefaultIds(seeds, "aif.launch"), ["env:FB_AIF_LAUNCH_TOKEN"]);
  assert.deepEqual(envDefaultIds(seeds, "hs.launch"), ["env:FB_HS_LAUNCH_TOKEN", "env:FB_HS_LAUNCH_TOKEN_2"]);
  assert.deepEqual(envDefaultIds(seeds, "hs.clone"), ["env:FB_HS_DUP_TOKEN"]);
  const noDup = envSeeds({ ...ENV, FB_HS_DUP_TOKEN: "" }, fp);
  assert.deepEqual(envDefaultIds(noDup, "hs.clone"), ["env:FB_HS_LAUNCH_TOKEN", "env:FB_HS_LAUNCH_TOKEN_2"]);
  // no soc at all → MO has NO default (the legacy launch token never signs MO by default: retired 09-08)
  const noSoc = envSeeds({ FB_LAUNCH_TOKEN: "EAAlegacy" }, fp);
  assert.deepEqual(envDefaultIds(noSoc, "mo.launch"), []);
  // first soc when no system-class entry
  const firstSoc = envSeeds({ FB_MO_SOC_TOKENS: JSON.stringify([{ name: "a", token: "1" }, { name: "b", token: "2" }]) }, fp);
  assert.deepEqual(envDefaultIds(firstSoc, "mo.clone"), ["env:mo-soc:a"]);
});

// ---- reducers --------------------------------------------------------------------------------

test("addToken: stores, refuses duplicate fingerprints (registry AND env) and duplicate labels", () => {
  const seeds = envSeeds(ENV, fp);
  const r1 = addToken(emptyRegistry(), { ...entry(), fp: "fp-new" }, "t_aaaaaaaaaa", seeds, NOW);
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.equal(r1.reg.tokens.length, 1);
  assert.equal(r1.reg.tokens[0].id, "t_aaaaaaaaaa");
  assert.equal(r1.reg.events[0].kind, "add");
  assert.equal(r1.reg.updatedBy, "nazar");
  const dupFp = addToken(r1.reg, { ...entry({ label: "Other" }), fp: "fp-new" }, "t_bbbbbbbbbb", seeds, NOW);
  assert.ok(!dupFp.ok && /already in the vault/.test(dupFp.error));
  const dupEnv = addToken(r1.reg, { ...entry({ label: "Other2" }), fp: fp("EAAharv") }, "t_cccccccccc", seeds, NOW);
  assert.ok(!dupEnv.ok && /Vercel env/.test(dupEnv.error));
  const dupLabel = addToken(r1.reg, { ...entry(), fp: "fp-other" }, "t_dddddddddd", seeds, NOW);
  assert.ok(!dupLabel.ok && /label/.test(dupLabel.error));
});

test("setSlot: eligibility by partner tag, dedupe, single-token rails, env ids allowed, pools keep order", () => {
  const seeds = envSeeds(ENV, fp);
  let reg = emptyRegistry();
  const a = addToken(reg, { ...entry({ label: "MoTok" }), fp: "f-a", partners: ["mo", "aif"] }, "t_aaaaaaaaaa", seeds, NOW);
  const h1 = addToken((a as { reg: typeof reg }).reg, { ...entry({ label: "HS one" }), fp: "f-h1", partners: ["hs"] }, "t_hhhhhhhhh1", seeds, NOW);
  const h2 = addToken((h1 as { reg: typeof reg }).reg, { ...entry({ label: "HS two" }), fp: "f-h2", partners: ["hs"] }, "t_hhhhhhhhh2", seeds, NOW);
  reg = (h2 as { reg: typeof reg }).reg;
  const assignables = [...reg.tokens, ...seeds];

  const ok = setSlot(reg, "mo.launch", ["t_aaaaaaaaaa"], assignables, "nazar", NOW);
  assert.ok(ok.ok);
  reg = (ok as { reg: typeof reg }).reg;
  assert.deepEqual(reg.slots["mo.launch"], ["t_aaaaaaaaaa"]);
  assert.equal(reg.events[0].kind, "assign");

  const wrongPartner = setSlot(reg, "hs.launch", ["t_aaaaaaaaaa"], assignables, "nazar", NOW);
  assert.ok(!wrongPartner.ok && /not tagged for HS/.test(wrongPartner.error));
  const ghost = setSlot(reg, "mo.clone", ["t_ghostghost"], assignables, "nazar", NOW);
  assert.ok(!ghost.ok && /unknown token/.test(ghost.error));
  const two = setSlot(reg, "aif.launch", ["t_aaaaaaaaaa", "env:FB_AIF_LAUNCH_TOKEN"], assignables, "nazar", NOW);
  assert.ok(!two.ok && /one token/.test(two.error));

  const envOk = setSlot(reg, "aif.clone", ["env:FB_AIF_LAUNCH_TOKEN"], assignables, "nazar", NOW);
  assert.ok(envOk.ok);
  const pool = setSlot(reg, "hs.launch", ["t_hhhhhhhhh2", "t_hhhhhhhhh1", "t_hhhhhhhhh2", "env:FB_HS_DUP_TOKEN"], assignables, "nazar", NOW);
  assert.ok(pool.ok);
  if (pool.ok) assert.deepEqual(pool.reg.slots["hs.launch"], ["t_hhhhhhhhh2", "t_hhhhhhhhh1", "env:FB_HS_DUP_TOKEN"]);

  // clearing a slot is fine (back to the env default)
  const cleared = setSlot(reg, "mo.launch", [], assignables, "nazar", NOW);
  assert.ok(cleared.ok && cleared.reg.slots["mo.launch"].length === 0);
  const badSlot = setSlot(reg, "tt.launch" as never, [], assignables, "nazar", NOW);
  assert.ok(!badSlot.ok);
});

test("removeToken clears every slot it sat in and reports them; unknown id errors", () => {
  const seeds = envSeeds(ENV, fp);
  let reg = emptyRegistry();
  reg = (addToken(reg, { ...entry(), fp: "f-a", partners: ["mo", "hs"] }, "t_aaaaaaaaaa", seeds, NOW) as { reg: typeof reg }).reg;
  const assignables = [...reg.tokens, ...seeds];
  reg = (setSlot(reg, "mo.launch", ["t_aaaaaaaaaa"], assignables, "n", NOW) as { reg: typeof reg }).reg;
  reg = (setSlot(reg, "hs.clone", ["env:FB_HS_DUP_TOKEN", "t_aaaaaaaaaa"], assignables, "n", NOW) as { reg: typeof reg }).reg;
  const out = removeToken(reg, "t_aaaaaaaaaa", "nazar", NOW);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(out.removedFrom, ["mo.launch", "hs.clone"]);
  assert.equal(out.reg.tokens.length, 0);
  assert.deepEqual(out.reg.slots["mo.launch"], []);
  assert.deepEqual(out.reg.slots["hs.clone"], ["env:FB_HS_DUP_TOKEN"]);
  assert.equal(out.reg.events[0].kind, "remove");
  assert.ok(!removeToken(out.reg, "t_aaaaaaaaaa", "nazar", NOW).ok);
  assert.ok(!removeToken(out.reg, "env:FB_HS_DUP_TOKEN", "nazar", NOW).ok); // env seeds are not removable here
});

test("updateToken: label/partners/personal/note; dropping a partner tag unassigns that partner's slots", () => {
  const seeds = envSeeds(ENV, fp);
  let reg = emptyRegistry();
  reg = (addToken(reg, { ...entry(), fp: "f-a", partners: ["mo", "hs"] }, "t_aaaaaaaaaa", seeds, NOW) as { reg: typeof reg }).reg;
  reg = (addToken(reg, { ...entry({ label: "Second" }), fp: "f-b", partners: ["mo"] }, "t_bbbbbbbbbb", seeds, NOW) as { reg: typeof reg }).reg;
  const assignables = [...reg.tokens, ...seeds];
  reg = (setSlot(reg, "hs.launch", ["t_aaaaaaaaaa"], assignables, "n", NOW) as { reg: typeof reg }).reg;
  reg = (setSlot(reg, "mo.clone", ["t_aaaaaaaaaa"], assignables, "n", NOW) as { reg: typeof reg }).reg;
  const out = updateToken(reg, "t_aaaaaaaaaa", { partners: ["mo"], personal: true, note: "moved", label: "Harvmo 2" }, "nazar", NOW);
  assert.ok(out.ok);
  if (!out.ok) return;
  const t = out.reg.tokens[0];
  assert.deepEqual(t.partners, ["mo"]);
  assert.equal(t.personal, true);
  assert.equal(t.note, "moved");
  assert.equal(t.label, "Harvmo 2");
  assert.deepEqual(out.reg.slots["hs.launch"], []); // no longer HS-eligible → unassigned
  assert.deepEqual(out.reg.slots["mo.clone"], ["t_aaaaaaaaaa"]); // still MO
  // label collision with another token is refused
  assert.ok(!updateToken(out.reg, "t_aaaaaaaaaa", { label: "Second" }, "nazar", NOW).ok);
  assert.ok(!updateToken(out.reg, "t_zzzzzzzzzz", { note: "x" }, "nazar", NOW).ok);
});

test("setIdentity stores the probe result and stamps a recheck event", () => {
  const seeds = envSeeds(ENV, fp);
  let reg = emptyRegistry();
  reg = (addToken(reg, { ...entry(), fp: "f-a" }, "t_aaaaaaaaaa", seeds, NOW) as { reg: typeof reg }).reg;
  const ident = {
    ok: true,
    userId: "1",
    userName: "Harvmo",
    appId: "2",
    appName: "Harvey for AIF",
    expiresAt: 0,
    dataAccessExpiresAt: 0,
    scopes: ["ads_management"],
    accounts: 16,
    pages: 10,
    checkedAt: NOW,
  };
  const out = setIdentity(reg, "t_aaaaaaaaaa", ident, "nazar", NOW);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(out.reg.tokens[0].identity, ident);
  assert.equal(out.reg.events[0].kind, "recheck");
});

// ---- effective slot resolution ---------------------------------------------------------------

test("effectiveSlot: assigned wins; unassigned falls back to the env default; nothing = none", () => {
  const seeds = envSeeds(ENV, fp);
  let reg = emptyRegistry();
  reg = (addToken(reg, { ...entry(), fp: "f-a" }, "t_aaaaaaaaaa", seeds, NOW) as { reg: typeof reg }).reg;
  const assignables = [...reg.tokens, ...seeds];
  assert.deepEqual(effectiveSlot(reg, seeds, "mo.launch"), { ids: ["env:mo-soc:Harvmo"], source: "env" });
  reg = (setSlot(reg, "mo.launch", ["t_aaaaaaaaaa"], assignables, "n", NOW) as { reg: typeof reg }).reg;
  assert.deepEqual(effectiveSlot(reg, seeds, "mo.launch"), { ids: ["t_aaaaaaaaaa"], source: "assigned" });
  assert.deepEqual(effectiveSlot(reg, seeds, "mo.clone"), { ids: ["env:mo-soc:Harvmo"], source: "env" });
  assert.deepEqual(effectiveSlot(reg, envSeeds({}, fp), "aif.launch"), { ids: [], source: "none" });
  // an assigned env id that the env no longer provides → dropped → falls to the env default
  const stale = sanitizeRegistry({ v: 1, tokens: [], slots: { "hs.clone": ["env:FB_HS_DUP_TOKEN"] } });
  assert.deepEqual(effectiveSlot(stale, envSeeds({ FB_HS_LAUNCH_TOKEN: "EAAhs1" }, fp), "hs.clone"), {
    ids: ["env:FB_HS_LAUNCH_TOKEN"],
    source: "env",
  });
});
