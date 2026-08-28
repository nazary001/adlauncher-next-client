// Node's built-in runner (v24 strips types natively): `node --test tests/mo-soc.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MO_SOC_MARK, moEnsureSocMark } from "../lib/types.ts";

// ---- the MO soc name marker (soc-born runs must be tellable apart in name-only lists) --------

test("prefix-shaped names get the marker between prefix and tail", () => {
  assert.equal(moEnsureSocMark("[28/08] (MO) - Nazar"), "[28/08] (MO) - SOC - Nazar");
  // dot-dated legacy prefixes keep working too
  assert.equal(moEnsureSocMark("[28.08] (t1) - wave 3"), "[28.08] (t1) - SOC - wave 3");
});

test("already-marked names pass through untouched (no double-apply)", () => {
  const marked = "[28/08] (MO) - SOC - Nazar";
  assert.equal(moEnsureSocMark(marked), marked);
});

test("grammar-less names get the marker prepended", () => {
  assert.equal(moEnsureSocMark("manual relaunch"), `${MO_SOC_MARK}manual relaunch`);
});

// ---- the soc channel registry (env-driven; parsed once at import) ----------------------------

test("resolveMoChannel: system default, provisioned soc, system-class entry, unknown soc", async () => {
  process.env.FB_MO_SOC_TOKENS = JSON.stringify([
    { name: "aleph", token: "EAAB-test" },
    { name: "Spencermo", token: "EAAY-test", system: true }, // alternate system user
    { name: "bad name!", token: "x" }, // invalid label → dropped
    { name: "aleph", token: "dup" }, // duplicate → dropped
  ]);
  const { moSocNames, resolveMoChannel } = await import("../lib/mo-soc.ts");
  assert.deepEqual(moSocNames(), ["aleph", "Spencermo"]);
  assert.deepEqual(resolveMoChannel(undefined), { kind: "system" });
  assert.deepEqual(resolveMoChannel("system"), { kind: "system" });
  const soc = resolveMoChannel("soc:aleph");
  assert.equal(soc?.kind, "soc");
  if (soc?.kind === "soc") {
    assert.equal(soc.name, "aleph");
    assert.equal(soc.token, "EAAB-test");
    assert.equal(soc.sys, false); // соц-class → launch route applies the SOC name marker
    assert.equal(soc.cat.cacheKey, "mo-soc-aleph");
  }
  // system:true rides through as sys — the launch route skips the SOC marker and notes `sys:`.
  const sys = resolveMoChannel("soc:Spencermo");
  assert.equal(sys?.kind, "soc");
  if (sys?.kind === "soc") {
    assert.equal(sys.sys, true);
    assert.equal(sys.cat.cacheKey, "mo-soc-Spencermo");
  }
  // A soc this server does not carry resolves to null — the route then errors instead of
  // silently launching on the system token the buyer was routing around.
  assert.equal(resolveMoChannel("soc:ghost"), null);
  assert.equal(resolveMoChannel("lion"), null);
});
