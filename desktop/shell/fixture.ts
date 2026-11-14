import type { SupervisorStatus } from "../contract.ts";

/** A running supervisor's status, for tests to change one field at a time. */
export function sampleStatus(over: Partial<SupervisorStatus> = {}): SupervisorStatus {
  return {
    state: "running",
    step: "running",
    appVersion: "0.5.0",
    settings: { port: 3170, networkPlay: true, checkUpdates: true, openBrowser: true, animatedMaps: true, roomSound: true },
    port: 3170,
    host: "0.0.0.0",
    network: "open",
    shareOrigin: "http://10.0.0.20:3170",
    otherAddresses: [],
    firewallRule: null,
    sockets: 0,
    remoteDevices: 0,
    backingUp: false,
    lastBackup: null,
    restore: null,
    error: null,
    notice: null,
    paths: { data: "/data", backups: "/data/backups", logs: "/data/logs" },
    ...over,
  };
}
