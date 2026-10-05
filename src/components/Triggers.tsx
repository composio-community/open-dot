"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, RefreshCw } from "lucide-react";
import * as actions from "@/app/actions";
import { useStore } from "@/lib/store";
import { openAfter } from "@/lib/popup";
import { Empty, RemoveButton } from "./SettingsKit";
import type { Dot, TriggerApp, TriggerField, TriggerType } from "@/lib/types";

const logo = (slug: string) => `https://logos.composio.dev/api/${slug}`;
const when = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** Settings: the Composio API key that turns triggers on. */
export function TriggersKey() {
  const source = useStore((s) => s.computer.triggersKey);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (value: string) =>
    start(async () => {
      const err = await actions.setComposioKey(value);
      setError(err);
      if (!err) { setKey(""); setEditing(false); }
    });

  return (
    <div className="surface p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[14px]">
            Composio API key <span className="text-foreground/40">· optional</span>
          </div>
          <div className="text-body-sm text-foreground/55">
            {source === "env"
              ? "Connected from COMPOSIO_API_KEY. Add triggers from a dot's Setup page."
              : source
                ? "Connected. Add triggers from a dot's Setup page."
                : "Create a project at platform.composio.dev, copy its API key and paste it here."}
          </div>
        </div>
        {source === "settings" && !editing && (
          <>
            <button className="btn-quiet h-8 px-3 text-[13px]" disabled={pending} onClick={() => save("")}>
              Remove
            </button>
            <button className="btn-secondary h-8 px-3 text-[13px]" onClick={() => setEditing(true)}>
              Change
            </button>
          </>
        )}
      </div>
      {(editing || !source) && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(key);
          }}
        >
          <input className="field font-mono text-[13px]" type="password" placeholder="ak_..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          <button className="btn-primary shrink-0" disabled={pending || !key.trim()}>
            {pending ? "Checking…" : "Save"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}

/** Setup page: this dot's triggers, and a form to add one. */
export function DotTriggers({ dot }: { dot: Dot }) {
  const hasKey = useStore((s) => s.computer.triggersKey !== null);
  const all = useStore((s) => s.triggers);
  const triggers = useMemo(() => all.filter((t) => t.dotId === dot.id), [all, dot.id]);
  const [adding, setAdding] = useState(false);
  const [apps, setApps] = useState<TriggerApp[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const loadApps = () =>
    start(async () => {
      const r = await actions.listTriggerApps();
      setAppsError(r.error ?? null);
      if (r.apps) setApps(r.apps);
    });

  if (!hasKey)
    return (
      <Empty>
        Triggers are off. Add a Composio API key in{" "}
        <a href="/settings#triggers" className="underline underline-offset-2 hover:text-foreground">
          Settings
        </a>{" "}
        to turn them on.
      </Empty>
    );

  return (
    <div className="space-y-3">
      {triggers.length > 0 ? (
        <div className="surface divide-y divide-black/[0.06]">
          {triggers.map((t) => (
            <div key={t.id} className="flex items-start gap-3 py-3 pr-2 pl-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo(t.toolkit)} alt="" className={`mt-0.5 size-5 shrink-0 rounded-xs object-contain ${t.enabled ? "" : "opacity-40 grayscale"}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px]">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-body-sm text-foreground/55">{t.instruction}</div>
                <div className={`mt-1 font-mono text-[10px] tracking-wider uppercase ${t.lastError ? "text-destructive" : "text-foreground/40"}`}>
                  {t.lastError ?? (t.enabled ? (t.lastFiredAt ? `Last fired ${when(t.lastFiredAt)}` : "Waiting for the first event") : "Paused")}
                </div>
              </div>
              <button className="btn-quiet" disabled={pending} onClick={() => start(async () => setError(await actions.toggleTrigger(t.id, !t.enabled)))}>
                {t.enabled ? "Pause" : "Resume"}
              </button>
              <RemoveButton label="Delete trigger" onClick={() => start(() => actions.deleteTrigger(t.id))} />
            </div>
          ))}
        </div>
      ) : (
        !adding && <Empty>No triggers yet. A trigger wakes {dot.name} when something happens, like a new email from your bank or a Slack mention.</Empty>
      )}
      {error && <p className="text-caption text-destructive">{error}</p>}
      {adding ? (
        <AddTrigger dot={dot} apps={apps} appsError={appsError} loadingApps={pending} reloadApps={loadApps} onDone={() => setAdding(false)} />
      ) : (
        <button
          className="btn-secondary"
          onClick={() => {
            setAdding(true);
            loadApps();
          }}
        >
          <Plus className="size-3.5" strokeWidth={2} /> Add trigger
        </button>
      )}
    </div>
  );
}

type Values = Record<string, string | boolean>;

function initialValues(type: TriggerType): Values {
  const v: Values = {};
  for (const f of type.fields) {
    if (f.type === "boolean") v[f.name] = f.default === true;
    else if (f.default !== undefined && f.default !== null) v[f.name] = Array.isArray(f.default) ? f.default.join(", ") : String(f.default);
    else v[f.name] = "";
  }
  return v;
}

/** Form values → the trigger's config, typed the way its schema asks. Returns an error for a missing field. */
function toConfig(fields: TriggerField[], values: Values): { config: Record<string, unknown>; error?: string } {
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (f.type === "boolean") {
      config[f.name] = raw === true;
      continue;
    }
    const text = String(raw ?? "").trim();
    if (!text) {
      if (f.required) return { config, error: `Fill in ${f.title}.` };
      continue;
    }
    if (f.type === "integer" || f.type === "number") {
      const n = Number(text);
      if (Number.isNaN(n)) return { config, error: `${f.title} needs a number.` };
      config[f.name] = f.type === "integer" ? Math.round(n) : n;
    } else if (f.type.startsWith("array:")) {
      const items = text.split(",").map((s) => s.trim()).filter(Boolean);
      config[f.name] = f.type === "array:string" ? items : items.map(Number);
    } else config[f.name] = text;
  }
  return { config };
}

function AddTrigger({ dot, apps, appsError, loadingApps, reloadApps, onDone }: { dot: Dot; apps: TriggerApp[] | null; appsError: string | null; loadingApps: boolean; reloadApps: () => void; onDone: () => void }) {
  const [app, setApp] = useState<TriggerApp | null>(null);
  const [types, setTypes] = useState<TriggerType[] | null>(null);
  const [type, setType] = useState<TriggerType | null>(null);
  const [values, setValues] = useState<Values>({});
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pickApp = (a: TriggerApp) => {
    setApp(a);
    setType(null);
    setTypes(null);
    start(async () => {
      const r = await actions.listTriggerTypes(a.slug);
      setError(r.error ?? null);
      setTypes(r.types ?? []);
    });
  };
  const pickType = (t: TriggerType) => {
    setType(t);
    setValues(initialValues(t));
  };
  const connect = (slug: string) => {
    setBusy(slug);
    start(() => openAfter(() => actions.connectTriggerApp(slug), setError).finally(() => setBusy(null)));
  };
  const create = () => {
    if (!app || !type) return;
    const { config, error: bad } = toConfig(type.fields, values);
    if (bad) return setError(bad);
    start(async () => {
      const err = await actions.addTrigger(dot.id, app.slug, type.slug, config, instruction);
      setError(err);
      if (!err) onDone();
    });
  };

  return (
    <div className="surface space-y-4 p-4">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="eyebrow">1 · App</span>
          <button className="btn-quiet" disabled={loadingApps} onClick={reloadApps} title="Refresh after connecting an app">
            <RefreshCw className={`size-3.5 ${loadingApps ? "animate-spin" : ""}`} strokeWidth={1.75} />
          </button>
        </div>
        {apps === null ? (
          <p className={`text-body-sm ${appsError ? "text-destructive" : "text-foreground/45"}`}>{appsError ?? "Loading apps…"}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {apps.map((a) => (
              <button
                key={a.slug}
                type="button"
                disabled={pending}
                onClick={() => (a.connected ? pickApp(a) : connect(a.slug))}
                className={`flex h-9 items-center gap-2 rounded-md border pr-3 pl-2 text-[13px] transition-colors ${app?.slug === a.slug ? "border-foreground bg-foreground text-card" : "border-black/10 bg-card hover:border-black/25"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo(a.slug)} alt="" className="size-4 object-contain" />
                {busy === a.slug ? "Opening…" : a.name}
                {!a.connected && <span className="text-[11px] text-foreground/40">Connect</span>}
              </button>
            ))}
          </div>
        )}
        {apps?.some((a) => !a.connected) && <p className="mt-2 text-caption text-foreground/45">Apps for triggers are connected in your Composio project, separate from your dots&apos; apps. Connect one, then refresh.</p>}
      </div>

      {app && (
        <div>
          <span className="eyebrow mb-2 block">2 · When</span>
          {types === null ? (
            <p className="text-body-sm text-foreground/45">Loading events…</p>
          ) : types.length === 0 ? (
            <p className="text-body-sm text-foreground/45">{app.name} has no trigger events.</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {types.map((t) => (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => pickType(t)}
                  className={`rounded-md border px-3 py-2 text-left transition-colors ${type?.slug === t.slug ? "border-foreground bg-black/[0.03]" : "border-black/10 hover:border-black/25"}`}
                >
                  <span className="block text-[13px]">{t.name}</span>
                  <span className="line-clamp-2 block text-caption text-foreground/50">{t.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {type && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          {type.fields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {type.fields.map((f) => (
                <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues({ ...values, [f.name]: v })} />
              ))}
            </div>
          )}
          <label className="block">
            <span className="eyebrow mb-1.5 block">3 · Then {dot.name} should</span>
            <textarea
              className="field h-auto min-h-20 resize-y py-2 leading-normal"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. If it's a bill, add it to my budget sheet and tell me the amount and due date."
            />
          </label>
          <div className="flex items-center gap-2">
            <span className="text-caption text-foreground/45">{type.fields.some((f) => f.name === "interval") ? "Can take up to the interval (in minutes) to fire." : "Runs as events come in."}</span>
            <button type="button" className="btn-quiet ml-auto" onClick={onDone}>
              Cancel
            </button>
            <button className="btn-primary h-8 px-3 text-[13px]" disabled={pending || !instruction.trim()}>
              {pending ? "Adding…" : "Add trigger"}
            </button>
          </div>
        </form>
      )}
      {!type && (
        <div className="flex justify-end">
          <button type="button" className="btn-quiet" onClick={onDone}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className="text-caption text-destructive">{error}</p>}
    </div>
  );
}

function Field({ field, value, onChange }: { field: TriggerField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const label = (
    <span className="eyebrow mb-1.5 block">
      {field.title}
      {!field.required && <span className="normal-case tracking-normal text-foreground/35"> · optional</span>}
    </span>
  );
  if (field.type === "boolean")
    return (
      <label className="flex items-center gap-2 text-[13px]" title={field.description}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {field.title}
      </label>
    );
  return (
    <label className="block" title={field.description}>
      {label}
      {field.enum ? (
        <select className="field" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {!field.required && <option value="">Any</option>}
          {field.enum.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field"
          inputMode={field.type === "integer" || field.type === "number" ? "numeric" : undefined}
          placeholder={field.type.startsWith("array:") ? "Comma-separated" : field.description.slice(0, 60)}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
