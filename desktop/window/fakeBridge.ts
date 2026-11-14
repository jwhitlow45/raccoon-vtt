import type { BackupSummary, BridgeResult, CommandFailure, RaccoonLocal, RoomSummary, SettingsPatch, SupervisorStatus, WindowState } from "../contract.ts";
import { scenario, type Scenario } from "./scenarios.ts";

/**
 * `window.raccoonLocal` for development and tests (design 12, LOCAL-5): the
 * page runs in a plain browser against this, with every state a scenario
 * names. It answers as the shell would, restarts included, and keeps a log
 * of every call. A test drives it through `window.fakeBridge`:
 * - `set(state)` replaces the state, as a new status from the supervisor does.
 * - `patchSupervisor(patch)` merges into the supervisor's status.
 * - `hold(method)` makes the next call of that method wait until `release(method)`,
 *   which is how a test sees a button busy.
 * - `fail(method, failure)` makes the next call of that method fail.
 * - `delayMs` slows every call, and `stepMs` the restart steps the fake runs.
 */

export type FakeBridge = {
  bridge: RaccoonLocal;
  state(): WindowState;
  set(state: WindowState): void;
  patchSupervisor(patch: Partial<SupervisorStatus>): void;
  patchShell(patch: Partial<WindowState["shell"]>): void;
  setRooms(rooms: RoomSummary[]): void;
  setBackups(backups: BackupSummary[]): void;
  hold(method: string): void;
  release(method: string): void;
  fail(method: string, failure: CommandFailure): void;
  calls: { method: string; args: unknown[] }[];
  delayMs: number;
  stepMs: number;
};

const OK: BridgeResult = { ok: true, value: {} };

export function createFakeBridge(initial: Scenario, opts: { delayMs?: number; stepMs?: number } = {}): FakeBridge {
  let state = initial.state;
  let rooms = initial.rooms;
  let backups = initial.backups;
  const listeners = new Set<(s: WindowState) => void>();
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
  const failures = new Map<string, CommandFailure>();
  const calls: FakeBridge["calls"] = [];
  const self: FakeBridge = {
    bridge: undefined as unknown as RaccoonLocal,
    state: () => state,
    set(next) {
      state = next;
      for (const l of listeners) l(state);
    },
    patchSupervisor(patch) {
      if (!state.supervisor) return;
      self.set({ ...state, supervisor: { ...state.supervisor, ...patch } });
    },
    patchShell(patch) {
      self.set({ ...state, shell: { ...state.shell, ...patch } });
    },
    setRooms(next) {
      rooms = next;
    },
    setBackups(next) {
      backups = next;
    },
    hold(method) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      holds.set(method, { promise, release });
    },
    release(method) {
      holds.get(method)?.release();
      holds.delete(method);
    },
    fail(method, failure) {
      failures.set(method, failure);
    },
    calls,
    delayMs: opts.delayMs ?? 0,
    stepMs: opts.stepMs ?? 250,
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** Logs the call, waits for a hold and the delay, and returns a queued failure if a test set one. */
  async function enter(method: string, args: unknown[]): Promise<CommandFailure | null> {
    calls.push({ method, args });
    const held = holds.get(method);
    if (held) await held.promise;
    if (self.delayMs > 0) await sleep(self.delayMs);
    const failure = failures.get(method) ?? null;
    failures.delete(method);
    return failure;
  }
  const refuse = (failure: CommandFailure): BridgeResult<never> => ({ ok: false, failure });
  const sup = () => state.supervisor!;

  /** A restart: the step shows for `stepMs`, then the server is back with what changed. */
  async function restart(step: "openToNetwork" | "closeToNetwork" | "changePort", after: Partial<SupervisorStatus>): Promise<void> {
    self.patchSupervisor({ state: "restarting", step });
    await sleep(self.stepMs);
    self.patchSupervisor({ state: "running", step: "running", ...after });
  }

  self.bridge = {
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => void listeners.delete(listener);
    },
    async setNetworkPlay(on) {
      const f = await enter("setNetworkPlay", [on]);
      if (f) return refuse(f);
      const s = sup();
      void restart(on ? "openToNetwork" : "closeToNetwork", {
        settings: { ...s.settings, networkPlay: on },
        network: on ? "open" : "off",
        host: on ? "0.0.0.0" : "127.0.0.1",
        shareOrigin: on ? "http://10.0.0.20:3170" : null,
      });
      return OK;
    },
    async setPort(port) {
      const f = await enter("setPort", [port]);
      if (f) return refuse(f);
      const s = sup();
      void restart("changePort", { port, settings: { ...s.settings, port }, shareOrigin: s.shareOrigin ? `http://10.0.0.20:${port}` : null, error: null });
      return OK;
    },
    async setSettings(patch: SettingsPatch) {
      const f = await enter("setSettings", [patch]);
      if (f) return refuse(f);
      self.patchSupervisor({ settings: { ...sup().settings, ...patch } });
      return OK;
    },
    async backupNow() {
      const f = await enter("backupNow", []);
      if (f) return refuse(f);
      self.patchSupervisor({ backingUp: true });
      await sleep(self.stepMs);
      const now = new Date().toISOString();
      backups = [{ name: `raccoon-2026-11-13-${String(backups.length).padStart(6, "0")}-eeeeeeee`, started: now, finished: now, kind: "manual", readable: true }, ...backups];
      self.patchSupervisor({ backingUp: false, lastBackup: now });
      return OK;
    },
    async listBackups() {
      const f = await enter("listBackups", []);
      if (f) return refuse(f);
      return { ok: true, value: { backups } };
    },
    async restore(backup) {
      const f = await enter("restore", [backup]);
      if (f) return refuse(f);
      void (async () => {
        for (const restore of ["stopping", "images", "database", "starting"] as const) {
          self.patchSupervisor({ state: "restoring", step: "finishRestore", restore, notice: null });
          await sleep(self.stepMs);
        }
        const found = backups.find((b) => b.name === backup);
        self.patchSupervisor({ state: "running", step: "running", restore: null, notice: { seq: (sup().notice?.seq ?? 0) + 1, kind: "restored", backupStarted: found?.started ?? new Date().toISOString() } });
      })();
      return OK;
    },
    async listRooms() {
      const f = await enter("listRooms", []);
      if (f) return refuse(f);
      return { ok: true, value: { rooms } };
    },
    async newDmLink(roomId) {
      const f = await enter("newDmLink", [roomId]);
      return f ? refuse(f) : OK;
    },
    async retry() {
      const f = await enter("retry", []);
      if (f) return refuse(f);
      self.set({ shell: { ...state.shell, error: null }, supervisor: state.supervisor && { ...state.supervisor, error: null, state: "running", step: "running", port: 3170, host: "0.0.0.0" } });
      return OK;
    },
    async startWithoutBackup() {
      const f = await enter("startWithoutBackup", []);
      if (f) return refuse(f);
      self.patchSupervisor({ error: null, state: "running", step: "running", port: 3170, host: "0.0.0.0" });
      return OK;
    },
    async deleteGuard() {
      const f = await enter("deleteGuard", []);
      if (f) return refuse(f);
      self.set({ ...state, shell: { ...state.shell, error: null } });
      return OK;
    },
    async openApp() {
      await enter("openApp", []);
    },
    async openFolder(folder) {
      await enter("openFolder", [folder]);
    },
    async openRelease() {
      await enter("openRelease", []);
    },
    async openSource() {
      await enter("openSource", []);
    },
    async installUpdate() {
      const f = await enter("installUpdate", []);
      if (f) return refuse(f);
      const update = state.shell.update;
      if (update.state === "available") self.patchShell({ update: { state: "stopping", version: update.version } });
      return OK;
    },
    async copyText(text) {
      await enter("copyText", [text]);
    },
    async quit() {
      await enter("quit", []);
    },
  };
  return self;
}

declare global {
  interface Window {
    fakeBridge?: FakeBridge;
  }
}

/** The fake for the page's address: `?scenario=<name>&platform=linux&delay=<ms>&step=<ms>`. */
export function fakeFromLocation(search: string): FakeBridge {
  const q = new URLSearchParams(search);
  const platform = q.get("platform");
  const fake = createFakeBridge(scenario(q.get("scenario") ?? "running", Date.now(), platform === "linux" || platform === "darwin" || platform === "win32" ? platform : undefined), {
    delayMs: Number(q.get("delay") ?? 0),
    stepMs: Number(q.get("step") ?? 250),
  });
  return fake;
}
