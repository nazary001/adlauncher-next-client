"use client";

// TikTok LAUNCH board — the FB / Google launcher's shape for fresh TikTok campaigns: a column of
// campaign CARDS (add / duplicate / remove / collapse, copies per card) on the left, a sticky
// "Launch bay" on the right (per-card readiness, total/day, Preview → Launch). Like every LION rail
// the create is SERVER-side: one POST /api/tiktok/launch stamps the rows and an after() pump sends
// every campaign to LION and settles what LION built, so once the wave is accepted the tab is safe
// to close. The one client-side phase is the creative UPLOAD (avatar → 256² PNG, videos → Vercel
// Blob, three at a time) — while that runs the tab must stay open, so the unload guard + notice
// mount exactly then. Gating is delegated to tiktokLaunchWire (the server's own validator) so the
// bay can never disagree with LION's refusal. Three rules keep a wave from building twice or from
// lying about what it sent: a card that was queued is NOT ready again until it is edited; the cards
// are LOCKED while a wave uploads and fires (what is on screen is what goes out); and a wave goes
// out with EVERY ready card or not at all — the wave id is cut from the ready set, so the body a
// retry re-sends under that id is always the body the first attempt sent.

import { useEffect, useRef, useState } from "react";
import { Header } from "./header";
import { TiktokNav } from "./tiktok-nav";
import { useTiktokAdvertisers, useTiktokConfigs, useTiktokLandings, type TwAdvertiser } from "./use-tiktok";
import { useTiktokTaskManager } from "./tiktok-task-manager";
import { makeGate } from "@/lib/launch-guards";
import { moneyLabel, parseMoney } from "@/lib/types";
import { tiktokBidPlan, tiktokCopies, tiktokResolvePixel, type TiktokLaunchShotIn } from "@/lib/tiktok-launch";
import { readCreative, safeBlobName, uploadCreativeFile } from "./blob-uploader";
import { UploadingNotice, useUnloadGuard } from "./upload-guard";
import { CopyIcon, EyeIcon, PlusIcon } from "./icons";
import {
  FIRST_TT_CARD_ID,
  TiktokLaunchCard,
  buildTiktokShot,
  cloneTiktokCard,
  freshTiktokCard,
  tiktokCardRefusal,
  tiktokCardSignature,
  type TiktokCard,
  type TiktokCardUpload,
} from "./tiktok-launch-card";
import { forgetIdentity, identityAvatarPng, loadIdentities, rememberIdentity, type RememberedIdentity } from "./tiktok-identity";
import type { RichOption } from "@/lib/catalog";
import type { PartnerId } from "@/lib/partners";
import type { SessionUser } from "./user-menu";

/** Server-side wave cap (lib/tiktok-wave TIKTOK_MAX_SHOTS) mirrored so an oversized wave is
 *  refused BEFORE Launch instead of every card flipping to error on the route's 400. */
const MAX_SHOTS = 45;
const MAX_CARDS = 45;
/** Files of one card uploaded to Blob at a time (the Snapchat board's number — a video upload is
 *  mostly waiting on the network, three keep a 20-video card to a third of the wall clock). */
const UPLOAD_CONCURRENCY = 3;

/** One card's derived, catalog-dependent view. */
type CardView = {
  card: TiktokCard;
  target: TwAdvertiser | null;
  effPixel: string;
  pixelNeeded: boolean;
  refusal: string | null;
  copies: number;
  ready: boolean;
  why: string;
};

export function TiktokLaunchBoard({ user }: { user?: SessionUser }) {
  const { advertisers, acr, liveLaunch, error: advError, retry: retryAdvertisers } = useTiktokAdvertisers();
  const { setOpen, counts, refresh } = useTiktokTaskManager();
  const landings = useTiktokLandings();

  const [cards, setCards] = useState<TiktokCard[]>(() => [freshTiktokCard(FIRST_TT_CARD_ID)]);
  const [previewed, setPreviewed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [fireNote, setFireNote] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [identities, setIdentities] = useState<RememberedIdentity[]>([]);
  const fireGate = useRef(makeGate());
  const hlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One waveId per prepared wave (same ready-card content): a retry after a lost answer re-sends
  // the same id, and the server's wave claim makes the re-POST a no-op instead of a second pump.
  const waveRef = useRef<{ sig: string; id: string } | null>(null);
  // Files this tab has already hosted (file id → Blob URL): a wave that has to be fired again — an
  // upload that died on another card, an answer that never came — re-uploads nothing.
  const hostedRef = useRef(new Map<string, string>());

  // Remembered identities live in localStorage — unreadable during SSR, so they join after mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of a browser-only store
    setIdentities(loadIdentities());
  }, []);

  const { configs, retry: retryConfig } = useTiktokConfigs(cards.map((c) => c.advertiser));

  const username = user?.username ?? "";
  const advertiserById = new Map((advertisers ?? []).map((a) => [a.advertiserId, a]));
  const advertisersLoading = advertisers === null && !advError;
  const advertisersFailed = Boolean(advError);

  const advertiserOptions: RichOption[] = (advertisers ?? []).map((a) => ({ value: a.advertiserId, label: a.name, subLabel: a.advertiserId, meta: a.timezone }));

  // Any edit makes a queued / failed card a fresh draft again (and drops the preview).
  const patch = (id: string, p: Partial<TiktokCard>) => {
    if (firing) return; // the wave on its way out was cut from what is on screen — see the header
    setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p, state: "idle", msg: undefined, progress: undefined } : c)));
    setPreviewed(false);
  };
  // A launch-lifecycle patch (upload progress / result) must NOT reset the preview or the state.
  const setCardState = (id: string, p: Partial<TiktokCard>) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const add = () => {
    if (firing) return;
    setCards((cs) => (cs.length >= MAX_CARDS ? cs : [...cs, freshTiktokCard()]));
    setPreviewed(false);
  };
  const duplicate = (id: string) => {
    if (firing) return;
    setCards((cs) => {
      const i = cs.findIndex((c) => c.id === id);
      if (i === -1 || cs.length >= MAX_CARDS) return cs;
      return [...cs.slice(0, i + 1), cloneTiktokCard(cs[i]), ...cs.slice(i + 1)];
    });
    setPreviewed(false);
  };
  const remove = (id: string) => {
    if (firing) return;
    setCards((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
    setPreviewed(false);
  };
  const toggleCollapse = (id: string) => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, collapsed: !c.collapsed } : c)));

  // ---- per-card derived view (pure — no effects) ---------------------------------------------
  const view: CardView[] = cards.map((card) => {
    const target = card.advertiser ? advertiserById.get(card.advertiser) ?? null : null;
    const entry = card.advertiser ? configs[card.advertiser] : undefined;
    const cfg = entry && !("error" in entry) ? entry : null;
    const px = cfg ? tiktokResolvePixel(cfg.pixels, card.pixel, target?.name ?? "") : null;
    const effPixel = px && !("refusal" in px) ? px.pixelCode : "";
    const pixelNeeded = Boolean(cfg && cfg.pixels.length > 1 && !effPixel);
    const refusal = tiktokCardRefusal(card, {
      pixelCode: effPixel,
      supportedModes: px && !("refusal" in px) ? px.supportedModes : undefined,
      config: cfg ? { countries: cfg.countries.map((c) => c.code), languages: cfg.languages.map((l) => l.code) } : undefined,
    });
    const why = !card.advertiser
      ? "pick an advertiser"
      : !target
        ? "advertiser not launchable"
        : entry && "error" in entry
          ? "advertiser config failed — retry"
          : !cfg
            ? "reading the advertiser…"
            : px && "refusal" in px
              ? px.refusal
              : refusal
                ? refusal
                : card.state === "ok"
                  ? "already queued — edit the card to launch it again"
                  : "";
    return { card, target, effPixel, pixelNeeded, refusal, copies: tiktokCopies(card.copies), ready: why === "", why };
  });

  const readyViews = view.filter((v) => v.ready);
  const totalShots = readyViews.reduce((n, v) => n + v.copies, 0);
  const overShotCap = totalShots > MAX_SHOTS;
  const totalPerDay = readyViews.reduce((sum, v) => sum + parseMoney(v.card.budget) * v.copies, 0);

  const uploadingN = cards.filter((c) => c.state === "uploading").length;
  useUnloadGuard(uploadingN > 0);

  const fireBlocked = firing || readyViews.length === 0 || advertisersLoading || advertisersFailed || overShotCap || !liveLaunch;

  // ---- launch bay row jump -------------------------------------------------------------------
  const jumpTo = (id: string) => {
    setCards((cs) => cs.map((c) => (c.id === id && c.collapsed ? { ...c, collapsed: false } : c)));
    setHighlightId(null);
    window.setTimeout(() => {
      document.getElementById(`ttcard-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightId(id);
    }, 60);
    if (hlTimer.current) clearTimeout(hlTimer.current);
    hlTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  /** Upload one card's files: the avatar (cropped to 256² PNG first), then the videos three at a
   *  time. The card goes out with ALL of its files or not at all — a campaign missing a creative is
   *  not what the buyer prepared. */
  async function uploadCard(c: TiktokCard, waveId: string): Promise<TiktokCardUpload> {
    const upload: TiktokCardUpload = {};
    const base = `tiktok/${safeBlobName(username, "buyer")}/${waveId}/${c.id}`;
    if (c.identityMode === "file" && c.identityFiles[0]) {
      setCardState(c.id, { state: "uploading", progress: "Preparing the identity avatar…" });
      const key = `identity:${c.identityFiles[0].id}`;
      let url = hostedRef.current.get(key);
      if (!url) {
        const png = await identityAvatarPng(c.identityFiles[0].url);
        url = await uploadCreativeFile(`${base}-identity.png`, png, "Identity avatar");
        hostedRef.current.set(key, url);
      }
      upload.identityUrl = url;
    }
    if (c.videoMode === "files" && c.videoFiles.length > 0) {
      const files = c.videoFiles;
      const urls: string[] = files.map(() => "");
      let next = 0;
      let done = 0;
      let failed = false;
      setCardState(c.id, { state: "uploading", progress: `Uploading videos… 0/${files.length}` });
      const worker = async () => {
        while (!failed && next < files.length) {
          const i = next++;
          const f = files[i];
          const label = files.length === 1 ? "Video" : `Video #${i + 1} (${f.name})`;
          try {
            let url = hostedRef.current.get(f.id);
            if (!url) {
              const file = await readCreative(f.url, f.name, "video", label);
              url = await uploadCreativeFile(`${base}-v${i + 1}-${safeBlobName(f.name, "video.mp4")}`, file, label);
              hostedRef.current.set(f.id, url);
            }
            urls[i] = url;
          } catch (e) {
            failed = true;
            throw e;
          }
          done += 1;
          if (!failed) setCardState(c.id, { state: "uploading", progress: `Uploading videos… ${done}/${files.length}` });
        }
      };
      // allSettled: every worker has stopped before the board moves on (a rejected one must not
      // leave its siblings uploading into a card that already reads "error").
      const settled = await Promise.allSettled(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
      const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) throw rejected.reason;
      upload.videoUrls = urls;
    }
    return upload;
  }

  // ---- fire: upload each ready card's files once, fan the copies out, one POST -----------------
  async function fireWave() {
    if (fireBlocked) return;
    if (!fireGate.current.enter()) return;
    setFireNote(null);
    setFiring(true);
    const ready = view.filter((v) => v.ready); // snapshot — the loop mutates card state below
    const sig = JSON.stringify(ready.map((v) => tiktokCardSignature(v.card)));
    if (!waveRef.current || waveRef.current.sig !== sig) waveRef.current = { sig, id: crypto.randomUUID() };
    const waveId = waveRef.current.id;

    try {
      const shots: TiktokLaunchShotIn[] = [];
      const shotCard: string[] = []; // parallel to shots: the card id each shot came from
      const hosted: Array<{ card: TiktokCard; upload: TiktokCardUpload }> = [];
      let uploadFailed = false;
      for (const v of ready) {
        const c = v.card;
        let upload: TiktokCardUpload;
        try {
          upload = await uploadCard(c, waveId);
        } catch (e) {
          // This card's upload died → NOTHING is sent. A wave cut short would go out under the id of
          // the full ready set; if its answer were then lost, the retry (upload healed) would re-send
          // that id with MORE cards and be told "already accepted" for campaigns never launched.
          setCardState(c.id, { state: "error", msg: String((e as Error).message ?? e) });
          uploadFailed = true;
          break;
        }
        hosted.push({ card: c, upload });
        const shot = buildTiktokShot({ ...c, pixel: v.effPixel }, { currency: v.target?.currency, advertiserName: v.target?.name, upload });
        for (let j = 0; j < v.copies; j++) {
          shots.push(shot);
          shotCard.push(c.id);
        }
        setCardState(c.id, { state: "sending", msg: "queuing on server…" });
      }

      if (uploadFailed || shots.length === 0) {
        setFireNote("Nothing was launched — a card's files failed to upload (see the note on it). Fix or remove that card and press Launch again: the files that did upload are kept, nothing is uploaded twice.");
        for (const h of hosted) setCardState(h.card.id, { state: "idle", msg: undefined, progress: undefined });
        return;
      }

      const res = await fetch("/api/tiktok/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ waveId, shots }) });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; queued?: number; error?: string; availablePixels?: string[] };
      if (d?.ok) {
        waveRef.current = null; // accepted — the next wave is a new wave
        setPreviewed(false);
        // The files are hosted now: the card keeps their URLs, so launching it again (after an
        // edit) re-uses them instead of uploading the same avatar and videos a second time.
        for (const h of hosted) {
          setCardState(h.card.id, {
            state: "ok",
            msg: "queued — safe to close the tab (LION builds it server-side)",
            ...(h.upload.identityUrl ? { identityMode: "url" as const, identityUrl: h.upload.identityUrl, identityFiles: [] } : {}),
            ...(h.upload.videoUrls ? { videoMode: "urls" as const, videoUrlsText: h.upload.videoUrls.join("\n"), videoFiles: [] } : {}),
          });
          const imageUrl = h.upload.identityUrl ?? (h.card.identityMode === "url" ? h.card.identityUrl : "");
          if (imageUrl) setIdentities(rememberIdentity({ name: h.card.identityName, imageUrl }));
        }
        refresh();
        setOpen(true);
      } else {
        const px = Array.isArray(d?.availablePixels) && d.availablePixels.length ? ` · available pixels: ${d.availablePixels.join(", ")}` : "";
        const msg = (d?.error ?? `HTTP ${res.status}`) + px;
        setFireNote(msg);
        // "shot N: …" pins the failure to one card; otherwise every contributing card carries it.
        const m = /^shot (\d+):/.exec(String(d?.error ?? ""));
        const culprit = m ? shotCard[Number(m[1]) - 1] : null;
        for (const id of new Set(shotCard)) {
          setCardState(id, culprit ? (id === culprit ? { state: "error", msg } : { state: "error", msg: "wave refused — fix the flagged card" }) : { state: "error", msg });
        }
      }
    } catch (e) {
      // No ANSWER is not a refusal: the wave may have been accepted before the connection dropped.
      // The same cards re-send the SAME wave id (the server answers "already accepted" instead of
      // pumping twice) — an edit would mint a new id, so the drawer is the thing to look at first.
      setFireNote(`No answer from the server (${String((e as Error).message ?? e)}) — the wave MAY have been accepted: check the Task Manager. Pressing Launch again WITHOUT edits is safe.`);
      for (const v of ready) setCardState(v.card.id, { state: "error", msg: "no answer — check the Task Manager before editing this card", progress: undefined });
      refresh();
      setOpen(true);
    } finally {
      setFiring(false);
      fireGate.current.exit();
    }
  }

  // Leaving the TikTok platform entirely → a full navigation back to the Facebook board on the
  // picked partner (a different server component tree, not a client route within TikTok).
  const changePartner = (id: PartnerId) =>
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/?partner=${id}`);

  const noAdvertiserCount = view.filter((v) => v.card.advertiser === "").length;
  const pixelNeededCount = view.filter((v) => v.pixelNeeded).length;
  const refusalCount = view.filter((v) => Boolean(v.card.advertiser) && v.target && !v.pixelNeeded && v.refusal).length;

  return (
    <>
      <Header partner="br" onPartnerChange={changePartner} user={user} platform="tiktok" />
      <TiktokNav active="launch" />
      <main className="flex-1">
        <div className="mx-auto grid w-full max-w-[1440px] items-start gap-5 px-4 pb-24 pt-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6 xl:px-6">
          {/* ---- campaign cards ---- */}
          <section className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-sm font-semibold text-ink">Campaigns</h1>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{cards.length}</span>
              <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 text-[10.5px] text-faint">TikTok · Smart Creative</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={add}
                  disabled={cards.length >= MAX_CARDS || firing}
                  className="flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3.5 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <PlusIcon className="h-4 w-4" />
                  New campaign
                </button>
              </div>
            </div>

            {view.map((v, i) => (
              <TiktokLaunchCard
                key={v.card.id}
                card={v.card}
                index={i}
                user={user}
                advertiserOptions={advertiserOptions}
                config={v.card.advertiser ? configs[v.card.advertiser] : undefined}
                onRetryConfig={retryConfig}
                acr={acr}
                advertiserName={v.target?.name ?? ""}
                effPixel={v.effPixel}
                pixelNeeded={v.pixelNeeded}
                refusal={v.refusal}
                ready={v.ready}
                advertisersLoading={advertisersLoading}
                highlight={highlightId === v.card.id}
                locked={firing}
                landings={landings}
                identities={identities}
                onForgetIdentity={(id) => setIdentities(forgetIdentity(id))}
                onPatch={patch}
                onDuplicate={duplicate}
                onRemove={remove}
                onToggleCollapse={toggleCollapse}
              />
            ))}

            <button
              type="button"
              onClick={add}
              disabled={cards.length >= MAX_CARDS || firing}
              className="flex h-13 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line2 py-3 text-[13px] font-medium text-dim transition-all duration-200 hover:border-accent/50 hover:bg-accent/5 hover:text-ink active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <PlusIcon className="h-4 w-4" />
              Add campaign
            </button>
          </section>

          {/* ---- launch bay ---- */}
          <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-32">
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto lg:overscroll-contain">
              <div className="flex shrink-0 items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Launch bay</span>
                <span
                  className={
                    "rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] " +
                    (readyViews.length === cards.length ? "border-launch/30 bg-launch/10 text-launch2" : "border-warn/25 bg-warn/5 text-warn")
                  }
                >
                  {readyViews.length}/{cards.length} ready
                </span>
              </div>

              <p className="text-[10.5px] leading-snug text-faint">
                Fresh TikTok campaigns — LION builds each one server-side (1–3 min). Avatar and video uploads run from this tab; keep it open until they finish.
              </p>

              {/* per-card readiness rows */}
              <div className="-mx-2 flex flex-col">
                {view.map((v, i) => (
                  <button
                    key={v.card.id}
                    type="button"
                    onClick={() => jumpTo(v.card.id)}
                    title="Jump to this campaign"
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-raise/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <span className="w-5 shrink-0 font-mono text-[10.5px] text-faint group-hover:text-[#9db8ff]">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{v.target?.name || "No advertiser"}</span>
                      <span className={"block truncate text-[10.5px] " + (v.ready ? "text-faint" : v.card.state === "ok" ? "text-launch2" : "text-warn")}>
                        {v.ready ? `${v.card.countries.join("+") || "—"}${v.copies > 1 ? ` · ×${v.copies}` : ""}` : v.why}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-dim">${moneyLabel(v.card.budget)}</span>
                    <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (v.ready ? "bg-launch2" : v.card.state === "ok" ? "bg-launch2/40" : "bg-warn")} />
                  </button>
                ))}
              </div>

              {/* totals */}
              <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-dim">
                <div className="flex items-center justify-between">
                  <span className="text-faint">Campaigns</span>
                  <span className="font-mono tabular-nums">{totalShots}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-faint">Total/day</span>
                  <span className="font-mono tabular-nums">${moneyLabel(totalPerDay)}</span>
                </div>
              </div>

              <UploadingNotice n={uploadingN} compact />

              <button
                type="button"
                onClick={() => {
                  setPreviewed(true);
                  setFireNote(null);
                }}
                disabled={readyViews.length === 0}
                className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/10 text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <EyeIcon className="h-4 w-4" />
                Generate preview
              </button>

              {previewed ? (
                <button
                  type="button"
                  onClick={() => void fireWave()}
                  disabled={fireBlocked}
                  className="animate-pop-in flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-launch2 to-launch text-[13.5px] font-bold text-[#032e20] shadow-[0_8px_28px_rgba(16,185,129,0.35)] transition-all duration-150 hover:shadow-[0_10px_36px_rgba(16,185,129,0.5)] hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-launch2"
                >
                  <CopyIcon className="h-4 w-4" />
                  {firing ? "Launching…" : `Launch ${totalShots}`}
                </button>
              ) : null}

              {fireNote ? <div className="animate-pop-in rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-[11px] leading-relaxed text-warn">{fireNote}</div> : null}

              {/* gates */}
              {!liveLaunch ? (
                <p className="animate-pop-in rounded-lg border border-line bg-surface2/40 px-3 py-2 text-center text-[11px] leading-relaxed text-dim">
                  This instance reads the live partner but won&apos;t fire at it (not production) — launching is off here.
                </p>
              ) : null}
              {advertisersFailed ? (
                <div className="animate-pop-in flex flex-col items-center gap-1.5 text-center text-[11px] font-semibold leading-relaxed text-warn">
                  <span>Couldn&apos;t load the TikTok advertisers — {advError}.</span>
                  <button
                    type="button"
                    onClick={retryAdvertisers}
                    className="rounded-md border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11.5px] font-semibold text-[#9db8ff] transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {noAdvertiserCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {noAdvertiserCount} campaign{noAdvertiserCount === 1 ? " needs" : "s need"} an advertiser — every launch needs somewhere to land.
                </p>
              ) : null}
              {pixelNeededCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {pixelNeededCount} campaign{pixelNeededCount === 1 ? " needs" : "s need"} a pixel — that advertiser has several, pick one.
                </p>
              ) : null}
              {refusalCount > 0 ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {refusalCount} campaign{refusalCount === 1 ? " is" : "s are"} incomplete — see the note on the card.
                </p>
              ) : null}
              {overShotCap ? (
                <p className="animate-pop-in text-center text-[11px] font-semibold leading-relaxed text-warn">
                  {totalShots} campaigns — one wave carries at most {MAX_SHOTS}. Lower the copies or split into two waves.
                </p>
              ) : null}

              {/* preview list */}
              {previewed ? (
                <div className="animate-pop-in flex flex-col gap-1.5 rounded-lg border border-line bg-surface2/40 p-3">
                  <p className="pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Preview</p>
                  {readyViews.map((v) => {
                    const plan = tiktokBidPlan({ kind: "launch", mode: v.card.mode, typedBid: v.card.bid.trim(), budget: v.card.budget });
                    const bidText = "refusal" in plan ? "—" : plan.label;
                    return (
                      <p key={v.card.id} className="text-[11.5px] leading-snug text-dim">
                        <span className="text-ink">{v.target?.name}</span> → ${moneyLabel(v.card.budget)}/day · {v.card.countries.join("+")}
                        {v.card.smartPlus ? ` · Smart+${v.card.budgetLevel === "campaign" ? " CBO" : ""}` : ""}
                        <span className="text-[#9db8ff]"> · {bidText}</span>
                        {v.copies > 1 ? <span className="text-faint"> · ×{v.copies}</span> : null}
                      </p>
                    );
                  })}
                  <div className="mt-1 border-t border-line pt-1.5 text-[11.5px] text-ink">
                    {totalShots} campaign{totalShots === 1 ? "" : "s"} · ${moneyLabel(totalPerDay)}/day · fires ONE wave to LION · the tab is safe to close once accepted (uploads finish first).
                  </div>
                </div>
              ) : null}

              {counts.active > 0 ? (
                <p className="text-center text-[10.5px] leading-relaxed text-faint">
                  {counts.active} TikTok build{counts.active === 1 ? "" : "s"} in flight — the Task Manager drawer tracks them.
                </p>
              ) : null}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
