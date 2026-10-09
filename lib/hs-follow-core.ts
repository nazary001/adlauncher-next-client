// The follow-up of a LION duplicate / JURO wave — the old phase 2 of /api/hs/duplicate and
// /api/hs/jurar (poll creation-status + the details/ reality check, rename the newborn, detect the
// Meta walls, ACTIVATE a born-PAUSED clone, finish the rows) as a PURE algorithm with every side
// effect injected. Since 09.10 it runs as a durable queue job (hs.dup.follow / hs.jurar.follow) in
// slices (lib/launch-queue-runners): a slice polls for a while, then the job is deferred and the
// next slice starts from the ROWS (a settled shot has a terminal row; a known clone id is on its
// row), so a slice can run again after a lost lease without doubling anything — every write here is
// idempotent (activate tolerates "already active", a repeated rename is the same name, a done row is
// written only over a still-open row).
//
// Kept verbatim from the pumps: the clone is activated only after COMPLETED (or the reality check
// finds its ads); a bid read-back mismatch parks it PAUSED instead; a JURO shell that hits a Meta
// wall is paused best-effort; a wall that is about the ACCOUNT settles every pending shot bound to
// that account, a family wall the source's other copies; NO_COUNTRIES_LEFT is final.
// Relative `.ts` imports only (node --test loads this straight from disk).

export type FollowMode = "dup" | "jurar";

/** One submitted shot the follow-up watches. */
export type FollowShot = {
  taskId: string;
  lionTaskId: string;
  /** The born campaign's id once known (from the row). */
  cloneId: string | null;
  /** The board's exact name for the post-birth rename ("" = keep LION's own). */
  name: string;
  /** The destination ad account (the rename's signer picks a bearer by it; account walls key on it). */
  account: string;
  /** A duplicate's bid read-back mismatch (hs.dup): park PAUSED at completion instead of activating. */
  biddingMismatch: string | null;
  /** The source campaign (family walls). */
  campaignId: string;
  /** The rename already landed (or was given up) in an earlier slice. */
  renamed: boolean;
};

export type LionTaskRead = { task_id: string; campaign_id?: string | null; ad_ids?: string[]; status: string; error?: { message?: string } | null };

export type FollowDeps = {
  creationStatus(taskIds: string[]): Promise<LionTaskRead[]>;
  campaignAds(campaignIds: string[]): Promise<Record<string, { status: string; adsCount: number }>>;
  /** lionActivateWithRetry — "already active" counts as ok. */
  activate(campaignId: string): Promise<{ ok: boolean; message?: string; attempts: number }>;
  pause(campaignId: string): Promise<boolean>;
  /** Graph rename to the board's exact name — null when the team has no FB token to sign it. */
  rename: ((campaignId: string, name: string, account: string) => Promise<boolean>) | null;
  /** Is this rename failure transient (try again next tick) or final (keep LION's name)? */
  transientRenameError(message: string): boolean;
  /** Write over the shot's row while it is still OPEN (patchOpenTaskRow semantics). True = written. */
  writeOpen(taskId: string, fields: Record<string, unknown>): Promise<boolean>;
  /** Write over the shot's row while it sits on the bid gate (stage "bid-gate"). True = written. */
  writeBidGate(taskId: string, fields: Record<string, unknown>): Promise<boolean>;
  /** Meta's min-ROAS wall inside a task error (lib/lion-dup-bid lionRoasWall). */
  roasWall(message: string | null | undefined): string | null;
  /** The JURO walls (lib/juro juroBlockingError). */
  blockingError(message: string | null | undefined): { reason: string; scope: "account" | "family" } | null;
  acctKey(account: string): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(msg: string): void;
};

export type FollowSliceOpts = {
  /** The slice ends here — nothing new is asked past it. */
  sliceEndAt: number;
  mode: FollowMode;
  pollMs?: number;
  realityEveryMs?: number;
};

export type FollowSliceResult = {
  /** Task ids settled in this slice (terminal rows written). */
  settled: string[];
  /** Shots still pending at the end of the slice. */
  pending: FollowShot[];
  /** Shots whose rename landed / was given up in this slice (the caller remembers it). */
  renamed: string[];
};

/**
 * One slice of a wave's follow-up over `shots` (the submitted, still-open ones). Returns what it
 * settled and what is still pending. Never throws: a LION / store blip ends the tick and the next
 * tick (or the next slice) asks again.
 */
export async function runHsFollowSlice(shots: FollowShot[], deps: FollowDeps, opts: FollowSliceOpts): Promise<FollowSliceResult> {
  const pollMs = opts.pollMs ?? 10_000;
  const realityEveryMs = opts.realityEveryMs ?? 40_000;
  const pending = new Map(shots.map((s) => [s.taskId, { ...s }]));
  const settled: string[] = [];
  const renamed: string[] = [];
  const now = () => deps.now();

  const settle = (taskId: string) => {
    pending.delete(taskId);
    settled.push(taskId);
  };

  /** A finished clone: activate it (dup: unless its bidding mismatched — then park it PAUSED;
   *  jurar: born ACTIVE, the activate is a belt that also heals a PAUSED birth) and close the row. */
  const finalize = async (s: FollowShot, cloneId: string, adCount: number): Promise<void> => {
    if (opts.mode === "dup" && s.biddingMismatch) {
      await deps.pause(cloneId).catch(() => false);
      const row = {
        status: "error",
        error: `${s.biddingMismatch} — clone left PAUSED; verify its bidding in LION / Ads Manager before activating`,
        campaign_id: cloneId,
        ad_id: String(adCount),
        finished_at: now(),
      };
      // The submit parked the row on the bid gate already (terminal): the ids land over that.
      if (!(await deps.writeBidGate(s.taskId, row).catch(() => false))) await deps.writeOpen(s.taskId, { ...row, stage: "bid-gate" }).catch(() => false);
      settle(s.taskId);
      return;
    }
    // "does not have permission" = already active = success (playbook); "Campaign not found" =
    // LION's store hasn't synced the newborn yet — retried by the helper so a born-PAUSED clone
    // can't stay paused under a green row.
    const act = await deps.activate(cloneId).catch((e) => ({ ok: false, message: String((e as Error).message ?? e), attempts: 0 }));
    if (!act.ok) {
      deps.log?.(`activate ${cloneId} failed after ${act.attempts} attempt(s): ${act.message ?? ""}`);
      // The chain exists; the buyer flips it by hand. Said on the row — never a silent green "done".
      const note = `activation failed — flip it ACTIVE in LION (${(act.message ?? "unknown").slice(0, 200)})`;
      await deps.writeOpen(s.taskId, { status: "done", stage: "ads", campaign_id: cloneId, ad_id: String(adCount), error: note, finished_at: now() }).catch(() => false);
      settle(s.taskId);
      return;
    }
    await deps.writeOpen(s.taskId, { status: "done", stage: "ads", campaign_id: cloneId, ad_id: String(adCount), error: null, finished_at: now() }).catch(() => false);
    settle(s.taskId);
  };

  /** A wall answer settles a shot as failed; a JURO shell is born ACTIVE, so a best-effort pause
   *  rides along (LION 404s status/ on 0-ad shells — reported honestly). */
  const settleWall = async (s: FollowShot, reason: string): Promise<void> => {
    let note = "";
    if (s.cloneId) {
      const paused = await deps.pause(s.cloneId).catch(() => false);
      note = opts.mode === "jurar" ? (paused ? " Shell campaign paused." : " Shell campaign left ACTIVE with 0 ads ($0) — LION can't pause ad-less shells; delete it in the UI.") : "";
    }
    await deps.writeOpen(s.taskId, { status: "error", error: (reason + note).slice(0, 1000), ...(s.cloneId ? { campaign_id: s.cloneId } : {}), finished_at: now() }).catch(() => false);
    settle(s.taskId);
  };

  let lastReality = 0;
  while (pending.size > 0 && now() < opts.sliceEndAt) {
    try {
      const list = [...pending.values()];
      const tasks = await deps.creationStatus([...new Set(list.map((s) => s.lionTaskId))]);
      const byId = new Map(tasks.map((t) => [String(t.task_id ?? ""), t]));
      let accountWall: { reason: string; account: string } | null = null;
      for (const s of list) {
        if (!pending.has(s.taskId)) continue; // settled by a family / account sweep in this pass
        const r = byId.get(s.lionTaskId);
        if (!r) continue;
        if (r.campaign_id && !s.cloneId) {
          s.cloneId = String(r.campaign_id);
          // Persist the clone id the moment it exists: if LION then takes HOURS and prunes the
          // finished record, a later slice still finds the campaign via the reality check.
          await deps.writeOpen(s.taskId, { campaign_id: s.cloneId }).catch(() => false);
        }
        // The board's EXACT name onto the born clone (owner ask 09-09) — a campaign-level Graph
        // write; transient misses retry next tick, final walls give up quietly.
        if (s.cloneId && s.name && !s.renamed && deps.rename) {
          try {
            await deps.rename(s.cloneId, s.name, s.account);
            s.renamed = true;
            renamed.push(s.taskId);
          } catch (e) {
            const msg = String((e as Error).message ?? e);
            if (!deps.transientRenameError(msg)) {
              s.renamed = true;
              renamed.push(s.taskId);
              deps.log?.(`rename ${s.cloneId} kept LION's name: ${msg.slice(0, 160)}`);
            }
          }
        }
        const errText = r.error?.message;
        if (opts.mode === "dup") {
          // Meta's min-ROAS eligibility rejection: LION retries the requested strategy forever —
          // settle now with the reason; a born shell stays PAUSED. (A COMPLETED task may still
          // carry its LAST error text — only an in-progress task is a wall.)
          const wall = r.status === "COMPLETED" ? null : deps.roasWall(errText);
          if (wall) {
            if (s.cloneId) await deps.pause(s.cloneId).catch(() => false);
            await deps.writeOpen(s.taskId, { status: "error", error: wall, ...(s.cloneId ? { campaign_id: s.cloneId } : {}), finished_at: now() }).catch(() => false);
            settle(s.taskId);
            continue;
          }
        }
        if (r.status === "COMPLETED" && r.campaign_id) {
          await finalize(s, String(r.campaign_id), (r.ad_ids ?? []).length || 1);
          continue;
        }
        if (r.status === "NO_COUNTRIES_LEFT") {
          await deps.writeOpen(s.taskId, { status: "error", error: "LION: no eligible countries left for this campaign", finished_at: now() }).catch(() => false);
          settle(s.taskId);
          continue;
        }
        if (opts.mode === "jurar") {
          // Non-transient Meta walls in the task's retry loop → settle now with the real reason
          // instead of spinning until the cap (the certification loop is endless).
          const wall = r.status === "COMPLETED" ? null : deps.blockingError(errText);
          if (wall) {
            await settleWall(s, wall.reason);
            if (wall.scope === "account") accountWall = { reason: wall.reason, account: deps.acctKey(s.account) };
            else for (const sib of [...pending.values()].filter((x) => x.campaignId === s.campaignId)) await settleWall(sib, wall.reason);
          }
        }
        // NOT_FOUND / CREATING_*: the reality check below settles them (task records wedge and
        // prune — live 08-13); anything left waits for the next tick / slice.
      }
      if (accountWall) {
        // An account wall (certification) kills every pending shot bound to THAT account — rows on
        // other destinations keep going (per-row destinations 09-08).
        for (const s of [...pending.values()].filter((x) => deps.acctKey(x.account) === accountWall!.account)) await settleWall(s, accountWall.reason);
      }
      if (now() - lastReality > realityEveryMs) {
        lastReality = now();
        const ids = [...new Set([...pending.values()].filter((s) => s.cloneId).map((s) => s.cloneId as string))];
        if (ids.length > 0) {
          const real = await deps.campaignAds(ids).catch(() => ({}) as Record<string, { status: string; adsCount: number }>);
          for (const s of [...pending.values()].filter((x) => x.cloneId)) {
            const c = real[s.cloneId as string];
            if (c && c.adsCount > 0) await finalize(s, s.cloneId as string, c.adsCount);
          }
        }
      }
    } catch (e) {
      deps.log?.(`follow tick failed: ${(e as Error).message ?? String(e)}`); // transient LION/store blip — next tick retries
    }
    if (pending.size === 0 || now() >= opts.sliceEndAt) break;
    await deps.sleep(Math.min(pollMs, Math.max(0, opts.sliceEndAt - now())));
  }
  return { settled, pending: [...pending.values()], renamed };
}
