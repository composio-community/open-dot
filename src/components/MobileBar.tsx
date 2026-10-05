"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Menu, SquarePen } from "lucide-react";
import { setSidebarOpen } from "@/lib/ui";
import { Wordmark } from "./Sidebar";

const noop = () => () => {};

/** Opens the sidebar drawer on small screens. */
export function MenuButton() {
  return (
    <button className="btn-quiet size-9 shrink-0 p-0 md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
      <Menu className="size-5" strokeWidth={1.75} />
    </button>
  );
}

/** Top bar for small screens on pages without their own header (dot pages have one). */
export default function MobileBar() {
  const pathname = usePathname();
  // Navigation can change the path before this layout's streamed HTML hydrates.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  if (!hydrated || pathname.startsWith("/dots/")) return null;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.06] px-2 md:hidden">
      <MenuButton />
      <Link href="/" className="mr-auto">
        <Wordmark />
      </Link>
      <Link href="/" className="btn-quiet size-9 p-0" aria-label="New chat">
        <SquarePen className="size-4" strokeWidth={1.75} />
      </Link>
    </div>
  );
}
