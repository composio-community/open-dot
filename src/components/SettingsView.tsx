"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Bell, KeyRound, Lock, LogOut, Plus, RefreshCw } from "lucide-react";
import { connectApp, deletePassword, refreshApps, savePassword, setCloudKey, setDefaultModel, setOpenAIKey, setRouterKey, signInComposio, signOutComposio } from "@/app/actions";
import { ROUTER_PROVIDERS, routerProvider, type RouterId } from "@/lib/model-providers";
import { useStore } from "@/lib/store";
import { openAfter } from "@/lib/popup";
import { Empty, PageHeader, RemoveButton, RuleEditor, Section } from "./SettingsKit";
import ModelPicker from "./ModelPicker";
import { TriggersKey } from "./Triggers";

const noop = () => () => {};
const notificationPermission = () => ("Notification" in window ? Notification.permission : "unsupported");

export default function SettingsView() {
  const passwords = useStore((s) => s.passwords);
  const computer = useStore((s) => s.computer);
  const keyProtection = computer.platform === "win32" ? "Windows DPAPI" : computer.platform === "darwin" ? "your macOS Keychain" : "a local key file";
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
          description={`Encrypted with a key protected by ${keyProtection}. Autofill asks for approval and checks the exact HTTPS site saved here. Passwords stay out of model tool arguments and results; the website receives them when filled.`}
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
                  <Lock className="size-3" strokeWidth={2} /> AES-256-GCM, key protected by {keyProtection}
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

        <Section eyebrow="Engine" title="Models & computers" description="Connect OpenAI or a model router. Each service needs its own key; choose the service that issued yours.">
          <ApiKey />
          <OpenModelsKey />
          <CloudKey />
          <div className="surface mb-3 flex items-center gap-3 p-4">
            <div className="flex-1">
              <div className="text-[14px]">Default model</div>
              <div className="text-body-sm text-foreground/55">Used by every dot that doesn&apos;t pick its own (pick per dot from its header).</div>
            </div>
            <ModelPicker allowDefault={false} value={computer.model || null} onChange={(m) => start(() => setDefaultModel(m))} />
          </div>
          <dl className="surface divide-y divide-black/[0.06]">
            {[
              ["Models on your key", computer.models.length ? `${computer.models.length} available` : "Loading…", true],
              ["Computer use", computer.computerTool === "off" ? "Off (page tools only)" : "OpenAI computer tool", true],
              ["Dot computers", computer.docker ? `Docker containers · ${computer.image}` : "Sandbox folders (start Docker for containers)", computer.docker],
            ].map(([k, v, ok]) => (
              <div key={String(k)} className="flex items-center gap-4 px-4 py-2.5">
                <dt className="eyebrow w-36 shrink-0">{k}</dt>
                <dd className={`flex-1 text-body-sm ${ok ? "" : "text-warning"}`}>{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
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

/** The OpenAI key: paste it here (stored encrypted), unless it comes from OPENAI_API_KEY. */
function ApiKey() {
  const computer = useStore((s) => s.computer);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const open = editing || !computer.hasKey;

  return (
    <div id="api-key" className="surface mb-3 p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[14px]">OpenAI API key</div>
          <div className={`text-body-sm ${computer.hasKey ? "text-foreground/55" : "text-warning"}`}>
            {computer.keySource === "env"
              ? "Connected from OPENAI_API_KEY."
              : computer.hasKey
                ? "Connected. Stored encrypted on this computer."
                : "For OpenAI models and voice, use a key from platform.openai.com. Router keys go under Model routers below."}
          </div>
        </div>
        {computer.hasKey && computer.keySource !== "env" && !editing && (
          <button className="btn-secondary h-8 px-3 text-[13px]" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
      </div>
      {open && computer.keySource !== "env" && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const err = await setOpenAIKey(key);
              setError(err);
              if (!err) { setKey(""); setEditing(false); }
            });
          }}
        >
          <input className="field font-mono text-[13px]" type="password" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          <button className="btn-primary shrink-0" disabled={pending || !key.trim()}>
            {pending ? "Checking…" : "Save"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}

/** Optional E2B computer; the agent and scheduler still require this PC to stay awake. */
function CloudKey() {
  const computer = useStore((s) => s.computer);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = computer.cloudKey !== null;
  const save = (value: string) =>
    start(async () => {
      const err = await setCloudKey(value);
      setError(err);
      if (!err) { setKey(""); setEditing(false); }
    });

  return (
    <div id="cloud-key" className="surface mb-3 scroll-mt-6 p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[14px]">
            Cloud computers <span className="text-foreground/40">· optional</span>
          </div>
          <div className="text-body-sm text-foreground/55">
            {computer.cloudKey === "env"
              ? "Connected from E2B_API_KEY."
              : saved
                ? "Connected. Each dot gets its own E2B cloud computer. Keep this app open and your PC awake for agents and routines to run."
                : "Paste an E2B API key (from e2b.dev) to give each dot a cloud computer. Agents and routines still need this app open and your PC awake."}
          </div>
        </div>
        {computer.cloudKey === "settings" && !editing && (
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
      {(editing || !saved) && computer.cloudKey !== "env" && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(key);
          }}
        >
          <input className="field font-mono text-[13px]" type="password" placeholder="e2b_..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          <button className="btn-primary shrink-0" disabled={pending || !key.trim()}>
            {pending ? "Checking…" : "Save"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}

/** Each router keeps a separate credential and model group. */
function OpenModelsKey() {
  const [id, setId] = useState<RouterId>("openrouter");
  const computer = useStore((s) => s.computer);
  const status = computer.routers?.find((r) => r.id === id);
  return (
    <div id="open-models" className="surface mb-3 scroll-mt-6 p-4">
      <div className="text-[14px]">Model routers <span className="text-foreground/40">· optional</span></div>
      <p className="text-body-sm text-foreground/55">Choose your key&apos;s provider. Keys are never tried against other services. Voice calls still need OpenAI.</p>
      <select aria-label="Router provider" className="field mt-3 text-[13px]" value={id} onChange={(e) => setId(e.target.value as RouterId)}>
        {ROUTER_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <RouterKey key={`${id}:${status?.source}:${status?.baseURL}`} id={id} />
    </div>
  );
}

function RouterKey({ id }: { id: RouterId }) {
  const provider = routerProvider(id)!;
  const computer = useStore((s) => s.computer);
  const status = computer.routers?.find((r) => r.id === id);
  const source = status?.source ?? (id === "openrouter" ? computer.openRouter : null);
  const count = computer.models.filter((m) => m.startsWith(`${id}:`)).length;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState(status?.baseURL ?? provider.baseURL);
  const [modelIds, setModelIds] = useState(status?.modelIds.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = source !== null;
  const save = (value: string) =>
    start(async () => {
      const err = await setRouterKey(id, value, baseURL, modelIds);
      setError(err);
      if (!err) { setKey(""); setEditing(false); }
    });
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-body-sm text-foreground/55">
          {source === "env" ? `Configured from ${provider.env}.` : saved ? `Saved encrypted · ${count} models loaded. Send a chat to check model access.` : `Paste the API key issued by ${provider.name}.`}
        </p>
        <a href={provider.docs} target="_blank" rel="noreferrer" className="text-caption underline">API docs</a>
        {source === "settings" && !editing && <>
          <button className="btn-quiet h-8 px-3 text-[13px]" disabled={pending} onClick={() => save("")}>Remove</button>
          <button className="btn-secondary h-8 px-3 text-[13px]" onClick={() => setEditing(true)}>Change</button>
        </>}
      </div>
      {(editing || !saved) && source !== "env" && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); save(key); }}>
          <label className="block text-caption">API base URL
            <input aria-label="Router API base URL" className="field mt-1 font-mono text-[13px]" type="url" required value={baseURL} onChange={(e) => setBaseURL(e.target.value)} disabled={pending} />
          </label>
          <label className="block text-caption">Model IDs · optional, comma separated
            <input aria-label="Router model IDs" className="field mt-1 font-mono text-[13px]" placeholder="Leave blank to load your available models" value={modelIds} onChange={(e) => setModelIds(e.target.value)} disabled={pending} />
          </label>
          <div className="flex gap-2">
            <input aria-label={`${provider.name} API key`} className="field font-mono text-[13px]" type="password" placeholder="Paste this provider's API key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" disabled={pending} />
            <button className="btn-primary shrink-0" disabled={pending || !key.trim()}>{pending ? "Checking…" : "Save"}</button>
          </div>
          <p className="text-caption text-foreground/50">The key goes only to the API URL shown above. Model and tool availability depend on your provider and plan.</p>
          {id === "commandcode" && <p className="text-caption text-foreground/50">Use your Command Code Studio API key and a plan with API access. Saving loads the public model catalog; send a chat to check your key, credits and model access.</p>}
        </form>
      )}
      {error && <p role="alert" className="mt-2 break-words text-caption text-destructive">{error}</p>}
    </div>
  );
}
