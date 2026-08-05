"use client";

import { useRef, useState } from "react";
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
  onRemove,
}: {
  file: FileItem;
  large: boolean;
  onRemove: () => void;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  const [meta, setMeta] = useState<VidMeta>({});
  const [playing, setPlaying] = useState(false);
  const isImage = file.kind === "image";
  const isVideo = file.kind === "video";

  const dims = meta.w && meta.h ? `${meta.w}×${meta.h}` : "";
  const bits = [fmtSize(file.size), fmtDur(meta.duration ?? 0), dims].filter(Boolean).join(" · ");

  return (
    <div
      className={
        "animate-pop-in group/creative relative overflow-hidden rounded-xl border border-line bg-black " +
        (large ? "h-full min-h-0" : "h-full")
      }
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- local blob previews
        <img
          src={file.url}
          alt={file.name}
          className={"h-full w-full " + (large ? "object-contain" : "object-cover")}
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
          className={"h-full w-full " + (large ? "object-contain" : "object-cover")}
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

      {/* info footer */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-8">
        <p className={"truncate font-medium text-white " + (large ? "text-[12px]" : "text-[10px]")}>{file.name}</p>
        <p className={"truncate font-mono text-white/60 " + (large ? "text-[10.5px]" : "text-[9px]")}>{bits}</p>
      </div>
    </div>
  );
}

export function Dropzone({
  id,
  files,
  onChange,
}: {
  id?: string;
  files: FileItem[];
  onChange: (files: FileItem[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const added: FileItem[] = Array.from(list).map((f) => ({
      id: `f${Date.now()}-${counter.current++}`,
      name: f.name,
      size: f.size,
      kind: f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : "other",
      url: URL.createObjectURL(f),
    }));
    onChange([...files, ...added]);
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
      addFiles(e.dataTransfer.files);
    },
  };

  const fileInput = (
    <input
      id={id}
      ref={inputRef}
      type="file"
      multiple
      accept="image/*,video/*"
      className="sr-only"
      onChange={(e) => {
        addFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  // ---------- empty ----------
  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-[210px] flex-col">
        {fileInput}
        <button
          type="button"
          onClick={browse}
          {...zoneEvents}
          className={
            "group relative flex h-full w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl " +
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
              "relative flex h-12 w-12 items-center justify-center rounded-2xl border border-line2 bg-surface2 " +
              "text-dim transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-accent/40 group-hover:text-[#9db8ff] " +
              (dragging ? "-translate-y-0.5 border-accent/50 text-[#9db8ff]" : "")
            }
          >
            <UploadIcon className="h-5 w-5" />
          </span>
          <span className="relative flex flex-col items-center gap-1">
            <span className="text-[13px] font-medium text-dim transition-colors group-hover:text-ink">
              {dragging ? "Drop to add" : "Drop a creative here"}
            </span>
            <span className="text-[11px] text-faint">or click to browse</span>
          </span>
          <span className="relative flex items-center gap-1.5">
            {["MP4", "JPG", "PNG"].map((ext) => (
              <span
                key={ext}
                className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px] font-medium tracking-wide text-faint"
              >
                {ext}
              </span>
            ))}
          </span>
        </button>
      </div>
    );
  }

  const single = files.length === 1;

  // ---------- filled ----------
  return (
    <div className="flex h-full min-h-[210px] flex-col gap-2" {...zoneEvents}>
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
            <CreativeCard file={f} large={single} onRemove={() => remove(f.id)} />
          </div>
        ))}
        {!single ? (
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

      {single ? (
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
    </div>
  );
}
