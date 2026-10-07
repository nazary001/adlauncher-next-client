// Server-only I/O for the Auto landings rail (MO / MK Learn): the mo_landing_jobs queue the
// owner console manages and the published mo_landings catalog the pickers + launch guard read.
// All store access is bounded (8 s) — a hung store must degrade, never pin a route to its maxDuration.

import type { Document } from "mongodb";
import type { Landing } from "@/lib/partners";
import type { LandingFormat } from "@/lib/auto-landings-plan";
import { coll } from "./mongo.ts";
import { MO_LANDINGS, MO_LANDING_JOBS, STORE_TIMEOUT_MS, bounded, insertFresh, pickSchema, storeConfigured, strapiRow } from "./store.ts";

/** Where the generated pages live (same base the MO partner config uses). */
export const AUTO_LANDING_BASE = "https://finance.magicoffers.shop/guides";

export type AutoLandingJob = {
  documentId: string;
  title: string;
  lang: "en" | "es";
  niche: string;
  /** Page template (contract §7): rows created before the schema gained the field read as "classic". */
  format: LandingFormat;
  notes: string;
  status: "scheduled" | "generating" | "published" | "failed" | "canceled";
  scheduledAt: number;
  createdBy: string;
  batchId: string;
  attempts: number;
  error: string;
  slug: string;
  landingUrl: string;
  startedAt: number;
  finishedAt: number;
  createdAt: string;
};

type JobRow = {
  documentId?: string;
  title?: string;
  lang?: string;
  niche?: string;
  format?: string;
  notes?: string;
  status?: string;
  scheduled_at?: unknown;
  created_by?: string;
  batch_id?: string;
  attempts?: unknown;
  error?: string;
  slug?: string;
  landing_url?: string;
  started_at?: unknown;
  finished_at?: unknown;
  createdAt?: string;
};

/** The queue row's attributes (schema.json of `mo-landing-job`): biginteger timestamps are stored as
 *  Numbers — the generator worker compares `scheduled_at <= now` numerically. */
const JOB_FIELDS = ["title", "lang", "format", "niche", "notes", "status", "scheduled_at", "created_by", "batch_id", "attempts", "error", "slug", "landing_url", "started_at", "finished_at"] as const;
const JOB_TYPING = { bigint: ["scheduled_at", "started_at", "finished_at"] } as const;

const num = (v: unknown): number => Number(v) || 0;

function formatJob(r: JobRow): AutoLandingJob | null {
  if (!r?.documentId || !r?.title) return null;
  const status = ["scheduled", "generating", "published", "failed", "canceled"].includes(String(r.status))
    ? (r.status as AutoLandingJob["status"])
    : "scheduled";
  return {
    documentId: String(r.documentId),
    title: String(r.title),
    lang: r.lang === "es" ? "es" : "en",
    niche: String(r.niche ?? "") || "Auto",
    format: r.format === "jobguide" ? "jobguide" : "classic",
    notes: String(r.notes ?? ""),
    status,
    scheduledAt: num(r.scheduled_at),
    createdBy: String(r.created_by ?? ""),
    batchId: String(r.batch_id ?? ""),
    attempts: num(r.attempts),
    error: String(r.error ?? ""),
    slug: String(r.slug ?? ""),
    landingUrl: String(r.landing_url ?? ""),
    startedAt: num(r.started_at),
    finishedAt: num(r.finished_at),
    createdAt: String(r.createdAt ?? ""),
  };
}

const jobOf = (doc: Document): AutoLandingJob | null => formatJob(strapiRow(doc) as JobRow);

/** Newest jobs first (whole queue — the batch cap keeps it small; bounded at 500 rows). */
export async function listJobs(): Promise<AutoLandingJob[] | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(MO_LANDING_JOBS);
    const docs = await bounded(c.find({}, { maxTimeMS: STORE_TIMEOUT_MS }).sort({ createdAt: -1 }).limit(500).toArray(), "jobs list");
    return docs.map(jobOf).filter((j): j is AutoLandingJob => j !== null);
  } catch {
    return null;
  }
}

export async function readJob(documentId: string): Promise<AutoLandingJob | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(MO_LANDING_JOBS);
    const doc = await bounded(c.findOne({ documentId }, { maxTimeMS: STORE_TIMEOUT_MS }), "job read");
    return doc ? jobOf(doc) : null;
  } catch {
    return null;
  }
}

export type NewJob = {
  title: string;
  lang: "en" | "es";
  niche: string;
  format: LandingFormat;
  notes?: string;
  scheduledAt: number;
  createdBy: string;
  batchId: string;
};

/** Create one queue row (full schema shape); returns the created job (null on failure). */
export async function createJob(j: NewJob): Promise<AutoLandingJob | null> {
  if (!storeConfigured()) return null;
  try {
    const doc = await insertFresh(MO_LANDING_JOBS, {
      title: j.title,
      lang: j.lang,
      format: j.format,
      niche: j.niche,
      notes: j.notes ?? "",
      status: "scheduled",
      scheduled_at: j.scheduledAt,
      created_by: j.createdBy,
      batch_id: j.batchId,
      attempts: 0,
      error: null,
      slug: null,
      landing_url: null,
      started_at: null,
      finished_at: null,
    });
    return jobOf(doc);
  } catch {
    return null;
  }
}

/** Partial update by documentId (only the schema's attributes; biginteger values typed as Numbers). */
export async function patchJob(
  documentId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!storeConfigured()) return false;
  try {
    const c = await coll(MO_LANDING_JOBS);
    const set = pickSchema(data, JOB_FIELDS, JOB_TYPING);
    const r = await bounded(c.updateOne({ documentId }, { $set: { ...set, updatedAt: new Date() } }), "job update");
    return r.matchedCount > 0;
  } catch {
    return false;
  }
}

export async function deleteJob(documentId: string): Promise<boolean> {
  if (!storeConfigured()) return false;
  try {
    const c = await coll(MO_LANDING_JOBS);
    const r = await bounded(c.deleteOne({ documentId }), "job delete");
    return r.deletedCount > 0;
  } catch {
    return false;
  }
}

// ---- published landings (the picker + launch-guard side) ------------------------------------

export type AutoLanding = Landing & { documentId: string };

/** Published auto landings as picker `Landing`s, grouped under "Auto · <niche>" section headers
 *  (groups must stay CONTIGUOUS for SearchSelect, hence the niche sort). */
export async function fetchAutoLandings(): Promise<AutoLanding[] | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(MO_LANDINGS);
    const rows = await bounded(
      c.find({}, { projection: { _id: 0, documentId: 1, title: 1, slug: 1, lang: 1, niche: 1 }, maxTimeMS: STORE_TIMEOUT_MS })
        .sort({ niche: 1, createdAt: -1 })
        .limit(500)
        .toArray(),
      "landings list",
    );
    const out: AutoLanding[] = [];
    for (const r of rows) {
      if (!r?.slug || !r?.title || !r?.documentId) continue;
      out.push({
        documentId: String(r.documentId),
        slug: String(r.slug),
        title: String(r.title),
        lang: r.lang === "es" ? "ES" : "EN",
        niche: `Auto · ${String(r.niche ?? "") || "Auto"}`,
      });
    }
    return out;
  } catch {
    return null;
  }
}

// Short per-instance cache so the launch guard + picker route don't hammer the store; the catalog
// changes at generation cadence (minutes), 60s staleness is invisible.
let landingsCache: { at: number; rows: AutoLanding[] } | null = null;
const LANDINGS_TTL_MS = 60_000;

export async function cachedAutoLandings(): Promise<AutoLanding[]> {
  if (landingsCache && Date.now() - landingsCache.at < LANDINGS_TTL_MS) return landingsCache.rows;
  const rows = await fetchAutoLandings();
  if (rows === null) return landingsCache?.rows ?? []; // degrade to stale/empty, never throw
  landingsCache = { at: Date.now(), rows };
  return rows;
}

/** Launch-guard check: is `slug` a live auto landing? (Static catalog is checked by the caller.) */
export async function isAutoLandingSlug(slug: string): Promise<boolean> {
  const clean = String(slug ?? "").trim();
  if (!clean) return false;
  const rows = await cachedAutoLandings();
  return rows.some((l) => l.slug === clean);
}

export async function deleteLanding(documentId: string): Promise<boolean> {
  if (!storeConfigured()) return false;
  try {
    const c = await coll(MO_LANDINGS);
    const r = await bounded(c.deleteOne({ documentId }), "landing delete");
    if (r.deletedCount > 0) landingsCache = null;
    return r.deletedCount > 0;
  } catch {
    return false;
  }
}

/** Launch-time facts for the Auto-launch rail: the published landing's polished title/subtitle +
 *  niche/lang, read fresh by slug (the ad copy is generated from these). null when absent/unavailable
 *  — the caller then falls back to the job's own fields. */
export type LandingLaunchFacts = { slug: string; title: string; subtitle: string; niche: string; lang: "en" | "es" };
export async function fetchLandingForLaunch(slug: string): Promise<LandingLaunchFacts | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(MO_LANDINGS);
    const r = await bounded(
      c.findOne({ slug }, { projection: { _id: 0, title: 1, title_accent: 1, subtitle: 1, niche: 1, slug: 1, lang: 1 }, maxTimeMS: STORE_TIMEOUT_MS }),
      "landing read",
    );
    if (!r) return null;
    const title = `${String(r.title ?? "")}${r.title_accent ? " " + r.title_accent : ""}`.trim();
    return {
      slug,
      title,
      subtitle: String(r.subtitle ?? ""),
      niche: String(r.niche ?? "") || "Auto",
      lang: r.lang === "es" ? "es" : "en",
    };
  } catch {
    return null;
  }
}

/** The landing documentId for a published job's slug (for unpublish). */
export async function findLandingBySlug(slug: string): Promise<string | null> {
  if (!storeConfigured()) return null;
  try {
    const c = await coll(MO_LANDINGS);
    const r = await bounded(c.findOne({ slug }, { projection: { _id: 0, documentId: 1 }, maxTimeMS: STORE_TIMEOUT_MS }), "landing read");
    return r?.documentId ? String(r.documentId) : null;
  } catch {
    return null;
  }
}
