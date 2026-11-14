/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_ACTIONS, WORDS, WindowState, errorText, type AppError } from "../contract.ts";
import { ERRORS, SCENARIO_NAMES, scenario } from "./scenarios.ts";
import { backupKindLabel, canReconfigure, checkPort, currentError, errorActions, failureText, notWorkingLines, playersView, restorable, serverUp, statusView, switchBusy } from "./view.ts";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const state = (name: string) => scenario(name, NOW).state;
const sup = (name: string) => state(name).supervisor!;

test("every scenario is a state the contract accepts", () => {
  for (const name of SCENARIO_NAMES) {
    const parsed = WindowState.safeParse(state(name));
    assert.ok(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`);
  }
});

test("every scenario uses an address from a private range the push scan accepts", () => {
  const all = JSON.stringify(SCENARIO_NAMES.map(state));
  assert.ok(!/192\.168\.\d/.test(all));
});

test("the status line says each step in the design's words", () => {
  assert.equal(statusView(state("step-initdb")).text, "Setting up the database. This happens once and takes up to a minute.");
  assert.equal(statusView(state("running")).text, "Running");
  assert.equal(statusView(state("running")).working, false);
  assert.equal(statusView(state("step-openToNetwork")).text, "Restarting so players can join");
  assert.equal(statusView(state("step-closeToNetwork")).text, "Restarting so only this computer can open it");
  assert.equal(statusView(state("restoring-database")).text, "Restoring the database");
  assert.equal(statusView(state("starting-none")).text, "Starting RaccoonVTT");
  assert.equal(statusView(state("finishing-restore")).text, "Finishing a restore, 42% done");
  assert.equal(statusView(state("step-finishRestore")).text, "Finishing a restore");
  assert.ok(statusView(state("step-changePort")).working);
});

test("a stop replaces the status line, and the shell's stop wins over the supervisor's", () => {
  assert.equal(statusView(state("error-portInUse")).text, "");
  const both = state("error-portInUse");
  both.shell.error = ERRORS.root!;
  assert.equal(currentError(both)?.kind, "root");
});

test("players can join only while the network is open, and each other state has its own words", () => {
  assert.equal(playersView(sup("running")).address, "http://10.0.0.20:3170");
  assert.equal(playersView(sup("running")).note, null);
  for (const reach of ["off", "offline", "public", "domain", "unknown"] as const) {
    const view = playersView(sup(`reach-${reach}`));
    assert.equal(view.address, null, reach);
    assert.equal(view.note, WORDS.players.reach[reach], reach);
  }
});

test("a lingering share address never shows while the network is not open", () => {
  const odd = { ...sup("running"), network: "public" as const };
  assert.equal(playersView(odd).address, null);
});

test("the awake line follows every socket, the DM's own tabs included, since the power blocker does", () => {
  assert.equal(playersView({ ...sup("running"), sockets: 1, remoteDevices: 0 }).awake, true);
  assert.equal(playersView({ ...sup("running"), sockets: 0, remoteDevices: 0 }).awake, false);
});

test("the device count and the awake line follow the status", () => {
  assert.equal(playersView(sup("running")).devices, "No other devices connected");
  assert.equal(playersView(sup("devices-1")).devices, "1 other device connected");
  assert.equal(playersView(sup("devices-3")).devices, "3 other devices connected");
  assert.equal(playersView(sup("running")).awake, false);
  assert.equal(playersView(sup("devices-3")).awake, true);
});

test("Not working? lists the platform's own lines and the other addresses", () => {
  const win = notWorkingLines(sup("running"), "win32");
  assert.equal(win.length, 3);
  assert.ok(win.at(-1)!.startsWith("This computer also answers at: 10.0.0.21"));
  assert.ok(notWorkingLines(sup("firewall-missing"), "win32").includes(WORDS.notWorking.firewallRuleMissing));
  assert.ok(notWorkingLines(sup("running-linux"), "linux").includes("If a firewall runs here, allow the port: sudo ufw allow 3170/tcp"));
  assert.ok(!notWorkingLines(sup("running-mac"), "darwin").some((l) => l.includes("ufw")));
});

test("only a running server takes a change, and Open needs a port", () => {
  assert.equal(canReconfigure(sup("running")), true);
  assert.equal(canReconfigure(sup("step-startServer")), false);
  assert.equal(canReconfigure(sup("restoring-images")), false);
  assert.equal(canReconfigure(null), false);
  assert.equal(serverUp(sup("running")), true);
  assert.equal(serverUp(sup("error-databaseFailed")), false);
  assert.equal(switchBusy(sup("step-openToNetwork")), true);
  assert.equal(switchBusy(sup("step-changePort")), false);
});

test("each stop's buttons match the design, and Use port names the next port", () => {
  for (const [key, error] of Object.entries(ERRORS)) {
    const labels = errorActions(error).map((a) => a.action);
    assert.deepEqual(labels, [...ERROR_ACTIONS[error.kind]], key);
  }
  assert.deepEqual(errorActions(ERRORS.portInUse!).map((a) => a.label), ["Use port 3171", "Quit"]);
  assert.deepEqual(errorActions(ERRORS.newerData!).map((a) => a.label), ["Download the latest version", "Restore a backup"]);
  assert.deepEqual(errorActions(ERRORS.glibc!), []);
});

test("every stop's sentence has no placeholder left and no em dash", () => {
  for (const error of Object.values(ERRORS) as AppError[]) {
    const text = errorText(error, "0.5.0", "linux");
    assert.ok(!/[<>]|undefined|\u2014/.test(text), text);
  }
});

test("a failed command is worded for what it was doing", () => {
  assert.equal(failureText({ error: "restoring" }, "backup"), "Not during a restore");
  assert.equal(failureText({ error: "noSpace", bytes: 1_400_000_000 }, "restore"), "Not enough free disk space to restore safely. Free at least 1.4 GB and try again.");
  assert.equal(failureText({ error: "failed", reason: "the disk is full." }, "backup"), "The backup failed: the disk is full.");
  assert.equal(failureText({ error: "failed", reason: "the disk is full" }, "restore"), "The restore failed, and nothing changed: the disk is full.");
  assert.equal(failureText({ error: "notRunning" }, "rooms"), "Rooms show here while RaccoonVTT runs.");
});

test("a typed port must be 1024 to 65535 and nothing else", () => {
  assert.deepEqual(checkPort("3175"), { ok: true, port: 3175 });
  assert.deepEqual(checkPort(" 1024 "), { ok: true, port: 1024 });
  assert.deepEqual(checkPort("65535"), { ok: true, port: 65535 });
  for (const bad of ["", "80", "1023", "65536", "99999", "123456", "31 70", "3170.5", "-3170", "0x10", "abc"]) assert.deepEqual(checkPort(bad), { ok: false }, bad);
});

test("backups this build cannot read get no Restore, and kinds read in the design's words", () => {
  const { backups } = scenario("unreadable-backup", NOW);
  assert.equal(backups.length, 4);
  assert.equal(restorable(backups).length, 3);
  assert.deepEqual(restorable(backups).map(backupKindLabel), ["By hand", "Daily", "Before the update to 0.5.0"]);
});
