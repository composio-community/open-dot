"use client";

import Link from "next/link";
import { Suspense, use, useState, useTransition } from "react";
import { Cloud, Hand, Laptop, MonitorSmartphone, RefreshCw, RotateCcw, Terminal, Undo2 } from "lucide-react";
import { handBackComputer, resetComputer, setLocalAccess, takeOverComputer, wakeComputer } from "@/app/actions";
import { useStore } from "@/lib/store";
import FilesPanel from "./FilesPanel";
import LiveBrowser from "./LiveBrowser";
import type { Dot } from "@/lib/types";

// Live-view URLs, cached per dot + mode so re-renders don't restart the stream request.
const liveCache = new Map<string, Promise<{ url: string | null; error?: string }>>();
function liveUrl(dotId: string, interactive: boolean, nonce: number) {
  const k = `${dotId}:${interactive}:${nonce}`;
  let p = liveCache.get(k);
  if (!p) {
    p = fetch(`/api/dots/${dotId}/live${interactive ? "?interactive=1" : ""}`).then((r) => r.json() as Promise<{ url: string | null; error?: string }>);
    liveCache.set(k, p);
  }
  return p;
}

function LiveView({ dotId, interactive, nonce }: { dotId: string; interactive: boolean; nonce: number }) {
  const r = use(liveUrl(dotId, interactive, nonce));
  if (!r.url) return <div className="px-6 text-center text-body-sm text-destructive">{r.error ?? "The live view isn't available."}</div>;
  return <iframe src={r.url} title="Live view" className={`h-full w-full border-0 bg-black ${interactive ? "" : "pointer-events-none"}`} allow="clipboard-read; clipboard-write" />;
}

export default function ComputerPane({ dot }: { dot: Dot }) {
  const shotAt = useStore((s) => s.screens[dot.id]);
  const computer = useStore((s) => s.computer);
  const machine = computer.platform === "darwin" ? "Mac" : "PC";
  const cloud = computer.mode === "cloud";
  const [nonce, setNonce] = useState(0);
  const [takenOver, setTakenOver] = useState(false);
  const [watching, setWatching] = useState(false); // Refresh started the browser: show it live
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const shotSrc = nonce ? `/api/dots/${dot.id}/screen?fresh=1&t=${nonce}` : shotAt ? `/api/dots/${dot.id}/screen?t=${shotAt}` : null;
  const live = dot.status === "working" && dot.activity === "Using its computer";

  const takeOver = () =>
    start(async () => {
      const r = await takeOverComputer(dot.id);
      if (r.error) setError(r.error);
      else setTakenOver(true);
    });
  const handBack = () => start(async () => (await handBackComputer(dot.id), setTakenOver(false)));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="rails mx-auto min-h-full max-w-[1080px] px-4 sm:px-8 py-8">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div>
            <div className="eyebrow">Computer</div>
            <h1 className="text-h2 mt-1.5">{dot.name}&apos;s computer</h1>
            <p className="mt-1 text-body-sm text-foreground/55">
              {cloud
                ? "A Linux desktop in the cloud. It sleeps when idle; agents and routines need this app open and your PC awake."
                : takenOver
                  ? `You're driving. Click and type right here; logins stay saved in ${dot.name}'s browser.`
                  : "Its own browser and workspace. Watch it work, or take over to log in yourself."}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              className="btn-secondary h-8 px-3 text-[13px]"
              disabled={pending}
              onClick={() =>
                cloud ? setNonce(Date.now()) : start(async () => (await wakeComputer(dot.id), setWatching(true), setNonce(Date.now())))
              }
            >
              <RefreshCw className="size-3.5" strokeWidth={1.75} /> Refresh
            </button>
            {takenOver ? (
              <button className="btn-primary h-8 px-3 text-[13px]" disabled={pending} onClick={handBack}>
                <Undo2 className="size-3.5" strokeWidth={1.75} /> Hand back to {dot.name}
              </button>
            ) : (
              <button className="btn-primary h-8 px-3 text-[13px]" disabled={pending} title="Your dot pauses while you're in control." onClick={takeOver}>
                <Hand className="size-3.5" strokeWidth={1.75} /> Take over
              </button>
            )}
          </div>
        </div>
        {error && <p className="mb-3 text-caption text-destructive">{error}</p>}

        {/* Screen */}
        <section className="surface overflow-hidden shadow-elevated">
          <div className="flex h-9 items-center gap-3 border-b border-black/[0.06] bg-popover px-3">
            <span className="flex gap-1.5">
              <span className="size-2.5 rounded-full bg-black/10" />
              <span className="size-2.5 rounded-full bg-black/10" />
              <span className="size-2.5 rounded-full bg-black/10" />
            </span>
            <span className="flex h-6 flex-1 items-center gap-2 rounded-xs border border-black/[0.06] bg-card px-2.5 font-mono text-[11px] text-foreground/45">
              {cloud ? <Cloud className="size-3" strokeWidth={1.75} /> : <MonitorSmartphone className="size-3" strokeWidth={1.75} />}
              {dot.name.toLowerCase()}.{cloud ? "cloud" : "browser"}
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase">
              <span className={`size-1.5 rounded-full ${takenOver ? "bg-warning" : live || cloud || watching ? "live-dot bg-brand text-brand" : "bg-foreground/25"}`} />
              <span className="text-foreground/50">{takenOver ? "You're in control" : live || cloud || watching ? "Live" : "Idle"}</span>
            </span>
          </div>
          {!cloud && (takenOver || live || watching) ? (
            <LiveBrowser dotId={dot.id} interactive={takenOver} nonce={nonce} />
          ) : (
            <div className="dot-grid flex aspect-[1280/800] items-center justify-center bg-popover">
              {cloud ? (
                <Suspense fallback={<div className="text-body-sm text-foreground/50">Waking {dot.name}&apos;s computer…</div>}>
                  <LiveView dotId={dot.id} interactive={takenOver} nonce={nonce} />
                </Suspense>
              ) : shotSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shotSrc} alt={`${dot.name}'s screen`} className="h-full w-full bg-card object-contain" />
              ) : (
                <div className="text-center">
                  <MonitorSmartphone className="mx-auto size-6 text-foreground/30" strokeWidth={1.5} />
                  <p className="mt-3 text-body-sm text-foreground/50">Nothing on screen yet. Press Refresh to start {dot.name}&apos;s browser, or ask it to open a website.</p>
                </div>
              )}
            </div>
          )}
        </section>

        <FilesPanel dot={dot} />

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <section className="surface p-5">
            <div className="flex items-center gap-2">
              <Terminal className="size-4 text-foreground/50" strokeWidth={1.5} />
              <h2 className="text-[15px] font-medium">Where it runs</h2>
              <span
                className={`ml-auto rounded-xs px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase ${computer.mode === "local" ? "bg-warning/15 text-warning" : "bg-success/12 text-success"}`}
              >
                {computer.mode === "cloud" ? "Cloud" : computer.mode === "docker" ? "Container" : `This ${machine}`}
              </span>
            </div>
            <p className="mt-2 text-body-sm text-foreground/55">
              {computer.mode === "cloud" ? (
                <>An isolated E2B cloud desktop. It sleeps after 10 idle minutes (keeping its files, apps, and logins) and wakes when {dot.name} needs it.</>
              ) : computer.mode === "docker" ? (
                <>
                  A local Linux container (<code className="font-mono text-[12px]">{computer.image}</code>) with a persistent workspace.{" "}
                  <Link href="/settings#cloud-key" className="underline underline-offset-2 hover:text-foreground">
                    Add an E2B key
                  </Link>{" "}
                  for a cloud computer that works while you&apos;re away.
                </>
              ) : (
                <>
                  A workspace folder on this {machine}; commands ask first. This is not an OS sandbox.{" "}
                  <Link href="/settings#cloud-key" className="underline underline-offset-2 hover:text-foreground">
                    Add an E2B key
                  </Link>{" "}
                  for a real cloud computer.
                </>
              )}
            </p>
            <div className="mt-4">
              {confirmReset ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body-sm text-foreground/55">{cloud ? "Replaces the computer with a fresh one." : "Removes installed apps and packages. Files stay."}</span>
                  <button className="btn-primary h-8 px-3 text-[13px]" onClick={() => start(async () => (await resetComputer(dot.id), setConfirmReset(false), setNonce(Date.now())))}>
                    Reset
                  </button>
                  <button className="btn-quiet" onClick={() => setConfirmReset(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn-secondary h-8 px-3 text-[13px]" onClick={() => setConfirmReset(true)}>
                  <RotateCcw className="size-3.5" strokeWidth={1.75} /> Reset computer
                </button>
              )}
            </div>
          </section>

          <section className="surface p-5">
            <div className="flex items-center gap-2">
              <Laptop className="size-4 text-foreground/50" strokeWidth={1.5} />
              <h2 className="text-[15px] font-medium">Access to this {machine}</h2>
              <button
                role="switch"
                aria-checked={dot.localAccess}
                disabled={pending}
                onClick={() => start(() => setLocalAccess(dot.id, !dot.localAccess))}
                className={`relative ml-auto h-5 w-9 rounded-full transition-colors ${dot.localAccess ? "bg-brand" : "bg-black/15"}`}
              >
                <span className={`absolute top-0.5 size-4 rounded-full bg-card shadow-sm transition-[left] ${dot.localAccess ? "left-[18px]" : "left-0.5"}`} />
              </button>
            </div>
            <p className="mt-2 text-body-sm text-foreground/55">
              {dot.localAccess
                ? `${dot.name} can run tasks on this ${machine}, not only on its own computer. It always asks first unless your rules say otherwise.`
                : `${dot.name} can't access this ${machine}. Allow it to let your dot open files and run tasks here.`}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
