import type { RoomState, Scene, SightTile } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OnAnswer, OpRefusal, RoomActions } from "../../state/types.ts";
import type { ServerSound } from "../sound/engine/store.ts";
import type { Playlists, Sounds } from "../sound/panel/state.ts";
import { playersPlace } from "../floors/words.ts";
import { moveWarning } from "../vision/moveWarning.ts";
import { moveSoundOp } from "./moveSound.ts";

/**
 * Moving the players to a scene, the one way every control does it
 * (docs/design/design-v1-qol.md 6): the Scenes list's Move players, and the DM menu's
 * Move players here and Show players <scene> (design-v1-qol.md 4, C2's move). A move that
 * may show players more or less than the DM expects asks first
 * (vision/moveWarning.ts). The move goes with the scene's own sound
 * (moveSound.ts), and a reveal adds the lift of the blackout guarded by
 * that scene, so a move refused or overtaken leaves the blackout on.
 */

/** The words of a move the server has not answered yet, shown after the shared indicator's delay. */
export const MOVING_PLAYERS = "Moving players…";

/** Where the server's room has the players and which scenes it has, as a snapshot that settled a move holds them (RoomView.confirmed). */
export type ConfirmedRoom = { meta: { playerSceneId: string | null }; scenes: Readonly<Record<string, Pick<Scene, "name" | "floor"> | undefined>> };

/**
 * What a move reads of the room: the scene the DM looks at, whose sight
 * the view holds, the sound the scene's own is built from, and, read only
 * when a snapshot settled the move with its answer lost, the server's room.
 */
export type MoveRoom = {
  viewingId: string | null;
  sight: Readonly<Record<string, SightTile | undefined>> | undefined;
  serverSound: ServerSound;
  playlists: Playlists;
  sounds: Sounds;
  confirmed(): ConfirmedRoom | null | undefined;
};

/** What a move asks the DM to confirm first, or null when it goes at once. */
export function moveQuestion(scene: Scene, room: Pick<MoveRoom, "viewingId" | "sight">): string | null {
  return moveWarning({ scene, viewing: scene.id === room.viewingId, sight: room.sight });
}

/**
 * How a move that went out ended. `refused` names the op the server
 * refused: the move (the players stayed, and a reveal's lift is refused
 * after it), or for a reveal the lift alone (the players moved, and the
 * blackout stays on). `notMoved` is a move whose answer was lost, to a
 * reconnect or to a resync such as the one a co-DM's delete of the DM's
 * scene sends, and whose snapshot has the players elsewhere: `sceneGone`
 * when the move's scene is no longer there, and `playersOn` the name of
 * the scene they are on. `unknown` is any other answer lost: the lift's,
 * or a move dropped as too old to send, which the store's toast says.
 */
export type MoveAnswer =
  | { t: "taken" }
  | { t: "refused"; step: "move" | "lift"; refusal: OpRefusal | undefined }
  | { t: "notMoved"; sceneGone: boolean; playersOn: string | null }
  | { t: "unknown" };

/** A press's result: the question to ask, with nothing sent, or the move sent and its answer to come. */
export type MoveStep = { t: "ask"; warning: string } | { t: "sent"; answer: Promise<MoveAnswer> };

export type MoveOptions = {
  /** The DM said yes to the question, so the move goes whatever it would ask. */
  confirmed?: boolean;
  /** Show players <scene>: the lift of the blackout follows the move, guarded by the scene, one Undo with it. */
  reveal?: boolean;
  /** No toast for a refusal, for a caller that says it in place. */
  quiet?: boolean;
};

/**
 * One press of a move. Unconfirmed where the scene asks, it sends nothing
 * and answers the question. Otherwise it sends the move, the scene's own
 * sound, and for a reveal the guarded lift, the move and the lift under
 * one undo group. The sound records no undo step (shared/undoScope.ts).
 */
export function movePlayers(actions: Pick<RoomActions, "dispatch" | "newId">, scene: Scene, room: MoveRoom, opts: MoveOptions = {}): MoveStep {
  const warning = moveQuestion(scene, room);
  if (warning !== null && opts.confirmed !== true) return { t: "ask", warning };
  const group = opts.reveal ? actions.newId() : undefined;
  const sent = (op: ClientOp, onAnswer: OnAnswer) =>
    actions.dispatch(op, { onAnswer, ...(group !== undefined ? { group } : {}), ...(opts.quiet ? { quiet: true } : {}) }) !== null;
  // The first answer that settles the press wins: the move's refusal comes before the lift's, since the server answers in order.
  let resolve!: (answer: MoveAnswer) => void;
  const answer = new Promise<MoveAnswer>((r) => (resolve = r));
  const settle = (step: "move" | "lift", last: boolean): OnAnswer => (a, refusal, unknown) => {
    if (a === "refused") return resolve({ t: "refused", step, refusal });
    if (a === "unknown") {
      // The answer was lost to a reconnect, or to a resync: the server sends no refusal to a socket without a snapshot
      // (server/rooms/fanout.ts publishBatch). The store tells only once the snapshot that settled it is in, so where that has the players says.
      const missed = step === "move" && unknown === "snapshot" ? lostMove(scene.id, room.confirmed()) : null;
      if (missed === null) return resolve({ t: "unknown" });
      if (missed.t === "notMoved") return resolve(missed);
      // The players are on the scene, as if the move were taken: a reveal still waits on its lift.
    }
    if (last) resolve({ t: "taken" });
  };
  if (!sent({ t: "room.setPlayerScene", sceneId: scene.id }, settle("move", !opts.reveal))) resolve({ t: "refused", step: "move", refusal: undefined });
  else if (opts.reveal && !sent({ t: "view.blackout", blackout: false, whilePlayersOn: scene.id }, settle("lift", true))) resolve({ t: "refused", step: "lift", refusal: undefined });
  // As the Scenes list always sent it: the sound plays only while the players are on the scene, so a move that did not go leaves it silent.
  const sound = moveSoundOp(scene, { serverSound: room.serverSound, playlists: room.playlists, sounds: room.sounds, newId: () => actions.newId() });
  if (sound) actions.dispatch(sound);
  return { t: "sent", answer };
}

/** What a snapshot that settled a move with its answer lost says of it: the players on the move's scene, or not moved and why. Null without a snapshot to read. */
function lostMove(sceneId: string, confirmed: ConfirmedRoom | null | undefined): { t: "moved" } | Extract<MoveAnswer, { t: "notMoved" }> | null {
  if (!confirmed) return null;
  const on = confirmed.meta.playerSceneId;
  if (on === sceneId) return { t: "moved" };
  // The helper reads only a scene's name and its floor's name, which the narrower record holds. "Another floor" when they are on one of this scene's floors.
  const place = on === null ? "" : playersPlace({ scenes: confirmed.scenes as RoomState["scenes"] }, on, sceneId);
  return { t: "notMoved", sceneGone: confirmed.scenes[sceneId] === undefined, playersOn: place === "" ? null : place };
}

/** The scene a move this page sent is going to while the server has not answered, or null. */
export function movingPlayersTo(pending: readonly { op: ClientOp }[]): string | null {
  for (const p of pending) if (p.op.t === "room.setPlayerScene") return p.op.sceneId;
  return null;
}
