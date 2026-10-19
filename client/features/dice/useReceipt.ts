import { useEffect, useSyncExternalStore } from "react";
import { compareLogIds } from "#shared/keys.ts";
import type { LogEntry } from "#shared/model.ts";
import { api, type ReceiptLookup } from "../../lib/api.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { OpAnswer, OpRefusal, UnknownCause } from "../../state/types.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { useScoped } from "../../state/scope.ts";
import { findRolls } from "./logic.ts";

/**
 * What became of an op that rolls or applies, by its tag
 * (docs/design-v1-dice.md 1.2 and 8.7), for every surface that sends one:
 * `sending` until its answer, `committed` with the lines it wrote,
 * `refused` with the reason, `checking` while the receipt lookup asks the
 * server, or `unknown`. It is the one place that reads acks, refusals and
 * the log for a tag.
 *
 * A tag's parts, the batches of one group, settle one by one. The tag reads
 * as the least settled of them: sending or checking while any is, unknown
 * if any stays unknown, committed once every part is (with the refusals of
 * any that were refused beside it), and refused when every part was.
 *
 * Unknown never sends again on its own. An op whose answer a reconnect's
 * snapshot swallowed, or that was too old to send, is first looked for in
 * the log, then looked up once. Only the person's own action sends again.
 */
export type PartState =
  | { state: "sending" }
  | { state: "committed"; lines: LogEntry[] }
  | { state: "refused"; code: string; message: string; text: string }
  | { state: "checking" }
  | { state: "unknown" };

export type ReceiptState =
  | { state: "sending" }
  | { state: "checking" }
  | { state: "unknown" }
  | { state: "refused"; code: string; message: string; text: string }
  | { state: "committed"; lines: LogEntry[]; refused?: { code: string; message: string; text: string } };

/** The words of a part the server refused, as the toast would say them, from a lookup's code and message. */
function refusedPart(code: string, message: string): PartState {
  return { state: "refused", code, message, text: message };
}

/**
 * A refused roll's or answer's words, as the server words them
 * (docs/design-v1-dice.md 7): the store's toast words open a refusal with
 * "Not saved.", which says the wrong thing where nothing was being saved.
 */
export function refusalWords(refusal: Pick<OpRefusal, "text" | "message"> | undefined): string {
  const text = refusal?.text ?? refusal?.message ?? "";
  return text.replace(/^Not saved\.\s*/, "") || text;
}

/** A refused part's words from a live answer, as the server words them, the same as a lookup gives them. */
function liveRefusal(refusal: OpRefusal | undefined): PartState {
  return { state: "refused", code: refusal?.code ?? "invalid", message: refusal?.message ?? "", text: refusalWords(refusal) };
}

type Entry = {
  parts: Map<number, PartState>;
  /** Mounted surfaces that show this tag, so a result nobody shows can go to a toast (8.7 rule 3). */
  watchers: number;
  /** A lookup was done for this tag. */
  looked: boolean;
  /** The lookup under way, which a second ask joins. */
  looking: Promise<void> | null;
  /** Whether the settled outcome was told to whoever announces results. */
  announced: boolean;
  /**
   * Its surface closed while the roll animation still held the result back
   * (docs/design-v1-roll-animation.md 3.5), so no surface showed it and it
   * goes to the toasts, whatever the closing surfaces say.
   */
  unseen: boolean;
};

export type ReceiptEnv = {
  /** The caller's own receipts of a tag, from the server. */
  lookup(tag: string): Promise<ReceiptLookup>;
  /** The viewer's live log, where a tag's lines land. */
  log(): readonly LogEntry[];
};

/** One room's receipts as this page knows them. Pure apart from `env`, so its rules are tested without React. */
export class ReceiptTracker {
  #entries = new Map<string, Entry>();
  #listeners = new Set<() => void>();
  #version = 0;
  env: ReceiptEnv | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Moves on every change, for useSyncExternalStore. */
  version = (): number => this.#version;

  #changed(): void {
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }

  #entry(tag: string): Entry {
    let entry = this.#entries.get(tag);
    if (!entry) {
      entry = { parts: new Map(), watchers: 0, looked: false, looking: null, announced: false, unseen: false };
      this.#entries.set(tag, entry);
    }
    return entry;
  }

  /** A part was sent. */
  sending(tag: string, part: number): void {
    const entry = this.#entry(tag);
    entry.parts.set(part, { state: "sending" });
    entry.announced = false;
    this.#changed();
  }

  /** A part was never sent after all, such as a preview refusing every op. */
  forget(tag: string, part: number): void {
    const entry = this.#entries.get(tag);
    if (!entry) return;
    entry.parts.delete(part);
    if (entry.parts.size === 0 && entry.watchers === 0) this.#entries.delete(tag);
    this.#changed();
  }

  /** The store's answer to a part: taken, refused, or unknown with how it came about. */
  answer(tag: string, part: number, answer: OpAnswer, refusal?: OpRefusal, cause?: UnknownCause): void {
    const entry = this.#entry(tag);
    if (answer === "taken") entry.parts.set(part, { state: "committed", lines: this.#lines(tag, part) });
    else if (answer === "refused") entry.parts.set(part, liveRefusal(refusal));
    else {
      // A snapshot that settled the op is in the view now, so this part's own line, if it committed, is there to find.
      // Another part's line of the same tag says nothing of this one, which may have been refused (W7-SOL-02).
      const lines = cause === "snapshot" ? this.#lines(tag, part) : [];
      if (lines.length > 0) entry.parts.set(part, { state: "committed", lines });
      else {
        entry.parts.set(part, { state: "checking" });
        this.#changed();
        void this.lookup(tag);
        return;
      }
    }
    this.#changed();
  }

  #lines(tag: string, part?: number): LogEntry[] {
    return this.env ? findRolls(this.env.log(), tag, part) : [];
  }

  /**
   * Asks the server once what became of a tag: every part it holds a
   * receipt for settles, and every part this page sent that it lacks is
   * unknown. A failed request leaves the parts unknown too, which is safe:
   * unknown never acts on its own.
   */
  lookup(tag: string): Promise<void> {
    const entry = this.#entry(tag);
    if (entry.looking) return entry.looking;
    if (entry.looked && ![...entry.parts.values()].some((p) => p.state === "checking")) return Promise.resolve();
    entry.looking = this.#ask(tag, entry).finally(() => {
      entry.looking = null;
    });
    return entry.looking;
  }

  async #ask(tag: string, entry: Entry): Promise<void> {
    entry.looked = true;
    for (const [part, state] of entry.parts) if (state.state !== "committed" && state.state !== "refused") entry.parts.set(part, { state: "checking" });
    if (entry.parts.size === 0) entry.parts.set(0, { state: "checking" });
    this.#changed();
    let answer: ReceiptLookup | null = null;
    try {
      answer = this.env ? await this.env.lookup(tag) : null;
    } catch {
      answer = null;
    }
    const held = new Map((answer?.parts ?? []).map((p) => [p.part, p]));
    for (const [part, state] of entry.parts) {
      if (state.state !== "checking") continue;
      const found = held.get(part);
      if (!found) entry.parts.set(part, { state: "unknown" });
      else if (found.state === "committed") entry.parts.set(part, { state: "committed", lines: found.lines });
      else entry.parts.set(part, refusedPart(found.code, found.message));
    }
    // Parts this page never sent, such as a group's other batches after a reload.
    for (const [part, found] of held) {
      if (entry.parts.has(part)) continue;
      entry.parts.set(part, found.state === "committed" ? { state: "committed", lines: found.lines } : refusedPart(found.code, found.message));
    }
    this.#changed();
  }

  /** A tag as a surface reads it, or null when this page has never heard of it. */
  state(tag: string): ReceiptState | null {
    const entry = this.#entries.get(tag);
    if (!entry || entry.parts.size === 0) return null;
    const parts = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    if (parts.some((p) => p.state === "sending")) return { state: "sending" };
    if (parts.some((p) => p.state === "checking")) return { state: "checking" };
    if (parts.some((p) => p.state === "unknown")) return { state: "unknown" };
    const committed = parts.filter((p): p is Extract<PartState, { state: "committed" }> => p.state === "committed");
    const refused = parts.find((p): p is Extract<PartState, { state: "refused" }> => p.state === "refused");
    if (committed.length === 0 && refused) return refused;
    // What the answers and lookups kept, merged with the live log by entry id, the live entry winning and in log order:
    // the live log may have trimmed some of a group's lines and not others, and a lookup may hold all of them.
    const byId = new Map<string, LogEntry>();
    for (const p of committed) for (const line of p.lines) byId.set(line.id, line);
    for (const line of this.#lines(tag)) byId.set(line.id, line);
    const lines = [...byId.values()].sort((a, b) => compareLogIds(a.id, b.id));
    return refused ? { state: "committed", lines, refused: { code: refused.code, message: refused.message, text: refused.text } } : { state: "committed", lines };
  }

  /** A surface shows this tag while mounted. */
  watch(tag: string): () => void {
    const entry = this.#entry(tag);
    entry.watchers++;
    // A surface that shows it again has shown it.
    entry.unseen = false;
    return () => {
      entry.watchers--;
      // The last surface of an unseen result closed, so the toasts look again.
      if (entry.unseen && entry.watchers === 0) this.#changed();
    };
  }

  /**
   * Settled tags no surface shows that were not told yet, each once, for the
   * toast of a roll whose surface closed before its answer (8.7 rule 3).
   */
  unannounced(): { tag: string; state: Exclude<ReceiptState, { state: "sending" | "checking" }> }[] {
    const out: { tag: string; state: Exclude<ReceiptState, { state: "sending" | "checking" }> }[] = [];
    for (const [tag, entry] of this.#entries) {
      if (entry.announced || entry.watchers > 0) continue;
      const state = this.state(tag);
      if (!state || state.state === "sending" || state.state === "checking") continue;
      entry.announced = true;
      entry.unseen = false;
      out.push({ tag, state });
    }
    return out;
  }

  /** A tag shown where it was sent is told there, and never to the toasts. */
  announced(tag: string): void {
    const entry = this.#entries.get(tag);
    if (entry && !entry.unseen) entry.announced = true;
  }

  /**
   * A committed result the roll animation still held back as its panel
   * closed: no surface showed it, so it goes to the toasts once no surface
   * shows it, in whatever order the closing surfaces clean up.
   */
  unseen(tag: string): void {
    const entry = this.#entries.get(tag);
    if (!entry) return;
    entry.unseen = true;
    entry.announced = false;
    this.#changed();
  }
}

export const receiptsSlot = scopeSlot(() => new ReceiptTracker());

/** This room's tracker, bound to the room's lookup and the viewer's log. */
export function useReceipts(): ReceiptTracker {
  const tracker = useScoped(receiptsSlot);
  const roomId = useRoomView((s) => s.roomId);
  const store = useRoomStore();
  // The log is read from the store when an answer lands, which is before any render shows it.
  tracker.env ??= { lookup: (tag) => api.getReceipts(roomId, tag), log: () => store.getState().view?.log ?? [] };
  return tracker;
}

/**
 * The state of one tag for a surface (8.7), null for no tag. A tag this page
 * never sent, such as one a surface kept across a reload, is looked up once.
 * While mounted the surface shows its result, so no toast tells it again.
 */
export function useReceipt(tag: string | null): ReceiptState | null {
  const tracker = useReceipts();
  useSyncExternalStore(tracker.subscribe, tracker.version, tracker.version);
  useEffect(() => {
    if (tag === null) return;
    const stop = tracker.watch(tag);
    if (tracker.state(tag) === null) void tracker.lookup(tag);
    return () => {
      stop();
      // A result the surface showed before it closed is not news.
      const state = tracker.state(tag);
      if (state && state.state !== "sending" && state.state !== "checking") tracker.announced(tag);
    };
  }, [tracker, tag]);
  return tag === null ? null : (tracker.state(tag) ?? { state: "checking" });
}
