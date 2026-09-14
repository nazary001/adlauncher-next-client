// Node's built-in runner (v24 strips types natively): `node --test tests/fb-token-vault.test.ts`.
// Excluded from the app's tsconfig — the explicit .ts import below is a Node requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openToken, sealToken, tokenFingerprint, vaultKey } from "../lib/fb-token-vault.ts";

const SECRET = "x".repeat(40);
const OTHER = "y".repeat(40);
const TOKEN = "EAAB" + "a1b2c3d4".repeat(24);

test("vaultKey: derives a 32-byte key from a strong secret, refuses a weak one", () => {
  const k = vaultKey(SECRET);
  assert.ok(k && k.length === 32);
  assert.equal(vaultKey("short"), null);
  assert.equal(vaultKey(""), null);
  // deterministic: same secret → same key (decrypt after a cold start must work)
  assert.deepEqual(vaultKey(SECRET), k);
  assert.notDeepEqual(vaultKey(OTHER), k);
});

test("seal/open: round-trips, randomizes per call, refuses tampering and foreign keys", () => {
  const k = vaultKey(SECRET)!;
  const s1 = sealToken(TOKEN, k);
  const s2 = sealToken(TOKEN, k);
  assert.ok(s1.startsWith("v1."));
  assert.notEqual(s1, s2); // fresh IV every time — equal tokens must not look equal at rest
  assert.ok(!s1.includes(TOKEN.slice(0, 20)));
  assert.equal(openToken(s1, k), TOKEN);
  assert.equal(openToken(s2, k), TOKEN);
  // wrong key → null (never garbage)
  assert.equal(openToken(s1, vaultKey(OTHER)!), null);
  // tampered ciphertext / malformed envelope → null
  const parts = s1.split(".");
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
  assert.equal(openToken(parts.join("."), k), null);
  assert.equal(openToken("v1.garbage", k), null);
  assert.equal(openToken("", k), null);
  assert.equal(openToken("v2.a.b.c", k), null);
});

test("tokenFingerprint: stable 12-hex prefix, differs per token", () => {
  const fp = tokenFingerprint(TOKEN);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(tokenFingerprint(TOKEN), fp);
  assert.notEqual(tokenFingerprint(TOKEN + "x"), fp);
});
