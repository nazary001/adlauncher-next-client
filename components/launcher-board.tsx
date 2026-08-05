"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Campaign, FileItem } from "@/lib/types";
import { firstVideo, fullName, isLaunchable, makeCampaign } from "@/lib/types";
import { spinCopy } from "@/lib/rephrase";
import { countryName } from "@/lib/catalog";
import {
  type PartnerConfig,
  type PartnerId,
  applyPartnerLocks,
  assignGcmCodes,
  namePrefixFor,
  partnerConfig,
} from "@/lib/partners";
import { Header } from "./header";
import { CampaignCard } from "./campaign-card";
import { LaunchRail } from "./launch-rail";
import { CopySettingsModal } from "./copy-settings-modal";
import { ChevronsIcon, CopyIcon, PlusIcon } from "./icons";
import { TaskManagerProvider, useTaskManager } from "./task-manager";
import type { SessionUser } from "./user-menu";

/** Today as DD.MM for the campaign-name prefix. Runs client-side (and on the local dev server). */
function todayDDMM(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** gcm auto-claim (skipping registry-reserved codes) + single account/pixel/fanpage pinning. */
function normalize(rows: Campaign[], partner: PartnerConfig, reserved: Set<string> | null): Campaign[] {
  const withGcm = partner.usesGcm ? assignGcmCodes(rows, reserved) : rows;
  return applyPartnerLocks(withGcm, partner);
}

function geoShort(c: Campaign): string {
  if (c.countries.length === 0) return "no geo";
  if (c.countries[0] === "WW") return "World";
  if (c.countries.length <= 2) return c.countries.map(countryName).join(", ");
  return `${c.countries.length} geos`;
}

export function LauncherBoard({ user }: { user?: SessionUser }) {
  return (
    <TaskManagerProvider user={user}>
      <LauncherInner user={user} />
    </TaskManagerProvider>
  );
}

function LauncherInner({ user }: { user?: SessionUser }) {
  const { enqueue, tasks } = useTaskManager();
  const [partnerId, setPartnerId] = useState<PartnerId>("in");
  // Codes already taken in the Strapi gcm registry. null = not loaded yet → assign nothing.
  const [reserved, setReserved] = useState<Set<string> | null>(null);
  // Live ads-running-or-in-review count on the bound fanpage. null = unavailable/not loaded.
  const [adCount, setAdCount] = useState<number | null>(null);
  // Count just sent to the Task Manager, shown as a brief confirmation (campaigns stay on the board).
  const [justQueued, setJustQueued] = useState(0);
  const queuedTimer = useRef<number | null>(null);
  // Card that a Launch-bay row jumped to (focus-pulses briefly).
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const hlTimer = useRef<number | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    normalize(
      [makeCampaign("c1", namePrefixFor(partnerConfig("in"), todayDDMM()), user?.username ?? "")],
      partnerConfig("in"),
      null,
    ),
  );
  const [previewed, setPreviewed] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const nextId = useRef(2);
  const partner = partnerConfig(partnerId);
  const anyExpanded = campaigns.some((c) => !c.collapsed);

  // Latest partner for callbacks that must not re-subscribe on partner switch.
  const partnerRef = useRef(partner);
  useEffect(() => {
    partnerRef.current = partner;
  }, [partner]);

  // Pull the live registry and (re)assign gcm codes above whatever is already used. Runs on
  // mount and again when the window regains focus (≥15s apart): with several accounts working
  // at once another user may claim a previewed code — the claim itself is atomic server-side,
  // this just keeps the optimistic previews close to reality.
  const lastGcmFetch = useRef(0);
  const refreshGcm = useCallback(() => {
    if (Date.now() - lastGcmFetch.current < 15_000) return;
    lastGcmFetch.current = Date.now();
    fetch("/api/gcm")
      .then((r) => r.json())
      .then((d) => {
        if (!Array.isArray(d.used)) return;
        const set = new Set<string>(d.used);
        setReserved(set);
        setCampaigns((cs) => normalize(cs, partnerRef.current, set));
      })
      .catch(() => {
        /* registry unreachable — keep the previous reserved set (null on first load =
           no possibly-taken code is handed out) */
      });
  }, []);

  useEffect(() => {
    refreshGcm();
    const onFocus = () => refreshGcm();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGcm]);

  // Fold every code an actually-completed launch claimed back into the reserved set. The server is
  // the source of truth for the real code (it may differ from the optimistic preview if the mount
  // snapshot was stale), so later batches never re-preview a code already taken this session. Stays
  // null while the registry hasn't loaded (→ keep assigning nothing).
  useEffect(() => {
    // Safe setState-in-effect: the functional updater returns the SAME reference when nothing new is
    // added, so it never re-renders (let alone cascades); it only grows `reserved` when a launch
    // actually completes with a new claimed code.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReserved((prev) => {
      if (!prev) return prev;
      let set: Set<string> | null = null;
      for (const t of tasks) {
        const g = t.status === "done" ? t.result?.gcm : undefined;
        if (g && !prev.has(g)) {
          set = set ?? new Set(prev);
          set.add(g);
        }
      }
      return set ?? prev;
    });
  }, [tasks]);

  // Bound fanpage's live ad usage for the "N / limit" badge; re-runs on partner change + after launch.
  function loadVolume() {
    const acct = partner.lockedAccount?.id;
    if (!acct) {
      setAdCount(null);
      return;
    }
    fetch(`/api/fanpage-volume?account=${acct}`)
      .then((r) => r.json())
      .then((d) => setAdCount(d?.ok && typeof d.count === "number" ? d.count : null))
      .catch(() => {});
  }

  useEffect(() => {
    // loadVolume() sets adCount from the fetch result (async for the live Indians partner; the
    // synchronous null-set only applies to a bound-account-less partner, which isn't selectable).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadVolume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  /** Non-blocking launch: every launchable campaign is captured + dropped into the Task Manager
   *  instantly, then flies off the board so you can keep building. The queue creates them one by
   *  one (PAUSED) in the background. */
  function launch() {
    const opts = { landing: partner.usesGcm, profile: partner.usesProfile };
    const launchable = campaigns.filter((c) => isLaunchable(c, opts));
    if (launchable.length === 0) return;

    // Reserve every code we're launching right now (optimistic — the tasks fire in the background),
    // so any card built next never re-previews a code that's already on its way into the registry.
    const nextReserved = reserved ? new Set(reserved) : null;
    const launched = new Set<string>();
    for (const c of launchable) {
      const video = firstVideo(c);
      if (!video) continue;
      if (nextReserved && c.gcm) nextReserved.add(c.gcm);
      enqueue({
        partnerId,
        campaign: c,
        videoUrl: video.url,
        videoName: video.name,
        name: fullName(c),
        gcm: c.gcm,
        geo: geoShort(c),
        budget: c.budget,
      });
      launched.add(c.id);
    }
    if (nextReserved) setReserved(nextReserved);
    setPreviewed(false);

    // Keep the campaigns on the board so you can tweak them and relaunch — only clear the gcm of the
    // ones just sent (their codes are now taken) so normalize hands them fresh codes for the next wave.
    setCampaigns((cs) =>
      normalize(cs.map((c) => (launched.has(c.id) ? { ...c, gcm: "" } : c)), partner, nextReserved),
    );

    setJustQueued(launched.size);
    if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    queuedTimer.current = window.setTimeout(() => setJustQueued(0), 3500);
    loadVolume();
  }

  function mutate(fn: (cs: Campaign[]) => Campaign[]) {
    setCampaigns((cs) => normalize(fn(cs), partner, reserved));
    setPreviewed(false);
  }

  function changePartner(id: PartnerId) {
    setPartnerId(id);
    setCampaigns((cs) => normalize(cs, partnerConfig(id), reserved));
    setPreviewed(false);
  }

  const patch = (id: string, p: Partial<Campaign>) =>
    mutate((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const toggleCollapse = (id: string) =>
    setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)));

  /** Launch-bay row click → expand the card, smooth-scroll the page to it, then focus-pulse it. */
  const jumpTo = (id: string) => {
    setCampaigns((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null); // reset so re-clicking the same card re-triggers the pulse
    window.setTimeout(() => {
      document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) window.clearTimeout(hlTimer.current);
    hlTimer.current = window.setTimeout(() => setHighlightId(null), 1800);
  };

  const add = () => {
    const prefix = namePrefixFor(partner, todayDDMM());
    mutate((cs) => [...cs, makeCampaign(`c${nextId.current++}`, prefix, user?.username ?? "")]);
  };

  const duplicate = (id: string) =>
    mutate((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1) return cs;
      const src = cs[i];
      const clone: Campaign = {
        ...src,
        id: `c${nextId.current++}`,
        collapsed: false,
        gcm: "", // each ad claims its own code — re-assigned by assignGcmCodes
        copy: spinCopy(src.copy), // vary the primary text so clones aren't identical ads
      };
      return [...cs.slice(0, i + 1), clone, ...cs.slice(i + 1)];
    });

  const remove = (id: string) => mutate((cs) => cs.filter((c) => c.id !== id));

  /** Copy the picked settings from the first campaign onto every other one. Never touches gcm
   *  (each keeps its own code) or name (each stays distinct); locks re-sync via normalize. */
  const applyCopy = (keys: (keyof Campaign)[]) => {
    setCopyOpen(false);
    if (keys.length === 0) return;
    mutate((cs) => {
      if (cs.length <= 1) return cs;
      const src = cs[0];
      const patch: Record<string, unknown> = {};
      for (const k of keys) {
        const v = src[k];
        patch[k] = Array.isArray(v) ? [...v] : v; // clone arrays (geo/locales/files)
      }
      if (keys.includes("redirectType")) patch.paramMode = src.paramMode; // keep the pair consistent
      return cs.map((c, i) => (i === 0 ? c : { ...c, ...(patch as Partial<Campaign>) }));
    });
  };

  const MAX_CARDS = 100;

  /** Wave builder: grow every card to `n` copies (fresh gcm + a varied copy each). Clones open
   *  expanded so you can review them right away. `n` is the total-per-card multiplier. */
  const duplicateAll = (n: number) =>
    mutate((cs) => {
      const out: Campaign[] = [];
      for (const c of cs) {
        out.push(c);
        for (let k = 1; k < n && out.length < MAX_CARDS; k++) {
          out.push({ ...c, id: `c${nextId.current++}`, collapsed: false, gcm: "", copy: spinCopy(c.copy) });
        }
      }
      return out.slice(0, MAX_CARDS);
    });

  const setAllCollapsed = (collapsed: boolean) =>
    setCampaigns((cs) => cs.map((c) => ({ ...c, collapsed })));

  const removeAll = () =>
    mutate(() => [makeCampaign(`c${nextId.current++}`, namePrefixFor(partner, todayDDMM()), user?.username ?? "")]);

  /** Copy one card's creatives onto every card — build a wave, drop the video once, apply to all. */
  const applyFilesToAll = (files: FileItem[]) => mutate((cs) => cs.map((c) => ({ ...c, files })));

  return (
    <>
      <Header partner={partnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-6 px-4 pb-24 pt-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_330px]">
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
                {campaigns.length}
              </span>

              {/* wave builder — turn a template into N copies at once */}
              <div className="ml-1 flex h-9 items-center overflow-hidden rounded-lg border border-line bg-surface">
                <span className="px-2.5 text-[12px] font-medium text-dim">Duplicate all</span>
                {[2, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => duplicateAll(n)}
                    className={
                      "h-9 border-l border-line px-2.5 font-mono text-[12px] text-dim transition-colors " +
                      "hover:bg-accent/15 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    }
                  >
                    ×{n}
                  </button>
                ))}
              </div>

              {campaigns.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => setAllCollapsed(anyExpanded)}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-dim transition-colors hover:border-line2 hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <ChevronsIcon className={"h-3.5 w-3.5 transition-transform " + (anyExpanded ? "" : "rotate-180")} />
                    {anyExpanded ? "Collapse all" : "Expand all"}
                  </button>
                  <button
                    type="button"
                    onClick={removeAll}
                    className="flex h-9 items-center rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-faint transition-colors hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Clear
                  </button>
                </>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCopyOpen(true)}
                  disabled={campaigns.length <= 1}
                  data-tip={campaigns.length <= 1 ? "Add more campaigns to copy settings to" : undefined}
                  className={
                    "tip flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 " +
                    "text-[13px] font-medium text-dim transition-all duration-150 " +
                    "hover:border-line2 hover:bg-surface2 hover:text-ink active:scale-[0.97] " +
                    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-dim " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <CopyIcon className="h-4 w-4 text-accent2" />
                  Copy to all
                </button>
                <button
                  type="button"
                  onClick={add}
                  className={
                    "flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 " +
                    "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 " +
                    "hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97] " +
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  }
                >
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>

            {campaigns.map((c, i) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                index={i}
                partner={partner}
                adCount={adCount}
                highlight={highlightId === c.id}
                onPatch={patch}
                onToggleCollapse={toggleCollapse}
                onDuplicate={duplicate}
                onRemove={remove}
                onApplyFilesToAll={campaigns.length > 1 ? applyFilesToAll : undefined}
              />
            ))}

            <button
              type="button"
              onClick={add}
              className={
                "flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed " +
                "border-line2 text-[13px] font-medium text-dim transition-all duration-200 " +
                "hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          <LaunchRail
            campaigns={campaigns}
            partner={partner}
            previewed={previewed}
            justQueued={justQueued}
            onJump={jumpTo}
            onPreview={() => setPreviewed(true)}
            onLaunch={launch}
          />
        </div>
      </main>

      <CopySettingsModal
        open={copyOpen}
        source={campaigns[0] ?? null}
        count={Math.max(0, campaigns.length - 1)}
        partner={partner}
        onClose={() => setCopyOpen(false)}
        onApply={applyCopy}
      />
    </>
  );
}
