"use client";

import { useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useStore } from "@/lib/store";

const OPEN = "openrouter:";
const OPENCODE_GO = "opencode-go:";
const OPENCODE_ZEN = "opencode-zen:";
const label = (id: string) => id.startsWith(OPEN) ? id.slice(OPEN.length) : id.startsWith(OPENCODE_GO) ? id.slice(OPENCODE_GO.length) : id.startsWith(OPENCODE_ZEN) ? id.slice(OPENCODE_ZEN.length) : id;
const providerLabel = (id: string) => id.startsWith(OPEN) ? "OpenRouter" : id.startsWith(OPENCODE_GO) ? "OpenCode Go" : id.startsWith(OPENCODE_ZEN) ? "OpenCode Zen" : "OpenAI";

function hint(id: string): string | null {
  if (id.startsWith(OPEN)) return "Open model · OpenRouter";
  if (id.startsWith(OPENCODE_GO)) return "OpenCode Go subscription";
  if (id.startsWith(OPENCODE_ZEN)) return "OpenCode Zen · pay as you go";
  if (/-pro\b/.test(id)) return "Strongest · slower";
  if (/-nano\b/.test(id)) return "Fastest · cheapest";
  if (/-mini\b/.test(id)) return "Fast · cheaper";
  if (/codex/.test(id)) return "Coding";
  return null;
}

/**
 * Model dropdown. `value === null` means "use the default"; pass `allowDefault={false}` for the
 * place where the default itself is chosen.
 */
export default function ModelPicker({
  value,
  onChange,
  allowDefault = true,
  compact = false,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  allowDefault?: boolean;
  compact?: boolean;
}) {
  const models = useStore((s) => s.computer.models);
  const fallback = useStore((s) => s.computer.model);
  const [open, setOpen] = useState(false);
  const current = value ?? fallback;
  const list = models.length ? models : fallback ? [fallback] : [];
  const options: { id: string | null; label: string; sub: string | null; group?: string }[] = [
    ...(allowDefault ? [{ id: null, label: "Default", sub: fallback ? label(fallback) : null }] : []),
    ...list.map((id, i) => {
      const group = providerLabel(id);
      const prev = i > 0 ? providerLabel(list[i - 1]) : null;
      return { id, label: label(id), sub: hint(id), group: group !== prev ? group : undefined };
    }),
  ];

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-md border border-black/10 bg-card font-mono tracking-wide text-foreground/75 transition-colors hover:border-black/20 hover:text-foreground ${compact ? "h-8 px-2.5 text-[11px]" : "h-9 px-3 text-[12px]"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Model this dot thinks with"
      >
        <Cpu className="size-3.5 text-foreground/45" strokeWidth={1.75} />
        {value === null && allowDefault ? <span className="text-foreground/45">Default ·</span> : null}
        <span className="max-w-40 truncate">{current ? label(current) : "Loading…"}</span>
        <ChevronDown className={`size-3.5 text-foreground/40 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>

      {open && (
        <div role="listbox" className="surface absolute top-full right-0 z-40 mt-1.5 max-h-80 w-64 overflow-y-auto p-1 shadow-elevated">
          <div className="eyebrow px-2.5 pt-1.5 pb-1">Model</div>
          {options.map((o) => {
            const selected = o.id === value;
            return [
              o.group && (
                <div key={`g-${o.group}`} className="eyebrow px-2.5 pt-2.5 pb-1">
                  {o.group}
                </div>
              ),
              <button
                key={o.id ?? "__default"}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${selected ? "bg-black/[0.05]" : "hover:bg-black/[0.03]"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] ${o.id ? "font-mono" : ""}`}>{o.label}</span>
                  {o.sub && <span className="block truncate font-mono text-[10px] tracking-wide text-foreground/45 uppercase">{o.sub}</span>}
                </span>
                {selected && <Check className="size-3.5 shrink-0 text-foreground" strokeWidth={2} />}
              </button>,
            ];
          })}
          {!models.length && <div className="px-2.5 py-2 text-caption text-foreground/45">Loading models…</div>}
        </div>
      )}
    </div>
  );
}
