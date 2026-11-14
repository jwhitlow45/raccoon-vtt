/**
 * A stand-in for desktop/runtime/main.ts, for desktop/e2e/shell.e2e.ts when
 * it runs with RACCOON_SHELL_E2E_FAKE=1: a packed shell can then be tested
 * before the bundled Node, PostgreSQL and staged server exist on the machine.
 * It speaks the contract's IPC (`ShellToSupervisor`, `SupervisorToShell`)
 * and nothing more: no database, no server, no network. The test copies it
 * into the packed app as `app-server/desktop/runtime/main.ts`, so it imports
 * nothing but types.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, Settings, ShellToSupervisor, SupervisorStatus, SupervisorToShell } from "../contract.ts";

const data = process.env.RACCOON_DATA_DIR;
if (!data || !process.send) {
  console.error("the fake supervisor needs RACCOON_DATA_DIR and an IPC channel");
  process.exit(2);
}
const logs = join(data, "logs");
mkdirSync(logs, { recursive: true });
const log = (line: string) => appendFileSync(join(logs, "supervisor.log"), `${new Date().toISOString()} fake ${line}\n`);

const settingsFile = join(data, "settings.json");
let settings: Settings = { networkPlay: true, checkUpdates: true, openBrowser: true, animatedMaps: true, roomSound: true, port: 3170 };
try {
  settings = { ...settings, ...(JSON.parse(readFileSync(settingsFile, "utf8")) as Partial<Settings>) };
} catch {
  // A first start: the defaults.
}
const port = settings.port ?? 3170;

let status: SupervisorStatus = {
  state: "starting",
  step: "startServer",
  appVersion: "0.0.0",
  settings,
  port,
  host: null,
  network: settings.networkPlay ? "open" : "off",
  shareOrigin: null,
  otherAddresses: [],
  firewallRule: null,
  sockets: 0,
  remoteDevices: 0,
  backingUp: false,
  lastBackup: null,
  restore: null,
  error: null,
  notice: null,
  paths: { data, backups: join(data, "backups"), logs },
};

function send(message: SupervisorToShell): void {
  process.send?.(message);
}

function set(change: Partial<SupervisorStatus>): void {
  status = { ...status, ...change };
  send({ type: "status", status });
}

function running(): void {
  set({
    state: "running",
    step: "running",
    host: status.settings.networkPlay ? "0.0.0.0" : "127.0.0.1",
    network: status.settings.networkPlay ? "open" : "off",
    shareOrigin: status.settings.networkPlay ? `http://10.0.0.20:${port}` : null,
  });
}

function answer(id: number, command: Command): void {
  log(`command ${command.type}`);
  switch (command.type) {
    case "setNetworkPlay": {
      const next = { ...status.settings, networkPlay: command.on };
      writeFileSync(settingsFile, JSON.stringify(next));
      set({ state: "restarting", step: command.on ? "openToNetwork" : "closeToNetwork", settings: next, host: null });
      setTimeout(() => {
        running();
        send({ type: "result", id, outcome: { ok: true, value: {} } });
      }, 300);
      return;
    }
    case "listRooms":
      send({ type: "result", id, outcome: { ok: true, value: { rooms: [] } } });
      return;
    case "listBackups":
      send({ type: "result", id, outcome: { ok: true, value: { backups: [] } } });
      return;
    case "stop":
      set({ state: "stopping", step: "stopping" });
      setTimeout(() => {
        set({ state: "stopped", step: null, host: null });
        send({ type: "result", id, outcome: { ok: true, value: {} } });
      }, 200);
      return;
    default:
      send({ type: "result", id, outcome: { ok: true, value: {} } });
  }
}

process.on("message", (raw: unknown) => {
  const message = raw as ShellToSupervisor;
  if (message?.type === "command") answer(message.id, message.command);
});
// A closed channel means the shell is gone or done: stop, as the real one does.
process.on("disconnect", () => {
  log("channel closed");
  process.exit(0);
});

log("starting");
send({ type: "status", status });
setTimeout(running, 300);
