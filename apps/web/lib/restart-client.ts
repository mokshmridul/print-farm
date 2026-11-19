/** Browser side of a server-settings save: the container restarts web and
 *  worker a few seconds later. Resolves once a restarted web answers (its
 *  health `boot` changed), or false after `timeoutMs`. */
export async function currentBoot(): Promise<string | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return ((await res.json()) as { boot?: string }).boot ?? null;
  } catch {
    return null;
  }
}

export async function waitForRestart(before: string | null, timeoutMs = 120_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) continue;
      const boot = ((await res.json()) as { boot?: string }).boot ?? null;
      if (boot && boot !== before) return true;
    } catch {
      // Restarting: not answering yet.
    }
  }
  return false;
}
