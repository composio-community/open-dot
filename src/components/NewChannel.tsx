"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Crown } from "lucide-react";
import { createChannel } from "@/app/actions";
import { useStore } from "@/lib/store";
import DotOrb from "./DotOrb";

export default function NewChannel() {
  const router = useRouter();
  const dots = useStore((s) => s.dots);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const leadId = lead ?? members[0] ?? null;

  const toggle = (id: string) => {
    if (lead === id) setLead(null);
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="rails mx-auto min-h-full max-w-[720px] px-4 sm:px-8 py-10">
        <div className="eyebrow text-brand-readable/80">New channel</div>
        <h1 className="text-h1 mt-2">Put a team on it</h1>
        <p className="mt-2 text-body-sm text-foreground/55">
          A channel is a group chat with several dots. The lead coordinates: it hands subtasks to members and brings you the combined result. Mention @Name to ask someone directly.
        </p>

        <label className="mt-8 block">
          <span className="eyebrow mb-1.5 block">Name</span>
          <div className="relative">
            <span className="absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[13px] text-foreground/40">#</span>
            <input className="field pl-6" placeholder="launch-plan" value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())} />
          </div>
        </label>

        <div className="mt-6">
          <div className="eyebrow mb-2">Members · pick the lead with the crown</div>
          <div className="surface divide-y divide-black/[0.06]">
            {dots.map((d) => {
              const on = members.includes(d.id);
              return (
                <div key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                  <button onClick={() => toggle(d.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className={`flex size-4 items-center justify-center rounded-xs border ${on ? "border-foreground bg-foreground text-card" : "border-black/20"}`}>
                      {on && <Check className="size-3" strokeWidth={2.5} />}
                    </span>
                    <DotOrb look={d.look} status={d.status} size={28} />
                    <span className="min-w-0">
                      <span className="block text-[14px]">{d.name}</span>
                      <span className="block truncate text-[12px] text-foreground/50">{d.purpose}</span>
                    </span>
                  </button>
                  {on && (
                    <button
                      onClick={() => setLead(d.id)}
                      className={`flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-wider uppercase ${leadId === d.id ? "bg-highlight text-highlight-foreground" : "text-foreground/40 hover:text-foreground"}`}
                    >
                      <Crown className="size-3" strokeWidth={2} /> {leadId === d.id ? "Lead" : "Make lead"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <button
          className="btn-primary mt-8 h-10 w-full text-[15px]"
          disabled={pending || !leadId || members.length < 2}
          onClick={() =>
            start(async () => {
              const id = await createChannel(name || "team", leadId!, members);
              router.push(`/channels/${id}`);
            })
          }
        >
          {members.length < 2 ? "Pick at least two dots" : `Create #${name || "team"}`}
        </button>
      </div>
    </div>
  );
}
