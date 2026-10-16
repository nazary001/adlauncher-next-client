// Server-only persistence for campaign templates (MongoDB collection `launch_templates`, one per
// team database — lib/team). A template is a buyer's saved card (lib/templates says what it may
// carry); the whole team reads them, the creator (or an owner-role login) changes and deletes
// them — the routes decide WHO, this module only stores. One name per buyer per partner is the
// unique index {owner, partner, name_key} (scripts/ensure-indexes.mjs); a clash comes back as
// `template_exists` with the template that holds the name, so the UI can offer to replace it.
// Bounded like every store call (lib/store).

import type { Document } from "mongodb";
import { coll } from "./mongo.ts";
import { STORE_TIMEOUT_MS, bounded, dupKeyField, insertFresh, strapiRow } from "./store.ts";
import {
  TEMPLATES_PER_USER_MAX,
  type CampaignTemplate,
  type TemplateInput,
  type TemplatePartner,
  type TemplatePatch,
  sanitizeTemplateFields,
  templateNameKey,
} from "./templates.ts";

export const LAUNCH_TEMPLATES = "launch_templates";
/** The board these templates belong to — the Facebook launcher. Another platform's cards would
 *  file under their own word. */
export const TEMPLATE_PLATFORM = "facebook";
/** At most this many rows a list read returns (every team is far below it). */
const LIST_MAX = 2000;

/** A stored row as the browser sees it: no `_id`, dates as ISO strings, the fields re-whitelisted
 *  (a row written by an older build or by hand must never crash the picker). */
export function templateFromRow(doc: Document): CampaignTemplate {
  const r = strapiRow(doc);
  const fields = sanitizeTemplateFields(r.fields);
  return {
    id: Number(r.id) || 0,
    documentId: String(r.documentId ?? ""),
    partner: String(r.partner ?? "") as TemplatePartner,
    owner: String(r.owner ?? ""),
    name: String(r.name ?? ""),
    description: String(r.description ?? ""),
    fields: fields.ok ? fields.fields : {},
    uses: Number(r.uses) || 0,
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
    updatedBy: String(r.updated_by ?? r.owner ?? ""),
  };
}

/** Did this write collide on the one-name-per-buyer index? The driver reports the index's FIRST key. */
const nameClash = (e: unknown): boolean => {
  const f = dupKeyField(e);
  return f === "owner" || f === "name_key";
};

/** The team's templates — one partner's, or every partner's — newest-updated first. */
export async function listTemplates(partner?: string): Promise<CampaignTemplate[]> {
  const c = await coll(LAUNCH_TEMPLATES);
  const filter: Document = partner ? { partner } : {};
  const docs = await bounded(c.find(filter, { maxTimeMS: STORE_TIMEOUT_MS }).sort({ updatedAt: -1, documentId: 1 }).limit(LIST_MAX).toArray(), "templates list");
  return docs.map(templateFromRow);
}

export async function findTemplate(documentId: string): Promise<CampaignTemplate | null> {
  const c = await coll(LAUNCH_TEMPLATES);
  const doc = await bounded(c.findOne({ documentId }, { maxTimeMS: STORE_TIMEOUT_MS }), "template read");
  return doc ? templateFromRow(doc) : null;
}

/** The buyer's template of this name on this partner (any spelling of the name), or null. */
export async function findOwnTemplate(owner: string, partner: string, name: string): Promise<CampaignTemplate | null> {
  const c = await coll(LAUNCH_TEMPLATES);
  const doc = await bounded(c.findOne({ owner, partner, name_key: templateNameKey(name) }, { maxTimeMS: STORE_TIMEOUT_MS }), "template read");
  return doc ? templateFromRow(doc) : null;
}

export type CreateTemplateResult =
  | { ok: true; template: CampaignTemplate }
  | { ok: false; error: "template_exists"; existing: CampaignTemplate | null }
  | { ok: false; error: "template_limit"; max: number };

/** A new template under `owner`. Refused when the buyer already has one of this name on this
 *  partner (the existing one is handed back) or holds `max` templates there already. */
export async function createTemplate(input: TemplateInput, owner: string, opts: { max?: number } = {}): Promise<CreateTemplateResult> {
  const max = opts.max ?? TEMPLATES_PER_USER_MAX;
  const c = await coll(LAUNCH_TEMPLATES);
  const count = await bounded(c.countDocuments({ owner, partner: input.partner }, { maxTimeMS: STORE_TIMEOUT_MS }), "templates count");
  if (count >= max) return { ok: false, error: "template_limit", max };
  try {
    const doc = await insertFresh(LAUNCH_TEMPLATES, {
      platform: TEMPLATE_PLATFORM,
      partner: input.partner,
      owner,
      name: input.name,
      name_key: templateNameKey(input.name),
      description: input.description,
      fields: input.fields,
      uses: 0,
      last_used_at: null,
      updated_by: owner,
    });
    return { ok: true, template: templateFromRow(doc) };
  } catch (e) {
    if (!nameClash(e)) throw e;
    return { ok: false, error: "template_exists", existing: await findOwnTemplate(owner, input.partner, input.name).catch(() => null) };
  }
}

export type UpdateTemplateResult = { ok: true; template: CampaignTemplate } | { ok: false; error: "not_found" | "template_exists" };

/** Change the name / description / fields of one template; `by` is recorded as its last editor. A
 *  new name the buyer already uses on this partner is refused. */
export async function updateTemplate(documentId: string, patch: TemplatePatch, by: string): Promise<UpdateTemplateResult> {
  const $set: Document = { updatedAt: new Date(), updated_by: by };
  if (patch.name !== undefined) {
    $set.name = patch.name;
    $set.name_key = templateNameKey(patch.name);
  }
  if (patch.description !== undefined) $set.description = patch.description;
  if (patch.fields !== undefined) $set.fields = patch.fields;
  const c = await coll(LAUNCH_TEMPLATES);
  try {
    const doc = await bounded(c.findOneAndUpdate({ documentId }, { $set }, { returnDocument: "after", maxTimeMS: STORE_TIMEOUT_MS }), "template update");
    return doc ? { ok: true, template: templateFromRow(doc) } : { ok: false, error: "not_found" };
  } catch (e) {
    if (!nameClash(e)) throw e;
    return { ok: false, error: "template_exists" };
  }
}

export async function deleteTemplate(documentId: string): Promise<boolean> {
  const c = await coll(LAUNCH_TEMPLATES);
  const r = await bounded(c.deleteOne({ documentId }), "template delete");
  return r.deletedCount > 0;
}

/** One more use: the counter and the last-use stamp move, "updated" (an edit) does not. */
export async function bumpTemplateUse(documentId: string): Promise<boolean> {
  const c = await coll(LAUNCH_TEMPLATES);
  const r = await bounded(c.updateOne({ documentId }, { $inc: { uses: 1 }, $set: { last_used_at: new Date() } }), "template use");
  return r.matchedCount > 0;
}
