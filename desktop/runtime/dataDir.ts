import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { APP_NAME, DATA_DIR_ENV, DATA_LAYOUT, type Platform } from "../contract.ts";

/**
 * Where a supervisor's data lives (docs/design/design-v1-local-app.md 8.1,
 * D-261113-059): `--data <dir>` or RACCOON_DATA_DIR, else one folder per
 * system. Windows uses the local, not the roaming, profile, which would
 * copy the whole database at every sign-in and sign-out.
 */

function pathFor(platform: Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

export function defaultDataDir(platform: Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = pathFor(platform);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA && p.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : p.join(home, "AppData", "Local");
    return p.join(local, APP_NAME, "data");
  }
  if (platform === "darwin") return p.join(home, "Library", "Application Support", APP_NAME, "data");
  // The XDG spec says a relative XDG_DATA_HOME is invalid and is to be ignored.
  const xdg = env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, ".local", "share");
  return p.join(xdg, APP_NAME);
}

export function resolveDataDir(arg: string | undefined, platform: Platform, env: NodeJS.ProcessEnv, home: string): string {
  const chosen = arg ?? (env[DATA_DIR_ENV] || undefined);
  return chosen ? pathFor(platform).resolve(chosen) : defaultDataDir(platform, env, home);
}

/** The data folder exists and only its user can enter it (design 6.5). Windows keeps the profile's own ACL. */
export async function ensureDataDir(dir: string, platform: Platform): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(dir, 0o700);
}

/**
 * The data folder's identity, which names its lock (D-261113-092): the
 * SHA-256 of its canonical path, with symlinks, junctions and short names
 * resolved, and case-folded where the usual file systems ignore case, so
 * every spelling of one folder gives one lock.
 */
export function dataIdentity(dir: string, platform: Platform, realpath: (p: string) => string = realpathSync.native): { canonical: string; hash: string } {
  const real = realpath(dir);
  const canonical = platform === "linux" ? real : real.toLowerCase();
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return { canonical, hash };
}

export type DataPaths = {
  root: string;
  postgres: string;
  assets: string;
  backups: string;
  logs: string;
  secrets: string;
  settings: string;
  settingsBad: string;
  journal: string;
  owner: string;
};

export function dataPaths(root: string): DataPaths {
  return {
    root,
    postgres: path.join(root, DATA_LAYOUT.postgres),
    assets: path.join(root, DATA_LAYOUT.assets),
    backups: path.join(root, DATA_LAYOUT.backups),
    logs: path.join(root, DATA_LAYOUT.logs),
    secrets: path.join(root, DATA_LAYOUT.secrets),
    settings: path.join(root, DATA_LAYOUT.settings),
    settingsBad: path.join(root, DATA_LAYOUT.settingsBad),
    journal: path.join(root, DATA_LAYOUT.restoreJournal),
    owner: path.join(root, DATA_LAYOUT.ownerRecord),
  };
}
