import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";
import type { Clock, Timer } from "./clock.ts";

/**
 * The Windows network profile (docs/design/design-v1-local-app.md 6,
 * D-261113-062, 077, 088, 094). Windows marks each network Public, Private
 * or Domain, and its firewall rule for the app is private only. Players may
 * join only while the network carrying the address they are shown is
 * Private, which one long-lived hidden PowerShell reads every 5 s, printing
 * a full sample each time, changed or not.
 *
 * Any doubt closes: a sample is fresh for 15 s, and an error line or
 * output that does not read is no new sample. A child that exits or cannot
 * start drops the sample at once, so the server binds 127.0.0.1 until a new
 * child gives a new one. A child silent for 15 s is ended the same way.
 * Children are started again after 1, 2 and 4 s, then every 30 s. macOS
 * and Linux have no such label, so there the switch alone decides.
 */

export const SAMPLE_EVERY_MS = 5_000;
export const FRESH_MS = 15_000;
export const FIRST_SAMPLE_WAIT_MS = 10_000;
export const RESTART_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const RESTART_LATER_MS = 30_000;

/**
 * Prints one JSON line every 5 s: each connection profile with its alias,
 * category and IPv4 addresses, numbered. A failed read prints its error in
 * place of the profiles, which counts as no sample.
 */
export const WATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$seq = 0
while ($true) {
  $seq++
  try {
    $profiles = @(Get-NetConnectionProfile | ForEach-Object {
      $addrs = @(Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.IPAddress })
      [pscustomobject]@{ alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory; ipv4 = $addrs }
    })
    $line = ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ seq = $seq; profiles = $profiles })
  } catch {
    $line = ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ seq = $seq; error = [string]$_.Exception.Message })
  }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
`;

/** PowerShell by its absolute path, since Windows looks in the current folder before PATH. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export function watchArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WATCH_SCRIPT, "utf16le").toString("base64")];
}

// PowerShell 5.1 writes a one-element array as a bare value, so either is read.
const oneOrMany = <T extends z.ZodType>(schema: T) => z.union([z.array(schema), schema]).transform((v) => (Array.isArray(v) ? v : [v]));

const SampleLine = z.object({
  seq: z.number().int().positive(),
  profiles: oneOrMany(
    z.object({
      alias: z.string(),
      category: z.string(),
      ipv4: z.union([oneOrMany(z.string()), z.null()]).transform((v) => v ?? []),
    }),
  ).optional(),
  error: z.string().optional(),
});

export type Profile = { alias: string; category: string; ipv4: string[] };
export type Sample = { seq: number; at: number; profiles: Profile[] };

/** A line as a sample, or null for anything that is not one: an error line, or output that does not read. */
export function parseSample(line: string, at: number): Sample | null {
  let json: unknown;
  try {
    json = JSON.parse(line.trim());
  } catch {
    return null;
  }
  const parsed = SampleLine.safeParse(json);
  if (!parsed.success || parsed.data.error !== undefined || parsed.data.profiles === undefined) return null;
  return { seq: parsed.data.seq, at, profiles: parsed.data.profiles };
}

export type ProfileReach = "open" | "public" | "domain" | "unknown";

/**
 * What the profile of the network carrying `address` allows. A stale or
 * missing sample, an address on no profile, or a category this does not
 * know all close. Domain (a work network) is closed too (D-261113-077).
 */
export function profileReach(sample: Sample | null, now: number, address: string | null): ProfileReach {
  if (!sample || now - sample.at > FRESH_MS || address === null) return "unknown";
  const profile = sample.profiles.find((p) => p.ipv4.includes(address));
  if (!profile) return "unknown";
  if (profile.category === "Private") return "open";
  if (profile.category === "Public") return "public";
  if (profile.category === "DomainAuthenticated") return "domain";
  return "unknown";
}

/**
 * What the window shows and what the server binds, from the switch, the
 * address players would be shown, and on Windows the profile (design 6):
 * `off`, then `offline`, then Windows' own reason, else `open`. Elsewhere the
 * switch alone decides the bind, so a computer that goes offline and back
 * takes its new address without a restart. On Windows only `open` binds
 * 0.0.0.0, so any doubt keeps players out.
 */
export function networkReading(
  platform: string,
  networkPlay: boolean,
  primary: string | null,
  others: string[],
  profile: () => ProfileReach,
): { reach: "open" | "off" | "offline" | "public" | "domain" | "unknown"; host: "0.0.0.0" | "127.0.0.1"; share: string | null; others: string[] } {
  let reach: "open" | "off" | "offline" | "public" | "domain" | "unknown" = !networkPlay ? "off" : primary === null ? "offline" : "open";
  if (platform === "win32" && reach === "open") reach = profile();
  const host = networkPlay && (platform !== "win32" || reach === "open") ? "0.0.0.0" : "127.0.0.1";
  return { reach, host, share: primary, others };
}

export type WatchChild = {
  stdout: Readable | null;
  kill(): boolean;
  once(event: "exit", listener: () => void): unknown;
  /** A child that could not start (ENOENT, EACCES) says so here, and without a listener Node would throw it. */
  once(event: "error", listener: (err: Error) => void): unknown;
};

export type WatcherDeps = {
  clock: Clock;
  spawn: () => WatchChild;
  log: (msg: string) => void;
  /** Called when the latest sample changes, stops being fresh, or is dropped on a failure. */
  onChange: () => void;
};

export function spawnWatchChild(): WatchChild {
  return spawn(powershellPath(), watchArgs(), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}

export class ProfileWatcher {
  private readonly deps: WatcherDeps;
  private child: WatchChild | null = null;
  private sample: Sample | null = null;
  private failures = 0;
  private stopped = false;
  private health: Timer | null = null;
  private restart: Timer | null = null;
  private startedAt = 0;
  private waiters: Array<() => void> = [];
  private wasFresh = false;
  /** The newest number this child printed. Each child counts from 1. */
  private childSeq = 0;

  constructor(deps: WatcherDeps) {
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.launch();
    this.checkHealth();
  }

  stop(): void {
    this.stopped = true;
    this.health?.cancel();
    this.restart?.cancel();
    this.child?.kill();
    this.child = null;
    for (const wake of this.waiters.splice(0)) wake();
  }

  latest(): Sample | null {
    return this.sample;
  }

  fresh(now = this.deps.clock.now()): boolean {
    return this.sample !== null && now - this.sample.at <= FRESH_MS;
  }

  /** The supervisor starts closed: it waits for the first sample, at most 10 s, before choosing what to bind. */
  firstSample(timeoutMs = FIRST_SAMPLE_WAIT_MS): Promise<void> {
    if (this.sample) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.deps.clock.setTimeout(() => done(), timeoutMs);
      const done = (): void => {
        timer.cancel();
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  private launch(): void {
    if (this.stopped) return;
    let child: WatchChild;
    try {
      child = this.deps.spawn();
    } catch (err) {
      this.fail(`the watcher could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    this.childSeq = 0;
    this.startedAt = this.deps.clock.now();
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (this.child === child) this.take(line);
      }
    });
    child.once("exit", () => {
      if (this.child === child) this.fail("the watcher exited");
    });
    child.once("error", (err) => {
      if (this.child === child) this.fail(`the watcher could not start: ${err.message}`);
    });
  }

  private take(line: string): void {
    const sample = parseSample(line, this.deps.clock.now());
    // An error line or one that does not read is no new sample (D-261113-094):
    // the last good one closes the server when it is 15 s old.
    if (!sample) return;
    // A number that does not grow is a repeat, which proves the child no more alive than before.
    if (sample.seq <= this.childSeq) return;
    this.childSeq = sample.seq;
    const changed = JSON.stringify(sample.profiles) !== JSON.stringify(this.sample?.profiles) || !this.wasFresh;
    this.sample = sample;
    this.failures = 0;
    this.wasFresh = true;
    for (const wake of this.waiters.splice(0)) wake();
    if (changed) this.deps.onChange();
  }

  private checkHealth(): void {
    if (this.stopped) return;
    const now = this.deps.clock.now();
    const lastAt = this.sample?.at ?? this.startedAt;
    if (this.child && now - Math.max(lastAt, this.startedAt) > FRESH_MS) this.fail("no fresh sample for 15 s");
    else if (this.wasFresh && !this.fresh(now)) {
      this.wasFresh = false;
      this.deps.onChange();
    }
    this.health = this.deps.clock.setTimeout(() => this.checkHealth(), 1_000);
  }

  /**
   * Its callers check the failing child is still the current one, so one
   * child's exit and error never schedule two restarts. The sample goes
   * before onChange, so the supervisor's next read is unknown and it binds
   * 127.0.0.1 at once rather than when the last sample turns stale.
   */
  private fail(why: string): void {
    if (this.stopped) return;
    this.deps.log(`network profile watcher failed: ${why}`);
    this.child?.kill();
    this.child = null;
    const had = this.sample !== null || this.wasFresh;
    this.sample = null;
    this.wasFresh = false;
    if (had) this.deps.onChange();
    const delay = RESTART_DELAYS_MS[this.failures] ?? RESTART_LATER_MS;
    this.failures++;
    this.restart = this.deps.clock.setTimeout(() => this.launch(), delay);
  }
}

const run = promisify(execFile);

/** Whether the installer's firewall rule is there (Windows only), for the window's Not working? fold. */
export async function firewallRule(env: NodeJS.ProcessEnv = process.env): Promise<"present" | "missing" | null> {
  try {
    // Ended after 30 s, which reads as not knowing.
    await run(`${env.SystemRoot ?? "C:\\Windows"}\\System32\\netsh.exe`, ["advfirewall", "firewall", "show", "rule", "name=RaccoonVTT"], { windowsHide: true, timeout: 30_000 });
    return "present";
  } catch (err) {
    // netsh answers 1 with "No rules match" when the rule is missing. Anything else is not knowing.
    return (err as { code?: unknown }).code === 1 ? "missing" : null;
  }
}
