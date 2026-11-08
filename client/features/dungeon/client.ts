import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { SceneInput } from "../scenes/create.ts";
import type { KeyInput } from "./keyPage.ts";
import type { DungeonPlan } from "./plan.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings, PlanContext } from "./settings.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

/*
 * The page's side of the dungeon worker (docs/design/design-v1-dungeon-generator.md
 * 4.3 and 5.5). Only the newest request is answered: one is drawn at a
 * time, a request asked while one draws waits and is replaced by any newer
 * one, and an answer to anything but the newest is dropped, so quick
 * choice changes never show an old dungeon. A dropped request's promise
 * never settles, so a caller only ever hears the newest answer. Closing
 * ends the worker and drops whatever was waiting. Nothing here sends an op.
 */

/** The foot's counts. Secret doors count doorways as doors do, and are counted among them. */
export type Summary = { rooms: number; asked: number; doors: number; locked: number; traps: number; secretDoors: number; secretRooms: number; lights: number };

export type Preview = { ok: true; plan: DungeonPlan; ops: ClientOp[]; room: RoomState; summary: Summary } | { ok: false; error: "fit" | "bug" };

/** What the page needs of a worker, so the tests can stand one in. */
export type PreviewWorker = {
  postMessage(message: ToWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: () => void): void;
  terminate(): void;
};

type Request = { id: number; message: ToWorker; resolve(preview: Preview): void };

export class DungeonPreviews {
  readonly #spawn: () => PreviewWorker;
  #worker: PreviewWorker | null = null;
  #next = 0;
  #drawing: Request | null = null;
  #waiting: Request | null = null;

  constructor(spawn: () => PreviewWorker) {
    this.#spawn = spawn;
  }

  /**
   * Starts the worker ahead of the first preview, as the dialog opens, so its load overlaps the dialog's own.
   * A worker the page cannot start is left for the first preview, which answers it as the bug error.
   */
  warm(): void {
    try {
      this.#ensure();
    } catch {
      // The dialog's open must not throw. The preview says it could not be made.
    }
  }

  preview(settings: DungeonSettings, seed: Seed, scene: SceneInput, context: PlanContext, key: KeyInput | null): Promise<Preview> {
    const id = ++this.#next;
    return new Promise((resolve) => {
      const request = { id, message: { t: "preview", id, settings, seed, scene, context, key } satisfies ToWorker, resolve };
      // A request still waiting is no longer wanted: only the newest is drawn next.
      this.#waiting = request;
      this.#pump();
    });
  }

  /** Ends the worker. Every request waiting or drawing is dropped, and a later preview starts a new worker. */
  close(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#drawing = null;
    this.#waiting = null;
  }

  #ensure(): PreviewWorker {
    if (this.#worker) return this.#worker;
    const worker = this.#spawn();
    worker.addEventListener("message", (e: MessageEvent<FromWorker>) => {
      if (this.#worker !== worker) return;
      const drawing = this.#drawing;
      if (!drawing || e.data.id !== drawing.id) return;
      this.#drawing = null;
      if (drawing.id === this.#next) drawing.resolve(e.data.preview);
      this.#pump();
    });
    const fail = () => {
      if (this.#worker !== worker) return;
      // A worker that died (out of memory on a huge map, say) answers what it was drawing as a bug, if that is still
      // the newest, and a newer request waiting is drawn by a fresh worker.
      const drawing = this.#drawing;
      worker.terminate();
      this.#worker = null;
      this.#drawing = null;
      if (drawing && drawing.id === this.#next) drawing.resolve({ ok: false, error: "bug" });
      this.#pump();
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    this.#worker = worker;
    return worker;
  }

  #pump(): void {
    if (this.#drawing || !this.#waiting) return;
    const request = this.#waiting;
    this.#waiting = null;
    this.#drawing = request;
    try {
      this.#ensure().postMessage(request.message);
    } catch {
      // A worker that cannot start, or a message it cannot take, answers as a bug, and the next request tries a fresh worker.
      this.#worker?.terminate();
      this.#worker = null;
      this.#drawing = null;
      if (request.id === this.#next) request.resolve({ ok: false, error: "bug" });
      this.#pump();
    }
  }
}

let shared: DungeonPreviews | null = null;

function previews(): DungeonPreviews {
  shared ??= new DungeonPreviews(() => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "dungeon" }));
  return shared;
}

/** A preview of the choices and seed at the room's scale, with its key or none, drawn in the worker. Only the newest call's promise settles. */
export function preview(settings: DungeonSettings, seed: Seed, scene: SceneInput, context: PlanContext, key: KeyInput | null): Promise<Preview> {
  return previews().preview(settings, seed, scene, context, key);
}

/** Loads the worker as the dialog opens (section 8). */
export function warmPreviews(): void {
  previews().warm();
}

/** Ends the worker as the dialog closes, dropping any late answer. */
export function closePreviews(): void {
  shared?.close();
}
