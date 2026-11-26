import type { DiscardHistoryCommand, HistoryBlocker, HistoryDirection, HistoryMessage, HistoryScope, StackHistoryCommand } from "#shared/undoContract.ts";
import { endSentence } from "#shared/logText.ts";
import type { OnAnswer } from "./types.ts";
import { Timer, type Clock } from "./timing.ts";

export type HistoryCommand = StackHistoryCommand | DiscardHistoryCommand;
export type HistoryActivation = {
  scope?: HistoryScope;
  /** The browser's click count, keyed by the control, survives an ack between taps. */
  control?: string;
  detail?: number;
  repeat?: boolean;
  of?: number;
  expected?: string;
  discard?: true;
  forget?: number;
  quiet?: boolean;
  onAnswer?: OnAnswer;
};

/** Each history's last answer, so a sheet shows only what its own history did. */
export type HistoryResults = Readonly<Record<HistoryScope, string | null>>;
export type HistoryView = { summary: HistoryMessage | null; ready: boolean; pending: number; slow: boolean; result: HistoryResults };
const NO_RESULTS: HistoryResults = { play: null, setup: null };
export const EMPTY_HISTORY: HistoryView = { summary: null, ready: false, pending: 0, slow: false, result: NO_RESULTS };
export const HISTORY_LOADING = "Loading undo history…";
export const HISTORY_WAIT_MS = 200;

/**
 * `live`: the socket is open and the room goes on, though a resync may still
 * wait for its snapshot. `enabled`: live, with that snapshot in.
 */
type Context = { seq: number; terminal: number; issued: number; enabled: boolean; live: boolean; dm: boolean };
type Request = { direction: HistoryDirection; options: HistoryActivation };
type Ports = {
  context(): Context;
  send(command: HistoryCommand, options: { quiet?: boolean; onAnswer: OnAnswer }): number | null;
  changed(view: HistoryView): void;
  notify(text: string): void;
};

export function historyChanged(scope: HistoryScope): string {
  return `${scope === "setup" ? "Setup" : "Play"} history changed. Check the next change.`;
}

/** A refused history command as one sentence, the words its toast shows (store.ts undoAnswer). */
export function refusalSentence(message: string): string {
  if (message === "Reload to use Undo") return message;
  const detail = message.trim().replace(/\.$/, "");
  if (!detail) return "";
  // A question, such as the forget question, keeps its own mark.
  return endSentence(detail[0]!.toUpperCase() + detail.slice(1));
}

export function blockerText(blocker: HistoryBlocker): string {
  const verb = blocker.direction === "undo" ? "Undo" : "Redo";
  return blocker.buried
    ? `${verb} the ${blocker.scope} steps through ${blocker.label} first.`
    : endSentence(`${verb} the ${blocker.scope} step first: ${blocker.label}`);
}

/** Authoritative heads stay outside optimistic room state and the transport retry queue. */
export class HistoryController {
  private ports: Ports;
  private timer: Timer;
  private connection = 0;
  private snapshotSeen = false;
  private epoch: string | null = null;
  private previousEpoch: string | null = null;
  private retired = new Set<string>();
  private latest: HistoryMessage | null = null;
  private ordered: HistoryMessage | null = null;
  private queue: Request[] = [];
  private active = 0;
  private draining = false;
  private slow = false;
  private result: HistoryResults = NO_RESULTS;
  private clicks = new Set<string>();
  private published = EMPTY_HISTORY;

  constructor(ports: Ports, clock: Clock) {
    this.ports = ports;
    this.timer = new Timer(clock);
  }

  get generation(): number { return this.connection; }

  suspend(): void {
    this.connection++;
    this.snapshotSeen = false;
    this.previousEpoch = this.epoch ?? this.previousEpoch;
    this.epoch = null;
    this.latest = null;
    this.ordered = null;
    const abandoned = this.queue.splice(0);
    for (const request of abandoned) request.options.onAnswer?.("unknown", undefined, "snapshot");
    if (abandoned.some((request) => !request.options.quiet)) this.ports.notify("Undo history disconnected. Try again when connected.");
    this.refresh();
  }

  snapshot(): void {
    this.snapshotSeen = true;
    // A resync on the same connection also needs a summary after its snapshot.
    this.latest = null;
    this.refresh();
  }

  receive(message: HistoryMessage, connection = this.connection): void {
    if (connection !== this.connection || !this.snapshotSeen || this.retired.has(message.epoch)) return;
    if (this.epoch !== null && message.epoch !== this.epoch) return;
    if (this.epoch === null) {
      if (this.previousEpoch && this.previousEpoch !== message.epoch) this.retired.add(this.previousEpoch);
      this.epoch = message.epoch;
    }
    const old = this.ordered;
    if (old && (message.serial < old.serial || message.seq < old.seq || message.watermark < old.watermark)) return;
    if (this.latest && old && message.serial === old.serial && message.seq === old.seq && message.watermark === old.watermark) return;
    this.ordered = message;
    this.latest = message;
    this.refresh();
  }

  activate(direction: HistoryDirection, options: HistoryActivation = {}): boolean {
    const context = this.ports.context();
    // A tap while a resync waits for its snapshot, as after an undo takes away the scene the DM stands on, waits
    // as one before a summary does, busy until it drains. Refused, it did nothing and said nothing.
    if (options.repeat || !context.live || (options.scope === "setup" && !context.dm)) return false;
    const control = options.control;
    if (control && (options.detail ?? 0) > 1 && this.clicks.has(control)) return false;
    if (control && (options.detail ?? 0) > 0) this.clicks.add(control);
    this.setResult(options.scope ?? "play", null);
    this.queue.push({ direction, options: { ...options } });
    this.refresh();
    return true;
  }

  private ready(context: Context): boolean {
    return context.enabled && this.snapshotSeen && this.latest !== null && this.latest.seq === context.seq
      && this.latest.watermark >= context.issued && context.terminal >= context.issued;
  }

  refresh(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && this.ready(this.ports.context())) {
        const { direction, options } = this.queue.shift()!;
        const scope = options.scope ?? "play";
        if (scope === "setup" && !this.ports.context().dm) {
          this.refuse(scope, options, "Setup history is available only to the DM.");
          continue;
        }
        const head = this.latest?.[scope]?.[direction].head;
        if (options.expected !== undefined && head?.id !== options.expected) {
          this.refuse(scope, options, historyChanged(scope));
          continue;
        }
        if (!head || (options.discard && !head.retained)) {
          this.refuse(scope, options, options.discard ? "This step is not retained." : `Nothing to ${direction}${scope === "setup" ? " in Setup history" : ""}.`);
          continue;
        }
        const target = { t: direction, scope, head: head.id };
        const command = options.discard ? { ...target, discard: true as const }
          : { ...target, ...(options.of !== undefined && direction === "undo" && scope === "play" ? { of: options.of } : {}), ...(options.forget !== undefined ? { forget: options.forget } : {}) };
        this.active++;
        const n = this.ports.send(command as HistoryCommand, {
          quiet: options.quiet,
          onAnswer: (...args) => {
            this.active--;
            const result = args[0] === "taken"
              ? options.discard ? "Discarded this step. The game stays as it is." : endSentence(`${direction === "undo" ? "Undid" : "Redid"}${scope === "setup" ? " setup:" : ""} ${head.label}`)
              : (args[1]?.message !== undefined ? refusalSentence(args[1].message) : "") || "The answer was lost. Check the next change.";
            this.setResult(scope, result);
            if (args[0] === "unknown" && !options.quiet) this.ports.notify(result);
            options.onAnswer?.(...args);
            this.refresh();
          },
        });
        if (n === null) {
          this.active--;
          this.refuse(scope, options, "That history action could not be sent.");
        }
      }
    } finally {
      this.draining = false;
    }
    this.publish();
  }

  private setResult(scope: HistoryScope, text: string | null): void {
    if (this.result[scope] !== text) this.result = { ...this.result, [scope]: text };
  }

  private refuse(scope: HistoryScope, options: HistoryActivation, text: string): void {
    this.setResult(scope, text);
    if (!options.quiet) this.ports.notify(text);
    options.onAnswer?.("refused", { code: "invalid", message: text, text });
  }

  private publish(): void {
    const context = this.ports.context();
    const pending = this.queue.length + this.active;
    if (pending === 0) {
      this.timer.clear();
      this.slow = false;
    } else if (!this.slow && !this.timer.pending) {
      this.timer.set(HISTORY_WAIT_MS, () => { this.slow = true; this.publish(); });
    }
    const next: HistoryView = {
      summary: this.latest && this.latest.seq === context.seq && this.latest.watermark >= context.terminal ? this.latest : null,
      ready: this.ready(context), pending, slow: this.slow, result: this.result,
    };
    const prev = this.published;
    if (next.summary === prev.summary && next.ready === prev.ready && next.pending === prev.pending && next.slow === prev.slow && next.result === prev.result) return;
    this.published = next;
    this.ports.changed(next);
  }

  dispose(): void { this.timer.clear(); this.queue = []; }
}
