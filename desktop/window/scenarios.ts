import { type AppError, type BackupSummary, type Notice, type NetworkReach, type Platform, type RestoreStep, type RoomSummary, type StatusStep, type SupervisorState, type SupervisorStatus, type UpdateState, type WindowState } from "../contract.ts";

/**
 * Every state section 9 words, as a `WindowState` the fake bridge starts
 * from. The development page (`?scenario=<name>`) and desktop/e2e/window.e2e.ts
 * walk this list, so a state the window can show but no scenario names is a
 * gap the test fails on. Addresses are from the documentation ranges.
 */

export type Scenario = { state: WindowState; rooms: RoomSummary[]; backups: BackupSummary[] };

const MIN = 60_000;
const HOUR = 3_600_000;

function ago(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

export const ROOM_IDS = ["7K3M9PQR", "2ABCDEFG", "H4JKMNPQ", "5TVWXYZ0"] as const;

export function defaultRooms(now: number): RoomSummary[] {
  return [
    { id: ROOM_IDS[0], name: "The Sunken Library", lastActiveAt: ago(now, 2 * HOUR) },
    { id: ROOM_IDS[1], name: "Ashford Crossing", lastActiveAt: ago(now, 30 * HOUR) },
    { id: ROOM_IDS[2], name: "A room with a very long name that has to wrap in a narrow window without breaking the row", lastActiveAt: ago(now, 20 * 24 * HOUR) },
    { id: ROOM_IDS[3], name: "Fresh room", lastActiveAt: null },
  ];
}

export function defaultBackups(now: number): BackupSummary[] {
  const entry = (name: string, ms: number, kind: BackupSummary["kind"], extra: Partial<BackupSummary> = {}): BackupSummary => ({
    name,
    started: ago(now, ms + 20_000),
    finished: ago(now, ms),
    kind,
    readable: true,
    ...extra,
  });
  return [
    entry("raccoon-2026-11-13-094200-aaaaaaaa", 3 * HOUR, "manual"),
    entry("raccoon-2026-11-13-030000-bbbbbbbb", 9 * HOUR, "daily"),
    entry("raccoon-2026-11-12-030000-cccccccc", 33 * HOUR, "before-update", { forVersion: "0.5.0" }),
  ];
}

export function runningStatus(now: number, platform: Platform = "win32"): SupervisorStatus {
  return {
    state: "running",
    step: "running",
    appVersion: "0.5.0",
    settings: { port: 3170, networkPlay: true, checkUpdates: true, openBrowser: true, animatedMaps: true, roomSound: true },
    port: 3170,
    host: "0.0.0.0",
    network: "open",
    shareOrigin: "http://10.0.0.20:3170",
    otherAddresses: platform === "win32" ? ["10.0.0.21"] : [],
    firewallRule: platform === "win32" ? "present" : null,
    sockets: 0,
    remoteDevices: 0,
    backingUp: false,
    lastBackup: ago(now, 3 * HOUR),
    restore: null,
    error: null,
    notice: null,
    paths: { data: "/home/dm/.local/share/RaccoonVTT", backups: "/home/dm/.local/share/RaccoonVTT/backups", logs: "/home/dm/.local/share/RaccoonVTT/logs" },
  };
}

function wrap(sup: SupervisorStatus | null, platform: Platform, over: Partial<WindowState["shell"]> = {}): WindowState {
  return { shell: { platform, version: "0.5.0", update: { state: "none" }, clockOffsetMinutes: null, error: null, ...over }, supervisor: sup };
}

const STEPS: StatusStep[] = ["initdb", "startDatabase", "backupBeforeUpdate", "finishRestore", "startServer", "stopping", "openToNetwork", "closeToNetwork", "changePort"];
const RESTORE_STEPS: RestoreStep[] = ["stopping", "images", "database", "starting"];
const REACH: NetworkReach[] = ["off", "offline", "public", "domain", "unknown"];

/** One example of every stop (design 9, Errors). */
export const ERRORS: Record<string, AppError> = {
  glibc: { kind: "glibc" },
  quarantine: { kind: "quarantine" },
  root: { kind: "root" },
  alreadyRunning: { kind: "alreadyRunning" },
  pathTooLong: { kind: "pathTooLong" },
  guardLeft: { kind: "guardLeft", path: "/run/user/1000/raccoonvtt-guard-3f9a" },
  guardUnreadable: { kind: "guardUnreadable", path: "C:\\Users\\dm\\AppData\\Local\\Temp\\raccoonvtt-guard-3f9a" },
  portInUse: { kind: "portInUse", port: 3170, next: 3171 },
  pgMajor: { kind: "pgMajor", dataMajor: 18, bundledMajor: 17 },
  databaseFailed: { kind: "databaseFailed", logLine: "FATAL: could not create shared memory segment" },
  serverCrashed: { kind: "serverCrashed", logLine: "Error: listen EADDRINUSE: address already in use :::3170" },
  restoreTangled: { kind: "restoreTangled" },
  noStamp: { kind: "noStamp" },
  newerData: { kind: "newerData", dataApp: "0.6.0" },
  noReadableBackup: { kind: "noReadableBackup", dataApp: "0.6.0" },
  backupBeforeUpdateFailed: { kind: "backupBeforeUpdateFailed", reason: "the disk is full" },
  stalled: { kind: "stalled", what: "starting the database", seconds: 180 },
};

/** Errors only the shell can raise, so they show with no supervisor status. */
const SHELL_ERRORS = new Set(["glibc", "quarantine", "root", "alreadyRunning", "pathTooLong", "guardLeft", "guardUnreadable"]);

const NOTICES: Record<string, Notice> = {
  restored: { seq: 1, kind: "restored", backupStarted: "2026-11-09T19:42:00.000Z" },
  restoreFailed: { seq: 1, kind: "restoreFailed", reason: "the backup's images could not be read" },
  restoreInterrupted: { seq: 1, kind: "restoreInterrupted" },
  restoreFinished: { seq: 1, kind: "restoreFinished", backupStarted: "2026-11-09T19:42:00.000Z" },
};

const UPDATES: Record<string, UpdateState> = {
  "update-install": { state: "available", version: "0.5.1", install: true },
  "update-download": { state: "available", version: "0.5.1", install: false },
  "update-downloading": { state: "downloading", version: "0.5.1", percent: 42 },
  "update-stopping": { state: "stopping", version: "0.5.1" },
};

/** Every scenario name, in the order the e2e file shoots them. */
export const SCENARIO_NAMES: readonly string[] = [
  "running",
  "running-linux",
  "running-mac",
  "devices-1",
  "devices-3",
  "firewall-missing",
  "no-rooms",
  "no-backups",
  "unreadable-backup",
  "starting-none",
  ...STEPS.map((s) => `step-${s}`),
  "finishing-restore",
  ...REACH.map((r) => `reach-${r}`),
  ...RESTORE_STEPS.map((s) => `restoring-${s}`),
  ...Object.keys(ERRORS).map((e) => `error-${e}`),
  ...Object.keys(NOTICES).map((n) => `notice-${n}`),
  ...Object.keys(UPDATES),
  "clock",
  "long-words",
];

const SUP_STATE_OF_STEP: Partial<Record<StatusStep, SupervisorState>> = {
  stopping: "stopping",
  openToNetwork: "restarting",
  closeToNetwork: "restarting",
  changePort: "restarting",
  running: "running",
};

export function scenario(name: string, now: number, platformOverride?: Platform): Scenario {
  let platform: Platform = platformOverride ?? "win32";
  if (name === "running-linux") platform = "linux";
  if (name === "running-mac") platform = "darwin";
  const base = runningStatus(now, platform);
  const out: Scenario = { state: wrap(base, platform), rooms: defaultRooms(now), backups: defaultBackups(now) };
  const set = (patch: Partial<SupervisorStatus>) => (out.state = wrap({ ...base, ...patch }, platform, out.state.shell));

  if (name === "devices-1") set({ remoteDevices: 1, sockets: 2 });
  else if (name === "devices-3") set({ remoteDevices: 3, sockets: 4 });
  else if (name === "firewall-missing") set({ firewallRule: "missing" });
  else if (name === "no-rooms") out.rooms = [];
  else if (name === "no-backups") {
    out.backups = [];
    set({ lastBackup: null });
  } else if (name === "unreadable-backup") out.backups = [{ ...defaultBackups(now)[0]!, name: "raccoon-2026-11-01-030000-dddddddd", readable: false }, ...defaultBackups(now)];
  else if (name === "starting-none") out.state = wrap(null, platform);
  else if (name.startsWith("step-")) {
    const step = name.slice(5) as StatusStep;
    set({ state: SUP_STATE_OF_STEP[step] ?? "starting", step, port: step === "initdb" || step === "startDatabase" ? null : 3170, host: null, shareOrigin: null, network: "offline" });
  } else if (name === "finishing-restore") set({ state: "recovering", step: "finishRestore", percent: 42, port: null, host: null, shareOrigin: null, network: "offline" });
  else if (name.startsWith("reach-")) {
    const network = name.slice(6) as NetworkReach;
    set({ network, shareOrigin: null, host: network === "off" ? "127.0.0.1" : "0.0.0.0", otherAddresses: [], settings: { ...base.settings, networkPlay: network === "off" } });
  } else if (name.startsWith("restoring-")) {
    const restore = name.slice(10) as RestoreStep;
    set({ state: "restoring", step: "finishRestore", restore, host: null, port: restore === "starting" ? 3170 : null, shareOrigin: null, network: "offline" });
  } else if (name.startsWith("error-")) {
    const key = name.slice(6);
    const error = ERRORS[key]!;
    if (SHELL_ERRORS.has(key)) out.state = wrap(null, platform, { error });
    else set({ state: "error", step: null, port: null, host: null, shareOrigin: null, network: "offline", error });
  } else if (name.startsWith("notice-")) set({ notice: NOTICES[name.slice(7)]! });
  else if (name in UPDATES) out.state = wrap(base, platform, { update: UPDATES[name]! });
  else if (name === "clock") out.state = wrap(base, platform, { clockOffsetMinutes: 7 });
  else if (name === "long-words") {
    set({ remoteDevices: 3, sockets: 4, otherAddresses: ["10.0.0.21", "172.16.4.200", "10.12.34.56"], paths: base.paths });
    out.state = wrap(out.state.supervisor, "linux", { update: UPDATES["update-install"]!, clockOffsetMinutes: 7 });
  } else if (name !== "running" && name !== "running-linux" && name !== "running-mac") throw new Error(`no scenario named ${name}`);
  return out;
}
