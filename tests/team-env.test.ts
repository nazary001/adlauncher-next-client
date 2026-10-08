// The team is chosen by ONE env var read when lib/team.ts loads (NEXT_PUBLIC_ADL_TEAM — inlined by
// the build, a plain runtime read here). These tests load the real modules in a CHILD process per
// team, so they prove the wiring end to end: the session cookie, the store guard, the S3 owner tag.
// Run: node --test tests/team-env.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const lib = (name: string): string => JSON.stringify(pathToFileURL(`${ROOT}lib/${name}`).href);
const SECRET = "team-env-secret-0123456789-0123456789-abcdef";

/** Run a module script under a team's env and return what it printed as JSON. */
function under(team: string | null, script: string, env: Record<string, string> = {}): unknown {
  const childEnv: Record<string, string | undefined> = { ...process.env, AUTH_SECRET: SECRET, ...env };
  if (team === null) delete childEnv.NEXT_PUBLIC_ADL_TEAM;
  else childEnv.NEXT_PUBLIC_ADL_TEAM = team;
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: childEnv, encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "null");
}

const b64u = (s: string) => Buffer.from(s).toString("base64url");
/** A cookie exactly as lib/session signs one — built by hand so a payload WITHOUT a team can exist. */
function cookie(payload: Record<string, unknown>): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
}
const exp = Math.floor(Date.now() / 1000) + 3600;

const VERIFY = (token: string) => `
  const s = await import(${lib("session.ts")});
  const v = s.verifySession(${JSON.stringify(token)});
  console.log(JSON.stringify(v ? { username: v.username, team: v.team ?? null } : null));
`;
const SIGN = `
  const s = await import(${lib("session.ts")});
  const t = s.signSession({ sub: 1, username: "nazar", role: "owner" });
  console.log(JSON.stringify({ token: t, payload: JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()) }));
`;

test("every cookie a launcher mints carries its own team", () => {
  const first = under(null, SIGN) as { payload: { team: string } };
  const second = under("glo-02", SIGN) as { payload: { team: string } };
  assert.equal(first.payload.team, "glo-01");
  assert.equal(second.payload.team, "glo-02");
});

test("a cookie of one team is refused by the other team's launcher — even under the same secret", () => {
  const first = (under(null, SIGN) as { token: string }).token;
  const second = (under("glo-02", SIGN) as { token: string }).token;
  assert.deepEqual(under(null, VERIFY(first)), { username: "nazar", team: "glo-01" });
  assert.deepEqual(under("glo-02", VERIFY(second)), { username: "nazar", team: "glo-02" });
  assert.equal(under("glo-02", VERIFY(first)), null);
  assert.equal(under(null, VERIFY(second)), null);
  assert.equal(under("glo-01", VERIFY(second)), null);
});

test("a cookie signed before teams existed stays valid on glo-01 (nobody is logged out) and only there", () => {
  const legacy = cookie({ sub: 7, username: "tima", role: null, iat: exp - 7200, exp });
  assert.deepEqual(under(null, VERIFY(legacy)), { username: "tima", team: null });
  assert.deepEqual(under("glo-01", VERIFY(legacy)), { username: "tima", team: null });
  assert.equal(under("glo-02", VERIFY(legacy)), null);
});

test("renewal keeps the team — a renewed glo-02 cookie still verifies on glo-02", () => {
  const out = under(
    "glo-02",
    `
    const s = await import(${lib("session.ts")});
    const now = Math.floor(Date.now() / 1000);
    const old = { sub: 3, username: "kate", role: null, team: "glo-02", iat: now - 2 * 86400, exp: now - 2 * 86400 + s.SESSION_TTL_SEC };
    const r = s.renewedSessionToken(old, now);
    const v = r ? s.verifySession(r.token) : null;
    console.log(JSON.stringify({ renewed: Boolean(r), team: v?.team ?? null, username: v?.username ?? null }));
  `,
  );
  assert.deepEqual(out, { renewed: true, team: "glo-02", username: "kate" });
});

test("a team name that names no team stops the build's modules from loading at all", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `await import(${lib("team.ts")});`], {
    env: { ...process.env, NEXT_PUBLIC_ADL_TEAM: "glo-2" },
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /names no team/);
});

// lib/mongo.ts refuses BEFORE it connects, so a made-up URI is enough: nothing is ever dialled.
const GET_DB = `
  const m = await import(${lib("mongo.ts")});
  try { await m.getDb(); console.log(JSON.stringify("connected")); }
  catch (e) { console.log(JSON.stringify(String(e.message))); }
`;
const NO_DIAL = { MONGODB_URI: "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300&connectTimeoutMS=300" };

test("the store: glo-02 refuses the first team's database, glo-01 refuses glo-02's", () => {
  assert.match(String(under("glo-02", GET_DB, { ...NO_DIAL, MONGODB_DB: "gc" })), /is not the GLO-02 launcher's database/);
  assert.match(String(under("glo-02", GET_DB, { ...NO_DIAL, MONGODB_DB: "gc_test" })), /is not the GLO-02 launcher's database/);
  assert.match(String(under(null, GET_DB, { ...NO_DIAL, MONGODB_DB: "gc_glo02" })), /is not the GLO-01 launcher's database/);
  // (the right pairings are tests/team.test.ts teamAllowsDb — past the guard a call would dial out)
});

test("the creative store: glo-01's owner tag is the pre-team one, glo-02's is its own", () => {
  const TAG = `
    const c = await import(${lib("creative-store.ts")});
    console.log(JSON.stringify(c.creativeOwnerTag("alice")));
  `;
  const first = under(null, TAG);
  const second = under("glo-02", TAG);
  assert.equal(first, "c13e915dbcdb"); // sha256("creative-owner:alice").slice(0, 12) — the key every glo-01 object already carries
  assert.match(String(second), /^[0-9a-f]{12}$/);
  assert.notEqual(second, first);
});
