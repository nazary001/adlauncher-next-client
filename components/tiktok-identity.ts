// TikTok identity helpers for the launcher (client-only). Two jobs:
//  1. The avatar. tiktok-weapon's own upload endpoint crops an identity image to a 256×256 PNG; we
//     host files on Vercel Blob instead (owner decision 18.09), so the SAME normalisation happens
//     here, in the browser, before the upload — whatever the buyer drops, LION receives a square
//     256×256 PNG.
//  2. Memory. A buyer reuses the same two or three identities for weeks; once an avatar is hosted
//     its URL is remembered (this browser only) together with the name, so the next card is one
//     click instead of another upload.

export const IDENTITY_SIZE = 256;
const STORE_KEY = "adlauncher.tiktok.identities";
const MAX_REMEMBERED = 8;

export type RememberedIdentity = { name: string; imageUrl: string };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Identity image can't be read — pick a PNG or JPG"));
    img.src = src;
  });
}

/** Centre-crop the image behind a session object URL to a square and scale it to 256×256 PNG. */
export async function identityAvatarPng(objUrl: string): Promise<File> {
  const img = await loadImage(objUrl);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("Identity image is empty — pick another file");
  const canvas = document.createElement("canvas");
  canvas.width = IDENTITY_SIZE;
  canvas.height = IDENTITY_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare the identity image — paste a hosted https:// image URL instead");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, IDENTITY_SIZE, IDENTITY_SIZE);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Identity image couldn't be converted to PNG — pick another file");
  return new File([blob], "identity.png", { type: "image/png" });
}

/** Identities this browser has launched with, most recent first. Never throws (private mode,
 *  a full or corrupted store → simply no suggestions). */
export function loadIdentities(): RememberedIdentity[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
      .map((x) => ({ name: String(x.name ?? "").trim(), imageUrl: String(x.imageUrl ?? "").trim() }))
      .filter((x) => x.name && /^https:\/\//i.test(x.imageUrl))
      .slice(0, MAX_REMEMBERED);
  } catch {
    return [];
  }
}

/** Put an identity at the head of the remembered list (same name + image = one entry). */
export function rememberIdentity(id: RememberedIdentity): RememberedIdentity[] {
  const name = id.name.trim();
  const imageUrl = id.imageUrl.trim();
  if (!name || !/^https:\/\//i.test(imageUrl)) return loadIdentities();
  const next = [{ name, imageUrl }, ...loadIdentities().filter((x) => !(x.name === name && x.imageUrl === imageUrl))].slice(0, MAX_REMEMBERED);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* a full / blocked store is not worth failing a launch over */
  }
  return next;
}

export function forgetIdentity(id: RememberedIdentity): RememberedIdentity[] {
  const next = loadIdentities().filter((x) => !(x.name === id.name && x.imageUrl === id.imageUrl));
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* see rememberIdentity */
  }
  return next;
}
