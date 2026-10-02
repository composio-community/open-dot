"use client";

import { Children, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Bell, KeyRound, Lock, LogOut, Plus, RefreshCw } from "lucide-react";
import { connectApp, deletePassword, refreshApps, refreshModels, savePassword, setCloudKey, setDefaultModel, setOpenAIKey, setOpenCodeProduct, setOpenRouterKey, signInComposio, signOutComposio } from "@/app/actions";
import { useStore } from "@/lib/store";
import { openAfter } from "@/lib/popup";
import { Empty, PageHeader, RemoveButton, RuleEditor, Section } from "./SettingsKit";
import ModelPicker from "./ModelPicker";
import { TriggersKey } from "./Triggers";

const noop = () => () => {};
const notificationPermission = () => ("Notification" in window ? Notification.permission : "unsupported");

export default function SettingsView() {
  const passwords = useStore((s) => s.passwords);
  const permission = useSyncExternalStore(noop, notificationPermission, () => "default");
  const [, force] = useState(0);
  const [form, setForm] = useState({ site: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="rails mx-auto min-h-full max-w-[1080px] px-4 sm:px-8 pb-16">
        <PageHeader eyebrow="Settings" title="Settings" description="Passwords, rules that apply to every dot, notifications, and the engine behind them." />

        <Section
          eyebrow="Passwords"
          title="Saved logins"
          description="Your dots can securely use these to log into websites in their browser. Encrypted with a key in your macOS Keychain, typed directly into the page, and never shown to the model."
        >
          <div className="space-y-3">
            {passwords.length > 0 ? (
              <div className="surface divide-y divide-black/[0.06]">
                {passwords.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 py-2 pr-2 pl-4">
                    <KeyRound className="size-3.5 text-foreground/40" strokeWidth={1.75} />
                    <span className="w-40 truncate text-[14px]">{p.site}</span>
                    <span className="min-w-0 flex-1 truncate text-body-sm text-foreground/55">{p.username}</span>
                    <span className="font-mono text-[12px] tracking-widest text-foreground/35">••••••••</span>
                    <RemoveButton label="Delete password" onClick={() => start(() => deletePassword(p.id))} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No saved logins yet.</Empty>
            )}
            <form
              className="surface space-y-3 p-4"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                start(async () => {
                  const err = await savePassword(form.site, form.username, form.password);
                  setError(err);
                  if (!err) setForm({ site: "", username: "", password: "" });
                });
              }}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <input className="field" placeholder="Site, e.g. github.com" value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} />
                <input className="field" placeholder="Username or email" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                <input className="field" type="password" placeholder="Password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 text-caption text-foreground/45">
                  <Lock className="size-3" strokeWidth={2} /> AES-256-GCM, key in Keychain
                </span>
                {error && <span className="text-caption text-destructive">{error}</span>}
                <button className="btn-primary ml-auto h-8 px-3 text-[13px]" disabled={pending}>
                  Save login
                </button>
              </div>
            </form>
          </div>
        </Section>

        <Section eyebrow="Approvals" title="Rules for all dots" description="These apply to every dot, on top of each dot's own rules.">
          <RuleEditor dotId={null} name="a dot" />
        </Section>

        <Section
          id="apps"
          eyebrow="Apps"
          title="Your apps, via Composio"
          description="Sign in with your Composio account to give your dots Gmail, Calendar, Slack, Notion, GitHub, and 500+ more apps. Dots read on their own and ask before sending, posting, or changing anything."
        >
          <AppsList />
        </Section>

        <Section
          id="triggers"
          eyebrow="Triggers"
          title="Wake dots from your apps"
          description="Let a dot act when something happens, like a new email or a GitHub issue. Triggers run through a Composio developer project, so they need its API key. Then add them from a dot's Setup page."
        >
          <TriggersKey />
        </Section>

        <Section eyebrow="Notifications" title="Desktop notifications" description={'Get notified when a dot finishes something or needs you, like "Your research is ready".'}>
          <div className="surface flex items-center gap-3 p-4">
            <Bell className="size-4 text-foreground/50" strokeWidth={1.5} />
            <span className="flex-1 text-body-sm">
              {permission === "granted"
                ? "Notifications are on."
                : permission === "denied"
                  ? "Notifications are blocked in your browser settings for this site."
                  : permission === "unsupported"
                    ? "This browser doesn't support notifications."
                    : "Notifications are off."}
            </span>
            {permission === "default" && (
              <button className="btn-primary h-8 px-3 text-[13px]" onClick={() => Notification.requestPermission().then(() => force((n) => n + 1))}>
                Turn on
              </button>
            )}
            {permission === "granted" && <span className="rounded-xs bg-success/12 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-success uppercase">On</span>}
          </div>
        </Section>

        <EngineSettings />
      </div>
    </div>
  );
}

function AppsList() {
  const apps = useStore((s) => s.apps);
  const signedIn = useStore((s) => s.computer.composio);
  const signInError = useSearchParams().get("composio_error");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const connected = apps.filter((a) => a.connected);
  const suggested = apps.filter((a) => !a.connected);

  if (!signedIn) {
    return (
      <div className="surface overflow-hidden">
        <div className="flex items-center gap-4 p-5">
          <div className="flex -space-x-2">
            {["gmail", "googlecalendar", "slack", "notion", "github"].map((slug) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={slug} src={`https://logos.composio.dev/api/${slug}`} alt="" className="size-8 rounded-full border-2 border-card bg-card object-contain p-1 shadow-sm" />
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium">Composio For You</div>
            <div className="text-body-sm text-foreground/55">One sign-in connects your dots to the apps you already use. No API keys.</div>
          </div>
          <button
            className="btn-primary shrink-0"
            disabled={pending}
            onClick={() => start(() => openAfter(signInComposio, setError))}
          >
            Sign in with Composio
          </button>
        </div>
        {(error || signInError) && <div className="border-t border-black/[0.06] px-5 py-2.5 text-caption text-destructive">{error ?? signInError}</div>}
      </div>
    );
  }

  const connect = (slug: string) => {
    setBusy(slug);
    start(() => openAfter(() => connectApp(slug), setError).finally(() => setBusy(null)));
  };

  return (
    <div className="space-y-3">
      <div className="surface flex items-center gap-3 px-4 py-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="https://logos.composio.dev/api/composio" alt="" className="size-6 rounded-xs object-contain" />
        <div className="flex-1">
          <div className="text-[14px]">Composio For You</div>
          <div className="text-caption text-foreground/50">Signed in · {connected.length} app{connected.length === 1 ? "" : "s"} connected</div>
        </div>
        <span className="rounded-xs bg-success/12 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-success uppercase">Connected</span>
        <button className="btn-quiet" disabled={pending} onClick={() => start(() => refreshApps())} title="Refresh">
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </button>
        <button className="btn-quiet" disabled={pending} onClick={() => start(() => signOutComposio())}>
          <LogOut className="size-3.5" strokeWidth={1.75} /> Sign out
        </button>
      </div>

      {connected.length > 0 && (
        <div className="surface grid gap-px overflow-hidden bg-black/[0.06] sm:grid-cols-2">
          {connected.map((a) => (
            <div key={a.slug} className="flex items-center gap-3 bg-card px-4 py-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.logo} alt="" className="size-5 rounded-xs object-contain" />
              <span className="flex-1 truncate text-[14px]">{a.name}</span>
              <span className="size-1.5 rounded-full bg-success" title="Connected" />
            </div>
          ))}
        </div>
      )}

      {suggested.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Connect more</span>
            <a href="/apps" className="btn-quiet">Browse all apps →</a>
          </div>
          <div className="flex flex-wrap gap-2">
            {suggested.map((a) => (
              <button
                key={a.slug}
                className="flex h-9 items-center gap-2 rounded-md border border-black/10 bg-card pr-3 pl-2 text-[13px] transition-colors hover:border-black/25"
                disabled={pending}
                onClick={() => connect(a.slug)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.logo} alt="" className="size-4 object-contain" />
                {busy === a.slug ? "Opening…" : a.name}
                <Plus className="size-3 text-foreground/40" strokeWidth={2} />
              </button>
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-caption text-destructive">{error}</p>}
    </div>
  );
}

function EngineSettings() {
  const computer = useStore((s) => s.computer);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const computerLabel = computer.docker ? `Docker · ${computer.image}` : "Local sandbox folders";
  return (
    <Section eyebrow="Engine" title="Models & computers" description="Choose where dots think and run. Connected providers stay compact until you need to manage them.">
      <div className="surface overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Default model</div>
            <div className="text-[12px] text-foreground/50">Used by dots that don&apos;t choose their own model.</div>
          </div>
          <ModelPicker allowDefault={false} value={computer.model || null} onChange={(m) => start(() => setDefaultModel(m))} compact />
        </div>
        <OpenCodeKey />
        <ApiKey />
        <OpenModelsKey />
        <CloudKey />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-caption text-foreground/45">
        <span>{computer.models.length ? `${computer.models.length} models` : "Loading models…"}</span><span>·</span>
        <span>{computer.computerTool === "off" ? "Page tools" : "OpenAI computer tool"}</span><span>·</span><span>{computerLabel}</span>
        <button className="btn-quiet ml-auto h-7 px-2.5 text-[12px]" disabled={pending} onClick={() => start(async () => setError(await refreshModels()))}>
          <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} strokeWidth={1.75} /> Refresh models
        </button>
      </div>
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </Section>
  );
}

function EngineRow({ id, title, detail, connected, action, children }: { id?: string; title: string; detail: ReactNode; connected: boolean; action?: ReactNode; children?: ReactNode }) {
  const hasDetails = Children.toArray(children).length > 0;
  return (
    <div id={id} className="border-t border-black/[0.06] scroll-mt-6">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className={`size-1.5 shrink-0 rounded-full ${connected ? "bg-success" : "bg-foreground/15"}`} />
        <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{title}</div><div className="truncate text-[12px] leading-5 text-foreground/50">{detail}</div></div>
        {action}
      </div>
      {hasDetails && <div className="border-t border-black/[0.05] bg-black/[0.015] px-4 py-3">{children}</div>}
    </div>
  );
}

function OpenCodeKey() {
  const computer = useStore((s) => s.computer);
  const [editing, setEditing] = useState(false);
  const goCount = computer.models.filter((m) => m.startsWith("opencode-go:")).length;
  const zenCount = computer.models.filter((m) => m.startsWith("opencode-zen:")).length;
  const connected = (computer.openCode.go.enabled && computer.openCode.go.source !== null) || (computer.openCode.zen.enabled && computer.openCode.zen.source !== null);
  const enabled = [computer.openCode.go.enabled && computer.openCode.go.source ? `Go${goCount ? ` · ${goCount}` : ""}` : null, computer.openCode.zen.enabled && computer.openCode.zen.source ? `Zen${zenCount ? ` · ${zenCount}` : ""}` : null].filter(Boolean).join(" + ");
  return (
    <EngineRow id="opencode-key" title="OpenCode" connected={connected} detail={connected ? enabled : "Go subscription or Zen pay-as-you-go"} action={<button className="btn-secondary h-7 px-2.5 text-[12px]" onClick={() => setEditing((v) => !v)}>{editing ? "Done" : connected ? "Manage" : "Add"}</button>}>
      {editing && <div className="space-y-2"><OpenCodeProductRow product="go" title="Go" subtitle="Subscription · coding models" status={computer.openCode.go} modelCount={goCount} /><OpenCodeProductRow product="zen" title="Zen" subtitle="Pay as you go · curated models" status={computer.openCode.zen} modelCount={zenCount} /><p className="text-caption text-foreground/45">Responses + Chat Completions models are shown. Messages/Gemini protocol models stay hidden for now.</p></div>}
    </EngineRow>
  );
}

function OpenCodeProductRow({ product, title, subtitle, status, modelCount }: { product: "go" | "zen"; title: string; subtitle: string; status: { source: "settings" | "cli" | "env" | null; enabled: boolean }; modelCount: number }) {
  const [key, setKey] = useState(""); const [editingKey, setEditingKey] = useState(false); const [error, setError] = useState<string | null>(null); const [pending, start] = useTransition();
  const sourceLabel = status.source === "cli" ? "OpenCode CLI" : status.source === "env" ? "Environment" : status.source === "settings" ? "Encrypted local key" : "No key";
  const save = (enabled: boolean, removeKey = false) => start(async () => { const err = await setOpenCodeProduct(product, key, enabled, removeKey); setError(err); if (!err) { setKey(""); setEditingKey(false); } });
  return <div className="rounded-md border border-black/[0.07] bg-card px-3 py-2.5">
    <div className="flex items-center gap-3"><span className={`size-1.5 shrink-0 rounded-full ${status.enabled && status.source ? "bg-success" : "bg-foreground/15"}`} /><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-[13px] font-medium">{title}</span><span className="text-[11px] text-foreground/40">{subtitle}</span></div><div className="text-[11px] text-foreground/45">{sourceLabel}{status.enabled && modelCount ? ` · ${modelCount} models` : ""}</div></div>{status.source && <button className="btn-quiet h-7 px-2 text-[12px]" disabled={pending} onClick={() => save(!status.enabled)}>{status.enabled ? "Disable" : "Enable"}</button>}<button className="btn-secondary h-7 px-2 text-[12px]" onClick={() => setEditingKey((v) => !v)}>{editingKey ? "Cancel" : status.source === "settings" ? "Change key" : status.source ? "Override key" : "Add key"}</button></div>
    {(editingKey || !status.source) && <div className="mt-2 flex gap-2"><input className="field font-mono text-[12px]" type="password" placeholder={`${title} API key`} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />{status.source === "settings" && <button className="btn-quiet shrink-0" disabled={pending} onClick={() => save(false, true)}>Remove</button>}<button className="btn-primary shrink-0" disabled={pending || !key.trim()} onClick={() => save(true)}>{pending ? "Saving…" : "Save & enable"}</button></div>}
    {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
  </div>;
}

function ApiKey() {
  const computer = useStore((s) => s.computer); const [editing, setEditing] = useState(false); const [key, setKey] = useState(""); const [error, setError] = useState<string | null>(null); const [pending, start] = useTransition();
  const save = () => start(async () => { const err = await setOpenAIKey(key); setError(err); if (!err) { setKey(""); setEditing(false); } });
  return <EngineRow id="api-key" title="OpenAI API" connected={computer.hasKey} detail={computer.keySource === "env" ? "OPENAI_API_KEY" : computer.hasKey ? "Connected · encrypted locally" : "Optional · OpenAI models, voice and native computer use"} action={computer.keySource !== "env" ? <button className="btn-secondary h-7 px-2.5 text-[12px]" onClick={() => setEditing((v) => !v)}>{editing ? "Done" : computer.hasKey ? "Manage" : "Add"}</button> : null}>
    {editing && computer.keySource !== "env" && <div className="flex gap-2"><input className="field font-mono text-[13px]" type="password" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /><button className="btn-primary shrink-0" disabled={pending || !key.trim()} onClick={save}>{pending ? "Checking…" : "Save"}</button></div>}{error && <p className="mt-2 text-caption text-destructive">{error}</p>}
  </EngineRow>;
}

function OpenModelsKey() {
  const computer = useStore((s) => s.computer); const count = computer.models.filter((m) => m.startsWith("openrouter:")).length; const [editing, setEditing] = useState(false); const [key, setKey] = useState(""); const [error, setError] = useState<string | null>(null); const [pending, start] = useTransition(); const connected = computer.openRouter !== null;
  const save = (value: string) => start(async () => { const err = await setOpenRouterKey(value); setError(err); if (!err) { setKey(""); setEditing(false); } });
  return <EngineRow id="open-models" title="OpenRouter" connected={connected} detail={computer.openRouter === "env" ? `OPENROUTER_API_KEY${count ? ` · ${count} models` : ""}` : connected ? `Connected${count ? ` · ${count} models` : ""}` : "Optional · broad open-model catalog"} action={computer.openRouter !== "env" ? <button className="btn-secondary h-7 px-2.5 text-[12px]" onClick={() => setEditing((v) => !v)}>{editing ? "Done" : connected ? "Manage" : "Add"}</button> : null}>
    {editing && computer.openRouter !== "env" && <div className="flex gap-2"><input className="field font-mono text-[13px]" type="password" placeholder="sk-or-..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />{computer.openRouter === "settings" && <button className="btn-quiet shrink-0" disabled={pending} onClick={() => save("")}>Remove</button>}<button className="btn-primary shrink-0" disabled={pending || !key.trim()} onClick={() => save(key)}>{pending ? "Checking…" : "Save"}</button></div>}{error && <p className="mt-2 text-caption text-destructive">{error}</p>}
  </EngineRow>;
}

function CloudKey() {
  const computer = useStore((s) => s.computer); const [editing, setEditing] = useState(false); const [key, setKey] = useState(""); const [error, setError] = useState<string | null>(null); const [pending, start] = useTransition(); const connected = computer.cloudKey !== null;
  const save = (value: string) => start(async () => { const err = await setCloudKey(value); setError(err); if (!err) { setKey(""); setEditing(false); } });
  return <EngineRow id="cloud-key" title="Cloud computers" connected={connected} detail={computer.cloudKey === "env" ? "E2B_API_KEY" : connected ? "Connected · keeps dots running while this Mac sleeps" : "Optional · E2B background computers"} action={computer.cloudKey !== "env" ? <button className="btn-secondary h-7 px-2.5 text-[12px]" onClick={() => setEditing((v) => !v)}>{editing ? "Done" : connected ? "Manage" : "Add"}</button> : null}>
    {editing && computer.cloudKey !== "env" && <div className="flex gap-2"><input className="field font-mono text-[13px]" type="password" placeholder="e2b_..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />{computer.cloudKey === "settings" && <button className="btn-quiet shrink-0" disabled={pending} onClick={() => save("")}>Remove</button>}<button className="btn-primary shrink-0" disabled={pending || !key.trim()} onClick={() => save(key)}>{pending ? "Checking…" : "Save"}</button></div>}{error && <p className="mt-2 text-caption text-destructive">{error}</p>}
  </EngineRow>;
}
