"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignTemplate, TemplateFields, TemplatePatch } from "@/lib/templates";

// The launcher board's campaign templates (owner ask 16.10): the ACTIVE partner's list from
// /api/templates, kept fresh on a partner switch, on focus (≥ 15 s apart) and after every write of
// this tab. Writes answer with the row the server stored, and the list takes that row — no second
// read. One instance per board; the picker and the save form read it through props.
//
// Keyed by partner like useAvDestinations: a key mismatch IS the loading state, so a switch never
// needs a synchronous setState inside an effect.

export type TemplateWriteFailure = { ok: false; error: string; message?: string; existing?: CampaignTemplate | null; max?: number };
export type TemplateWriteResult = { ok: true; template: CampaignTemplate } | TemplateWriteFailure;

export type TemplatesApi = {
  /** The partner's templates, newest-updated first; null until the first answer for this partner. */
  templates: CampaignTemplate[] | null;
  loading: boolean;
  /** The last read failed (the previous list, if any, stays on screen). */
  error: string | null;
  /** The session's own login as the server knows it (the picker's "you"). */
  me: string;
  /** This session has the owner role (may change / delete anyone's) — the server's word. */
  owner: boolean;
  refresh: () => void;
  create: (input: { name: string; description: string; fields: TemplateFields }) => Promise<TemplateWriteResult>;
  update: (documentId: string, patch: TemplatePatch) => Promise<TemplateWriteResult>;
  remove: (documentId: string) => Promise<{ ok: true } | TemplateWriteFailure>;
  /** "Applied just now" — the counter moves at once here, the server is told in the background. */
  use: (documentId: string) => void;
};

type State = { key: string; templates: CampaignTemplate[] | null; loading: boolean; error: string | null; me: string; owner: boolean };

const FOCUS_MIN_MS = 15_000;
const errText = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Read a JSON answer; a non-JSON body (a proxy 502 page) reads as a failure with the status. */
async function readJson<T>(res: Response): Promise<T & { ok?: boolean; error?: string; message?: string }> {
  const d = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string; message?: string }) | null;
  return d ?? ({ ok: false, error: `http_${res.status}` } as T & { ok: false; error: string });
}

export function useTemplates(partner: string, enabled = true): TemplatesApi {
  const key = enabled ? partner : "off";
  const [state, setState] = useState<State>({ key, templates: null, loading: enabled, error: null, me: "", owner: false });
  const reqId = useRef(0);
  const lastLoad = useRef(0);

  const load = useCallback(() => {
    if (!enabled) return;
    const id = ++reqId.current;
    lastLoad.current = Date.now();
    fetch(`/api/templates?partner=${encodeURIComponent(partner)}`, { cache: "no-store" })
      .then((r) => readJson<{ templates?: CampaignTemplate[]; me?: string; owner?: boolean }>(r))
      .then((d) => {
        if (id !== reqId.current) return;
        if (d.ok && Array.isArray(d.templates)) {
          setState({ key, templates: d.templates, loading: false, error: null, me: String(d.me ?? ""), owner: Boolean(d.owner) });
        } else {
          setState((s) => ({ key, templates: s.key === key ? s.templates : null, loading: false, error: d.error || "templates_failed", me: s.key === key ? s.me : "", owner: s.key === key ? s.owner : false }));
        }
      })
      .catch((e) => {
        if (id !== reqId.current) return;
        setState((s) => ({ key, templates: s.key === key ? s.templates : null, loading: false, error: `templates_failed — ${errText(e)}`, me: s.key === key ? s.me : "", owner: s.key === key ? s.owner : false }));
      });
  }, [enabled, partner, key]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const onFocus = () => {
      if (Date.now() - lastLoad.current >= FOCUS_MIN_MS) load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  const matched = state.key === key;
  const templates = matched ? state.templates : null;
  const loading = enabled && (!matched || state.loading);
  const error = matched ? state.error : null;
  const me = matched ? state.me : "";
  const owner = matched ? state.owner : false;

  const refresh = useCallback(() => {
    setState((s) => ({ ...s, key, loading: true, error: null }));
    load();
  }, [key, load]);

  /** Put a stored row into the list (replacing its older self), newest-updated first. */
  const take = useCallback(
    (t: CampaignTemplate) =>
      setState((s) => {
        if (s.key !== key) return s;
        const rest = (s.templates ?? []).filter((x) => x.documentId !== t.documentId);
        return { ...s, templates: [t, ...rest] };
      }),
    [key],
  );

  const create = useCallback<TemplatesApi["create"]>(
    async (input) => {
      try {
        const r = await fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, partner }),
        });
        const d = await readJson<{ template?: CampaignTemplate; existing?: CampaignTemplate | null; max?: number }>(r);
        if (r.ok && d.ok && d.template) {
          take(d.template);
          return { ok: true, template: d.template };
        }
        return { ok: false, error: d.error || `http_${r.status}`, message: d.message, existing: d.existing ?? null, max: d.max };
      } catch (e) {
        return { ok: false, error: "network", message: errText(e) };
      }
    },
    [partner, take],
  );

  const update = useCallback<TemplatesApi["update"]>(
    async (documentId, patch) => {
      try {
        const r = await fetch(`/api/templates/${encodeURIComponent(documentId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const d = await readJson<{ template?: CampaignTemplate }>(r);
        if (r.ok && d.ok && d.template) {
          take(d.template);
          return { ok: true, template: d.template };
        }
        if (r.status === 404) setState((s) => (s.key === key ? { ...s, templates: (s.templates ?? []).filter((x) => x.documentId !== documentId) } : s));
        return { ok: false, error: d.error || `http_${r.status}`, message: d.message };
      } catch (e) {
        return { ok: false, error: "network", message: errText(e) };
      }
    },
    [key, take],
  );

  const remove = useCallback<TemplatesApi["remove"]>(
    async (documentId) => {
      try {
        const r = await fetch(`/api/templates/${encodeURIComponent(documentId)}`, { method: "DELETE" });
        const d = await readJson<Record<string, never>>(r);
        if ((r.ok && d.ok) || r.status === 404) {
          setState((s) => (s.key === key ? { ...s, templates: (s.templates ?? []).filter((x) => x.documentId !== documentId) } : s));
          return { ok: true };
        }
        return { ok: false, error: d.error || `http_${r.status}`, message: d.message };
      } catch (e) {
        return { ok: false, error: "network", message: errText(e) };
      }
    },
    [key],
  );

  const use = useCallback<TemplatesApi["use"]>(
    (documentId) => {
      const now = new Date().toISOString();
      setState((s) =>
        s.key === key && s.templates
          ? { ...s, templates: s.templates.map((t) => (t.documentId === documentId ? { ...t, uses: t.uses + 1, lastUsedAt: now } : t)) }
          : s,
      );
      fetch(`/api/templates/${encodeURIComponent(documentId)}/use`, { method: "POST", keepalive: true }).catch(() => {
        /* best-effort — the counter is a courtesy */
      });
    },
    [key],
  );

  return useMemo(
    () => ({ templates, loading, error, me, owner, refresh, create, update, remove, use }),
    [templates, loading, error, me, owner, refresh, create, update, remove, use],
  );
}
