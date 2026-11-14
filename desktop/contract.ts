/**
 * The desktop app's contract (docs/design/design-v1-local-app.md, section 12):
 * every shape that crosses from one of its processes to another, and the
 * words its window, tray and notifications show. The shell talks to the
 * supervisor over Node's IPC channel on stdio, the supervisor to the app
 * server over another, and the window to the shell through
 * `window.raccoonLocal`.
 *
 * This file runs in four places: the supervisor (Node's type stripping), the
 * shell's main and preload (bundled by Vite), the window (a browser page) and
 * the smoke tests. So it imports nothing but zod: no Node built-ins, no
 * Electron, no DOM.
 *
 * Code outside desktop/ imports from here only with `import type`. The
 * server's image holds no desktop/ folder (.dockerignore), and a type import
 * is erased before Node runs the file. contract.test.ts checks both rules.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Names, versions and ports

/** The name every system shows (D-261113-076). */
export const APP_NAME = "RaccoonVTT";

/** An app version as releases are tagged, without the `v`. */
export const AppVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

/**
 * The app server's port on first run, or the first free one above it, saved
 * from then on (design 7). Below 1024 needs root on Linux, which the app
 * refuses to run as.
 */
export const DEFAULT_PORT = 3170;
export const Port = z.number().int().min(1024).max(65535);

/** A room's canonical ID: 8 Crockford base32 characters, no hyphen (server/auth/roomId.ts). */
export const RoomId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);

export const Platform = z.enum(["win32", "darwin", "linux"]);
export type Platform = z.infer<typeof Platform>;

// ---------------------------------------------------------------------------
// Files: the data folder, the bundled runtime and the backups

/**
 * Overrides the data folder, as `--data <dir>` does (design 8.1). Unset, it
 * is `%LOCALAPPDATA%\RaccoonVTT\data` on Windows,
 * `~/Library/Application Support/RaccoonVTT/data` on macOS and
 * `${XDG_DATA_HOME:-~/.local/share}/RaccoonVTT` on Linux. desktop/runtime
 * works it out, and reports it in `SupervisorStatus.paths`.
 */
export const DATA_DIR_ENV = "RACCOON_DATA_DIR";

/** What the data folder holds, by name (design 8.1). */
export const DATA_LAYOUT = {
  /** The PostgreSQL cluster, made by initdb. */
  postgres: "postgres",
  /** The app server's ASSET_DIR. */
  assets: "assets",
  /** Backups, named as `BackupName` says, and their image store. */
  backups: "backups",
  /** One file per process, as `LOG_FILES` names them. */
  logs: "logs",
  /** `ROOM_SECRET_KEY` and the database password, mode 0600 on macOS and Linux (design 6.5). */
  secrets: "secrets.json",
  settings: "settings.json",
  /** An unreadable settings.json, kept here when defaults replace it. */
  settingsBad: "settings.json.bad",
  /** The restore journal, `RestoreJournal`, present only while a restore runs (design 8.3). */
  restoreJournal: "restore.json",
  /** The owner record: pid, start time and lock path of the supervisor that holds the lock (design 8.1). */
  ownerRecord: "supervisor.json",
} as const;

/** Each process writes its own log, rotated at 10 MB with 5 kept (design 8.1). */
export const LOG_FILES = {
  server: "server.log",
  supervisor: "supervisor.log",
  shell: "shell.log",
  postgres: "postgres.log",
} as const;
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;

/**
 * The bundled runtime, by folder (design 2, 11.2). desktop/scripts/
 * fetch-runtime.ts fills `desktop/.runtime/` with `node/` and `postgres/`,
 * and electron-builder copies those two and the staged `app-server/` into
 * the app's resources folder under the same names. The bundled Node is
 * renamed so Task Manager and firewall prompts name the app, and the
 * Windows firewall rule names `resources\node\raccoonvtt-server.exe`.
 */
export const RUNTIME_DIR = "desktop/.runtime";
export const RESOURCES = {
  node: "node",
  postgres: "postgres",
  appServer: "app-server",
  licenses: "licenses",
} as const;
export function serverBinaryName(platform: Platform): string {
  return platform === "win32" ? "raccoonvtt-server.exe" : "raccoonvtt-server";
}
/** The supervisor's entry, from the repository's root or the staged `app-server/`. */
export const SUPERVISOR_ENTRY = "desktop/runtime/main.ts";

/**
 * Backups use backup.sh's names (docker/backup.sh): `raccoon-`, the start
 * in UTC to the second, and an 8-character run ID. A good backup is
 * `<name>.dump`, `<name>.files` and, written last, `<name>.good.json`
 * (a `BackupRecord`). Images live once each in `BACKUP_STORE`.
 */
export const BackupName = z.string().regex(/^raccoon-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{8}$/);
export const BACKUP_STORE = "assets";
export const BACKUP_SUFFIX = { dump: ".dump", files: ".files", good: ".good.json" } as const;

/**
 * When a backup started, read from its name, as an ISO string. A restore
 * journal names its backup, so the window can still say "the backup from
 * <date>" after retention removed the backup itself (D-261113-107).
 */
export function backupNameTime(name: string): string | null {
  const m = /^raccoon-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-[a-z0-9]{8}$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  // Date.parse accepts a day 31 in a 30-day month by rolling it over, so the
  // round trip has to come back unchanged.
  const t = Date.parse(iso);
  return Number.isNaN(t) || new Date(t).toISOString() !== iso ? null : iso;
}

// ---------------------------------------------------------------------------
// Stored records

/**
 * settings.json (design 8.1). An unreadable file is replaced by the defaults
 * and kept as `settings.json.bad`. Keys this build does not know are kept,
 * so going back to an older build and forward again loses no setting.
 * `port` is unset until the first start picks one.
 */
export const Settings = z.looseObject({
  port: Port.optional(),
  networkPlay: z.boolean().default(true),
  checkUpdates: z.boolean().default(true),
  openBrowser: z.boolean().default(true),
  // On by default here, unlike a hosted server, where a CDN's terms and
  // metered bandwidth are the reasons they start off (D-261113-058).
  animatedMaps: z.boolean().default(true),
  roomSound: z.boolean().default(true),
});
export type Settings = z.infer<typeof Settings>;

/**
 * What the window changes in place. The port and the switch go through
 * their own commands, since each restarts the app server.
 */
export const SettingsPatch = z.strictObject({
  checkUpdates: z.boolean().optional(),
  openBrowser: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * The format stamp: the one row of `local_app_stamp` in the `raccoon`
 * database (design 8.4), with columns `app`, `snapshot_version`,
 * `op_version`, `pg_major` and `written_at`. It names the build that last ran
 * a server over this data. db/schema.sql never names the table, and columns
 * are only ever added to it (D-261113-109).
 */
export const STAMP_TABLE = "local_app_stamp";
export const VersionStamp = z.object({
  app: AppVersion,
  snapshotVersion: z.number().int().positive(),
  opVersion: z.number().int().positive(),
  pgMajor: z.number().int().positive(),
  writtenAt: z.iso.datetime(),
});
export type VersionStamp = z.infer<typeof VersionStamp>;

export const BackupKind = z.enum(["daily", "manual", "before-update"]);
export type BackupKind = z.infer<typeof BackupKind>;

/**
 * `<name>.good.json`, written last, so a backup without one never counts
 * (design 8.2). The formats are the data's own, read from the stamp in the
 * dump's snapshot: the old build's for a before-update backup. `forVersion`,
 * the version being installed, is there exactly for a before-update backup.
 * `dbBytes` is the database's size, for a restore's space check.
 */
export const BackupRecord = z
  .object({
    started: z.iso.datetime(),
    finished: z.iso.datetime(),
    kind: BackupKind,
    dataApp: AppVersion,
    snapshotVersion: z.number().int().positive(),
    opVersion: z.number().int().positive(),
    pgMajor: z.number().int().positive(),
    forVersion: AppVersion.optional(),
    dumpBytes: z.number().int().nonnegative(),
    dbBytes: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
  })
  .refine((r) => (r.kind === "before-update") === (r.forVersion !== undefined), {
    message: "forVersion is set exactly for a before-update backup",
    path: ["forVersion"],
  });
export type BackupRecord = z.infer<typeof BackupRecord>;

/**
 * restore.json (design 8.3). The ID goes into the restored database's
 * comment, `raccoonvtt-restoring:<id>` and so on, so it is plain hex:
 * 16 random bytes. The next start never takes the journal's word over the
 * databases'. It only picks between finishing and undoing when both are safe.
 */
export const RestoreState = z.enum(["preparing", "swapping", "finishing", "undoing"]);
export const RestoreJournal = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  backup: BackupName,
  state: RestoreState,
});
export type RestoreJournal = z.infer<typeof RestoreJournal>;

// ---------------------------------------------------------------------------
// Supervisor and app server

/**
 * The app server's environment, built from nothing at each start (design 2
 * and 4): no inherited `NODE_OPTIONS`, proxies or `PUBLIC_ORIGIN`. On
 * Windows the supervisor also passes `WINDOWS_KEPT_ENV` from its own.
 */
export const SERVER_ENV_NAMES = [
  "NODE_ENV",
  "RACCOON_MODE",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "ROOM_SECRET_KEY",
  "ASSET_DIR",
  "DATABASE_DISK_DIR",
  "ANIMATED_MAPS",
  "ROOM_SOUND",
  "ROOMS_PER_IP_PER_DAY",
  "ROOMS_PER_DAY",
  "ROOM_QUOTA_MB",
] as const;
export type ServerEnv = Record<(typeof SERVER_ENV_NAMES)[number], string>;
export const WINDOWS_KEPT_ENV = ["SystemRoot", "TEMP", "TMP"] as const;

/**
 * What the app server binds (design 6): 127.0.0.1 with the switch off, or on
 * Windows without a fresh sample saying the network is Private, else 0.0.0.0,
 * IPv4 only.
 */
export const ServerHost = z.enum(["127.0.0.1", "0.0.0.0"]);
export type ServerHost = z.infer<typeof ServerHost>;

export function localServerEnv(start: {
  host: ServerHost;
  port: number;
  databaseUrl: string;
  roomSecretKey: string;
  assetDir: string;
  databaseDiskDir: string;
  animatedMaps: boolean;
  roomSound: boolean;
}): ServerEnv {
  return {
    NODE_ENV: "production",
    RACCOON_MODE: "local",
    HOST: start.host,
    PORT: String(start.port),
    DATABASE_URL: start.databaseUrl,
    ROOM_SECRET_KEY: start.roomSecretKey,
    ASSET_DIR: start.assetDir,
    DATABASE_DISK_DIR: start.databaseDiskDir,
    ANIMATED_MAPS: start.animatedMaps ? "1" : "0",
    ROOM_SOUND: start.roomSound ? "1" : "0",
    // Only this computer makes rooms, so the hosted limits would only get
    // in the DM's way (design 4).
    ROOMS_PER_IP_PER_DAY: "1000",
    ROOMS_PER_DAY: "1000",
    ROOM_QUOTA_MB: "1024",
  };
}

/**
 * Supervisor to app server. `shutdown` runs server/main.ts's graceful
 * shutdown, which a disconnect of the channel runs too, since
 * `kill("SIGTERM")` ends a Windows process at once. The server's exit is
 * its stopped report.
 */
export const SupervisorToServer = z.object({ type: z.literal("shutdown") });
export type SupervisorToServer = z.infer<typeof SupervisorToServer>;

/**
 * App server to supervisor, at most every `SERVER_STATUS_INTERVAL_MS` and
 * only when a count changed, so both are 0 until the first one.
 * `remoteDevices` counts addresses other than this computer's own, so the
 * DM's tabs at `localhost` or at the LAN address never count (D-261113-095).
 */
export const ServerToSupervisor = z.object({
  type: z.literal("status"),
  sockets: z.number().int().nonnegative(),
  remoteDevices: z.number().int().nonnegative(),
});
export type ServerToSupervisor = z.infer<typeof ServerToSupervisor>;
export const SERVER_STATUS_INTERVAL_MS = 5000;

/**
 * The supervisor's arguments. `--headless` runs it without the shell and
 * prints each status as one `headlessLine`. The smoke tests drive a headless
 * supervisor over the same IPC channel the shell uses, and with no channel
 * Ctrl+C stops it cleanly. `--port` and `--network on|off` override
 * settings.json for that run. `--postgres <dir>` names the PostgreSQL
 * folder, which is otherwise `RESOURCES.postgres` beside `app-server/`, or
 * `desktop/.runtime/postgres` in the repository.
 */
export const SUPERVISOR_ARGS = {
  headless: "--headless",
  data: "--data",
  port: "--port",
  network: "--network",
  postgres: "--postgres",
} as const;

/**
 * The shell's own arguments. `--smoke` opens no browser and quits with code
 * 0 once the supervisor reports `running` (design 11.3). `--quit` asks a
 * running copy to quit through the single-instance lock, and exits at once
 * when none runs (D-261113-099).
 */
export const SHELL_ARGS = { smoke: "--smoke", quit: "--quit" } as const;

// ---------------------------------------------------------------------------
// Supervisor status

/** Section 10's states. */
export const SupervisorState = z.enum([
  "stopped",
  "recovering",
  "starting",
  "running",
  "restarting",
  "restoring",
  "stopping",
  "error",
]);
export type SupervisorState = z.infer<typeof SupervisorState>;

/** What the status line says, one key per phrase in section 9's Starting list. */
export const StatusStep = z.enum([
  "initdb",
  "startDatabase",
  "backupBeforeUpdate",
  "finishRestore",
  "startServer",
  "running",
  "stopping",
  "openToNetwork",
  "closeToNetwork",
  "changePort",
]);
export type StatusStep = z.infer<typeof StatusStep>;

/** A restore's steps, shown on its blocking panel (design 8.3). */
export const RestoreStep = z.enum(["stopping", "images", "database", "starting"]);
export type RestoreStep = z.infer<typeof RestoreStep>;

/**
 * Whether players can join, and if not, why, in this order: `off` (the
 * switch is off), `offline` (no private address), then on Windows `public`,
 * `domain` or `unknown` (the watcher failed or the network has no profile,
 * D-261113-094), else `open`. It picks the window's words. The bind follows
 * `ServerHost`, so a computer that is offline with the switch on can take a
 * new address without a restart, except on Windows.
 */
export const NetworkReach = z.enum(["open", "off", "offline", "public", "domain", "unknown"]);
export type NetworkReach = z.infer<typeof NetworkReach>;

/**
 * Every stop the window explains. `glibc` and `quarantine` come from the
 * shell, which sees the bundled programs fail to load, and `root` from
 * either. The shell also uses `serverCrashed`, with supervisor.log's last
 * line, when the supervisor itself exits on its own.
 */
export const AppError = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("glibc") }),
  z.object({ kind: z.literal("quarantine") }),
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("alreadyRunning") }),
  z.object({ kind: z.literal("pathTooLong") }),
  z.object({ kind: z.literal("guardLeft"), path: z.string() }),
  z.object({ kind: z.literal("guardUnreadable"), path: z.string() }),
  z.object({ kind: z.literal("portInUse"), port: Port, next: Port }),
  z.object({ kind: z.literal("pgMajor"), dataMajor: z.number().int().positive(), bundledMajor: z.number().int().positive() }),
  z.object({ kind: z.literal("databaseFailed"), logLine: z.string() }),
  z.object({ kind: z.literal("serverCrashed"), logLine: z.string() }),
  z.object({ kind: z.literal("restoreTangled") }),
  z.object({ kind: z.literal("noStamp") }),
  z.object({ kind: z.literal("newerData"), dataApp: AppVersion }),
  z.object({ kind: z.literal("noReadableBackup"), dataApp: AppVersion }),
  z.object({ kind: z.literal("backupBeforeUpdateFailed"), reason: z.string() }),
]);
export type AppError = z.infer<typeof AppError>;

/**
 * A one-time message about a restore. `seq` grows with each new notice, so
 * the window shows one once although every later status repeats it. Dates
 * are the backup's start.
 */
const noticeSeq = { seq: z.number().int().nonnegative() };
export const Notice = z.discriminatedUnion("kind", [
  z.object({ ...noticeSeq, kind: z.literal("restored"), backupStarted: z.iso.datetime() }),
  z.object({ ...noticeSeq, kind: z.literal("restoreFailed"), reason: z.string() }),
  z.object({ ...noticeSeq, kind: z.literal("restoreInterrupted") }),
  z.object({ ...noticeSeq, kind: z.literal("restoreFinished"), backupStarted: z.iso.datetime() }),
]);
export type Notice = z.infer<typeof Notice>;

/**
 * The supervisor's whole state, sent on every change. The shell reads it for
 * the tray and the power blocker, and passes it to the window.
 * - `port`: where the app server listens or is starting, else null.
 * - `host`: what it binds now, null while no server runs.
 * - `shareOrigin`: `http://<address>:<port>` while `network` is `open`.
 * - `otherAddresses`: this computer's other private addresses, for Not working?.
 * - `firewallRule`: Windows only, null elsewhere or until checked.
 * - `sockets` counts every socket, the DM's own tabs included, for the power
 *   blocker. `remoteDevices` counts other devices, for the window and Quit.
 * - `lastBackup`: the newest good backup's start, null when there is none.
 * - `restore`: the step while a restore runs.
 */
export const SupervisorStatus = z.object({
  state: SupervisorState,
  step: StatusStep.nullable(),
  appVersion: AppVersion,
  settings: Settings,
  port: Port.nullable(),
  host: ServerHost.nullable(),
  network: NetworkReach,
  shareOrigin: z.string().nullable(),
  otherAddresses: z.array(z.string()),
  firewallRule: z.enum(["present", "missing"]).nullable(),
  sockets: z.number().int().nonnegative(),
  remoteDevices: z.number().int().nonnegative(),
  backingUp: z.boolean(),
  lastBackup: z.iso.datetime().nullable(),
  restore: RestoreStep.nullable(),
  error: AppError.nullable(),
  notice: Notice.nullable(),
  paths: z.object({ data: z.string(), backups: z.string(), logs: z.string() }),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatus>;

/** A headless supervisor's status line: the status as one line of JSON. */
export function headlessLine(status: SupervisorStatus): string {
  return JSON.stringify(status);
}
/** The status a headless line holds, or null for any other line. */
export function parseHeadlessLine(line: string): SupervisorStatus | null {
  try {
    const parsed = SupervisorStatus.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shell and supervisor

/**
 * A backup as the window lists it. `readable`: its recorded formats are
 * this build's or older, so this build can restore it (design 8.4).
 */
export const BackupSummary = z.object({
  name: BackupName,
  started: z.iso.datetime(),
  finished: z.iso.datetime(),
  kind: BackupKind,
  forVersion: AppVersion.optional(),
  readable: z.boolean(),
});
export type BackupSummary = z.infer<typeof BackupSummary>;

/** A room as Rooms on this computer lists it, from `scripts/admin.ts --no-schema --json list-rooms` (design 8.6). */
export const RoomSummary = z.object({
  id: RoomId,
  name: z.string(),
  lastActiveAt: z.iso.datetime().nullable(),
});
export type RoomSummary = z.infer<typeof RoomSummary>;

/**
 * What the shell asks of the supervisor. `newDmLink`'s link goes back to
 * the shell, which opens it in the browser, and never reaches the window.
 * `stop` answers once the app server has closed and PostgreSQL has shut
 * down cleanly, the stopped report an install waits for (design 8.4). A
 * closed channel stops the supervisor the same way. `backupNow` answers when
 * the backup ends. `restore` answers a refusal from step 1 as a failure, and
 * otherwise answers once the restore starts, its end arriving as a `Notice`.
 */
export const Command = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("setNetworkPlay"), on: z.boolean() }),
  z.strictObject({ type: z.literal("setPort"), port: Port }),
  z.strictObject({ type: z.literal("setSettings"), patch: SettingsPatch }),
  z.strictObject({ type: z.literal("backupNow") }),
  z.strictObject({ type: z.literal("listBackups") }),
  z.strictObject({ type: z.literal("restore"), backup: BackupName }),
  z.strictObject({ type: z.literal("listRooms") }),
  z.strictObject({ type: z.literal("newDmLink"), roomId: RoomId }),
  z.strictObject({ type: z.literal("retry") }),
  z.strictObject({ type: z.literal("startWithoutBackup") }),
  z.strictObject({ type: z.literal("deleteGuard") }),
  z.strictObject({ type: z.literal("stop") }),
]);
export type Command = z.infer<typeof Command>;

/** A command's answer when it worked, by command. The rest answer `{}`. */
export const CommandValue = {
  listBackups: z.object({ backups: z.array(BackupSummary) }),
  listRooms: z.object({ rooms: z.array(RoomSummary) }),
  newDmLink: z.object({ link: z.string() }),
} as const;
export type CommandValue<T extends Command["type"]> = T extends keyof typeof CommandValue
  ? z.infer<(typeof CommandValue)[T]>
  : Record<string, never>;

/**
 * Why a command did nothing. `restoring`: refused while a restore runs.
 * `busy`: the same command is still running. `notRunning`: it needs the
 * database, which is not up. `noSpace`: a restore needs `bytes` more free.
 * `failed`: a reason the window shows as written, a lowercase clause.
 */
export const CommandFailure = z.discriminatedUnion("error", [
  z.object({ error: z.literal("restoring") }),
  z.object({ error: z.literal("busy") }),
  z.object({ error: z.literal("notRunning") }),
  z.object({ error: z.literal("noSpace"), bytes: z.number().int().nonnegative() }),
  z.object({ error: z.literal("failed"), reason: z.string() }),
]);
export type CommandFailure = z.infer<typeof CommandFailure>;

export const CommandOutcome = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), failure: CommandFailure }),
]);

export const ShellToSupervisor = z.strictObject({
  type: z.literal("command"),
  id: z.number().int().positive(),
  command: Command,
});
export type ShellToSupervisor = z.infer<typeof ShellToSupervisor>;

export const SupervisorToShell = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: SupervisorStatus }),
  z.object({ type: z.literal("result"), id: z.number().int().positive(), outcome: CommandOutcome }),
]);
export type SupervisorToShell = z.infer<typeof SupervisorToShell>;

// ---------------------------------------------------------------------------
// Shell and window

/**
 * The update banner's state (design 8.4). `install` is true where the app
 * installs itself (Windows and the AppImage), and false where Download opens
 * the release page (macOS and the deb).
 */
export const UpdateState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("available"), version: AppVersion, install: z.boolean() }),
  z.object({ state: z.literal("downloading"), version: AppVersion, percent: z.number().int().min(0).max(100) }),
  z.object({ state: z.literal("stopping"), version: AppVersion }),
]);
export type UpdateState = z.infer<typeof UpdateState>;

/**
 * What the shell knows that the supervisor does not. `clockOffsetMinutes`
 * is set only when the clock is more than 2 minutes off (design 7).
 * `error` is the shell's own stop, such as a supervisor that would not start.
 */
export const ShellState = z.object({
  platform: Platform,
  version: AppVersion,
  update: UpdateState,
  clockOffsetMinutes: z.number().int().nullable(),
  error: AppError.nullable(),
});
export type ShellState = z.infer<typeof ShellState>;

/** Everything the window draws. `supervisor` is null until its first status. */
export const WindowState = z.object({
  shell: ShellState,
  supervisor: SupervisorStatus.nullable(),
});
export type WindowState = z.infer<typeof WindowState>;

/**
 * The window's calls, as they cross from the preload to the shell's main
 * process. The shell parses every one with this schema before acting
 * (design 6.4): strict objects, so a call with an extra key is refused too.
 */
export const BRIDGE_CHANNEL = "raccoon-local";
export const STATE_CHANNEL = "raccoon-local-state";
export const Folder = z.enum(["data", "backups", "logs"]);
export const BridgeCall = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("getState") }),
  z.strictObject({ method: z.literal("setNetworkPlay"), on: z.boolean() }),
  z.strictObject({ method: z.literal("setPort"), port: Port }),
  z.strictObject({ method: z.literal("setSettings"), patch: SettingsPatch }),
  z.strictObject({ method: z.literal("backupNow") }),
  z.strictObject({ method: z.literal("listBackups") }),
  z.strictObject({ method: z.literal("restore"), backup: BackupName }),
  z.strictObject({ method: z.literal("listRooms") }),
  z.strictObject({ method: z.literal("newDmLink"), roomId: RoomId }),
  z.strictObject({ method: z.literal("retry") }),
  z.strictObject({ method: z.literal("startWithoutBackup") }),
  z.strictObject({ method: z.literal("deleteGuard") }),
  z.strictObject({ method: z.literal("openApp") }),
  z.strictObject({ method: z.literal("openFolder"), folder: Folder }),
  z.strictObject({ method: z.literal("openRelease") }),
  z.strictObject({ method: z.literal("openSource") }),
  z.strictObject({ method: z.literal("installUpdate") }),
  z.strictObject({ method: z.literal("copyText"), text: z.string().max(4096) }),
  z.strictObject({ method: z.literal("quit") }),
]);
export type BridgeCall = z.infer<typeof BridgeCall>;

export type BridgeResult<T = Record<string, never>> = { ok: true; value: T } | { ok: false; failure: CommandFailure };

/**
 * `window.raccoonLocal`, which the preload exposes and desktop/window's fake
 * bridge stands in for in development and tests.
 * - `subscribe` calls back with the state now, then on every change, and
 *   returns the function that stops it.
 * - `newDmLink` opens the new link in the browser. The link never reaches
 *   the window.
 * - `openApp` opens `http://localhost:<port>` in the default browser.
 * - `openRelease` opens the latest release page (Download, Download the
 *   latest version), and `openSource` this version's tag on it.
 * - `copyText` copies through the shell, so it works whatever the page's
 *   clipboard permission.
 * - `quit` quits at once: the window asks first when other devices are
 *   connected.
 */
export type RaccoonLocal = {
  subscribe(listener: (state: WindowState) => void): () => void;
  setNetworkPlay(on: boolean): Promise<BridgeResult>;
  setPort(port: number): Promise<BridgeResult>;
  setSettings(patch: SettingsPatch): Promise<BridgeResult>;
  backupNow(): Promise<BridgeResult>;
  listBackups(): Promise<BridgeResult<CommandValue<"listBackups">>>;
  restore(backup: string): Promise<BridgeResult>;
  listRooms(): Promise<BridgeResult<CommandValue<"listRooms">>>;
  newDmLink(roomId: string): Promise<BridgeResult>;
  retry(): Promise<BridgeResult>;
  startWithoutBackup(): Promise<BridgeResult>;
  deleteGuard(): Promise<BridgeResult>;
  openApp(): Promise<void>;
  openFolder(folder: z.infer<typeof Folder>): Promise<void>;
  openRelease(): Promise<void>;
  openSource(): Promise<void>;
  installUpdate(): Promise<BridgeResult>;
  copyText(text: string): Promise<void>;
  quit(): Promise<void>;
};

declare global {
  interface Window {
    raccoonLocal?: RaccoonLocal;
  }
}

// ---------------------------------------------------------------------------
// Words (design 9, Exact words)

/** A clause from a log or a reason, ready to end a sentence with one full stop. */
function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, "");
}

function devices(n: number): string {
  return n === 1 ? "1 other device" : `${n} other devices`;
}

export const WORDS = {
  steps: {
    initdb: "Setting up the database. This happens once and takes up to a minute.",
    startDatabase: "Starting the database",
    backupBeforeUpdate: "Backing up before the update",
    finishRestore: "Finishing a restore",
    startServer: "Starting RaccoonVTT",
    running: "Running",
    stopping: "Stopping",
    openToNetwork: "Restarting so players can join",
    closeToNetwork: "Restarting so only this computer can open it",
    changePort: "Changing the port",
  } satisfies Record<StatusStep, string>,

  players: {
    heading: "Players join at",
    copy: "Copy",
    copied: "Copied",
    qrAlt: (origin: string) => `QR code for ${origin}`,
    switch: "Players on this network can join",
    reach: {
      off: "Only this computer can open RaccoonVTT.",
      offline: "This computer isn't on a network. Connect to Wi-Fi or a cable and the address shows here.",
      public:
        "Windows calls this network public, so players can't join on it. If you trust this network, open Windows Settings, then Network & internet, choose this network, and set Network profile type to Private.",
      domain: "This is a work network managed by your organization. Players can't join on it.",
      unknown: "RaccoonVTT couldn't read this network's Windows profile, so players can't join for now.",
    } satisfies Record<Exclude<NetworkReach, "open">, string>,
    devices: (n: number) => (n === 0 ? "No other devices connected" : `${devices(n)} connected`),
    awake: "This computer stays awake while devices are connected.",
  },

  notWorking: {
    heading: "Not working?",
    sameNetwork: "Players' devices must be on the same network as this computer. Guest Wi-Fi often keeps devices apart.",
    vpn: "A VPN on this computer can block players. Turn it off, or allow local network access in it.",
    alsoAt: (addresses: readonly string[]) => `This computer also answers at: ${addresses.join(", ")}.`,
    ufw: (port: number) => `If a firewall runs here, allow the port: sudo ufw allow ${port}/tcp`,
    firewallRuleMissing: "Windows Firewall has no rule for RaccoonVTT. Reinstall RaccoonVTT to add it.",
  },

  openApp: "Open RaccoonVTT",

  rooms: {
    heading: "Rooms on this computer",
    empty: "No rooms yet. Open RaccoonVTT to make one.",
    notRunning: "Rooms show here while RaccoonVTT runs.",
    lastPlayed: (when: string) => `Last played ${when}`,
    newDmLink: "New DM link",
    confirm: (name: string) =>
      `Make a new DM link for “${name}”? Every device signed in as DM in this room is signed out, co-DMs become players, and unused DM invites stop working.`,
    makeLink: "Make link",
    opened: "The new DM link opened in your browser.",
  },

  backups: {
    heading: "Backups",
    last: (when: string) => `Last backup: ${when}`,
    none: "No backups yet",
    backUpNow: "Back up now",
    backingUp: "Backing up",
    failed: (reason: string) => `The backup failed: ${clause(reason)}.`,
    kinds: {
      manual: () => "By hand",
      daily: () => "Daily",
      "before-update": (forVersion: string) => `Before the update to ${forVersion}`,
    } satisfies Record<BackupKind, (forVersion: string) => string>,
    restore: "Restore",
    confirm: (date: string) =>
      `Restore the backup from ${date}? Every room goes back to how it was then, and changes since are lost. Players are disconnected while it restores.`,
    steps: {
      stopping: "Restoring: stopping RaccoonVTT",
      images: "Restoring: checking images",
      database: "Restoring the database",
      starting: "Starting RaccoonVTT",
    } satisfies Record<RestoreStep, string>,
    restored: (date: string) => `Restored the backup from ${date}.`,
    restoreFailed: (reason: string) => `The restore failed, and nothing changed: ${clause(reason)}.`,
    restoreInterrupted: "A restore was interrupted, and nothing changed.",
    restoreFinished: (date: string) => `The restore of the backup from ${date} finished.`,
    noSpace: (size: string) => `Not enough free disk space to restore safely. Free at least ${size} and try again.`,
    showFolder: "Show backups folder",
  },

  /** Rooms on this computer and Back up now, while a restore runs. */
  notDuringRestore: "Not during a restore",

  settings: {
    heading: "Settings",
    port: "Port",
    changePort: "Change port",
    confirmPort: (port: number) => `Change the port to ${port}? Player links will change.`,
    portRange: "Use a port from 1024 to 65535.",
    checkUpdates: "Check for updates once a day",
    openBrowser: "Open my browser when RaccoonVTT starts",
    showData: "Show data folder",
    showLogs: "Show logs",
  },

  updates: {
    banner: (version: string) => `RaccoonVTT ${version} is out. Your rooms are backed up before it starts.`,
    install: "Install and restart",
    downloading: (percent: number) => `Downloading ${percent}%`,
    stopping: "Stopping to install",
    download: "Download",
    failed: (reason: string) => `The update failed: ${clause(reason)}.`,
    clock: (minutes: number) =>
      `This computer's clock is ${minutes} minutes off. Set the time automatically, since the Log numbers its lines by this clock.`,
  },

  footer: {
    version: (version: string) => `RaccoonVTT ${version}`,
    sourceCode: "Source code",
    quit: "Quit",
  },

  quit: {
    confirm: (n: number) => `${devices(n)} ${n === 1 ? "is" : "are"} connected. Quitting ends the game for them.`,
    quit: "Quit",
    keepRunning: "Keep running",
  },

  actions: {
    tryAgain: "Try again",
    showLogs: "Show logs",
    showData: "Show data folder",
    usePort: (port: number) => `Use port ${port}`,
    quit: "Quit",
    downloadLatest: "Download the latest version",
    restoreBackup: "Restore a backup",
    startWithoutBackup: "Start without a backup",
    startAnyway: "Start anyway",
    copyPath: "Copy",
    deleteGuard: "Delete it and start",
    cancel: "Cancel",
  },

  confirmStartWithoutBackup:
    "Start without a backup? Going back to the older version would then lose every change since your last backup.",
  confirmDeleteGuard:
    "Delete the folder and start? Do this only when no other copy of RaccoonVTT is open, or two copies could change the same rooms.",

  tray: {
    openWindow: "Open window",
    openBrowser: "Open RaccoonVTT in the browser",
    networkPlay: "Players on this network can join",
    quit: "Quit RaccoonVTT",
  },

  /** The one notification the first close shows. Linux minimizes instead (D-261113-063). */
  stillRunning: {
    win32: "RaccoonVTT is still running. Quit it from the notification area.",
    darwin: "RaccoonVTT is still running. Quit it from the menu bar.",
  },
} as const;

/**
 * The buttons each stop offers, in order (design 9). `pgMajor` adds
 * Download the latest version to its "Install the latest RaccoonVTT", and a
 * guard's stop offers Copy for its path and Delete it and start behind
 * `confirmDeleteGuard`.
 */
export type ErrorAction = keyof typeof WORDS.actions;
export const ERROR_ACTIONS = {
  glibc: [],
  quarantine: [],
  root: [],
  alreadyRunning: [],
  pathTooLong: [],
  guardLeft: ["copyPath", "deleteGuard"],
  guardUnreadable: ["copyPath", "deleteGuard"],
  portInUse: ["usePort", "quit"],
  pgMajor: ["downloadLatest"],
  databaseFailed: ["tryAgain", "showLogs"],
  serverCrashed: ["tryAgain", "showLogs"],
  restoreTangled: ["showData"],
  noStamp: ["restoreBackup"],
  newerData: ["downloadLatest", "restoreBackup"],
  noReadableBackup: ["downloadLatest"],
  backupBeforeUpdateFailed: ["tryAgain", "startWithoutBackup"],
} as const satisfies Record<AppError["kind"], readonly ErrorAction[]>;

/** The words for a stop. `appVersion` is this build's, `platform` the computer's. */
export function errorText(error: AppError, appVersion: string, platform: Platform): string {
  switch (error.kind) {
    case "glibc":
      return "RaccoonVTT needs glibc 2.36 or later (Ubuntu 24.04, Debian 12, Fedora 37 or later).";
    case "quarantine":
      return 'macOS blocked part of RaccoonVTT. In Terminal, run: xattr -dr com.apple.quarantine "/Applications/RaccoonVTT.app" then open RaccoonVTT again.';
    case "root":
      return "RaccoonVTT can't run as root. Open it as your own user.";
    case "alreadyRunning":
      return "RaccoonVTT is already running with this data folder.";
    case "pathTooLong":
      return "RaccoonVTT can't start because your home folder's path is too long for it.";
    case "guardLeft":
      // /run/user is cleared at boot, so on Linux a restart clears the folder too (D-261113-106).
      return platform === "linux"
        ? `RaccoonVTT closed while it was starting last time. If no other copy is open, delete the folder ${error.path}, or restart the computer, and open RaccoonVTT again.`
        : `RaccoonVTT closed while it was starting last time. If no other copy is open, delete the folder ${error.path} and open RaccoonVTT again.`;
    case "guardUnreadable":
      return `RaccoonVTT can't tell whether another copy is running. If no other copy is open, delete the folder ${error.path} and open RaccoonVTT again.`;
    case "portInUse":
      return `Port ${error.port} is in use by another program. Use port ${error.next} instead? Player links will change.`;
    case "pgMajor":
      return `This data's database is PostgreSQL ${error.dataMajor}, and this version runs PostgreSQL ${error.bundledMajor}. Install the latest RaccoonVTT.`;
    case "databaseFailed":
      return `The database did not start. The log says: ${clause(error.logLine)}.`;
    case "serverCrashed":
      return `RaccoonVTT stopped unexpectedly and did not start again. The log says: ${clause(error.logLine)}.`;
    case "restoreTangled":
      return "A restore left the databases in a state RaccoonVTT can't sort out by itself. Nothing was deleted.";
    case "noStamp":
      return "RaccoonVTT can't tell which version wrote this data.";
    case "newerData":
      return `This data was last used by RaccoonVTT ${error.dataApp}, which saves rooms in a newer format than this version (${appVersion}) reads. Install ${error.dataApp} or later, or restore a backup made before that update.`;
    case "noReadableBackup":
      return `No backup this version can read is on this computer. Install ${error.dataApp} or later to open your rooms.`;
    case "backupBeforeUpdateFailed":
      return `The backup before the update failed: ${clause(error.reason)}. Your rooms are untouched.`;
  }
}
