"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? "Login failed.");
      }
      // Honor ?from= if present, else go to the landing page.
      const from = new URLSearchParams(window.location.search).get("from");
      const dest = from && from.startsWith("/") && from !== "/login" ? from : "/";
      router.replace(dest);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-line bg-card p-6 shadow-sm"
      >
        <p className="font-mono text-[0.7rem] uppercase tracking-[0.25em] text-accent">
          data/analyst
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          Enter password
        </h1>
        <p className="mt-1 text-sm text-muted">
          This app is restricted. Enter the access password to continue.
        </p>

        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mt-5 w-full rounded-lg border border-line bg-paper px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />

        {error && (
          <p className="mt-3 rounded-md border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!password || submitting}
          className="mt-4 h-11 w-full rounded-lg bg-ink text-sm font-medium text-paper transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-40"
        >
          {submitting ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
