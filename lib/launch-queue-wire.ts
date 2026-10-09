// Pure wiring decisions of the server launch queue, split out of lib/launch-queue-run.ts so the
// parts that can be unit-tested have no "@/" / next/* imports (the runner proper imports the route
// handlers and the store, so node --test can't load it). Relative `.ts` imports only.
//
// Here live: the NDJSON reply parser (a port of what the browser task managers did reading the same
// stream), the self-origin resolution for the continuation kick, the internal-token HMAC + its
// constant-time compare, and the lane-name shape check. All deterministic — tested in
// tests/launch-queue-run.test.ts.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { QueueKind } from "./launch-queue-types.ts";

// ---- NDJSON reply parsing ----

/**
 * Collapse the lines of a handler's NDJSON reply into (lastStage, final) — exactly as the browser
 * task managers did (components/task-manager.tsx runLaunchTask / runCloneTask,
 * components/hs-task-manager.tsx runTask): the final is the last event carrying `ok` (true/false);
 * every other event's `stage` string becomes the running `lastStage`. For clones the batch summary
 * `{stage:"batch-done"}` is ignored entirely and the per-clone `{stage:"start"}` never counts as a
 * stage (it predates the real work). `outcomeOf` turns this pair into the verdict.
 */
export function parseReplyLines(lines: string[], kind: QueueKind): { lastStage: string | null; final: Record<string, unknown> | null } {
  const isClone = kind === "fb.clone";
  let lastStage: string | null = null;
  let final: Record<string, unknown> | null = null;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      ev = parsed as Record<string, unknown>;
    } catch {
      continue; // a torn/partial line — skip it, same as the browser's try/catch per line
    }
    // The clone batch ends with a {stage:"batch-done"} summary — never a verdict, never a stage.
    if (isClone && ev.stage === "batch-done") continue;
    if (ev.ok === true || ev.ok === false) {
      final = ev; // the last ok-bearing event wins (each clone job carries exactly one)
      continue;
    }
    if (typeof ev.stage === "string" && !(isClone && ev.stage === "start")) {
      lastStage = ev.stage;
    }
  }
  return { lastStage, final };
}

// ---- self-origin for the continuation kick (spec §4.3) ----

type Env = { readonly [key: string]: string | undefined };

/**
 * Where this deployment can reach ITS OWN /api/launch-queue/pump: ADL_SELF_ORIGIN when set, else the
 * request's own origin — unless that origin is a `*.vercel.app` preview/alias host, in which case the
 * stable production URL is used (a preview alias can rotate / scale to zero between a kick and its
 * landing); with no production URL configured it falls back to the request's origin.
 */
export function computeSelfOrigin(env: Env, requestUrl: string): string {
  const explicit = (env.ADL_SELF_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^/\s]+$/i.test(explicit)) return explicit;
  let reqOrigin = "";
  let reqHost = "";
  try {
    const u = new URL(requestUrl);
    reqOrigin = u.origin;
    reqHost = u.host;
  } catch {
    /* an opaque request url — fall through to the production URL / empty */
  }
  if (reqOrigin && !/\.vercel\.app$/i.test(reqHost)) return reqOrigin;
  const prod = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (prod) return `https://${prod}`;
  return reqOrigin;
}

// ---- internal pump authorization ----

/** The fixed HMAC label — a self-kick is authenticated by HMAC(AUTH_SECRET, label), so pumps can
 *  continue a lane even where CRON_SECRET is unset (the cron bearer is the other accepted token). */
export const INTERNAL_TOKEN_LABEL = "adlauncher:launch-queue:internal-pump:v1";

/** HMAC-SHA256(secret, label) as hex — or "" for an empty secret (then no bearer can ever match,
 *  so the pump route stays closed; same fail-closed discipline as lib/session). */
export function computeInternalToken(secret: string): string {
  if (!secret) return "";
  return createHmac("sha256", secret).update(INTERNAL_TOKEN_LABEL).digest("hex");
}

/** Constant-time string compare on equal-length buffers; false for an empty side or a length
 *  mismatch (an empty secret must never authorize). */
export function timingEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---- lane name shape ----

// The username part is whatever the session carries (usernames may hold spaces, dots, non-Latin
// letters) — the lane is only ever a Mongo filter VALUE, so the shape check is about bounds and
// control characters, not about an alphabet. A lane this refused could never be continued by a
// self-kick or restarted by the cron (it would run only inside its hand-off's own invocation).
// A scope's submit lane (`hs:<user>`) or its follow-up lane (`hs-follow:<user>`, lib/launch-queue-types followLaneOf).
const LANE_RE = /^(mo|aif|av|hs|gg|sn|tt)(-follow)?:[^\u0000-\u001f\u007f]{1,160}$/;

/** A lane the pump route will act on: `<scope>:<username>`, bounded, no control characters. */
export function laneNameValid(lane: unknown): lane is string {
  return typeof lane === "string" && LANE_RE.test(lane);
}

// ---- pump budget ----

/**
 * How long one pump invocation may work: `fallback` (PUMP_BUDGET_MS) everywhere that matters.
 * ADL_QUEUE_BUDGET_MS can only SHORTEN it, and only off production — the local bench uses it to
 * prove a lane survives being handed from one invocation to the next without waiting 13 minutes.
 */
/** This deployment's build stamp for the queue. `inlined` is process.env.NEXT_PUBLIC_BUILD_STAMP as
 *  the bundler inlined it (an ISO build time — the caller must read it LITERALLY, next.config `env`
 *  values exist only as build-time replacements). Off production a bench may stand in for "another
 *  build" with ADL_QUEUE_BUILD — the same seam as ADL_QUEUE_BUDGET_MS; production never reads it. */
export function queueBuild(inlined: string | undefined, env: Env): string {
  const override = env.VERCEL_ENV === "production" ? "" : String(env.ADL_QUEUE_BUILD ?? "").trim();
  return override || String(inlined ?? "").trim();
}

/** May THIS deployment announce itself as the current build? Only the production deployment (the
 *  one Vercel Cron sweeps) — or a process that is not on Vercel at all (the local bench). A preview
 *  sharing the database must never make production pumps step aside. */
export function mayAnnounceBuild(env: Env): boolean {
  return env.VERCEL_ENV === "production" || !env.VERCEL;
}

export function pumpBudgetMs(env: Env, fallback: number): number {
  if (env.VERCEL_ENV === "production") return fallback;
  const raw = Number(env.ADL_QUEUE_BUDGET_MS);
  // Never below what ONE job needs (worst case 310 s + 20 s margin): a budget no job fits would
  // make every invocation hand the lane straight to the next one, forever.
  return Number.isFinite(raw) && raw >= 331_000 && raw < fallback ? raw : fallback;
}
