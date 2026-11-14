import type { BridgeResult, UpdateState } from "../contract.ts";

/**
 * Install and restart (design 8.4), where the app installs itself: download,
 * stop the supervisor and wait for its stopped report (the app server closed,
 * PostgreSQL shut down cleanly), and only then hand over to the installer.
 * Starting the installer any earlier would have it end a database that is
 * still writing, which PostgreSQL survives but which costs a recovery.
 */
export type InstallSteps = {
  /** electron-updater's download, reporting whole percents. Rejects on failure. */
  download(onPercent: (percent: number) => void): Promise<void>;
  /** The supervisor's `stop` command: resolves once it reports stopped, or with the reason it did not. */
  stop(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** electron-updater's quitAndInstall, which quits the app. */
  quitAndInstall(): void;
  setUpdate(state: UpdateState): void;
  log(level: "info" | "error", message: string): void;
};

export class Installer {
  readonly #steps: InstallSteps;
  #running = false;

  constructor(steps: InstallSteps) {
    this.#steps = steps;
  }

  get running(): boolean {
    return this.#running;
  }

  async install(version: string): Promise<BridgeResult> {
    if (this.#running) return { ok: false, failure: { error: "busy" } };
    this.#running = true;
    const steps = this.#steps;
    try {
      let shown = 0;
      steps.setUpdate({ state: "downloading", version, percent: shown });
      try {
        await steps.download((raw) => {
          const percent = Math.max(0, Math.min(100, Math.floor(raw)));
          if (percent === shown) return;
          shown = percent;
          steps.setUpdate({ state: "downloading", version, percent });
        });
      } catch (error) {
        steps.log("error", `update ${version} download failed: ${String(error)}`);
        steps.setUpdate({ state: "available", version, install: true });
        return { ok: false, failure: { error: "failed", reason: "the download did not finish" } };
      }
      steps.setUpdate({ state: "stopping", version });
      const stopped = await steps.stop();
      if (!stopped.ok) {
        steps.log("error", `update ${version} not installed: the supervisor did not stop: ${stopped.reason}`);
        steps.setUpdate({ state: "available", version, install: true });
        return { ok: false, failure: { error: "failed", reason: stopped.reason } };
      }
      steps.log("info", `installing update ${version}`);
      steps.quitAndInstall();
      return { ok: true, value: {} };
    } finally {
      this.#running = false;
    }
  }
}
