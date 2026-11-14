import { z } from "zod";
import type { Platform } from "../contract.ts";

/**
 * Update checks (design 8.4): at start and once a day, on by default with a
 * switch, sending GitHub only the request and a `RaccoonVTT/X.Y.Z` user
 * agent. The repository's own address is public, so it is written here.
 */
export const REPOSITORY = { owner: "jwhitlow45", repo: "raccoon-vtt" } as const;
const GITHUB = `https://github.com/${REPOSITORY.owner}/${REPOSITORY.repo}`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY.owner}/${REPOSITORY.repo}/releases/latest`;
/** Where Download and Download the latest version go. */
export const LATEST_RELEASE_PAGE = `${GITHUB}/releases/latest`;
/** Every page the window may open in the browser, besides the app itself, starts with this. */
export const RELEASES_PAGE_PREFIX = `${GITHUB}/releases/`;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Source code: this version's tag on the release page, which offers its archive. */
export function sourcePage(version: string): string {
  return `${GITHUB}/releases/tag/v${version}`;
}

export function userAgent(version: string): string {
  return `RaccoonVTT/${version}`;
}

/**
 * How this install learns of a new version. Windows and the AppImage update
 * themselves through electron-updater's `latest.yml` and `latest-linux*.yml`.
 * macOS, unsigned, cannot install itself, and apt owns the deb, so those read
 * GitHub's `releases/latest` and offer Download (the release page).
 * electron-updater's own Linux default would pick its deb updater from the
 * packaged `package-type` file, so the choice is made here instead.
 */
export type UpdateSource = "updater" | "release";

export function updateSource(platform: Platform, env: Readonly<Record<string, string | undefined>>): UpdateSource {
  if (platform === "win32") return "updater";
  if (platform === "linux" && env.APPIMAGE) return "updater";
  return "release";
}

/**
 * The asset a release must carry for this computer to offer it, as the
 * release assets are named (design 11.5). A hosted-only release, or one whose
 * desktop assets are still uploading, has none and is no update.
 */
export function releaseAssetName(version: string, platform: Platform, arch: string): string | null {
  if (platform === "darwin") return `raccoon-vtt-${version}-macos-${arch === "arm64" ? "arm64" : "x64"}.dmg`;
  if (platform === "linux") return `raccoon-vtt_${version}_${arch === "arm64" ? "arm64" : "amd64"}.deb`;
  return null;
}

const LatestRelease = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(z.looseObject({ name: z.string() })),
});

/** A release tag's version: `v1.2.3` or `1.2.3`, never a prerelease (the updater refuses those too). */
export function tagVersion(tag: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(tag);
  return m?.[1] ?? null;
}

/**
 * Compares two versions. A prerelease of a version comes before it, as
 * semver orders them, and two prereleases of one version compare equal,
 * which is enough here since releases are never prereleases.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], boolean] => {
    const [main = "", pre] = v.split("-", 2);
    return [main.split(".").map((n) => Number(n)), pre !== undefined];
  };
  const [am, apre] = parse(a);
  const [bm, bpre] = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (am[i] ?? 0) - (bm[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return apre === bpre ? 0 : apre ? -1 : 1;
}

/**
 * The version GitHub's `releases/latest` offers this computer, or null: a
 * draft, a prerelease, a version not newer than this one, a downgrade, and a
 * release without this computer's asset are all no update. Anything that
 * does not parse as a release throws, which the caller logs as an error.
 */
export function releaseOffer(json: unknown, current: string, platform: Platform, arch: string): string | null {
  const release = LatestRelease.parse(json);
  if (release.draft || release.prerelease) return null;
  const version = tagVersion(release.tag_name);
  if (!version || compareVersions(version, current) <= 0) return null;
  const asset = releaseAssetName(version, platform, arch);
  if (!asset || !release.assets.some((a) => a.name === asset)) return null;
  return version;
}

/**
 * How an electron-updater failure is logged. A release with no desktop
 * assets yet, a missing feed file and a 404 are the normal state between a
 * release and its desktop upload, or of a repository with no release, so
 * they read as no update, logged at info. Anything else, a network or parse
 * failure, logs as an error. Neither shows in the window (design 8.4).
 */
export function updaterErrorLevel(error: unknown): "info" | "error" {
  if (typeof error !== "object" || error === null) return "error";
  const e = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (e.statusCode === 404) return "info";
  const message = typeof e.message === "string" ? e.message : "";
  switch (e.code) {
    case "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND":
    case "ERR_UPDATER_NO_PUBLISHED_VERSIONS":
    case "ERR_UPDATER_ASSET_NOT_FOUND":
      return "info";
    case "ERR_UPDATER_LATEST_VERSION_NOT_FOUND":
      // This code wraps every failure to read the latest tag, the network's
      // included, so only the 404 inside it means "no release".
      return /\b404\b/.test(message) ? "info" : "error";
    default:
      return "error";
  }
}

/** The clock check's limit (design 7): past it, the window warns. */
export const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * How many whole minutes this computer's clock is off from a response's
 * `Date` header, or null when it is within 2 minutes or the header is
 * missing or unreadable.
 */
export function clockOffsetMinutes(dateHeader: string | null | undefined, nowMs: number): number | null {
  if (!dateHeader) return null;
  const server = Date.parse(dateHeader);
  if (Number.isNaN(server)) return null;
  const off = Math.abs(nowMs - server);
  return off > CLOCK_TOLERANCE_MS ? Math.round(off / 60_000) : null;
}
