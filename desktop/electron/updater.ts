import { net } from "electron";
import { AppImageUpdater, NsisUpdater, type AppUpdater } from "electron-updater";
import type { BridgeResult, Platform, UpdateState } from "../contract.ts";
import { Installer } from "../shell/install.ts";
import type { ShellLog } from "../shell/log.ts";
import {
  LATEST_RELEASE_API,
  REPOSITORY,
  UPDATE_CHECK_INTERVAL_MS,
  clockOffsetMinutes,
  releaseOffer,
  updateSource,
  updaterErrorLevel,
  userAgent,
} from "../shell/updates.ts";

export type UpdateHooks = {
  platform: Platform;
  arch: string;
  version: string;
  env: Readonly<Record<string, string | undefined>>;
  log: ShellLog;
  setUpdate(state: UpdateState): void;
  setClockOffset(minutes: number | null): void;
  /** The supervisor's stopped report, for Install and restart (shell/install.ts). */
  stopSupervisor(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Called just before the installer takes over, so the app's own quit rules stand aside. */
  beforeInstall(): void;
};

/** Response headers' Date, whatever case the server sent it in. */
function dateHeader(headers: Record<string, string | string[]> | undefined): string | null {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "date") return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

/**
 * Update checks at start and once a day (design 8.4), and the clock check
 * that rides on them (design 7). Nothing here ever shows an error in the
 * window: a failed check is a log line, and the banner shows only an update.
 */
export class Updates {
  readonly #hooks: UpdateHooks;
  readonly #updater: AppUpdater | null;
  readonly #installer: Installer;
  #timer: ReturnType<typeof setInterval> | null = null;
  #available: string | null = null;
  #checking = false;

  constructor(hooks: UpdateHooks) {
    this.#hooks = hooks;
    this.#updater = updateSource(hooks.platform, hooks.env) === "updater" ? this.#makeUpdater() : null;
    this.#installer = new Installer({
      download: (onPercent) => this.#download(onPercent),
      stop: () => hooks.stopSupervisor(),
      quitAndInstall: () => {
        hooks.beforeInstall();
        // Silent, then start the new version: the installer itself quits
        // anything left of this one first (installer.nsh).
        this.#updater?.quitAndInstall(true, true);
      },
      setUpdate: (state) => hooks.setUpdate(state),
      log: (level, message) => hooks.log[level](message),
    });
  }

  /** Checks now, then every 24 h while `enabled()` says checks are on. */
  start(enabled: () => boolean): void {
    if (this.#timer) return;
    if (enabled()) void this.check();
    this.#timer = setInterval(() => {
      if (enabled()) void this.check();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async check(): Promise<void> {
    if (this.#checking || this.#installer.running) return;
    this.#checking = true;
    try {
      const version = this.#updater ? await this.#checkUpdater(this.#updater) : await this.#checkRelease();
      if (version === null) return;
      this.#available = version;
      this.#hooks.log.info(`RaccoonVTT ${version} is out`);
      this.#hooks.setUpdate({ state: "available", version, install: this.#updater !== null });
    } catch (error) {
      const level = updaterErrorLevel(error);
      this.#hooks.log[level](`update check: ${level === "info" ? "no update" : "failed"}: ${String(error).split("\n")[0]}`);
    } finally {
      this.#checking = false;
    }
  }

  /** Install and restart, where the app installs itself. Elsewhere the window's button is Download. */
  install(): Promise<BridgeResult> {
    if (!this.#updater || this.#available === null) return Promise.resolve({ ok: false, failure: { error: "failed", reason: "no update is ready to install here" } });
    return this.#installer.install(this.#available);
  }

  #makeUpdater(): AppUpdater {
    const options = { provider: "github" as const, owner: REPOSITORY.owner, repo: REPOSITORY.repo, releaseType: "release" as const };
    const updater = this.#hooks.platform === "win32" ? new NsisUpdater(options) : new AppImageUpdater(options);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    // The release ships no blockmaps (design 11.5), so a differential
    // download would only fetch a 404 first.
    updater.disableDifferentialDownload = true;
    updater.requestHeaders = { "User-Agent": userAgent(this.#hooks.version) };
    // electron-updater logs a missing feed as an error before it throws.
    // The check logs every failure itself, at the level the design gives it.
    updater.logger = {
      info: (message: unknown) => this.#hooks.log.info(`updater: ${String(message)}`),
      warn: (message: unknown) => this.#hooks.log.info(`updater: ${String(message)}`),
      error: () => {},
    };
    // electron-updater also emits each failure as an event, and an
    // EventEmitter with no listener for "error" would throw it again.
    updater.on("error", () => {});
    updater.netSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith("https://github.com/")) this.#clock(dateHeader(details.responseHeaders));
      callback({});
    });
    return updater;
  }

  async #checkUpdater(updater: AppUpdater): Promise<string | null> {
    const result = await updater.checkForUpdates();
    return result?.isUpdateAvailable ? result.updateInfo.version : null;
  }

  /** macOS and the deb: GitHub's latest release, offered when it carries this computer's asset. */
  async #checkRelease(): Promise<string | null> {
    const response = await net.fetch(LATEST_RELEASE_API, {
      headers: { "User-Agent": userAgent(this.#hooks.version), Accept: "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store",
    });
    this.#clock(response.headers.get("date"));
    // No release at all yet.
    if (response.status === 404) throw Object.assign(new Error(`HTTP 404 from ${LATEST_RELEASE_API}`), { statusCode: 404 });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${LATEST_RELEASE_API}`);
    return releaseOffer(await response.json(), this.#hooks.version, this.#hooks.platform, this.#hooks.arch);
  }

  async #download(onPercent: (percent: number) => void): Promise<void> {
    const updater = this.#updater;
    if (!updater) throw new Error("this install cannot update itself");
    const progress = (info: { percent: number }) => onPercent(info.percent);
    updater.on("download-progress", progress);
    try {
      await updater.downloadUpdate();
      onPercent(100);
    } finally {
      updater.off("download-progress", progress);
    }
  }

  #clock(header: string | null): void {
    if (header === null) return;
    this.#hooks.setClockOffset(clockOffsetMinutes(header, Date.now()));
  }
}
