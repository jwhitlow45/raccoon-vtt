import { useMemo } from "react";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OpAnswer } from "../../state/types.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { dropMode, planGroup, planOne, type DropPlan, type DropToken, type Point, type Role, type Stop } from "./drop.ts";
import { sendPlan } from "./send.ts";
import { holdSlot, sameHold, stopNoteSlot } from "./store.ts";

/** The part of a Konva node a drag reads and moves. */
type DragNode = { x(): number; y(): number; position(p: Point): void };

/**
 * What the map canvas (client/canvas/Stage.tsx) asks of walls and ledges
 * while a token is dragged and dropped (docs/design-v1-maps-vision.md 4.1).
 * Kept here so the canvas needs a line for each step of a drag.
 */
export type DragStops = {
  /** A drag began: an earlier note about this token goes. */
  start(tokenId: string): void;
  /**
   * A frame of a lone token's drag. While the walk to the finger is stopped,
   * the preview stays on the last clear spot before the wall or the ledge,
   * so a drop never bounces back.
   */
  frame(node: DragNode, token: DropToken): void;
  /** Where the drop puts the dragged token, and the rest of its group, by the rules. */
  plan(node: DragNode, token: DropToken, group: readonly DropToken[]): DropPlan;
  /**
   * Sends the plan's moves, and says what stopped any of them (send.ts).
   * `onAnswer` hears what became of each op sent (OpAnswer). Returns the
   * `n` of each op sent.
   */
  send(plan: DropPlan, onAnswer?: (op: ClientOp, answer: OpAnswer) => void): number[];
  /** The drag ended without a drop. */
  end(): void;
};

const NOTHING: DropPlan = { moves: [], stop: null, held: [] };

export function useDragStops(role: Role): DragStops {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  return useMemo(() => {
    const holds = scope.get(holdSlot);
    const notes = scope.get(stopNoteSlot);
    /** Where the finger is, before a hold moved the preview back to the wall: the drop's own spot. */
    let raw: ({ tokenId: string } & Point) | null = null;
    /*
     * The leg test runs again only when the finger crosses into another
     * quarter cell, the finest step a drop snaps by (half cells, and the
     * squeezed spots half a cell off the grid), or the room changed, never on
     * every pointer frame. The walls are derived once per build and cached
     * across drags (walls.ts sceneWalls), so a frame costs at most one drop's
     * leg tests.
     */
    let memo: { view: RoomState; token: DropToken; qx: number; qy: number; stop: Stop | null } | null = null;
    const setHold = (next: { tokenId: string; at: Point; blocker: Stop["blocker"] } | null) => {
      if (!sameHold(holds.getState().hold, next)) holds.setState({ hold: next });
    };
    const reset = () => {
      raw = null;
      memo = null;
      setHold(null);
    };
    return {
      start(tokenId) {
        reset();
        const s = notes.getState();
        if (s.note?.tokenId === tokenId && !s.busy) notes.setState({ note: null });
      },
      frame(node, token) {
        raw = { tokenId: token.id, x: node.x(), y: node.y() };
        const view = store.getState().view;
        if (!view || dropMode(role, view.scenes[token.sceneId]) !== "walk") {
          setHold(null);
          return;
        }
        const qx = Math.floor(raw.x * 4);
        const qy = Math.floor(raw.y * 4);
        if (!memo || memo.view !== view || memo.token !== token || memo.qx !== qx || memo.qy !== qy) {
          memo = { view, token, qx, qy, stop: planOne(view, token, raw, "walk").stop };
        }
        const stop = memo.stop;
        if (stop) node.position(stop.at);
        setHold(stop ? { tokenId: token.id, at: stop.at, blocker: stop.blocker } : null);
      },
      plan(node, token, group) {
        const at = raw?.tokenId === token.id ? { x: raw.x, y: raw.y } : { x: node.x(), y: node.y() };
        reset();
        const view = store.getState().view;
        if (!view) return NOTHING;
        const mode = dropMode(role, view.scenes[token.sceneId]);
        return group.length <= 1 ? planOne(view, token, at, mode) : planGroup(view, group, at.x - token.x, at.y - token.y, mode);
      },
      send(plan, onAnswer) {
        return sendPlan(plan, {
          dispatch: (op, opts) => actions.dispatch(op, onAnswer ? { ...opts, onAnswer: (answer) => onAnswer(op, answer) } : opts),
          newId: () => actions.newId(),
          note: (note) => notes.setState({ note, busy: false }),
          notify: (text) => ui.notify(text),
          showActions: (open) => ui.showActions(open),
        });
      },
      end: reset,
    };
  }, [store, actions, ui, scope, role]);
}
