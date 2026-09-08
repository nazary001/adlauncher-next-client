"use client";

// Confirm-and-fire dialog for the Auto-landings "Launch campaign" button (owner). It calls
// prepare-launch (Gemini ad copy + a fresh creative staged to Blob + a ready MO Campaign), shows the
// buyer the EXACT campaign that will fire, lets them pick the soc signer / fanka / account / pixel
// (defaults pre-filled), and on Confirm streams the same /api/launch pipeline the launcher uses.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Campaign } from "@/lib/types";
import type { AutoLandingJob } from "@/lib/auto-landings";

type Prepared = {
  campaign: Campaign;
  media: { url: string; kind: "image" };
  linkPreview: string;
  suggested: { channel: string; account: { id: string; name: string } | null; pixel: { id: string; name: string } | null };
  landing: { slug: string; title: string; niche: string; lang: string };
};
type SocStatus = { name: string; ok: boolean; error?: string; system?: boolean };
type Page = { id: string; name: string };
type Pixel = { id: string; name: string };
type Account = { id: string; name: string; pixels: Pixel[] };

const FIRE_STAGES = ["gcm", "processing", "campaign", "adset", "creative", "ad"] as const;
const STAGE_LABEL: Record<string, string> = {
  gcm: "Reserving code", processing: "Preparing creative", campaign: "Creating campaign",
  adset: "Creating ad set", creative: "Building creative", ad: "Publishing ad",
};
const newTaskId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function AutoLaunchModal({ job, onClose }: { job: AutoLandingJob; onClose: () => void }) {
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [prepErr, setPrepErr] = useState<string | null>(null);

  const [socs, setSocs] = useState<SocStatus[] | null>(null);
  const [channel, setChannel] = useState(""); // "soc:<name>"
  const [pages, setPages] = useState<Page[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pageId, setPageId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [budget, setBudget] = useState("10");
  const [gcmNext, setGcmNext] = useState<string | null>(null);

  const [firing, setFiring] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 1) prepare (Gemini copy + creative). Runs once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/auto-landings/${job.documentId}/prepare-launch`, { method: "POST" });
        const d = (await r.json().catch(() => ({}))) as Prepared & { ok?: boolean; error?: string };
        if (!alive) return;
        if (!r.ok || !d.ok) return setPrepErr(d.error || `prepare failed (${r.status})`);
        setPrep(d);
        setChannel(d.suggested.channel || "");
        setBudget(d.campaign.budget || "10");
        setPixelId(d.suggested.pixel?.id || "");
        setAccountId(d.suggested.account?.id || "");
      } catch (e) {
        if (alive) setPrepErr(String((e as Error).message ?? e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [job.documentId]);

  // 2) load signers + the next free gcm code once prep is in. The code shown here is the code the
  // fire will TRY to claim; /api/launch reserves it atomically (walking to the next free one if a
  // concurrent launch took it in the meantime), so the preview is real but the claim stays race-safe.
  useEffect(() => {
    if (!prep) return;
    let alive = true;
    fetch("/api/gcm")
      .then((r) => r.json())
      .then((d: { next?: string | null }) => {
        if (alive && d?.next) setGcmNext(String(d.next));
      })
      .catch(() => {
        /* preview falls back to "auto"; the fire still claims a real code */
      });
    fetch("/api/mo-socs")
      .then((r) => r.json())
      .then((d: { ok?: boolean; statuses?: SocStatus[] }) => {
        if (!alive) return;
        const list = Array.isArray(d?.statuses) ? d.statuses : [];
        setSocs(list);
        setChannel((cur) => cur || (list.find((s) => s.ok) ? `soc:${list.find((s) => s.ok)!.name}` : ""));
      })
      .catch(() => alive && setSocs([]));
    return () => {
      alive = false;
    };
  }, [prep]);

  // 3) load fankas + accounts for the chosen signer
  useEffect(() => {
    if (!channel) return;
    let alive = true;
    setPages(null);
    setAccounts(null);
    const q = `channel=${encodeURIComponent(channel)}`;
    fetch(`/api/fanpages?${q}`)
      .then((r) => r.json())
      .then((d: { ok?: boolean; pages?: Page[] }) => {
        if (!alive) return;
        const list = Array.isArray(d?.pages) ? d.pages : [];
        setPages(list);
        setPageId((cur) => cur || (list[0]?.id ?? ""));
      })
      .catch(() => alive && setPages([]));
    fetch(`/api/adaccounts?${q}`)
      .then((r) => r.json())
      .then((d: { ok?: boolean; accounts?: Account[] }) => {
        if (!alive) return;
        const list = Array.isArray(d?.accounts) ? d.accounts : [];
        setAccounts(list);
        setAccountId((cur) => (cur && list.some((a) => a.id === cur) ? cur : list[0]?.id ?? cur));
      })
      .catch(() => alive && setAccounts([]));
    return () => {
      alive = false;
    };
  }, [channel]);

  // keep the pixel valid for the chosen account
  const acct = accounts?.find((a) => a.id === accountId) ?? null;
  useEffect(() => {
    if (!acct) return;
    setPixelId((cur) => (cur && acct.pixels.some((p) => p.id === cur) ? cur : acct.pixels[0]?.id ?? ""));
  }, [acct]);

  const canFire = Boolean(prep && channel && pageId && accountId && pixelId && Number(budget) >= 1 && !firing && !result?.ok);

  const fire = useCallback(async () => {
    if (!prep || !canFire) return;
    setFiring(true);
    setResult(null);
    setStage("gcm");
    // The launch route claims the gcm atomically; pass the previewed code as the DESIRED one so it
    // claims that (or the next free if a concurrent wave took it). Empty = let it pick from the pool.
    const campaign: Campaign = { ...prep.campaign, gcm: gcmNext ?? "", page: pageId, account: accountId, pixel: pixelId, budget };
    const body = {
      partnerId: "in",
      campaign,
      channel,
      medias: [{ url: prep.media.url, kind: "image" as const }],
      mediaUrl: prep.media.url,
      mediaKind: "image" as const,
      taskId: newTaskId(),
    };
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.body) throw new Error(`no stream (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let final: { ok?: boolean; stage?: string; error?: string; link?: string; gcm?: string } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { stage?: string; ok?: boolean; error?: string; link?: string; gcm?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.stage && ev.ok === undefined) setStage(ev.stage);
          if (ev.ok !== undefined) final = ev;
        }
      }
      if (final?.ok) {
        setResult({ ok: true, text: `Live · gcm ${final.gcm}` });
      } else {
        setResult({ ok: false, text: final?.error || "launch failed (stream ended)" });
      }
    } catch (e) {
      setResult({ ok: false, text: String((e as Error).message ?? e) });
    } finally {
      setFiring(false);
      setStage(null);
    }
  }, [prep, canFire, pageId, accountId, pixelId, budget, channel, gcmNext]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const sel =
    "h-8 rounded-lg border border-line bg-surface2 px-2 text-[12px] text-ink outline-none focus:border-accent/60";
  const label = "text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-ink">Launch campaign</p>
            <p className="mt-0.5 text-[11px] text-faint">
              {job.niche} · {job.lang.toUpperCase()} · <span className="truncate">{job.title}</span>
            </p>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface2 text-faint hover:text-ink">✕</button>
        </div>

        {prepErr ? (
          <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-4 text-[12px] text-danger">
            Preparation failed: {prepErr}
          </div>
        ) : !prep ? (
          <div className="flex items-center gap-3 px-1 py-8 text-[12px] text-faint">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            Gemini is writing the ad copy and generating a fresh creative…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              {/* creative */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={prep.media.url} alt="ad creative" className="h-28 w-[199px] shrink-0 rounded-lg border border-line object-cover" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-snug text-ink">{prep.campaign.headline}</p>
                <p className="mt-1 line-clamp-3 text-[12px] leading-snug text-dim">{prep.campaign.copy}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="rounded border border-line bg-surface2 px-1.5 py-0.5 text-[10px] font-semibold text-faint">{prep.campaign.cta}</span>
                  <span className="text-[10px] text-faint">geo {prep.campaign.countries.join(", ")}</span>
                </div>
              </div>
            </div>

            <div>
              <p
                className="truncate rounded-lg border border-line bg-surface2 px-2 py-1.5 text-[10.5px] text-launch2"
                title={prep.linkPreview.replace("gcm=NN", `gcm=${gcmNext ?? "auto"}`)}
              >
                {prep.linkPreview.replace("gcm=NN", `gcm=${gcmNext ?? "auto"}`).replace("https://", "")}
              </p>
              <p className="mt-0.5 px-1 text-[9.5px] text-faint">
                gcm <span className="font-mono text-launch2">{gcmNext ?? "…"}</span> is reserved atomically the moment you launch (next free 01–200).
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <span className={label}>Signer</span>
                <select className={sel} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="">— pick signer —</option>
                  {(socs ?? []).map((s) => (
                    <option key={s.name} value={`soc:${s.name}`} disabled={!s.ok}>
                      {s.name}{s.ok ? "" : " (token down)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Fanpage</span>
                <select className={sel} value={pageId} onChange={(e) => setPageId(e.target.value)} disabled={!pages}>
                  {!pages ? <option>loading…</option> : pages.length === 0 ? <option value="">none</option> : null}
                  {(pages ?? []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Ad account</span>
                <select className={sel} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!accounts}>
                  {!accounts ? <option>loading…</option> : accounts.length === 0 ? <option value="">none</option> : null}
                  {(accounts ?? []).map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Pixel</span>
                <select className={sel} value={pixelId} onChange={(e) => setPixelId(e.target.value)} disabled={!acct}>
                  {!acct ? <option>—</option> : acct.pixels.length === 0 ? <option value="">no pixel</option> : null}
                  {(acct?.pixels ?? []).map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Daily budget $</span>
                <input className={sel} value={budget} inputMode="decimal" onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} />
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Bid</span>
                <input className={`${sel} text-faint`} value="Lowest cost · Purchase" readOnly />
              </div>
            </div>

            {result ? (
              <div className={`rounded-xl border px-3 py-2 text-[12px] ${result.ok ? "border-launch/40 bg-launch/10 text-launch2" : "border-danger/40 bg-danger/10 text-danger"}`}>
                {result.ok ? "✅ Campaign is live. " : "❌ "}{result.text}
              </div>
            ) : firing ? (
              <div className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-[#9db8ff]">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
                {FIRE_STAGES.indexOf((stage as (typeof FIRE_STAGES)[number]) ?? "gcm") + 1}/{FIRE_STAGES.length} · {STAGE_LABEL[stage ?? "gcm"] ?? stage}
              </div>
            ) : null}

            <div className="mt-1 flex items-center justify-end gap-2">
              <button onClick={onClose} className="h-9 rounded-lg border border-line bg-surface2 px-3 text-[12px] text-dim hover:text-ink">
                {result?.ok ? "Close" : "Cancel"}
              </button>
              {!result?.ok ? (
                <button
                  onClick={() => void fire()}
                  disabled={!canFire}
                  className="h-9 rounded-lg border border-launch/50 bg-launch/15 px-4 text-[12px] font-semibold text-launch2 transition-colors enabled:hover:bg-launch/25 disabled:opacity-40"
                >
                  {firing ? "Launching…" : "Confirm & launch"}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
