"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Bell, KeyRound, Lock, LogOut, Plus, RefreshCw } from "lucide-react";
import { connectApp, deletePassword, refreshApps, savePassword, setCloudKey, setDefaultModel, setOpenAIKey, setOpenRouterKey, setUserProfile, signInComposio, signOutComposio } from "@/app/actions";
import { useStore } from "@/lib/store";
import { openAfter } from "@/lib/popup";
import { Empty, PageHeader, RemoveButton, RuleEditor, Section } from "./SettingsKit";
import ModelPicker from "./ModelPicker";
import { TriggersKey } from "./Triggers";
import { USER_PROFILE_FILE, USER_PROFILE_MAX_CHARS, userProfileLength } from "@/lib/user-profile";

const noop = () => () => {};
const notificationPermission = () => ("Notification" in window ? Notification.permission : "unsupported");

export default function SettingsView() {
  const passwords = useStore((s) => s.passwords);
  const computer = useStore((s) => s.computer);
  const permission = useSyncExternalStore(noop, notificationPermission, () => "default");
  const [, force] = useState(0);
  const [form, setForm] = useState({ site: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="rails mx-auto min-h-full max-w-[1080px] px-4 sm:px-8 pb-16">
        <PageHeader eyebrow="Settings" title="Settings" description="Your universal profile, passwords, rules that apply to every dot, notifications, and the engine behind them." />

        <UserProfile />

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

        <Section eyebrow="Engine" title="Models & computers" description="Models come from what your OpenAI key can use, plus open models once you add an OpenRouter key.">
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

function UserProfile() {
  const saved = useStore((s) => s.userProfile);
  const version = useStore((s) => s.userProfileVersion);
  const warning = useStore((s) => s.userProfileWarning);
  const loaded = useStore((s) => s.loaded);
  return <UserProfileEditor key={loaded ? "loaded" : "loading"} saved={saved} version={version} warning={warning} />;
}

function UserProfileEditor({ saved, version, warning }: { saved: string; version: string | null; warning: string | null }) {
  const [draft, setDraft] = useState(saved);
  const [baseSaved, setBaseSaved] = useState(saved);
  const [baseVersion, setBaseVersion] = useState(version);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = draft.trim() !== baseSaved.trim();
  const count = userProfileLength(draft.trim());
  const tooLong = count > USER_PROFILE_MAX_CHARS;
  const changedElsewhere = version !== baseVersion;

  const reloadLatest = () => {
    setDraft(saved);
    setBaseSaved(saved);
    setBaseVersion(version);
    setError(null);
  };

  return (
    <Section
      id="user-profile"
      eyebrow="You"
      title="Universal profile"
      description="Stable things every dot should know about you. This is shared by existing and future dots; each dot's Personality & appearance remains separate."
    >
      <div className="surface space-y-3 p-4">
        <textarea
          className="field h-auto min-h-44 resize-y py-3 leading-normal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={"Examples:\n- Call me Sam.\n- I prefer concise, direct answers.\n- I work in product design and care about accessibility.\n- My current project is Acme."}
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-caption text-foreground/45">
            Saved locally as <code className="font-mono">{USER_PROFILE_FILE}</code>. Don&apos;t put passwords or secrets here.
          </span>
          <span className={`ml-auto font-mono text-[11px] ${tooLong ? "text-destructive" : "text-foreground/40"}`}>
            {count.toLocaleString()} / {USER_PROFILE_MAX_CHARS.toLocaleString()}
          </span>
          {changedElsewhere && (
            <button className="btn-secondary h-8 px-3 text-[13px]" disabled={pending} onClick={reloadLatest}>
              Reload latest
            </button>
          )}
          <button
            className="btn-primary h-8 px-3 text-[13px]"
            disabled={!dirty || tooLong || pending}
            onClick={() => start(async () => {
              const result = await setUserProfile(draft, baseVersion);
              setError(result.error);
              if (!result.error) {
                const clean = draft.trim();
                setBaseSaved(clean);
                setBaseVersion(result.version);
              }
            })}
          >
            {pending ? "Saving…" : dirty ? "Save profile" : "Saved"}
          </button>
        </div>
        {(warning || changedElsewhere) && <p className="text-caption text-warning">{warning ?? "USER.md changed elsewhere. Reload the latest version before saving over it."}</p>}
        {error && <p className="text-caption text-destructive">{error}</p>}
      </div>
    </Section>
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
                : "Your dots need one to think. Create one at platform.openai.com."}
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
              if (!err) (setKey(""), setEditing(false));
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

/** Optional E2B key: each dot gets a cloud computer that keeps working while this Mac sleeps. */
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
      if (!err) (setKey(""), setEditing(false));
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
                ? "Connected. Each dot gets its own E2B cloud computer that keeps working while your Mac sleeps."
                : "Paste an E2B API key (from e2b.dev) to give each dot a cloud computer that keeps working while your Mac sleeps."}
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

/** Optional OpenRouter key: adds open models (Qwen, DeepSeek, Kimi, GLM, Llama, gpt-oss…) to every model picker. */
function OpenModelsKey() {
  const computer = useStore((s) => s.computer);
  const openCount = computer.models.filter((m) => m.startsWith("openrouter:")).length;
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = computer.openRouter !== null;
  const save = (value: string) =>
    start(async () => {
      const err = await setOpenRouterKey(value);
      setError(err);
      if (!err) (setKey(""), setEditing(false));
    });

  return (
    <div id="open-models" className="surface mb-3 scroll-mt-6 p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[14px]">
            Open models <span className="text-foreground/40">· optional</span>
          </div>
          <div className="text-body-sm text-foreground/55">
            {computer.openRouter === "env"
              ? `Connected from OPENROUTER_API_KEY${openCount ? ` · ${openCount} open models in the model picker` : ""}.`
              : saved
                ? `Connected${openCount ? ` · ${openCount} open models in the model picker` : ""}. Voice calls still use OpenAI.`
                : "Paste an OpenRouter key (from openrouter.ai) to run dots on open models like Qwen, DeepSeek, Kimi, GLM and Llama."}
          </div>
        </div>
        {computer.openRouter === "settings" && !editing && (
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
      {(editing || !saved) && computer.openRouter !== "env" && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(key);
          }}
        >
          <input className="field font-mono text-[13px]" type="password" placeholder="sk-or-..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          <button className="btn-primary shrink-0" disabled={pending || !key.trim()}>
            {pending ? "Checking…" : "Save"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}
