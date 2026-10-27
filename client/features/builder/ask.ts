import { serializedBytes } from "#shared/limits.ts";
import type { Scene } from "#shared/model.ts";
import { MAX_ASK_BYTES, MAX_ASK_OPS, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { keepsMemory } from "#shared/reducer/memory.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { RoomActions } from "../../state/types.ts";

type Askable = OpOf<"build.ask">["ops"][number];

const ASKABLE: ReadonlySet<ClientOp["t"]> = new Set<Askable["t"]>(["build.paint", "build.erase", "build.rect", "build.edge", "build.height", "build.stairs", "build.rough"]);

/**
 * Sends a builder gesture of several ops, asked about first where players
 * remember the scene (docs/design-v1-map-discovery.md 5.3): its asks go
 * under the gesture's undo group ahead of its ops, so the server asks the
 * forget question before any op of it applies and refuses the rest with
 * it, and a no leaves the whole gesture unmade. A gesture of one op is
 * asked about by that op itself, and a scene that keeps no memory has
 * nothing to forget. A stroke sends its ops as it goes, so it cannot ask
 * ahead: the server refuses the rest of it from the first op it asks about.
 */
export function dispatchBuild(actions: Pick<RoomActions, "dispatch" | "newId">, scene: Pick<Scene, "id" | "fogEnabled" | "vision">, ops: readonly ClientOp[]): number[] {
  const asks = ops.length > 1 && keepsMemory(scene) ? askOps(scene.id, ops) : [];
  if (asks.length === 0) return dispatchGesture(actions, ops);
  const group = actions.newId();
  for (const ask of asks) actions.dispatch(ask, { group });
  const sent: number[] = [];
  for (const op of ops) {
    const n = actions.dispatch(op, { group });
    if (n !== null) sent.push(n);
  }
  return sent;
}

/**
 * A gesture's asks: its builder ops on the scene in order, without a yes,
 * packed into asks of at most MAX_ASK_OPS ops and MAX_ASK_BYTES, all but
 * the last marked `more`, so the server answers once for the whole.
 */
export function askOps(sceneId: string, ops: readonly ClientOp[]): OpOf<"build.ask">[] {
  const parts: Askable[][] = [];
  for (const op of ops) {
    if (!ASKABLE.has(op.t) || (op as { sceneId?: string }).sceneId !== sceneId) continue;
    const { forget: _yes, ...asked } = op as Askable;
    const part = parts.at(-1);
    if (part && part.length < MAX_ASK_OPS && serializedBytes({ t: "build.ask", sceneId, ops: [...part, asked], more: true }) <= MAX_ASK_BYTES) part.push(asked);
    else parts.push([asked]);
  }
  return parts.map((part, i) => ({ t: "build.ask", sceneId, ops: part, ...(i < parts.length - 1 ? { more: true as const } : {}) }));
}
