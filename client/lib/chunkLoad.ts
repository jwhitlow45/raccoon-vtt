import type { ConnectionState } from "./connection.ts";

/**
 * Panels and some tool options load their code the first time they open
 * (design section 14.1). That load can fail in two ways during a session:
 *
 * - The device is offline. The room keeps working from its store and its
 *   queue, and the panel can open once the network is back.
 * - The site was redeployed. Every chunk name carries a hash of its
 *   contents, so the chunks this page knows about are gone, and only a
 *   reload brings the new ones.
 *
 * Without an answer, React unmounts the whole tree, which takes the socket
 * and the queued edits with it. client/components/LoadBoundary.tsx catches
 * the failure at the panel, and the functions here tell the two cases
 * apart and say when a reload is safe.
 */

export type LoadFailure = "offline" | "updated" | "failed";

/**
 * Whether an error came from loading a module rather than from running one.
 * Each engine words it differently: Chrome "Failed to fetch dynamically
 * imported module", Firefox "error loading dynamically imported module",
 * Safari "Importing a module script failed", and Chrome again "Expected a
 * JavaScript module script" when the server answers a missing chunk with the
 * HTML page. Vite's own preload step says "Unable to preload CSS".
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /dynamically imported module|importing a module script failed|expected a javascript(-or-wasm)? module script|unable to preload css/i.test(
    err.message,
  );
}

/** The URL of the chunk that failed, when the engine names it (Chrome and Firefox do, Safari does not). */
export function chunkUrlFrom(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const match = /(https?:\/\/[^\s'"]+\.m?js)\b/.exec(err.message);
  return match ? match[1]! : null;
}

/** The module scripts an HTML page loads, as paths, in page order. */
export function moduleScripts(html: string, base: string): string[] {
  const paths: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    try {
      paths.push(new URL(src, base).pathname);
    } catch {
      // Not a URL a browser would load either.
    }
  }
  return paths;
}

export type ProbeResponse = { status: number; contentType: string; text: string };

export type LoadProbe = {
  online(): boolean;
  /** GET without the cache. Rejects when the network fails. */
  fetch(url: string): Promise<ProbeResponse>;
  /** This page's own module scripts, as paths. */
  scripts(): string[];
  /** The site's origin, to resolve paths against. */
  origin: string;
};

/**
 * Why a chunk did not load. The page itself answers: a fresh copy of the
 * page that loads other scripts than this one means a new build. A chunk
 * that is missing or comes back as HTML means the same, for a page served
 * from a cache that has not caught up yet. A network error means offline.
 * Anything else, such as a dropped request on a live network, is worth
 * another try as it is.
 */
export async function classifyLoadFailure(err: unknown, probe: LoadProbe): Promise<LoadFailure> {
  if (!probe.online()) return "offline";
  let page: ProbeResponse;
  try {
    page = await probe.fetch(`${probe.origin}/`);
  } catch {
    return "offline";
  }
  if (page.status >= 200 && page.status < 300) {
    const fresh = moduleScripts(page.text, probe.origin);
    const current = new Set(probe.scripts());
    if (fresh.length > 0 && current.size > 0 && fresh.some((path) => !current.has(path))) return "updated";
  }
  const chunk = chunkUrlFrom(err);
  if (chunk && new URL(chunk).origin === probe.origin) {
    try {
      const res = await probe.fetch(chunk);
      if (res.status === 404 || res.status === 410 || /text\/html/i.test(res.contentType)) return "updated";
    } catch {
      return "offline";
    }
  }
  return "failed";
}

/**
 * What the "reload" button may do now. Ops still in the queue live only in
 * this page's memory (design section 7.4), so a reload would lose them.
 * They go out first: the button waits until the server has answered every
 * one. It also waits for the connection itself, because a reload while
 * offline lands on the browser's own error page instead of the room.
 */
export function reloadGate(input: { pending: number; connection: ConnectionState }): { ready: boolean; status: string | null } {
  const { pending, connection } = input;
  const open = connection === "open";
  if (pending === 0) return open ? { ready: true, status: null } : { ready: false, status: "Waiting for the connection…" };
  const edits = pending === 1 ? "1 change" : `${pending} changes`;
  if (open) return { ready: false, status: `Saving ${edits} first…` };
  return { ready: false, status: `Waiting for the connection to save ${edits} first.` };
}
