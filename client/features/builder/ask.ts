import { serializedBytes } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { ASK_LOST, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_ASK_PARTS, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { keepsMemory } from "#shared/reducer/memory.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomUi } from "../../state/store.ts";
import type { OpAnswer, OpRefusal, RoomActions, UnknownCause } from "../../state/types.ts";
import type { ToolContext, ToolPointerHandlers } from "../tools.ts";
import { builderSlot } from "./store.ts";

type Askable = OpOf<"build.ask">["ops"][number];

const ASKABLE: ReadonlySet<ClientOp["t"]> = new Set<Askable["t"]>(["build.paint", "build.erase", "build.rect", "build.edge", "build.height", "build.stairs", "build.rough"]);

/** The builder's line while a gesture waits for the server's answer to its asks. */
export const BUILD_ASKING = "Checking players' remembered map…";

/** The toast when the server lost a gesture's asks twice over, and nothing of it was made. */
export const BUILD_NOT_MADE = "The change was not made: the server lost track of it. Make it again.";

/** What sending a builder gesture needs: the room's actions, a toast, the scene, and the builder's count of gestures waiting on their asks. */
export type BuildContext = {
  actions: Pick<RoomActions, "dispatch" | "newId" | "holdBuild">;
  ui: Pick<RoomUi, "notify">;
  scene: Pick<Scene, "id" | "fogEnabled" | "vision">;
  /** Told 1 as a gesture starts waiting on its asks and -1 as it stops, for the builder's line (BUILD_ASKING). */
  waiting?: (change: 1 | -1) => void;
};

/** A tool's BuildContext, its waiting counted on this Room's builder (BuilderState.asking). */
export function buildContext(ctx: Pick<ToolContext, "actions" | "ui" | "scene" | "scope">): BuildContext {
  const store = ctx.scope.get(builderSlot).store;
  return { actions: ctx.actions, ui: ctx.ui, scene: ctx.scene, waiting: (change) => store.setState((s) => ({ asking: Math.max(0, s.asking + change) })) };
}

/**
 * Sends a builder gesture of several ops, asked about first where players
 * remember the scene (docs/design-v1-map-discovery.md 5.3). Its ops stay
 * on the device until the server answers its asks (MD4-ASTRA-5), so none
 * of it applies before the answer and a no leaves nothing to take back.
 * Fits: the ops go under one undo group. Past a cap: the store asks the
 * forget question about them (`holds`), and its yes sends them with
 * `forget`. Asks the server lost, to a restart (ASK_LOST) or a dropped
 * connection (`unknown` by a snapshot), go again from the start once, and
 * a second loss says the change was not made. Asks too old to send
 * (`unknown`, expired) end the gesture with nothing sent, as the store's
 * toast says (MD4-ASTRA-11).
 *
 * While it waits, the room's actions refuse every other builder edit, so
 * none overtakes it, and Undo cancels it: nothing of it goes, and its late
 * answers do nothing (`holdBuild`, D-261027-07, MD4-ASTRA-9).
 *
 * A gesture of one op is asked about by that op itself, and a scene that
 * keeps no memory has nothing to forget. A stroke sends its ops as it
 * goes, so it cannot ask ahead: the server refuses the rest of it from the
 * first op it asks about, and a no takes back with an undo the part sent
 * before. A server restart forgets that refusal, so a stroke's later ops
 * are each asked about by themselves.
 */
export function dispatchBuild(ctx: BuildContext, ops: readonly ClientOp[]): void {
  if (ops.length <= 1 || !keepsMemory(ctx.scene) || askOps(ctx.scene.id, ops).length === 0) {
    dispatchGesture(ctx.actions, ops);
    return;
  }
  const gesture: Waiting = { over: false, release: () => undefined };
  gesture.release = ctx.actions.holdBuild?.(() => end(ctx, gesture)) ?? (() => undefined);
  ctx.waiting?.(1);
  preflight(ctx, ops, gesture, true);
}

/** A gesture waiting on its asks: `over` once it was answered or cancelled, and what lets the builder's edits go again. */
type Waiting = { over: boolean; release: () => void };

type Heard = { answer: OpAnswer; refusal?: OpRefusal; unknown?: UnknownCause };

/** Ends a waiting gesture once: the builder takes edits again and its line clears. */
function end(ctx: BuildContext, gesture: Waiting): void {
  if (gesture.over) return;
  gesture.over = true;
  gesture.release();
  ctx.waiting?.(-1);
}

/** Sends the gesture's asks under a fresh group, the last holding its ops while it waits, and acts once all are answered. */
function preflight(ctx: BuildContext, ops: readonly ClientOp[], gesture: Waiting, again: boolean): void {
  const group = ctx.actions.newId();
  const asks = askOps(ctx.scene.id, ops);
  const heard: Heard[] = [];
  let left = asks.length;
  const hear = (h: Heard) => {
    heard.push(h);
    if (--left === 0) settle(ctx, ops, gesture, group, heard, again);
  };
  asks.forEach((ask, i) => {
    const holds = i === asks.length - 1 ? { holds: () => (gesture.over ? [] : ops) } : {};
    const onAnswer = (answer: OpAnswer, refusal?: OpRefusal, unknown?: UnknownCause) => hear({ answer, ...(refusal ? { refusal } : {}), ...(unknown ? { unknown } : {}) });
    const n = ctx.actions.dispatch(ask, { group, ...holds, onAnswer });
    if (n === null) hear({ answer: "refused" });
  });
}

/** Every ask answered: the ops go, the forget question stands, the asks go again, or the gesture ends with nothing sent. */
function settle(ctx: BuildContext, ops: readonly ClientOp[], gesture: Waiting, group: string, heard: readonly Heard[], again: boolean): void {
  // Cancelled by Undo: its answers came too late to matter.
  if (gesture.over) return;
  if (heard.every((h) => h.answer === "taken")) {
    end(ctx, gesture);
    for (const op of ops) ctx.actions.dispatch(op, { group });
    return;
  }
  // The store asks the forget question about the ops the last ask holds.
  if (heard.some((h) => h.refusal?.code === "forget")) {
    end(ctx, gesture);
    return;
  }
  // Too old to send: the store's toast already counts the gesture among the edits not saved.
  if (heard.some((h) => h.unknown === "expired")) {
    end(ctx, gesture);
    return;
  }
  const lost = heard.some((h) => (h.answer === "unknown" && h.unknown === "snapshot") || (h.refusal?.code === "invalid" && h.refusal.message === ASK_LOST));
  if (lost && again) {
    preflight(ctx, ops, gesture, false);
    return;
  }
  end(ctx, gesture);
  ctx.ui.notify(lost || !heard.some((h) => h.refusal) ? BUILD_NOT_MADE : heard.find((h) => h.refusal)!.refusal!.text, "error");
}

/**
 * The builder's pointer while a gesture waits on its asks (D-261027-07):
 * a press then starts nothing, and its move and lift do nothing, so no
 * edit is begun to overtake the waiting one. The line says it is checking
 * (BUILD_ASKING).
 */
export function whileAsking(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const refused = (ctx: ToolContext) => ctx.scope.get(builderSlot).gesture.asking;
  return {
    ...handlers,
    down: (p, ctx) => {
      const { store, gesture } = ctx.scope.get(builderSlot);
      gesture.asking = store.getState().asking > 0;
      if (!gesture.asking) handlers.down?.(p, ctx);
    },
    move: (p, ctx) => {
      if (!refused(ctx)) handlers.move?.(p, ctx);
    },
    up: (p, ctx) => {
      const gesture = ctx.scope.get(builderSlot).gesture;
      if (gesture.asking) gesture.asking = false;
      else handlers.up?.(p, ctx);
    },
    cancel: (ctx) => {
      ctx.scope.get(builderSlot).gesture.asking = false;
      handlers.cancel?.(ctx);
    },
  };
}

/**
 * A gesture's asks: its builder ops on the scene in order, without a yes,
 * packed into asks of at most MAX_ASK_OPS ops and MAX_ASK_BYTES, numbered
 * by `part`, all but the last marked `more`, so the server answers once
 * for the whole. A gesture past MAX_ASK_PARTS asks gets none, and goes as
 * a stroke goes.
 */
export function askOps(sceneId: string, ops: readonly ClientOp[]): OpOf<"build.ask">[] {
  const parts: Askable[][] = [];
  for (const op of ops) {
    if (!ASKABLE.has(op.t) || (op as { sceneId?: string }).sceneId !== sceneId) continue;
    const { forget: _yes, ...asked } = op as Askable;
    const part = parts.at(-1);
    if (part && part.length < MAX_ASK_OPS && serializedBytes({ t: "build.ask", sceneId, ops: [...part, asked], part: MAX_ASK_PARTS - 1, more: true }) <= MAX_ASK_BYTES) part.push(asked);
    else parts.push([asked]);
  }
  if (parts.length > MAX_ASK_PARTS) return [];
  return parts.map((part, i) => ({ t: "build.ask", sceneId, ops: part, part: i, ...(i < parts.length - 1 ? { more: true as const } : {}) }));
}
