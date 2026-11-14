import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { FRESH_MS, ProfileWatcher, RESTART_LATER_MS, WATCH_SCRIPT, networkReading, parseSample, profileReach, watchArgs, powershellPath, type WatchChild } from "./netProfile.ts";
import { FakeClock } from "./testing/fakeWorld.ts";

/**
 * The Windows network profile watcher (docs/design/design-v1-local-app.md 6,
 * D-261113-094): parsing, freshness, a silent or exited child, the restart
 * waits, and the first sample a start waits for.
 */

const LINE = (seq: number, category = "Private", ipv4: unknown = ["10.0.0.20"]) => JSON.stringify({ seq, profiles: [{ alias: "Wi-Fi", category, ipv4 }] });

test("a sample reads with one profile or many, one address or many, and nothing else counts as one", () => {
  assert.deepEqual(parseSample(LINE(3), 7)?.profiles, [{ alias: "Wi-Fi", category: "Private", ipv4: ["10.0.0.20"] }]);
  // PowerShell 5.1 writes a one-element array as its element.
  const single = parseSample(JSON.stringify({ seq: 1, profiles: { alias: "Ethernet", category: "Public", ipv4: "172.16.4.2" } }), 0);
  assert.deepEqual(single?.profiles, [{ alias: "Ethernet", category: "Public", ipv4: ["172.16.4.2"] }]);
  assert.deepEqual(parseSample(JSON.stringify({ seq: 1, profiles: [{ alias: "x", category: "Private", ipv4: null }] }), 0)?.profiles[0]?.ipv4, []);
  assert.equal(parseSample(JSON.stringify({ seq: 2, error: "Access denied" }), 0), null);
  assert.equal(parseSample("WARNING: something", 0), null);
  assert.equal(parseSample(JSON.stringify({ seq: 0, profiles: [] }), 0), null);
});

test("only the profile of the network carrying the shown address decides, and only while fresh", () => {
  const sample = { seq: 1, at: 1_000, profiles: [{ alias: "vEthernet", category: "Public", ipv4: ["172.16.0.1"] }, { alias: "Wi-Fi", category: "Private", ipv4: ["10.0.0.20"] }] };
  assert.equal(profileReach(sample, 1_000, "10.0.0.20"), "open");
  assert.equal(profileReach(sample, 1_000, "172.16.0.1"), "public");
  assert.equal(profileReach({ ...sample, profiles: [{ alias: "Corp", category: "DomainAuthenticated", ipv4: ["10.0.0.20"] }] }, 1_000, "10.0.0.20"), "domain");
  assert.equal(profileReach(sample, 1_000, "10.9.9.9"), "unknown", "an address on no profile");
  assert.equal(profileReach(sample, 1_000 + FRESH_MS, "10.0.0.20"), "open");
  assert.equal(profileReach(sample, 1_001 + FRESH_MS, "10.0.0.20"), "unknown", "stale");
  assert.equal(profileReach(null, 0, "10.0.0.20"), "unknown");
  assert.equal(profileReach({ ...sample, profiles: [{ alias: "Wi-Fi", category: "Weird", ipv4: ["10.0.0.20"] }] }, 1_000, "10.0.0.20"), "unknown");
});

test("the switch, the address and the Windows profile decide the words and the bind", () => {
  const open = () => "open" as const;
  const pub = () => "public" as const;
  assert.deepEqual(networkReading("linux", true, "10.0.0.20", ["172.16.0.2"], open), { reach: "open", host: "0.0.0.0", share: "10.0.0.20", others: ["172.16.0.2"] });
  assert.equal(networkReading("linux", false, "10.0.0.20", [], open).host, "127.0.0.1");
  assert.equal(networkReading("darwin", false, "10.0.0.20", [], open).reach, "off");
  // Offline with the switch on: the words say so, and macOS and Linux still bind for a new address.
  assert.deepEqual(networkReading("linux", true, null, [], open), { reach: "offline", host: "0.0.0.0", share: null, others: [] });
  assert.deepEqual(networkReading("win32", true, null, [], open), { reach: "offline", host: "127.0.0.1", share: null, others: [] });
  assert.deepEqual(networkReading("win32", true, "10.0.0.20", [], pub), { reach: "public", host: "127.0.0.1", share: "10.0.0.20", others: [] });
  assert.equal(networkReading("win32", true, "10.0.0.20", [], () => "unknown").host, "127.0.0.1");
  assert.equal(networkReading("win32", true, "10.0.0.20", [], open).host, "0.0.0.0");
  assert.equal(networkReading("win32", false, "10.0.0.20", [], open).reach, "off");
});

test("PowerShell runs by its absolute path, hidden, with the script encoded", () => {
  assert.equal(powershellPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const args = watchArgs();
  assert.deepEqual(args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.equal(Buffer.from(args[5] as string, "base64").toString("utf16le"), WATCH_SCRIPT);
  assert.match(WATCH_SCRIPT, /Start-Sleep -Seconds 5/);
});

class FakeChild extends EventEmitter implements WatchChild {
  stdout = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("exit"));
    return true;
  }
  say(line: string): void {
    this.stdout.write(`${line}\n`);
  }
}

async function tick(clock: FakeClock, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) await clock.advance(250);
}

function watcher() {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const spawnedAt: number[] = [];
  let changes = 0;
  const w = new ProfileWatcher({
    clock,
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      spawnedAt.push(clock.now());
      return c;
    },
    log: () => undefined,
    onChange: () => void changes++,
  });
  return { clock, children, spawnedAt, w, changes: () => changes };
}

test("a start waits for the first sample, up to 10 s", async () => {
  const { clock, children, w } = watcher();
  w.start();
  let waited = false;
  void w.firstSample().then(() => (waited = true));
  await tick(clock, 2_000);
  assert.equal(waited, false);
  children[0]?.say(LINE(1));
  await tick(clock, 250);
  assert.equal(waited, true);
  assert.equal(w.fresh(), true);

  const other = watcher();
  other.w.start();
  let gaveUp = false;
  void other.w.firstSample().then(() => (gaveUp = true));
  await tick(other.clock, 9_750);
  assert.equal(gaveUp, false);
  await tick(other.clock, 500);
  assert.equal(gaveUp, true, "no sample in 10 s: the start goes on, closed");
  assert.equal(other.w.fresh(), false);
});

test("a watcher alive but silent fails within 15 s, and is started again after 1, 2 and 4 s, then every 30 s", async () => {
  const { clock, children, spawnedAt, w, changes } = watcher();
  w.start();
  children[0]?.say(LINE(1));
  await tick(clock, 250);
  assert.equal(w.fresh(), true);
  const before = changes();
  // From here every child stays silent.
  await tick(clock, FRESH_MS + 1_000);
  assert.equal(w.fresh(), false);
  assert.ok(changes() > before, "the change is reported, so the server closes");
  assert.equal(children[0]?.killed, true);
  await tick(clock, 200_000);
  const gaps = spawnedAt.slice(1).map((t, i) => t - (spawnedAt[i] as number));
  // Each child gets 15 s to speak before it counts as failed, then the wait before the next.
  assert.deepEqual(gaps.slice(0, 5), [FRESH_MS + 1_000 + 1_000, FRESH_MS + 1_000 + 2_000, FRESH_MS + 1_000 + 4_000, FRESH_MS + 1_000 + RESTART_LATER_MS, FRESH_MS + 1_000 + RESTART_LATER_MS]);
});

test("a watcher that exits, or prints only what does not read, counts as failed", async () => {
  const exited = watcher();
  exited.w.start();
  exited.children[0]?.say(LINE(1));
  await tick(exited.clock, 250);
  exited.children[0]?.emit("exit");
  await tick(exited.clock, 1_250);
  assert.equal(exited.children.length, 2, "started again after 1 s");

  const garbled = watcher();
  garbled.w.start();
  garbled.children[0]?.say(LINE(1));
  for (let i = 0; i < 5; i++) {
    await tick(garbled.clock, 5_000);
    garbled.children[0]?.say("not json");
  }
  assert.equal(garbled.w.fresh(), false);
  assert.equal(garbled.children[0]?.killed, true);
});

test("a repeated sample number proves nothing new, and a fresh child counts from 1 again", async () => {
  const { clock, children, w } = watcher();
  w.start();
  children[0]?.say(LINE(5));
  await tick(clock, 250);
  const at = w.latest()?.at;
  await tick(clock, 5_000);
  children[0]?.say(LINE(5));
  await tick(clock, 250);
  assert.equal(w.latest()?.at, at, "a repeat does not refresh");
  children[0]?.say(LINE(6, "Public"));
  await tick(clock, 250);
  assert.equal(w.latest()?.profiles[0]?.category, "Public");
});
