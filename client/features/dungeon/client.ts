import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { WingClear } from "#shared/rules/wingClear.ts";
import type { SceneInput } from "../scenes/create.ts";
import type { DungeonEdits, RoomFacts } from "./edits.ts";
import type { KeyInput } from "./keyPage.ts";
import type { DungeonPlan, WingBase } from "./plan.ts";
import type { Seed } from "./seed.ts";
import type { DungeonSettings, PlanContext } from "./settings.ts";
import type { WingProblem } from "./wing.ts";
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

/**
 * A preview as the worker answers it. Made: the plan, the ops Make sends,
 * the scratch room they landed in and the foot's counts, with each kept
 * room's facts for the room panel and the room count the plan asked for
 * (phase 3, 4.1 and 4.2), and for a wing what its asks carry (3.6). Not
 * made: "fit" with why a fit gave up (past its plans, under two rooms, or
 * edits over a hex scene's walls) or a wing's problem, or "bug".
 */
export type Preview =
  | { ok: true; plan: DungeonPlan; ops: ClientOp[]; room: RoomState; summary: Summary; facts: RoomFacts[]; fitted: number; clear?: WingClear }
  | { ok: false; error: "fit" | "bug"; why?: "tooMany" | "underTwo" | "edits"; problem?: WingProblem };

/** What the page needs of a worker, so the tests can stand one in. */
export type PreviewWorker = {
  postMessage(message: ToWorker): void;
  addEventListener(type: "message", listener: (e: MessageEvent<FromWorker>) => void): void;
  addEventListener(type: "error" | "messageerror", listener: () => void): void;
  terminate(): void;
};

type Request = { id: number; message: Extract<ToWorker, { id: number }>; resolve(preview: Preview): void };

export class DungeonPreviews {
  readonly #spawn: () => PreviewWorker;
  #worker: PreviewWorker | null = null;
  #next = 0;
  #drawing: Request | null = null;
  #waiting: Request | null = null;
  #base: WingBase | null = null;

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

  preview(settings: DungeonSettings, seed: Seed, scene: SceneInput, context: PlanContext, key: KeyInput | null, edits: DungeonEdits | null = null): Promise<Preview> {
    return this.#ask((id) => ({ t: "preview", id, settings, seed, scene, context, key, edits }));
  }

  /**
   * Posts a wing's base to the worker (phase 3, 3.3), which plans every
   * wing on the newest one posted, ahead of any request asked after it.
   * The page keeps it, so a worker started again after one died gets it
   * before its first request.
   */
  base(base: WingBase): void {
    this.#base = base;
    try {
      // A worker started here gets the base as it starts.
      if (this.#worker) this.#worker.postMessage({ t: "base", base });
      else this.#ensure();
    } catch {
      // A worker that cannot start is left for the next request, which posts the base to a fresh one first.
      this.#worker?.terminate();
      this.#worker = null;
    }
  }

  /** A preview of a wing on the base posted last. Only the newest request of either kind is answered. */
  wing(settings: DungeonSettings, seed: Seed, context: PlanContext, key: KeyInput | null, edits: DungeonEdits | null = null): Promise<Preview> {
    return this.#ask((id) => ({ t: "wing", id, settings, seed, context, key, edits }));
  }

  #ask(message: (id: number) => Extract<ToWorker, { id: number }>): Promise<Preview> {
    const id = ++this.#next;
    return new Promise((resolve) => {
      const request = { id, message: message(id), resolve };
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
    this.#base = null;
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
    if (this.#base) worker.postMessage({ t: "base", base: this.#base });
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

/** A preview of the choices and seed at the room's scale, with its key or none, and the room edits, drawn in the worker. Only the newest call's promise settles. */
export function preview(settings: DungeonSettings, seed: Seed, scene: SceneInput, context: PlanContext, key: KeyInput | null, edits: DungeonEdits | null = null): Promise<Preview> {
  return previews().preview(settings, seed, scene, context, key, edits);
}

/** Posts the base a wing is planned on (phase 3, 3.3): Generate a wing posts it as the pane opens, and again when the scene changes under it. */
export function postWingBase(base: WingBase): void {
  previews().base(base);
}

/** A preview of a wing on the base posted last, drawn in the worker. Only the newest call's promise settles, of a wing's or a dungeon's. */
export function previewWing(settings: DungeonSettings, seed: Seed, context: PlanContext, key: KeyInput | null, edits: DungeonEdits | null = null): Promise<Preview> {
  return previews().wing(settings, seed, context, key, edits);
}

/** Loads the worker as the dialog opens (section 8). */
export function warmPreviews(): void {
  previews().warm();
}

/** Ends the worker as the dialog closes, dropping any late answer. */
export function closePreviews(): void {
  shared?.close();
}
