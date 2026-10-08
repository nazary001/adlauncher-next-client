"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { UploadingNotice } from "./upload-guard";
import { type Campaign, bidTag, moneyLabel } from "@/lib/types";
import { type PartnerId, partnerConfig } from "@/lib/partners";
import type { CloneEdit } from "@/lib/clone";
import {
  type EffStatus,
  type LaunchTask,
  type TaskKind,
  type TaskStatus,
  type ViewTask,
  effStatusOf,
  fromRemote,
  isCanceled,
  mergeShared,
  ownerHue,
  ownerLastWrite,
} from "@/lib/task-view";
import type { QueueKind, QueueScope } from "@/lib/launch-queue-types";
import { cancelQueued, isHandoffUnconfirmed, retryQueued, sendToQueue } from "./launch-queue-client";
import { ensureCreativeUploaded } from "./creative-uploads";
import { handoffBegin, handoffPatch, useHandoffItems, useHandoffPending } from "./launch-handoff";
import type { SessionUser } from "./user-menu";
import { AlertIcon, CheckIcon, CopyIcon, RetryIcon, RocketIcon, TasksIcon, XIcon } from "./icons";

export type { LaunchTask } from "@/lib/task-view";

// ---------- stages (per task kind) ----------

type StageDef = { key: string; label: string };

// Launch pipeline. The wave no longer uploads from this tab (creatives go to S3 at attach time and
// the server pump runs the job): the first segment is now "Queued on the server" — lit while the
// row is queued — and the rest mirror the launch route's NDJSON stages the server pump reads.
// Media-neutral labels: the "video" stage registers either kind (image launches skip "processing").
const LAUNCH_STAGES: readonly StageDef[] = [
  { key: "queued", label: "Queued on the server" },
  { key: "gcm", label: "Reserving code" },
  { key: "video", label: "Registering media" },
  { key: "processing", label: "Processing video" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

// Clone pipeline — mirrors the clone run route's stage events; the source media is reused by id, so
// no upload. "media" fires only for cross-account clones (the source video/image is re-homed in the
// target account first); same-account clones skip straight from source to gcm.
const CLONE_STAGES: readonly StageDef[] = [
  { key: "source", label: "Reading source" },
  { key: "media", label: "Migrating media" },
  { key: "gcm", label: "Reserving code" },
  { key: "campaign", label: "Creating campaign" },
  { key: "adset", label: "Creating ad set" },
  { key: "creative", label: "Building creative" },
  { key: "ad", label: "Publishing ad" },
];

// ---- shared-view cadence ----
// The whole team's queue refreshes continuously — the header badge and drawer must be truthful at
// any moment, not only while the drawer is open (drawer open polls faster for live stage motion).
// Raised 2026-08-24 (4s/12s → 8s/24s): dozens of buyers polling every 4s overloaded the shared
// store (503→504 incident); the server route now also short-caches the team list, so a slightly
// slower poll costs no freshness the cache wouldn't have eaten anyway.
const POLL_OPEN_MS = 8_000;
const POLL_CLOSED_MS = 24_000;
// Coarse re-render tick so stale detection advances with time even with the drawer closed. (srv
// rows are never stale, but teammates' legacy/offline rows and the optimistic-row sweep still key
// on the clock.)
const TICK_MS = 10_000;
// Ids deleted here are ignored in merges briefly, so an in-flight fetch can't resurrect them.
const TOMBSTONE_MS = 60_000;
// An accepted job's optimistic row survives this long without appearing in the polled list before
// it is dropped: the team list is short-cached ~4s server-side, so a poll taken just before the
// hand-off's row write landed must not make the just-queued row blink out.
const OPTIMISTIC_TTL_MS = 30_000;

function stagesFor(kind: TaskKind): readonly StageDef[] {
  return kind === "clone" ? CLONE_STAGES : LAUNCH_STAGES;
}
function stageIndexFor(kind: TaskKind, stage: string | null): number {
  if (!stage) return 0;
  const i = stagesFor(kind).findIndex((s) => s.key === stage);
  return i < 0 ? 0 : i;
}

/** Account id as the launch-limit meters it (strip act_, trim). */
const stripAct = (raw: string | null | undefined): string => String(raw ?? "").trim().replace(/^act_/, "");
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const mintId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) + Date.now().toString(36);

// ---------- task model ----------

/** One creative captured at enqueue (session-local object URLs). */
export type QueuedMedia = {
  url: string;
  name: string;
  kind: "video" | "image";
  /** Custom cover for a VIDEO creative — uploaded next to it and pinned as the ad's thumbnail. */
  cover?: { url: string; name: string };
};

// Per-account key: several people share machines/browsers, and the fallback snapshot must not
// leak one account's queue into another. The bare legacy key predates scoping and gets dropped.
const LS_BASE = "adlauncher.tasks";
const lsKeyFor = (user: SessionUser | undefined, base: string) =>
  user?.username ? `${base}.${user.username}` : base;

export type EnqueueArgs = {
  partnerId: PartnerId;
  campaign: Campaign;
  /** Retired MO soc-signer switch — NOT forwarded to the queue any more (the server resolves the
   *  rail's signer from /tokens). Kept on the type so older callers type-check; ignored here. */
  channel?: string;
  /** TOOL launch channel (see spec §5.1 / owner ask 28.09) — forwarded to the handler body as
   *  `via` when the board's TOOL rail is the effective channel for this MO/AIF/AV wave. */
  via?: "tool";
  /** All creatives (1..partner.maxCreatives); when absent the single-media fields drive alone. */
  medias?: QueuedMedia[];
  mediaUrl: string;
  mediaName: string;
  mediaKind: "video" | "image";
  /** Custom cover image for a video creative. */
  cover?: { url: string; name: string };
  name: string;
  gcm: string;
  geo: string;
  budget: string;
};

export type CloneEnqueueArgs = {
  partnerId: PartnerId;
  edit: CloneEdit;
  /** MO clone signer: "soc:<name>" — forwarded in the queued job body to the clone handler verbatim
   *  (the system token is retired there; MO clones without a signer are rejected server-side). AIF/AV
   *  send none. */
  channel?: string;
  /** TOOL clone channel (see CloneEnqueueArgs usage) — forwarded to the handler body as `via`. */
  via?: "tool";
  name: string;
  geo: string;
  budget: string;
  /** Display-only bid/ROAS tag for the card (bidTag of the row's picked strategy + Bid value,
   *  computed on the board). */
  bid?: string;
};

type TaskManagerValue = {
  /** The shared team list, each task with its display status (`eff`) resolved. Newest first. */
  tasks: ViewTask[];
  counts: {
    queued: number;
    running: number;
    done: number;
    error: number;
    active: number;
    total: number;
    /** What still depends on THIS tab: campaigns of this scope still uploading their creatives or
     *  being handed over (useHandoffPending). Once the server accepts a job, nothing here holds the
     *  page — the server runs it. 0 the rest of the time. */
    inFlight: number;
  };
  /** The current user — used to label task owners and gate own-only actions in the shared view. */
  me: string | null;
  open: boolean;
  setOpen: (v: boolean) => void;
  enqueue: (args: EnqueueArgs) => void;
  enqueueClone: (args: CloneEnqueueArgs) => void;
  /** Re-queue one own failed/canceled row the server flagged `retry` (a row without the flag has
   *  no Retry affordance — the server decided it is not safe to re-run). */
  retry: (id: string) => void;
  /** Re-queue every own row the server flagged `retry`. */
  retryAll: () => void;
  /** Cancel one own QUEUED server row before it starts. */
  cancel: (id: string) => void;
  /** Cancel every own queued server row of this scope. */
  cancelAllQueued: () => void;
};

const Ctx = createContext<TaskManagerValue | null>(null);

export function useTaskManager(): TaskManagerValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTaskManager must be used within TaskManagerProvider");
  return v;
}

// AIF runs an IDENTICAL queue/drawer as a fully SEPARATE instance (own context, own store scope
// partner="us", own localStorage) — owner call 08-17: every partner gets its own task manager;
// the team "Tasks" drawer stays MO-only, "HS Tasks" stays LION's.
const AifCtx = createContext<TaskManagerValue | null>(null);

export function useAifTaskManager(): TaskManagerValue {
  const v = useContext(AifCtx);
  if (!v) throw new Error("useAifTaskManager must be used within AifTaskManagerProvider");
  return v;
}

// AV runs the SAME queue/drawer as a fully SEPARATE instance (own context, own store scope
// partner="av", own localStorage) — the AIF twin pattern again (owner call 28.09: every partner
// gets its own task manager). use-acct-limit folds this instance's queued demand into the shared
// per-account launch limit, so it is mounted ABOVE AcctLimitProvider in the (app) layout.
const AvCtx = createContext<TaskManagerValue | null>(null);

export function useAvTaskManager(): TaskManagerValue {
  const v = useContext(AvCtx);
  if (!v) throw new Error("useAvTaskManager must be used within AvTaskManagerProvider");
  return v;
}

/** Everything scope-specific about one task-manager instance. `api` serves the GET list only — the
 *  client never POSTs task rows any more (the server queue owns every row); the query param scopes
 *  the list on GET. `queueScope` is the drawer's lane in the server queue and the hand-off screen. */
type TmScope = {
  api: string;
  lsBase: string;
  /** mo | aif | av — the server launch-queue scope AND the hand-off screen scope. */
  queueScope: QueueScope;
  /** Header button caption. */
  label: string;
  title: string;
  subtitle: string;
  /** A dormant rail's instance never talks to the server (no restore fetch, no poll) — the same
   *  rule the Snap rail follows: a build without the rail's flag must not generate store traffic
   *  for a queue nobody can fill (AV while NEXT_PUBLIC_AV_ENABLED is unset). */
  dormant?: boolean;
};
const MO_SCOPE: TmScope = {
  api: "/api/launch-tasks",
  lsBase: LS_BASE,
  queueScope: "mo",
  label: "Tasks",
  title: "Task Manager",
  subtitle: "Team launch & clone queue",
  // Dormant when MO is not this team's partner (lib/team) — the server already 404s its routes, so
  // a polling instance would just collect 404s. Keyed on `hidden`, NOT inDevelopment, so glo-01
  // (where MO is always a partner) is unchanged.
  dormant: partnerConfig("in").hidden === true,
};
const AIF_SCOPE: TmScope = {
  api: "/api/launch-tasks?scope=aif",
  lsBase: "adlauncher.aiftasks",
  queueScope: "aif",
  label: "AIF Tasks",
  title: "AIF Task Manager",
  subtitle: "AIF launch queue · team view",
  // Dormant when AIF is not this team's partner (lib/team) — `hidden`, NOT inDevelopment, so glo-01
  // keeps polling AIF even while it is env-gated "in development" there, exactly as it does today.
  dormant: partnerConfig("us").hidden === true,
};
const AV_SCOPE: TmScope = {
  api: "/api/launch-tasks?scope=av",
  lsBase: "adlauncher.avtasks",
  queueScope: "av",
  label: "AV Tasks",
  title: "AV Task Manager",
  subtitle: "AV launch queue · team view",
  // Build-time flag (NEXT_PUBLIC_AV_ENABLED inlined): a dormant AV rail never polls the store.
  dormant: partnerConfig("av").inDevelopment === true,
};

// ---------- provider ----------
// Mounted ONCE in the (app) layout, above both boards — the drawer and the team poll survive
// navigating between the launcher and the clone board. Launches/clones are no longer RUN here: the
// boards call enqueue/enqueueClone, which upload the creatives (if not already done), hand the job
// to the server queue and drop an optimistic row; the server pump builds every campaign.

export function TaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  return (
    <TaskManagerCore user={user} scope={MO_SCOPE} ctx={Ctx}>
      {children}
    </TaskManagerCore>
  );
}

/** The AIF twin — mounted alongside in the (app) layout; boards pick the instance by partner. */
export function AifTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  return (
    <TaskManagerCore user={user} scope={AIF_SCOPE} ctx={AifCtx}>
      {children}
    </TaskManagerCore>
  );
}

/** The AV twin — mounted alongside in the (app) layout; boards pick the instance by partner. */
export function AvTaskManagerProvider({ children, user }: { children: React.ReactNode; user?: SessionUser }) {
  return (
    <TaskManagerCore user={user} scope={AV_SCOPE} ctx={AvCtx}>
      {children}
    </TaskManagerCore>
  );
}

function TaskManagerCore({
  children,
  user,
  scope,
  ctx,
}: {
  children: React.ReactNode;
  user?: SessionUser;
  scope: TmScope;
  ctx: React.Context<TaskManagerValue | null>;
}) {
  const lsKey = lsKeyFor(user, scope.lsBase);
  const me = user?.username ?? null;
  // The fetched team list (server-owned rows). No "local" rows live here any more — a tab's own
  // just-handed-over launches live in `optimistic` until the poll catches up.
  const [tasks, setTasks] = useState<LaunchTask[]>([]);
  const [open, setOpen] = useState(false);
  // Coarse clock for staleness re-evaluation (stale is derived, so it must advance with time) and
  // for the optimistic-row sweep.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const openRef = useRef(false);
  const loadedRef = useRef(false);
  // Server-clock skew measured at fetch time (server `now` − client now): owner liveness is judged
  // on the server clock so wrong local clocks can't fake or mask a dead session.
  const [skew, setSkew] = useState(0);
  const noteSkew = useCallback((serverNow: number) => {
    const s = serverNow - Date.now();
    setSkew((prev) => (Math.abs(prev - s) > 3000 ? s : prev));
  }, []);
  const tombstones = useRef(new Map<string, number>());
  const authDeadRef = useRef(false);
  const lastPollRef = useRef(0);

  // Optimistic rows: added the moment a hand-off is ACCEPTED, so the drawer shows the just-queued
  // campaign at once instead of waiting for the ~4s-cached team list. Display-only — the server
  // owns the real row. Each is dropped once the polled list carries its id, or after
  // OPTIMISTIC_TTL_MS. State (not a ref) so the render can read it — the React-Compiler lint forbids
  // reading a ref during render, and a stale optimistic row could otherwise mask a real one.
  const [optimistic, setOptimistic] = useState<LaunchTask[]>([]);
  // An optimistic row's lifetime counts from the moment it is ADDED (the server accepted it), not
  // from the Launch click: after an upload longer than the TTL the row used to be born already
  // expired and blink out of the drawer until the next poll (review find 08.10).
  const addOptimistic = useCallback((row: LaunchTask) => {
    const stamped: LaunchTask = { ...row, optimisticAt: Date.now() };
    setOptimistic((rows) => (rows.some((r) => r.id === row.id) ? rows : [...rows, stamped]));
  }, []);

  /** Pull the whole team's tasks and merge them in. Every row mirrors the fetch (so a teammate's
   *  dismiss disappears here too); nothing is authoritative on the client — the server owns the rows. */
  const loadRemote = useCallback(() => {
    // Bounded like the HS drawer's poll (20s): a hung store read must not pile up open polls.
    fetch(scope.api, { signal: AbortSignal.timeout(20_000) })
      .then(async (r) => {
        if (r.status === 401) {
          // Session died — stop hammering; the next focus/visibility re-arms polling.
          authDeadRef.current = true;
          return;
        }
        const d = (await r.json().catch(() => null)) as
          | { ok?: boolean; now?: number; tasks?: Record<string, unknown>[] }
          | null;
        if (!d?.ok || !Array.isArray(d.tasks)) return;
        if (typeof d.now === "number") noteSkew(d.now);
        const cutoff = Date.now() - TOMBSTONE_MS;
        for (const [id, ts] of tombstones.current) if (ts < cutoff) tombstones.current.delete(id);
        const fetched = d.tasks.map(fromRemote);
        const tomb = new Set(tombstones.current.keys());
        // A tombstoned id still coming back means the delete hasn't landed — keep it buried.
        for (const f of fetched) if (f.id && tomb.has(f.id)) tombstones.current.set(f.id, Date.now());
        setTasks((cur) => mergeShared(cur, fetched, tomb));
      })
      .catch(() => {});
  }, [noteSkew, scope.api]);

  // Restore once on mount: the team's server list wins; localStorage is the offline fallback.
  useEffect(() => {
    let localSnap: LaunchTask[] = [];
    try {
      const raw = localStorage.getItem(lsKey);
      // A restored snapshot row is display-only (it can never be the authoritative live row again).
      if (raw) localSnap = (JSON.parse(raw) as LaunchTask[]).map((t) => ({ ...t, local: false }));
      // Pre-scoping snapshot was account-agnostic — drop it so it can't surface for the wrong user.
      if (lsKey !== scope.lsBase) localStorage.removeItem(scope.lsBase);
    } catch {
      /* ignore */
    }
    if (scope.dormant) {
      loadedRef.current = true;
      return;
    }
    let alive = true;
    fetch(scope.api)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.ok && Array.isArray(d.tasks)) {
          if (typeof d.now === "number") noteSkew(d.now);
          const fetched = (d.tasks as Record<string, unknown>[]).map(fromRemote);
          setTasks((cur) => mergeShared(cur, fetched));
        } else {
          setTasks((cur) => mergeShared(cur, localSnap));
        }
      })
      .catch(() => {
        if (alive) setTasks((cur) => mergeShared(cur, localSnap));
      })
      .finally(() => {
        loadedRef.current = true;
        lastPollRef.current = Date.now();
      });
    return () => {
      alive = false;
    };
  }, [lsKey, noteSkew, scope.api, scope.lsBase, scope.dormant]);

  // Live shared view: poll continuously (faster with the drawer open), pause while the tab is
  // hidden, refresh immediately on focus/visible — the badge is truthful at any moment.
  useEffect(() => {
    if (scope.dormant) return;
    const tick = () => {
      if (document.hidden || authDeadRef.current) return;
      const interval = openRef.current ? POLL_OPEN_MS : POLL_CLOSED_MS;
      if (Date.now() - lastPollRef.current < interval - 500) return;
      lastPollRef.current = Date.now();
      loadRemote();
    };
    const iv = window.setInterval(tick, POLL_OPEN_MS);
    const wake = () => {
      authDeadRef.current = false;
      lastPollRef.current = Date.now();
      loadRemote();
    };
    const onVis = () => {
      if (!document.hidden) wake();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadRemote, scope.dormant]);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      lastPollRef.current = Date.now();
      loadRemote();
    }
  }, [open, loadRemote]);

  // Staleness (and the optimistic sweep) advance with time even when nothing refetches.
  useEffect(() => {
    const iv = window.setInterval(() => setNowTick(Date.now()), TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  // Drop an optimistic row once the polled list carries its id (the server wrote the real row) or
  // after OPTIMISTIC_TTL_MS (a hand-off whose row never showed — the sweep keeps a dead stub from
  // lingering). Runs on every poll and on the coarse tick. Safe setState-in-effect: the functional
  // updater returns the SAME array when nothing is dropped (no re-render, no cascade), and
  // `optimistic` is not a dependency of this effect, so a drop can't re-trigger it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOptimistic((rows) => {
      if (rows.length === 0) return rows;
      const have = new Set(tasks.map((t) => t.id));
      const cutoff = Date.now() - OPTIMISTIC_TTL_MS;
      const next = rows.filter((r) => !have.has(r.id) && (r.optimisticAt ?? r.queuedAt) >= cutoff);
      return next.length === rows.length ? rows : next;
    });
  }, [tasks, nowTick]);

  // Mirror to localStorage after the initial load (guard prevents the empty first render from
  // wiping the stored snapshot before restore reads it). The snapshot is an offline fallback only.
  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      localStorage.setItem(lsKey, JSON.stringify(tasks));
    } catch {
      /* quota / disabled — the server still holds the durable copy */
    }
  }, [tasks, lsKey]);

  // ---- hand-off: enqueue / enqueueClone no longer run anything (spec §5.1) ----

  // A hand-off this tab marked FAILED whose row the server nevertheless holds: the reply was lost
  // on the way back, not the campaign. The server has it — clear the alarm, or the buyer is left
  // looking at "not confirmed" for a launch that is in fact running (and tempted to fire it again).
  const handoffItems = useHandoffItems();
  useEffect(() => {
    for (const it of handoffItems) {
      if (it.scope !== scope.queueScope || it.phase !== "failed") continue;
      const row = tasks.find((t) => t.id === it.id);
      // "Not accepted by the queue" is the server's own marker for a job it could NOT store.
      if (row?.srv && !(row.status === "error" && /^Not accepted by the queue/.test(row.error ?? ""))) {
        handoffPatch(it.id, { phase: "accepted", error: null, retry: null });
      }
    }
  }, [handoffItems, tasks, scope.queueScope]);

  /** A failed hand-off: say why; when no verdict came back, look for the server's row now and again
   *  once its short list cache has turned over. */
  const failHandoff = useCallback(
    (id: string, e: unknown, retry: () => void) => {
      const unsure = isHandoffUnconfirmed(e);
      handoffPatch(id, { phase: "failed", error: errMsg(e), retry, uncertain: unsure });
      if (unsure) {
        loadRemote();
        window.setTimeout(loadRemote, 6_000);
      }
    },
    [loadRemote],
  );

  const enqueue = useCallback(
    (args: EnqueueArgs) => {
      const id = mintId();
      const queuedAt = Date.now();
      const cfg = partnerConfig(args.partnerId);
      const kind: QueueKind = cfg.avLaunch ? "av.launch" : cfg.aifLaunch ? "aif.launch" : "mo.launch";
      const bid = bidTag(args.campaign.bidStrategy, args.campaign.bidCap) || undefined;
      const account = stripAct(args.campaign.account) || undefined;
      // Everything this launch ships (1..maxCreatives): the multi shape when present, else the
      // legacy single-media fields (restored tasks / older enqueues).
      const medias: QueuedMedia[] =
        args.medias && args.medias.length > 0
          ? args.medias
          : [{ url: args.mediaUrl, name: args.mediaName, kind: args.mediaKind, cover: args.cover }];
      // Every file this campaign waits on (creatives + their video covers), as creative-uploads
      // sources (session object URLs) — the hand-off screen reads their live upload progress from
      // these. A cover only ever rides a video (same guard the upload below uses), so the source
      // list is exactly the set of files that get uploaded.
      const sources: string[] = [];
      for (const m of medias) {
        sources.push(m.url);
        if (m.cover && m.kind === "video") sources.push(m.cover.url);
      }

      const run = async () => {
        try {
          handoffBegin([{ id, scope: scope.queueScope, label: args.name, sub: `${args.geo} · $${moneyLabel(args.budget)}`, sources, account }]);
          // Usually already done — the Dropzone started each upload at attach; this just takes the
          // remote URL (or finishes a straggler). A dead handle / expired login / network failure
          // rejects here with a complete, creative-named sentence (creative-uploads).
          const remote = await Promise.all(
            medias.map(async (m) => {
              const url = await ensureCreativeUploaded(m.url, { name: m.name, kind: m.kind });
              const coverUrl =
                m.cover && m.kind === "video"
                  ? await ensureCreativeUploaded(m.cover.url, { name: m.cover.name || "cover.jpg", kind: "image" })
                  : undefined;
              return { url, kind: m.kind, ...(coverUrl ? { coverUrl } : {}) };
            }),
          );
          const first = remote[0];
          // Exactly the body the browser used to POST for a launch, minus the task id (the server
          // stamps it). The retired soc `channel` is NOT sent for launches; the multi shape + legacy
          // single-media fields ride together so a mid-deploy server on either side keeps working.
          const body: Record<string, unknown> = {
            partnerId: args.partnerId,
            campaign: args.campaign,
            ...(args.via ? { via: args.via } : {}),
            medias: remote,
            mediaUrl: first.url,
            mediaKind: first.kind,
            ...(first.coverUrl ? { coverUrl: first.coverUrl } : {}),
          };
          handoffPatch(id, { phase: "sending" });
          await sendToQueue(scope.queueScope, {
            taskId: id,
            kind,
            body,
            row: { name: args.name, gcm: args.gcm, geo: args.geo, budget: args.budget, bid: bid ?? "" },
            account: account ?? null,
          });
          handoffPatch(id, { phase: "accepted" });
          addOptimistic({
            id,
            kind: "launch",
            owner: me,
            name: args.name,
            partner: args.partnerId,
            gcm: args.gcm,
            geo: args.geo,
            budget: args.budget,
            ...(bid ? { bid } : {}),
            status: "queued",
            stage: null,
            srv: true,
            account,
            queuedAt,
          });
          loadRemote();
        } catch (e) {
          failHandoff(id, e, run);
        }
      };
      void run();
    },
    [me, scope.queueScope, loadRemote, addOptimistic, failHandoff],
  );

  const enqueueClone = useCallback(
    (args: CloneEnqueueArgs) => {
      const id = mintId();
      const queuedAt = Date.now();
      const bid = args.bid || undefined;
      const account = stripAct(args.edit.accountId) || undefined;
      // The clone reuses the source's media by id (server-side) — no uploads, so the hand-off opens
      // straight at "sending". The server adds taskIds to the body.
      const body: Record<string, unknown> = {
        partnerId: args.partnerId,
        edits: [args.edit],
        ...(args.channel ? { channel: args.channel } : {}),
        ...(args.via ? { via: args.via } : {}),
      };

      const run = async () => {
        try {
          handoffBegin([{ id, scope: scope.queueScope, label: args.name, sub: `${args.geo} · $${moneyLabel(args.budget)}`, sources: [], account, phase: "sending" }]);
          await sendToQueue(scope.queueScope, {
            taskId: id,
            kind: "fb.clone",
            body,
            row: { name: args.name, gcm: "", geo: args.geo, budget: args.budget, bid: bid ?? "" },
            account: account ?? null,
          });
          handoffPatch(id, { phase: "accepted" });
          addOptimistic({
            id,
            kind: "clone",
            owner: me,
            name: args.name,
            partner: args.partnerId,
            gcm: "",
            geo: args.geo,
            budget: args.budget,
            ...(bid ? { bid } : {}),
            status: "queued",
            stage: null,
            srv: true,
            account,
            queuedAt,
          });
          loadRemote();
        } catch (e) {
          failHandoff(id, e, run);
        }
      };
      void run();
    },
    [me, scope.queueScope, loadRemote, addOptimistic, failHandoff],
  );

  // Display statuses resolved against owner liveness (srv rows are never stale — the server owns
  // them). nowTick is the render-safe clock: it lags real time by ≤10s, which only ever DELAYS a
  // stale verdict (never fakes one). Optimistic rows whose id hasn't reached the polled list yet
  // are folded in on top.
  const view = useMemo<ViewTask[]>(() => {
    const estNow = nowTick + skew;
    const lastWrite = ownerLastWrite(tasks);
    const have = new Set(tasks.map((t) => t.id));
    const merged: LaunchTask[] = [...tasks];
    for (const row of optimistic) if (!have.has(row.id)) merged.push(row);
    merged.sort((a, b) => b.queuedAt - a.queuedAt || (a.id < b.id ? 1 : -1));
    return merged.map((t) => ({ ...t, eff: effStatusOf(t, lastWrite, estNow) }));
  }, [tasks, optimistic, nowTick, skew]);

  const viewRef = useRef<ViewTask[]>([]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // What still depends on this tab: creatives still uploading / hand-offs in flight for this scope.
  const inFlight = useHandoffPending(scope.queueScope);

  const counts = useMemo(() => {
    let queued = 0,
      running = 0,
      done = 0,
      error = 0;
    for (const t of view) {
      if (t.eff === "queued") queued++;
      else if (t.eff === "running") running++;
      else if (t.eff === "done") done++;
      else error++; // real errors + stale/interrupted + canceled
    }
    return { queued, running, done, error, active: queued + running, total: view.length, inFlight };
  }, [view, inFlight]);

  // ---- owner actions: retry / cancel are server actions now (no client decides retry safety) ----

  const isOwn = useCallback((t: LaunchTask): boolean => !!me && t.owner === me, [me]);

  // A small, dismissible error line in the drawer for a failed queue action — never an alert().
  const [actionError, setActionError] = useState<string | null>(null);

  const retry = useCallback(
    (id: string) => {
      const t = viewRef.current.find((x) => x.id === id);
      // Only an own, failed row the SERVER flagged retryable may be re-queued — the client never
      // decides retry safety.
      if (!t || t.status !== "error" || !t.retry || !isOwn(t)) return;
      retryQueued([id])
        .then(() => loadRemote())
        .catch((e) => setActionError(errMsg(e)));
    },
    [isOwn, loadRemote],
  );

  const retryAll = useCallback(() => {
    const ids = viewRef.current.filter((t) => t.status === "error" && t.retry && isOwn(t)).map((t) => t.id);
    if (ids.length === 0) return;
    retryQueued(ids)
      .then(() => loadRemote())
      .catch((e) => setActionError(errMsg(e)));
  }, [isOwn, loadRemote]);

  const cancel = useCallback(
    (id: string) => {
      const t = viewRef.current.find((x) => x.id === id);
      if (!t || t.eff !== "queued" || !t.srv || !isOwn(t)) return;
      cancelQueued({ taskIds: [id] })
        .then(() => loadRemote())
        .catch((e) => setActionError(errMsg(e)));
    },
    [isOwn, loadRemote],
  );

  const cancelAllQueued = useCallback(() => {
    cancelQueued({ scope: scope.queueScope })
      .then(() => loadRemote())
      .catch((e) => setActionError(errMsg(e)));
  }, [scope.queueScope, loadRemote]);

  const value: TaskManagerValue = {
    tasks: view,
    counts,
    me,
    open,
    setOpen,
    enqueue,
    enqueueClone,
    retry,
    retryAll,
    cancel,
    cancelAllQueued,
  };

  // No floating pill / leave-page confirm here any more: the hand-off host (LaunchHandoffHost,
  // mounted once in the layout) owns the overlay, the "still handing over" pill and the unload
  // guard for every scope — the tab is held open only while creatives upload / a hand-off is in
  // flight, never after the server has the job.
  return (
    <ctx.Provider value={value}>
      {children}
      <TaskManagerPanel
        tm={value}
        scope={scope}
        actionError={actionError}
        onDismissActionError={() => setActionError(null)}
      />
    </ctx.Provider>
  );
}

// ---------- header button ----------

export function TaskManagerButton() {
  return <TasksButtonCore tm={useTaskManager()} label={MO_SCOPE.label} />;
}

export function AifTaskManagerButton() {
  return <TasksButtonCore tm={useAifTaskManager()} label={AIF_SCOPE.label} />;
}

export function AvTaskManagerButton() {
  return <TasksButtonCore tm={useAvTaskManager()} label={AV_SCOPE.label} />;
}

function TasksButtonCore({ tm, label }: { tm: TaskManagerValue; label: string }) {
  const { counts, setOpen } = tm;
  const badge = counts.active > 0 ? counts.active : counts.error > 0 ? counts.error : 0;
  const tone =
    counts.active > 0
      ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
      : counts.error > 0
        ? "border-danger/40 bg-danger/10 text-danger"
        : "border-line bg-surface text-dim hover:border-line2 hover:bg-surface2 hover:text-ink";

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`Open ${label}`}
      className={
        "relative flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium " +
        "transition-all duration-200 active:scale-[0.96] focus-visible:outline-none " +
        "focus-visible:ring-2 focus-visible:ring-accent/40 " +
        tone
      }
    >
      <span className="relative">
        <TasksIcon className="h-4 w-4" />
        {counts.running > 0 ? (
          <span className="animate-pulse-soft absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-launch2" />
        ) : null}
      </span>
      <span className="hidden whitespace-nowrap md:max-lg:inline min-[1360px]:inline">{label}</span>
      {badge > 0 ? (
        <span
          key={badge}
          className={
            "animate-badge-pop grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold " +
            (counts.active > 0 ? "bg-accent text-white" : "bg-danger text-white")
          }
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// ---------- drawer panel ----------

type Filter = "all" | "active" | "done" | "error";
type KindFilter = "all" | "launch" | "clone";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const inBucket = (eff: EffStatus, f: Filter): boolean =>
  f === "all"
    ? true
    : f === "active"
      ? eff === "queued" || eff === "running"
      : f === "error"
        ? eff === "error" || eff === "stale"
        : eff === f;

function TaskManagerPanel({
  tm,
  scope,
  actionError,
  onDismissActionError,
}: {
  tm: TaskManagerValue;
  scope: TmScope;
  actionError: string | null;
  onDismissActionError: () => void;
}) {
  const { tasks, counts, me, open, setOpen, retry, retryAll, cancel, cancelAllQueued } = tm;
  const [filter, setFilter] = useState<Filter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || counts.running === 0) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [open, counts.running]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, setOpen]);

  if (!open) return null;

  const isMine = (t: ViewTask) => !!me && t.owner === me;

  // Retry safety is the server's call: an own failed/canceled row it flagged `retry` is retryable.
  const retryable = tasks.filter((t) => t.status === "error" && t.retry && isMine(t)).length;
  // Own queued server rows can be canceled before they start.
  const cancelable = tasks.filter((t) => t.eff === "queued" && t.srv && isMine(t)).length;

  // Mine toggle → kind split (New launches vs Duplicates) → status filter within that split.
  const scoped = mineOnly ? tasks.filter(isMine) : tasks;
  const kindTasks = kindFilter === "all" ? scoped : scoped.filter((t) => t.kind === kindFilter);
  const kc = { queued: 0, running: 0, done: 0, error: 0 };
  for (const t of kindTasks) {
    if (t.eff === "queued") kc.queued++;
    else if (t.eff === "running") kc.running++;
    else if (t.eff === "done") kc.done++;
    else kc.error++;
  }

  const shown = kindTasks.filter((t) => inBucket(t.eff, filter));

  const kinds: { key: KindFilter; label: string; icon: React.ReactNode; n: number }[] = [
    { key: "all", label: "All", icon: null, n: scoped.length },
    { key: "launch", label: "Launches", icon: <RocketIcon className="h-3.5 w-3.5" />, n: scoped.filter((t) => t.kind === "launch").length },
    { key: "clone", label: "Duplicates", icon: <CopyIcon className="h-3.5 w-3.5" />, n: scoped.filter((t) => t.kind === "clone").length },
  ];

  const tabs: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: kindTasks.length },
    { key: "active", label: "Active", n: kc.queued + kc.running },
    { key: "done", label: "Done", n: kc.done },
    { key: "error", label: "Failed", n: kc.error },
  ];

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <aside className="animate-drawer-in absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-[-20px_0_60px_rgba(0,0,0,0.5)]">
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent/25 to-accent2/25 text-[#9db8ff]">
              <TasksIcon className="h-4 w-4" />
            </span>
            <div className="leading-none">
              <h2 className="text-[14px] font-semibold text-ink">{scope.title}</h2>
              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">{scope.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* While THIS tab still has creatives uploading / a hand-off in flight it must stay open —
            say so inside the drawer too (the hand-off overlay is the primary surface; this mirrors
            its "keep the tab open" state). Once the server accepts every job, inFlight is 0. */}
        {counts.inFlight > 0 ? (
          <div className="border-b border-line px-3 py-2">
            <UploadingNotice n={counts.inFlight} />
          </div>
        ) : null}

        {/* A queue action (retry / cancel) failed — inline + dismissible, never an alert(). */}
        {actionError ? (
          <div className="flex items-start gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-[11.5px] leading-relaxed text-danger">
            <AlertIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{actionError}</span>
            <button
              type="button"
              onClick={onDismissActionError}
              aria-label="Dismiss"
              className="shrink-0 text-danger/70 transition-colors hover:text-danger"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {/* split — New launches vs Duplicates */}
        <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKindFilter(k.key)}
              className={
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
                (kindFilter === k.key
                  ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                  : "border-line bg-surface2/40 text-faint hover:border-line2 hover:text-dim")
              }
            >
              {k.icon}
              <span>{k.label}</span>
              <span className="font-mono text-[10.5px] opacity-70">{k.n}</span>
            </button>
          ))}
        </div>

        {/* summary strip — reflects the selected split */}
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5">
          <Stat label="Queued" n={kc.queued} tone="text-dim" />
          <Stat label="Running" n={kc.running} tone="text-[#9db8ff]" />
          <Stat label="Done" n={kc.done} tone="text-launch2" />
          <Stat label="Failed" n={kc.error} tone="text-danger" />
        </div>

        {/* filter tabs + mine toggle */}
        <div className="flex items-center gap-1 px-3 pt-3">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={
                "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
                (filter === tab.key ? "bg-raise text-ink" : "text-faint hover:text-dim")
              }
            >
              {tab.label}
              <span className="font-mono text-[10.5px] text-faint">{tab.n}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMineOnly((v) => !v)}
            aria-pressed={mineOnly}
            data-tip={mineOnly ? "Showing only your tasks" : "Show only your tasks"}
            className={
              "tip ml-auto flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150 " +
              (mineOnly
                ? "border-accent/40 bg-accent/15 text-[#9db8ff]"
                : "border-line text-faint hover:border-line2 hover:text-dim")
            }
          >
            Mine
          </button>
        </div>

        {/* list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {shown.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface2 text-faint">
                <TasksIcon className="h-5 w-5" />
              </span>
              <p className="text-[13px] font-medium text-dim">Nothing here yet</p>
              <p className="max-w-[240px] text-[11.5px] leading-relaxed text-faint">
                Launches and duplicates from every account land here live. Press Launch and the
                server builds them one at a time — you can close the tab.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {shown.map((t) => (
                <TaskRow key={t.id} task={t} me={me} now={now} onRetry={() => retry(t.id)} onCancel={() => cancel(t.id)} />
              ))}
            </div>
          )}
        </div>

        {/* footer — bulk actions */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
          <span className="text-[10.5px] text-faint">
            {counts.running > 0 ? "Building on the server…" : counts.active > 0 ? "Queued on the server" : "Idle"}
          </span>
          <div className="flex items-center gap-1.5">
            {cancelable > 0 ? (
              <button
                type="button"
                onClick={cancelAllQueued}
                className="flex items-center gap-1.5 rounded-md border border-warn/30 px-2 py-1 text-[11.5px] font-medium text-warn transition-colors hover:bg-warn/10"
              >
                <XIcon className="h-3.5 w-3.5" />
                Cancel queued ({cancelable})
              </button>
            ) : null}
            {retryable > 0 ? (
              <button
                type="button"
                onClick={retryAll}
                className="flex items-center gap-1.5 rounded-md border border-danger/30 px-2 py-1 text-[11.5px] font-medium text-danger transition-colors hover:bg-danger/10"
              >
                <RetryIcon className="h-3.5 w-3.5" />
                Retry failed ({retryable})
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <div className="flex flex-1 flex-col items-center rounded-lg bg-surface2/50 py-1.5">
      <span className={"font-mono text-[15px] font-semibold tabular-nums " + tone}>{n}</span>
      <span className="text-[9px] uppercase tracking-[0.14em] text-faint">{label}</span>
    </div>
  );
}

/** Colored chip naming who launched a task — stable hue per username across all sessions. */
function OwnerChip({ owner, mine }: { owner: string | null | undefined; mine: boolean }) {
  if (mine) return <span className="text-dim">you</span>;
  const name = owner || "—";
  const h = ownerHue(name);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] align-middle"
      style={{ color: `hsl(${h} 75% 72%)`, background: `hsl(${h} 70% 60% / 0.14)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${h} 75% 62%)` }} />
      {name}
    </span>
  );
}

function TaskRow({
  task,
  me,
  now,
  onRetry,
  onCancel,
}: {
  task: ViewTask;
  me: string | null;
  now: number;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const mine = !!me && task.owner === me;
  const stages = stagesFor(task.kind);
  const idx = stageIndexFor(task.kind, task.stage);
  const done = task.eff === "done";
  const canceled = isCanceled(task);
  const error = task.eff === "error" && !canceled;
  const stale = task.eff === "stale";
  const running = task.eff === "running";
  const queued = task.eff === "queued";
  // A failed/canceled row the server flagged retryable shows Retry; a queued server row shows
  // Cancel — both owner-only. A created-campaign partial (retry cleared) shows the non-retryable
  // marker instead.
  const canRetry = (error || canceled) && !!task.retry && mine;
  const canCancel = queued && !!task.srv && mine;
  // A stale task's clock froze at its owner's last sign of life — never tick a dead run.
  const end = task.finishedAt ?? (stale ? task.updatedMs ?? task.startedAt : now);
  const elapsed = task.startedAt ? Math.max(0, (end ?? now) - task.startedAt) : 0;

  const statusLabel = done
    ? task.kind === "clone"
      ? "Duplicated · live"
      : "Launched · live"
    : canceled
      ? "Canceled"
      : error
        ? task.error || "Failed"
        : stale
          ? task.status === "queued"
            ? "Interrupted — queued in a session that went offline"
            : "Interrupted — session went offline"
          : running
            ? stages[idx]?.label ?? "Working…"
            : "Queued on the server";

  return (
    <div
      className={
        "animate-row-in rounded-xl border bg-surface2/40 p-3 transition-colors " +
        (canceled ? "border-line" : error ? "border-danger/30" : stale ? "border-warn/30" : done ? "border-launch/25" : "border-line")
      }
    >
      <div className="flex items-start gap-2.5">
        <StatusDot eff={task.eff} canceled={canceled} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={task.name}>
            {task.name || "Untitled campaign"}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
            {task.partner === "us" ? "brand" : task.partner === "av" ? "key" : "gcm"} {task.gcm || "—"} · {task.geo} · ${moneyLabel(task.budget)}
            {task.bid ? ` · ${task.bid}` : ""} ·{" "}
            <OwnerChip owner={task.owner} mine={mine} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10.5px] tabular-nums text-faint">{fmtElapsed(elapsed)}</span>
          {canRetry ? (
            <button
              type="button"
              onClick={onRetry}
              data-tip="Retry"
              aria-label="Retry"
              className="tip flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <RetryIcon className="h-3.5 w-3.5" />
            </button>
          ) : canCancel ? (
            <button
              type="button"
              onClick={onCancel}
              data-tip="Cancel this queued launch"
              aria-label="Cancel"
              className="tip rounded-md border border-line px-1.5 py-0.5 text-[10.5px] font-medium text-faint transition-colors hover:border-warn/40 hover:text-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Cancel
            </button>
          ) : error && task.result?.campaignId ? (
            // Partial failure — a campaign was created. Retrying would duplicate it, so the server
            // cleared the retry flag; show a non-retryable marker pointing at Ads Manager instead.
            <span
              data-tip="Campaign was partially created — review/delete it in Ads Manager, don't retry"
              className="tip font-mono text-[9px] font-semibold uppercase tracking-wide text-warn"
            >
              partial
            </span>
          ) : null}
          {/* No Dismiss: error rows are a team-visible record (owner call 08-11) — failures
              can't be quietly swept from the drawer. */}
        </div>
      </div>

      {/* segmented stage bar */}
      <div className="mt-2.5 flex gap-1">
        {stages.map((s, i) => {
          const cls = canceled
            ? "bg-line2"
            : done
              ? "bg-launch"
              : error && i === idx
                ? "bg-danger"
                : stale && i === idx
                  ? "bg-warn"
                  : i < idx
                    ? "bg-accent"
                    : running && i === idx
                      ? "bg-accent/70 animate-pulse"
                      : queued && i === idx
                        ? "bg-accent/50 animate-pulse"
                        : "bg-line2";
          return <span key={s.key} className={"h-1 flex-1 rounded-full transition-colors duration-300 " + cls} />;
        })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span
          className={
            "flex items-center gap-1.5 truncate text-[11px] " +
            (done ? "text-launch2" : canceled ? "text-dim" : error ? "text-danger" : stale ? "text-warn" : "text-dim")
          }
        >
          {error || stale ? <AlertIcon className="h-3 w-3 shrink-0" /> : null}
          {done ? <CheckIcon className="h-3 w-3 shrink-0" /> : null}
          {running ? <RocketIcon className="h-3 w-3 shrink-0 text-[#9db8ff]" /> : null}
          <span className="truncate" title={statusLabel}>
            {statusLabel}
          </span>
        </span>
        {done && task.result?.adId ? <CopyId id={task.result.adId} /> : null}
      </div>
    </div>
  );
}

function StatusDot({ eff, canceled }: { eff: EffStatus; canceled: boolean }) {
  if (eff === "running")
    return (
      <span className="relative mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="z-10 h-2 w-2 rounded-full bg-[#9db8ff]" />
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/40" />
      </span>
    );
  const color = canceled
    ? "bg-line2"
    : eff === "done"
      ? "bg-launch2"
      : eff === "error"
        ? "bg-danger"
        : "bg-warn"; // queued + stale → warn
  return <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + color} />;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface2/60 px-1.5 py-0.5 font-mono text-[10px] text-dim transition-colors hover:border-line2 hover:text-ink"
      title="Copy ad id"
    >
      {copied ? <CheckIcon className="h-3 w-3 text-launch2" /> : <CopyIcon className="h-3 w-3" />}
      ad {id}
    </button>
  );
}

// Keep TaskStatus referenced for consumers that narrow on it (type-only re-export below).
export type { TaskStatus, ViewTask };
