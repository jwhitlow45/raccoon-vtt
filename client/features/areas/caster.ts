import type { RoomState, Token } from "#shared/model.ts";

/**
 * Which token a new area starts from, and what a tap picks, for the area
 * tool (features section 9). Pure, so it runs under plain Node tests.
 */

/**
 * The caster a new area starts from when the tool opens: a player's own
 * selected creature, and nothing for the DM. A selection is whatever was
 * tapped last, often long ago and for something else, so the DM taps the
 * caster each time rather than casting a Fireball from a goblin picked for
 * its HP. A player's own creature is almost always the caster, and the
 * options bar names it with a way to drop it.
 */
export function defaultCaster(input: {
  selected: Token | undefined;
  sceneId: string;
  you: { memberId: string; role: "dm" | "player" };
  characters: RoomState["characters"];
}): string | null {
  const { selected, you } = input;
  if (you.role === "dm" || !selected || selected.sceneId !== input.sceneId) return null;
  if ((selected.ownerIds ?? []).includes(you.memberId)) return selected.id;
  const character = "ref" in selected.actor ? input.characters[selected.actor.ref] : undefined;
  return (character?.ownerIds ?? []).includes(you.memberId) ? selected.id : null;
}

/**
 * What a tap picks with nothing in progress. A token wins over the placed
 * areas it stands in, so casting from a creature inside an aura or a
 * Fireball still works. An area under a token is picked by tapping its
 * open ground, or from the Areas panel.
 */
export function idleTapPicks(under: { token: boolean; template: boolean }): "token" | "template" | "map" {
  if (under.token) return "token";
  return under.template ? "template" : "map";
}

/**
 * What a press does to the placed area picked for editing.
 *
 * A cone, line or cube cast from a creature turns around that creature from
 * a press on the creature or inside the area, since moving it would leave
 * its caster behind. That is where a finger goes to swing a Burning Hands
 * around its caster on a phone, where the handle past the far end is small
 * and often under the options sheet. A free one moves from inside instead.
 *
 * A press anywhere else turns a cone, line or cube too, as aiming a new one
 * does, unless it lands on another area, which a tap then picks. A tap
 * that does not move lets the area go (`letGo`), as it always has.
 */
export function pickedPress(at: {
  directional: boolean;
  onCaster: boolean;
  handle: boolean;
  casterToken: boolean;
  inside: boolean;
  nearOrigin: boolean;
  attached: boolean;
  otherArea: boolean;
}): "turn" | "move" | "turnOrLetGo" | null {
  if (at.directional && at.handle) return "turn";
  if (at.directional && at.onCaster && (at.casterToken || at.inside || at.nearOrigin)) return "turn";
  if (!at.attached && (at.inside || at.nearOrigin)) return "move";
  if (at.directional && !at.otherArea) return "turnOrLetGo";
  return null;
}
