import type { Scene, SightTile } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OnAnswer, OpRefusal, RoomActions } from "../../state/types.ts";
import type { ServerSound } from "../sound/engine/store.ts";
import type { Playlists, Sounds } from "../sound/panel/state.ts";
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

/** What a move reads of the room: the scene the DM looks at, whose sight the view holds, and the sound the scene's own is built from. */
export type MoveRoom = {
  viewingId: string | null;
  sight: Readonly<Record<string, SightTile | undefined>> | undefined;
  serverSound: ServerSound;
  playlists: Playlists;
  sounds: Sounds;
};

/** What a move asks the DM to confirm first, or null when it goes at once. */
export function moveQuestion(scene: Scene, room: Pick<MoveRoom, "viewingId" | "sight">): string | null {
  return moveWarning({ scene, viewing: scene.id === room.viewingId, sight: room.sight });
}

/**
 * How a move that went out ended. `refused` names the op the server
 * refused: the move (the players stayed, and a reveal's lift is refused
 * after it), or for a reveal the lift alone (the players moved, and the
 * blackout stays on). `unknown` is an answer lost to a reconnect, whose
 * snapshot the view already holds.
 */
export type MoveAnswer = { t: "taken" } | { t: "refused"; step: "move" | "lift"; refusal: OpRefusal | undefined } | { t: "unknown" };

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
  const settle = (step: "move" | "lift", last: boolean): OnAnswer => (a, refusal) => {
    if (a === "refused") resolve({ t: "refused", step, refusal });
    else if (a === "unknown") resolve({ t: "unknown" });
    else if (last) resolve({ t: "taken" });
  };
  if (!sent({ t: "room.setPlayerScene", sceneId: scene.id }, settle("move", !opts.reveal))) resolve({ t: "refused", step: "move", refusal: undefined });
  else if (opts.reveal && !sent({ t: "view.blackout", blackout: false, whilePlayersOn: scene.id }, settle("lift", true))) resolve({ t: "refused", step: "lift", refusal: undefined });
  // As the Scenes list always sent it: the sound plays only while the players are on the scene, so a move that did not go leaves it silent.
  const sound = moveSoundOp(scene, { serverSound: room.serverSound, playlists: room.playlists, sounds: room.sounds, newId: () => actions.newId() });
  if (sound) actions.dispatch(sound);
  return { t: "sent", answer };
}

/** The scene a move this page sent is going to while the server has not answered, or null. */
export function movingPlayersTo(pending: readonly { op: ClientOp }[]): string | null {
  for (const p of pending) if (p.op.t === "room.setPlayerScene") return p.op.sceneId;
  return null;
}
