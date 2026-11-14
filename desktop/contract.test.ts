import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  AppError,
  BackupRecord,
  BridgeCall,
  Command,
  ERROR_ACTIONS,
  SERVER_ENV_NAMES,
  Settings,
  SupervisorStatus,
  WORDS,
  backupNameTime,
  errorText,
  headlessLine,
  localServerEnv,
  parseHeadlessLine,
  type RaccoonLocal,
} from "./contract.ts";

const root = new URL("..", import.meta.url);

// The window's calls and the bridge's methods are one list, and every
// command but `stop` is one the window can make.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const bridgeMatchesCalls: Same<Exclude<keyof RaccoonLocal, "subscribe">, Exclude<BridgeCall["method"], "getState">> = true;
const shellOnlyCalls = ["getState", "openApp", "openFolder", "openRelease", "openSource", "installUpdate", "copyText", "quit"] as const;
const commandsAreCalls: Same<Exclude<Command["type"], "stop">, Exclude<BridgeCall["method"], (typeof shellOnlyCalls)[number]>> = true;
void bridgeMatchesCalls;
void commandsAreCalls;

const SAMPLE_ERRORS = {
  glibc: { kind: "glibc" },
  quarantine: { kind: "quarantine" },
  root: { kind: "root" },
  alreadyRunning: { kind: "alreadyRunning" },
  pathTooLong: { kind: "pathTooLong" },
  guardLeft: { kind: "guardLeft", path: "/run/user/1000/raccoonvtt-0123456789abcdef.sock.recover" },
  guardUnreadable: { kind: "guardUnreadable", path: "/run/user/1000/raccoonvtt-0123456789abcdef.sock.recover" },
  portInUse: { kind: "portInUse", port: 3170, next: 3171 },
  pgMajor: { kind: "pgMajor", dataMajor: 18, bundledMajor: 17 },
  databaseFailed: { kind: "databaseFailed", logLine: "FATAL:  could not create shared memory segment." },
  serverCrashed: { kind: "serverCrashed", logLine: "Error: listen EADDRINUSE" },
  restoreTangled: { kind: "restoreTangled" },
  noStamp: { kind: "noStamp" },
  newerData: { kind: "newerData", dataApp: "0.6.0" },
  noReadableBackup: { kind: "noReadableBackup", dataApp: "0.6.0" },
  backupBeforeUpdateFailed: { kind: "backupBeforeUpdateFailed", reason: "the disk is full" },
  stalled: { kind: "stalled", what: "starting the database", seconds: 180 },
} as const satisfies { [K in AppError["kind"]]: Extract<AppError, { kind: K }> };

/** Every string WORDS can produce, with sample arguments for its functions. */
function allWords(): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") {
      const f = value as (arg: unknown) => unknown;
      // A function takes a version, a date, a name, a count or a list of addresses.
      for (const arg of [3, "0.5.1", ["10.0.0.21", "10.0.0.5"]]) {
        try {
          const text = f(arg);
          if (typeof text === "string" && !text.includes("[object") && !text.includes("undefined")) {
            out.push(text);
            break;
          }
        } catch {
          // The wrong kind of argument for this one: try the next.
        }
      }
    } else if (value && typeof value === "object") for (const v of Object.values(value)) visit(v);
  };
  visit(WORDS);
  for (const error of Object.values(SAMPLE_ERRORS)) for (const platform of ["win32", "darwin", "linux"] as const) out.push(errorText(error, "0.5.0", platform));
  return out;
}

test("the contract imports nothing but zod, so it runs in the supervisor, the shell and the window", () => {
  const source = readFileSync(new URL("desktop/contract.ts", root), "utf8");
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(specifiers, ["zod"]);
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/);
});

/**
 * Module specifiers under desktop/ that a file imports as values. Only a
 * whole `import type` or `export type` is erased before Node runs a file:
 * `import { type A } from` still loads the module.
 */
function valueImportsOfDesktop(source: string): string[] {
  const underDesktop = (specifier: string) => /(?:^|\/)desktop\//.test(specifier);
  const found: string[] = [];
  for (const m of source.matchAll(/(?:^|[;\n])\s*(?:import|export)(\s+type\b)?[^"';]*?\bfrom\s*["']([^"']+)["']/g)) {
    const [, typeOnly, specifier = ""] = m;
    if (!typeOnly && underDesktop(specifier)) found.push(specifier);
  }
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) if (m[1] && underDesktop(m[1])) found.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) if (m[1] && underDesktop(m[1])) found.push(m[1]);
  return found;
}

test("the import check tells type imports from value imports", () => {
  assert.deepEqual(valueImportsOfDesktop('import type { Settings } from "../desktop/contract.ts";'), []);
  assert.deepEqual(valueImportsOfDesktop('export type { Settings } from "../../desktop/contract.ts";'), []);
  assert.deepEqual(valueImportsOfDesktop('import { WORDS } from "../desktop/contract.ts";'), ["../desktop/contract.ts"]);
  assert.deepEqual(valueImportsOfDesktop('import {\n  type Settings,\n  WORDS,\n} from "../desktop/contract.ts";'), ["../desktop/contract.ts"]);
  assert.deepEqual(valueImportsOfDesktop('import "../desktop/runtime/main.ts";'), ["../desktop/runtime/main.ts"]);
  assert.deepEqual(valueImportsOfDesktop('const m = await import("../desktop/contract.ts");'), ["../desktop/contract.ts"]);
  assert.deepEqual(valueImportsOfDesktop('import { type Settings } from "../desktop/contract.ts";'), ["../desktop/contract.ts"]);
  assert.deepEqual(valueImportsOfDesktop('import { x } from "./desktopish.ts";\nimport { y } from "#shared/desktop.ts";'), []);
  assert.deepEqual(valueImportsOfDesktop('export const RUNTIME = "desktop/.runtime";\nconst a = "desktop/out";'), []);
});

test("code the image or the browser bundle ships imports desktop/ only as types", () => {
  const offenders: string[] = [];
  for (const area of ["server", "shared", "scripts", "db", "client"]) {
    for (const file of readdirSync(new URL(`${area}/`, root), { recursive: true }) as string[]) {
      // Tests never ship: .dockerignore leaves them out, and Vite bundles only what the app imports.
      if (!/\.tsx?$/.test(file) || /\.(?:test|itest|e2e)\.tsx?$/.test(file) || file.split(/[\\/]/).includes("node_modules")) continue;
      const source = readFileSync(new URL(`${area}/${file.replaceAll("\\", "/")}`, root), "utf8");
      for (const specifier of valueImportsOfDesktop(source)) offenders.push(`${area}/${file}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("settings default to players joining, update checks, opening the browser, animated maps and sound", () => {
  const defaults = Settings.parse({});
  assert.deepEqual(defaults, { networkPlay: true, checkUpdates: true, openBrowser: true, animatedMaps: true, roomSound: true });
  assert.equal(defaults.port, undefined);
});

test("settings keep keys a newer build wrote, and refuse a bad port", () => {
  assert.deepEqual(Settings.parse({ port: 3171, networkPlay: false, future: "kept" }), {
    port: 3171,
    networkPlay: false,
    checkUpdates: true,
    openBrowser: true,
    animatedMaps: true,
    roomSound: true,
    future: "kept",
  });
  assert.equal(Settings.safeParse({ port: 80 }).success, false);
  assert.equal(Settings.safeParse({ port: 3170.5 }).success, false);
  assert.equal(Settings.safeParse({ networkPlay: "yes" }).success, false);
});

test("a backup record names the version being installed exactly when it was taken before an update", () => {
  const base = {
    started: "2026-11-13T19:42:05.000Z",
    finished: "2026-11-13T19:42:09.000Z",
    dataApp: "0.5.0",
    snapshotVersion: 46,
    opVersion: 60,
    pgMajor: 17,
    dumpBytes: 1000,
    dbBytes: 9000,
    images: 3,
  };
  assert.equal(BackupRecord.safeParse({ ...base, kind: "before-update", forVersion: "0.5.1" }).success, true);
  assert.equal(BackupRecord.safeParse({ ...base, kind: "before-update" }).success, false);
  assert.equal(BackupRecord.safeParse({ ...base, kind: "daily", forVersion: "0.5.1" }).success, false);
  assert.equal(BackupRecord.safeParse({ ...base, kind: "manual" }).success, true);
});

test("a backup's start is read from its name, and only from a real date", () => {
  assert.equal(backupNameTime("raccoon-2026-11-13-194205-ab12cd34"), "2026-11-13T19:42:05.000Z");
  assert.equal(backupNameTime("raccoon-2026-02-30-194205-ab12cd34"), null);
  assert.equal(backupNameTime("raccoon-2026-11-13-254205-ab12cd34"), null);
  assert.equal(backupNameTime("raccoon-2026-11-13-194205-AB12CD34"), null);
  assert.equal(backupNameTime("../raccoon-2026-11-13-194205-ab12cd34"), null);
});

test("the shell refuses a window call with an extra key or a bad argument", () => {
  assert.equal(BridgeCall.safeParse({ method: "newDmLink", roomId: "7K3M9QX2" }).success, true);
  assert.equal(BridgeCall.safeParse({ method: "newDmLink", roomId: "7K3M-9QX2" }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "newDmLink", roomId: "7K3M9QX2", link: "x" }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "quit", now: true }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "setPort", port: 80 }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "restore", backup: "../secrets.json" }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "openFolder", folder: "/etc" }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "setSettings", patch: { networkPlay: true } }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "copyText", text: "x".repeat(4097) }).success, false);
  assert.equal(BridgeCall.safeParse({ method: "eval", code: "1" }).success, false);
});

test("the supervisor refuses a command with an extra key", () => {
  assert.equal(Command.safeParse({ type: "setNetworkPlay", on: true }).success, true);
  assert.equal(Command.safeParse({ type: "setNetworkPlay", on: true, host: "0.0.0.0" }).success, false);
});

test("the app server's environment is exactly the listed names, in local mode", () => {
  const env = localServerEnv({
    host: "0.0.0.0",
    port: 3170,
    databaseUrl: "postgres://raccoon:pw@127.0.0.1:54321/raccoon",
    roomSecretKey: "k",
    assetDir: "/data/assets",
    databaseDiskDir: "/data/postgres",
    animatedMaps: true,
    roomSound: false,
  });
  assert.deepEqual(Object.keys(env).sort(), [...SERVER_ENV_NAMES].sort());
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.RACCOON_MODE, "local");
  assert.equal(env.HOST, "0.0.0.0");
  assert.equal(env.PORT, "3170");
  assert.equal(env.ANIMATED_MAPS, "1");
  assert.equal(env.ROOM_SOUND, "0");
});

test("a headless status line reads back as the status, and other lines as nothing", () => {
  const status = SupervisorStatus.parse({
    state: "running",
    step: "running",
    appVersion: "0.5.0",
    settings: {},
    port: 3170,
    host: "0.0.0.0",
    network: "open",
    shareOrigin: "http://10.0.0.20:3170",
    otherAddresses: [],
    firewallRule: null,
    sockets: 2,
    remoteDevices: 1,
    backingUp: false,
    lastBackup: null,
    restore: null,
    error: null,
    notice: { seq: 1, kind: "restoreInterrupted" },
    paths: { data: "/d", backups: "/d/backups", logs: "/d/logs" },
  });
  const line = headlessLine(status);
  assert.doesNotMatch(line, /\n/);
  assert.deepEqual(parseHeadlessLine(line), status);
  assert.equal(parseHeadlessLine("Starting the database"), null);
  assert.equal(parseHeadlessLine('{"state":"running"}'), null);
});

test("every stop has words and its buttons, on every system", () => {
  for (const [kind, error] of Object.entries(SAMPLE_ERRORS)) {
    assert.ok(kind in ERROR_ACTIONS, kind);
    assert.equal(AppError.safeParse(error).success, true, kind);
  }
  assert.match(errorText(SAMPLE_ERRORS.guardLeft, "0.5.0", "linux"), /or restart the computer/);
  assert.doesNotMatch(errorText(SAMPLE_ERRORS.guardLeft, "0.5.0", "darwin"), /restart/);
  assert.equal(
    errorText(SAMPLE_ERRORS.newerData, "0.5.0", "win32"),
    "This data was last used by RaccoonVTT 0.6.0, which saves rooms in a newer format than this version (0.5.0) reads. Install 0.6.0 or later, or restore a backup made before that update.",
  );
  assert.equal(
    errorText(SAMPLE_ERRORS.databaseFailed, "0.5.0", "win32"),
    "The database did not start. The log says: FATAL:  could not create shared memory segment.",
  );
  assert.equal(errorText(SAMPLE_ERRORS.stalled, "0.5.0", "win32"), "Starting the database has done nothing for 180 s. RaccoonVTT goes on when it ends, and the logs may say why it is slow.");
  assert.deepEqual(ERROR_ACTIONS.stalled, ["showLogs"], "a stalled part is still waited for, so Try again has nothing to start");
});

test("counts read as words", () => {
  assert.equal(WORDS.players.devices(0), "No other devices connected");
  assert.equal(WORDS.players.devices(1), "1 other device connected");
  assert.equal(WORDS.players.devices(3), "3 other devices connected");
  assert.equal(WORDS.quit.confirm(1), "1 other device is connected. Quitting ends the game for them.");
  assert.equal(WORDS.quit.confirm(3), "3 other devices are connected. Quitting ends the game for them.");
  assert.equal(WORDS.backups.kinds["before-update"]("0.5.1"), "Before the update to 0.5.1");
});

test("the words keep the house style: no em dash, no semicolon, one full stop", () => {
  const words = allWords();
  assert.ok(words.length > 100, `only ${words.length} strings`);
  for (const text of words) {
    assert.doesNotMatch(text, /\u2014/, text);
    assert.doesNotMatch(text, /;/, text);
    assert.doesNotMatch(text, /\.\.|\s$|^\s/, text);
  }
});
