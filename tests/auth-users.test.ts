// Node's built-in runner (v24 strips types natively): `node --test tests/auth-users.test.ts`.
// Login with LAZY PASSWORD MIGRATION (lib/auth-users): a migrated user has no bcrypt hash — the first
// login is verified by the old Strapi and the hash is stored; every later login is local. The decision
// is pure (deps injected); the live half (set-password + lookup + a real login) runs on gc_test.
import { HAVE_DB, RUN, closeDb, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { compare, hash } from "bcryptjs";

const auth = await import("../lib/auth-users.ts");
type AppUser = import("../lib/auth-users.ts").AppUser;
type AuthDeps = import("../lib/auth-users.ts").AuthDeps;

const user = (extra: Partial<AppUser> = {}): AppUser => ({
  id: 7,
  documentId: "d7",
  username: "Tima",
  email: "tima@example.com",
  app_role: "designer",
  blocked: false,
  password: null,
  ...extra,
});

function deps(over: Partial<AuthDeps> & { stored?: string[] } = {}): AuthDeps & { stored: string[] } {
  const stored: string[] = over.stored ?? [];
  return {
    findUser: over.findUser ?? (async () => user()),
    verifyHash: over.verifyHash ?? ((pw, h) => compare(pw, h)),
    hashPassword: over.hashPassword ?? ((pw) => hash(pw, 4)), // cost 4 keeps the suite fast; prod uses 10
    storeHash:
      over.storeHash ??
      (async (_u, h) => {
        stored.push(h);
      }),
    legacyLogin: "legacyLogin" in over ? (over.legacyLogin ?? null) : async () => "ok",
    stored,
  };
}

test("a user with a hash is verified locally — right password in, wrong password out, Strapi never asked", async () => {
  const h = await hash("secret-1", 4);
  let asked = 0;
  const d = deps({
    findUser: async () => user({ password: h }),
    legacyLogin: async () => {
      asked++;
      return "ok";
    },
  });
  const good = await auth.authenticateWith("Tima", "secret-1", d);
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.migrated, false);
    assert.equal(good.user.username, "Tima");
  }
  const bad = await auth.authenticateWith("Tima", "nope", d);
  assert.deepEqual(bad, { ok: false, reason: "invalid" });
  assert.equal(asked, 0);
  assert.equal(d.stored.length, 0);
});

test("no hash + Strapi says ok → the password is bcrypt-hashed, stored, and the login succeeds (migrated)", async () => {
  const d = deps();
  const res = await auth.authenticateWith("Tima", "secret-2", d);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.migrated, true);
  assert.equal(d.stored.length, 1);
  assert.match(d.stored[0], /^\$2[aby]\$/);
  assert.equal(await compare("secret-2", d.stored[0]), true, "the stored hash verifies the password");
  // From now on the user has a hash → the next login is local.
  const next = await auth.authenticateWith("Tima", "secret-2", deps({ findUser: async () => user({ password: d.stored[0] }), legacyLogin: null }));
  assert.equal(next.ok, true);
});

test("no hash + Strapi refuses → invalid (nothing stored); Strapi down → unavailable, never invalid", async () => {
  const refused = deps({ legacyLogin: async () => "invalid" });
  assert.deepEqual(await auth.authenticateWith("Tima", "x", refused), { ok: false, reason: "invalid" });
  assert.equal(refused.stored.length, 0);
  const down = deps({ legacyLogin: async () => "unavailable" });
  assert.deepEqual(await auth.authenticateWith("Tima", "x", down), { ok: false, reason: "unavailable" });
  const noFallback = deps({ legacyLogin: null });
  assert.deepEqual(await auth.authenticateWith("Tima", "x", noFallback), { ok: false, reason: "unavailable" });
});

test("a store failure on the hash write does not fail a login Strapi approved (the next login migrates again)", async () => {
  const d = deps({
    storeHash: async () => {
      throw new Error("write timeout");
    },
  });
  const res = await auth.authenticateWith("Tima", "secret-3", d);
  assert.equal(res.ok, true);
});

test("blocked users are refused before any password check; unknown users are invalid; a failed lookup is unavailable", async () => {
  let verified = 0;
  const blocked = deps({
    findUser: async () => user({ blocked: true, password: "$2a$04$x" }),
    verifyHash: async () => {
      verified++;
      return true;
    },
  });
  assert.deepEqual(await auth.authenticateWith("Tima", "x", blocked), { ok: false, reason: "blocked" });
  assert.equal(verified, 0);
  assert.deepEqual(await auth.authenticateWith("nobody", "x", deps({ findUser: async () => null })), { ok: false, reason: "invalid" });
  assert.deepEqual(
    await auth.authenticateWith("Tima", "x", deps({ findUser: async () => Promise.reject(new Error("server selection timed out")) })),
    { ok: false, reason: "unavailable" },
  );
});

test("legacyStrapiLogin maps the old /api/auth/local answers: 2xx+user → ok, 4xx → invalid, 5xx/network → unavailable", async () => {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  const stub = (status: number, body: unknown) => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };
  try {
    const login = auth.legacyStrapiLogin("https://tools.test/");
    stub(200, { jwt: "x", user: { id: 1, username: "Tima" } });
    assert.equal(await login("Tima", "pw"), "ok");
    assert.equal(calls[0].url, "https://tools.test/api/auth/local");
    assert.deepEqual(calls[0].body, { identifier: "Tima", password: "pw" });
    stub(400, { error: { message: "Invalid identifier or password" } });
    assert.equal(await login("Tima", "pw"), "invalid");
    stub(503, {});
    assert.equal(await login("Tima", "pw"), "unavailable");
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal(await login("Tima", "pw"), "unavailable");
  } finally {
    globalThis.fetch = real;
  }
});

// ---- live: set-password + lookup + a real local login on gc_test ----

test("live: setUserPassword stores a cost-10 bcrypt hash; the lookup matches exact username or lower-cased e-mail; authenticateUser logs in locally", { skip: !HAVE_DB && "MONGODB_URI not set" }, async () => {
  await ensureTestIndexes();
  const { insertFresh } = await import("../lib/store.ts");
  const username = `User_${RUN}`;
  const email = `${RUN}@example.com`;
  await wipe("up_users", { username });
  await insertFresh("up_users", { username, email, provider: "local", confirmed: true, blocked: false, app_role: "designer", role: null, source: "tools" });
  try {
    assert.equal(await auth.setUserPassword(username, "pw-live-1"), true);
    assert.equal(await auth.setUserPassword(`nobody_${RUN}`, "pw-live-1"), false);
    const byName = await auth.findUserByIdentifier(username);
    assert.equal(byName?.username, username);
    assert.match(String(byName?.password), /^\$2[aby]\$10\$/);
    const byEmail = await auth.findUserByIdentifier(email.toUpperCase());
    assert.equal(byEmail?.documentId, byName?.documentId, "e-mail is compared lower-cased, as Strapi did");
    assert.equal(await auth.findUserByIdentifier(username.toLowerCase()), null, "username is exact, as Strapi did");
    const res = await auth.authenticateUser(username, "pw-live-1");
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.migrated, false);
      assert.equal(res.user.app_role, "designer");
      assert.equal(typeof res.user.id, "number");
    }
    assert.deepEqual(await auth.authenticateUser(username, "wrong"), { ok: false, reason: "invalid" });
  } finally {
    await wipe("up_users", { username });
  }
});

after(async () => {
  await closeDb();
});
