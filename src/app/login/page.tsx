"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Sign-in failed");
      return;
    }
    const next = params.get("next");
    router.replace(next && next.startsWith("/") ? next : "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="panel w-full max-w-sm space-y-4 p-6">
      <div>
        <div className="text-lg font-semibold">SpinSight</div>
        <div className="text-sm text-ink-400">Wheel motion research tool</div>
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-ink-300">Username</span>
        <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-ink-300">Password</span>
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="text-sm text-bad">{error}</div>}
      <button className="btn-primary w-full" disabled={busy || !username || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
