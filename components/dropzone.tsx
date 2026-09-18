"use client";

import { useEffect, useRef, useState } from "react";
import { FilmIcon, PlayIcon, PlusIcon, UploadIcon, XIcon } from "./icons";
import type { FileItem } from "@/lib/types";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type VidMeta = { duration?: number; w?: number; h?: number };

/** One creative preview. Video shows its first frame, plays on hover, and reads its own
 *  duration/resolution. `large` = hero mode (fills height, letterboxed); else a grid thumb. */
function CreativeCard({
  file,
  large,
  contain = large,
  index,
  warn,
  onRemove,
  onCover,
}: {
  file: FileItem;
  large: boolean;
  /** Letterbox the media instead of cropping it (hero mode always does; the portrait gallery asks
   *  for it so a non-9:16 file visibly fails to fill its phone frame). */
  contain?: boolean;
  /** 1-based position shown in the type chip ("#2 · Video") — the portrait gallery numbers its
   *  tiles so a launch note about "creative #2" points at a tile. */
  index?: number;
  /** A soft issue with this file (wrong aspect…): amber frame + the sentence as the tile's title. */
  warn?: string;
  onRemove: () => void;
  /** Present = the cover picker is enabled (video creatives only): pass the chosen image, or
   *  null to clear. The image is recoded like a dropped creative — it lands on adimages too. */
  onCover?: (cover: { url: string; name: string } | null) => void;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<VidMeta>({});
  const [playing, setPlaying] = useState(false);
  const isImage = file.kind === "image";
  const isVideo = file.kind === "video";

  async function pickCover(list: FileList | null) {
    const raw = list?.[0];
    if (!raw || !onCover) return;
    const recoded = await recodeImage(raw);
    const f = recoded ?? raw;
    if (!recoded && raw.size > IMAGE_MAX_BYTES) return; // undecodable + over the server cap
    onCover({ url: URL.createObjectURL(f), name: f.name });
  }

  const dims = meta.w && meta.h ? `${meta.w}×${meta.h}` : "";
  const bits = [fmtSize(file.size), fmtDur(meta.duration ?? 0), dims].filter(Boolean).join(" · ");

  return (
    <div
      title={warn}
      className={
        "animate-pop-in group/creative relative overflow-hidden rounded-xl border bg-black " +
        (warn ? "border-warn/60 " : "border-line ") +
        (large ? "h-full min-h-0" : "h-full")
      }
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob previews
        <img
          src={file.url}
          alt={file.name}
          className={"h-full w-full " + (contain ? "object-contain" : "object-cover")}
        />
      ) : isVideo ? (
        <video
          ref={vid}
          src={file.url}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setMeta({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
            try {
              v.currentTime = Math.min(0.1, (v.duration || 1) / 2); // paint a real first frame
            } catch {
              /* ignore */
            }
          }}
          onMouseEnter={() => {
            const v = vid.current;
            if (v) void v.play().then(() => setPlaying(true)).catch(() => {});
          }}
          onMouseLeave={() => {
            const v = vid.current;
            if (v) {
              v.pause();
              try {
                v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
              } catch {
                /* ignore */
              }
            }
            setPlaying(false);
          }}
          className={"h-full w-full " + (contain ? "object-contain" : "object-cover")}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-faint">
          <FilmIcon className="h-8 w-8" />
        </div>
      )}

      {/* play affordance (video only, hidden while playing) */}
      {isVideo ? (
        <span
          className={
            "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-200 " +
            (playing ? "opacity-0" : "opacity-100")
          }
        >
          <span
            className={
              "flex items-center justify-center rounded-full bg-black/45 text-white/90 ring-1 ring-white/25 " +
              "backdrop-blur-sm transition-transform duration-200 group-hover/creative:scale-110 " +
              (large ? "h-12 w-12" : "h-8 w-8")
            }
          >
            <PlayIcon className={large ? "h-5 w-5 translate-x-[1px]" : "h-3.5 w-3.5 translate-x-[1px]"} />
          </span>
        </span>
      ) : null}

      {/* type chip */}
      <span className="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-white/80 backdrop-blur-sm">
        {index != null ? `#${index} · ` : ""}
        {isVideo ? "Video" : isImage ? "Image" : "File"}
      </span>

      {/* remove */}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className={
          "absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-white/80 " +
          "opacity-0 backdrop-blur-sm transition-all duration-150 hover:bg-danger/80 hover:text-white " +
          "group-hover/creative:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        }
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>

      {/* custom cover (video creatives only, when the partner supports it): a small chip that
          holds the chosen thumbnail — the launch uploads it and pins it as the ad's cover. */}
      {isVideo && onCover ? (
        <>
          <input
            ref={coverInput}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              void pickCover(e.target.files);
              e.target.value = "";
            }}
          />
          {file.cover ? (
            <span
              className={
                "absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-md bg-black/60 py-1 pl-1 pr-1.5 " +
                "backdrop-blur-sm ring-1 ring-white/15"
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
              <img src={file.cover.url} alt="Cover" className="h-6 w-9 rounded-[4px] object-cover" />
              <span className="font-mono text-[8.5px] font-semibold uppercase tracking-wider text-white/80">
                Cover
              </span>
              <button
                type="button"
                aria-label="Remove cover"
                onClick={() => onCover(null)}
                className={
                  "flex h-4.5 w-4.5 items-center justify-center rounded text-white/70 transition-colors " +
                  "hover:bg-danger/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                }
              >
                <XIcon className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => coverInput.current?.click()}
              title="Pick a custom cover image for this video"
              className={
                "absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 " +
                "font-mono text-[8.5px] font-semibold uppercase tracking-wider text-white/75 backdrop-blur-sm " +
                "ring-1 ring-white/15 transition-colors hover:bg-black/75 hover:text-white " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <PlusIcon className="h-3 w-3" />
              Cover
            </button>
          )}
        </>
      ) : null}

      {/* info footer */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-8">
        <p className={"truncate font-medium text-white " + (large ? "text-[12px]" : "text-[10px]")}>{file.name}</p>
        <p className={"truncate font-mono text-white/60 " + (large ? "text-[10.5px]" : "text-[9px]")}>{bits}</p>
      </div>
    </div>
  );
}

// Meta's adimages rejection ("resized image too large", sub 1885355 — 12 buyer launches killed
// on 08-11 alone) meters the PIXEL STREAM after Meta's own re-encode, not the file size: probed
// live, a 3MB max-entropy 1080² passes while the same content at 2000² (11MB) dies, and a 10MB
// file whose bytes sit in a non-pixel chunk passes. No source-size cap can truly prevent it —
// so oversized images are RE-ENCODED here instead of rejected: scaled to ≤2000px (Meta
// recommends 1080; ads never need more) and recompressed, which lands far under every probed
// limit. Rejection remains only for undecodable files over the server's hard caps.
const IMG_RECODE_SIDE = 2000;
const IMG_RECODE_BYTES = 3 * 1024 * 1024;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024; // server backstop — mirrors /api/launch

/**
 * Downscale + recompress an image file so Meta's re-encode can never call it too large.
 * JPEG (q0.92, white matte) for opaque images, PNG when transparency is real. Returns the
 * original file untouched when it's already small, or null when the file can't be decoded.
 */
async function recodeImage(f: File): Promise<File | null> {
  const bmp = await createImageBitmap(f).catch(() => null);
  if (!bmp) return null;
  const needs = f.size > IMG_RECODE_BYTES || Math.max(bmp.width, bmp.height) > IMG_RECODE_SIDE;
  if (!needs) {
    bmp.close();
    return f;
  }
  const scale = Math.min(1, IMG_RECODE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return f;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // Transparency check (JPEG has none — flattening a transparent creative onto black would
  // wreck it; those stay PNG). JPEG sources can't be transparent, skip the pixel scan.
  let hasAlpha = false;
  if (f.type !== "image/jpeg") {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) {
        hasAlpha = true;
        break;
      }
    }
  }
  if (!hasAlpha) {
    // White matte BEHIND the pixels (destination-over), then export as JPEG.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  const type = hasAlpha ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!blob) return f;
  const name = f.name.replace(/\.[a-z0-9]+$/i, "") + (hasAlpha ? ".png" : ".jpg");
  const out = new File([blob], name, { type });
  // A recompress that somehow grew the file keeps the (already-small-enough?) original only
  // when the original is genuinely smaller AND within limits; otherwise the recode wins.
  return out.size < f.size || f.size > IMAGE_MAX_BYTES ? out : f;
}

/** What a zone takes: images only (a Google logo), videos only (Google video creatives), or both. */
export type DropzoneAccept = "image" | "video" | "any";
const ACCEPT_ATTR: Record<DropzoneAccept, string> = {
  image: "image/png,image/jpeg,image/gif",
  video: "video/mp4,video/quicktime,video/webm",
  any: "image/*,video/*",
};

export function Dropzone({
  id,
  files,
  onChange,
  maxFiles,
  covers,
  accept = "any",
  compact = false,
  portrait = false,
  fileWarnings,
}: {
  id?: string;
  files: FileItem[];
  onChange: (files: FileItem[]) => void;
  /** Cap on creatives (Indians = 1). Undefined = unlimited. */
  maxFiles?: number;
  /** Offer a per-video custom cover picker (HS — the FB Token rail pins it as the thumbnail). */
  covers?: boolean;
  /** Restrict the zone to one media kind: the picker's accept list AND dropped files are
   *  filtered, and a wrong-kind file is refused with a named reason (Google's logo field takes
   *  square PNG/JPG/GIF only, its video field mp4/mov/webm only). Default: images + videos. */
  accept?: DropzoneAccept;
  /** Dense zone for inline slots (the Google ad group's video / logo fields): ~120 px tall, a
   *  smaller glyph and a one-line, kind-specific prompt instead of the launcher's 210 px hero. */
  compact?: boolean;
  /** Portrait gallery (Snapchat): every creative is a numbered 9:16 phone-frame tile in a wrapping
   *  row and the "add" slot is one more frame, so ANY number of files stays a tidy strip. Media is
   *  letterboxed — a file that is not 9:16 visibly fails to fill its frame. */
  portrait?: boolean;
  /** Portrait gallery only: a soft issue per file id (amber frame + tooltip on that tile). */
  fileWarnings?: Record<string, string>;
}) {
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const rejectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atMax = maxFiles != null && files.length >= maxFiles;
  // The list as of NOW for the async adder below: images are recoded (awaited) before they join the
  // list, so a second drop during that wait would otherwise merge into the list it captured and
  // overwrite the first batch. Synced from the prop, and advanced at once when a batch lands.
  const latestFiles = useRef(files);
  useEffect(() => {
    latestFiles.current = files;
  }, [files]);

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const ok: FileItem[] = [];
    const bad: string[] = [];
    for (const raw of Array.from(list)) {
      let f = raw;
      const kind = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : "other";
      if (accept === "image" && (kind !== "image" || !/^image\/(png|jpe?g|gif)$/.test(f.type))) {
        bad.push(`${f.name}: a logo must be a PNG, JPG or GIF image`);
        continue;
      }
      if (accept === "video" && (kind !== "video" || !/^video\/(mp4|quicktime|webm)$/.test(f.type))) {
        bad.push(`${f.name}: videos only here — MP4, MOV or WebM`);
        continue;
      }
      if (kind === "image") {
        const recoded = await recodeImage(f);
        if (recoded) {
          f = recoded; // oversized images auto-shrink instead of erroring at Meta
        } else if (f.size > IMAGE_MAX_BYTES) {
          // Undecodable AND over the server's hard cap — nothing we can do client-side.
          bad.push(`${f.name} — ${fmtSize(f.size)}: can't be read for recompression; export it under 8 MB`);
          continue;
        }
      }
      ok.push({ id: `f${Date.now()}-${counter.current++}`, name: f.name, size: f.size, kind, url: URL.createObjectURL(f) });
    }
    if (ok.length) {
      const merged = [...latestFiles.current, ...ok];
      const next = maxFiles != null ? merged.slice(0, maxFiles) : merged;
      latestFiles.current = next;
      onChange(next);
    }
    setRejected(bad);
    if (rejectTimer.current) clearTimeout(rejectTimer.current);
    if (bad.length) rejectTimer.current = setTimeout(() => setRejected([]), 10_000);
  }

  const browse = () => inputRef.current?.click();
  const remove = (fid: string) => onChange(files.filter((x) => x.id !== fid));

  const zoneEvents = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void addFiles(e.dataTransfer.files);
    },
  };

  const fileInput = (
    <input
      id={id}
      ref={inputRef}
      type="file"
      multiple={maxFiles !== 1}
      accept={ACCEPT_ATTR[accept]}
      className="sr-only"
      onChange={(e) => {
        void addFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  // Refused files, named with the reason — visible right where the buyer just dropped them.
  const rejectNote =
    rejected.length > 0 ? (
      <div className="flex shrink-0 flex-col gap-1">
        {rejected.map((m) => (
          <p
            key={m}
            className="animate-pop-in rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-danger"
          >
            {m}
          </p>
        ))}
      </div>
    ) : null;

  // ---------- portrait gallery (empty and filled are the same strip) ----------
  if (portrait) {
    const frame = "w-[132px] max-w-full shrink-0";
    return (
      <div className="flex flex-col gap-2" {...zoneEvents}>
        {fileInput}
        <div className={"flex flex-wrap gap-2 rounded-xl transition-colors duration-200 " + (dragging ? "outline outline-2 outline-dashed outline-accent/60" : "")}>
          {files.map((f, i) => (
            <div key={f.id} className={frame} style={{ aspectRatio: "9 / 16" }}>
              <CreativeCard file={f} large={false} contain index={i + 1} warn={fileWarnings?.[f.id]} onRemove={() => remove(f.id)} />
            </div>
          ))}
          {!atMax ? (
            <button
              type="button"
              onClick={browse}
              style={{ aspectRatio: "9 / 16" }}
              className={
                frame +
                " group relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-[18px] border border-dashed px-2 text-center " +
                "transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
                (dragging ? "border-accent bg-accent/10" : "border-line2 bg-black/40 hover:border-accent/50 hover:bg-accent/[0.04]")
              }
            >
              <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-white/80 backdrop-blur-sm">9:16</span>
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-line2 bg-surface2 text-dim transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-accent/40 group-hover:text-[#9db8ff]">
                {files.length === 0 ? <UploadIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
              </span>
              <span className="text-[12px] font-medium text-dim transition-colors group-hover:text-ink">{dragging ? "Drop to add" : files.length === 0 ? "Drop creatives here" : "Add more"}</span>
              <span className="text-[10.5px] leading-snug text-faint">{files.length === 0 ? "or click to browse · any number" : "drop or browse"}</span>
            </button>
          ) : null}
        </div>
        {rejectNote}
      </div>
    );
  }

  // ---------- empty ----------
  const prompt =
    accept === "image" ? "Drop a square logo here" : accept === "video" ? `Drop videos here${maxFiles ? ` (up to ${maxFiles})` : ""}` : "Drop a creative here";
  if (files.length === 0) {
    return (
      <div className={"flex h-full flex-col " + (compact ? "min-h-[120px]" : "min-h-[210px]")}>
        {fileInput}
        <button
          type="button"
          onClick={browse}
          {...zoneEvents}
          className={
            "group relative flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-xl " +
            (compact ? "gap-1.5 px-3 py-2 " : "gap-3 ") +
            "border border-dashed transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 " +
            "focus-visible:ring-accent/40 " +
            (dragging
              ? "border-accent bg-accent/10"
              : "border-line2 bg-surface2/40 hover:border-accent/50 hover:bg-accent/[0.04]")
          }
        >
          <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(61,127,255,0.08),transparent_60%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
          <span
            className={
              "relative flex items-center justify-center rounded-2xl border border-line2 bg-surface2 " +
              (compact ? "h-9 w-9 " : "h-12 w-12 ") +
              "text-dim transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-accent/40 group-hover:text-[#9db8ff] " +
              (dragging ? "-translate-y-0.5 border-accent/50 text-[#9db8ff]" : "")
            }
          >
            <UploadIcon className={compact ? "h-4 w-4" : "h-5 w-5"} />
          </span>
          <span className={"relative flex items-center gap-1 " + (compact ? "flex-row flex-wrap justify-center gap-x-1.5" : "flex-col")}>
            <span className={(compact ? "text-[12px] " : "text-[13px] ") + "font-medium text-dim transition-colors group-hover:text-ink"}>
              {dragging ? "Drop to add" : prompt}
            </span>
            <span className="text-[11px] text-faint">{compact ? "· or click to browse" : "or click to browse"}</span>
          </span>
          <span className="relative flex items-center gap-1.5">
            {(accept === "image" ? ["PNG", "JPG", "GIF"] : accept === "video" ? ["MP4", "MOV", "WEBM"] : ["MP4", "JPG", "PNG"]).map((ext) => (
              <span
                key={ext}
                className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px] font-medium tracking-wide text-faint"
              >
                {ext}
              </span>
            ))}
          </span>
        </button>
        {rejectNote}
      </div>
    );
  }

  const single = files.length === 1;

  // ---------- filled ----------
  return (
    <div className={"flex h-full flex-col gap-2 " + (compact ? "min-h-[120px]" : "min-h-[210px]")} {...zoneEvents}>
      {fileInput}

      <div
        className={
          "min-h-0 flex-1 rounded-xl transition-colors duration-200 " +
          (dragging ? "outline outline-2 outline-dashed outline-accent/60" : "") +
          (single ? "" : " grid grid-cols-2 content-start gap-2")
        }
      >
        {files.map((f) => (
          <div key={f.id} className={single ? "h-full" : "h-28"}>
            <CreativeCard
              file={f}
              large={single}
              onRemove={() => remove(f.id)}
              onCover={
                covers && f.kind === "video"
                  ? (cover) =>
                      onChange(files.map((x) => (x.id === f.id ? { ...x, cover: cover ?? undefined } : x)))
                  : undefined
              }
            />
          </div>
        ))}
        {!single && !atMax ? (
          <button
            type="button"
            onClick={browse}
            className={
              "flex h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line2 " +
              "text-faint transition-all duration-150 hover:border-accent/50 hover:bg-accent/5 hover:text-[#9db8ff] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            }
          >
            <PlusIcon className="h-4 w-4" />
            <span className="text-[10px] font-medium">Add more</span>
          </button>
        ) : null}
      </div>

      {single && !atMax ? (
        <button
          type="button"
          onClick={browse}
          className={
            "flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-line2 " +
            "text-[11.5px] font-medium text-faint transition-colors duration-150 hover:border-accent/50 " +
            "hover:bg-accent/5 hover:text-[#9db8ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          }
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Add another creative
        </button>
      ) : null}
      {rejectNote}
    </div>
  );
}
