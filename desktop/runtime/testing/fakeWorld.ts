import type { BackupRecord, Command, Platform, RestoreJournal, Settings, SupervisorStatus, VersionStamp } from "../../contract.ts";
import type { ServerExit, ServerHandle } from "../appServer.ts";
import type { StoredBackup } from "../backup.ts";
import type { Clock, Timer } from "../clock.ts";
import { BEFORE, LIVE, RESTORING, checkRestorable, recover, runRestore, type DbName, type RestoreContext, type RestoreDb, type Tag } from "../restore.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";
import { Supervisor, type CommandOutcome, type SupervisorDeps } from "../supervisor.ts";
import type { Build } from "../versionGuard.ts";

/**
 * A computer in memory for the supervisor's tests (design 10): one
 * PostgreSQL with its databases, the restore journal, backups, app server
 * processes, the lock, the network profile and a fake clock. Each
 * supervisor runs the real Supervisor and the real restore code over it.
 *
 * A supervisor is killed the way a process dies: from the call its budget
 * runs out on, nothing it awaits ever settles again, half the time after
 * that call's effect took place and half the time before. Its app server
 * then shuts down as its channel closes, its PostgreSQL keeps running, and
 * the lock's socket is left for the next start to recover.
 *
 * The world checks the section 10 rules as they happen and keeps every
 * break in `violations`.
 */

export async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

type FakeTimer = { at: number; seq: number; fn: () => void; live: boolean };

export class FakeClock implements Clock {
  t = Date.parse("2026-11-01T12:00:00.000Z");
  private timers: FakeTimer[] = [];
  private seq = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const timer: FakeTimer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, live: true };
    this.timers.push(timer);
    return { cancel: () => void (timer.live = false) };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  /** Runs every timer due within `ms`, in order, letting the promises they settle run between them. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      this.timers = this.timers.filter((t) => t.live);
      let next: FakeTimer | undefined;
      for (const t of this.timers) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      if (!next) break;
      next.live = false;
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

/** A deterministic random source, so a failing run can be read again from its seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

type Db = { content: string; tag: Tag | null; stamp: VersionStamp | null; rooms: number };

type FakeServer = {
  owner: Instance;
  port: number;
  host: string;
  epoch: number;
  alive: boolean;
  exit: (e: ServerExit) => void;
  exited: Promise<ServerExit>;
};

export const BUILD = { app: "0.5.0", snapshotVersion: 46, opVersion: 60 };

export class World {
  readonly clock = new FakeClock();
  platform: Platform = "linux";
  random: () => number;
  dbs = new Map<DbName, Db>();
  journal: RestoreJournal | null = null;
  pg = { inited: false, running: false, epoch: 0 };
  settings: Settings = DEFAULT_SETTINGS;
  servers: FakeServer[] = [];
  backups: StoredBackup[] = [];
  lockOwner: Instance | null = null;
  profile: "open" | "public" | "domain" | "unknown" = "open";
  netListeners: Array<{ owner: Instance; onChange: () => void }> = [];
  violations: string[] = [];
  /** How often a restore's database step fails on its own, for the undo paths. */
  failRate = 0;
  restoreBy: Instance | null = null;
  backupBy: Instance | null = null;
  /** The content before the newest restore began, and the content it brings. */
  lastRestore: { before: string; after: string } | null = null;
  /** Each server start, for the crash timing test. */
  serverStarts: number[] = [];
  /** A server that crashes this long after it starts, when set. */
  crashAfterMs: number | null = null;
  backupFails = false;
  portTaken = new Set<number>();
  private nameSeq = 0;

  constructor(seed = 1) {
    this.random = rng(seed);
  }

  /** A server alive on today's PostgreSQL: one that can reach the data. An old one's database moved to a new port. */
  serving(): FakeServer[] {
    return this.servers.filter((s) => s.alive && s.epoch === this.pg.epoch && this.pg.running);
  }

  violate(rule: string): void {
    this.violations.push(rule);
  }

  live(): Db {
    const db = this.dbs.get(LIVE);
    if (!db) throw new Error("database raccoon does not exist");
    return db;
  }

  needPg(): void {
    if (!this.pg.running) throw new Error("connection refused");
  }

  maybeFail(what: string): void {
    if (this.failRate > 0 && this.random() < this.failRate) throw new Error(`${what} failed (injected)`);
  }

  backupName(): string {
    const iso = new Date(this.clock.now()).toISOString();
    const id = (this.nameSeq++).toString(36).padStart(8, "0");
    return `raccoon-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${id}`;
  }

  died(inst: Instance): void {
    if (this.lockOwner === inst) this.lockOwner = null;
    this.netListeners = this.netListeners.filter((l) => l.owner !== inst);
    for (const s of this.servers) if (s.owner === inst && s.alive) this.exitServer(s, { code: 0, signal: null }, 100);
  }

  exitServer(s: FakeServer, exit: ServerExit, afterMs = 0): void {
    const done = (): void => {
      if (!s.alive) return;
      s.alive = false;
      s.exit(exit);
    };
    if (afterMs === 0) done();
    else this.clock.setTimeout(done, afterMs);
  }

  crashServer(): boolean {
    const s = this.serving()[0];
    if (!s) return false;
    this.exitServer(s, { code: 1, signal: null });
    return true;
  }

  crashPostgres(): void {
    this.pg.running = false;
  }

  setProfile(profile: World["profile"]): void {
    this.profile = profile;
    for (const l of [...this.netListeners]) if (!l.owner.dead) l.onChange();
  }

  /** A database in use by an earlier build, with one room, as an existing install has. */
  seed(stamp: Partial<VersionStamp> = {}): void {
    this.pg.inited = true;
    this.dbs.set(LIVE, {
      content: "orig",
      tag: null,
      stamp: { app: BUILD.app, snapshotVersion: BUILD.snapshotVersion, opVersion: BUILD.opVersion, pgMajor: 17, writtenAt: new Date(this.clock.now()).toISOString(), ...stamp },
      rooms: 1,
    });
  }
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

export class Instance {
  readonly world: World;
  readonly sup: Supervisor;
  readonly statuses: SupervisorStatus[] = [];
  dead = false;
  stopped = false;
  /** Calls left before this process dies. */
  budget = Number.POSITIVE_INFINITY;
  private nextId = 1;
  readonly sent = new Map<number, Command>();
  readonly answers = new Map<number, CommandOutcome[]>();

  constructor(world: World, build: Omit<Build, "pgMajor"> = BUILD, overrides: SupervisorDeps["overrides"] = {}) {
    this.world = world;
    this.sup = new Supervisor(depsFor(world, this, build, overrides));
  }

  /** One call into the computer. The process dies on the call its budget runs out on. */
  call<T>(effect: () => T | Promise<T>): Promise<T> {
    if (this.dead) return never();
    this.budget--;
    if (this.budget <= 0) {
      if (this.world.random() < 0.5) {
        try {
          const r = effect();
          if (r instanceof Promise) r.catch(() => undefined);
        } catch {
          // Its effect is what counts. The process is gone.
        }
      }
      this.kill();
      return never();
    }
    return Promise.resolve().then(effect);
  }

  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.world.died(this);
  }

  latest(): SupervisorStatus | null {
    return this.statuses.at(-1) ?? null;
  }

  issue(command: Command): number {
    const id = this.nextId++;
    this.sent.set(id, command);
    void this.sup.command(command).then((outcome) => {
      if (this.dead) return;
      const list = this.answers.get(id) ?? [];
      list.push(outcome);
      this.answers.set(id, list);
    });
    return id;
  }
}

function depsFor(world: World, inst: Instance, build: Omit<Build, "pgMajor">, overrides: SupervisorDeps["overrides"]): SupervisorDeps {
  const c = <T>(effect: () => T | Promise<T>): Promise<T> => inst.call(effect);
  const clock: Clock = {
    now: () => world.clock.now(),
    setTimeout: (fn, ms) => (inst.dead ? { cancel: () => undefined } : world.clock.setTimeout(() => void (inst.dead || fn()), ms)),
    sleep: (ms) => (inst.dead ? never() : world.clock.sleep(ms)),
  };

  /** Changing the data is only ever the lock holder's to do. */
  const holder = (what: string): void => {
    if (world.lockOwner !== inst) world.violate(`${what} without the lock`);
  };
  const restoreGuard = (what: string): void => {
    world.needPg();
    holder(what);
    if (world.serving().length > 0) world.violate(`${what} while an app server runs`);
  };
  const db: RestoreDb = {
    state: () =>
      c(() => {
        world.needPg();
        const live = world.dbs.get(LIVE);
        const restoring = world.dbs.get(RESTORING);
        return { live: live ? { tag: live.tag } : null, before: world.dbs.has(BEFORE), restoring: restoring ? { tag: restoring.tag } : null };
      }),
    createRestoring: (tag) =>
      c(() => {
        restoreGuard("create");
        world.maybeFail("create database");
        if (world.dbs.has(RESTORING)) throw new Error("raccoon_restoring exists");
        world.dbs.set(RESTORING, { content: "creating", tag, stamp: null, rooms: 0 });
      }),
    setTag: (name, tag) =>
      c(() => {
        world.needPg();
        const target = world.dbs.get(name);
        if (!target) throw new Error(`${name} does not exist`);
        target.tag = tag;
      }),
    rename: (from, to) =>
      c(() => {
        restoreGuard("rename");
        world.maybeFail("rename");
        const target = world.dbs.get(from);
        if (!target || world.dbs.has(to)) throw new Error(`cannot rename ${from} to ${to}`);
        world.dbs.delete(from);
        world.dbs.set(to, target);
      }),
    drop: (name) =>
      c(() => {
        restoreGuard("drop");
        world.maybeFail("drop");
        if (!world.dbs.has(name)) return;
        const R = world.dbs.get(LIVE);
        if (name === LIVE && !(world.dbs.has(BEFORE) && R?.tag?.kind === "restored")) world.violate("dropped raccoon without raccoon_before_restore beside it and a restored tag");
        if (name === BEFORE && !(R && world.journal && R.tag?.id === world.journal.id)) world.violate("dropped raccoon_before_restore while raccoon was not this journal's");
        world.dbs.delete(name);
      }),
    endSessions: () => c(() => world.needPg()),
    load: (dumpFile) =>
      c(() => {
        restoreGuard("load");
        world.maybeFail("pg_restore");
        const target = world.dbs.get(RESTORING);
        if (!target) throw new Error("no raccoon_restoring");
        target.content = `restored:${/(raccoon-[^/\\]+)\.dump$/.exec(dumpFile)?.[1] ?? "?"}`;
        target.rooms = 1;
      }),
    stampRestored: (b, record) =>
      c(() => {
        const target = world.dbs.get(RESTORING);
        if (!target) throw new Error("no raccoon_restoring");
        target.stamp = { app: b.app, snapshotVersion: record.snapshotVersion, opVersion: record.opVersion, pgMajor: record.pgMajor, writtenAt: new Date(world.clock.now()).toISOString() };
      }),
  };

  const ctx = (b: Build): RestoreContext => ({
    db,
    journal: {
      read: () => c(() => world.journal),
      write: (j) => c(() => void (world.journal = j)),
      delete: () => c(() => void (world.journal = null)),
    },
    fs: {
      size: (p) => c(() => (p.endsWith(".dump") ? 100 : null)),
      isDir: () => c(() => true),
      mkdir: () => c(() => undefined),
      copy: () => c(() => undefined),
      rename: () => c(() => undefined),
      unlink: () => c(() => undefined),
      syncFile: () => c(() => undefined),
      syncDir: () => c(() => undefined),
    },
    backupsDir: "/data/backups",
    assetsDir: "/data/assets",
    build: b,
    hooks: { at: () => undefined },
    log: () => undefined,
    freeBytes: () => c(() => 1e12),
    floorBytes: 0,
    readRecord: (name) => c(() => world.backups.find((x) => x.name === name)?.record ?? null),
    readList: (name) => c(() => (world.backups.some((x) => x.name === name) ? [] : null)),
  });

  return {
    clock,
    platform: world.platform,
    build,
    paths: { data: "/data", backups: "/data/backups", logs: "/data/logs" },
    log: () => undefined,
    overrides: { ...overrides },
    isRoot: () => false,
    lock: {
      acquire: () =>
        c(() => {
          if (world.lockOwner && !world.lockOwner.dead && world.lockOwner !== inst) return { ok: false as const, error: { kind: "alreadyRunning" as const } };
          world.lockOwner = inst;
          return { ok: true as const };
        }),
      release: () => c(() => void (world.lockOwner === inst && (world.lockOwner = null))),
      deleteGuard: () => c(() => undefined),
    },
    settings: { load: () => c(() => world.settings), save: (s) => c(() => void (world.settings = s)) },
    pg: {
      bundledMajor: () => c(() => 17),
      dataMajor: () => c(() => (world.pg.inited ? 17 : null)),
      needsInit: () => !world.pg.inited,
      init: () =>
        c(() => {
          holder("initdb");
          world.pg.inited = true;
        }),
      leftover: () => c(() => (world.pg.running ? { kind: "running" as const, pid: 99 } : { kind: "none" as const })),
      clearLeftover: () =>
        c(() => {
          if (world.lockOwner !== inst) world.violate("a leftover PostgreSQL stopped without the lock");
          world.pg.running = false;
        }),
      start: () =>
        c(() => {
          holder("PostgreSQL started");
          if (world.pg.running) throw Object.assign(new Error("already running"), { logLine: "lock file postmaster.pid already exists" });
          world.pg.running = true;
          world.pg.epoch++;
        }),
      stop: () => c(() => void (world.pg.running = false)),
      alive: () => c(() => world.pg.running),
    },
    db: {
      open: (create) =>
        c(() => {
          world.needPg();
          if (create) world.dbs.set(LIVE, { content: "empty", tag: null, stamp: null, rooms: 0 });
        }),
      close: () => c(() => undefined),
      readStamp: () =>
        c(() => {
          world.needPg();
          return world.live().stamp;
        }),
      roomsEmpty: () =>
        c(() => {
          world.needPg();
          return world.live().rooms === 0;
        }),
      writeStamp: (b) =>
        c(() => {
          world.needPg();
          holder("the stamp written");
          world.live().stamp = { app: b.app, snapshotVersion: b.snapshotVersion, opVersion: b.opVersion, pgMajor: b.pgMajor, writtenAt: new Date(world.clock.now()).toISOString() };
        }),
    },
    restore: {
      pending: () => c(() => world.journal !== null),
      recover: (b) => recover(ctx(b)),
      check: (b, name) => checkRestorable(ctx(b), name),
      run: async (b, name, checked, onStep) => {
        if (world.backupBy && !world.backupBy.dead) world.violate("a restore began during a backup");
        world.restoreBy = inst;
        const live = world.dbs.get(LIVE);
        world.lastRestore = { before: live?.content ?? "?", after: `restored:${name}` };
        try {
          return await runRestore(ctx(b), name, checked, onStep);
        } finally {
          // A restore that threw (its database gone) is over too. One that was killed never gets here, and its owner is dead.
          if (world.restoreBy === inst) world.restoreBy = null;
        }
      },
    },
    backups: {
      run: (kind, forVersion) =>
        c(async () => {
          if (world.restoreBy && !world.restoreBy.dead) world.violate("a backup ran during a restore");
          world.needPg();
          world.backupBy = inst;
          await clock.sleep(2_000);
          if (world.backupBy === inst) world.backupBy = null;
          if (world.backupFails) return { outcome: "failed" as const, reason: "the disk is full" };
          world.needPg();
          const stamp = world.live().stamp;
          if (!stamp) return { outcome: "failed" as const, reason: "the database has no version stamp" };
          const at = new Date(world.clock.now()).toISOString();
          const record: BackupRecord = {
            started: at,
            finished: at,
            kind,
            dataApp: stamp.app,
            snapshotVersion: stamp.snapshotVersion,
            opVersion: stamp.opVersion,
            pgMajor: stamp.pgMajor,
            ...(kind === "before-update" ? { forVersion } : {}),
            dumpBytes: 100,
            dbBytes: 1000,
            images: 0,
          };
          const name = world.backupName();
          world.backups.push({ name, record });
          return { outcome: "good" as const, name, record };
        }),
      list: () => c(() => [...world.backups]),
    },
    server: {
      start(host, port): ServerHandle {
        holder("an app server started");
        if (world.serving().length > 0) world.violate("a second app server started");
        let exit!: (e: ServerExit) => void;
        const exited = new Promise<ServerExit>((resolve) => (exit = resolve));
        const s: FakeServer = { owner: inst, port, host, epoch: world.pg.epoch, alive: true, exit, exited };
        world.servers.push(s);
        world.serverStarts.push(world.clock.now());
        if (world.crashAfterMs !== null) world.exitServer(s, { code: 1, signal: null }, world.crashAfterMs);
        return {
          pid: world.servers.length,
          exited,
          onStatus: () => undefined,
          stop: () => {
            world.exitServer(s, { code: 0, signal: null }, 100);
            return exited;
          },
        };
      },
      healthy: (_port, handle) =>
        c(async () => {
          await clock.sleep(200);
          const s = world.servers.find((x) => x.exited === handle.exited);
          return s?.alive === true;
        }),
      lastLogLine: () => c(() => "fake server crashed"),
    },
    network: {
      start: (onChange) => void world.netListeners.push({ owner: inst, onChange }),
      stop: () => void (world.netListeners = world.netListeners.filter((l) => l.owner !== inst)),
      firstSample: () => c(() => undefined),
      read: (networkPlay) =>
        c(() => {
          const reach = !networkPlay ? "off" : world.platform === "win32" ? world.profile : "open";
          const host = networkPlay && reach === "open" ? "0.0.0.0" : "127.0.0.1";
          return { reach, host, share: "10.0.0.20", others: [] } as const;
        }),
      firewallRule: () => c(() => null),
    },
    ports: {
      free: (port) => c(() => !world.portTaken.has(port) && !world.servers.some((s) => s.alive && s.port === port)),
      firstFree: (from) =>
        c(() => {
          let p = from;
          while (world.portTaken.has(p) || world.servers.some((s) => s.alive && s.port === p)) p++;
          return p;
        }),
    },
    rooms: {
      list: () =>
        c(async () => {
          world.needPg();
          await clock.sleep(100);
          return [];
        }),
      newDmLink: (port, roomId) => c(() => `http://localhost:${port}/r/${roomId}#dm=k`),
    },
    emit: (status) => {
      if (!inst.dead) inst.statuses.push(status);
    },
  };
}
