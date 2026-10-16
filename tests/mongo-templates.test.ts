// `node --test tests/mongo-templates.test.ts` (needs MONGODB_URI; runs on gc_test) — the campaign
// template store (lib/template-store) on a live collection with its real unique index: one name per
// buyer per partner, the per-buyer cap, edits, the use counter, deletion.
import { HAVE_DB, RUN, closeDb, col, ensureTestIndexes, wipe } from "./_mongo.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const live = { skip: !HAVE_DB && "MONGODB_URI not set" };
const COLL = "launch_templates";

before(async () => {
  if (HAVE_DB) await ensureTestIndexes();
});

// ---- pure: a stored row as the browser sees it (no store needed) ----------------------------------

test("templateFromRow: the envelope + the template parts, dates as ISO strings, junk fields dropped, missing counters zero", async () => {
  const { templateFromRow } = await import("../lib/template-store.ts");
  const now = new Date("2026-10-16T10:00:00Z");
  const t = templateFromRow({
    _id: "x",
    id: 7,
    documentId: "abcdefghijklmnopqrstuvwx",
    partner: "in",
    owner: "Tima",
    name: "Cars US",
    name_key: "cars us",
    description: "d",
    fields: { countries: ["US"], budget: "7", files: [1], bogus: true },
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    updated_by: "Tima",
  });
  assert.deepEqual(t, {
    id: 7,
    documentId: "abcdefghijklmnopqrstuvwx",
    partner: "in",
    owner: "Tima",
    name: "Cars US",
    description: "d",
    fields: { countries: ["US"], budget: "7" },
    uses: 0,
    lastUsedAt: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
    updatedBy: "Tima",
  });
  // a row whose fields are not an object comes back with none (never a crash in the picker)
  assert.deepEqual(templateFromRow({ id: 1, documentId: "y", partner: "br", owner: "a", name: "n", fields: "junk" }).fields, {});
});

// ---- live ---------------------------------------------------------------------------------------

test("live: create → list by partner → one name per buyer (the existing one is named) → another buyer may use the name → patch → rename clash → use bump → delete", live, async () => {
  const store = await import("../lib/template-store.ts");
  const owner = `tpl-${RUN}`;
  const other = `tpl-${RUN}-other`;
  const mine = { owner: { $regex: `^tpl-${RUN}` } };
  await wipe(COLL, mine);
  try {
    const a = await store.createTemplate({ name: "Cars US", description: "lowest cost", partner: "in", fields: { countries: ["US"], budget: "7" } }, owner);
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.match(a.template.documentId, /^[a-z0-9]{24}$/);
    assert.equal(typeof a.template.id, "number");
    assert.deepEqual([a.template.owner, a.template.partner, a.template.name, a.template.description, a.template.uses, a.template.lastUsedAt, a.template.updatedBy], [owner, "in", "Cars US", "lowest cost", 0, null, owner]);
    assert.deepEqual(a.template.fields, { countries: ["US"], budget: "7" });
    const raw = await (await col(COLL)).findOne({ documentId: a.template.documentId });
    assert.deepEqual([raw?.platform, raw?.name_key], ["facebook", "cars us"]);
    assert.ok(raw?.createdAt instanceof Date && raw?.updatedAt instanceof Date && raw?.publishedAt instanceof Date);

    // list: the partner's templates only, newest-updated first
    const b = await store.createTemplate({ name: "MKD BR", description: "", partner: "br", fields: { link: "https://a.b/c", redirectType: "HIGH ADX" } }, owner);
    assert.equal(b.ok, true);
    const inList = (await store.listTemplates("in")).filter((t) => t.owner.startsWith(`tpl-${RUN}`));
    assert.deepEqual(inList.map((t) => t.name), ["Cars US"]);
    const brList = (await store.listTemplates("br")).filter((t) => t.owner.startsWith(`tpl-${RUN}`));
    assert.deepEqual(brList.map((t) => t.name), ["MKD BR"]);
    const all = (await store.listTemplates()).filter((t) => t.owner.startsWith(`tpl-${RUN}`));
    assert.equal(all.length, 2);

    // one name per buyer per partner — spelled any way; the existing template is handed back
    const dup = await store.createTemplate({ name: "cars   US", description: "", partner: "in", fields: { budget: "9" } }, owner);
    assert.equal(dup.ok, false);
    if (dup.ok) return;
    assert.equal(dup.error, "template_exists");
    assert.equal(dup.error === "template_exists" && dup.existing?.documentId, a.template.documentId);
    // the same name on another partner, or for another buyer, is fine
    const sameNameBr = await store.createTemplate({ name: "Cars US", description: "", partner: "br", fields: { budget: "9" } }, owner);
    assert.equal(sameNameBr.ok, true);
    const otherOwner = await store.createTemplate({ name: "Cars US", description: "", partner: "in", fields: { budget: "9" } }, other);
    assert.equal(otherOwner.ok, true);
    if (!otherOwner.ok) return;

    // patch: name / description / fields, the editor is recorded, updatedAt moves
    const edited = await store.updateTemplate(a.template.documentId, { name: "Cars US v2", fields: { countries: ["CA"], budget: "8" } }, "editor");
    assert.equal(edited.ok, true);
    if (!edited.ok) return;
    assert.deepEqual([edited.template.name, edited.template.description, edited.template.updatedBy], ["Cars US v2", "lowest cost", "editor"]);
    assert.deepEqual(edited.template.fields, { countries: ["CA"], budget: "8" });
    assert.ok(Date.parse(edited.template.updatedAt) >= Date.parse(a.template.createdAt));
    assert.equal((await store.findTemplate(a.template.documentId))?.name, "Cars US v2");
    // the old name is free again for this buyer
    const reuse = await store.createTemplate({ name: "Cars US", description: "", partner: "in", fields: { budget: "1" } }, owner);
    assert.equal(reuse.ok, true);
    if (!reuse.ok) return;
    // a rename onto a name the buyer already uses is refused
    const clash = await store.updateTemplate(reuse.template.documentId, { name: "cars us V2" }, owner);
    assert.deepEqual(clash, { ok: false, error: "template_exists" });
    assert.deepEqual(await store.updateTemplate("000000000000000000000000", { name: "x" }, owner), { ok: false, error: "not_found" });

    // the use counter: bumped twice, the last use stamped, "updated" untouched
    assert.equal(await store.bumpTemplateUse(a.template.documentId), true);
    assert.equal(await store.bumpTemplateUse(a.template.documentId), true);
    assert.equal(await store.bumpTemplateUse("000000000000000000000000"), false);
    const used = await store.findTemplate(a.template.documentId);
    assert.equal(used?.uses, 2);
    assert.ok(used?.lastUsedAt && Date.parse(used.lastUsedAt) > 0);
    assert.equal(used?.updatedAt, edited.template.updatedAt);

    // delete
    assert.equal(await store.deleteTemplate(a.template.documentId), true);
    assert.equal(await store.deleteTemplate(a.template.documentId), false);
    assert.equal(await store.findTemplate(a.template.documentId), null);
  } finally {
    await wipe(COLL, mine);
  }
});

test("live: the per-buyer cap refuses the next save, per partner", live, async () => {
  const store = await import("../lib/template-store.ts");
  const owner = `tpl-${RUN}-cap`;
  await wipe(COLL, { owner });
  try {
    for (const name of ["one", "two"]) {
      const r = await store.createTemplate({ name, description: "", partner: "in", fields: { budget: "7" } }, owner, { max: 2 });
      assert.equal(r.ok, true, name);
    }
    const third = await store.createTemplate({ name: "three", description: "", partner: "in", fields: { budget: "7" } }, owner, { max: 2 });
    assert.deepEqual(third, { ok: false, error: "template_limit", max: 2 });
    const otherPartner = await store.createTemplate({ name: "three", description: "", partner: "br", fields: { budget: "7" } }, owner, { max: 2 });
    assert.equal(otherPartner.ok, true);
  } finally {
    await wipe(COLL, { owner });
  }
});

after(async () => {
  await closeDb();
});
