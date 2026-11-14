import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import {
  BACKUP_SUFFIX,
  LOG_FILES,
  Platform,
  Port,
  RESOURCES,
  RUNTIME_DIR,
  ShellToSupervisor,
  headlessLine,
  localServerEnv,
  type RestoreJournal,
  type SupervisorToShell,
} from "../contract.ts";
import { localNetwork } from "../../server/local/network.ts";
import { OP_VERSION, SNAPSHOT_VERSION } from "../../shared/migrate.ts";
import { spawnAppServer, waitHealthy } from "./appServer.ts";
import { FREE_FLOOR_BYTES, freeBytesOf, listBackups, runBackup } from "./backup.ts";
import { realClock } from "./clock.ts";
import { dataIdentity, dataPaths, ensureDataDir, resolveDataDir } from "./dataDir.ts";
import { deleteJournal, readJournal, writeJournal } from "./journal.ts";
import { acquireLock, deleteGuardFolder, lockLocation, type HeldLock } from "./lock.ts";
import { RotatingLog, lastLogLine } from "./logs.ts";
import { ProfileWatcher, firewallRule, networkReading, profileReach, spawnWatchChild } from "./netProfile.ts";
import { readOwner, writeOwner } from "./ownerRecord.ts";
import { firstFreePort, portFree } from "./ports.ts";
import { Cluster, DATABASE } from "./postgres.ts";
import { selfIdentity, stillRunning } from "./processInfo.ts";
import { checkRestorable, parseRecord, recover, runRestore, type CrashPoint, type RestoreContext, type RestoreHooks } from "./restore.ts";
import { clusterRestoreDb, nodeImageFs } from "./restoreDb.ts";
import { listRooms, newDmLink } from "./rooms.ts";
import { loadSecrets, type Secrets } from "./secrets.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { Supervisor, type SupervisorDeps } from "./supervisor.ts";
import { readStamp, roomsEmpty, stampOf, writeStamp, type Build } from "./versionGuard.ts";

/**
 * The supervisor's entry (docs/design/design-v1-local-app.md 2 and 10), run
 * by the bundled Node as `raccoonvtt-server desktop/runtime/main.ts`. The
 * shell talks to it over Node's IPC channel on stdio, never a port. With
 * `--headless` it prints each status as one line of JSON, for the smoke
 * tests, and stops cleanly on Ctrl+C.
 *
 * Variables read only by tests, never set by the shell, the installer or
 * the docs, as backup.sh's BACKUP_TEST_* are:
 * - RACCOONVTT_TEST_BUILD: `{"app","snapshotVersion","opVersion"}` this run pretends to be.
 * - RACCOONVTT_TEST_SERVER_ENTRY: a stand-in for server/main.ts.
 * - RESTORE_TEST_CRASH_AT: a restore point (restore.ts CrashPoint) at which the process kills itself.
 * - RESTORE_TEST_DROP_JOURNAL: journal states, comma-separated, whose writes are dropped.
 * - RESTORE_TEST_FAIL_BEFORE: a restore point whose step fails.
 */

const { values: args } = parseArgs({
  options: {
    headless: { type: "boolean", default: false },
    data: { type: "string" },
    port: { type: "string" },
    network: { type: "string" },
    postgres: { type: "string" },
  },
  strict: true,
});

const platform = Platform.parse(process.platform);
const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const channel = typeof process.send === "function";
if (!channel && !args.headless) {
  console.error("Run RaccoonVTT from its app. To run this without it: --headless --data <folder>");
  process.exit(2);
}

const dataDir = resolveDataDir(args.data, platform, process.env, os.homedir());
await ensureDataDir(dataDir, platform);
const paths = dataPaths(dataDir);
for (const dir of [paths.logs, paths.assets, paths.backups]) await mkdir(dir, { recursive: true });
const supervisorLog = new RotatingLog(join(paths.logs, LOG_FILES.supervisor));
const serverLog = new RotatingLog(join(paths.logs, LOG_FILES.server));
const log = (msg: string): void => supervisorLog.line(`${new Date().toISOString()} ${msg}`);
log(`starting, pid ${process.pid}, data ${dataDir}`);

/** Beside app-server/ in the installed app, or the fetched runtime in the repository. */
const postgresDir =
  args.postgres ?? (basename(appRoot.replace(/[\\/]+$/, "")) === RESOURCES.appServer ? join(appRoot, "..", RESOURCES.postgres) : join(appRoot, RUNTIME_DIR, RESOURCES.postgres));

async function thisBuild(): Promise<Omit<Build, "pgMajor">> {
  const test = process.env.RACCOONVTT_TEST_BUILD;
  if (test) return JSON.parse(test) as Omit<Build, "pgMajor">;
  const pkg = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { version: string };
  return { app: pkg.version, snapshotVersion: SNAPSHOT_VERSION, opVersion: OP_VERSION };
}

const overrides: SupervisorDeps["overrides"] = {};
if (args.port !== undefined) overrides.port = Port.parse(Number(args.port));
if (args.network !== undefined) {
  if (args.network !== "on" && args.network !== "off") throw new Error("--network takes on or off");
  overrides.networkPlay = args.network === "on";
}

// The secrets and the cluster are made only once the lock is held, so two
// first starts can never write two different passwords.
let secrets: Secrets | null = null;
let cluster: Cluster | null = null;
async function theCluster(): Promise<Cluster> {
  secrets ??= await loadSecrets(paths.secrets, platform, existsSync(paths.postgres));
  cluster ??= new Cluster({
    binDir: join(postgresDir, "bin"),
    pgData: paths.postgres,
    logFile: join(paths.logs, LOG_FILES.postgres),
    password: secrets.databasePassword,
    platform,
  });
  return cluster;
}

let pool: pg.Pool | null = null;
function thePool(): pg.Pool {
  if (!pool) throw new Error("the database is not open");
  return pool;
}

let held: HeldLock | null = null;
const self = await selfIdentity(platform);

const testCrashAt = process.env.RESTORE_TEST_CRASH_AT as CrashPoint | undefined;
const testDropped = new Set((process.env.RESTORE_TEST_DROP_JOURNAL ?? "").split(",").filter(Boolean));
const testFailBefore = process.env.RESTORE_TEST_FAIL_BEFORE as CrashPoint | undefined;
const hooks: RestoreHooks = {
  at(point) {
    if (point === testCrashAt) {
      log(`killed at the restore point ${point}, for a test`);
      process.kill(process.pid, "SIGKILL");
    }
  },
  dropJournalWrite: (state) => testDropped.has(state),
  failBefore: (point) => point === testFailBefore,
};

async function restoreContext(build: Build): Promise<RestoreContext> {
  const c = await theCluster();
  return {
    db: clusterRestoreDb(c),
    journal: {
      read: () => readJournal(paths.journal),
      write: (j: RestoreJournal) => writeJournal(paths.journal, j),
      delete: () => deleteJournal(paths.journal),
    },
    fs: nodeImageFs,
    backupsDir: paths.backups,
    assetsDir: paths.assets,
    build,
    hooks,
    log,
    freeBytes: () => freeBytesOf(dataDir),
    floorBytes: FREE_FLOOR_BYTES,
    async readRecord(name) {
      try {
        return parseRecord(await readFile(join(paths.backups, name + BACKUP_SUFFIX.good), "utf8"));
      } catch {
        return null;
      }
    },
  };
}

const network = localNetwork();
let watcher: ProfileWatcher | null = null;

const deps: SupervisorDeps = {
  clock: realClock,
  platform,
  build: await thisBuild(),
  paths: { data: dataDir, backups: paths.backups, logs: paths.logs },
  log,
  overrides,
  isRoot: () => process.getuid?.() === 0,
  lock: {
    async acquire() {
      const location = lockLocation(dataIdentity(dataDir, platform).hash, { platform, uid: process.getuid?.() ?? 0, home: os.homedir() });
      if ("error" in location) return { ok: false, error: { kind: "pathTooLong" } };
      const outcome = await acquireLock(location.path, {
        platform,
        self,
        async claim() {
          const previous = await readOwner(paths.owner);
          if (previous !== null && previous !== "unreadable" && previous.pid !== process.pid && (await stillRunning(previous, platform))) {
            log(`the owner record names a supervisor still running (pid ${previous.pid})`);
            return false;
          }
          await writeOwner(paths.owner, self, location.path);
          return true;
        },
      });
      if (!outcome.ok) return outcome;
      held = outcome.lock;
      return { ok: true };
    },
    async release() {
      await rm(paths.owner, { force: true });
      await held?.close();
      held = null;
    },
    deleteGuard: (path) => deleteGuardFolder(path),
  },
  settings: {
    async load() {
      const loaded = await loadSettings(paths.settings, paths.settingsBad);
      if (loaded.replaced) log("settings.json did not read, so the defaults replaced it and the old file is settings.json.bad");
      return loaded.settings;
    },
    save: (settings) => saveSettings(paths.settings, settings),
  },
  pg: {
    bundledMajor: async () => (await theCluster()).bundledMajor(),
    dataMajor: async () => (await theCluster()).dataMajor(),
    needsInit: () => (cluster as Cluster).needsInit(),
    init: async () => (await theCluster()).init(),
    leftover: async () => (await theCluster()).leftover(),
    clearLeftover: async (found) => (await theCluster()).clearLeftover(found),
    async start() {
      await (await theCluster()).start();
    },
    stop: async () => (await theCluster()).stop(),
    alive: async () => (await theCluster()).running(),
  },
  db: {
    async open(create) {
      const c = await theCluster();
      if (create) {
        const admin = new pg.Client({ connectionString: c.url("postgres") });
        await admin.connect();
        try {
          await admin.query(`create database ${DATABASE} template template0`);
        } finally {
          await admin.end();
        }
      }
      pool = new pg.Pool({ connectionString: c.url(), max: 3 });
      pool.on("error", (err) => log(`database connection failed: ${err.message}`));
    },
    async close() {
      const p = pool;
      pool = null;
      await p?.end();
    },
    readStamp: () => readStamp(thePool()),
    roomsEmpty: () => roomsEmpty(thePool()),
    writeStamp: (build) => writeStamp(thePool(), stampOf(build)),
  },
  restore: {
    pending: async () => (await readJournal(paths.journal)) !== null || existsSync(paths.journal),
    recover: async (build) => recover(await restoreContext(build)),
    check: async (build, name) => checkRestorable(await restoreContext(build), name),
    run: async (build, name, checked, onStep) => runRestore(await restoreContext(build), name, checked, onStep),
  },
  backups: {
    run: async (kind, forVersion) =>
      runBackup({ cluster: await theCluster(), pool: thePool(), backupsDir: paths.backups, assetsDir: paths.assets, log }, kind, forVersion),
    list: () => listBackups(paths.backups),
  },
  server: {
    start(host, port) {
      const c = cluster as Cluster;
      const s = secrets as Secrets;
      const settings = supervisor.status().settings;
      return spawnAppServer({
        node: process.execPath,
        entry: process.env.RACCOONVTT_TEST_SERVER_ENTRY ?? join(appRoot, "server", "main.ts"),
        cwd: appRoot,
        env: localServerEnv({
          host,
          port,
          databaseUrl: c.url(),
          roomSecretKey: s.roomSecretKey,
          assetDir: paths.assets,
          databaseDiskDir: paths.postgres,
          animatedMaps: settings.animatedMaps,
          roomSound: settings.roomSound,
        }),
        platform,
        log: serverLog,
        clock: realClock,
      });
    },
    healthy: (port, handle) => waitHealthy(port, handle.exited, realClock),
    lastLogLine: () => lastLogLine(join(paths.logs, LOG_FILES.server)),
  },
  network: {
    start(onChange) {
      if (platform !== "win32") return;
      watcher = new ProfileWatcher({ clock: realClock, spawn: spawnWatchChild, log, onChange });
      watcher.start();
    },
    stop: () => watcher?.stop(),
    firstSample: () => watcher?.firstSample() ?? Promise.resolve(),
    async read(networkPlay) {
      const primary = await network.primaryAddress();
      const others = network.localAddresses().filter((a) => a !== primary);
      return networkReading(platform, networkPlay, primary, others, () => profileReach(watcher?.latest() ?? null, Date.now(), primary));
    },
    firewallRule: async () => (platform === "win32" ? firewallRule() : null),
  },
  ports: { free: (port) => portFree(port), firstFree: (from) => firstFreePort(from) },
  rooms: {
    list: async (port) => listRooms({ node: process.execPath, appRoot, databaseUrl: (await theCluster()).url(), port, platform }),
    newDmLink: async (port, roomId) => newDmLink({ node: process.execPath, appRoot, databaseUrl: (await theCluster()).url(), port, platform }, roomId),
  },
  emit(status) {
    if (channel) send({ type: "status", status });
    if (args.headless) console.log(headlessLine(status));
    if (status.state === "error") {
      log(`error: ${JSON.stringify(status.error)}`);
      // With no shell to answer it, an error has no one to act on it.
      if (!channel) void exit(1);
    }
  },
};

function send(message: SupervisorToShell): void {
  try {
    process.send?.(message);
  } catch {
    // The shell is gone, and the disconnect handler stops everything.
  }
}

const supervisor = new Supervisor(deps);

let exiting = false;
async function exit(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await supervisor.stop();
  } catch (err) {
    log(`stop failed: ${(err as Error).stack ?? String(err)}`);
    code = code || 1;
  }
  log(`exiting with code ${code}`);
  supervisorLog.close();
  serverLog.close();
  process.exit(code);
}

process.on("message", (message: unknown) => {
  const parsed = ShellToSupervisor.safeParse(message);
  if (!parsed.success) {
    log("ignored a message from the shell that did not read");
    return;
  }
  const { id, command } = parsed.data;
  void supervisor.command(command).then((outcome) => {
    send({ type: "result", id, outcome });
    if (command.type === "stop") void exit(0);
  });
});
// A closed channel stops everything the same way, so the shell's end (even
// taskkill /F) never leaves PostgreSQL or the server behind for long.
process.on("disconnect", () => void exit(0));
process.on("SIGINT", () => void exit(0));
process.on("SIGTERM", () => void exit(0));
process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack ?? err.message}`);
  void exit(1);
});
process.on("unhandledRejection", (err) => {
  log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});

await supervisor.start();
