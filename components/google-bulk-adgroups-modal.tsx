"use client";

// Bulk Ad Groups modal for the Google launcher — LION's "Up to 50 videos, auto-split into ad
// groups of 5, duplicating all fields". The buyer types the shared copy/CTA/logo once and pastes
// (or uploads) up to 50 videos; on Create every chunk of ≤5 videos becomes one ad group carrying
// the same fields (chunkVideosIntoAdGroups). "Replace existing ad groups" (default on) swaps the
// card's whole ad-group list; off appends. Assets stay session-local object URLs — they ride
// Vercel Blob only at launch, exactly like the per-card Dropzones.

import { useEffect, useState } from "react";
import { Dropzone } from "./dropzone";
import { AutoTextarea, Select } from "./ui";
import { CheckIcon, PlusIcon, XIcon } from "./icons";
import type { FileItem } from "@/lib/types";
import {
  GOOGLE_BULK_VIDEOS_MAX,
  GOOGLE_CTAS,
  GOOGLE_DESCRIPTION_MAX,
  GOOGLE_HEADLINE_MAX,
  GOOGLE_LONG_HEADLINE_MAX,
  GOOGLE_VIDEOS_MAX,
  chunkVideosIntoAdGroups,
  googleLogoDimsIssue,
  googleLogoUrlNote,
  splitLines,
} from "@/lib/google-bid";
import { freshAdGroup, type AdGroup } from "./google-launch-card";

const inp =
  "h-9 w-full rounded-lg border border-line bg-surface2 px-3 text-[13px] text-ink placeholder:text-faint " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";
const micro = "text-[10px] font-semibold uppercase tracking-[0.16em] text-faint select-none";

const CTA_OPTIONS = GOOGLE_CTAS.map((c) => ({ value: c.value, label: c.label }));

/** Split an array into contiguous chunks of `size` (the file-mode mirror of
 *  chunkVideosIntoAdGroups, which chunks string URLs — files carry FileItems). */
function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function GoogleBulkAdGroupsModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  /** Hand the built ad groups back to the board; `replace` swaps the card's list vs appends. */
  onCreate: (groups: AdGroup[], replace: boolean) => void;
}) {
  const [headlines, setHeadlines] = useState("");
  const [longHeadlines, setLongHeadlines] = useState("");
  const [descriptions, setDescriptions] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [logoMode, setLogoMode] = useState<"url" | "file">("url");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoFiles, setLogoFiles] = useState<FileItem[]>([]);
  const [logoDims, setLogoDims] = useState<{ w: number; h: number } | null>(null);
  const [videoMode, setVideoMode] = useState<"youtube" | "files">("youtube");
  const [youtubeText, setYoutubeText] = useState("");
  const [videoFiles, setVideoFiles] = useState<FileItem[]>([]);
  const [replace, setReplace] = useState(true);
  const [logoNote, setLogoNote] = useState("");

  // Reset every time the modal opens (each card starts from a blank bulk sheet). Guarded on `open`
  // flipping to true — a plain reset-on-open, no cascade.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeadlines("");
    setLongHeadlines("");
    setDescriptions("");
    setCallToAction("");
    setLogoMode("url");
    setLogoUrl("");
    setLogoFiles([]);
    setLogoDims(null);
    setVideoMode("youtube");
    setYoutubeText("");
    setVideoFiles([]);
    setReplace(true);
    setLogoNote("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const onLogo = (files: FileItem[]) => {
    const imgs = files.filter((f) => f.kind === "image").slice(0, 1);
    setLogoNote("");
    setLogoFiles(imgs);
    setLogoDims(null);
    const first = imgs[0];
    if (first) {
      const img = new Image();
      img.onload = () => setLogoDims({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => setLogoNote("Couldn't read that image — pick a PNG, JPG or GIF.");
      img.src = first.url;
    }
  };
  const onVideos = (files: FileItem[]) => setVideoFiles(files.filter((f) => f.kind === "video").slice(0, GOOGLE_BULK_VIDEOS_MAX));

  const urls = videoMode === "youtube" ? splitLines(youtubeText).slice(0, GOOGLE_BULK_VIDEOS_MAX) : [];
  const count = videoMode === "youtube" ? urls.length : videoFiles.length;
  const groupCount = Math.ceil(count / GOOGLE_VIDEOS_MAX);
  const logoUrlNote = logoMode === "url" ? googleLogoUrlNote(logoUrl) : null;
  const logoDimsIssue = logoMode === "file" ? googleLogoDimsIssue(logoDims) : null;
  const canCreate = count > 0;

  // The shared fields every generated ad group carries (copy/CTA/logo/channel).
  const baseFields: Omit<AdGroup, "id" | "videoMode" | "youtubeText" | "videoFiles"> = {
    headlines,
    longHeadlines,
    descriptions,
    callToAction,
    channelId: "",
    logoMode,
    logoUrl,
    logoFiles,
    logoDims,
  };

  const create = () => {
    if (!canCreate) return;
    let groups: AdGroup[];
    if (videoMode === "youtube") {
      // chunkVideosIntoAdGroups splits the URLs into groups of ≤5, duplicating the template fields.
      const chunks = chunkVideosIntoAdGroups(urls, { i: 0 }, "youtubeUrls");
      groups = chunks.map((c) => ({
        ...freshAdGroup(),
        ...baseFields,
        // Clone the shared logo file per group so a later edit can't bleed across groups.
        logoFiles: logoFiles.map((f) => ({ ...f })),
        videoMode: "youtube",
        youtubeText: c.youtubeUrls.join("\n"),
        videoFiles: [],
      }));
    } else {
      groups = chunk(videoFiles, GOOGLE_VIDEOS_MAX).map((files) => ({
        ...freshAdGroup(),
        ...baseFields,
        logoFiles: logoFiles.map((f) => ({ ...f })),
        videoMode: "files",
        youtubeText: "",
        videoFiles: files.map((f) => ({ ...f })),
      }));
    }
    onCreate(groups, replace);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="animate-pop-in relative flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)]">
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-line px-6 py-5">
          <div>
            <h2 className="text-[17px] font-semibold leading-tight text-ink">Bulk ad groups</h2>
            <p className="mt-1.5 text-[13px] text-dim">Up to {GOOGLE_BULK_VIDEOS_MAX} videos — auto-split into ad groups of {GOOGLE_VIDEOS_MAX}, duplicating all fields.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-raise hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-4">
          <div className="flex flex-col gap-1.5">
            <span className={micro}>Headlines</span>
            <input value={headlines} onChange={(e) => setHeadlines(e.target.value)} placeholder="H1 | H2 | H3" aria-label="Headlines" className={inp} title={`Pipe-separated, max ${GOOGLE_HEADLINE_MAX} chars each`} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={micro}>Long headlines</span>
            <input value={longHeadlines} onChange={(e) => setLongHeadlines(e.target.value)} placeholder="Long headline 1 | Long headline 2" aria-label="Long headlines" className={inp} title={`Pipe-separated, max ${GOOGLE_LONG_HEADLINE_MAX} chars each`} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className={micro}>Descriptions</span>
            <input value={descriptions} onChange={(e) => setDescriptions(e.target.value)} placeholder="Description 1 | Description 2" aria-label="Descriptions" className={inp} title={`Pipe-separated, max ${GOOGLE_DESCRIPTION_MAX} chars each`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className={micro}>Call to action</span>
              <Select value={callToAction} onChange={(e) => setCallToAction(e.target.value)} options={CTA_OPTIONS} aria-label="Call to action" />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className={micro}>Logo</span>
                <div className="inline-grid grid-flow-col overflow-hidden rounded-lg border border-line bg-surface2/50 p-0.5">
                  {(["url", "file"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={logoMode === k}
                      onClick={() => setLogoMode(k)}
                      className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " + (logoMode === k ? "bg-accent/20 text-[#9db8ff]" : "text-dim hover:text-ink")}
                    >
                      {k === "url" ? "URL" : "Upload"}
                    </button>
                  ))}
                </div>
              </div>
              {logoMode === "url" ? (
                <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value.trim())} placeholder="https://…/logo.png" aria-label="Logo URL" className={inp} />
              ) : (
                <div className="min-h-[120px]">
                  <Dropzone id="bulk-logo" files={logoFiles} onChange={onLogo} maxFiles={1} accept="image" compact />
                </div>
              )}
              {logoUrlNote ? (
                <p className="text-[10px] leading-snug text-warn">{logoUrlNote}</p>
              ) : logoDimsIssue ? (
                <p className="text-[10px] leading-snug text-warn">{logoDimsIssue}</p>
              ) : logoMode === "file" && logoDims ? (
                <p className="text-[10px] leading-snug text-faint">{logoDims.w}×{logoDims.h} · square ✓</p>
              ) : null}
              {logoNote ? <p className="text-[10px] leading-snug text-warn">{logoNote}</p> : null}
            </div>
          </div>

          {/* video source */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className={micro}>Videos</span>
              <div className="inline-grid grid-flow-col overflow-hidden rounded-lg border border-line bg-surface2/50 p-0.5">
                {(["youtube", "files"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={videoMode === k}
                    onClick={() => setVideoMode(k)}
                    className={"h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors duration-150 " + (videoMode === k ? "bg-accent/20 text-[#9db8ff]" : "text-dim hover:text-ink")}
                  >
                    {k === "youtube" ? "YouTube URLs" : "Upload Videos"}
                  </button>
                ))}
              </div>
            </div>
            {videoMode === "youtube" ? (
              <AutoTextarea
                value={youtubeText}
                onChange={setYoutubeText}
                ariaLabel="YouTube URLs"
                placeholder={`One URL per line — up to ${GOOGLE_BULK_VIDEOS_MAX}`}
                className="block min-h-[120px] w-full resize-none overflow-hidden rounded-lg border border-line bg-surface2 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
              />
            ) : (
              <Dropzone id="bulk-videos" files={videoFiles} onChange={onVideos} maxFiles={GOOGLE_BULK_VIDEOS_MAX} accept="video" compact />
            )}
          </div>

          {/* live count */}
          <div className="flex items-center justify-between rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[12px]">
            <span className={count > GOOGLE_BULK_VIDEOS_MAX ? "text-warn" : "text-dim"}>
              <span className="font-mono tabular-nums text-ink">{count}</span>/{GOOGLE_BULK_VIDEOS_MAX} URLs
            </span>
            <span className="text-dim">
              <span className="font-mono tabular-nums text-ink">{groupCount}</span> ad group{groupCount === 1 ? "" : "s"} will be created
            </span>
          </div>

          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-dim">
            <span
              className={
                "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors " +
                (replace ? "border-accent bg-accent text-white" : "border-line2 bg-surface")
              }
            >
              {replace ? <CheckIcon className="h-3.5 w-3.5" /> : null}
            </span>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="sr-only" />
            Replace existing ad groups
          </label>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2.5 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[14px] font-medium text-dim transition-colors hover:border-line2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={!canCreate}
            className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-4 py-2.5 text-[14px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <PlusIcon className="h-4 w-4" />
            Create {groupCount || ""} Ad Group{groupCount === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
