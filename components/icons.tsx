import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function S({ children, ...props }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function RocketIcon(props: P) {
  return (
    <S {...props}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </S>
  );
}

export function PlusIcon(props: P) {
  return (
    <S {...props}>
      <path d="M12 5v14M5 12h14" />
    </S>
  );
}

export function TimerIcon(props: P) {
  return (
    <S {...props}>
      <path d="M10 2h4" />
      <path d="M12 14v-4" />
      <circle cx="12" cy="14" r="8" />
    </S>
  );
}

export function CopyIcon(props: P) {
  return (
    <S {...props}>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </S>
  );
}

export function TrashIcon(props: P) {
  return (
    <S {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6M14 11v6" />
    </S>
  );
}

export function ChevronDownIcon(props: P) {
  return (
    <S {...props}>
      <path d="m6 9 6 6 6-6" />
    </S>
  );
}

export function SparklesIcon(props: P) {
  return (
    <S {...props}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4" />
    </S>
  );
}

export function UploadIcon(props: P) {
  return (
    <S {...props}>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m16 16-4-4-4 4" />
    </S>
  );
}

export function GlobeIcon(props: P) {
  return (
    <S {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </S>
  );
}

export function TargetIcon(props: P) {
  return (
    <S {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </S>
  );
}

export function MegaphoneIcon(props: P) {
  return (
    <S {...props}>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </S>
  );
}

export function SlidersIcon(props: P) {
  return (
    <S {...props}>
      <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
      <path d="M14 2v4M8 10v4M16 18v4" />
    </S>
  );
}

export function XIcon(props: P) {
  return (
    <S {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </S>
  );
}

export function CheckIcon(props: P) {
  return (
    <S {...props}>
      <path d="M20 6 9 17l-5-5" />
    </S>
  );
}

export function PlayIcon(props: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" />
    </svg>
  );
}

export function FilmIcon(props: P) {
  return (
    <S {...props}>
      <rect x="2" y="2" width="20" height="20" rx="2.2" />
      <path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 7h5M17 17h5" />
    </S>
  );
}

export function EyeIcon(props: P) {
  return (
    <S {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </S>
  );
}

export function SearchIcon(props: P) {
  return (
    <S {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </S>
  );
}

export function LockIcon(props: P) {
  return (
    <S {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </S>
  );
}

export function LogoutIcon(props: P) {
  return (
    <S {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </S>
  );
}

export function ChevronsIcon(props: P) {
  return (
    <S {...props}>
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </S>
  );
}

export function TasksIcon(props: P) {
  return (
    <S {...props}>
      <path d="m3 8 2 2 3-3" />
      <path d="m3 17 2 2 3-3" />
      <path d="M12 8h9M12 17h9" />
    </S>
  );
}

export function RetryIcon(props: P) {
  return (
    <S {...props}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </S>
  );
}

export function AlertIcon(props: P) {
  return (
    <S {...props}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
    </S>
  );
}

/* ---------- partner flags (circular, simplified) ---------- */

export function BrazilFlag(props: P) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <defs>
        <clipPath id="flag-br">
          <circle cx="12" cy="12" r="11" />
        </clipPath>
      </defs>
      <g clipPath="url(#flag-br)">
        <rect width="24" height="24" fill="#169B3E" />
        <path d="M12 4.2 20.6 12 12 19.8 3.4 12z" fill="#FFDF00" />
        <circle cx="12" cy="12" r="3.5" fill="#002776" />
        <path d="M8.8 11.3c2.4-.4 4.6.3 6.3 1.8" stroke="#fff" strokeWidth="0.9" fill="none" />
      </g>
      <circle cx="12" cy="12" r="10.6" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
    </svg>
  );
}

export function IndiaFlag(props: P) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <defs>
        <clipPath id="flag-in">
          <circle cx="12" cy="12" r="11" />
        </clipPath>
      </defs>
      <g clipPath="url(#flag-in)">
        <rect width="24" height="8" fill="#FF9933" />
        <rect y="8" width="24" height="8" fill="#F5F5F5" />
        <rect y="16" width="24" height="8" fill="#138808" />
        <circle cx="12" cy="12" r="2.5" fill="none" stroke="#000088" strokeWidth="1" />
        <circle cx="12" cy="12" r="0.7" fill="#000088" />
      </g>
      <circle cx="12" cy="12" r="10.6" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
    </svg>
  );
}

export function UsaFlag(props: P) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <defs>
        <clipPath id="flag-us">
          <circle cx="12" cy="12" r="11" />
        </clipPath>
      </defs>
      <g clipPath="url(#flag-us)">
        <rect width="24" height="24" fill="#F5F5F5" />
        {[0, 3.7, 7.4, 11.1, 14.8, 18.5, 22.2].map((y) => (
          <rect key={y} y={y} width="24" height="1.85" fill="#B22234" />
        ))}
        <rect width="12.5" height="11.1" fill="#3C3B6E" />
        {[2.5, 5.5, 8.5].map((x) =>
          [2.2, 5, 7.8].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="0.55" fill="#fff" />),
        )}
      </g>
      <circle cx="12" cy="12" r="10.6" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="0.8" />
    </svg>
  );
}

/* ---------- platform marks ---------- */

export function FacebookMark(props: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047v-2.66c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
    </svg>
  );
}

export function TikTokMark(props: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

export function GoogleMark({ mono, ...props }: P & { mono?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill={mono ? "currentColor" : "#4285F4"}
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill={mono ? "currentColor" : "#34A853"}
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill={mono ? "currentColor" : "#FBBC05"}
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill={mono ? "currentColor" : "#EA4335"}
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
