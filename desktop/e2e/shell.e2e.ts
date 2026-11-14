import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { WORDS, type RaccoonLocal, type WindowState } from "../contract.ts";

/**
 * The packed shell (design 12, LOCAL-4), driven through Playwright's
 * Electron support: the tray's items, the switch there and back, the
 * window's bridge, the single-instance lock's --quit, Quit leaving no
 * process behind, and a shell killed outright leaving none either.
 *
 * It runs against an `electron-builder --dir` build, by default the one
 * `node desktop/build/pack.ts --dir` leaves in desktop/out/dist, or the app
 * RACCOON_SHELL_APP names. It checks the build carries the shipped fuses,
 * then tests a copy with one fuse changed: Playwright drives Electron
 * through Node's inspector, which the shipped build turns off.
 *
 * With RACCOON_SHELL_E2E_FAKE=1 the copy gets a stand-in supervisor
 * (shellFakeSupervisor.ts) on this machine's Node, for a build made with
 * `--shell-only`, before Node and PostgreSQL are fetched and the server is
 * staged. Without it the copy runs the real supervisor, database and server.
 */

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));

/** The shell's test handle in its main process (desktop/electron/main.ts). */
type MenuItemLike = { id: string; type: string; label: string; checked: boolean; enabled: boolean; click: () => void };
type ShellHandle = {
  state(): WindowState;
  trayMenu(): { items: MenuItemLike[] } | null;
  supervisorPid(): number | null;
};
/** The window's page, seen from inside it. */
type PageGlobals = { raccoonLocal?: RaccoonLocal; require?: unknown; process?: unknown };
const FAKE = process.env.RACCOON_SHELL_E2E_FAKE === "1";
const PORT = Number(process.env.E2E_PORT ?? 40500);
const TIMEOUT = FAKE ? 30_000 : 180_000;
/** Each test's bound, so a shell that never does its part fails the test rather than hanging the run. */
const STEP_TIMEOUT = TIMEOUT + 60_000;

type Layout = { app: string; exe: string; resources: string };

function layout(app: string): Layout {
  if (process.platform === "darwin") {
    return { app, exe: join(app, "Contents", "MacOS", "RaccoonVTT"), resources: join(app, "Contents", "Resources") };
  }
  const exe = join(app, process.platform === "win32" ? "RaccoonVTT.exe" : "raccoonvtt");
  return { app, exe, resources: join(app, "resources") };
}

function builtApp(): string {
  if (process.env.RACCOON_SHELL_APP) return process.env.RACCOON_SHELL_APP;
  const dist = join(DESKTOP, "out", "dist");
  const arm = process.arch === "arm64";
  if (process.platform === "darwin") return join(dist, arm ? "mac-arm64" : "mac", "RaccoonVTT.app");
  if (process.platform === "win32") return join(dist, "win-unpacked");
  return join(dist, arm ? "linux-arm64-unpacked" : "linux-unpacked");
}

/** Every process running a program from under `dir`: the shell, its helpers, the supervisor and PostgreSQL alike. */
function processesUnder(dir: string): string[] {
  if (process.platform === "win32") {
    const script = `$d = $env:RACCOON_E2E_DIR; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessId) $(if ($_.CommandLine) { $_.CommandLine } else { $_.ExecutablePath })" }`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, RACCOON_E2E_DIR: dir },
    });
    return out.split(/\r?\n/).filter((l) => l.trim());
  }
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(dir));
}

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeout = TIMEOUT): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A private IPv4 address of this machine other than loopback, to check what the switch binds. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

describe("the packed shell", () => {
  const work = mkdtempSync(join(tmpdir(), "raccoonvtt-shell-e2e-"));
  const data = join(work, "data");
  const profile = join(work, "profile");
  const shipped = layout(builtApp());
  let copy: Layout;
  let app: ElectronApplication | null = null;
  let page: Page;

  const env = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ELECTRON_RUN_AS_NODE") out[k] = v;
    return { ...out, RACCOON_DATA_DIR: data };
  };
  const state = async (): Promise<WindowState> => {
    assert.ok(app);
    return app.evaluate(() => (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.state());
  };
  /** The tray menu's items as Electron holds them: label, checked, enabled. */
  const trayMenu = async () => {
    assert.ok(app);
    return app.evaluate(() => {
      const menu = (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.trayMenu();
      return (menu?.items ?? []).map((i) => ({ id: i.id, type: i.type, label: i.label, checked: i.checked, enabled: i.enabled }));
    });
  };
  const clickTray = async (id: string) => {
    assert.ok(app);
    await app.evaluate((_electron, itemId) => {
      const menu = (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.trayMenu();
      const item = menu?.items.find((i) => i.id === itemId);
      if (!item) throw new Error(`no tray item ${itemId}`);
      item.click();
    }, id);
  };
  const policyViolations: string[] = [];
  const launch = async () => {
    app = await _electron.launch({ executablePath: copy.exe, args: [`--user-data-dir=${profile}`], env: env(), timeout: TIMEOUT });
    page = await app.firstWindow({ timeout: TIMEOUT });
    page.on("console", (message) => {
      if (/Content.Security.Policy/i.test(message.text())) policyViolations.push(message.text());
    });
    await until("the supervisor to run", async () => (await state()).supervisor?.state === "running");
  };
  /**
   * The real supervisor stopped as design 10 says: PostgreSQL shut down
   * cleanly, then the supervisor itself exited with code 0. The stand-in
   * has neither, and logs the channel closing instead.
   */
  const stoppedCleanly = () => {
    const last = (file: string) => readFileSync(join(data, "logs", file), "utf8").trimEnd().split(/\r?\n/).at(-1) ?? "";
    assert.match(last("supervisor.log"), /exiting with code 0$/);
    assert.match(last("postgres.log"), /database system is shut down$/);
  };
  /** Every process under the copy ended, or the error names those left, with the logs' last lines. */
  const allEnded = async (): Promise<void> => {
    try {
      await until("every process to end", async () => processesUnder(copy.app).length === 0, 30_000);
    } catch (err) {
      const tail = (file: string): string => {
        try {
          return readFileSync(join(data, "logs", file), "utf8").trimEnd().split(/\r?\n/).slice(-10).join("\n");
        } catch {
          return "(no file)";
        }
      };
      const left = processesUnder(copy.app).join("\n");
      throw new Error(`${(err as Error).message}. Left:\n${left}\nsupervisor.log ends:\n${tail("supervisor.log")}\nshell.log ends:\n${tail("shell.log")}`);
    }
  };
  const exited = (a: ElectronApplication) =>
    new Promise<number | null>((resolve) => {
      const child = a.process();
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("exit", (code) => resolve(code));
    });

  before(async () => {
    assert.ok(existsSync(shipped.exe), `no packed app at ${shipped.app}: run node desktop/build/pack.ts --dir first`);
    const fuses = (await import(pathToFileURL(join(DESKTOP, "build", "fuses.mjs")).href)) as {
      fuseDifferences(exe: string): Promise<string[]>;
      allowInspectForTests(exe: string, resetAdHocDarwinSignature: boolean): Promise<void>;
    };
    assert.deepEqual(await fuses.fuseDifferences(shipped.exe), [], "the packed build carries the shipped fuses");

    copy = layout(join(work, process.platform === "darwin" ? "RaccoonVTT.app" : "app"));
    cpSync(shipped.app, copy.app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    if (FAKE) {
      const appServer = join(copy.resources, "app-server");
      mkdirSync(join(appServer, "desktop", "runtime"), { recursive: true });
      writeFileSync(join(appServer, "package.json"), JSON.stringify({ type: "module" }));
      cpSync(join(DESKTOP, "e2e", "shellFakeSupervisor.ts"), join(appServer, "desktop", "runtime", "main.ts"));
      mkdirSync(join(copy.resources, "node"), { recursive: true });
      if (process.platform === "win32") {
        cpSync(process.execPath, join(copy.resources, "node", "raccoonvtt-server.exe"));
      } else {
        // This machine's Node may load libraries from beside itself, so a
        // copy of it would not start: a script that runs it in place does.
        const launcher = join(copy.resources, "node", "raccoonvtt-server");
        writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
      }
    } else {
      assert.ok(existsSync(join(copy.resources, "app-server", "desktop", "runtime", "main.ts")), "the build has no staged server: pack without --shell-only, or set RACCOON_SHELL_E2E_FAKE=1");
    }
    await fuses.allowInspectForTests(copy.exe, process.platform === "darwin");

    mkdirSync(data, { recursive: true });
    // A port of this lane's own, no browser opening on the machine running
    // the test, and no requests to GitHub.
    writeFileSync(join(data, "settings.json"), JSON.stringify({ port: PORT, networkPlay: true, openBrowser: false, checkUpdates: false }));
    await launch();
  });

  after(async () => {
    if (app && app.process().exitCode === null) await app.close().catch(() => {});
    // Whatever a failed run left: only this test's own copy, by its path.
    for (const line of processesUnder(work)) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    // Windows ends a killed process after the call returns, and its files stay open until then.
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  });

  test("the tray holds its four items, and the switch shows the saved setting", { timeout: STEP_TIMEOUT }, async () => {
    const items = await trayMenu();
    assert.deepEqual(
      items.map((i) => (i.type === "separator" ? "-" : i.label)),
      [WORDS.tray.openWindow, WORDS.tray.openBrowser, WORDS.tray.networkPlay, "-", WORDS.tray.quit],
    );
    const toggle = items.find((i) => i.id === "networkPlay");
    assert.deepEqual({ type: toggle?.type, checked: toggle?.checked, enabled: toggle?.enabled }, { type: "checkbox", checked: true, enabled: true });
  });

  test("the switch in the tray turns players off and the window's bridge turns them back on", { timeout: STEP_TIMEOUT }, async () => {
    const before = (await state()).supervisor;
    const lan = FAKE || before?.network !== "open" ? null : lanAddress();
    if (lan) assert.equal(await reachable(`http://${lan}:${PORT}/healthz`), true, "players reach it before");
    await clickTray("networkPlay");
    const off = await until("players off", async () => {
      const s = (await state()).supervisor;
      return s?.state === "running" && s.settings.networkPlay === false ? s : null;
    });
    assert.equal(off.host, "127.0.0.1");
    assert.equal(off.shareOrigin, null);
    assert.equal((await trayMenu()).find((i) => i.id === "networkPlay")?.checked, false);
    if (lan) {
      assert.equal(await reachable(`http://${lan}:${PORT}/healthz`), false, "players can't reach it");
      assert.equal(await reachable(`http://127.0.0.1:${PORT}/healthz`), true, "this computer still can");
    }

    const result = await page.evaluate(() => (globalThis as unknown as PageGlobals).raccoonLocal?.setNetworkPlay(true));
    assert.deepEqual(result, { ok: true, value: {} });
    const on = await until("players on", async () => {
      const s = (await state()).supervisor;
      return s?.state === "running" && s.settings.networkPlay === true ? s : null;
    });
    // A runner whose network Windows calls public keeps players out with the
    // switch on (design 6), and says so.
    assert.equal(on.host, on.network === "open" ? "0.0.0.0" : "127.0.0.1", `network ${on.network}`);
    assert.equal((await trayMenu()).find((i) => i.id === "networkPlay")?.checked, true);
    if (lan && on.network === "open") assert.equal(await reachable(`http://${lan}:${PORT}/healthz`), true, "players reach it again");
  });

  test("the window's page reaches nothing but the bridge, and the bridge refuses calls off the contract", { timeout: STEP_TIMEOUT }, async () => {
    const sandboxed = await page.evaluate(() => {
      const page = globalThis as unknown as PageGlobals;
      return { require: typeof page.require, process: typeof page.process, bridge: Object.keys(page.raccoonLocal ?? {}).length };
    });
    assert.deepEqual(sandboxed, { require: "undefined", process: "undefined", bridge: 19 });
    const refused = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as PageGlobals).raccoonLocal as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const outcomes: string[] = [];
      for (const [method, arg] of [
        ["setPort", 80],
        ["setNetworkPlay", "yes"],
        ["restore", "../../secrets.json"],
        ["copyText", "x".repeat(5000)],
      ] as const) {
        outcomes.push(
          await bridge[method]!(arg).then(
            () => `${method} accepted`,
            () => `${method} refused`,
          ),
        );
      }
      return outcomes;
    });
    assert.deepEqual(refused, ["setPort refused", "setNetworkPlay refused", "restore refused", "copyText refused"]);
    const s = await state();
    assert.equal(s.supervisor?.settings.networkPlay, true, "nothing a refused call asked for happened");
  });

  test("the window's page loads from the shell's scheme under its policy, on the real bridge", { timeout: STEP_TIMEOUT }, async (t) => {
    // A build made before the window's page existed serves only a 404 here.
    const loaded = await page.evaluate(() => (globalThis as unknown as { document: { title: string } }).document.title === "RaccoonVTT");
    if (!loaded) {
      t.skip("this build has no window page (desktop/out/window was empty when it was packed)");
      return;
    }
    assert.ok(page.url().startsWith("app://raccoonvtt/"), page.url());
    await until("the page to draw", async () =>
      page.evaluate(() => ((globalThis as unknown as { document: { getElementById(id: string): { childElementCount: number } | null } }).document.getElementById("root")?.childElementCount ?? 0) > 0),
    );
    const usesFake = await page.evaluate(() => "fakeBridge" in (globalThis as object));
    assert.equal(usesFake, false, "the page found the preload's bridge and never loaded the fake");
    assert.deepEqual(policyViolations, [], "nothing the page loads breaks its Content-Security-Policy");
  });

  test("a supervisor that dies shows its last words, and Try again starts a new one", { timeout: STEP_TIMEOUT }, async () => {
    assert.ok(app);
    const pid = await app.evaluate(() => (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.supervisorPid());
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    const crashed = await until("the crash to show", async () => {
      const s = await state();
      return s.shell.error?.kind === "serverCrashed" ? s.shell.error : null;
    });
    assert.ok(crashed.kind === "serverCrashed" && crashed.logLine.length > 0, "the log's last line, for the window's words");
    assert.equal((await trayMenu()).find((i) => i.id === "networkPlay")?.enabled, false, "the switch waits for a running server");
    const retried = await page.evaluate(() => (globalThis as unknown as PageGlobals).raccoonLocal?.retry());
    assert.deepEqual(retried, { ok: true, value: {} });
    await until("a new supervisor to run", async () => {
      const s = await state();
      return s.shell.error === null && s.supervisor?.state === "running";
    });
    const newPid = await app.evaluate(() => (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.supervisorPid());
    assert.ok(newPid && newPid !== pid);
  });

  test("--quit from a second launch quits the running copy cleanly, and leaves no process", { timeout: STEP_TIMEOUT }, async () => {
    assert.ok(app);
    const running = app;
    const done = exited(running);
    const second = spawn(copy.exe, [`--user-data-dir=${profile}`, "--quit"], { env: env(), stdio: "ignore" });
    const secondCode = await new Promise<number | null>((resolve) => second.once("exit", resolve));
    assert.equal(secondCode, 0, "the second launch hands over and exits");
    assert.equal(await done, 0);
    app = null;
    await allEnded();
    const log = readFileSync(join(data, "logs", "shell.log"), "utf8");
    assert.match(log, /quitting \(secondInstance\)/);
    assert.doesNotMatch(log, /did not report stopped/);
    if (!FAKE) stoppedCleanly();
  });

  test("--quit with nothing running exits at once and starts nothing", { timeout: STEP_TIMEOUT }, async () => {
    const started = Date.now();
    const lone = spawn(copy.exe, [`--user-data-dir=${profile}`, "--quit"], { env: env(), stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => lone.once("exit", resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
    assert.deepEqual(processesUnder(copy.app), []);
  });

  test("Quit in the tray stops the supervisor first and leaves no process", { timeout: STEP_TIMEOUT }, async () => {
    await launch();
    assert.ok(app);
    const running = app;
    const supervisorPid = await running.evaluate(() => (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.supervisorPid());
    assert.ok(supervisorPid, "the supervisor runs");
    const done = exited(running);
    await clickTray("quit");
    assert.equal(await done, 0);
    app = null;
    await allEnded();
    const supervisorLog = readFileSync(join(data, "logs", "supervisor.log"), "utf8");
    if (FAKE) assert.match(supervisorLog, /command stop[\s\S]*channel closed/, "stop came first, then the channel closed");
    else stoppedCleanly();
    assert.doesNotMatch(readFileSync(join(data, "logs", "shell.log"), "utf8"), /did not report stopped/);
  });

  test("a shell killed outright leaves a supervisor that sees its channel close and stops as Quit does", { timeout: STEP_TIMEOUT }, async () => {
    await launch();
    assert.ok(app);
    const shellPid = app.process().pid;
    assert.ok(shellPid);
    const supervisorPid = await app.evaluate(() => (globalThis as unknown as { raccoonShellForTests: ShellHandle }).raccoonShellForTests.supervisorPid());
    assert.ok(supervisorPid, "the supervisor runs");
    // As taskkill /F does on Windows: no stop is sent, only the channel ends.
    process.kill(shellPid, "SIGKILL");
    app = null;
    await allEnded();
    if (FAKE) assert.match(readFileSync(join(data, "logs", "supervisor.log"), "utf8").trimEnd().split("\n").at(-1) ?? "", /channel closed$/);
    else stoppedCleanly();
  });
});
