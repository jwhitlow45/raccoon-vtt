import type { AppError, Platform } from "../contract.ts";

/**
 * The bundled PostgreSQL's glibc floor (design 3, D-261113-074), the same
 * number as `glibc` in desktop/pins.json. Electron itself runs on older
 * systems, so the shell checks first and says why instead of letting the
 * database fail to load.
 */
export const GLIBC_FLOOR = "2.36";

/** Whether `version` (such as "2.35") is below `floor`. */
export function versionBelow(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Number.isNaN(d)) return false;
    if (d !== 0) return d < 0;
  }
  return false;
}

export type HostFacts = {
  platform: Platform;
  /** process.getuid(), where the system has one. */
  uid: number | null;
  /** process.report's `glibcVersionRuntime` on Linux, null elsewhere or on musl. */
  glibc: string | null;
};

/**
 * A stop the shell can see before it starts anything (contract `AppError`):
 * running as root, which would leave root-owned files in the user's data
 * folder, and a glibc older than the database needs. Null to go on.
 */
export function startBlocker(facts: HostFacts): AppError | null {
  if (facts.platform !== "win32" && facts.uid === 0) return { kind: "root" };
  if (facts.platform === "linux" && facts.glibc !== null && versionBelow(facts.glibc, GLIBC_FLOOR)) return { kind: "glibc" };
  return null;
}

/**
 * Whether a supervisor that died before its first status was killed by
 * macOS's Gatekeeper: the app still carries the quarantine mark its download
 * gave it, and the bundled program never ran (it could not be started, or
 * the system ended it with SIGKILL as it loaded). Opening the app once with
 * Open Anyway approves the app but not always the programs inside it, which
 * `xattr -dr com.apple.quarantine` fixes (design 11.7).
 */
export function looksQuarantined(facts: {
  platform: Platform;
  quarantined: boolean;
  spawnError: string | null;
  signal: string | null;
}): boolean {
  if (facts.platform !== "darwin" || !facts.quarantined) return false;
  return facts.spawnError === "EACCES" || facts.spawnError === "EPERM" || facts.signal === "SIGKILL";
}
