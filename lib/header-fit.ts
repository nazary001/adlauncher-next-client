// The header fits itself to the width it actually has (owner ask 10.11: «чтобы всегда все помещалось
// там … чтобы на меньших экранах ничего не наезжало друг на друга»).
//
// Viewport breakpoints could not do it: what the row holds changes under the same window — the HS
// partner adds the token pool, a launch window turns "5/15m" into "5/5 8:56 · 2 full", a deploy adds
// the update chip, an owner has a menu a designer does not, a task badge appears. So the header is
// MEASURED: its three parts — logo · partner context · controls — are tried in the layouts below,
// roomiest first, and the first that fits stays. This file is the pure half (which layouts, in what
// order, and the walk between them); components/header.tsx is the DOM half (measuring, and the
// attributes the hdr-* rules in app/globals.css follow).
//
// The layouts, roomiest first:
//   1. ONE line, everything squeezed by the same step 0 … MAX_SQUEEZE;
//   2. TWO lines — logo + controls above, the partner context below — each line squeezed on its
//      own, only as far as IT needs;
//   3. a line that still does not fit at the last step may WRAP (a phone-narrow window). Wrapped
//      content cannot overflow, so there is always an answer.
// A squeezed single line comes before two roomy ones: the header is sticky, a second line costs
// every board its height.
//
// The squeeze steps (each keeps the ones before it):
//   1 the "Partner" caption and the user's name
//   2 the labels of the queue button, the token pool and the active platform
//   3 the names of the partners that are not picked (their flags stay, a tooltip names them)
//   4 the wordmark (the team's mark moves onto the logo)
//   5 an owner's quick sign-out (it is in their menu), the "N full" and failover tags

export const MAX_SQUEEZE = 5;

export type HeaderFit = {
  /** 1 = all three parts on one line; 2 = the partner context on its own line below. */
  rows: 1 | 2;
  /** Squeeze step of the logo + controls. */
  top: number;
  /** Squeeze step of the partner context (= `top` on one line). */
  mid: number;
  /** Two lines only: that line does not fit even at the last step, so it wraps. */
  wrapTop: boolean;
  wrapMid: boolean;
};

/** Nothing folded, one line — where a header starts before it has been measured. */
export const ROOMY_FIT: HeaderFit = { rows: 1, top: 0, mid: 0, wrapTop: false, wrapMid: false };

/** Lays the header out one way and says whether it fits. Each call costs a forced layout. */
export type FitProbe = {
  /** One line, all three parts at step `s`. */
  oneRow(s: number): boolean;
  /** Two lines: the logo + controls line at step `s`. */
  top(s: number): boolean;
  /** Two lines: the partner line at step `s`. */
  mid(s: number): boolean;
};

const step = (s: number): number => (Number.isFinite(s) ? Math.min(Math.max(Math.trunc(s), 0), MAX_SQUEEZE) : 0);

/** `s` fits — how much roomier can it get? */
function loosen(s: number, fits: (s: number) => boolean): number {
  while (s > 0 && fits(s - 1)) s--;
  return s;
}
/** `s` does not fit — the first tighter step that does, or -1. */
function tighten(s: number, fits: (s: number) => boolean): number {
  while (s < MAX_SQUEEZE) if (fits(++s)) return s;
  return -1;
}
/** The roomiest step that fits, walking from `s` (a line only ever gets narrower step by step). */
const roomiest = (s: number, fits: (s: number) => boolean): number => (fits(s) ? loosen(s, fits) : tighten(s, fits));

/**
 * The roomiest layout that fits, walking from the one the header is in — so a steady header answers
 * in two measurements on one line (its step fits, the one above does not).
 */
export function settleFit(current: HeaderFit, probe: FitProbe): HeaderFit {
  const cur: HeaderFit = { ...current, top: step(current.top), mid: step(current.mid) };
  // One line? From two lines the question is only whether the tightest single line fits yet.
  const one = cur.rows === 1 ? roomiest(cur.top, probe.oneRow) : probe.oneRow(MAX_SQUEEZE) ? loosen(MAX_SQUEEZE, probe.oneRow) : -1;
  if (one >= 0) return { rows: 1, top: one, mid: one, wrapTop: false, wrapMid: false };
  // Two lines, each on its own. Falling here from one line, both start from the roomiest step.
  const top = roomiest(cur.rows === 2 ? cur.top : 0, probe.top);
  const mid = roomiest(cur.rows === 2 ? cur.mid : 0, probe.mid);
  return { rows: 2, top: top < 0 ? MAX_SQUEEZE : top, mid: mid < 0 ? MAX_SQUEEZE : mid, wrapTop: top < 0, wrapMid: mid < 0 };
}

/** A squeeze attribute's value: every step up to `squeeze`, space-separated, so one
 *  `[data-sq~="3"]` selector means "step 3 or tighter". */
export const squeezeTokens = (squeeze: number): string => Array.from({ length: step(squeeze) }, (_, i) => String(i + 1)).join(" ");

/** What <header> carries for the CSS: data-rows, data-sq (logo + controls), data-sqm (partner
 *  context), data-wrap ("top" / "mid" / "top mid", absent when nothing wraps). */
export type FitAttrs = { rows: string; sq: string; sqm: string; wrap: string | null };

export function fitAttrs(fit: HeaderFit): FitAttrs {
  const wrap = [fit.wrapTop ? "top" : "", fit.wrapMid ? "mid" : ""].filter(Boolean).join(" ");
  return { rows: String(fit.rows), sq: squeezeTokens(fit.top), sqm: squeezeTokens(fit.mid), wrap: wrap || null };
}

/** The layout these attributes say; null when they are not a fitted header's (not measured yet). */
export function fitFromAttrs(a: { rows: string | null; sq: string | null; sqm: string | null; wrap: string | null }): HeaderFit | null {
  if (a.rows !== "1" && a.rows !== "2") return null;
  const count = (v: string | null) => step((v ?? "").split(" ").filter(Boolean).length);
  const wraps = (a.wrap ?? "").split(" ");
  return { rows: a.rows === "1" ? 1 : 2, top: count(a.sq), mid: count(a.sqm), wrapTop: wraps.includes("top"), wrapMid: wraps.includes("mid") };
}

/** Half a pixel of slack: sub-pixel text widths must not flip a layout. */
const SLACK = 0.5;

/** One line: all three parts and the two gaps between them, in `inner` (the row minus its padding). */
export const oneRowFits = (logo: number, mid: number, right: number, inner: number, gap: number): boolean => logo + mid + right + 2 * gap <= inner + SLACK;
/** Two lines, the upper one: logo, a gap, the controls. */
export const topLineFits = (logo: number, right: number, inner: number, gap: number): boolean => logo + right + gap <= inner + SLACK;
/** Two lines, the lower one: the partner context alone. */
export const midLineFits = (mid: number, inner: number): boolean => mid <= inner + SLACK;

/**
 * The same fit as a script for the server's HTML (app/layout.tsx puts it right after the page): it
 * runs while the document is still being parsed, so the very first paint is already the layout that
 * fits — without it the header would show its roomiest layout (wrapped where that does not fit)
 * until React wakes up, then jump. Plain ES5 on purpose, nothing imported: it tries the layouts from
 * the top, which is what settleFit(ROOMY_FIT, …) answers. tests/header-fit.test.ts runs it against
 * the walk above so the two cannot drift apart. It touches nothing but the header's own data-rows /
 * data-sq / data-sqm / data-wrap (<header> carries suppressHydrationWarning for them): --hdr-h on
 * <html> is left to the hook — setting it here would hand React an <html> that differs from what it
 * rendered.
 */
export const HEADER_PREFIT_SCRIPT =
  "(function(){var M=" + MAX_SQUEEZE + ",hs=document.querySelectorAll('header[data-hdr]');" +
  "function T(s){for(var t='',j=1;j<=s;j++)t+=(j>1?' ':'')+j;return t}" +
  "function W(e){return e.getBoundingClientRect().width}" +
  "for(var k=0;k<hs.length;k++)(function(h){" +
  "var r=h.querySelector('.hdr-row'),a=h.querySelector('.hdr-logo'),b=h.querySelector('.hdr-mid-in'),c=h.querySelector('.hdr-right');" +
  "if(!r||!a||!b||!c)return;" +
  "var cs=getComputedStyle(r);function G(){return parseFloat(cs.columnGap)||0}" +
  "function X(){return r.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)+" + SLACK + "}" +
  "function S(n,p,q){h.setAttribute('data-rows',n);h.setAttribute('data-sq',T(p));h.setAttribute('data-sqm',T(q))}" +
  "h.removeAttribute('data-wrap');" +
  "for(var s=0;s<=M;s++){S(1,s,s);if(W(a)+W(b)+W(c)+2*G()<=X())return}" +
  "var p=-1,q=-1;" +
  "for(s=0;s<=M;s++){S(2,s,M);if(W(a)+W(c)+G()<=X()){p=s;break}}" +
  "for(s=0;s<=M;s++){S(2,M,s);if(W(b)<=X()){q=s;break}}" +
  "S(2,p<0?M:p,q<0?M:q);" +
  "var w=(p<0?'top':'')+(p<0&&q<0?' ':'')+(q<0?'mid':'');if(w)h.setAttribute('data-wrap',w)" +
  "})(hs[k])})()";
