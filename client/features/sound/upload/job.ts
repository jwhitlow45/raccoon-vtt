import { createStore, type StoreApi } from "zustand/vanilla";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { OpOf } from "#shared/protocol.ts";
import type { SoundId, SoundUse } from "#shared/sound.ts";
import type { AssetRow, ProgressUploadOptions } from "../../../lib/api.ts";
import type { Prepared, ReadOutcome, ReadStep } from "./read.ts";
import { refusalWords, soundNameOf, uploadRefusal, type Refusal, type RowStep } from "./words.ts";

/**
 * The queue of files the Add buttons picked (docs/design/design-v1-music.md
 * 4.2): one row a file, each through reading, converting, uploading and
 * `sound.create`, its refusal on its own row while the others go on. One
 * file is read at a time, since reading is what takes the device's memory.
 * A file's upload goes on while the next one is read, through the device's
 * one upload queue (client/lib/api.ts). The room running out of storage
 * stops the whole batch. The queue lives in the room's scope, in memory,
 * so closing the panel loses nothing and leaving the room drops it.
 */

export type Row = {
  id: string;
  use: SoundUse;
  fileName: string;
  step: RowStep;
  /** The new sound's name, once added, for "Added Rain.". */
  added?: string;
};

export type QueueState = { rows: Row[] };

/** What became of `sound.create`: taken, refused with the store's words, or not heard, when the room state says. */
export type CreateAnswer = { t: "taken" } | { t: "refused"; text: string } | { t: "unknown" };

/** The protocol's own op, so the queue never sends a shape the room does not take. */
export type SoundCreate = Omit<OpOf<"sound.create">, "t">;

export type QueueDeps = {
  prepare(input: { file: File; use: SoundUse; signal: AbortSignal; onStep(step: ReadStep): void }): Promise<ReadOutcome>;
  upload(blob: Blob, options: ProgressUploadOptions & { signal: AbortSignal }): Promise<AssetRow>;
  create(op: SoundCreate): Promise<CreateAnswer>;
  /** Whether the room's state holds the sound, for a `sound.create` whose answer was not heard. */
  holds(soundId: SoundId): boolean;
  newId(): string;
  /** How long "Added Rain." stays. */
  setTimer(run: () => void, ms: number): () => void;
  onAdded?(soundId: SoundId): void;
  onStorageChanged?(): void;
};

/** "Added Rain." goes after this (4.2 step 6). */
export const ADDED_MS = 3_000;

type Live = { row: Row; file: File; controller: AbortController; uploading: boolean; clearTimer?: () => void };

export class SoundQueue {
  readonly store: StoreApi<QueueState> = createStore<QueueState>(() => ({ rows: [] }));
  #deps: QueueDeps;
  readonly #live = new Map<string, Live>();
  /** Rows waiting to be read, in order. */
  readonly #waiting: string[] = [];
  #reading: string | null = null;

  constructor(deps: QueueDeps) {
    this.#deps = deps;
  }

  /** The deps of the room's latest render: the actions and store stay, but the callbacks may change. */
  setDeps(deps: QueueDeps): void {
    this.#deps = deps;
  }

  /** Queues picked files for one section. Past SOUND_LIMITS.pickFiles a pick takes its first files. Returns how many it left out. */
  add(files: readonly File[], use: SoundUse): number {
    const taken = files.slice(0, SOUND_LIMITS.pickFiles);
    for (const file of taken) {
      const row: Row = { id: this.#deps.newId(), use, fileName: file.name, step: { t: "waiting" } };
      this.#live.set(row.id, { row, file, controller: new AbortController(), uploading: false });
      this.#waiting.push(row.id);
    }
    this.#publish();
    this.#pump();
    return files.length - taken.length;
  }

  /** Cancel on a row still under way: it stops wherever it is, and its row goes. */
  cancel(rowId: string): void {
    const live = this.#live.get(rowId);
    if (!live || isFinal(live.row.step)) return;
    this.#drop(rowId);
    live.controller.abort(new DOMException("The file was cancelled.", "AbortError"));
    if (live.uploading) this.#deps.onStorageChanged?.();
    this.#publish();
    this.#pump();
  }

  /** Dismiss on a refused row, or an added one before its time. */
  dismiss(rowId: string): void {
    const live = this.#live.get(rowId);
    if (!live || !isFinal(live.row.step)) return;
    live.clearTimer?.();
    this.#drop(rowId);
    this.#publish();
  }

  /**
   * The room went away: everything under way stops, and nothing it would
   * send is sent. The queue still takes files after, since React's
   * development double mount disposes a room's scope and goes on using it.
   */
  dispose(): void {
    for (const [id, live] of this.#live) {
      live.clearTimer?.();
      live.controller.abort(new DOMException("The room closed.", "AbortError"));
      this.#drop(id);
    }
    this.#publish();
  }

  /** A row's end. A read under way keeps the read slot until it settles, since a decode cannot be stopped partway and two would hold twice the memory. */
  #drop(rowId: string): void {
    this.#live.delete(rowId);
    const at = this.#waiting.indexOf(rowId);
    if (at >= 0) this.#waiting.splice(at, 1);
  }

  #publish(): void {
    this.store.setState({ rows: [...this.#live.values()].map((l) => l.row) });
  }

  #set(live: Live, step: RowStep): void {
    if (this.#live.get(live.row.id) !== live) return;
    live.row = { ...live.row, step };
    this.#publish();
  }

  #pump(): void {
    if (this.#reading !== null) return;
    const next = this.#waiting.shift();
    if (next === undefined) return;
    const live = this.#live.get(next)!;
    this.#reading = next;
    void this.#run(live);
  }

  async #run(live: Live): Promise<void> {
    const { signal } = live.controller;
    let prepared: Prepared;
    try {
      const outcome = await this.#deps.prepare({
        file: live.file,
        use: live.row.use,
        signal,
        onStep: (step) => {
          if (!signal.aborted) this.#set(live, step.t === "reading" ? { t: "reading" } : { t: "converting", percent: step.percent });
        },
      });
      if (signal.aborted) return;
      if (!outcome.ok) return this.#refuse(live, outcome.why);
      prepared = outcome.prepared;
    } catch (err) {
      if (signal.aborted) return;
      console.error("raccoon: reading a sound failed", err);
      return this.#refuse(live, { t: "failed" });
    } finally {
      if (this.#reading === live.row.id) this.#reading = null;
      // The next file starts reading while this one uploads.
      this.#pump();
    }
    await this.#send(live, prepared);
  }

  async #send(live: Live, prepared: Prepared): Promise<void> {
    const { signal } = live.controller;
    live.uploading = true;
    this.#set(live, { t: "uploading", percent: 0 });
    let row: AssetRow;
    try {
      row = await this.#deps.upload(prepared.blob, {
        name: `${live.row.fileName}.mp3`,
        signal,
        onProgress: (fraction) => {
          if (!signal.aborted) this.#set(live, { t: "uploading", percent: Math.floor(fraction * 100) });
        },
      });
    } catch (err) {
      if (signal.aborted) return;
      const why = uploadRefusal(err);
      this.#refuse(live, why);
      if (why.t === "outOfStorage") this.#stopBatch(live);
      this.#deps.onStorageChanged?.();
      return;
    }
    if (signal.aborted) return;
    // From here the file is the room's: a cancel now leaves it unnamed, for the cleanup a day later (7.3).
    this.#set(live, { t: "adding" });
    const soundId = this.#deps.newId();
    const name = soundNameOf(live.row.fileName);
    let answer: CreateAnswer;
    try {
      answer = await this.#deps.create({
        id: soundId,
        assetId: row.id,
        name,
        use: live.row.use,
        // The server fills it from the row in any case, and the row's is the file's own.
        ms: row.audio?.ms ?? prepared.ms,
        ...(prepared.level !== 0 ? { level: prepared.level } : {}),
      });
    } catch {
      answer = { t: "unknown" };
    }
    if (signal.aborted || this.#live.get(live.row.id) !== live) return;
    this.#deps.onStorageChanged?.();
    if (answer.t === "refused") return this.#refuse(live, { t: "server", text: answer.text });
    if (answer.t === "unknown" && !this.#deps.holds(soundId)) return this.#refuse(live, { t: "server", text: "it may not have been added. Check the list, and add it again if it is missing." });
    live.row = { ...live.row, added: name };
    this.#set(live, { t: "added" });
    this.#deps.onAdded?.(soundId);
    live.clearTimer = this.#deps.setTimer(() => this.dismiss(live.row.id), ADDED_MS);
  }

  #refuse(live: Live, why: Refusal): void {
    this.#set(live, { t: "refused", text: refusalWords(live.row.fileName, why) });
  }

  /** The room is full: every other file of the batch stops, and their rows go, the refused row saying why. */
  #stopBatch(except: Live): void {
    for (const [id, live] of [...this.#live]) {
      if (live === except || isFinal(live.row.step)) continue;
      live.controller.abort(new DOMException("The room is out of storage space.", "AbortError"));
      this.#drop(id);
    }
    this.#publish();
  }
}

export function isFinal(step: RowStep): boolean {
  return step.t === "added" || step.t === "refused";
}

/** Whether any file of the queue is still under way, for Leave room's question. */
export function queueBusy(state: QueueState): boolean {
  return state.rows.some((row) => !isFinal(row.step));
}
