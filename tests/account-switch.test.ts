// Node's built-in runner (v24 strips types natively): `node --test tests/account-switch.test.ts`.
// Another account in the same browser (owner 12.10: "when another account signs in, it must reset").
// Two pure decisions are held here: which remembered keys a different account must not inherit
// (components/account-switch), and the session that keeps everything but its username when the owner
// renames a login (lib/session renamedSessionToken — what /api/auth/session re-issues).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "test-secret-0123456789-0123456789-abcdef";

const s = await import("../lib/session.ts");
const { LAST_USER_KEY, sharedMemoryKeys } = await import("../components/account-switch.ts");
const { TEAM } = await import("../lib/team.ts");

test("a different account forgets the browser's shared picks, keeps every buyer's own task fallback", () => {
  const keys = [
    "adlauncher.hs.channel",
    "adlauncher.mo.channel2",
    "adlauncher.aif.channel",
    "adlauncher.clone.in.channel",
    "adlauncher.hs.mode",
    "adlauncher.hs.dupchannel",
    "adlauncher.hs.jurochannel",
    "adlauncher.google.mode",
    "adlauncher.tiktok.mode",
    "adlauncher.tiktok.identities",
    "adlauncher.google.clone.wave",
    "adlauncher.tasks",
    "adlauncher.tasks.Katya",
    "adlauncher.hstasks.Katya_M",
    "adlauncher.aiftasks.Tima",
    "adlauncher.avtasks.Vlad YouTube",
    LAST_USER_KEY,
    "theme",
    "some.other.app",
  ];
  assert.deepEqual(sharedMemoryKeys(keys), [
    "adlauncher.hs.channel",
    "adlauncher.mo.channel2",
    "adlauncher.aif.channel",
    "adlauncher.clone.in.channel",
    "adlauncher.hs.mode",
    "adlauncher.hs.dupchannel",
    "adlauncher.hs.jurochannel",
    "adlauncher.google.mode",
    "adlauncher.tiktok.mode",
    "adlauncher.tiktok.identities",
    "adlauncher.google.clone.wave",
  ]);
  assert.deepEqual(sharedMemoryKeys([]), []);
});

test("a renamed login keeps its session — same sign-in time, same expiry, same id — under the new name", () => {
  const now = Math.floor(Date.now() / 1000);
  const old: s.Session = { sub: 21, username: "Katya_M", email: "k@x.y", role: "designer", team: "glo-01", iat: now - 3 * 86400, exp: now + 4 * 86400 };
  const { token, maxAge } = s.renamedSessionToken(old, "Devich", now);
  const v = s.verifySession(token);
  assert.ok(v);
  assert.equal(v.username, "Devich");
  assert.equal(v.sub, 21);
  assert.equal(v.role, "designer");
  assert.equal(v.email, "k@x.y");
  assert.equal(v.iat, old.iat);
  assert.equal(v.exp, old.exp);
  assert.equal(maxAge, 4 * 86400);
});

test("a renamed session is still this team's only", () => {
  const now = Math.floor(Date.now() / 1000);
  const old: s.Session = { sub: 21, username: "Katya_M", role: null, iat: now - 60, exp: now + 3600 };
  const { token } = s.renamedSessionToken(old, "Devich", now);
  assert.equal(s.verifySession(token)?.team, "glo-01");
  assert.equal(s.verifySession(token, { ...TEAM, id: "glo-02" }), null);
});
