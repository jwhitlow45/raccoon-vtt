import os from "node:os";
import { parseArgs } from "node:util";
import { Platform } from "../../contract.ts";
import { dataIdentity } from "../dataDir.ts";
import { acquireLock, lockLocation, type LockPausePoint } from "../lock.ts";
import { selfIdentity } from "../processInfo.ts";

/**
 * One contender for a data folder's lock, for lock.itest.ts: a real
 * process, so a test can start ten at once, pause one at a point in the
 * recovery, or kill it while it holds the guard.
 *
 *   node lockChild.ts --data <dir> [--home <dir>] [--runtime-dir <dir>] [--pause <point>=<ms>]... [--wait-ms <n>]
 *
 * It prints one JSON line per event: `paused` and `resumed` around a pause,
 * then `result` with the outcome. An owner holds the lock until its stdin
 * closes or it is killed. Any other outcome exits at once.
 */

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    home: { type: "string" },
    "runtime-dir": { type: "string" },
    pause: { type: "string", multiple: true, default: [] },
    "wait-ms": { type: "string" },
  },
  strict: true,
});
if (!values.data) throw new Error("--data is required");

const platform = Platform.parse(process.platform);
const say = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);
};

const pauses = new Map<string, number>();
for (const item of values.pause) {
  const [point, ms] = item.split("=");
  if (!point || !ms) throw new Error(`--pause takes <point>=<ms>, not ${item}`);
  pauses.set(point, Number(ms));
}

const runtimeDir = values["runtime-dir"];
const location = lockLocation(dataIdentity(values.data, platform).hash, {
  platform,
  uid: process.getuid?.() ?? 0,
  home: values.home ?? os.homedir(),
  ...(runtimeDir ? { runtimeDir: () => runtimeDir } : {}),
});
if ("error" in location) {
  say({ event: "result", ok: false, error: { kind: location.error } });
  process.exit(0);
}

const outcome = await acquireLock(location.path, {
  platform,
  self: await selfIdentity(platform),
  ...(values["wait-ms"] ? { waitMs: Number(values["wait-ms"]) } : {}),
  async pause(point: LockPausePoint) {
    const ms = pauses.get(point);
    if (ms === undefined) return;
    say({ event: "paused", point });
    await new Promise((resolve) => setTimeout(resolve, ms));
    say({ event: "resumed", point });
  },
});

if (!outcome.ok) {
  say({ event: "result", ok: false, error: outcome.error, path: location.path });
  process.exit(0);
}
say({ event: "result", ok: true, path: location.path });
process.stdin.resume();
process.stdin.on("end", () => {
  void outcome.lock.close().then(() => process.exit(0));
});
