import type { RoomState } from "#shared/model.ts";
import { withheldWhereItStands } from "#shared/project.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { OpAnswer } from "../state/types.ts";
import { displayName, type ViewToken } from "../lib/scene.ts";

/**
 * What the map says when a drag does not do what the finger expected
 * (features section 5). Kept free of Konva and the DOM so it runs under
 * plain Node tests.
 */

/**
 * Why a press on a token cannot drag it, for a toast, or null when it can.
 * The same rules as dragRights.ts `canDragToken`, which the server enforces
 * for real (shared/permissions.ts).
 */
export function refusedDragText(input: {
  name: string;
  role: "dm" | "player";
  owns: boolean;
  locked: boolean;
  /** The room lets this player move tokens they do not own (RoomSettings.playersMoveAny), and players can see this one. */
  moveAny: boolean;
}): string | null {
  const mayMove = input.role === "dm" || input.owns || input.moveAny;
  if (!mayMove) return "You can only move your own tokens.";
  if (!input.locked) return null;
  return input.role === "dm" ? `${input.name} is locked. Turn off Locked in its action bar to move it.` : `${input.name} is locked in place.`;
}

/** A token a drop moved, where it lands, and whether this viewer owns it. */
export type DroppedToken = { token: ViewToken; owns: boolean; x: number; y: number; squeeze?: boolean };

/** The dropped creatures a player can lose from view: not theirs, and not shown to them above the fog. */
function losable(role: "dm" | "player", moves: readonly DroppedToken[]): DroppedToken[] {
  return role === "dm" ? [] : moves.filter((m) => !m.owns && m.token.aboveFog !== true);
}

/** Whether a token's scene has party vision on. */
function onVisionScene(view: RoomState, token: ViewToken): boolean {
  return view.scenes[token.sceneId]?.vision?.on === true;
}

/**
 * The tokens a player just dropped fully under the fog of a scene without
 * party vision, where their own view will lose them: not theirs and not
 * exempt, and withheld where they land by the rule the server projects with
 * (design 13.4), the fog players get. A move changes neither fog layer on
 * such a scene, since only party vision explores, so the view the player
 * holds at the drop answers exactly. A vision scene is watchDrop's.
 * The DM sees through the fog, so nothing vanishes for a DM.
 */
export function droppedIntoFog(input: { role: "dm" | "player"; view: RoomState; moves: readonly DroppedToken[] }): ViewToken[] {
  return losable(input.role, input.moves)
    .filter((m) => {
      if (onVisionScene(input.view, m.token)) return false;
      const { squeeze: _squeeze, ...rest } = m.token;
      return withheldWhereItStands(input.view, m.squeeze ? { ...rest, x: m.x, y: m.y, squeeze: true } : { ...rest, x: m.x, y: m.y });
    })
    .map((m) => m.token);
}

/** The part of the room store a drop's note reads. */
export type SettleStore = {
  getState(): { view: RoomState | null };
  subscribe(listener: () => void): () => void;
};

/** What a drop on a vision scene tells its watch (watchDrop). */
export type DropWatch = {
  /** Each op the drop sends reports here, as its dispatch's `onAnswer` (OpAnswer). */
  answer(op: ClientOp, answer: OpAnswer): void;
  /** How many ops the drop sent, once it sent them. */
  sent(count: number): void;
};

/** The tokens a move op moves. */
function movedBy(op: ClientOp): string[] {
  if (op.t === "token.move") return [op.tokenId];
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  return [];
}

/**
 * On a vision scene, the note for creatures a player dropped out of the
 * party's sight. What the party sees after the drop is the server's to
 * work out (design 13.6): a creature carrying a light takes its glow along,
 * and a group move can move a party member who lends sight, so the sight
 * the player holds at the drop can say either way wrongly. So the note
 * waits for every op the drop sent to be answered (OpAnswer), when the view
 * holds the server's projection after them, and names a dropped creature
 * only when every op that moved it was taken and that projection no longer
 * holds it.
 *
 * A creature can leave the view for other reasons meanwhile, which say
 * nothing about where it landed: the DM hid it before its move was
 * processed (the move is then refused, and the creature gone for that
 * reason), or the players were moved to another scene, or a blackout began,
 * each of which empties the view of the drop's scene. A refused or unknown
 * answer names nothing, and the watch ends unsaid once the player scene
 * leaves the drop's scene or a blackout begins.
 *
 * Null when the drop has nothing to watch: a DM, a scene without party
 * vision, or only the player's own and always-shown creatures.
 */
export function watchDrop(input: { role: "dm" | "player"; store: SettleStore; moves: readonly DroppedToken[]; notify(text: string): void }): DropWatch | null {
  const view = input.store.getState().view;
  const watched = view ? losable(input.role, input.moves).filter((m) => onVisionScene(view, m.token)) : [];
  const sceneId = watched[0]?.token.sceneId;
  if (!view || sceneId === undefined) return null;
  const stillOn = (now: RoomState | null) => now !== null && now.meta.playerSceneId === sceneId && now.meta.view?.blackout !== true;
  const taken = new Map<string, boolean>();
  let answered = 0;
  let expected: number | null = null;
  let done = false;
  const stop = input.store.subscribe(() => {
    if (!done && !stillOn(input.store.getState().view)) finish(false);
  });
  function finish(say: boolean): void {
    if (done) return;
    done = true;
    stop();
    if (!say) return;
    const now = input.store.getState().view;
    if (now === null || !stillOn(now)) return;
    const gone = watched.filter((m) => taken.get(m.token.id) === true && now.tokens[m.token.id] === undefined).map((m) => displayName(m.token));
    const text = intoFogText(gone, true);
    if (text) input.notify(text);
  }
  const settle = () => {
    if (expected !== null && answered >= expected) finish(true);
  };
  return {
    answer(op, answer) {
      answered++;
      for (const id of movedBy(op)) taken.set(id, (taken.get(id) ?? true) && answer === "taken");
      settle();
    },
    sent(count) {
      expected = count;
      if (count === 0) finish(false);
      else settle();
    },
  };
}

/**
 * The note for tokens that went where the player cannot see them on a
 * drop: into the fog, or on a vision scene out of the party's sight.
 */
export function intoFogText(names: readonly string[], vision = false): string | null {
  if (names.length === 0) return null;
  if (vision) return names.length === 1 ? `${names[0]} is out of the party's sight now.` : `${names.length} creatures are out of the party's sight now.`;
  if (names.length === 1) return `${names[0]} is in the fog now, so you can no longer see it.`;
  return `${names.length} creatures are in the fog now, so you can no longer see them.`;
}
