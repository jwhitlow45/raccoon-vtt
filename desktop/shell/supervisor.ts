import { join } from "node:path";
import {
  RESOURCES,
  SUPERVISOR_ENTRY,
  SupervisorToShell,
  serverBinaryName,
  type Command,
  type CommandFailure,
  type Platform,
  type ShellToSupervisor,
  type SupervisorStatus,
} from "../contract.ts";

/**
 * How the shell starts the supervisor (design 2): the bundled Node, renamed
 * so Task Manager and firewall prompts name the app, running the
 * supervisor's entry from the staged server, talking over Node's IPC channel
 * on stdio and never a port.
 */
export type SpawnPlan = { command: string; args: string[]; cwd: string; env: Record<string, string> };

/**
 * Environment variables the supervisor must not inherit from the shell.
 * Electron's own ones mean nothing to plain Node, and NODE_OPTIONS or
 * NODE_PATH from the DM's shell profile could change how the server's Node
 * runs. The supervisor builds the app server's environment from nothing
 * anyway (contract `localServerEnv`).
 */
function inherited(name: string): boolean {
  if (name.startsWith("ELECTRON_") || name.startsWith("CHROME_")) return false;
  return !["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_REPL_EXTERNAL_MODULE"].includes(name);
}

export function supervisorEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && inherited(name)) out[name] = value;
  return out;
}

/**
 * Packaged, everything is in the app's resources folder (contract
 * `RESOURCES`). In development the repository's own copy runs: Node from
 * desktop/.runtime when desktop:fetch has filled it, else the `node` on PATH.
 */
export function spawnPlan(opts: {
  platform: Platform;
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  devNodeExists: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): SpawnPlan {
  const env = supervisorEnv(opts.env);
  if (opts.packaged) {
    const appServer = join(opts.resourcesPath, RESOURCES.appServer);
    return {
      command: join(opts.resourcesPath, RESOURCES.node, serverBinaryName(opts.platform)),
      args: [join(appServer, SUPERVISOR_ENTRY)],
      cwd: appServer,
      env,
    };
  }
  const devNode = join(opts.repoRoot, "desktop", ".runtime", RESOURCES.node, serverBinaryName(opts.platform));
  return {
    command: opts.devNodeExists ? devNode : "node",
    args: [join(opts.repoRoot, SUPERVISOR_ENTRY)],
    cwd: opts.repoRoot,
    env,
  };
}

/** The parts of a ChildProcess with an IPC channel the link uses, so tests can stand in for one. */
export type SupervisorChannel = {
  send(message: ShellToSupervisor): boolean;
  onMessage(listener: (message: unknown) => void): void;
  /** The process ended, or never started (a spawn error carries no exit of its own). */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  disconnect(): void;
  readonly connected: boolean;
};

export type CommandAnswer = { ok: true; value: unknown } | { ok: false; failure: CommandFailure };

export type ExitInfo = { code: number | null; signal: string | null; hadStatus: boolean };

/**
 * One running supervisor, as the shell sees it: its newest status, and its
 * commands' answers matched to their ids. Every message is parsed with the
 * contract before it is used. When the process exits, every command still
 * waiting answers `notRunning`, so no caller waits forever.
 */
export class SupervisorLink {
  readonly #channel: SupervisorChannel;
  readonly #onStatus: (status: SupervisorStatus) => void;
  readonly #onExit: (info: ExitInfo) => void;
  readonly #log: (message: string) => void;
  readonly #pending = new Map<number, (answer: CommandAnswer) => void>();
  #nextId = 1;
  #status: SupervisorStatus | null = null;
  #exited = false;
  #exitWaiters: (() => void)[] = [];

  constructor(
    channel: SupervisorChannel,
    handlers: { onStatus(status: SupervisorStatus): void; onExit(info: ExitInfo): void; log(message: string): void },
  ) {
    this.#channel = channel;
    this.#onStatus = handlers.onStatus;
    this.#onExit = handlers.onExit;
    this.#log = handlers.log;
    channel.onMessage((raw) => this.#receive(raw));
    channel.onExit((code, signal) => this.#exit(code, signal));
  }

  get status(): SupervisorStatus | null {
    return this.#status;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Sends a command and waits for its answer, however long the supervisor takes (a backup can take minutes). */
  command(command: Command): Promise<CommandAnswer> {
    if (this.#exited || !this.#channel.connected) return Promise.resolve({ ok: false, failure: { error: "notRunning" } });
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      let sent = false;
      try {
        sent = this.#channel.send({ type: "command", id, command });
      } catch (error) {
        this.#log(`could not send ${command.type} to the supervisor: ${String(error)}`);
      }
      if (!sent && this.#pending.delete(id)) resolve({ ok: false, failure: { error: "notRunning" } });
    });
  }

  /**
   * Asks the supervisor to stop and waits for its stopped report: the
   * `stop` command's answer, or the process ending. Resolves false when
   * neither comes within `timeoutMs`.
   */
  async stop(timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#exited) return { ok: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs)));
    const answer = this.command({ type: "stop" }).then((a) => ({ kind: "answer" as const, answer: a }));
    const exit = this.waitForExit().then(() => ({ kind: "exit" as const }));
    try {
      const first = await Promise.race([answer, exit, timeout]);
      if (first === "timeout") return { ok: false, reason: "RaccoonVTT did not stop in time" };
      if (first.kind === "exit") return { ok: true };
      if (first.answer.ok) return { ok: true };
      // A supervisor that exited while stopping has stopped, whatever the answer says.
      if (first.answer.failure.error === "notRunning" && this.#exited) return { ok: true };
      return { ok: false, reason: failureReason(first.answer.failure) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves once the process has exited. */
  waitForExit(): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return new Promise((resolve) => this.#exitWaiters.push(resolve));
  }

  /** Closes the IPC channel, which the supervisor treats as `stop`. */
  disconnect(): void {
    try {
      if (this.#channel.connected) this.#channel.disconnect();
    } catch {
      // Already closing.
    }
  }

  #receive(raw: unknown): void {
    const parsed = SupervisorToShell.safeParse(raw);
    if (!parsed.success) {
      this.#log(`ignored a message from the supervisor that does not match the contract: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      return;
    }
    const message = parsed.data;
    if (message.type === "status") {
      this.#status = message.status;
      this.#onStatus(message.status);
      return;
    }
    const resolve = this.#pending.get(message.id);
    if (!resolve) return;
    this.#pending.delete(message.id);
    resolve(message.outcome.ok ? { ok: true, value: message.outcome.value } : { ok: false, failure: message.outcome.failure });
  }

  #exit(code: number | null, signal: string | null): void {
    if (this.#exited) return;
    this.#exited = true;
    for (const resolve of this.#pending.values()) resolve({ ok: false, failure: { error: "notRunning" } });
    this.#pending.clear();
    for (const resolve of this.#exitWaiters) resolve();
    this.#exitWaiters = [];
    this.#onExit({ code, signal, hadStatus: this.#status !== null });
  }
}

/** A failure as a lowercase clause, for the shell's log and the update's words. */
export function failureReason(failure: CommandFailure): string {
  switch (failure.error) {
    case "failed":
      return failure.reason;
    case "restoring":
      return "a restore is running";
    case "busy":
      return "it is still busy";
    case "notRunning":
      return "RaccoonVTT is not running";
    case "noSpace":
      return "there is not enough free disk space";
  }
}
