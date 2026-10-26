import type { AreaShape, BuildChunk, Character, CharacterId, MemberId, RoomState, Token } from "#shared/model.ts";
import { emanationFootprint, type AreaToken } from "#shared/rules/aoe.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import type { Point } from "#shared/rules/geom.ts";
import { shownLife } from "#shared/rules/hp.ts";
import { displayName } from "../../lib/scene.ts";
import { characterToken } from "../rolls/logic.ts";
import { ownsCharacter, ownsToken } from "../tokens/access.ts";
import {
  draftTemplate,
  freePointHeight,
  freePointOf,
  isDirectional,
  pointHeight,
  snapCubeCenter,
  snapYaw,
  usesFrom,
  yawToward,
  type AreaDraft,
  type AreaTokens,
  type SnapMode,
} from "./placement.ts";
import { placedAtPoint } from "./presets.ts";
import type { Grid } from "#shared/rules/grid.ts";

/**
 * Which token a new area starts from, and what a tap picks, for the area
 * tool (features section 9, docs/design-v1-area-from-character.md). Pure,
 * so it runs under plain Node tests.
 *
 * Two values stay apart. The saved choice says who a player's next area
 * starts from, and lives in the page's scope across areas, tools and
 * scenes. The area's caster is the draft's own. The From control shows
 * the first while idle and the second while an area is being placed.
 */

type Tokens = Readonly<Record<string, Token | undefined>>;
type You = { memberId: MemberId; role: "dm" | "player" };

/** One creature the From control offers (3.1). */
export type AreaCreature = {
  tokenId: string;
  characterId?: CharacterId;
  /** The name this viewer sees, numbered where two offers would read the same ("Thorn 2"). */
  name: string;
  kind: "character" | "companion" | "other";
  /** One of the viewer's own creatures, rather than the area's own caster (3.1 item 2). */
  yours: boolean;
  /** Its life is Alive, so it may be the default. */
  living: boolean;
};

function creatureOf(view: Pick<RoomState, "characters">, t: Token, yours: boolean): AreaCreature {
  const characterId = "ref" in t.actor ? t.actor.ref : undefined;
  const actor = characterId !== undefined ? view.characters[characterId]?.actor : "inline" in t.actor ? t.actor.inline : undefined;
  const kind = t.companion !== undefined ? "companion" : characterId !== undefined ? "character" : "other";
  const c: AreaCreature = { tokenId: t.id, name: displayName(t), kind, yours, living: (shownLife(actor, t) ?? "alive") === "alive" };
  if (characterId !== undefined) c.characterId = characterId;
  return c;
}

/** Later offers that would read the same as an earlier one read "Thorn 2", "Thorn 3", in the list's order. */
function numbered(list: readonly AreaCreature[]): AreaCreature[] {
  const seen = new Map<string, number>();
  return list.map((c) => {
    const base = c.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? c : { ...c, name: `${base} ${n}` };
  });
}

/**
 * A player's creatures on this scene (3.1 item 1): tokens they own,
 * directly or through their character, companions included and objects
 * left out, characters first, then the rest, each by name and then id. A
 * creature the DM hid counts, since it still reaches its owner, and so
 * does a dying or dead one, which is never the default. The DM has none:
 * the DM runs every token, so owning one says nothing about who casts.
 */
export function areaCreatures(input: { view: Pick<RoomState, "tokens" | "characters">; sceneId: string; you: You }): AreaCreature[] {
  if (input.you.role === "dm") return [];
  const mine = Object.values(input.view.tokens).filter(
    (t): t is Token => t !== undefined && t.sceneId === input.sceneId && t.kind !== "object" && ownsToken(input.view, input.you.memberId, t),
  );
  const list = mine.map((t) => creatureOf(input.view, t, true));
  const rank = (c: AreaCreature) => (c.kind === "character" ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.tokenId.localeCompare(b.tokenId));
  return numbered(list);
}

/** What a player's saved choice holds: a creature, its character where it has one so it is found on another scene, "none", or nothing yet. */
export type SavedChoice = { tokenId: string; characterId?: CharacterId } | "none" | null;

export function choiceOf(c: Pick<AreaCreature, "tokenId" | "characterId">): SavedChoice {
  return c.characterId !== undefined ? { tokenId: c.tokenId, characterId: c.characterId } : { tokenId: c.tokenId };
}

/**
 * The creature a player's next area starts from (3.3), by the first that
 * holds:
 *
 * 1. A fresh selection of one of theirs as the tool opens, made after the
 *    choice last changed, which becomes the choice. An old one never
 *    undoes a choice, so "off" holds across tools with Thorn still
 *    selected.
 * 2. The choice, if it names one of their creatures here: by token, else
 *    by the first token of the same character on this scene, which is how
 *    it follows the party to another scene. "None" holds as none.
 * 3. Their only living character here, else their only living creature
 *    here, else none. A companion never wins over a living character, and
 *    two characters wait for a pick.
 *
 * The DM has no choice: the DM's areas start with no caster, since a
 * selection is often old and for something else, and a Fireball cast from
 * a goblin picked for its HP is worse than a tap on the caster.
 */
export function savedChoice(input: {
  creatures: readonly AreaCreature[];
  tokens: Tokens;
  sceneId: string;
  choice: SavedChoice;
  selected: { id: string | null; fresh: boolean };
  role: "dm" | "player";
}): { casterId: string | null; choice: SavedChoice } {
  const { creatures, choice } = input;
  if (input.role === "dm") return { casterId: null, choice };
  const here = (id: string | undefined) => (id === undefined ? undefined : creatures.find((c) => c.yours && c.tokenId === id));
  const picked = input.selected.fresh && input.selected.id !== null ? here(input.selected.id) : undefined;
  if (picked) return { casterId: picked.tokenId, choice: choiceOf(picked) };
  if (choice === "none") return { casterId: null, choice };
  if (choice !== null) {
    const found = here(choice.tokenId) ?? (choice.characterId !== undefined ? here(characterToken(input.tokens, choice.characterId, input.sceneId)?.id) : undefined);
    if (found) return { casterId: found.tokenId, choice };
  }
  const living = creatures.filter((c) => c.yours && c.living);
  const characters = living.filter((c) => c.kind === "character");
  const only = characters.length === 1 ? characters[0] : characters.length === 0 && living.length === 1 ? living[0] : undefined;
  return { casterId: only?.tokenId ?? null, choice };
}

/**
 * The draft's caster: its `casterId`, else the token a cone, line, cube or
 * emanation starts from. Ice Knife's target is never its caster.
 */
export function draftCaster(d: Pick<AreaDraft, "casterId" | "fromId" | "targetsOther">): string | null {
  return d.casterId ?? (d.targetsOther ? undefined : d.fromId) ?? null;
}

/** Whom the From control shows on (3.3): the saved choice while idle, the area's own caster while placing, or no one. */
export function fromShows(input: { draft: AreaDraft | null; saved: string | null }): string | null {
  return input.draft ? draftCaster(input.draft) : input.saved;
}

/**
 * What the From control is (3.1, 3.2): a toggle for one offer, a chip for
 * two or more, disabled with its words for a player with none here, or
 * nothing for the DM with no area cast from a token. The offers are the
 * player's creatures, then the area's own caster while placing when it is
 * not one of theirs and stands on this scene: the token it is cast from
 * now, or was last cast from, so a dropped caster can be turned on again.
 */
export type FromControl =
  | { form: "none" }
  /** `name` is their first character's, wherever it stands, or null for a player with none: "From you". */
  | { form: "disabled"; name: string | null; characterId?: CharacterId }
  | { form: "toggle"; offer: AreaCreature; on: boolean }
  | { form: "chip"; offers: AreaCreature[]; on: string | null };

export function fromOffers(input: {
  creatures: readonly AreaCreature[];
  draft: AreaDraft | null;
  saved: string | null;
  view: Pick<RoomState, "tokens" | "characters">;
  sceneId: string;
  you: You;
}): FromControl {
  const { creatures, draft, view } = input;
  let offers: AreaCreature[] = [...creatures];
  const own = draft ? (draftCaster(draft) ?? draft.lastCaster) : undefined;
  const ownToken = own !== undefined ? view.tokens[own] : undefined;
  if (ownToken && ownToken.sceneId === input.sceneId && !creatures.some((c) => c.tokenId === ownToken.id)) {
    offers = numbered([...creatures, creatureOf(view, ownToken, false)].map(unnumbered(view)));
  }
  const shown = fromShows({ draft, saved: input.saved });
  const first = offers[0];
  if (!first) {
    if (input.you.role === "dm") return { form: "none" };
    // Their first character by name, wherever it stands, so the control keeps its words while it is away.
    const character = Object.values(view.characters)
      .filter((c): c is Character => c !== undefined && ownsCharacter(input.you.memberId, c))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
    return character ? { form: "disabled", name: character.name, characterId: character.id } : { form: "disabled", name: null };
  }
  if (offers.length === 1) return { form: "toggle", offer: first, on: shown === first.tokenId };
  return { form: "chip", offers, on: offers.some((o) => o.tokenId === shown) ? shown : null };
}

/** An offer under the name its token gives, before numbering, so a list joined by the area's caster numbers once. */
function unnumbered(view: Pick<RoomState, "tokens">) {
  return (c: AreaCreature): AreaCreature => {
    const t = view.tokens[c.tokenId];
    return t ? { ...c, name: displayName(t) } : c;
  };
}

/**
 * The From control on, with a creature, or off (3.4). While idle the
 * caller sets the saved choice instead.
 *
 * On: Ice Knife keeps its target and takes the creature as its caster. A
 * sphere, a cylinder and a cube spell placed at a point stay where they
 * are, with the creature recorded, so the line reads the distance from it.
 * A cone, line, cube or emanation starts from the creature: at its edge,
 * keeping the aim, or around it.
 *
 * Off: the caster goes and the area keeps where it stands, as a free area,
 * Ice Knife keeping its target. An emanation keeps the square it
 * surrounded. The creature stays as `lastCaster`, to turn it on again.
 */
export function castFrom(g: Grid, d: AreaDraft, casterId: string | null, tokens: AreaTokens, feetPerCell: number): AreaDraft {
  if (casterId === null) {
    if (d.targetsOther) {
      // Ice Knife stands on its target, which keeps it in place: only the caster goes.
      const next: AreaDraft = { ...d };
      delete next.casterId;
      return next;
    }
    const t = draftTemplate(g, d, tokens, feetPerCell);
    const next: AreaDraft = { ...d, point: d.point ?? (t ? freePointOf(t, feetPerCell) : null) };
    delete next.casterId;
    delete next.fromId;
    const around = d.shape === "emanation" && d.fromId !== undefined ? tokens[d.fromId] : undefined;
    if (around) next.footprint = emanationFootprint(g, around, feetPerCell);
    return next;
  }
  const next: AreaDraft = { ...d, casterId, lastCaster: casterId };
  if (d.targetsOther || !usesFrom(d.shape) || placedAtPoint(d)) return next;
  return { ...next, fromId: casterId, point: null };
}

/**
 * The draft without any reference to a creature that left the scene or was
 * deleted (3.3). Only what pointed at it goes: as the caster the area
 * loses its caster, and its origin where it started from that creature,
 * and waits for a tap, as Ice Knife's target it waits for a new target,
 * and as `lastCaster` only the offer to turn it back on goes. Nothing
 * stands in for it.
 */
export function withoutCreature(d: AreaDraft, tokenId: string): AreaDraft {
  if (d.casterId !== tokenId && d.fromId !== tokenId && d.lastCaster !== tokenId) return d;
  const next: AreaDraft = { ...d };
  if (next.casterId === tokenId) delete next.casterId;
  if (next.fromId === tokenId) delete next.fromId;
  if (next.lastCaster === tokenId) delete next.lastCaster;
  return next;
}

/** The draft without every creature it names that `present` no longer finds on the scene. */
export function withoutDeparted(d: AreaDraft, present: (tokenId: string) => boolean): AreaDraft {
  let next = d;
  for (const id of [d.casterId, d.fromId, d.lastCaster]) if (id !== undefined && !present(id)) next = withoutCreature(next, id);
  return next;
}

/**
 * What a tap on a token does while an area is being placed (3.5):
 *
 * - "cast": the area starts from the token, as its caster.
 * - "target": Ice Knife surrounds the token.
 * - "aim": a cone, line or cube turns toward the token's center, from its
 *   caster or its free origin, and a drag from the press keeps aiming.
 * - "grab": a press on the caster itself grabs the aim.
 * - "center": a cube placed at a point centers on the token.
 * - "place": a sphere, cylinder or free emanation goes on the token.
 * - "stay": an emanation around its caster stays there.
 *
 * `yours` says the area's caster is one of the viewer's creatures. Then a
 * tap on another creature aims rather than casts, since the player chose
 * to cast from their own. Otherwise, for the DM and for a player's area
 * cast from someone else's token or from no one, a tap casts from the
 * token as it always has.
 */
export type TokenTap = "cast" | "target" | "aim" | "grab" | "center" | "place" | "stay";

/** What a press on the map starts once it lands: aiming around a pivot, moving the point, moving a cube's center, or nothing. */
export type TapGesture = { kind: "none" } | { kind: "aim"; pivot: Point } | { kind: "point" } | { kind: "center" };

export function tokenTap(d: Pick<AreaDraft, "shape" | "fromId" | "casterId" | "targetsOther" | "point">, tokenId: string, yours: boolean): TokenTap {
  if (d.shape === "sphere" || d.shape === "cylinder") return "place";
  if (!yours) {
    if (tokenId !== d.fromId) return d.targetsOther ? "target" : "cast";
    return d.shape === "emanation" ? "stay" : "grab";
  }
  if (d.shape === "emanation") {
    if (d.targetsOther) return tokenId !== d.fromId ? "target" : "stay";
    return d.fromId !== undefined ? "stay" : "place";
  }
  if (d.fromId !== undefined) return tokenId === d.fromId ? "grab" : "aim";
  if (d.shape === "cube") return "center";
  return d.point ? "aim" : "cast";
}

/**
 * The idle line's words while the next area starts from a creature (3.5):
 * what a tap does with the last shape used. A cone, line or cube turns
 * toward the tap, a sphere or cylinder goes where it lands, and an
 * emanation starts around its caster wherever the tap is.
 */
export function idleHint(shape: AreaShape, name: string): string {
  const tap =
    shape === "emanation" ? `Tap the map to start it around ${name}.` : shape === "sphere" || shape === "cylinder" ? "Tap the map or a creature to place it." : "Tap the map or a creature to aim it.";
  return `Casting from ${name}. ${tap} Tap an area on the map to pick it.`;
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

function centerOf(g: Grid, t: AreaToken): Point {
  const r = footprintRect(g, t);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * A tap on a token while an area is being placed, by tokenTap's rule: the
 * draft it leaves and the gesture its press starts. Aiming at a token aims
 * at its center, snapped as the Rotation snap says. A cube placed at a
 * point centers on the token by the free cube's snapping rule and height,
 * and a drag from that press moves it, as the free cube's center grab does.
 */
export function tappedToken(input: {
  draft: AreaDraft;
  token: AreaToken;
  yours: boolean;
  tokens: AreaTokens;
  snap: SnapMode;
  chunks: Readonly<Record<string, BuildChunk>>;
  sceneId: string;
  /** The scene's grid: on hexes a token's center is its anchor, and the snaps are the hex lattice's. */
  grid: Grid;
  feetPerCell: number;
}): { draft: AreaDraft; gesture: TapGesture } {
  const { draft: d, token, grid } = input;
  const at = centerOf(grid, token);
  const from = d.fromId !== undefined ? input.tokens[d.fromId] : undefined;
  switch (tokenTap(d, token.id, input.yours)) {
    case "cast":
      return { draft: { ...d, fromId: token.id, casterId: token.id, lastCaster: token.id, point: null }, gesture: isDirectional(d.shape) ? { kind: "aim", pivot: at } : { kind: "none" } };
    case "target":
      return { draft: { ...d, fromId: token.id, point: null }, gesture: { kind: "none" } };
    case "aim": {
      const pivot = from ? centerOf(grid, from) : d.point ? { x: d.point.x, y: d.point.y } : at;
      const yaw = yawToward(pivot, at);
      return { draft: yaw === null ? d : { ...d, yaw: snapYaw(grid, yaw, input.snap) }, gesture: { kind: "aim", pivot } };
    }
    case "grab":
      return { draft: d, gesture: { kind: "aim", pivot: from ? centerOf(grid, from) : at } };
    case "center": {
      const c = snapCubeCenter(grid, at, d.size, input.feetPerCell);
      return { draft: { ...d, point: { ...c, z: freePointHeight(input.chunks, input.sceneId, c, d.point) } }, gesture: { kind: "center" } };
    }
    case "place":
      return { draft: { ...d, point: { ...at, z: pointHeight(token) } }, gesture: { kind: "point" } };
    case "stay":
      return { draft: d, gesture: { kind: "none" } };
  }
}

/** The room's selection as the area tool last saw it, and how many times it has changed (3.3 step 1). */
export type SelectionSeen = { ids: readonly string[]; count: number };

/**
 * Counts a change of the room's selection. Every change counts, so letting
 * go of Thorn and selecting him again is a fresh selection, while a bar
 * opened or closed on the same selection is not.
 */
export function seeSelection(seen: SelectionSeen, ids: readonly string[]): SelectionSeen {
  const same = seen.ids.length === ids.length && seen.ids.every((id, i) => id === ids[i]);
  return same ? seen : { ids, count: seen.count + 1 };
}
