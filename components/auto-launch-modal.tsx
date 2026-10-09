"use client";

// Confirm-and-fire dialog for the Auto-landings "Launch campaign" button (owner). It calls
// prepare-launch (Gemini ad copy + a fresh creative staged to S3 + a ready MO Campaign), shows the
// buyer the EXACT campaign that will fire, shows the signer (the owner's /tokens pick), lets them
// pick fanka / account / pixel (defaults pre-filled), and on Confirm HANDS the campaign to the
// durable server launch queue (the same hand-off the launcher boards use, 09.10) — the build runs
// on the server, so the tab may be closed the moment the hand-off is accepted. (Until 09.10 the
// fire streamed /api/launch from this tab: closing it mid-build tore the launch down.)

import { useCallback, useEffect, useState } from "react";
import type { Campaign } from "@/lib/types";
import { fullName, limitMoney, parseMoney } from "@/lib/types";
import { UploadingNotice, useUnloadGuard } from "./upload-guard";
import type { AutoLandingJob } from "@/lib/auto-landings";
import { isHandoffUnconfirmed, sendToQueue } from "./launch-queue-client";
import { useSigners } from "./use-signers";
import { SignerBadge } from "./signer-badge";

type Prepared = {
  campaign: Campaign;
  media: { url: string; kind: "image" };
  linkPreview: string;
  suggested: { channel: string; account: { id: string; name: string } | null; pixel: { id: string; name: string } | null };
  landing: { slug: string; title: string; niche: string; lang: string };
};
type Page = { id: string; name: string };
type Pixel = { id: string; name: string };
type Account = { id: string; name: string; pixels: Pixel[] };

const newTaskId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function AutoLaunchModal({ job, onClose }: { job: AutoLandingJob; onClose: () => void }) {
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [prepErr, setPrepErr] = useState<string | null>(null);

  // The MO launch signer is the owner's pick on /tokens — shown read-only, gates the fire.
  const signers = useSigners(true);
  const moSigner = signers.slots?.["mo.launch"] ?? null;
  const signerReady = Boolean(moSigner?.primary);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pageId, setPageId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [budget, setBudget] = useState("10");
  const [gcmNext, setGcmNext] = useState<string | null>(null);

  // "firing" = the hand-off is in flight (seconds): the one moment the tab is still needed.
  const [firing, setFiring] = useState(false);
  useUnloadGuard(firing);
  const [result, setResult] = useState<{ ok: boolean; text: string; retrySafe: boolean; taskId?: string } | null>(null);
  // The staged creative lives in a content-addressed S3 object the launch route never deletes per
  // run (the bucket lifecycle is the cleanup) — so a retry after a refused hand-off reuses the SAME
  // creative (just press Confirm again). "Regenerate" stays available for a fresh one.
  const [prepNonce, setPrepNonce] = useState(0);
  // The task id of the campaign being handed over: the idempotency key — a retry of a hand-off
  // that got no verdict re-sends the SAME id, so the server can never take it twice.
  const [taskId, setTaskId] = useState(() => newTaskId());

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
  }, [job.documentId, prepNonce]);

  // 2) load the next free gcm code once prep is in. The code shown here is the code the
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
    return () => {
      alive = false;
    };
  }, [prep]);

  // 3) load fankas + accounts of the launch signer (server-side pick, ?rail=launch)
  useEffect(() => {
    if (!prep) return;
    let alive = true;
    // Safe setState-in-effect: a signer switch resets the catalogs to loading once, then the
    // fetch callbacks fill them — converges in one pass.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPages(null);
    setAccounts(null);
    const q = "rail=launch";
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
  }, [prep]);

  // keep the pixel valid for the chosen account
  const acct = accounts?.find((a) => a.id === accountId) ?? null;
  useEffect(() => {
    if (!acct) return;
    // Safe setState-in-effect: converges in one pass (a valid pixel is kept, else the
    // account's first is picked once).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPixelId((cur) => (cur && acct.pixels.some((p) => p.id === cur) ? cur : acct.pixels[0]?.id ?? ""));
  }, [acct]);

  // parseMoney reads the board's comma money ("12,50") — Number() would read it as NaN and a
  // stripped "1250" as $1250 (audit 09-09).
  // A refused hand-off may be sent again with one click (nothing exists on the server); a hand-off
  // that got NO verdict is re-sent under the SAME task id (safe: the server answers "accepted" for
  // a job it already has). After an accepted hand-off the button is done — the queue owns it.
  const canFire = Boolean(prep && signerReady && pageId && accountId && pixelId && parseMoney(budget) >= 1 && !firing && !result?.ok);

  const fire = useCallback(async () => {
    if (!prep || !canFire) return;
    setFiring(true);
    setResult(null);
    // The launch route claims the gcm atomically; pass the previewed code as the DESIRED one so it
    // claims that (or the next free if a concurrent wave took it). Empty = let it pick from the pool.
    const campaign: Campaign = { ...prep.campaign, gcm: gcmNext ?? "", page: pageId, account: accountId, pixel: pixelId, budget };
    // The exact mo.launch hand-off the launcher board sends (lib/launch-queue-types parseEnqueue):
    // the route's own request body, minus the task id (the server stamps it).
    const body = {
      partnerId: "in",
      campaign,
      medias: [{ url: prep.media.url, kind: "image" as const }],
      mediaUrl: prep.media.url,
      mediaKind: "image" as const,
    };
    try {
      await sendToQueue("mo", {
        taskId,
        kind: "mo.launch",
        body,
        row: { name: fullName(campaign), gcm: gcmNext ?? "", geo: campaign.countries.join(","), budget, bid: "" },
        account: accountId.replace(/^act_/, ""),
      });
      setResult({ ok: true, text: "Handed to the server — the campaign is being built in the launch queue. You can close this window and the tab; follow it in the Facebook launcher's Tasks drawer.", retrySafe: false, taskId });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (isHandoffUnconfirmed(e)) {
        // No verdict: the server may already have it. Retry re-sends the SAME task id (idempotent).
        setResult({ ok: false, text: msg, retrySafe: true, taskId });
      } else {
        // A clean refusal (a bad field, a creative not on the server, the queue unavailable): nothing
        // exists on the server — a retry is a fresh hand-off of the same campaign.
        setResult({ ok: false, text: msg, retrySafe: true, taskId });
      }
    } finally {
      setFiring(false);
    }
  }, [prep, canFire, pageId, accountId, pixelId, budget, gcmNext, taskId]);

  // Fresh copy + creative for another attempt (optional now — a retry reuses the staged creative;
  // this is for when the buyer wants a different one). A fresh attempt is a fresh task id.
  const regenerate = useCallback(() => {
    setResult(null);
    setPrep(null);
    setPrepErr(null);
    setGcmNext(null);
    setTaskId(newTaskId());
    setPrepNonce((n) => n + 1);
  }, []);

  // While the hand-off is in flight the dialog cannot be dismissed in-app either (backdrop, ✕,
  // Cancel): closing used to unmount and abort the launch (audit find 09.10). It is seconds.
  const close = useCallback(() => {
    if (firing) return;
    onClose();
  }, [firing, onClose]);

  const sel =
    "h-8 rounded-lg border border-line bg-surface2 px-2 text-[12px] text-ink outline-none focus:border-accent/60";
  const label = "text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
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
          <button onClick={close} disabled={firing} className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-surface2 text-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">✕</button>
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
                gcm <span className="font-mono text-launch2">{gcmNext ?? "…"}</span> is reserved atomically the moment the server launches (next free 01–200).
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <span className={label}>Signer</span>
                <SignerBadge signer={moSigner} loaded={signers.loaded} rail="launch" owner compact />
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
                <input
                  className={sel}
                  value={budget}
                  inputMode="decimal"
                  // Same money sanitizer as the campaign card: digits + ONE separator (comma or
                  // dot). The old digits-and-dot strip turned the board-convention "12,50" into
                  // 1250 → $1250/day on an ACTIVE-born launch (audit 09-09).
                  onChange={(e) => setBudget(limitMoney(e.target.value, 10000))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className={label}>Bid</span>
                <input className={`${sel} text-faint`} value="Lowest cost · Purchase" readOnly />
              </div>
            </div>

            {result ? (
              <div className={`rounded-xl border px-3 py-2 text-[12px] ${result.ok ? "border-launch/40 bg-launch/10 text-launch2" : "border-danger/40 bg-danger/10 text-danger"}`}>
                {result.ok ? "✅ " : "❌ "}{result.text}
                {result.ok ? (
                  <p className="mt-1 text-[11px] opacity-80">
                    Task <span className="font-mono">{result.taskId}</span> ·{" "}
                    <a href="/?partner=in" className="underline">
                      open the launcher to watch it
                    </a>
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] opacity-80">
                    Press Retry to hand it over again (safe: the same task id can never be launched twice), or Regenerate for a fresh creative.
                  </p>
                )}
              </div>
            ) : firing ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-[#9db8ff]">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
                  Handing the campaign to the server…
                </div>
                <UploadingNotice n={1} compact />
              </div>
            ) : null}

            <div className="mt-1 flex items-center justify-end gap-2">
              <button onClick={close} disabled={firing} className="h-9 rounded-lg border border-line bg-surface2 px-3 text-[12px] text-dim hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">
                {result?.ok ? "Close" : "Cancel"}
              </button>
              {!result?.ok ? (
                <>
                  {result && !firing ? (
                    <button
                      onClick={regenerate}
                      className="h-9 rounded-lg border border-accent/50 bg-accent/15 px-4 text-[12px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25"
                    >
                      Regenerate creative
                    </button>
                  ) : null}
                  <button
                    onClick={() => void fire()}
                    disabled={!canFire}
                    className="h-9 rounded-lg border border-launch/50 bg-launch/15 px-4 text-[12px] font-semibold text-launch2 transition-colors enabled:hover:bg-launch/25 disabled:opacity-40"
                  >
                    {firing ? "Handing over…" : result ? "Retry hand-off" : "Confirm & launch"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
