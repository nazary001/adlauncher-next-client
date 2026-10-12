// One buyer, one name (owner 12.10). The console prints the buyer's login into every name it builds
// itself — the Google / TikTok / Snapchat suffix, a clone's " - <Name>" ending — and buyers ALSO type
// their own name into the tail out of FB habit ("Katya - CREO - Lakshmi0910"), so live names came out
// as "09.10 Katya GC-Launcher Katya - CREO - Lakshmi0910". Names are " - "-separated segments; a
// segment that is nothing but the login again (any letter case) is the repeat. Everything else in the
// tail stays exactly as typed — a name inside a longer segment ("KatyaBest", "Katya CREO") is not it.

const norm = (s: string): string => String(s ?? "").trim().toLowerCase();
const segments = (name: string): string[] => String(name ?? "").trim().split(/\s+-\s+/);

/** Does the name already carry `user` as a whole " - " segment? */
export function carriesOwnName(name: string, user: string): boolean {
  const me = norm(user);
  return !!me && segments(name).some((seg) => norm(seg) === me);
}

/** The tail without the segments that only repeat the login the console prints next to it. */
export function dropOwnName(tail: string, user: string): string {
  const t = String(tail ?? "").trim();
  const me = norm(user);
  if (!t || !me) return t;
  const kept = segments(t).filter((seg) => norm(seg) !== me);
  return kept.join(" - ");
}
