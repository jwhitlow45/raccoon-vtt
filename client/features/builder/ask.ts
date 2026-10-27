import { serializedBytes } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { ASK_LOST, MAX_ASK_BYTES, MAX_ASK_OPS, MAX_ASK_PARTS, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { keepsMemory } from "#shared/reducer/memory.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomUi } from "../../state/store.ts";
import type { OpAnswer, OpRefusal, RoomActions } from "../../state/types.ts";
import type { ToolContext } from "../tools.ts";
import { builderSlot } from "./store.ts";

type Askable = OpOf<"build.ask">["ops"][number];

const ASKABLE: ReadonlySet<ClientOp["t"]> = new Set<Askable["t"]>(["build.paint", "build.erase", "build.rect", "build.edge", "build.height", "build.stairs", "build.rough"]);

/** The builder's line while a gesture waits for the server's answer to its asks. */
export const BUILD_ASKING = "Checking players' remembered map…";

/** The toast when the server lost a gesture's asks twice over, and nothing of it was made. */
export const BUILD_NOT_MADE = "The change was not made: the server lost track of it. Make it again.";

/** What sending a builder gesture needs: the room's actions, a toast, the scene, and the builder's count of gestures waiting on their asks. */
export type BuildContext = {
  actions: Pick<RoomActions, "dispatch" | "newId">;
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
 * `forget`. Asks the server lost, to a restart or a dropped connection,
 * go again from the start once, and a second loss says the change was not
 * made.
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
  ctx.waiting?.(1);
  preflight(ctx, ops, true);
}

type Heard = { answer: OpAnswer; refusal?: OpRefusal };

/** Sends the gesture's asks under a fresh group, the last holding its ops, and acts once all are answered. */
function preflight(ctx: BuildContext, ops: readonly ClientOp[], again: boolean): void {
  const group = ctx.actions.newId();
  const asks = askOps(ctx.scene.id, ops);
  const heard: Heard[] = [];
  let left = asks.length;
  const hear = (h: Heard) => {
    heard.push(h);
    if (--left === 0) settle(ctx, ops, group, heard, again);
  };
  asks.forEach((ask, i) => {
    const holds = i === asks.length - 1 ? { holds: ops } : {};
    const n = ctx.actions.dispatch(ask, { group, ...holds, onAnswer: (answer, refusal) => hear({ answer, ...(refusal ? { refusal } : {}) }) });
    if (n === null) hear({ answer: "refused" });
  });
}

/** Every ask answered: the ops go, the forget question stands, or the asks go again. */
function settle(ctx: BuildContext, ops: readonly ClientOp[], group: string, heard: readonly Heard[], again: boolean): void {
  if (heard.every((h) => h.answer === "taken")) {
    for (const op of ops) ctx.actions.dispatch(op, { group });
    ctx.waiting?.(-1);
    return;
  }
  // The store asks the forget question about the ops the last ask holds.
  if (heard.some((h) => h.refusal?.code === "forget")) {
    ctx.waiting?.(-1);
    return;
  }
  const lost = heard.some((h) => h.answer === "unknown" || (h.refusal?.code === "invalid" && h.refusal.message === ASK_LOST));
  if (lost && again) {
    preflight(ctx, ops, false);
    return;
  }
  ctx.waiting?.(-1);
  ctx.ui.notify(lost ? BUILD_NOT_MADE : (heard.find((h) => h.refusal)?.refusal?.text ?? BUILD_NOT_MADE), "error");
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
