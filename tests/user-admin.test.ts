// `node --test tests/user-admin.test.ts` — owners manage the team's logins from the launcher (owner ask
// 20.10: "роль овнер могла управлять акаунтами, например добавлять новый акаунт дизайнера или овнера
// или же удалять или редактировать"). lib/user-admin: what a login may be called / its password / its
// e-mail / its role (pure), what an owner may NOT do to a login (pure — never lock the team out), and
// the store operations on `up_users` and everything filed under a login's name (live, gc_test only).
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compare } from "bcryptjs";

const ua = await import("../lib/user-admin.ts");
type Roster = import("../lib/user-admin.ts").RosterEntry;

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };

before(async () => {
  if (HAVE_DB) await ensureTestIndexes();
});
after(closeDb);

// ---- pure: the fields ---------------------------------------------------------------------------

test("checkUsername: trimmed; required; at most 60; no '@' (it would read as an e-mail at sign-in), no control characters; spaces inside and any alphabet are fine", () => {
  assert.deepEqual(ua.checkUsername("  Korsun "), { ok: true, value: "Korsun" });
  assert.deepEqual(ua.checkUsername("Vlad YouTube"), { ok: true, value: "Vlad YouTube" });
  assert.deepEqual(ua.checkUsername("Тарас_2"), { ok: true, value: "Тарас_2" });
  assert.deepEqual(ua.checkUsername("Katya_M"), { ok: true, value: "Katya_M" });
  assert.deepEqual(ua.checkUsername(""), { ok: false, error: "username_required" });
  assert.deepEqual(ua.checkUsername("   "), { ok: false, error: "username_required" });
  assert.deepEqual(ua.checkUsername(undefined), { ok: false, error: "username_required" });
  assert.deepEqual(ua.checkUsername(42), { ok: false, error: "username_required" });
  assert.deepEqual(ua.checkUsername("a".repeat(61)), { ok: false, error: "username_too_long" });
  assert.deepEqual(ua.checkUsername("a".repeat(60)), { ok: true, value: "a".repeat(60) });
  assert.deepEqual(ua.checkUsername("nick@glo"), { ok: false, error: "username_invalid" });
  assert.deepEqual(ua.checkUsername("Nick\tX"), { ok: false, error: "username_invalid" });
  assert.deepEqual(ua.checkUsername("Nick\u0000"), { ok: false, error: "username_invalid" });
});

test("checkPassword: trimmed like the login trims it; 6..72 characters (bcrypt reads 72 bytes at most)", () => {
  assert.deepEqual(ua.checkPassword(" ys8VfLReqQDNypj "), { ok: true, value: "ys8VfLReqQDNypj" });
  assert.deepEqual(ua.checkPassword("123456"), { ok: true, value: "123456" });
  assert.deepEqual(ua.checkPassword("12345"), { ok: false, error: "password_too_short" });
  assert.deepEqual(ua.checkPassword("x".repeat(73)), { ok: false, error: "password_too_long" });
  assert.deepEqual(ua.checkPassword("ж".repeat(37)), { ok: false, error: "password_too_long" }, "72 BYTES, not characters");
  assert.deepEqual(ua.checkPassword(undefined), { ok: false, error: "password_required" });
  assert.deepEqual(ua.checkPassword(""), { ok: false, error: "password_required" });
});

test("checkEmail: optional (empty → null); lower-cased; must look like an address", () => {
  assert.deepEqual(ua.checkEmail(""), { ok: true, value: null });
  assert.deepEqual(ua.checkEmail(null), { ok: true, value: null });
  assert.deepEqual(ua.checkEmail(undefined), { ok: true, value: null });
  assert.deepEqual(ua.checkEmail(" Nick@GlobeCoders.net "), { ok: true, value: "nick@globecoders.net" });
  assert.deepEqual(ua.checkEmail("nick"), { ok: false, error: "email_invalid" });
  assert.deepEqual(ua.checkEmail("a b@c.de"), { ok: false, error: "email_invalid" });
  assert.deepEqual(ua.checkEmail(`${"a".repeat(250)}@x.io`), { ok: false, error: "email_invalid" });
});

test("checkRole: owner or designer (any case); nothing else is handed out from the launcher", () => {
  assert.deepEqual(ua.checkRole("owner"), { ok: true, value: "owner" });
  assert.deepEqual(ua.checkRole(" Designer "), { ok: true, value: "designer" });
  assert.deepEqual(ua.checkRole("admin"), { ok: false, error: "role_invalid" });
  assert.deepEqual(ua.checkRole(undefined), { ok: false, error: "role_invalid" });
});

test("parseNewUser: name + password + role (designer when not given) + optional e-mail; the first problem is named", () => {
  assert.deepEqual(ua.parseNewUser({ username: " Korsun", password: "ys8VfLReqQDNypj", role: "designer" }), {
    ok: true,
    input: { username: "Korsun", password: "ys8VfLReqQDNypj", role: "designer", email: null },
  });
  assert.deepEqual(ua.parseNewUser({ username: "Nick", password: "secret1", email: "N@x.io" }), {
    ok: true,
    input: { username: "Nick", password: "secret1", role: "designer", email: "n@x.io" },
  });
  assert.deepEqual(ua.parseNewUser({ username: "Nick", password: "123" }), { ok: false, error: "password_too_short" });
  assert.deepEqual(ua.parseNewUser({ password: "secret1" }), { ok: false, error: "username_required" });
  assert.deepEqual(ua.parseNewUser({ username: "Nick", password: "secret1", role: "root" }), { ok: false, error: "role_invalid" });
  assert.deepEqual(ua.parseNewUser(null), { ok: false, error: "username_required" });
});

test("parseUserPatch: only what is sent changes; an empty password means 'keep it'; an empty e-mail clears it; nothing at all is refused", () => {
  assert.deepEqual(ua.parseUserPatch({ role: "owner" }), { ok: true, patch: { role: "owner" } });
  assert.deepEqual(ua.parseUserPatch({ username: "Tarass ", password: "", blocked: true }), { ok: true, patch: { username: "Tarass", blocked: true } });
  assert.deepEqual(ua.parseUserPatch({ password: " newpass1 " }), { ok: true, patch: { password: "newpass1" } });
  assert.deepEqual(ua.parseUserPatch({ email: "" }), { ok: true, patch: { email: null } });
  assert.deepEqual(ua.parseUserPatch({ signOutEverywhere: true }), { ok: true, patch: { signOutEverywhere: true } });
  assert.deepEqual(ua.parseUserPatch({}), { ok: false, error: "nothing_to_change" });
  assert.deepEqual(ua.parseUserPatch({ password: "" }), { ok: false, error: "nothing_to_change" });
  assert.deepEqual(ua.parseUserPatch(null), { ok: false, error: "nothing_to_change" });
  assert.deepEqual(ua.parseUserPatch({ blocked: "yes" }), { ok: false, error: "blocked_invalid" });
  assert.deepEqual(ua.parseUserPatch({ username: "a@b" }), { ok: false, error: "username_invalid" });
  assert.deepEqual(ua.parseUserPatch({ password: "123" }), { ok: false, error: "password_too_short" });
});

test("placeholderEmail: the same address scripts/add-user.mjs gives a login nobody typed an e-mail for", () => {
  const tag = (u: string) => createHash("sha256").update(u).digest("hex").slice(0, 6);
  assert.equal(ua.placeholderEmail("Korsun", "glo-02"), `korsun.${tag("Korsun")}@glo-02.adlauncher.local`);
  assert.equal(ua.placeholderEmail("Vlad YouTube", "glo-01"), `vlad.youtube.${tag("Vlad YouTube")}@glo-01.adlauncher.local`);
  assert.equal(ua.placeholderEmail("Тарас", "glo-02"), `user.${tag("Тарас")}@glo-02.adlauncher.local`);
  assert.notEqual(ua.placeholderEmail("Alex", "glo-01"), ua.placeholderEmail("alex", "glo-01"));
  assert.equal(ua.isPlaceholderEmail(ua.placeholderEmail("Nick", "glo-02")), true);
  assert.equal(ua.isPlaceholderEmail("nick@globecoders.net"), false);
  assert.equal(ua.isPlaceholderEmail(null), false);
});

// ---- pure: what an owner may not do -------------------------------------------------------------

const roster: Roster[] = [
  { id: 1, username: "Boss", role: "owner", blocked: false },
  { id: 2, username: "Nick", role: "owner", blocked: false },
  { id: 3, username: "Bogdan", role: "designer", blocked: false },
  { id: 4, username: "Old", role: "owner", blocked: true },
];
const by = (id: number) => roster.find((r) => r.id === id)!;

test("adminRefusal: an owner never deletes, blocks or demotes their own login, nor signs it out everywhere", () => {
  const me = { id: 1, username: "Boss" }; // not "Nazar": .env.local names Nazar in ADL_OWNER_USERS
  assert.equal(ua.adminRefusal(me, by(1), { delete: true }, roster), "self_delete");
  assert.equal(ua.adminRefusal(me, by(1), { blocked: true }, roster), "self_block");
  assert.equal(ua.adminRefusal(me, by(1), { role: "designer" }, roster), "self_demote");
  assert.equal(ua.adminRefusal(me, by(1), { signOutEverywhere: true }, roster), "self_sign_out");
  // their own name, password, e-mail — and "owner" again — are fine
  assert.equal(ua.adminRefusal(me, by(1), { role: "owner", password: "x", username: "Naz", email: null }, roster), null);
});

test("adminRefusal: other logins — owners and designers alike — are the owner's to change", () => {
  const me = { id: 1, username: "Boss" }; // not "Nazar": .env.local names Nazar in ADL_OWNER_USERS
  assert.equal(ua.adminRefusal(me, by(2), { delete: true }, roster), null);
  assert.equal(ua.adminRefusal(me, by(2), { role: "designer" }, roster), null);
  assert.equal(ua.adminRefusal(me, by(2), { blocked: true }, roster), null);
  assert.equal(ua.adminRefusal(me, by(3), { role: "owner" }, roster), null);
  assert.equal(ua.adminRefusal(me, by(3), { delete: true }, roster), null);
  assert.equal(ua.adminRefusal(me, by(4), { blocked: false }, roster), null);
});

test("adminRefusal: the team always keeps one active owner (a blocked owner does not count)", () => {
  const two: Roster[] = [
    { id: 1, username: "Env", role: "designer", blocked: false }, // owner through ADL_OWNER_USERS only
    { id: 2, username: "Nick", role: "owner", blocked: false },
    { id: 4, username: "Old", role: "owner", blocked: true },
  ];
  const me = { id: 1, username: "Env" };
  assert.equal(ua.adminRefusal(me, two[1], { delete: true }, two), "last_owner");
  assert.equal(ua.adminRefusal(me, two[1], { role: "designer" }, two), "last_owner");
  assert.equal(ua.adminRefusal(me, two[1], { blocked: true }, two), "last_owner");
  assert.equal(ua.adminRefusal(me, two[1], { password: "x" }, two), null);
  assert.equal(ua.adminRefusal(me, two[2], { delete: true }, two), null, "removing a blocked owner leaves the active one");
});

// ---- pure: the account assignments follow the login --------------------------------------------

test("renameInAssignments / dropFromAssignments: the name is matched without letter case; a list left empty frees the account", () => {
  const accounts = { "111": ["Taras", "Nick"], "222": ["taras"], "333": ["Nick"], "444": ["Tarass", "Taras"] };
  assert.deepEqual(ua.renameInAssignments(accounts, "Taras", "Tarass"), {
    accounts: { "111": ["Tarass", "Nick"], "222": ["Tarass"], "333": ["Nick"], "444": ["Tarass"] },
    touched: 3,
  });
  assert.deepEqual(ua.dropFromAssignments(accounts, "TARAS"), {
    accounts: { "111": ["Nick"], "333": ["Nick"], "444": ["Tarass"] },
    touched: 3,
    freed: 1,
  });
  assert.deepEqual(ua.dropFromAssignments({ "1": ["A"] }, "B"), { accounts: { "1": ["A"] }, touched: 0, freed: 0 });
});

// ---- live (gc_test) -------------------------------------------------------------------------------

const ASSIGN_KEY = "fb-acct-assignments";

test("live: create → listed (placeholder e-mail hidden) → a taken name in any letter case or a former name is refused → edit role / password / e-mail / block → sign out everywhere", live, async () => {
  const users = await col("up_users");
  const name = `Ua_${RUN}`;
  await wipe("up_users", { username: { $regex: `^ua_${RUN}`, $options: "i" } });
  try {
    const made = await ua.createManagedUser({ username: name, password: "first-pass", role: "designer", email: null }, "Nazar");
    assert.equal(made.ok, true);
    if (!made.ok) return;
    assert.equal(made.user.username, name);
    assert.equal(made.user.role, "designer");
    assert.equal(made.user.email, null, "a placeholder e-mail is not shown");
    assert.equal(made.user.hasPassword, true);
    assert.equal(made.user.createdBy, "Nazar");
    const doc = await users.findOne({ username: name });
    assert.ok(doc);
    assert.equal(doc.provider, "local");
    assert.equal(doc.confirmed, true);
    assert.equal(doc.blocked, false);
    assert.equal(doc.source, "launcher");
    assert.ok(ua.isPlaceholderEmail(doc.email));
    assert.ok(await compare("first-pass", doc.password));

    const listed = (await ua.listManagedUsers()).find((u) => u.id === made.user.id);
    assert.deepEqual(listed, made.user);

    assert.deepEqual(await ua.createManagedUser({ username: name.toUpperCase(), password: "x-pass-1", role: "owner", email: null }, "Nazar"), { ok: false, error: "username_taken" });
    await users.updateOne({ username: name }, { $set: { former_usernames: [`${name}_old`] } });
    assert.deepEqual(await ua.createManagedUser({ username: `${name}_OLD`, password: "x-pass-1", role: "owner", email: null }, "Nazar"), { ok: false, error: "username_taken" });

    const mail = `${RUN}@example.com`;
    const edited = await ua.updateManagedUser(made.user.id, { role: "owner", password: "second-pass", email: mail, blocked: true }, "Nick");
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    assert.equal(edited.user.role, "owner");
    assert.equal(edited.user.blocked, true);
    assert.equal(edited.user.email, mail);
    const after1 = await users.findOne({ username: name });
    assert.ok(after1 && (await compare("second-pass", after1.password)));
    assert.ok(Number(after1.sessions_valid_after) > 0, "a new password signs the login out everywhere");
    assert.equal(after1.updated_by, "Nick");

    // another login may not take the same e-mail
    const other = await ua.createManagedUser({ username: `${name}_b`, password: "third-pass", role: "designer", email: mail }, "Nazar");
    assert.deepEqual(other, { ok: false, error: "email_taken" });

    // clearing the e-mail gives back a placeholder; sign out everywhere moves the cut forward
    const before = Number(after1.sessions_valid_after);
    await new Promise((r) => setTimeout(r, 1100));
    const cleared = await ua.updateManagedUser(made.user.id, { email: null, signOutEverywhere: true, blocked: false }, "Nick");
    assert.equal(cleared.ok, true);
    const after2 = await users.findOne({ username: name });
    assert.ok(after2 && ua.isPlaceholderEmail(after2.email));
    assert.equal(after2.blocked, false);
    assert.ok(Number(after2.sessions_valid_after) > before);

    assert.deepEqual(await ua.updateManagedUser(987654321, { role: "owner" }, "Nick"), { ok: false, error: "not_found" });
  } finally {
    await wipe("up_users", { username: { $regex: `^ua_${RUN}`, $options: "i" } });
  }
});

test("live: rename moves everything filed under the name (accounts, tasks, queue rows, templates, held keys); refused while the login has launches in the queue; the old name stops signing in", live, async () => {
  const caches = await col("app_caches");
  const saved = await caches.findOne({ ckey: ASSIGN_KEY });
  const oldName = `Ub_${RUN}`;
  const newName = `Ub_${RUN}_new`;
  const tasks = await col("launch_tasks");
  const jobs = await col("launch_jobs");
  const templates = await col("launch_templates");
  const users = await col("up_users");
  const cleanup = async () => {
    await wipe("up_users", { username: { $regex: `^ub_${RUN}`, $options: "i" } });
    await wipe("launch_tasks", { task_id: { $regex: `^ub-${RUN}` } });
    await wipe("launch_jobs", { job_id: { $regex: `^ub-${RUN}` } });
    await wipe("launch_templates", { name: `ub-${RUN}` });
    await wipe("app_caches", { ckey: `ub-${RUN}-hold` });
  };
  await cleanup();
  try {
    const made = await ua.createManagedUser({ username: oldName, password: "rename-pass", role: "designer", email: null }, "Nazar");
    assert.ok(made.ok);
    if (!made.ok) return;
    await users.updateOne({ id: made.user.id }, { $set: { former_usernames: ["Ancient"] } });
    const accounts = { ...(saved?.cvalue?.accounts ?? {}), [`9${RUN.length}01`]: [oldName, "Nick"] };
    await caches.updateOne({ ckey: ASSIGN_KEY }, { $set: { cvalue: { v: 1, accounts, updatedAt: 1 } } }, { upsert: true });
    await tasks.insertOne({ id: 900_000_001, documentId: `ub${RUN}`.padEnd(24, "x").slice(0, 24), task_id: `ub-${RUN}-1`, owner: oldName });
    await jobs.insertOne({ id: 900_000_002, documentId: `uc${RUN}`.padEnd(24, "x").slice(0, 24), job_id: `ub-${RUN}-1`, owner: oldName, status: "queued" });
    await templates.insertOne({ id: 900_000_003, documentId: `ud${RUN}`.padEnd(24, "x").slice(0, 24), owner: oldName, partner: "br", name: `ub-${RUN}`, name_key: `ub-${RUN}`, updated_by: oldName });
    await caches.insertOne({ id: 900_000_004, documentId: `ue${RUN}`.padEnd(24, "x").slice(0, 24), ckey: `ub-${RUN}-hold`, cvalue: { user: oldName } });

    // a queued launch of theirs → refused, nothing moved
    assert.deepEqual(await ua.updateManagedUser(made.user.id, { username: newName }, "Nazar"), { ok: false, error: "user_busy", busy: 1 });
    assert.equal((await users.findOne({ id: made.user.id }))?.username, oldName);

    await jobs.updateOne({ job_id: `ub-${RUN}-1` }, { $set: { status: "done" } });
    const r = await ua.updateManagedUser(made.user.id, { username: newName }, "Nazar");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.user.username, newName);
    assert.deepEqual(r.moved, { accounts: 1, tasks: 1, jobs: 1, templates: 1, held: 1 });
    const doc = await users.findOne({ id: made.user.id });
    assert.equal(doc?.username, newName);
    assert.deepEqual(doc?.former_usernames, ["Ancient"], "the old name is NOT kept as a sign-in name");
    const reg = await caches.findOne({ ckey: ASSIGN_KEY });
    assert.deepEqual(reg?.cvalue.accounts[`9${RUN.length}01`], [newName, "Nick"]);
    assert.equal((await tasks.findOne({ task_id: `ub-${RUN}-1` }))?.owner, newName);
    assert.equal((await jobs.findOne({ job_id: `ub-${RUN}-1` }))?.owner, newName);
    const tpl = await templates.findOne({ name: `ub-${RUN}` });
    assert.equal(tpl?.owner, newName);
    assert.equal(tpl?.updated_by, newName);
    assert.equal((await caches.findOne({ ckey: `ub-${RUN}-hold` }))?.cvalue.user, newName);

    // renaming onto a taken name (any case) is refused
    const other = await ua.createManagedUser({ username: `${oldName}_x`, password: "rename-pass", role: "designer", email: null }, "Nazar");
    assert.ok(other.ok);
    assert.deepEqual(await ua.updateManagedUser(made.user.id, { username: `${oldName}_X`.toUpperCase() }, "Nazar"), { ok: false, error: "username_taken" });
  } finally {
    await cleanup();
    if (saved) await caches.replaceOne({ ckey: ASSIGN_KEY }, saved);
    else await caches.deleteOne({ ckey: ASSIGN_KEY });
  }
});

test("live: delete drops the login from the account assignments (a sole assignee's account goes back to everyone) and removes it; refused while it has launches in the queue", live, async () => {
  const caches = await col("app_caches");
  const saved = await caches.findOne({ ckey: ASSIGN_KEY });
  const name = `Uc_${RUN}`;
  const jobs = await col("launch_jobs");
  const cleanup = async () => {
    await wipe("up_users", { username: { $regex: `^uc_${RUN}`, $options: "i" } });
    await wipe("launch_jobs", { job_id: { $regex: `^uc-${RUN}` } });
  };
  await cleanup();
  try {
    const made = await ua.createManagedUser({ username: name, password: "delete-pass", role: "owner", email: null }, "Nazar");
    assert.ok(made.ok);
    if (!made.ok) return;
    const accounts = { ...(saved?.cvalue?.accounts ?? {}), [`8${RUN.length}01`]: [name], [`8${RUN.length}02`]: [name, "Nick"] };
    await caches.updateOne({ ckey: ASSIGN_KEY }, { $set: { cvalue: { v: 1, accounts, updatedAt: 2 } } }, { upsert: true });
    await jobs.insertOne({ id: 900_000_011, documentId: `uf${RUN}`.padEnd(24, "x").slice(0, 24), job_id: `uc-${RUN}-1`, owner: name, status: "running" });

    assert.deepEqual(await ua.deleteManagedUser(made.user.id), { ok: false, error: "user_busy", busy: 1 });
    await jobs.deleteOne({ job_id: `uc-${RUN}-1` });

    assert.deepEqual(await ua.deleteManagedUser(made.user.id), { ok: true, username: name, accounts: 2, freed: 1 });
    const reg = await caches.findOne({ ckey: ASSIGN_KEY });
    assert.equal(reg?.cvalue.accounts[`8${RUN.length}01`], undefined);
    assert.deepEqual(reg?.cvalue.accounts[`8${RUN.length}02`], ["Nick"]);
    assert.equal(await (await col("up_users")).findOne({ username: name }), null);
    assert.deepEqual(await ua.deleteManagedUser(made.user.id), { ok: false, error: "not_found" });
  } finally {
    await cleanup();
    if (saved) await caches.replaceOne({ ckey: ASSIGN_KEY }, saved);
    else await caches.deleteOne({ ckey: ASSIGN_KEY });
  }
});

test("generatePassword: 14 characters of letters and digits without look-alikes (0/O, 1/l/I), always valid, never the same twice", async () => {
  const { generatePassword, checkPassword } = await import("../lib/user-fields.ts");
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 14);
    assert.match(p, /^[A-HJ-NP-Za-km-z2-9]+$/);
    assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[2-9]/.test(p), `mixed: ${p}`);
    assert.deepEqual(checkPassword(p), { ok: true, value: p });
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});
