// Shared reader for the /api/launch reply (the auto-launch modal; pure, unit-tested).
//
// The route answers in one of two shapes:
//   - a pre-stream rejection: ONE JSON object, `application/json`, NO trailing newline;
//   - the run itself: `application/x-ndjson`, one event per line, the last one carrying `ok`.
// A line splitter that only parses terminated lines drops the first shape whole — every 4xx
// surfaced as a bare "launch failed (stream ended)" (owner report 2026-09-11).

export type LaunchEvent = {
  stage?: string;
  ok?: boolean;
  error?: string;
  link?: string;
  gcm?: string;
  done?: number;
  total?: number;
  /** TOOL is still finishing the launch past the route's window — the campaign may yet be born. */
  pending?: boolean;
  /** What a FAILED run had already created on Facebook (a campaign id here = money may be moving). */
  created?: { campaign_id?: unknown } | null;
};

/** One event line → object, or null for a blank / unparsable line (never throws). */
export function parseEvent(line: string): LaunchEvent | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" ? (v as LaunchEvent) : null;
  } catch {
    return null;
  }
}

/** Parse every COMPLETE line of an NDJSON buffer; `rest` is the unterminated tail — keep it for
 *  the next chunk, and run it through parseEvent once the body is finished. */
export function drainNdjson(buf: string): { events: LaunchEvent[]; rest: string } {
  const lines = buf.split("\n");
  const rest = lines.pop() ?? "";
  const events: LaunchEvent[] = [];
  for (const line of lines) {
    const ev = parseEvent(line);
    if (ev) events.push(ev);
  }
  return { events, rest };
}

export type LaunchOutcome = {
  ok: boolean;
  text: string;
  /** A failed launch that may be fired again with ONE click: only when it is CERTAIN nothing exists
   *  on Facebook — a rejection before the run, or a run that ended with a clean error and no created
   *  campaign. Anything else (a campaign was created, TOOL is still working, the reply ended without
   *  a verdict) is not: a blind re-fire would build a SECOND live campaign under a fresh code. */
  retrySafe: boolean;
};

/**
 * Turn a finished reply into the modal's verdict.
 *  - `streamed`: the reply was the NDJSON run (content-type x-ndjson), not a plain JSON rejection;
 *  - `final`: the last event carrying `ok` — including the unterminated tail, so a pre-stream
 *    rejection counts as a verdict instead of "stream ended".
 *
 * Creatives now live in S3 objects the launch route never deletes per run (the bucket lifecycle is
 * the cleanup), so a retry no longer needs a FRESH creative. What a retry still needs is certainty
 * that the first attempt created nothing — that is `retrySafe` (review find 08.10: when the old
 * "creative consumed" gate went away, every failure became a one-click re-fire, including the
 * outcomes where the campaign may already be live).
 */
export function launchOutcome(args: { status: number; streamed: boolean; final: LaunchEvent | null }): LaunchOutcome {
  const { status, streamed, final } = args;
  if (final?.ok) return { ok: true, text: `Live · gcm ${final.gcm ?? "?"}`, retrySafe: false };
  if (final) {
    const reason = final.error || (streamed ? "launch failed" : "launch rejected");
    const createdCampaign = Boolean(final.created && typeof final.created === "object" && final.created.campaign_id);
    return {
      ok: false,
      text: streamed ? reason : `${reason} · HTTP ${status}`,
      retrySafe: !final.pending && !createdCampaign,
    };
  }
  if (streamed) {
    return {
      ok: false,
      text: `stream ended without a verdict (HTTP ${status}) — the launch may still have finished server-side; check the Tasks drawer / Ads Manager before retrying`,
      retrySafe: false,
    };
  }
  // No readable reply at all (a platform error page — e.g. a 504 after the function ran its whole
  // window): the run may well have happened.
  return {
    ok: false,
    text: `no readable reply from the server (HTTP ${status}) — the launch may still have run; check the Tasks drawer / Ads Manager before retrying`,
    retrySafe: false,
  };
}

/** Is this reply the NDJSON run (vs a plain JSON rejection / a platform error page)? */
export function isLaunchStream(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("ndjson");
}
