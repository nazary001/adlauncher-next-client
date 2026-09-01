"use client";

import type { RichOption } from "@/lib/catalog";
import type { MoSocStatus } from "./use-mo-socs";
import { SearchSelect } from "./search-select";

/** The MO signer pick persists across refreshes AND boards (launcher ↔ cloner share it): a wave
 *  routed onto a soc must not silently snap elsewhere next session. "" = not picked yet — the
 *  boards auto-pick a default once the roster lands (the system token is RETIRED, 09-01). */
export const MO_CHANNEL_LS = "adlauncher.mo.channel";

/** The default signer once the roster lands: the system-class entry (Spencermo) when healthy,
 *  else the first healthy soc, else the system-class one dead, else the first — never "". */
export function defaultMoSoc(socs: MoSocStatus[]): string {
  const pick =
    socs.find((s) => s.system && s.ok) ?? socs.find((s) => s.ok) ?? socs.find((s) => s.system) ?? socs[0];
  return pick?.name ?? "";
}

/** Signer options: full names (the old chip grid truncated six socs into unreadable stubs),
 *  live health as the right-aligned tag, a dead soc's FB error in the sub-line. Dead socs stay
 *  pickable on purpose — their launches fail with FB's own reason; silently rerouting would
 *  defeat the buyer's routing choice. */
function socOptions(socs: MoSocStatus[]): RichOption[] {
  return socs.map((s) => ({
    value: s.name,
    label: s.name,
    subLabel: s.ok
      ? s.system
        ? "system-class signer · names unmarked"
        : "personal soc · names carry the SOC marker"
      : s.error || "token dead — re-issue it",
    tag: s.ok ? "live" : "dead",
    tagTone: s.ok ? ("ok" as const) : ("danger" as const),
  }));
}

/**
 * The MO signer picker (launcher rail + clone board): a dropdown with full soc names, live
 * health tags and the picked signer's verdict under it. Replaces the cramped chip grid; the
 * system token is gone from the roster entirely (retired — Meta's ward kills its adset-creates).
 */
export function MoSocPicker({
  socs,
  value,
  onChange,
}: {
  socs: MoSocStatus[] | null;
  value: string;
  onChange: (name: string) => void;
}) {
  const picked = (socs ?? []).find((s) => s.name === value);
  return (
    <div className="flex flex-col gap-1">
      <SearchSelect
        value={value}
        onChange={onChange}
        options={socs ? socOptions(socs) : []}
        placeholder="Pick a signer"
        emptyHint={socs === null ? "Loading signers…" : "No soc tokens provisioned (FB_MO_SOC_TOKENS)"}
        warn={socs !== null && socs.length > 0 && !picked}
      />
      {picked ? (
        picked.ok ? (
          <p className="text-center text-[10px] leading-relaxed text-faint">
            {picked.system
              ? `System-class token "${picked.name}" signs the tree`
              : `Soc token "${picked.name}" signs the tree · names carry the SOC marker`}
          </p>
        ) : (
          <p className="text-center text-[10px] leading-relaxed text-red-400">
            Token dead — pickers stay empty and launches will fail: {picked.error || "re-issue it"}
          </p>
        )
      ) : socs !== null && socs.length === 0 ? (
        <p className="text-center text-[10px] leading-relaxed text-red-400">
          No signers — MO launches are blocked until FB_MO_SOC_TOKENS is provisioned.
        </p>
      ) : null}
    </div>
  );
}
