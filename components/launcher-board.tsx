"use client";

import { useEffect, useRef, useState } from "react";
import type { Campaign, FileItem } from "@/lib/types";
import { firstVideo, fullName, isLaunchable, makeCampaign } from "@/lib/types";
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
    <TaskManagerProvider>
      <LauncherInner user={user} />
    </TaskManagerProvider>
  );
}

function LauncherInner({ user }: { user?: SessionUser }) {
  const { enqueue } = useTaskManager();
  const [partnerId, setPartnerId] = useState<PartnerId>("in");
  // Codes already taken in the Strapi gcm registry. null = not loaded yet → assign nothing.
  const [reserved, setReserved] = useState<Set<string> | null>(null);
  // Live ads-running-or-in-review count on the bound fanpage. null = unavailable/not loaded.
  const [adCount, setAdCount] = useState<number | null>(null);
  // Ids currently playing the fly-to-Task-Manager animation before removal.
  const [flying, setFlying] = useState<Set<string>>(new Set());
  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    normalize([makeCampaign("c1", namePrefixFor(partnerConfig("in"), todayDDMM()))], partnerConfig("in"), null),
  );
  const [previewed, setPreviewed] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const nextId = useRef(2);
  const partner = partnerConfig(partnerId);
  const anyExpanded = campaigns.some((c) => !c.collapsed);

  // Pull the live registry once, then (re)assign gcm codes above whatever is already used.
  useEffect(() => {
    let alive = true;
    fetch("/api/gcm")
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !Array.isArray(d.used)) return;
        const set = new Set<string>(d.used);
        setReserved(set);
        setCampaigns((cs) => normalize(cs, partner, set));
      })
      .catch(() => {
        /* registry unreachable — leave reserved null so no possibly-taken code is handed out */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setAdCount(null);
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

    for (const c of launchable) {
      const video = firstVideo(c);
      if (!video) continue;
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
    }

    const ids = new Set(launchable.map((c) => c.id));
    setFlying(ids);
    setPreviewed(false);
    window.setTimeout(() => {
      setFlying(new Set());
      setCampaigns((cs) => {
        const remaining = cs.filter((c) => !ids.has(c.id));
        const base = remaining.length
          ? remaining
          : [makeCampaign(`c${nextId.current++}`, namePrefixFor(partner, todayDDMM()))];
        return normalize(base, partner, reserved);
      });
      loadVolume();
    }, 340);
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

  const add = () => {
    const prefix = namePrefixFor(partner, todayDDMM());
    mutate((cs) => [...cs, makeCampaign(`c${nextId.current++}`, prefix)]);
  };

  const duplicate = (id: string) =>
    mutate((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1) return cs;
      const src = cs[i];
      const copy: Campaign = {
        ...src,
        id: `c${nextId.current++}`,
        collapsed: false,
        gcm: "", // each ad claims its own code — re-assigned by assignGcmCodes
      };
      return [...cs.slice(0, i + 1), copy, ...cs.slice(i + 1)];
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

  /** Wave builder: grow every card to `n` identical copies (fresh gcm each). Clones collapse
   *  so a big wave stays scannable. `n` is the total-per-card multiplier. */
  const duplicateAll = (n: number) =>
    mutate((cs) => {
      const out: Campaign[] = [];
      for (const c of cs) {
        out.push(c);
        for (let k = 1; k < n && out.length < MAX_CARDS; k++) {
          out.push({ ...c, id: `c${nextId.current++}`, collapsed: true, gcm: "" });
        }
      }
      return out.slice(0, MAX_CARDS);
    });

  const setAllCollapsed = (collapsed: boolean) =>
    setCampaigns((cs) => cs.map((c) => ({ ...c, collapsed })));

  const removeAll = () =>
    mutate(() => [makeCampaign(`c${nextId.current++}`, namePrefixFor(partner, todayDDMM()))]);

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
                flying={flying.has(c.id)}
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
