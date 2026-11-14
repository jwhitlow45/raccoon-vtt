import {
  DEFAULT_PORT,
  backupNameTime,
  type AppError,
  type BackupKind,
  type BackupRecord,
  type BackupSummary,
  type Command,
  type CommandFailure,
  type NetworkReach,
  type Notice,
  type Platform,
  type RestoreStep,
  type RoomSummary,
  type ServerHost,
  type Settings,
  type StatusStep,
  type SupervisorState,
  type SupervisorStatus,
  type VersionStamp,
} from "../contract.ts";
import type { ServerExit, ServerHandle } from "./appServer.ts";
import type { BackupResult, StoredBackup } from "./backup.ts";
import type { Clock, Timer } from "./clock.ts";
import type { LockFailure } from "./lock.ts";
import type { Leftover } from "./postgres.ts";
import type { RecoveryResult, Refusal, RestoreOutcome } from "./restore.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { judge, readable, type Build } from "./versionGuard.ts";

/**
 * The supervisor's states and their order (docs/design/design-v1-local-app.md
 * 10): take the lock, deal with a PostgreSQL left running, start it, finish
 * or undo an interrupted restore, check the data's version, back up before
 * an update, then run the app server, restarting it after a crash, and
 * stop it all cleanly when asked or when the shell goes away.
 *
 * Everything that changes what runs (a start, a restart, a restore, a
 * stop) goes through one queue, so no two of them overlap: there is never
 * a second app server, and never a restore while one runs. Backups run
 * beside the server, but never beside a restore. Every part that touches
 * the computer is a port in `SupervisorDeps`, so the randomized test runs
 * this same code over many event orders in fake time.
 */

export type NetworkReading = { reach: NetworkReach; host: ServerHost; share: string | null; others: string[] };

export type SupervisorDeps = {
  clock: Clock;
  platform: Platform;
  /** This build. Its PostgreSQL major is read from the bundled programs at the first start. */
  build: Omit<Build, "pgMajor">;
  paths: { data: string; backups: string; logs: string };
  log(msg: string): void;
  /** `--port` and `--network`, for this run only. */
  overrides: { port?: number; networkPlay?: boolean };
  isRoot(): boolean;
  lock: {
    acquire(): Promise<{ ok: true } | { ok: false; error: LockFailure }>;
    release(): Promise<void>;
    deleteGuard(path: string): Promise<void>;
  };
  settings: { load(): Promise<Settings>; save(settings: Settings): Promise<void> };
  pg: {
    bundledMajor(): Promise<number>;
    dataMajor(): Promise<number | null>;
    needsInit(): boolean;
    init(): Promise<void>;
    leftover(): Promise<Leftover>;
    clearLeftover(found: Leftover): Promise<void>;
    /** Throws an error with `logLine` when the database does not start. */
    start(): Promise<void>;
    stop(): Promise<void>;
    alive(): Promise<boolean>;
  };
  db: {
    /** Opens the pool to `raccoon`, creating the database first on a new cluster. */
    open(create: boolean): Promise<void>;
    close(): Promise<void>;
    readStamp(): Promise<VersionStamp | null>;
    roomsEmpty(): Promise<boolean>;
    writeStamp(build: Build): Promise<void>;
  };
  restore: {
    pending(): Promise<boolean>;
    recover(build: Build): Promise<RecoveryResult>;
    check(build: Build, name: string): Promise<{ ok: true; record: BackupRecord; list: string[] } | { ok: false; refusal: Refusal }>;
    run(build: Build, name: string, checked: { record: BackupRecord; list: string[] }, onStep: (step: "images" | "database") => void): Promise<RestoreOutcome>;
  };
  backups: { run(kind: BackupKind, forVersion?: string): Promise<BackupResult>; list(): Promise<StoredBackup[]> };
  server: {
    start(host: ServerHost, port: number): ServerHandle;
    healthy(port: number, handle: ServerHandle): Promise<boolean>;
    lastLogLine(): Promise<string>;
  };
  network: {
    start(onChange: () => void): void;
    stop(): void;
    /** Windows waits up to 10 s for the first profile sample, so a normal start binds once. */
    firstSample(): Promise<void>;
    read(networkPlay: boolean): Promise<NetworkReading>;
    firewallRule(): Promise<"present" | "missing" | null>;
  };
  ports: { free(port: number): Promise<boolean>; firstFree(from: number): Promise<number | null> };
  rooms: { list(port: number): Promise<RoomSummary[]>; newDmLink(port: number, roomId: string): Promise<string> };
  emit(status: SupervisorStatus): void;
};

export type CommandOutcome = { ok: true; value: unknown } | { ok: false; failure: CommandFailure };

/** A crash restarts the server after these waits, then the start ends in an error (design 10). */
export const CRASH_RESTART_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/** A server that has run this long has its crash count forgiven. */
export const CRASH_FORGIVE_MS = 60_000;
/** How often the daily backup, PostgreSQL's health and the addresses are looked at. */
export const BACKUP_CHECK_MS = 60 * 60 * 1000;
export const DAILY_MS = 24 * 60 * 60 * 1000;
export const PG_WATCH_MS = 5_000;
export const ADDRESS_WATCH_MS = 5_000;
/** A port held by a server that is still shutting down (an older supervisor's) is waited on this long. */
export const PORT_WAIT_MS = 5_000;

class Halt extends Error {}

/** A notice without its number, which setNotice gives it. */
type NoticeBody = Notice extends infer N ? (N extends Notice ? Omit<N, "seq"> : never) : never;

const ok = (value: unknown = {}): CommandOutcome => ({ ok: true, value });
const refuse = (failure: CommandFailure): CommandOutcome => ({ ok: false, failure });

export class Supervisor {
  private readonly d: SupervisorDeps;
  private build: Build | null = null;

  private state: SupervisorState = "stopped";
  private step: StatusStep | null = null;
  private error: AppError | null = null;
  private notice: Notice | null = null;
  private noticeSeq = 0;
  private settings: Settings | null = null;
  private port: number | null = null;
  private host: ServerHost | null = null;
  private net: NetworkReading = { reach: "off", host: "127.0.0.1", share: null, others: [] };
  private firewall: "present" | "missing" | null = null;
  private sockets = 0;
  private remoteDevices = 0;
  private backingUp = false;
  private lastBackup: string | null = null;
  private restoreStep: RestoreStep | null = null;
  private lastEmitted = "";

  private lockHeld = false;
  private pgUp = false;
  private dbOpen = false;
  private networkStarted = false;
  private firstSampleWaited = false;
  private skipBeforeUpdateBackup = false;
  private server: ServerHandle | null = null;
  private healthyAt = 0;
  private crashes = 0;
  private crashTimer: Timer | null = null;
  private backupTimer: Timer | null = null;
  private pgTimer: Timer | null = null;
  private addressTimer: Timer | null = null;
  private restoring = false;
  private justRestored = false;
  private job: Promise<unknown> | null = null;
  private jobKind: "backup" | "restore" | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;

  constructor(deps: SupervisorDeps) {
    this.d = deps;
  }

  // -------------------------------------------------------------------------
  // Status

  status(): SupervisorStatus {
    return {
      state: this.state,
      step: this.step,
      appVersion: this.d.build.app,
      settings: { ...(this.settings ?? DEFAULT_SETTINGS), networkPlay: this.networkPlay(), ...(this.d.overrides.port ? { port: this.d.overrides.port } : {}) },
      port: this.port,
      host: this.host,
      network: this.net.reach,
      shareOrigin: this.net.reach === "open" && this.net.share !== null && this.port !== null ? `http://${this.net.share}:${this.port}` : null,
      otherAddresses: this.net.others,
      firewallRule: this.firewall,
      sockets: this.sockets,
      remoteDevices: this.remoteDevices,
      backingUp: this.backingUp,
      lastBackup: this.lastBackup,
      restore: this.restoreStep,
      error: this.error,
      notice: this.notice,
      paths: this.d.paths,
    };
  }

  private emit(): void {
    const status = this.status();
    const text = JSON.stringify(status);
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.d.emit(status);
  }

  private set(state: SupervisorState, step: StatusStep | null): void {
    this.state = state;
    this.step = step;
    if (state !== "error") this.error = null;
    this.emit();
  }

  /** Ends the current start in an error the window explains. The supervisor stays up for the DM's answer. */
  private report(error: AppError): void {
    this.d.log(`stopped: ${error.kind}`);
    this.state = "error";
    this.step = null;
    this.error = error;
    this.emit();
  }

  private fail(error: AppError): never {
    this.report(error);
    throw new Halt(error.kind);
  }

  private setNotice(notice: NoticeBody): void {
    this.noticeSeq++;
    this.notice = { ...notice, seq: this.noticeSeq } as Notice;
    this.emit();
  }

  private networkPlay(): boolean {
    return this.d.overrides.networkPlay ?? this.settings?.networkPlay ?? true;
  }

  // -------------------------------------------------------------------------
  // The queue

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The start, from wherever things are: every part already done is skipped. */
  start(): Promise<void> {
    return this.enqueue(() => this.boot());
  }

  private async boot(): Promise<void> {
    // A restart that something else already did (a crash timer that fired
    // just before a restore started the server again) has nothing to do.
    if (this.stopping || (this.server && this.pgUp && this.dbOpen && this.lockHeld)) return;
    try {
      await this.bootSteps();
    } catch (err) {
      if (err instanceof Halt) return;
      this.d.log(`start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.report({ kind: "databaseFailed", logLine: err instanceof Error ? err.message : String(err) });
    }
  }

  private async bootSteps(): Promise<void> {
    if (this.restoreStep === null) this.set("starting", null);
    if (this.d.isRoot()) this.fail({ kind: "root" });
    if (!this.lockHeld) {
      const lock = await this.d.lock.acquire();
      if (!lock.ok) this.fail(lock.error);
      this.lockHeld = true;
    }
    this.settings ??= await this.d.settings.load();
    if (!this.networkStarted) {
      this.networkStarted = true;
      this.d.network.start(() => void this.enqueue(() => this.networkChanged()));
      this.firewall = await this.d.network.firewallRule();
    }
    if (!this.build) this.build = { ...this.d.build, pgMajor: await this.d.pg.bundledMajor() };
    const build = this.build;

    if (!this.pgUp) {
      const dataMajor = await this.d.pg.dataMajor();
      if (dataMajor !== null && dataMajor !== build.pgMajor) this.fail({ kind: "pgMajor", dataMajor, bundledMajor: build.pgMajor });
      const left = await this.d.pg.leftover();
      if (left.kind !== "none") {
        this.set("recovering", null);
        await this.d.pg.clearLeftover(left);
      }
      if (this.d.pg.needsInit()) {
        this.set("starting", "initdb");
        await this.d.pg.init();
      }
      this.set("starting", "startDatabase");
      try {
        await this.d.pg.start();
      } catch (err) {
        this.fail({ kind: "databaseFailed", logLine: (err as { logLine?: string }).logLine ?? (err as Error).message });
      }
      this.pgUp = true;
      this.watchPostgres();
    }

    if (!this.dbOpen) {
      if (await this.d.restore.pending()) this.set("recovering", "finishRestore");
      const rec = await this.d.restore.recover(build);
      if (rec.tangled) this.fail({ kind: "restoreTangled" });
      if (rec.notice && !(this.justRestored && rec.notice === "restoreFinished")) {
        const started = rec.backup ? backupNameTime(rec.backup) : null;
        if (rec.notice === "restoreFinished" && started) this.setNotice({ kind: "restoreFinished", backupStarted: started });
        else this.setNotice({ kind: "restoreInterrupted" });
      }
      this.justRestored = false;
      await this.d.db.open(rec.createLive);
      this.dbOpen = true;
      await this.refreshLastBackup();
    }

    if (!this.server) {
      await this.versionChecks(build);
      await this.startServer("startServer");
    }
  }

  private async versionChecks(build: Build): Promise<void> {
    const verdict = judge(await this.d.db.readStamp(), await this.d.db.roomsEmpty(), build);
    if (verdict.kind === "noStamp") this.fail({ kind: "noStamp" });
    if (verdict.kind === "newer") {
      const any = (await this.d.backups.list()).some((b) => readable(b.record, build));
      this.fail(any ? { kind: "newerData", dataApp: verdict.dataApp } : { kind: "noReadableBackup", dataApp: verdict.dataApp });
    }
    if (verdict.kind === "update" && !this.skipBeforeUpdateBackup) {
      this.set("starting", "backupBeforeUpdate");
      const result = await this.exclusive("backup", () => this.d.backups.run("before-update", build.app));
      await this.refreshLastBackup();
      if (result.outcome !== "good") this.fail({ kind: "backupBeforeUpdateFailed", reason: result.reason });
    }
    this.skipBeforeUpdateBackup = false;
  }

  private async startServer(step: StatusStep): Promise<void> {
    const build = this.build as Build;
    const settings = this.settings as Settings;
    let port = this.d.overrides.port ?? settings.port;
    if (port === undefined) {
      const first = await this.d.ports.firstFree(DEFAULT_PORT);
      if (first === null) this.fail({ kind: "databaseFailed", logLine: "no free port from 3170 up" });
      port = first;
      this.settings = { ...settings, port };
      await this.d.settings.save(this.settings);
    }
    if (!(await this.waitPortFree(port))) {
      const next = (await this.d.ports.firstFree(port + 1)) ?? port;
      this.port = null;
      this.fail({ kind: "portInUse", port, next });
    }
    this.net = await this.d.network.read(this.networkPlay());
    if (this.d.platform === "win32" && !this.firstSampleWaited) {
      this.firstSampleWaited = true;
      await this.d.network.firstSample();
      this.net = await this.d.network.read(this.networkPlay());
    }
    // Every server start writes this build's stamp first, in its own commit:
    // a running server may move rooms to its formats as they load (design 8.4).
    await this.d.db.writeStamp(build);
    this.set(step === "startServer" ? "starting" : "restarting", step);
    this.port = port;
    const handle = this.d.server.start(this.net.host, port);
    this.server = handle;
    this.host = this.net.host;
    handle.onStatus((s) => {
      if (this.server !== handle) return;
      this.sockets = s.sockets;
      this.remoteDevices = s.remoteDevices;
      this.emit();
    });
    void handle.exited.then((exit) => this.serverExited(handle, exit));
    const healthy = await this.d.server.healthy(port, handle);
    if (this.server !== handle) return;
    if (!healthy) {
      this.d.log("the app server did not answer /healthz");
      await handle.stop();
      return;
    }
    this.healthyAt = this.d.clock.now();
    this.set("running", "running");
    this.scheduleBackupCheck(0);
    this.watchAddresses();
  }

  private async waitPortFree(port: number): Promise<boolean> {
    const deadline = this.d.clock.now() + PORT_WAIT_MS;
    for (;;) {
      if (await this.d.ports.free(port)) return true;
      if (this.d.clock.now() >= deadline) return false;
      await this.d.clock.sleep(500);
    }
  }

  /** Stops the app server on purpose: its exit is then no crash. */
  private async stopServer(): Promise<void> {
    const handle = this.server;
    if (!handle) return;
    this.server = null;
    this.host = null;
    this.sockets = 0;
    this.remoteDevices = 0;
    await handle.stop();
    this.emit();
  }

  private serverExited(handle: ServerHandle, exit: ServerExit): void {
    if (this.server !== handle) return;
    this.server = null;
    this.host = null;
    this.sockets = 0;
    this.remoteDevices = 0;
    if (this.stopping) return;
    if (this.healthyAt > 0 && this.d.clock.now() - this.healthyAt >= CRASH_FORGIVE_MS) this.crashes = 0;
    this.healthyAt = 0;
    this.crashes++;
    this.d.log(`the app server exited (code ${exit.code}, signal ${exit.signal}), crash ${this.crashes}`);
    const delay = CRASH_RESTART_MS[this.crashes - 1];
    if (delay === undefined) {
      void this.enqueue(async () => {
        if (this.stopping || this.server) return;
        this.report({ kind: "serverCrashed", logLine: await this.d.server.lastLogLine() });
      });
      return;
    }
    this.set("restarting", "startServer");
    this.crashTimer = this.d.clock.setTimeout(() => {
      this.crashTimer = null;
      void this.enqueue(() => this.boot());
    }, delay);
  }

  private watchPostgres(): void {
    this.pgTimer?.cancel();
    this.pgTimer = this.d.clock.setTimeout(async () => {
      if (this.stopping || !this.pgUp) return;
      if (!this.restoring && !(await this.d.pg.alive())) {
        this.d.log("PostgreSQL stopped on its own");
        void this.enqueue(() => this.postgresCrashed());
        return;
      }
      this.watchPostgres();
    }, PG_WATCH_MS);
  }

  /** The server stopped, PostgreSQL started again, the server restarted (design 14). */
  private async postgresCrashed(): Promise<void> {
    if (this.stopping) return;
    await this.stopServer();
    await this.closeDb();
    this.pgUp = false;
    await this.boot();
  }

  private watchAddresses(): void {
    this.addressTimer?.cancel();
    this.addressTimer = this.d.clock.setTimeout(() => {
      if (this.stopping) return;
      void this.enqueue(() => this.networkChanged());
      this.watchAddresses();
    }, ADDRESS_WATCH_MS);
  }

  /** A new address, a new Windows profile or a silent watcher: the status follows, and the bind when it must. */
  private async networkChanged(): Promise<void> {
    if (this.stopping || !this.settings) return;
    this.net = await this.d.network.read(this.networkPlay());
    this.emit();
    if (this.server && this.state === "running" && this.net.host !== this.host) await this.restartServer(this.net.host === "0.0.0.0" ? "openToNetwork" : "closeToNetwork");
  }

  private async restartServer(step: StatusStep): Promise<void> {
    if (this.stopping || this.restoring) return;
    await this.stopServer();
    try {
      await this.startServer(step);
    } catch (err) {
      if (!(err instanceof Halt)) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Backups and restore

  /** Backups and restores never overlap. A restore waits for a backup to end. */
  private async exclusive<T>(kind: "backup" | "restore", work: () => Promise<T>): Promise<T> {
    while (this.job) await this.job.catch(() => undefined);
    this.jobKind = kind;
    if (kind === "backup") {
      this.backingUp = true;
      this.emit();
    }
    const run = work();
    this.job = run;
    try {
      return await run;
    } finally {
      this.job = null;
      this.jobKind = null;
      if (kind === "backup") {
        this.backingUp = false;
        this.emit();
      }
    }
  }

  private async refreshLastBackup(): Promise<void> {
    const newest = (await this.d.backups.list()).at(-1);
    this.lastBackup = newest?.record.started ?? null;
    this.emit();
  }

  private scheduleBackupCheck(ms: number): void {
    this.backupTimer?.cancel();
    this.backupTimer = this.d.clock.setTimeout(() => void this.dailyBackup(), ms);
  }

  private async dailyBackup(): Promise<void> {
    if (this.stopping) return;
    try {
      const due = this.lastBackup === null || this.d.clock.now() - Date.parse(this.lastBackup) > DAILY_MS;
      if (due && this.dbOpen && !this.restoring && !this.job) {
        const result = await this.exclusive("backup", () => this.d.backups.run("daily"));
        if (result.outcome !== "good") this.d.log(`the daily backup did not finish well: ${result.reason}`);
        await this.refreshLastBackup();
      }
    } catch (err) {
      this.d.log(`the daily backup failed: ${(err as Error).message}`);
    }
    if (!this.stopping) this.scheduleBackupCheck(BACKUP_CHECK_MS);
  }

  private async closeDb(): Promise<void> {
    if (!this.dbOpen) return;
    this.dbOpen = false;
    await this.d.db.close();
  }

  private async restore(name: string, checked: { record: BackupRecord; list: string[] }): Promise<void> {
    // A stop that came in while the backup was being checked runs first, and a restore after it has nothing to run on.
    if (this.stopping) {
      this.restoring = false;
      return;
    }
    const build = this.build as Build;
    this.restoring = true;
    try {
      await this.exclusive("restore", async () => {
        this.crashTimer?.cancel();
        this.crashTimer = null;
        this.restoreStep = "stopping";
        this.set("restoring", null);
        // Step 2: the server stays stopped to the end, so nothing moves an image to the trash in between.
        await this.stopServer();
        await this.closeDb();
        const outcome = await this.d.restore.run(build, name, checked, (step) => {
          this.restoreStep = step;
          this.emit();
        });
        const started = backupNameTime(name) ?? checked.record.started;
        if (outcome.ok) {
          this.justRestored = true;
          this.setNotice({ kind: "restored", backupStarted: started });
        } else this.setNotice({ kind: "restoreFailed", reason: outcome.reason });
        this.restoreStep = "starting";
        this.emit();
      });
    } catch (err) {
      this.d.log(`the restore stopped: ${(err as Error).message}`);
      this.setNotice({ kind: "restoreFailed", reason: (err as Error).message });
      this.restoreStep = "starting";
    } finally {
      this.restoring = false;
    }
    this.crashes = 0;
    await this.boot();
    this.restoreStep = null;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Commands

  async command(cmd: Command): Promise<CommandOutcome> {
    try {
      return await this.commandInner(cmd);
    } catch (err) {
      return refuse({ error: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  private async commandInner(cmd: Command): Promise<CommandOutcome> {
    if (cmd.type === "stop") {
      await this.stop();
      return ok();
    }
    if (this.stopping) return refuse({ error: "notRunning" });
    switch (cmd.type) {
      case "setSettings": {
        if (!this.settings) this.settings = await this.d.settings.load();
        this.settings = { ...this.settings, ...cmd.patch };
        await this.d.settings.save(this.settings);
        this.emit();
        return ok();
      }
      case "setNetworkPlay":
        return this.enqueue(async () => {
          if (!this.settings) this.settings = await this.d.settings.load();
          this.settings = { ...this.settings, networkPlay: cmd.on };
          delete this.d.overrides.networkPlay;
          await this.d.settings.save(this.settings);
          await this.networkChanged();
          return ok();
        });
      case "setPort":
        return this.enqueue(async () => {
          if (this.restoring) return refuse({ error: "restoring" });
          const current = this.server ? this.port : null;
          if (cmd.port !== current && !(await this.d.ports.free(cmd.port))) return refuse({ error: "failed", reason: `port ${cmd.port} is in use by another program` });
          if (!this.settings) this.settings = await this.d.settings.load();
          this.settings = { ...this.settings, port: cmd.port };
          delete this.d.overrides.port;
          await this.d.settings.save(this.settings);
          if (this.server) {
            if (cmd.port !== current) await this.restartServer("changePort");
          } else if (this.state === "error") await this.boot();
          else this.emit();
          return ok();
        });
      case "backupNow": {
        if (this.restoring || this.jobKind === "restore") return refuse({ error: "restoring" });
        if (this.jobKind === "backup") return refuse({ error: "busy" });
        if (!this.dbOpen) return refuse({ error: "notRunning" });
        const result = await this.exclusive("backup", () => this.d.backups.run("manual"));
        await this.refreshLastBackup();
        return result.outcome === "good" ? ok() : refuse({ error: "failed", reason: result.reason });
      }
      case "listBackups": {
        const build = this.build;
        const backups: BackupSummary[] = (await this.d.backups.list())
          .map((b) => ({
            name: b.name,
            started: b.record.started,
            finished: b.record.finished,
            kind: b.record.kind,
            ...(b.record.forVersion ? { forVersion: b.record.forVersion } : {}),
            readable: build ? readable(b.record, build) : false,
          }))
          .reverse();
        return ok({ backups });
      }
      case "restore": {
        if (this.restoring || this.jobKind === "restore") return refuse({ error: "busy" });
        if (!this.pgUp || !this.build) return refuse({ error: "notRunning" });
        const checked = await this.d.restore.check(this.build, cmd.backup);
        if (!checked.ok) return refuse(checked.refusal);
        // Answered once it starts. Its end arrives as a notice.
        this.restoring = true;
        void this.enqueue(() => this.restore(cmd.backup, checked));
        return ok();
      }
      case "listRooms":
      case "newDmLink": {
        if (this.restoring) return refuse({ error: "restoring" });
        if (!this.dbOpen) return refuse({ error: "notRunning" });
        const port = this.port ?? this.settings?.port ?? DEFAULT_PORT;
        if (cmd.type === "listRooms") return ok({ rooms: await this.d.rooms.list(port) });
        return ok({ link: await this.d.rooms.newDmLink(port, cmd.roomId) });
      }
      case "retry":
        return this.enqueue(async () => {
          if (this.state === "error") {
            this.crashes = 0;
            await this.boot();
          }
          return ok();
        });
      case "startWithoutBackup":
        return this.enqueue(async () => {
          if (this.error?.kind === "backupBeforeUpdateFailed") {
            this.skipBeforeUpdateBackup = true;
            await this.boot();
          }
          return ok();
        });
      case "deleteGuard":
        return this.enqueue(async () => {
          const error = this.error;
          if (error?.kind === "guardLeft" || error?.kind === "guardUnreadable") {
            await this.d.lock.deleteGuard(error.path);
            await this.boot();
          }
          return ok();
        });
    }
  }

  // -------------------------------------------------------------------------
  // Stop

  /**
   * Stops everything cleanly: the server closes its rooms, a backup or a
   * restore under way ends first, PostgreSQL shuts down, and the lock goes.
   * Answers once all of it has happened.
   */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const timer of [this.crashTimer, this.backupTimer, this.pgTimer, this.addressTimer]) timer?.cancel();
      await this.enqueue(async () => {
        this.set("stopping", "stopping");
        if (this.networkStarted) this.d.network.stop();
        await this.stopServer();
        while (this.job) await this.job.catch(() => undefined);
        await this.closeDb();
        if (this.pgUp) {
          await this.d.pg.stop();
          this.pgUp = false;
        }
        if (this.lockHeld) {
          await this.d.lock.release();
          this.lockHeld = false;
        }
        this.port = null;
        this.set("stopped", null);
      });
    })();
    return this.stopping;
  }
}
