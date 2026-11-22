import { OP_VERSION } from "#shared/migrate.ts";

/**
 * The server runs a newer op version than this page's own code, so the page
 * reloads to pick up the new build. It reloads once per server version: the
 * version tried is kept for the tab, so a reload that lands on the same old
 * code (a cached page) never starts another.
 */
export type BuildReload = {
  /** The op version of this page's own code. */
  ownOp: number;
  /** The newest server version this tab already reloaded for, null when it never did, or "unknown" when the tab cannot say, which never reloads. */
  tried(): number | null | "unknown";
  /** Keeps the version for the tab. False when it could not be kept, which must stop the reload: nothing would stop the next one. */
  remember(serverOp: number): boolean;
  reload(): void;
};

const KEY = "raccoon.buildReloadFor";

/** Whether a page whose own version is `ownOp` reloads for `serverOp`, given the newest version it already reloaded for. */
export function shouldReloadForBuild(serverOp: number, ownOp: number, tried: number | null | "unknown"): boolean {
  // Without a record that survives a reload there is no way to stop a second one.
  if (tried === "unknown") return false;
  return serverOp > ownOp && (tried === null || tried < serverOp);
}

export function browserBuildReload(): BuildReload {
  return {
    ownOp: OP_VERSION,
    tried() {
      try {
        const kept = sessionStorage.getItem(KEY);
        if (kept === null) return null;
        const n = Number(kept);
        return Number.isSafeInteger(n) ? n : "unknown";
      } catch {
        return "unknown";
      }
    },
    remember(serverOp) {
      try {
        sessionStorage.setItem(KEY, String(serverOp));
        // Storage that takes a write and keeps nothing would loop as well.
        return sessionStorage.getItem(KEY) === String(serverOp);
      } catch {
        return false;
      }
    },
    reload() {
      location.reload();
    },
  };
}
