"use client";

import Link from "next/link";
import { Suspense, use, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppWindow, ArrowRight, ArrowUp, AudioLines, Plus, Brain, Download, ExternalLink, FileText, Paperclip, Plug, Check, Clock, Globe, KeyRound, Laptop, MessageSquare, MonitorSmartphone, Search, ShieldAlert, Sparkles, Terminal, X } from "lucide-react";
import { confirmConnectCard, resolveCard, resumeDot, sendMessage, startConversation, startVoiceConversation } from "@/app/actions";
import { mergeMessages, useStore } from "@/lib/store";
import { startCall } from "@/lib/voiceCall";
import Dot3DLazy from "./Dot3DLazy";
import DotOrb from "./DotOrb";
import type { Attachment, Dot, Message } from "@/lib/types";

const SUGGESTIONS = [
  { label: "Research", text: "Research the best noise-cancelling headphones under $300 and give me a shortlist with sources" },
  { label: "Routine", text: "Every weekday at 8am, send me a short briefing on the top AI news" },
  { label: "Browse", text: "Open Hacker News in your browser and tell me the top 5 stories" },
];

// Older messages of a conversation load on open (the live snapshot only carries recent ones).
const historyLoads = new Map<string, Promise<true>>();
function loadHistory(convId: string) {
  let p = historyLoads.get(convId);
  if (!p) {
    p = fetch(`/api/conversations/${convId}`)
      .then((r) => r.json() as Promise<{ messages: Message[] }>)
      .then((r) => (mergeMessages(r.messages), true as const))
      .catch(() => true as const);
    historyLoads.set(convId, p);
  }
  return p;
}
function HistoryLoader({ convId }: { convId: string }) {
  use(loadHistory(convId));
  return null;
}

/** `conversation`: a conversation id, "new" for a fresh chat, or undefined for the dot's latest chat. */
export default function Chat({ dot, conversation }: { dot: Dot; conversation?: string }) {
  const router = useRouter();
  const all = useStore((s) => s.messages);
  const conversations = useStore((s) => s.conversations);
  const mine = useMemo(() => conversations.filter((c) => c.dotId === dot.id).sort((a, b) => b.updatedAt - a.updatedAt), [conversations, dot.id]);
  const convId = conversation === "new" ? null : conversation ?? mine[0]?.id ?? null;
  const messages = useMemo(() => (convId ? all.filter((m) => m.conversationId === convId && !m.channelId) : []), [all, convId]);
  const hasKey = useStore((s) => s.computer.hasKey || s.computer.openRouter !== null || ((s.computer.openCode.go.enabled && s.computer.openCode.go.source !== null) || (s.computer.openCode.zen.enabled && s.computer.openCode.zen.source !== null)));
  const [, start] = useTransition();
  // A chat counts as started once you've written, or talked in voice mode.
  const fresh = !messages.some((m) => m.role === "user" || m.from === "voice");
  // On a fresh chat the welcome panel replaces the dot's canned greeting.
  const shown = fresh && messages[0]?.role === "dot" ? messages.slice(1) : messages;
  // "NEW" marks messages that arrived since the user last looked (captured when the chat opens).
  const lastRead = useStore((s) => s.lastRead[dot.id]);
  const [readAt] = useState(() => lastRead ?? Infinity);
  const firstNew = shown.findIndex((m) => (m.role === "dot" || m.role === "card") && m.createdAt > readAt);
  // Best guess at where the dot is working: its most recently active conversation.
  const workingHere = dot.status === "working" && (convId === mine[0]?.id || !convId);

  const send = (text: string, attachments: Attachment[] = []) =>
    start(async () => {
      if (convId) await sendMessage(dot.id, text, attachments, convId);
      else router.replace(`/dots/${dot.id}?c=${await startConversation(dot.id, text, attachments)}`);
    });

  // Voice mode writes into this chat; from "New chat" it makes the chat first.
  const voice = async () => {
    const id = convId ?? (await startVoiceConversation(dot.id));
    if (!convId) router.replace(`/dots/${dot.id}?c=${id}`);
    void startCall(dot.id, id);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {convId && (
          <Suspense fallback={null}>
            <HistoryLoader convId={convId} />
          </Suspense>
        )}
        {/* column-reverse keeps the view pinned to the newest message without scroll effects */}
        <div className="flex flex-1 flex-col-reverse overflow-y-auto">
          <div className="flex min-h-full w-full shrink-0 flex-col px-3 sm:px-6">
            <div className="flex-1" />
            {fresh && (
              <div className="mx-auto w-full max-w-[780px]">
                <Welcome dot={dot} onPick={(t) => send(t)} />
              </div>
            )}
            <div className="space-y-1.5 py-6">
              {shown.map((m, i) => (
                <div key={m.id}>
                  {i === firstNew && i > 0 && <NewDivider />}
                  {(i === 0 || m.createdAt - shown[i - 1].createdAt > 60 * 60_000) && <DateSeparator ts={m.createdAt} />}
                  <div className="max-w-[860px]">
                    <MessageRow m={m} dot={dot} />
                  </div>
                </div>
              ))}
              {workingHere && (
                <div className="flex items-center gap-3">
                  <DotOrb look={dot.look} status="working" size={24} />
                  <span className="shimmer-text text-body-sm">{dot.activity ?? "Working"}…</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="w-full px-3 pb-3 sm:px-6 sm:pb-5">
          {!hasKey && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/[0.08] px-3.5 py-2 text-body-sm">
              <ShieldAlert className="size-4 text-warning" strokeWidth={1.75} />
              <span>
                Add an OpenAI, OpenCode, or OpenRouter key in{" "}
                <Link href="/settings#api-key" className="underline underline-offset-2">
                  Settings
                </Link>{" "}
                so your dots can think.
              </span>
            </div>
          )}
          <Composer key={convId ?? "new"} dot={dot} onSend={send} onVoice={voice} />
        </div>
      </div>
    </div>
  );
}

function Welcome({ dot, onPick }: { dot: Dot; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-12 text-center">
      <div className="dot-grid rounded-full">
        <Dot3DLazy look={dot.look} status={dot.status} size={148} />
      </div>
      <div className="eyebrow mt-4 text-brand-readable/80">Your dot</div>
      <h1 className="text-h1 mt-2">Hi, I&apos;m {dot.name}</h1>
      {dot.purpose && (
        <div className="mt-3 max-w-[520px] rounded-md border border-black/[0.06] bg-card px-3 py-1.5 text-body-sm text-foreground/70">
          <span className="eyebrow mr-2">Job</span>
          {dot.purpose}
        </div>
      )}
      <p className="text-body mt-3 max-w-[460px] text-foreground/55">
        I work on my own computer and browser, remember what matters, and ask before doing anything important.
      </p>
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.text)}
            className="surface group flex flex-col items-start gap-2 p-3.5 text-left transition-[border-color,box-shadow] hover:border-black/15 hover:shadow-elevated"
          >
            <span className="eyebrow flex w-full items-center justify-between">
              {s.label}
              <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
            <span className="text-body-sm text-foreground/75">{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Upload = { key: string; name: string; state: "uploading" | "done" | "error"; file?: Attachment; error?: string };

async function uploadFiles(dotId: string, list: File[]): Promise<{ files?: Attachment[]; error?: string }> {
  const form = new FormData();
  for (const f of list) form.append("file", f);
  const r = await fetch(`/api/dots/${dotId}/files`, { method: "POST", body: form });
  return r.json();
}

function Composer({ dot, onSend, onVoice }: { dot: Dot; onSend: (text: string, attachments: Attachment[]) => void; onVoice: () => void }) {
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();
  const ready = uploads.filter((u) => u.state === "done" && u.file).map((u) => u.file!);
  const busy = uploads.some((u) => u.state === "uploading");

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    const batch = list.map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, name: f.name, state: "uploading" as const }));
    setUploads((u) => [...u, ...batch]);
    void uploadFiles(dot.id, list).then((r) =>
      setUploads((u) =>
        u.map((x) => {
          const i = batch.findIndex((b) => b.key === x.key);
          if (i === -1) return x;
          return r.files?.[i] ? { ...x, state: "done", file: r.files[i] } : { ...x, state: "error", error: r.error ?? "Upload failed" };
        }),
      ),
    );
  };

  const submit = () => {
    const value = text.trim();
    if ((!value && !ready.length) || busy) return;
    setText("");
    setUploads([]);
    onSend(value, ready);
  };

  if (dot.status === "paused") {
    return (
      <div className="surface flex items-center justify-between gap-4 px-4 py-3 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.15)]">
        <span className="text-body-sm text-foreground/60">
          {dot.name} is paused. Any ongoing work was stopped, and it won&apos;t message you until you resume it.
        </span>
        <button className="btn-primary h-8 shrink-0 px-3 text-[13px]" onClick={() => start(() => resumeDot(dot.id))}>
          Resume
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div
        className={`rounded-[26px] border bg-card p-1.5 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.15)] transition-[box-shadow,border-color] focus-within:shadow-[0_12px_40px_-12px_rgba(0,0,0,0.2)] ${dragging ? "border-brand border-dashed" : "border-black/10"}`}
      >
        {uploads.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 pl-1">
            {uploads.map((u) => (
              <span
                key={u.key}
                className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] ${u.state === "error" ? "border-destructive/40 text-destructive" : "border-black/10 text-foreground/70"}`}
                title={u.error}
              >
                <Paperclip className="size-3" strokeWidth={1.75} />
                <span className="max-w-40 truncate">{u.name}</span>
                {u.state === "uploading" && <span className="font-mono text-[10px] text-foreground/40">…</span>}
                <button onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label={`Remove ${u.name}`} className="text-foreground/35 hover:text-foreground">
                  <X className="size-3" strokeWidth={2} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <label className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-black/[0.05] hover:text-foreground" title="Attach files">
            <Plus className="size-5" strokeWidth={1.75} />
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
          <textarea
            rows={1}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={dragging ? "Drop files to attach" : `Message ${dot.name}…`}
            className="max-h-52 min-h-10 flex-1 resize-none bg-transparent py-2 text-[16px] leading-[1.45] tracking-default outline-none [field-sizing:content] placeholder:text-foreground/35"
          />
          {text.trim() || ready.length || busy ? (
            <button
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-card transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-25"
              disabled={pending || busy}
              onClick={submit}
              aria-label="Send"
            >
              <ArrowUp className="size-4" strokeWidth={2.25} />
            </button>
          ) : (
            // Empty composer: the round button starts voice mode. What's said lands in this chat.
            <button
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-card transition-opacity hover:opacity-85"
              onClick={onVoice}
              aria-label={`Voice mode with ${dot.name}`}
              title="Voice mode"
            >
              <AudioLines className="size-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Files on a message: images preview inline, everything else is a download chip. */
function Attachments({ items, align = "start" }: { items: Attachment[]; align?: "start" | "end" }) {
  const images = items.filter((a) => /^image\/(png|jpeg|gif|webp)$/.test(a.mime));
  const others = items.filter((a) => !images.includes(a));
  const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <div className={`mt-2 flex flex-wrap gap-2 ${align === "end" ? "justify-end" : ""}`}>
      {images.map((a) => (
        <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-black/[0.06] bg-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${a.id}`} alt={a.name} className="max-h-60 max-w-[320px] object-contain" />
        </a>
      ))}
      {others.map((a) => (
        <a
          key={a.id}
          href={`/api/files/${a.id}${a.mime === "application/pdf" ? "" : "?download=1"}`}
          target="_blank"
          rel="noreferrer"
          className="surface flex items-center gap-2.5 px-3 py-2 transition-colors hover:border-black/15"
        >
          <FileText className="size-4 shrink-0 text-foreground/45" strokeWidth={1.5} />
          <span className="min-w-0">
            <span className="block max-w-56 truncate text-[13px]">{a.name}</span>
            <span className="block font-mono text-[10px] text-foreground/40 uppercase">{size(a.size)}</span>
          </span>
          <Download className="size-3.5 text-foreground/35" strokeWidth={1.75} />
        </a>
      ))}
    </div>
  );
}

const ACTIVITY_ICON: [RegExp, typeof Globe][] = [
  [/^Searched|^Searching/, Search],
  [/^Browsing|^Reading the web/, Globe],
  [/^Using its computer/, MonitorSmartphone],
  [/^Running commands|^Reading a file|^Writing a file/, Terminal],
  [/^Signing in/, KeyRound],
  [/^On your computer/, Laptop],
  [/^Remember|^Updating memory/, Brain],
  [/^Setting up a routine|^Updating routines/, Clock],
  [/^Messaging/, MessageSquare],
  [/^Learning a skill|^Using a skill/, Sparkles],
  [/^Finding app tools|^Using an app|^Connecting an app/, AppWindow],
  [/^Blocked/, X],
];

/** One chat line. In channels, `showName` labels which dot wrote it. */
export function MessageRow({ m, dot, showName = false }: { m: Message; dot: Dot; showName?: boolean }) {
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end pl-8 sm:pl-12">
        {m.from && <span className="eyebrow mb-1">{m.from.replace(/^dot:/, "From ").replace(/^routine:/, "Routine · ")}</span>}
        {m.text && (
          <div className="max-w-full rounded-[18px] bg-foreground px-4 py-2.5 text-[15px] leading-[1.5] tracking-default whitespace-pre-wrap text-card">
            {m.text}
          </div>
        )}
        {!!m.attachments?.length && <Attachments items={m.attachments} align="end" />}
      </div>
    );
  }
  if (m.role === "activity") {
    const [label, ...rest] = m.text.split(" · ");
    const Icon = ACTIVITY_ICON.find(([re]) => re.test(label))?.[1] ?? Sparkles;
    return (
      <div className="flex min-w-0 items-center gap-2 pl-1 text-foreground/45">
        <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
        {showName && <span className="shrink-0 text-[12px] text-foreground/65">{dot.name}</span>}
        <span className="shrink-0 font-mono text-[11px] tracking-wide whitespace-nowrap uppercase">{label}</span>
        {rest.length > 0 && <span className="truncate font-mono text-[11px] text-foreground/35">{rest.join(" · ")}</span>}
      </div>
    );
  }
  if (m.role === "system") {
    return (
      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-black/[0.06]" />
        <span className="text-caption text-foreground/45">{m.text}</span>
        <span className="h-px flex-1 bg-black/[0.06]" />
      </div>
    );
  }
  if (m.role === "card" && m.card) return <CardRow m={m} />;
  return (
    <div className={`flex gap-2.5 ${showName ? "" : "pr-6 sm:pr-12"}`}>
      {showName && (
        <div className="pt-0.5">
          <DotOrb look={dot.look} status="idle" size={24} />
        </div>
      )}
      <div className="min-w-0 max-w-full rounded-[18px] bg-background px-4 py-2.5">
        {showName && <div className="mb-0.5 text-[13px] font-medium">{dot.name}</div>}
        {m.title && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-xs bg-highlight px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-highlight-foreground uppercase">
            <Sparkles className="size-3" strokeWidth={2} />
            {m.title}
          </div>
        )}
        <div className="dot-prose">
          <Markdown remarkPlugins={[remarkGfm]}>{m.text || "…"}</Markdown>
        </div>
        {!!m.attachments?.length && <Attachments items={m.attachments} />}
      </div>
    </div>
  );
}

function CardRow({ m }: { m: Message }) {
  const card = m.card!;
  const [answer, setAnswer] = useState("");
  const [pending, start] = useTransition();
  const open = card.status === "pending";
  const act = (choice: "approve" | "deny" | "always" | "answer", value?: string) => start(() => resolveCard(m.id, choice, value));

  if (!open) {
    const tone = card.status === "approved" || card.status === "answered" ? "text-success" : card.status === "denied" ? "text-destructive" : "text-foreground/40";
    const Icon = card.status === "denied" ? X : card.status === "expired" ? Clock : Check;
    return (
      <div className="flex max-w-[560px] items-center gap-2.5 rounded-lg border border-black/[0.06] bg-card/60 px-3 py-2">
        <Icon className={`size-3.5 shrink-0 ${tone}`} strokeWidth={2} />
        <span className="truncate text-body-sm text-foreground/60">{card.title}</span>
        <span className={`ml-auto shrink-0 font-mono text-[10px] tracking-wider uppercase ${tone}`}>
          {card.status === "answered" ? `Answered · ${card.answer}` : card.kind === "connect" && card.status === "approved" ? "Connected" : card.status}
        </span>
      </div>
    );
  }

  return (
    <div className="surface max-w-[560px] overflow-hidden shadow-elevated">
      <div className="flex items-center gap-2 border-b border-black/[0.06] bg-popover px-4 py-2">
        <span className="size-1.5 rounded-full bg-warning" />
        <span className="eyebrow">{card.kind === "question" ? "Question for you" : card.kind === "connect" ? "Connect an app" : "Needs your approval"}</span>
      </div>
      <div className="p-4">
        <div className="text-[15px] leading-snug font-medium">{card.title}</div>
        {card.detail && <div className="mt-1.5 text-body-sm whitespace-pre-wrap text-foreground/60">{card.detail}</div>}

        {card.kind === "connect" && <ConnectActions m={m} />}

        {card.kind === "approval" && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button className="btn-primary h-8 px-3 text-[13px]" disabled={pending} onClick={() => act("approve")}>
              Approve
            </button>
            <button className="btn-secondary h-8 px-3 text-[13px]" disabled={pending} onClick={() => act("deny")}>
              Deny
            </button>
            {card.ruleAction && (
              <button className="btn-quiet ml-auto" disabled={pending} onClick={() => act("always")} title={`Adds a rule: always allow when it wants to ${card.ruleAction}`}>
                Always allow
              </button>
            )}
          </div>
        )}

        {card.kind === "question" && (
          <div className="mt-4 space-y-2.5">
            {!!card.options?.length && (
              <div className="flex flex-wrap gap-2">
                {card.options.map((o) => (
                  <button key={o} className="btn-secondary h-8 px-3 text-[13px]" disabled={pending} onClick={() => act("answer", o)}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (answer.trim()) act("answer", answer.trim());
              }}
            >
              <input className="field h-8" placeholder="Type your own answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <button className="btn-primary h-8 px-3 text-[13px]" disabled={pending || !answer.trim()}>
                Send
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectActions({ m }: { m: Message }) {
  const card = m.card!;
  const [pending, start] = useTransition();
  const [notYet, setNotYet] = useState(false);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button className="btn-primary h-8 px-3 text-[13px]" disabled={!card.url} onClick={() => window.open(card.url, "_blank", "noopener")}>
        <Plug className="size-3.5" strokeWidth={1.75} /> {card.title}
        <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
      </button>
      <button
        className="btn-secondary h-8 px-3 text-[13px]"
        disabled={pending}
        onClick={() => start(async () => setNotYet(!(await confirmConnectCard(m.id))))}
      >
        I&apos;ve connected
      </button>
      <button className="btn-quiet" disabled={pending} onClick={() => start(() => resolveCard(m.id, "deny"))}>
        Not now
      </button>
      {notYet && <span className="text-caption text-foreground/50">Not connected yet. Finish signing in, then try again.</span>}
    </div>
  );
}

function NewDivider() {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="h-px flex-1 bg-brand/40" />
      <span className="font-mono text-[10px] tracking-wider text-brand-readable uppercase">New</span>
      <span className="h-px flex-1 bg-brand/40" />
    </div>
  );
}

function DateSeparator({ ts }: { ts: number }) {
  const d = new Date(ts);
  const label = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return <div className="py-3 text-center font-mono text-[10px] tracking-wider text-foreground/35 uppercase">{label}</div>;
}
