"use client";

import { useMemo, useState, useTransition } from "react";
import { X } from "lucide-react";
import * as actions from "@/app/actions";
import { useStore } from "@/lib/store";
import type { ApprovalMode, Dot, RuleDecision } from "@/lib/types";

/** Two-column settings block: label + description on the left, controls on the right. */
export function Section({ id, eyebrow, title, description, children }: { id?: string; eyebrow?: string; title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="grid gap-5 border-t border-black/[0.06] py-8 first:border-t-0 first:pt-2 md:grid-cols-[240px_1fr] md:gap-10">
      <div>
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h2 className="text-[15px] leading-snug font-medium">{title}</h2>
        {description && <p className="mt-1.5 text-body-sm text-foreground/55">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="pt-10 pb-6">
      <div className="eyebrow text-brand-readable/80">{eyebrow}</div>
      <h1 className="text-h1 mt-2">{title}</h1>
      {description && <p className="mt-2 max-w-[560px] text-body-sm text-foreground/55">{description}</p>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-black/10 px-4 py-5 text-center text-body-sm text-foreground/45">{children}</div>;
}

export function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/35 transition-colors hover:bg-black/[0.05] hover:text-foreground" onClick={onClick} aria-label={label}>
      <X className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

const DECISIONS: { value: RuleDecision; label: string; tone: string }[] = [
  { value: "allow", label: "Allow automatically", tone: "bg-success/12 text-success" },
  { value: "ask", label: "Ask first", tone: "bg-warning/15 text-warning" },
  { value: "never", label: "Never allow", tone: "bg-destructive/10 text-destructive" },
];

export function ApprovalModeSelect({ dot, compact = false }: { dot: Dot; compact?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className={compact ? "hidden xl:block" : "surface mb-4 space-y-2 p-4"}>
      <label className={compact ? "flex items-center gap-1.5 text-caption text-foreground/60" : "block"}>
        <span className={compact ? "" : "eyebrow mb-1.5 block"}>Approvals</span>
        <select
          aria-label="Approval mode"
          className={compact ? "h-8 max-w-36 rounded-md border border-black/10 bg-card px-2 text-[12px]" : "field"}
          value={dot.approvalMode}
          disabled={pending}
          onChange={(e) => {
            const mode = e.target.value as ApprovalMode;
            setError(null);
            start(async () => {
              try { await actions.setApprovalMode(dot.id, mode); }
              catch { setError("Could not save approval mode. Try again."); }
            });
          }}
        >
          <option value="balanced">Ask when needed</option>
          <option value="ask">Ask before actions</option>
          <option value="auto">Auto approve</option>
        </select>
      </label>
      {!compact && <p className="text-caption text-foreground/55">
        {dot.approvalMode === "auto"
          ? "Commands and actions run without ordinary approval prompts, including changes on your PC and in connected apps. This overrides Ask first rules. Never allow rules and built-in safety checks still apply."
          : dot.approvalMode === "balanced"
          ? "Routine work runs automatically after your bot's model checks it. Risky or uncertain actions still ask; if the check fails, it asks too."
          : "Local commands and sensitive actions ask first. Reading workspace files and routine browser navigation still run automatically."}
        {" "}Applies to every chat and routine for this dot. Approve or deny any request already waiting once.
      </p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </div>
  );
}

export function RuleEditor({ dotId, name }: { dotId: string | null; name: string }) {
  const all = useStore((s) => s.rules);
  const auto = useStore((s) => s.dots.find(d => d.id === dotId)?.approvalMode === "auto");
  const rules = useMemo(() => all.filter((r) => r.dotId === dotId), [all, dotId]);
  const [action, setAction] = useState("");
  const [decision, setDecision] = useState<RuleDecision>("ask");
  const [pending, start] = useTransition();

  return (
    <div className="space-y-3">
      {rules.length > 0 && (
        <div className="surface divide-y divide-black/[0.06]">
          {rules.map((r) => {
            const d = DECISIONS.find((x) => x.value === r.decision)!;
            return (
              <div key={r.id} className="flex items-center gap-3 py-2 pr-2 pl-4">
                <span className="min-w-0 flex-1 text-body-sm text-foreground/60">
                  When {name} wants to <span className="text-foreground">{r.action}</span>
                </span>
                <span className={`shrink-0 rounded-xs px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase ${auto && r.decision === "ask" ? "bg-black/5 text-foreground/45" : d.tone}`}>
                  {auto && r.decision === "ask" ? "Inactive in Auto approve" : d.label}
                </span>
                <RemoveButton label="Delete rule" onClick={() => start(() => actions.deleteRule(r.id))} />
              </div>
            );
          })}
        </div>
      )}
      <form
        className="surface space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!action.trim()) return;
          start(() => actions.addRule(dotId, action, decision));
          setAction("");
        }}
      >
        <label className="block">
          <span className="eyebrow mb-1.5 block">When {name} wants to</span>
          <input className="field" placeholder="reply to emails for me" value={action} onChange={(e) => setAction(e.target.value)} />
        </label>
        <div>
          <span className="eyebrow mb-1.5 block">It should</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {DECISIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => setDecision(d.value)}
                className={`h-8 rounded-md border px-3 text-[13px] transition-colors ${decision === d.value ? "border-foreground bg-foreground text-card" : "border-black/10 text-foreground/70 hover:border-black/25"}`}
              >
                {d.label}
              </button>
            ))}
            <button className="btn-primary ml-auto h-8 px-3 text-[13px]" disabled={pending || !action.trim()}>
              Add rule
            </button>
          </div>
        </div>
      </form>
      <p className="text-caption text-foreground/45">One short, natural-language rule per action. &ldquo;Never allow&rdquo; always wins. Auto approve overrides &ldquo;Ask first&rdquo; rules; those rules apply again in the other modes. Built-in safety checks always apply.</p>
    </div>
  );
}
