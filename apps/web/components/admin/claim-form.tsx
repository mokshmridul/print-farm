"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";

/** First run: create the admin password, proving with the setup code from the
 *  container log that this is the person running the shop. */
export function ClaimForm({ minLength }: { minLength: number }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = repeat !== "" && repeat !== password;
  const ready = code.trim() !== "" && password.length >= minLength && repeat === password;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ code, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
        throw new Error(body?.error?.message ?? "That didn't work — try again.");
      }
      router.push("/admin/setup");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work — try again.");
      setBusy(false);
    }
  };

  const label = "mb-2 block text-[0.7rem] font-[650] uppercase tracking-[0.14em] text-muted";
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-5 py-16">
      <div className="mb-6 flex items-center gap-2 text-accent">
        <KeyRound strokeWidth={1.8} className="h-5 w-5" />
        <span className="eyebrow">First run</span>
      </div>
      <h1 className="section-title">Welcome to your shop</h1>
      <p className="mt-2 text-sm text-muted">
        Create the admin password. To prove it&apos;s you, enter the setup code from the container&apos;s log:
      </p>
      <pre className="tile mt-3 overflow-x-auto px-3 py-2 text-xs">docker logs print-farm 2&gt;&amp;1 | grep &quot;setup code&quot;</pre>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className={label}>Setup code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="ABCD-1234"
            className="input-base font-mono uppercase"
          />
        </label>
        <label className="block">
          <span className={label}>New admin password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={minLength}
            maxLength={72}
            className="input-base"
          />
          <span className="mt-1 block text-xs text-faint">At least {minLength} characters.</span>
        </label>
        <label className="block">
          <span className={label}>Repeat it</span>
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            className="input-base"
            aria-invalid={mismatch}
          />
          {mismatch ? <span className="mt-1 block text-xs text-danger">The two don&apos;t match.</span> : null}
        </label>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy || !ready} className="btn-pill w-full">
          {busy ? <Loader2 strokeWidth={2} className="h-4 w-4 animate-spin" /> : "Create password and start setup"}
        </button>
      </form>
    </div>
  );
}
