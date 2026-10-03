"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/live-analysis", label: "Live analysis" },
  { href: "/calibration", label: "Calibration" },
  { href: "/history", label: "History" },
  { href: "/simulation", label: "Simulation lab" },
  { href: "/limitations", label: "Limitations" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-30 w-56 border-r border-ink-700 bg-ink-900 p-4 transition-transform lg:static lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-6">
          <div className="text-base font-semibold tracking-tight">SpinSight</div>
          <div className="text-[11px] text-ink-400">motion measurement · research</div>
        </div>
        <nav className="space-y-1">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
              className={`block rounded-lg px-3 py-2 text-sm ${path?.startsWith(n.href) ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:bg-ink-800"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <button className="btn-ghost mt-6 w-full" onClick={() => void logout()}>Sign out</button>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <main className="min-w-0 flex-1 p-4 lg:p-6">
        <button className="btn-ghost mb-4 lg:hidden" onClick={() => setOpen(true)}>Menu</button>
        {children}
      </main>
    </div>
  );
}
