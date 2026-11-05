"use client";

// The VC (ValueClick) clone board — /clone?partner=vc (owner ask 05.11: "сделать клоны всех активных кампаний
// на этот новый пиксель … через TOOL в нашем адлаунчере, но если уже не получится через него то через этот
// токен … Бид ставь 0.5 везде, в нейминг … добавь слово Lead и ставь все клоны на лид оптимизацию").
//
// Unlike the MO/AIF/AV board (ids handed over by the stats tool), this one LISTS every ACTIVE campaign of
// the VC cabinets itself (GET /api/vc/sources, read with the VC token) — or the ids of a deep link — and
// clones the selected ones with ONE set of batch settings (lib/vc-clone): the pixel, the event (Lead /
// Purchase), the bid, an optional budget, a name suffix. A row may type its own name. The channel is the
// VC token (direct Graph) or TOOL (recreate through the HS Ads Manager sessions service — offered only
// when a live TOOL session sees VC's cabinets, /api/tool/ready). Duplicate hands each clone to the server
// queue through the VC task manager (fb.clone with partnerId "vc" → lib/vc-clone-run).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "./header";
import type { SessionUser } from "./user-menu";
import { useVcTaskManager } from "./task-manager";
import { useToolReady } from "./use-tool-ready";
import { Field, MoneyInput, Select, TextInput } from "./ui";
import { AlertIcon, CheckIcon, RetryIcon, UndoIcon } from "./icons";
import type { PartnerId } from "@/lib/partners";
import { BID_STRATEGIES } from "@/lib/catalog";
import { bidKind, bidTag, limitMoney, moneyLabel } from "@/lib/types";
import { TOOL_MARK, toolEnsureMark } from "@/lib/tool-launch";
import {
  VC_CLONE_DEFAULTS,
  VC_CLONE_EVENTS,
  VC_CLONE_PIXELS,
  type VcCloneEvent,
  type VcCloneSettings,
  type VcCloneSource,
  vcCloneEditOf,
  vcCloneRefusal,
  vcPixelName,
} from "@/lib/vc-clone";

type SourceAccount = { id: string; name: string; pixels: { id: string; name: string }[] };
type Loaded = { sources: VcCloneSource[]; accounts: SourceAccount[]; signer: string; failed: { id: string; error: string }[] };

const LS_CHANNEL = "adlauncher.clone.vc.channel";
const LS_SETTINGS = "adlauncher.clone.vc.settings";

function SectionHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
      <h4 className="text-[13px] font-semibold text-ink">{children}</h4>
      {right}
    </div>
  );
}

const label = "text-[10px] font-medium uppercase tracking-[0.14em] text-faint";

/** The settings as stored between visits (the owner's defaults the first time). */
function readSettings(): VcCloneSettings {
  try {
    const raw = window.localStorage.getItem(LS_SETTINGS);
    if (!raw) return { ...VC_CLONE_DEFAULTS };
    const j = JSON.parse(raw) as Partial<VcCloneSettings>;
    const event: VcCloneEvent = j.event === "PURCHASE" ? "PURCHASE" : "LEAD";
    return {
      pixelId: typeof j.pixelId === "string" && j.pixelId ? j.pixelId : VC_CLONE_DEFAULTS.pixelId,
      event,
      bidStrategy: typeof j.bidStrategy === "string" ? j.bidStrategy : VC_CLONE_DEFAULTS.bidStrategy,
      bidCap: typeof j.bidCap === "string" ? j.bidCap : VC_CLONE_DEFAULTS.bidCap,
      budget: typeof j.budget === "string" ? j.budget : "",
      suffix: typeof j.suffix === "string" ? j.suffix : VC_CLONE_DEFAULTS.suffix,
    };
  } catch {
    return { ...VC_CLONE_DEFAULTS };
  }
}

export function VcCloneBoard({ user, initialIds = [] }: { user: SessionUser; initialIds?: string[] }) {
  const partnerId: PartnerId = "vc";
  const { enqueueClone, setOpen } = useVcTaskManager();

  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<VcCloneSettings>(() => ({ ...VC_CLONE_DEFAULTS }));
  const [channel, setChannel] = useState<"token" | "tool">("token");
  const [justQueued, setJustQueued] = useState(0);
  const queuedTimer = useRef<number | null>(null);
  const idsKey = initialIds.join(",");

  // Remembered picks (per browser): the channel and the batch settings. Safe setState-in-effect: runs
  // once on mount (localStorage is unreadable during SSR) — the same pattern as the MO clone board.
  useEffect(() => {
    try {
      const ch = window.localStorage.getItem(LS_CHANNEL);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (ch === "tool") setChannel("tool");
    } catch {
      /* no storage */
    }
    setSettings(readSettings());
  }, []);
  const patchSettings = (p: Partial<VcCloneSettings>) =>
    setSettings((s) => {
      const next = { ...s, ...p };
      try {
        window.localStorage.setItem(LS_SETTINGS, JSON.stringify(next));
      } catch {
        /* no storage */
      }
      return next;
    });
  const changeChannel = (c: "token" | "tool") => {
    setChannel(c);
    try {
      window.localStorage.setItem(LS_CHANNEL, c);
    } catch {
      /* no storage */
    }
  };

  /** Read the sources. Sets state only AFTER the fetch (a caller that wants the loading state shows it
   *  itself — the mount effect starts in it, Reload flips it on click). */
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/vc/sources${idsKey ? `?ids=${encodeURIComponent(idsKey)}` : ""}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        sources?: VcCloneSource[];
        accounts?: SourceAccount[];
        signer?: string;
        failed?: string[];
        failures?: Record<string, string>;
      };
      if (!res.ok || !body.ok) throw new Error(body.error || `Failed to load VC campaigns (${res.status})`);
      const sources = body.sources ?? [];
      setData({
        sources,
        accounts: body.accounts ?? [],
        signer: body.signer ?? "",
        failed: (body.failed ?? []).map((id) => ({ id, error: body.failures?.[id] || "not found / no access" })),
      });
      setSelected(new Set(sources.map((s) => s.campaignId)));
      setNames({});
    } catch (e) {
      setError((e as Error).message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [idsKey]);
  // The first read: off the effect's own tick (the sources arrive in a callback, never a synchronous setState).
  useEffect(() => {
    Promise.resolve().then(() => void load());
  }, [load]);
  const reload = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  // TOOL readiness for VC clones: a live session must see VC's cabinets (the sources are still read with the token).
  const toolReady = useToolReady(partnerId, "clone");
  const onTool = channel === "tool" && toolReady.ready;

  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    window.location.assign(url.toString());
  };

  const sources = useMemo(() => data?.sources ?? [], [data]);
  const accountsById = useMemo(() => new Map((data?.accounts ?? []).map((a) => [a.id, a])), [data]);
  // The pixels on offer: the known VC datasets first, then every other pixel the cabinets carry.
  const pixelOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of VC_CLONE_PIXELS) seen.set(p.id, p.name);
    for (const a of data?.accounts ?? []) for (const p of a.pixels) if (!seen.has(p.id)) seen.set(p.id, p.name);
    if (settings.pixelId && !seen.has(settings.pixelId)) seen.set(settings.pixelId, settings.pixelId);
    return [...seen].map(([id, name]) => ({ value: id, label: `${name} · ${id}` }));
  }, [data, settings.pixelId]);

  const kind = bidKind(settings.bidStrategy || "LOWEST_COST_WITH_BID_CAP");
  const bidLabel = kind === "roas" ? "ROAS goal" : kind === "cap" ? "Bid cap ($)" : "Bid";

  /** One row's clone as it would ship, with why it can't (null = fine). */
  const rows = useMemo(
    () =>
      sources.map((src) => {
        const own = names[src.campaignId];
        const edit = vcCloneEditOf(src, settings, own && own.trim() ? own : undefined);
        const acct = accountsById.get(src.accountId);
        const pixelMissing = Boolean(acct) && !acct!.pixels.some((p) => p.id === settings.pixelId);
        const toolMissing = onTool && !toolReady.accounts.has(src.accountId);
        const refusal =
          vcCloneRefusal(edit, src) ??
          (pixelMissing ? `${vcPixelName(settings.pixelId)} is not shared to ${src.accountName || `act_${src.accountId}`} — share it in Business Manager first` : null) ??
          (toolMissing ? `no live TOOL session sees ${src.accountName || `act_${src.accountId}`} — switch to FB Token` : null);
        return { src, edit, refusal, name: onTool ? toolEnsureMark(edit.name) : edit.name };
      }),
    [sources, names, settings, accountsById, onTool, toolReady.accounts],
  );
  const picked = rows.filter((r) => selected.has(r.src.campaignId));
  const ready = picked.filter((r) => !r.refusal);
  const blocked = picked.length - ready.length;
  const signerMissing = Boolean(error && /no_token/i.test(error));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectAll = (on: boolean) => setSelected(on ? new Set(sources.map((s) => s.campaignId)) : new Set());

  /** Hand every ready, selected row to the server queue (one fb.clone job each, partnerId "vc"). */
  const duplicate = () => {
    if (ready.length === 0) return;
    let queued = 0;
    for (const r of ready) {
      enqueueClone({
        partnerId,
        edit: r.edit,
        name: r.name,
        geo: r.src.countries.join(", "),
        budget: r.edit.budget,
        bid: bidTag(r.edit.bidStrategy, r.edit.bidCap) || undefined,
        ...(onTool ? { via: "tool" as const } : {}),
      });
      queued++;
    }
    if (queued === 0) return;
    setOpen(true);
    setJustQueued(queued);
    if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    queuedTimer.current = window.setTimeout(() => setJustQueued(0), 4500);
  };
  useEffect(
    () => () => {
      if (queuedTimer.current) window.clearTimeout(queuedTimer.current);
    },
    [],
  );

  const eventLabel = VC_CLONE_EVENTS.find((e) => e.value === settings.event)?.label ?? settings.event;
  const summary = `${eventLabel} on ${vcPixelName(settings.pixelId)} · ${bidTag(settings.bidStrategy || "LOWEST_COST_WITH_BID_CAP", settings.bidCap) || "auto"} · ${settings.budget.trim() ? `$${moneyLabel(settings.budget)}/day` : "source budget"}${settings.suffix.trim() ? ` · “- ${settings.suffix.trim()}”` : ""}`;

  return (
    <>
      <Header partner={partnerId} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[300px_minmax(0,1fr)] xl:gap-6 xl:px-6">
          {/* ---- Settings (left) ---- */}
          <section className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:overscroll-contain">
            <SectionHeading>Settings</SectionHeading>
            <p className="-mt-2 text-[10.5px] leading-snug text-faint">
              Every selected campaign is recreated in its own cabinet — same page, same creatives, same targeting, same tracking link — with these on top.
            </p>

            {/* channel: the VC token (direct Graph) or TOOL (a live session must see VC's cabinets) */}
            <div className="flex flex-col gap-1">
              <span className={label}>Launch channel</span>
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-surface2/50 p-0.5">
                {[
                  { key: "token" as const, label: "FB Token", ready: true, hint: "Builds on the VC token (VC · Clones, else VC · Launches)" },
                  {
                    key: "tool" as const,
                    label: "TOOL",
                    ready: toolReady.ready,
                    hint: !toolReady.loaded ? "Checking TOOL…" : toolReady.ready ? `Recreates through TOOL · ${toolReady.accounts.size} cabinet${toolReady.accounts.size === 1 ? "" : "s"}` : toolReady.message || "TOOL is not ready for VC",
                  },
                ].map((opt) => {
                  const active = channel === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      disabled={!opt.ready}
                      aria-pressed={active}
                      title={opt.hint}
                      onClick={() => changeChannel(opt.key)}
                      className={
                        "h-8 rounded-[10px] text-[12px] font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                        (active ? "bg-accent/20 text-[#9db8ff] shadow-[inset_0_0_0_1px_rgba(122,150,255,0.35)]" : "text-dim hover:text-ink") +
                        (opt.ready ? "" : " cursor-not-allowed opacity-40")
                      }
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-center text-[10px] leading-relaxed text-faint">
                {onTool
                  ? `Recreates through TOOL · marks names “${TOOL_MARK.trim()}” · the source is still read with the VC token`
                  : channel === "tool" && !toolReady.ready
                    ? toolReady.message || "TOOL not ready — firing on the VC token"
                    : data?.signer
                      ? `Signs as ${data.signer}`
                      : "Builds on the VC token"}
              </p>
            </div>

            <Field label="Pixel" hint="The dataset every clone optimizes on — it must be shared to the cabinet (rows say when it is not).">
              <Select value={settings.pixelId} onChange={(e) => patchSettings({ pixelId: e.target.value })} options={pixelOptions} />
            </Field>
            <Field label="Event" hint={settings.event === "LEAD" ? "Lead = a Leads campaign optimizing LEAD on the pixel (Meta allows LEAD only there)." : "Purchase = Sales optimizing PURCHASE, as the VC launches run."}>
              <Select value={settings.event} onChange={(e) => patchSettings({ event: e.target.value === "PURCHASE" ? "PURCHASE" : "LEAD" })} options={VC_CLONE_EVENTS.map((e) => ({ value: e.value, label: e.label }))} />
            </Field>
            <Field label="Bid strategy">
              <Select value={settings.bidStrategy} onChange={(e) => patchSettings({ bidStrategy: e.target.value })} options={[{ value: "", label: "Source's own" }, ...BID_STRATEGIES]} />
            </Field>
            {kind !== "none" ? (
              <Field label={bidLabel} hint={settings.bidStrategy ? undefined : "Empty = each source's own bid."} error={settings.bidStrategy && !(Number(String(settings.bidCap).replace(",", ".")) > 0) ? "A cap / ROAS clone needs a bid" : undefined}>
                <MoneyInput value={settings.bidCap} onChange={(e) => patchSettings({ bidCap: limitMoney(e.target.value, 1000) })} placeholder={kind === "roas" ? "0,30" : "0,50"} />
              </Field>
            ) : null}
            <Field label="Daily budget" hint="Empty = each source's own daily budget (campaign budget).">
              <MoneyInput value={settings.budget} onChange={(e) => patchSettings({ budget: limitMoney(e.target.value, 100000) })} placeholder="source budget" />
            </Field>
            <Field label="Name suffix" hint="Joined to the source's name as its own “ - ” segment (once).">
              <TextInput value={settings.suffix} onChange={(e) => patchSettings({ suffix: e.target.value.slice(0, 40) })} placeholder="Lead" />
            </Field>
            <button
              type="button"
              onClick={() => patchSettings({ ...VC_CLONE_DEFAULTS })}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-line bg-raise px-3 text-[12px] font-medium text-dim hover:border-line2 hover:text-ink"
            >
              <UndoIcon className="h-3.5 w-3.5" /> Reset to the Lead preset
            </button>

            <div className="rounded-xl border border-line bg-surface2/40 p-3 text-[11.5px] leading-relaxed text-dim">
              <p className="text-ink">{summary}</p>
              <p className="mt-1">
                {picked.length} of {sources.length} selected{blocked ? ` · ${blocked} blocked` : ""}
              </p>
            </div>

            <button
              type="button"
              disabled={loading || ready.length === 0 || signerMissing}
              onClick={duplicate}
              title={ready.length === 0 ? "Select at least one clonable campaign" : `Hand ${ready.length} clone${ready.length === 1 ? "" : "s"} to the server queue`}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[13px] font-semibold text-white shadow-[0_6px_20px_-8px_rgba(122,150,255,0.8)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {justQueued ? (
                <>
                  <CheckIcon className="h-4 w-4" /> {justQueued} queued
                </>
              ) : (
                <>Duplicate {ready.length ? `${ready.length} ${ready.length === 1 ? "campaign" : "campaigns"}` : ""}</>
              )}
            </button>
            <p className="text-[10.5px] leading-snug text-faint">Clones go live at once (ACTIVE), one per source, built by the server one at a time — watch them in VC Tasks.</p>
          </section>

          {/* ---- Sources (right) ---- */}
          <section className="flex min-w-0 flex-col gap-3">
            <SectionHeading
              right={
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => selectAll(true)} className="text-[11px] font-medium text-dim hover:text-ink">
                    Select all
                  </button>
                  <span className="text-faint">·</span>
                  <button type="button" onClick={() => selectAll(false)} className="text-[11px] font-medium text-dim hover:text-ink">
                    None
                  </button>
                  <button
                    type="button"
                    onClick={reload}
                    disabled={loading}
                    className="ml-2 inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-raise px-2 text-[11px] font-medium text-dim hover:border-line2 hover:text-ink disabled:opacity-40"
                  >
                    <RetryIcon className="h-3 w-3" /> Reload
                  </button>
                </div>
              }
            >
              {idsKey ? "VC campaigns" : "Active VC campaigns"} {data ? `(${sources.length})` : ""}
            </SectionHeading>

            {loading ? (
              <p className="py-10 text-center text-[12.5px] text-faint">Reading the VC cabinets…</p>
            ) : error ? (
              <div className="rounded-2xl border border-warn/40 bg-warn/5 p-4 text-[12.5px] leading-relaxed text-warn">
                <p className="flex items-center gap-2 font-semibold">
                  <AlertIcon className="h-4 w-4" /> Couldn&apos;t read the VC campaigns
                </p>
                <p className="mt-1 text-dim">{error}</p>
                {signerMissing && user.owner ? (
                  <p className="mt-2 text-dim">
                    Assign the VC token under menu → FB tokens (VC · Clones or VC · Launches), then Reload.
                  </p>
                ) : null}
              </div>
            ) : sources.length === 0 ? (
              <p className="py-10 text-center text-[12.5px] text-faint">{idsKey ? "None of the linked campaigns is on a VC cabinet." : "No ACTIVE campaign on the VC cabinets right now."}</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-line bg-surface/60">
                <table className="w-full text-[12px]">
                  <thead className="bg-surface2/50 text-[10px] uppercase tracking-[0.12em] text-faint">
                    <tr>
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2 text-left font-semibold">Source</th>
                      <th className="px-3 py-2 text-left font-semibold">Clone</th>
                      <th className="min-w-[200px] px-3 py-2 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ src, edit, refusal, name }) => {
                      const on = selected.has(src.campaignId);
                      const own = names[src.campaignId] ?? "";
                      return (
                        <tr key={src.campaignId} className={"border-t border-line/60 align-top " + (on ? "" : "opacity-50")}>
                          <td className="px-3 py-2.5">
                            <input type="checkbox" checked={on} onChange={() => toggle(src.campaignId)} aria-label={`select ${src.name}`} className="mt-0.5 h-3.5 w-3.5 accent-[#7a96ff]" />
                          </td>
                          <td className="min-w-[260px] px-3 py-2.5">
                            <p className="text-ink" title={src.campaignId}>
                              {src.name}
                            </p>
                            <p className="mt-0.5 text-[11px] text-faint">
                              {src.accountName || `act_${src.accountId}`} · ${moneyLabel(src.budget)}/day · {bidTag(src.bidStrategy, src.bidCap) || "auto"} ·{" "}
                              {src.conversionEvent ? `${src.conversionEvent} on ${vcPixelName(src.pixelId)}` : src.optimizationGoal} · {src.countries.join(", ")} · {src.ads.length}{" "}
                              {src.ads.length === 1 ? "ad" : "ads"}
                            </p>
                          </td>
                          <td className="min-w-[280px] px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <TextInput
                                value={own}
                                placeholder={name}
                                onChange={(e) => setNames((n) => ({ ...n, [src.campaignId]: e.target.value.slice(0, 300) }))}
                                className="!h-8 text-[12px]"
                                aria-label={`clone name for ${src.name}`}
                              />
                              {own ? (
                                <button type="button" title="Back to the source's name + suffix" onClick={() => setNames((n) => ({ ...n, [src.campaignId]: "" }))} className="text-faint hover:text-ink">
                                  <UndoIcon className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>
                            <p className="mt-1 text-[11px] text-faint">
                              {VC_CLONE_EVENTS.find((e) => e.value === edit.event)?.label ?? edit.event} on {vcPixelName(edit.pixelId)} · {bidTag(edit.bidStrategy, edit.bidCap) || "auto"} · ${moneyLabel(edit.budget)}/day
                              {onTool ? ` · ${TOOL_MARK.trim()}` : ""}
                            </p>
                          </td>
                          <td className="min-w-[200px] max-w-[320px] px-3 py-2.5 text-right">
                            {refusal ? (
                              <span className="inline-flex items-start gap-1 text-left text-[11px] leading-snug text-warn" title={refusal}>
                                <AlertIcon className="mt-0.5 h-3 w-3 shrink-0" /> {refusal}
                              </span>
                            ) : (
                              <span className="rounded bg-launch/15 px-1.5 py-[1px] text-[10px] font-semibold uppercase text-launch2">ready</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {data?.failed.length ? (
              <p className="text-[11px] text-warn">
                Not loaded: {data.failed.map((f) => `#${f.id} — ${f.error}`).join(" · ")}
              </p>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
