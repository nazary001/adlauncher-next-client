// Shared reader for the /api/launch reply (the auto-launch modal; pure, unit-tested).
//
// The route answers in one of two shapes:
//   - a pre-stream rejection: ONE JSON object, `application/json`, NO trailing newline;
//   - the run itself: `application/x-ndjson`, one event per line, the last one carrying `ok`.
// A line splitter that only parses terminated lines drops the first shape whole — every 4xx
// (e.g. "image fetch failed (HTTP 404)" on a retry whose creative the previous run already
// dropped) surfaced as a bare "launch failed (stream ended)" (owner report 2026-09-11).

export type LaunchEvent = {
  stage?: string;
  ok?: boolean;
  error?: string;
  link?: string;
  gcm?: string;
  done?: number;
  total?: number;
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
  /** The staged creative is gone (or its fate is unknown) — a retry needs a fresh one. The route
   *  drops every temporary Blob whenever the RUN finishes (success or failure); a pre-stream
   *  rejection never starts the run, so the creative survives it and the same one can fire again. */
  creativeConsumed: boolean;
};

/**
 * Turn a finished reply into the modal's verdict.
 *  - `streamed`: the reply was the NDJSON run (content-type x-ndjson), not a plain JSON rejection;
 *  - `final`: the last event carrying `ok` — including the unterminated tail, so a pre-stream
 *    rejection counts as a verdict instead of "stream ended".
 */
export function launchOutcome(args: { status: number; streamed: boolean; final: LaunchEvent | null }): LaunchOutcome {
  const { status, streamed, final } = args;
  if (final?.ok) return { ok: true, text: `Live · gcm ${final.gcm ?? "?"}`, creativeConsumed: true };
  if (final) {
    const reason = final.error || (streamed ? "launch failed" : "launch rejected");
    return { ok: false, text: streamed ? reason : `${reason} · HTTP ${status}`, creativeConsumed: streamed };
  }
  if (streamed) {
    return {
      ok: false,
      text: `stream ended without a verdict (HTTP ${status}) — the launch may still have finished server-side; check the Tasks drawer / Ads Manager before retrying`,
      creativeConsumed: true,
    };
  }
  return { ok: false, text: `launch rejected (HTTP ${status}) — no readable reply from the server`, creativeConsumed: false };
}

/** Is this reply the NDJSON run (vs a plain JSON rejection / a platform error page)? */
export function isLaunchStream(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("ndjson");
}
