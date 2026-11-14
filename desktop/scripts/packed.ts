import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { APP_NAME, RESOURCES, type Platform } from "../contract.ts";

/**
 * What desktop/build/pack.ts checks once electron-builder has packed the
 * app: every file of the runtime and the staged server reached the app's
 * resources folder. electron-builder's copy of `extraResources` drops a
 * `node_modules` folder at the top of any `from`, whatever the filter says
 * (app-builder-lib's util/filter.ts), and once left the server without its
 * packages. Inside the repository that went unseen, since Node found the
 * packages in the repository's own node_modules above the build.
 */

/** The staged server as electron-builder entries: its node_modules goes in as an entry of its own, so electron-builder's rule above never drops it. */
export function stagedResources(stage: string): { from: string; to: string }[] {
  return [
    { from: stage, to: RESOURCES.appServer },
    { from: path.join(stage, "node_modules"), to: `${RESOURCES.appServer}/node_modules` },
  ];
}

/**
 * The resources folder of the app electron-builder leaves unpacked in
 * `dist`, for this platform and architecture, by electron-builder's own
 * folder names (`mac-arm64`, `win-unpacked`, `linux-arm64-unpacked`).
 */
export function packedResources(dist: string, platform: Platform, arch: string): string {
  if (platform === "darwin") return path.join(dist, arch === "x64" ? "mac" : `mac-${arch}`, `${APP_NAME}.app`, "Contents", "Resources");
  const os = platform === "win32" ? "win" : "linux";
  return path.join(dist, arch === "x64" ? `${os}-unpacked` : `${os}-${arch}-unpacked`, "resources");
}

/** Git's empty folder placeholders, which some packages ship. electron-builder never copies them, and nothing reads them. */
const NEVER_PACKED = new Set([".gitkeep"]);

/** Every file under `dir`, by its path from `dir` with forward slashes. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && !NEVER_PACKED.has(e.name))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
}

/** The files under `from` that are not under `to` by the same path, sorted, leaving out NEVER_PACKED. */
export function filesMissing(from: string, to: string): string[] {
  if (!existsSync(to)) return filesUnder(from).toSorted();
  return filesUnder(from)
    .filter((rel) => !existsSync(path.join(to, rel)))
    .toSorted();
}
