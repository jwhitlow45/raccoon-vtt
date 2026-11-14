import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, powerMonitor, powerSaveBlocker, shell } from "electron";
import {
  APP_NAME,
  BRIDGE_CHANNEL,
  CommandValue,
  LOG_FILES,
  STATE_CHANNEL,
  WORDS,
  type AppError,
  type BridgeCall,
  type BridgeResult,
  type Command,
  type Platform,
  type SupervisorStatus,
  type UpdateState,
  type WindowState,
} from "../contract.ts";
import { parseShellArgs, secondInstanceWantsQuit, type SecondInstanceData } from "../shell/args.ts";
import { commandFor, parseBridgeCall } from "../shell/bridge.ts";
import { planClose } from "../shell/close.ts";
import { APP_ID } from "../shell/identity.ts";
import { ShellLog } from "../shell/log.ts";
import { appPage, externalAllowed } from "../shell/navigation.ts";
import { looksQuarantined, startBlocker } from "../shell/platform.ts";
import { PowerBlocker } from "../shell/power.ts";
import { readPrefs, writePrefs, type ShellPrefs } from "../shell/prefs.ts";
import { STOP_TIMEOUT_MS, quitQuestion, type QuitSource } from "../shell/quit.ts";
import { SupervisorLink, failureReason, spawnPlan, type ExitInfo, type SupervisorChannel } from "../shell/supervisor.ts";
import { trayItems } from "../shell/tray.ts";
import { LATEST_RELEASE_PAGE, sourcePage } from "../shell/updates.ts";
import { ShellTray } from "./tray.ts";
import { Updates } from "./updater.ts";
import { createWindow, fromWindow, lockDown, registerAppScheme, serveWindow } from "./window.ts";

/**
 * The shell (design 2 and 9): the tray, the window, the single-instance
 * lock, updates and the power blocker. Everything else, the database, the
 * app server, backups and the network, is the supervisor's, which the shell
 * starts and talks to over Node's IPC channel. The shell stays thin so that
 * a hang or crash here never takes a game down with it.
 */

const platform = process.platform as Platform;
const args = parseShellArgs(process.argv);
const log = new ShellLog();

/** How long --smoke waits for the supervisor to run before it fails (a first start runs initdb). */
const SMOKE_TIMEOUT_MS = 4 * 60_000;
/** How long a quit waits for the supervisor's process to end once it has stopped. */
const EXIT_WAIT_MS = 10_000;

let win: BrowserWindow | null = null;
let tray: ShellTray | null = null;
let updates: Updates | null = null;
let prefs: ShellPrefs = { closeNoticeShown: false };
let supervisor: { link: SupervisorLink; child: ChildProcess } | null = null;
/** The newest status, kept after the supervisor exits, so the window still shows its last words. */
let lastStatus: SupervisorStatus | null = null;
let shellError: AppError | null = null;
/** Root or an old glibc: nothing starts, and Try again cannot change that. */
let shellBlocker: AppError | null = null;
let update: UpdateState = { state: "none" };
let clockOffset: number | null = null;
let shuttingDown = false;
/** The shell asked the supervisor to stop (a quit or an install), so its exit is no crash. */
let stopRequested = false;
let browserOpened = false;
let windowLoaded = false;
let smokePassed = false;

const power = new PowerBlocker({
  start: () => powerSaveBlocker.start("prevent-app-suspension"),
  stop: (id) => powerSaveBlocker.stop(id),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

// ---------------------------------------------------------------------------
// Before the app is ready

// Windows: Electron's profile beside the data folder in %LOCALAPPDATA%, not
// in the roaming %APPDATA%, which a roaming profile copies at every sign-in
// (the reason D-261113-059 gives for the data folder).
if (platform === "win32" && process.env.LOCALAPPDATA && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(process.env.LOCALAPPDATA, APP_NAME, "shell"));
}
registerAppScheme();
app.enableSandbox();

if (!app.requestSingleInstanceLock({ quit: args.quit } satisfies SecondInstanceData)) {
  // Another copy runs: it got this launch's arguments, --quit included.
  app.exit(0);
} else if (args.quit) {
  // Nothing of this user's runs, so there is nothing to quit and nothing to
  // start (D-261113-099). The installer's wait does the rest.
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv, _cwd, data) => {
    if (secondInstanceWantsQuit(argv, data)) {
      void quit("secondInstance");
      return;
    }
    showWindow();
    openApp();
  });
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void quit("menu");
  });
  // The window only ever hides, but if it is ever gone, RaccoonVTT keeps running in the tray.
  app.on("window-all-closed", () => {});
  app.on("activate", () => showWindow());
  process.on("uncaughtException", (error) => {
    log.error(`uncaught: ${error.stack ?? String(error)}`);
    if (args.smoke) app.exit(1);
  });
  app.whenReady().then(ready, (error: unknown) => {
    log.error(`could not start: ${String(error)}`);
    app.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Start

function ready(): void {
  log.info(`RaccoonVTT ${app.getVersion()} shell starting on ${platform} ${process.arch}${args.smoke ? " (smoke)" : ""}`);
  if (platform === "win32") app.setAppUserModelId(APP_ID);
  prefs = readPrefs(app.getPath("userData"));
  serveWindow(join(__dirname, "..", "window"));
  lockDown(currentPort, platform);
  setAppMenu();
  ipcMain.handle(BRIDGE_CHANNEL, (event, raw: unknown) => {
    if (!fromWindow(win, event.sender, event.senderFrame?.url)) throw new Error("RaccoonVTT refused a call from outside its window");
    return answer(parseBridgeCall(raw));
  });

  win = createWindow(join(__dirname, "..", "preload", "preload.cjs"), platform === "linux" ? iconFile("icon.png") : undefined);
  win.on("close", onWindowClose);
  // Windows signing out or shutting down: stop the database cleanly while it waits.
  win.on("session-end", () => void quit("system"));
  win.webContents.on("did-finish-load", () => {
    windowLoaded = true;
    pushState();
    smokeCheck();
  });

  tray = new ShellTray(iconDir(), platform, {
    openWindow: showWindow,
    openBrowser: openApp,
    setNetworkPlay: (on) => void sendCommand({ type: "setNetworkPlay", on }),
    quit: () => void quit("tray"),
  });
  refreshTray();

  // Linux and macOS: hold the shutdown long enough to stop the database
  // cleanly. Electron passes the event, though its type says it does not.
  powerMonitor.on("shutdown", (event?: Electron.Event) => {
    event?.preventDefault();
    void quit("system");
  });

  updates = new Updates({
    platform,
    arch: process.arch,
    version: app.getVersion(),
    env: process.env,
    log,
    setUpdate: (state) => {
      update = state;
      pushState();
    },
    setClockOffset: (minutes) => {
      if (minutes === clockOffset) return;
      clockOffset = minutes;
      if (minutes !== null) log.info(`this computer's clock is ${minutes} minutes off`);
      pushState();
    },
    stopSupervisor: stopSupervisor,
    beforeInstall: () => {
      shuttingDown = true;
      power.stop();
      tray?.destroy();
    },
  });

  if (args.smoke) {
    setTimeout(() => {
      log.error("smoke: RaccoonVTT did not reach Running in time");
      void quit("smoke");
    }, SMOKE_TIMEOUT_MS).unref();
  }

  shellBlocker = startBlocker({ platform, uid: process.getuid?.() ?? null, glibc: glibcRuntime() });
  if (shellBlocker) {
    log.error(`not starting: ${shellBlocker.kind}`);
    setShellError(shellBlocker);
    if (args.smoke) void quit("smoke");
    return;
  }
  startSupervisor();
}

function glibcRuntime(): string | null {
  if (platform !== "linux") return null;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ?? null;
}

function iconDir(): string {
  return join(app.getAppPath(), "build", "icons");
}

function iconFile(name: string): string {
  return join(iconDir(), name);
}

/**
 * macOS needs an app menu for Cmd+Q, Hide and the Edit shortcuts, which
 * work only through menu items there. Windows and Linux get none: the
 * window's page has every control, and Electron's default menu would add
 * reload and developer tools.
 */
function setAppMenu(): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: WORDS.tray.quit, accelerator: "Command+Q", click: () => void quit("menu") },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

// ---------------------------------------------------------------------------
// The supervisor

function startSupervisor(): void {
  const plan = spawnPlan({
    platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: join(__dirname, "..", "..", ".."),
    devNodeExists: existsSync(join(__dirname, "..", "..", ".runtime", "node")),
    env: process.env,
  });
  log.info(`starting the supervisor: ${plan.command}`);
  let spawnError: string | null = null;
  // Detached with its IPC channel kept (D-261113-088): on Windows that puts
  // it outside the shell's job object, so a shell that is killed outright
  // leaves it alive just long enough to see the channel close and stop the
  // server and PostgreSQL cleanly.
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  const stderrTail: string[] = [];
  const keep = (stream: NodeJS.ReadableStream | null, name: string) => {
    if (!stream) return;
    stream.setEncoding("utf8");
    let partial = "";
    stream.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        log.info(`supervisor ${name}: ${line}`);
        if (name === "stderr") {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      }
    });
  };
  keep(child.stdout, "stdout");
  keep(child.stderr, "stderr");
  child.on("error", (error: NodeJS.ErrnoException) => {
    log.error(`supervisor process: ${error.message}`);
    // A spawn that failed never emits exit, so the link hears it from here.
    if (child.pid === undefined) {
      spawnError = error.code ?? "ERROR";
      for (const listener of exitListeners) listener(null, null);
    }
  });
  child.on("exit", (code, signal) => {
    for (const listener of exitListeners) listener(code, signal);
  });
  const channel: SupervisorChannel = {
    send: (message) => (child.connected ? child.send(message) : false),
    onMessage: (listener) => void child.on("message", listener),
    onExit: (listener) => void exitListeners.push(listener),
    disconnect: () => child.disconnect(),
    get connected() {
      return child.connected;
    },
  };
  const link = new SupervisorLink(channel, {
    onStatus,
    onExit: (info) => void onSupervisorExit(link, info, spawnError, stderrTail),
    log: (message) => log.error(message),
  });
  supervisor = { link, child };
}

function onStatus(status: SupervisorStatus): void {
  const hadError = lastStatus?.error ?? null;
  lastStatus = status;
  log.setDir(status.paths.logs);
  power.update(status.sockets);
  if (status.state === "running" && status.port !== null) {
    if (!browserOpened) {
      browserOpened = true;
      if (!args.smoke && status.settings.openBrowser) openApp();
      if (!args.smoke) updates?.start(() => lastStatus?.settings.checkUpdates ?? false);
    }
  }
  // A new stop shows the window, wherever it was hidden, since only the window explains it.
  if (status.error && !hadError) showWindow();
  refreshTray();
  pushState();
  smokeCheck();
}

async function onSupervisorExit(link: SupervisorLink, info: ExitInfo, spawnError: string | null, stderrTail: readonly string[]): Promise<void> {
  if (supervisor?.link === link) supervisor = null;
  power.update(0);
  refreshTray();
  if (shuttingDown || stopRequested) return;
  log.error(`the supervisor exited (code ${info.code}, signal ${info.signal ?? "none"})`);
  // A supervisor that stopped on one of its own errors said why in its last status.
  if (lastStatus?.error) {
    pushState();
  } else {
    const quarantined = platform === "darwin" && !info.hadStatus ? await hasQuarantine() : false;
    if (looksQuarantined({ platform, quarantined, spawnError, signal: info.signal })) setShellError({ kind: "quarantine" });
    else setShellError({ kind: "serverCrashed", logLine: await lastLogLine(stderrTail, info, spawnError) });
  }
  if (args.smoke) void quit("smoke");
}

/** The supervisor's last words: supervisor.log's last line, else what it printed, else how it ended. */
async function lastLogLine(stderrTail: readonly string[], info: ExitInfo, spawnError: string | null): Promise<string> {
  if (lastStatus) {
    try {
      const handle = await open(join(lastStatus.paths.logs, LOG_FILES.supervisor), "r");
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, 8192);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const line = buffer.toString("utf8").split(/\r?\n/).filter((l) => l.trim()).at(-1);
        if (line) return line;
      } finally {
        await handle.close();
      }
    } catch {
      // No log yet: fall back to what it printed.
    }
  }
  const printed = stderrTail.at(-1);
  if (printed) return printed;
  if (spawnError) return `it could not be started (${spawnError})`;
  return info.signal ? `it ended on ${info.signal}` : `it exited with code ${info.code}`;
}

/** Whether this app bundle still carries the quarantine mark from its download. */
function hasQuarantine(): Promise<boolean> {
  const bundle = dirname(dirname(dirname(process.execPath)));
  return new Promise((resolve) => execFile("/usr/bin/xattr", ["-p", "com.apple.quarantine", bundle], (error) => resolve(!error)));
}

function setShellError(error: AppError | null): void {
  shellError = error;
  if (error) showWindow();
  pushState();
}

async function sendCommand(command: Command): Promise<BridgeResult<unknown>> {
  if (!supervisor) return { ok: false, failure: { error: "notRunning" } };
  const result = await supervisor.link.command(command);
  if (!result.ok) log.info(`${command.type}: ${failureReason(result.failure)}`);
  return result;
}

async function stopSupervisor(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!supervisor) return { ok: true };
  stopRequested = true;
  const result = await supervisor.link.stop(STOP_TIMEOUT_MS);
  // A supervisor that would not stop is still running, so its later exit is news again.
  if (!result.ok) stopRequested = false;
  return result;
}

// ---------------------------------------------------------------------------
// The window

function windowState(): WindowState {
  return {
    shell: { platform, version: app.getVersion(), update, clockOffsetMinutes: clockOffset, error: shellError },
    supervisor: lastStatus,
  };
}

function pushState(): void {
  if (!win || win.isDestroyed() || !windowLoaded) return;
  win.webContents.send(STATE_CHANNEL, windowState());
}

function refreshTray(): void {
  tray?.update(trayItems(supervisor ? lastStatus : null, shuttingDown));
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function onWindowClose(event: Electron.Event): void {
  if (shuttingDown || !win) return;
  event.preventDefault();
  const plan = planClose(platform, prefs.closeNoticeShown);
  if (plan.action === "minimize") win.minimize();
  else win.hide();
  if (plan.notice && Notification.isSupported()) {
    new Notification({ title: APP_NAME, body: plan.notice }).show();
    prefs = { ...prefs, closeNoticeShown: true };
    try {
      writePrefs(app.getPath("userData"), prefs);
    } catch (error) {
      log.error(`could not save shell.json: ${String(error)}`);
    }
  }
}

function currentPort(): number | null {
  return supervisor && lastStatus?.state === "running" ? lastStatus.port : null;
}

function openApp(): void {
  const port = currentPort();
  if (port !== null) void shell.openExternal(appPage(port));
}

/** One call from the window, already parsed against the contract. */
async function answer(call: BridgeCall): Promise<unknown> {
  const command = commandFor(call);
  if (command) {
    // Try again after the supervisor itself has gone starts a new one, with
    // the old one's words cleared. A running supervisor retries on its own.
    if (command.type === "retry" && !supervisor && !shuttingDown && shellBlocker === null) {
      lastStatus = null;
      stopRequested = false;
      setShellError(null);
      startSupervisor();
      return { ok: true, value: {} };
    }
    const result = await sendCommand(command);
    if (!result.ok) return result;
    switch (command.type) {
      case "listBackups":
        return { ok: true, value: CommandValue.listBackups.parse(result.value) };
      case "listRooms":
        return { ok: true, value: CommandValue.listRooms.parse(result.value) };
      case "newDmLink": {
        // The link is a DM's whole access to a room, so it goes straight to
        // the browser and never to the window or the log.
        const { link } = CommandValue.newDmLink.parse(result.value);
        if (externalAllowed(link, lastStatus?.port ?? null)) await shell.openExternal(link);
        else log.error("refused to open a new DM link that is not on this computer's address");
        return { ok: true, value: {} };
      }
      default:
        return { ok: true, value: {} };
    }
  }
  switch (call.method) {
    case "getState":
      return windowState();
    case "openApp":
      openApp();
      return undefined;
    case "openFolder": {
      const folder = lastStatus?.paths[call.folder];
      if (folder) {
        const problem = await shell.openPath(folder);
        if (problem) log.error(`could not open the ${call.folder} folder: ${problem}`);
      }
      return undefined;
    }
    case "openRelease":
      await shell.openExternal(LATEST_RELEASE_PAGE);
      return undefined;
    case "openSource":
      await shell.openExternal(sourcePage(app.getVersion()));
      return undefined;
    case "installUpdate":
      return updates?.install() ?? { ok: false, failure: { error: "notRunning" } };
    case "copyText":
      clipboard.writeText(call.text);
      return undefined;
    case "quit":
      void quit("window");
      return undefined;
    default:
      throw new Error(`RaccoonVTT has no answer for ${call.method}`);
  }
}

// ---------------------------------------------------------------------------
// Quitting

/**
 * Stops the supervisor and waits for its stopped report (the app server
 * closed, PostgreSQL shut down cleanly) before the shell leaves, so Quit
 * never leaves a process behind or a database to recover.
 */
async function quit(source: QuitSource): Promise<void> {
  if (shuttingDown) return;
  const question = quitQuestion(source, supervisor ? lastStatus : null);
  if (question) {
    showWindow();
    const options = {
      type: "question" as const,
      message: question,
      buttons: [WORDS.quit.quit, WORDS.quit.keepRunning],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (response !== 0 || shuttingDown) return;
  }
  shuttingDown = true;
  stopRequested = true;
  log.info(`quitting (${source})`);
  updates?.stop();
  power.stop();
  refreshTray();
  const running = supervisor;
  if (running) {
    const stopped = await running.link.stop(STOP_TIMEOUT_MS);
    if (!stopped.ok) log.error(`the supervisor did not report stopped: ${stopped.reason}`);
    running.link.disconnect();
    await Promise.race([running.link.waitForExit(), new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS))]);
  }
  tray?.destroy();
  app.exit(source === "smoke" && !smokePassed ? 1 : 0);
}

/**
 * --smoke (design 11.3): passes once the window has loaded and the
 * supervisor reports Running, then quits cleanly with code 0. Any stop
 * fails it with code 1.
 */
function smokeCheck(): void {
  if (!args.smoke || shuttingDown) return;
  if (lastStatus?.error || shellError) {
    log.error(`smoke: stopped with ${lastStatus?.error?.kind ?? shellError?.kind}`);
    void quit("smoke");
    return;
  }
  if (windowLoaded && lastStatus?.state === "running") {
    smokePassed = true;
    log.info("smoke: running");
    void quit("smoke");
  }
}

// The e2e test (desktop/e2e/shell.e2e.ts) drives a packaged build through
// Node's inspector, which the shipped build's fuses turn off (design 6.6).
// This is what it reads and clicks there.
Object.assign(globalThis, {
  raccoonShellForTests: {
    state: () => windowState(),
    trayMenu: () => tray?.menu ?? null,
    supervisorPid: () => supervisor?.child.pid ?? null,
    powerHeld: () => power.held,
  },
});
