import { uuidv7 } from "#shared/ids.ts";
import { clientMessageSchema, type ClientOp, type EphEvent } from "#shared/protocol.ts";
import { moveOps } from "../lib/group.ts";
import type { RoomSocket } from "./socket.ts";
import type { RoomStore } from "./store.ts";
import type { RoomActions } from "./types.ts";

/**
 * Whether the server would take this event. The server drops an invalid
 * `eph` without a word (server/rooms/ws.ts), so a client bug would only
 * show as a preview nobody else sees. The whole message is checked, with a
 * stand-in scene id, so the payload's size cap counts exactly as it does on
 * the server.
 */
export function validEph(e: EphEvent): boolean {
  return clientMessageSchema.safeParse({ t: "eph", sceneId: "local", e }).success;
}

/**
 * Sends the ops of one gesture as one undo step (design 7.7): a room too
 * big for one op goes out in bands, and one undo should take the whole room
 * back, not the last band. Returns the numbers of the ops it queued, so a
 * button can wait for the server's answer to all of them.
 */
export function dispatchGesture(actions: Pick<RoomActions, "dispatch" | "newId">, ops: readonly ClientOp[], opts: { alwaysGroup?: boolean } = {}): number[] {
  // A lone op is one step anyway. A gesture the server names as a whole, such as a folder rename, keeps its group
  // even then, so its step reads as the gesture and not as its one op.
  const group = ops.length > 1 || opts.alwaysGroup ? actions.newId() : undefined;
  const sent: number[] = [];
  for (const op of ops) {
    const n = actions.dispatch(op, group === undefined ? undefined : { group });
    if (n !== null) sent.push(n);
  }
  return sent;
}

/** Room actions over a store and whatever carries its messages: the live socket, or the dev fixture's local server. */
export function createRoomActions(room: RoomStore, socket: Pick<RoomSocket, "sendEph" | "switchScene">): RoomActions {
  /** Kinds already reported, so a broken preview sending 30 frames a second logs once. */
  const reported = new Set<string>();
  const actions: RoomActions = {
    // While a builder gesture waits on its asks, the store refuses whatever could land before it (store.ts holdBuild).
    dispatch: (op, opts) => room.dispatch(op, opts),
    sendEph(e, opts) {
      if (!validEph(e)) {
        if (!reported.has(e.k)) {
          reported.add(e.k);
          console.error("raccoon: refusing to send a malformed ephemeral event", e);
        }
        return;
      }
      // Konva already draws this device's own drag under the finger.
      const drag = e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd" || e.k === "dragCancel";
      if (!drag) room.recordLocalEph(e);
      if (!opts?.localOnly) socket.sendEph(e);
    },
    switchScene: (sceneId) => socket.switchScene(sceneId),
    // Undo while a gesture waits takes back that gesture, which the server never saw, and sends no undo.
    undo: () => {
      if (!room.cancelHeld()) void room.dispatch({ t: "undo" });
    },
    holdBuild: (cancel) => room.holdBuild(cancel),
    // Redo while a gesture waits does nothing: the store refuses it, since the step it brings back may be a builder one.
    redo: () => void room.dispatch({ t: "redo" }),
    newId: () => uuidv7(),
    moveToken: (tokenId, x, y) => void room.dispatch({ t: "token.move", tokenId, x, y }),
    moveTokens(moves) {
      dispatchGesture(actions, moveOps(moves));
    },
  };
  return actions;
}
