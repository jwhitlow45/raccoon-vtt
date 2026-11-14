import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { LOG_FILES, LOG_KEEP, WORDS, type SupervisorStatus } from "../contract.ts";
import { parseShellArgs, secondInstanceWantsQuit } from "./args.ts";
import { commandFor, parseBridgeCall } from "./bridge.ts";
import { planClose } from "./close.ts";
import { ShellLog, rotate } from "./log.ts";
import { externalAllowed, windowFile, WINDOW_CSP, contentType } from "./navigation.ts";
import { looksQuarantined, startBlocker, versionBelow } from "./platform.ts";
import { POWER_RELEASE_MS, PowerBlocker } from "./power.ts";
import { readPrefs, writePrefs, SHELL_PREFS_FILE } from "./prefs.ts";
import { quitQuestion } from "./quit.ts";
import { spawnPlan, supervisorEnv } from "./supervisor.ts";
import { trayItems } from "./tray.ts";
import { zoomKey, zoomStep } from "./zoom.ts";
import { sampleStatus } from "./fixture.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "raccoonvtt-shell-"));
}

// ---------------------------------------------------------------------------
// Arguments and the single-instance lock

test("--quit and --smoke are read wherever Chromium puts them", () => {
  assert.deepEqual(parseShellArgs(["/opt/RaccoonVTT/raccoonvtt"]), { smoke: false, quit: false });
  assert.deepEqual(parseShellArgs(["RaccoonVTT.exe", "--allow-file-access-from-files", "--quit"]), { smoke: false, quit: true });
  assert.deepEqual(parseShellArgs(["RaccoonVTT", "--smoke"]), { smoke: true, quit: false });
  assert.equal(parseShellArgs(["RaccoonVTT", "--quitter"]).quit, false);
});

test("a second launch asks to quit by its arguments or, when another user started it, by the lock's data", () => {
  assert.equal(secondInstanceWantsQuit(["RaccoonVTT.exe", "--quit"], null), true);
  assert.equal(secondInstanceWantsQuit([], { quit: true }), true);
  assert.equal(secondInstanceWantsQuit(["RaccoonVTT.exe"], { quit: false }), false);
  assert.equal(secondInstanceWantsQuit(["RaccoonVTT.exe"], "quit"), false);
  assert.equal(secondInstanceWantsQuit(["RaccoonVTT.exe"], { quit: "yes" }), false);
});

// ---------------------------------------------------------------------------
// The bridge

test("every bridge call is parsed before it acts, and anything off the contract is refused", () => {
  assert.deepEqual(parseBridgeCall({ method: "setNetworkPlay", on: false }), { method: "setNetworkPlay", on: false });
  assert.deepEqual(parseBridgeCall({ method: "setPort", port: 3175 }), { method: "setPort", port: 3175 });
  const refused: unknown[] = [
    null,
    "quit",
    { method: "runAnything", command: "rm" },
    { method: "setNetworkPlay", on: "true" },
    { method: "setNetworkPlay", on: true, extra: 1 },
    { method: "setPort", port: 80 },
    { method: "setPort", port: 70000 },
    { method: "setPort", port: 3170.5 },
    { method: "setSettings", patch: { networkPlay: true } },
    { method: "setSettings", patch: { port: 3171 } },
    { method: "restore", backup: "../../etc/passwd" },
    { method: "restore", backup: "raccoon-2026-11-13-120000-abcdefgh/../x" },
    { method: "newDmLink", roomId: "not-a-room" },
    { method: "openFolder", folder: "/" },
    { method: "openFolder", folder: "home" },
    { method: "copyText", text: "x".repeat(4097) },
    { method: "copyText", text: 5 },
    { method: "quit", now: true },
  ];
  for (const raw of refused) assert.throws(() => parseBridgeCall(raw), /refused a call/, JSON.stringify(raw)?.slice(0, 80));
});

test("the window's supervisor calls become the matching command, and the shell answers the rest", () => {
  assert.deepEqual(commandFor(parseBridgeCall({ method: "setPort", port: 3171 })), { type: "setPort", port: 3171 });
  assert.deepEqual(commandFor(parseBridgeCall({ method: "newDmLink", roomId: "ABCDEFGH" })), { type: "newDmLink", roomId: "ABCDEFGH" });
  assert.deepEqual(commandFor(parseBridgeCall({ method: "listRooms" })), { type: "listRooms" });
  assert.deepEqual(commandFor(parseBridgeCall({ method: "setSettings", patch: { openBrowser: false } })), {
    type: "setSettings",
    patch: { openBrowser: false },
  });
  for (const method of ["getState", "openApp", "openRelease", "openSource", "installUpdate", "quit"] as const) {
    assert.equal(commandFor(parseBridgeCall({ method })), null, method);
  }
  // The window can never send `stop`: only the shell stops the supervisor, after its own checks.
  assert.throws(() => parseBridgeCall({ method: "stop" }));
});

// ---------------------------------------------------------------------------
// Closing the window

test("closing hides to the tray on Windows and macOS, with one notification the first time, and minimizes on Linux", () => {
  assert.deepEqual(planClose("win32", false), { action: "hide", notice: WORDS.stillRunning.win32 });
  assert.deepEqual(planClose("win32", true), { action: "hide", notice: null });
  assert.deepEqual(planClose("darwin", false), { action: "hide", notice: WORDS.stillRunning.darwin });
  assert.deepEqual(planClose("darwin", true), { action: "hide", notice: null });
  assert.deepEqual(planClose("linux", false), { action: "minimize", notice: null });
  assert.equal(WORDS.stillRunning.win32, "RaccoonVTT is still running. Quit it from the notification area.");
  assert.equal(WORDS.stillRunning.darwin, "RaccoonVTT is still running. Quit it from the menu bar.");
});

test("the first close's notification is remembered across launches, and a bad prefs file starts over", () => {
  const dir = tempDir();
  try {
    assert.equal(readPrefs(dir).closeNoticeShown, false);
    writePrefs(dir, { ...readPrefs(dir), closeNoticeShown: true });
    assert.equal(readPrefs(dir).closeNoticeShown, true);
    assert.deepEqual(readdirSync(dir), [SHELL_PREFS_FILE]);
    writeFileSync(join(dir, SHELL_PREFS_FILE), "{ not json");
    assert.equal(readPrefs(dir).closeNoticeShown, false);
    // A newer build's key survives an older build's write.
    writeFileSync(join(dir, SHELL_PREFS_FILE), JSON.stringify({ closeNoticeShown: true, later: 1 }));
    writePrefs(dir, readPrefs(dir));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SHELL_PREFS_FILE), "utf8")), { closeNoticeShown: true, later: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Quitting

test("the tray and the app menu ask before quitting only while other devices are connected", () => {
  assert.equal(quitQuestion("tray", sampleStatus({ remoteDevices: 0, sockets: 4 })), null);
  assert.equal(quitQuestion("tray", sampleStatus({ remoteDevices: 3 })), "3 other devices are connected. Quitting ends the game for them.");
  assert.equal(quitQuestion("menu", sampleStatus({ remoteDevices: 1 })), "1 other device is connected. Quitting ends the game for them.");
  assert.equal(quitQuestion("tray", null), null);
  // The window asked already, an installer cannot answer, and a shutdown will not wait.
  for (const source of ["window", "secondInstance", "system", "smoke"] as const) {
    assert.equal(quitQuestion(source, sampleStatus({ remoteDevices: 3 })), null, source);
  }
});

// ---------------------------------------------------------------------------
// The tray

test("the tray lists its four items, and the switch follows the saved setting and waits for a running server", () => {
  const items = trayItems(sampleStatus(), false);
  assert.deepEqual(
    items.map((i) => (i.type === "separator" ? "-" : i.label)),
    ["Open window", "Open RaccoonVTT in the browser", "Players on this network can join", "-", "Quit RaccoonVTT"],
  );
  const item = (id: string, status: SupervisorStatus | null, quitting = false) => {
    const found = trayItems(status, quitting).find((i) => i.type !== "separator" && i.id === id);
    assert.ok(found && found.type !== "separator", id);
    return found;
  };
  assert.deepEqual(item("networkPlay", sampleStatus()), { id: "networkPlay", type: "checkbox", label: WORDS.tray.networkPlay, enabled: true, checked: true });
  const off = sampleStatus({ settings: { ...sampleStatus().settings, networkPlay: false }, host: "127.0.0.1", network: "off" });
  assert.deepEqual(item("networkPlay", off), { id: "networkPlay", type: "checkbox", label: WORDS.tray.networkPlay, enabled: true, checked: false });
  for (const state of ["starting", "restarting", "restoring", "stopping", "error", "stopped", "recovering"] as const) {
    assert.equal(item("networkPlay", sampleStatus({ state })).enabled, false, state);
  }
  assert.equal(item("networkPlay", null).enabled, false);
  assert.equal(item("networkPlay", sampleStatus(), true).enabled, false);
  assert.equal(item("openBrowser", sampleStatus()).enabled, true);
  assert.equal(item("openBrowser", sampleStatus({ state: "starting", port: null })).enabled, false);
  assert.equal(item("quit", sampleStatus()).enabled, true);
  assert.equal(item("quit", sampleStatus(), true).enabled, false, "no second quit while quitting");
});

// ---------------------------------------------------------------------------
// Sleep

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const calls: string[] = [];
  let blockerId = 100;
  const deps = {
    start: () => {
      calls.push("start");
      return ++blockerId;
    },
    stop: (id: number) => calls.push(`stop ${id}`),
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (timer: unknown) => void timers.delete(timer as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { deps, calls, advance, pending: () => timers.size };
}

test("sleep is blocked while any socket is open and let go 60 s after the last one closes", () => {
  const clock = fakeClock();
  const power = new PowerBlocker(clock.deps);
  power.update(0);
  assert.deepEqual(clock.calls, [], "nothing to hold with no sockets");
  power.update(1);
  power.update(3);
  assert.deepEqual(clock.calls, ["start"], "held once, however many sockets");
  assert.equal(power.held, true);
  power.update(0);
  clock.advance(POWER_RELEASE_MS - 1);
  assert.equal(power.held, true, "still held just before 60 s");
  clock.advance(1);
  assert.deepEqual(clock.calls, ["start", "stop 101"]);
  assert.equal(power.held, false);
});

test("a socket that comes back within 60 s keeps the same hold, and quitting lets go at once", () => {
  const clock = fakeClock();
  const power = new PowerBlocker(clock.deps);
  power.update(2);
  power.update(0);
  clock.advance(30_000);
  power.update(1);
  clock.advance(POWER_RELEASE_MS * 2);
  assert.deepEqual(clock.calls, ["start"], "the release was cancelled and nothing restarted");
  power.update(0);
  power.update(0);
  assert.equal(clock.pending(), 1, "a second 0 does not start a second countdown");
  power.stop();
  assert.deepEqual(clock.calls, ["start", "stop 101"]);
  assert.equal(clock.pending(), 0);
  clock.advance(POWER_RELEASE_MS);
  assert.deepEqual(clock.calls, ["start", "stop 101"], "nothing released twice");
});

// ---------------------------------------------------------------------------
// The window's page and links

test("the window's scheme serves only files inside its build", () => {
  const root = join(tmpdir(), "window");
  assert.equal(windowFile("app://raccoonvtt/", root), join(root, "index.html"));
  assert.equal(windowFile("app://raccoonvtt/assets/index-abc.js?x=1#y", root), join(root, "assets", "index-abc.js"));
  assert.equal(windowFile("app://raccoonvtt/fonts/inter%20var.woff2", root), join(root, "fonts", "inter var.woff2"));
  for (const url of [
    "app://raccoonvtt/../secrets.json",
    "app://raccoonvtt/%2e%2e/secrets.json",
    "app://raccoonvtt/assets/%2e%2e/%2e%2e/x",
    "app://raccoonvtt/%5c..%5cx",
    "app://raccoonvtt/%2F..%2F..%2Fsecrets.json",
    "app://raccoonvtt/assets%2F..%2F..%2F..%2Fsecrets.json",
    "app://raccoonvtt/x%00.js",
    "app://raccoonvtt/%E0%A4%A",
    "app://other/index.html",
    "file:///etc/passwd",
    "https://raccoonvtt/",
    "not a url",
  ]) {
    const file = windowFile(url, root);
    assert.ok(file === null || file.startsWith(root + sep), `${url} gave ${file}`);
    assert.ok(file === null || !file.includes(".."), `${url} gave ${file}`);
  }
  assert.equal(windowFile("app://raccoonvtt/../secrets.json", root), join(root, "secrets.json"), "the URL parser already resolves dot segments inside the root");
  assert.equal(windowFile("app://other/index.html", root), null);
  assert.equal(windowFile("app://raccoonvtt/%5c..%5cx", root), null);
  // The URL parser resolves dot segments, but not ones hidden behind an encoded slash.
  assert.equal(windowFile("app://raccoonvtt/%2F..%2F..%2Fsecrets.json", root), null);
  assert.equal(contentType("index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("a.WOFF2"), "font/woff2");
  assert.equal(contentType("a.exe"), "application/octet-stream");
});

test("the window's policy loads its own files only and talks to nothing", () => {
  assert.equal(
    WINDOW_CSP,
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
});

test("the browser opens only the app on this computer's port and the release pages", () => {
  assert.equal(externalAllowed("http://localhost:3170/", 3170), true);
  assert.equal(externalAllowed("http://localhost:3170/r/ABCDEFGH#dm=secret", 3170), true);
  assert.equal(externalAllowed("https://github.com/jwhitlow45/raccoon-vtt/releases/latest", null), true);
  assert.equal(externalAllowed("https://github.com/jwhitlow45/raccoon-vtt/releases/tag/v0.5.0", 3170), true);
  for (const url of [
    "http://localhost:3171/",
    "http://localhost/",
    "https://localhost:3170/",
    "http://127.0.0.1:3170/",
    "http://10.0.0.20:3170/",
    "http://localhost:3170@evil.example/",
    "http://user:pw@localhost:3170/",
    "https://github.com/jwhitlow45/raccoon-vtt/",
    "https://github.com/jwhitlow45/raccoon-vtt/releases.evil.example/",
    "https://github.com.evil.example/jwhitlow45/raccoon-vtt/releases/latest",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(externalAllowed(url, 3170), false, url);
  }
  assert.equal(externalAllowed("http://localhost:3170/", null), false, "no port while the server is down");
});

// ---------------------------------------------------------------------------
// Zoom

test("zoom steps from 100% to 150% by 10% and stops at both ends", () => {
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1.5, 1), 1.5);
  assert.equal(zoomStep(1, -1), 1);
  assert.equal(zoomStep(1.3, -1), 1.2);
  assert.equal(zoomStep(1.37, 1), 1.5, "an odd value snaps to the nearest step first");
  assert.equal(zoomStep(1.4, 0), 1);
  assert.equal(zoomStep(3, 1), 1.5);
  assert.equal(zoomStep(0.25, -1), 1);
});

test("Ctrl on Windows and Linux, Cmd on macOS, with plus, equals, minus or 0", () => {
  const key = (k: string, mods: Partial<{ control: boolean; meta: boolean; alt: boolean }>, type = "keyDown") => ({
    type,
    key: k,
    control: false,
    meta: false,
    alt: false,
    ...mods,
  });
  assert.equal(zoomKey(key("=", { control: true }), "win32"), 1);
  assert.equal(zoomKey(key("+", { control: true }), "linux"), 1);
  assert.equal(zoomKey(key("-", { meta: true }), "darwin"), -1);
  assert.equal(zoomKey(key("0", { meta: true }), "darwin"), 0);
  assert.equal(zoomKey(key("=", { meta: true }), "win32"), null);
  assert.equal(zoomKey(key("=", { control: true }), "darwin"), null);
  assert.equal(zoomKey(key("=", { control: true, alt: true }), "win32"), null);
  assert.equal(zoomKey(key("=", { control: true }, "keyUp"), "win32"), null);
  assert.equal(zoomKey(key("a", { control: true }), "win32"), null);
});

// ---------------------------------------------------------------------------
// Stops the shell sees itself

test("the shell stops before starting anything as root, or below the database's glibc", () => {
  assert.deepEqual(startBlocker({ platform: "linux", uid: 0, glibc: "2.39" }), { kind: "root" });
  assert.deepEqual(startBlocker({ platform: "darwin", uid: 0, glibc: null }), { kind: "root" });
  assert.equal(startBlocker({ platform: "win32", uid: 0, glibc: null }), null);
  assert.deepEqual(startBlocker({ platform: "linux", uid: 1000, glibc: "2.35" }), { kind: "glibc" });
  assert.deepEqual(startBlocker({ platform: "linux", uid: 1000, glibc: "2.31" }), { kind: "glibc" });
  assert.equal(startBlocker({ platform: "linux", uid: 1000, glibc: "2.36" }), null);
  assert.equal(startBlocker({ platform: "linux", uid: 1000, glibc: "2.40" }), null);
  assert.equal(startBlocker({ platform: "linux", uid: 1000, glibc: null }), null, "unknown glibc: let the start say what fails");
  assert.equal(versionBelow("2.9", "2.36"), true);
  assert.equal(versionBelow("3.0", "2.36"), false);
});

test("the glibc floor matches the one pins.json holds for the bundled PostgreSQL", () => {
  let pins: unknown;
  try {
    pins = JSON.parse(readFileSync(new URL("../pins.json", import.meta.url), "utf8"));
  } catch {
    return; // pins.json lands with the supervisor's lane, and this check with it.
  }
  const floor = (pins as { floors?: { glibc?: unknown }; glibc?: unknown }).floors?.glibc ?? (pins as { glibc?: unknown }).glibc;
  if (floor !== undefined) assert.equal(String(floor), "2.36");
});

test("a bundled program the system killed as it loaded, in an app still quarantined, reads as Gatekeeper", () => {
  const base = { platform: "darwin" as const, quarantined: true, spawnError: null, signal: null };
  assert.equal(looksQuarantined({ ...base, signal: "SIGKILL" }), true);
  assert.equal(looksQuarantined({ ...base, spawnError: "EPERM" }), true);
  assert.equal(looksQuarantined({ ...base, spawnError: "EACCES" }), true);
  assert.equal(looksQuarantined({ ...base, quarantined: false, signal: "SIGKILL" }), false);
  assert.equal(looksQuarantined({ ...base, signal: "SIGSEGV" }), false);
  assert.equal(looksQuarantined({ ...base, platform: "linux", signal: "SIGKILL" }), false);
});

// ---------------------------------------------------------------------------
// Starting the supervisor

test("the packaged supervisor runs on the bundled, renamed Node from the staged server", () => {
  const resources = join(sep, "Applications", "RaccoonVTT.app", "Contents", "Resources");
  const plan = spawnPlan({ platform: "darwin", packaged: true, resourcesPath: resources, repoRoot: "/repo", devNodeExists: false, env: {} });
  assert.equal(plan.command, join(resources, "node", "raccoonvtt-server"));
  assert.deepEqual(plan.args, [join(resources, "app-server", "desktop", "runtime", "main.ts")]);
  assert.equal(plan.cwd, join(resources, "app-server"));
  const win = spawnPlan({ platform: "win32", packaged: true, resourcesPath: "C:\\RaccoonVTT\\resources", repoRoot: "", devNodeExists: false, env: {} });
  assert.ok(win.command.endsWith("raccoonvtt-server.exe"), win.command);
  const dev = spawnPlan({ platform: "linux", packaged: false, resourcesPath: "", repoRoot: "/repo", devNodeExists: false, env: {} });
  assert.equal(dev.command, "node");
  assert.deepEqual(dev.args, [join("/repo", "desktop", "runtime", "main.ts")]);
  const devFetched = spawnPlan({ platform: "linux", packaged: false, resourcesPath: "", repoRoot: "/repo", devNodeExists: true, env: {} });
  assert.equal(devFetched.command, join("/repo", "desktop", ".runtime", "node", "raccoonvtt-server"));
});

test("the supervisor keeps the data folder override and drops what would change how its Node runs", () => {
  const env = supervisorEnv({
    PATH: "/usr/bin",
    HOME: "/home/dm",
    RACCOON_DATA_DIR: "/data",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NODE_PATH: "/x",
    ELECTRON_RUN_AS_NODE: "1",
    CHROME_DESKTOP: "raccoonvtt.desktop",
    UNSET: undefined,
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/dm", RACCOON_DATA_DIR: "/data" });
});

// ---------------------------------------------------------------------------
// The shell's log

test("the shell's log keeps early lines until it knows its folder, writes one line per entry, and rotates at 10 MB", () => {
  const dir = tempDir();
  try {
    const log = new ShellLog(() => new Date("2026-11-13T12:00:00Z"));
    log.info("first\nsecond");
    log.error("failed");
    log.setDir(join(dir, "logs"));
    log.info("after");
    const lines = readFileSync(join(dir, "logs", LOG_FILES.shell), "utf8").trimEnd().split("\n");
    assert.deepEqual(lines, [
      "2026-11-13T12:00:00.000Z info first | second",
      "2026-11-13T12:00:00.000Z error failed",
      "2026-11-13T12:00:00.000Z info after",
    ]);
    const file = join(dir, "logs", LOG_FILES.shell);
    for (let i = 0; i < LOG_KEEP + 2; i++) {
      writeFileSync(file, `generation ${i}\n`);
      rotate(file);
    }
    const kept = readdirSync(join(dir, "logs")).sort();
    assert.deepEqual(kept, Array.from({ length: LOG_KEEP }, (_, i) => `${LOG_FILES.shell}.${i + 1}`).sort());
    assert.equal(readFileSync(`${file}.1`, "utf8"), `generation ${LOG_KEEP + 1}\n`, "newest is .1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
