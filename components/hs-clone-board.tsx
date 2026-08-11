"use client";

import { useState } from "react";
import { Header } from "./header";
import { Field } from "./ui";
import { SearchSelect } from "./search-select";
import { useHs } from "./use-hs";
import { useHsTaskManager } from "./hs-task-manager";
import { limitMoney, parseMoney } from "@/lib/types";
import type { PartnerId } from "@/lib/partners";
import { CopyIcon, PlusIcon, TrashIcon } from "./icons";
import type { SessionUser } from "./user-menu";

const MAX_COPIES = 20;

type Row = {
  id: string;
  campaignId: string;
  copies: string; // display string, clamped 1..20 on submit
  budget: string; // display string, cents on the wire
  suffix: string;
  state: "idle" | "sending" | "ok" | "error";
  msg?: string;
};

const cellInput =
  "h-8 w-full rounded-md border border-line bg-surface2 px-2 text-[12px] font-mono tabular-nums text-ink " +
  "outline-none transition-colors duration-150 hover:border-line2 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

/**
 * HS duplicator: clone existing LION campaigns through the duplicate weapon (playbook flow —
 * duplicate → creation-status → auto-activate). Binds are the same profile→account→page→pixel
 * cascade as HS launches; each row = one source campaign id × N copies. Submits are instant
 * (LION just enqueues), so successful rows land in the HS Task Manager already "submitted"
 * and ride its polling; bids inherit from the source on purpose (MIN_ROAS sources carry ROAS
 * decimals — overriding blindly is the 100× class mistake).
 */
export function HsCloneBoard({ user, partner }: { user?: SessionUser; partner: PartnerId }) {
  const hs = useHs(true);
  const { enqueueSubmitted, setOpen } = useHsTaskManager();

  const [profile, setProfile] = useState("");
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");
  const [pixel, setPixel] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { id: "r1", campaignId: "", copies: "1", budget: "10", suffix: user?.username ?? "", state: "idle" },
  ]);
  const [firing, setFiring] = useState(false);
  const nextId = { current: rows.length + 1 };

  const data = profile ? hs.dataFor(profile) : undefined;
  const pixels = profile && account ? hs.pixelsFor(profile, account) : undefined;

  const pickProfile = (slug: string) => {
    setProfile(slug);
    setAccount("");
    setPage("");
    setPixel("");
    if (slug) hs.ensureProfile(slug);
  };
  const pickAccount = (id: string) => {
    setAccount(id);
    setPixel("");
    if (profile && id) hs.ensurePixels(profile, id);
  };

  const patchRow = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const addRow = () =>
    setRows((rs) => [
      ...rs,
      {
        id: `r${Date.now()}-${nextId.current++}`,
        campaignId: "",
        copies: "1",
        budget: "10",
        suffix: user?.username ?? "",
        state: "idle",
      },
    ]);
  const removeRow = (id: string) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));

  const bindsReady = Boolean(profile && account && page && pixel);
  const validRows = rows.filter((r) => /^\d{5,}$/.test(r.campaignId.trim()) && parseMoney(r.budget) >= 1);
  const totalCopies = validRows.reduce(
    (s, r) => s + Math.min(MAX_COPIES, Math.max(1, Math.round(Number(r.copies) || 1))),
    0,
  );

  async function duplicateAll() {
    if (!bindsReady || validRows.length === 0 || firing) return;
    setFiring(true);
    try {
      for (const r of rows) {
        const cid = r.campaignId.trim();
        if (!/^\d{5,}$/.test(cid) || parseMoney(r.budget) < 1) continue;
        const copies = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(r.copies) || 1)));
        patchRow(r.id, { state: "sending", msg: undefined });
        try {
          const res = await fetch("/api/hs/duplicate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              profile,
              account,
              page,
              pixel,
              campaignId: cid,
              copies,
              budget: r.budget,
              nameSuffix: r.suffix.trim(),
            }),
          });
          const d = (await res.json().catch(() => ({}))) as { ok?: boolean; taskIds?: string[]; error?: string };
          if (d?.ok && Array.isArray(d.taskIds) && d.taskIds.length > 0) {
            enqueueSubmitted(
              d.taskIds.map((taskId, i) => ({
                name: `Clone of ${cid}${d.taskIds!.length > 1 ? ` · copy ${i + 1}/${d.taskIds!.length}` : ""}`,
                profile,
                geo: "inherited",
                budget: r.budget,
                lionTaskId: String(taskId),
              })),
            );
            patchRow(r.id, { state: "ok", msg: `${d.taskIds.length} task${d.taskIds.length === 1 ? "" : "s"} → HS Tasks` });
          } else {
            // LION's preflight reason is the actionable text ("No valid creative URL…" =
            // object-story source, not duplicable; "Page not found in account data"; …).
            patchRow(r.id, { state: "error", msg: d?.error ?? `HTTP ${res.status}` });
          }
        } catch (e) {
          patchRow(r.id, { state: "error", msg: String((e as Error).message ?? e) });
        }
        // polite pacing between LION submits, matching the launch queue's spirit
        await new Promise((done) => setTimeout(done, 400));
      }
      setOpen(true); // the drawer shows live creation stages + auto-activation
    } finally {
      setFiring(false);
    }
  }

  const changePartner = (id: PartnerId) => {
    const url = new URL(window.location.href);
    url.searchParams.set("partner", id);
    // Cross-rail switch (HS duplicator ↔ MO clone board) is a different server component tree.
    window.location.assign(url.toString());
  };

  return (
    <>
      <Header partner={partner} onPartnerChange={changePartner} user={user} />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 pb-24 pt-6 sm:px-6">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-ink">Duplicate campaigns · HS</h1>
            <span className="rounded-md border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-dim">
              via LION
            </span>
          </div>

          {/* destination binds — same cascade as HS launches */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <p className="pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
              Destination
            </p>
            <div className="grid grid-cols-12 gap-3">
              <Field label="Profile" className="col-span-12 md:col-span-3">
                <SearchSelect
                  value={profile}
                  onChange={pickProfile}
                  options={hs.profiles ?? []}
                  placeholder="Search profile"
                  emptyHint={hs.profiles?.length ? "No matches" : "Loading profiles…"}
                />
              </Field>
              <Field label="Account" className="col-span-12 md:col-span-3">
                <SearchSelect
                  value={account}
                  onChange={pickAccount}
                  options={data?.accounts ?? []}
                  placeholder="Search account"
                  emptyHint={!profile ? "Pick a profile first" : data ? "No enabled accounts" : "Loading…"}
                />
              </Field>
              <Field label="Page" className="col-span-12 md:col-span-3">
                <SearchSelect
                  value={page}
                  onChange={setPage}
                  options={data?.pages ?? []}
                  placeholder="Search page"
                  emptyHint={!profile ? "Pick a profile first" : data ? "No pages" : "Loading…"}
                />
              </Field>
              <Field label="Pixel" className="col-span-12 md:col-span-3">
                <SearchSelect
                  value={pixel}
                  onChange={setPixel}
                  options={(pixels ?? []).map((p) => ({ value: p.id, label: p.name, meta: p.id }))}
                  placeholder="Search pixel"
                  emptyHint={!account ? "Pick an account first" : pixels ? "No pixels on this account" : "Loading…"}
                />
              </Field>
            </div>
          </section>

          {/* source rows */}
          <section className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="grid grid-cols-[minmax(0,1.4fr)_90px_110px_minmax(0,1fr)_minmax(0,1.2fr)_36px] items-center gap-2 border-b border-line px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
              <span>Source campaign ID</span>
              <span>Copies</span>
              <span>Budget $</span>
              <span>Name suffix</span>
              <span>Status</span>
              <span />
            </div>
            {rows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[minmax(0,1.4fr)_90px_110px_minmax(0,1fr)_minmax(0,1.2fr)_36px] items-center gap-2 border-b border-line/60 px-4 py-2.5 last:border-b-0"
              >
                <input
                  value={r.campaignId}
                  onChange={(e) => patchRow(r.id, { campaignId: e.target.value.replace(/\D/g, "") })}
                  placeholder="1202538…"
                  aria-label="Source campaign id"
                  className={cellInput}
                />
                <input
                  value={r.copies}
                  onChange={(e) => patchRow(r.id, { copies: e.target.value.replace(/\D/g, "").slice(0, 2) })}
                  aria-label="Copies"
                  className={cellInput + " text-center"}
                />
                <input
                  value={r.budget}
                  onChange={(e) => patchRow(r.id, { budget: limitMoney(e.target.value, 10000) })}
                  aria-label="Daily budget"
                  className={cellInput}
                />
                <input
                  value={r.suffix}
                  onChange={(e) => patchRow(r.id, { suffix: e.target.value })}
                  placeholder="suffix"
                  aria-label="Name suffix"
                  maxLength={80}
                  className={cellInput.replace("font-mono tabular-nums ", "")}
                />
                <span
                  className={
                    "truncate text-[11.5px] " +
                    (r.state === "error"
                      ? "text-danger"
                      : r.state === "ok"
                        ? "text-launch2"
                        : r.state === "sending"
                          ? "text-[#9db8ff]"
                          : "text-faint")
                  }
                  title={r.msg}
                >
                  {r.state === "sending" ? "Submitting…" : (r.msg ?? "—")}
                </span>
                <button
                  type="button"
                  aria-label="Remove row"
                  onClick={() => removeRow(r.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raise hover:text-danger"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2.5">
              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 py-1.5 text-[11.5px] font-medium text-faint transition-colors hover:border-accent/50 hover:text-[#9db8ff]"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Add source
              </button>
              <p className="text-[10.5px] text-faint">
                Bid, targeting and creatives inherit from the source · clones activate automatically
              </p>
            </div>
          </section>

          <div className="flex items-center justify-end gap-3">
            {!bindsReady ? (
              <span className="text-[11.5px] text-warn">Pick profile · account · page · pixel first</span>
            ) : null}
            <button
              type="button"
              onClick={() => void duplicateAll()}
              disabled={!bindsReady || validRows.length === 0 || firing}
              className={
                "flex h-10 items-center justify-center gap-2 rounded-xl border border-accent/40 bg-accent/15 px-5 " +
                "text-[13px] font-semibold text-[#9db8ff] transition-all duration-150 hover:border-accent/60 " +
                "hover:bg-accent/25 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              }
            >
              <CopyIcon className="h-4 w-4" />
              {firing ? "Submitting…" : `Duplicate ${totalCopies} cop${totalCopies === 1 ? "y" : "ies"}`}
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
