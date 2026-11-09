import type { RoomState, Scene, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { floorsOf, onPlayersScene, openFloor, unhiddenPartyMember } from "#shared/rules/floors.ts";
import { footprintSize, occupiedHexes } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { hexInScene } from "#shared/rules/hex.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { carriedGroup } from "#shared/rules/attach.ts";
import { displayName } from "../../lib/scene.ts";

/*
 * Move to floor (docs/design/design-v1-floors.md 7.4): the DM moves the
 * selected creatures, with what they carry and drag, to the same squares on
 * another floor of their scene. It is one `token.update` with a new
 * `sceneId` for each creature named, in one gesture and so one undo step,
 * and the reducer takes the passengers and the attached areas along.
 */

type View = Pick<RoomState, "scenes" | "tokens" | "meta" | "characters" | "openFloors" | "buildChunks">;

/** One floor the move could go to: whether it is off and why, and the line warning that it opens the floor to players. */
export type FloorChoice = { floor: Scene; name: string; off: string | null; warning: string | null };

/** The tokens the move holds: those named, and everything they carry or drag, each once, in token id order. */
export function movedTokens(view: Pick<RoomState, "tokens">, named: readonly Token[]): Token[] {
  const names = new Set(named.map((t) => t.id));
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const t of named) {
    for (const id of carriedGroup(view.tokens, t.id, names)) {
      const member = view.tokens[id];
      if (member && !seen.has(id)) {
        seen.add(id);
        out.push(member);
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether the creature's full space, unsqueezed as it lands, lies inside the
 * scene: its box on squares, and on hexes every hex it stands on, as the
 * server reads a placement (shared/permissions.ts insideScene).
 */
export function fitsOn(scene: Pick<Scene, "bounds" | "gridShape">, token: Token): boolean {
  const { squeeze: _squeeze, ...bare } = token;
  const grid = sceneGrid(scene);
  if (isHex(grid)) return occupiedHexes(grid, bare).every((h) => hexInScene(grid, scene.bounds, h));
  const fp = footprintSize(bare);
  return token.x >= 0 && token.y >= 0 && token.x + fp.w <= scene.bounds.w && token.y + fp.h <= scene.bounds.h;
}

/** "Thorn", "Thorn and Bree", "Thorn, Bree and Mira". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The floors of the named creatures' scene they can move to, top first: every floor but the one all of them
 * already stand on. A floor is off where a creature's full space lies outside it ("Outside Attic"). A floor
 * players have not reached warns, in one line, when the whole move holds an unhidden party member (D-261102-484).
 */
export function floorChoices(view: View, named: readonly Token[]): FloorChoice[] {
  const first = named[0];
  if (!first) return [];
  const moved = movedTokens(view, named);
  const party = moved.filter((t) => unhiddenPartyMember(view as RoomState, t));
  const choices: FloorChoice[] = [];
  for (const floor of floorsOf(view, first.sceneId).slice().reverse()) {
    if (named.every((t) => t.sceneId === floor.id)) continue;
    const name = floor.floor?.name ?? floor.name;
    const outside = moved.some((t) => !fitsOn(floor, t));
    // Only the players' scene opens by a party member's arrival (markOpened), so a move on a scene the DM prepares in private opens nothing and warns of nothing.
    const warns = party.length > 0 && onPlayersScene(view, floor.id) && !openFloor(view as RoomState, floor.id);
    choices.push({
      floor,
      name,
      off: outside ? `Outside ${name}` : null,
      warning: warns ? `Players haven't reached ${name}. Moving ${nameList(party.map((t) => displayName(t)))} there opens it to them.` : null,
    });
  }
  return choices;
}

/**
 * The ops of the move: one `token.update` for each creature named. A creature standing on the ground lands on the
 * ground of its place on the floor, one flying keeps its height, and one already on the floor is left.
 */
export function moveToFloorOps(view: Pick<RoomState, "buildChunks">, named: readonly Token[], target: Scene): ClientOp[] {
  const ops: ClientOp[] = [];
  for (const token of named) {
    if (token.sceneId === target.id) continue;
    const here = footprintGround(view.buildChunks, token);
    const there = footprintGround(view.buildChunks, { ...token, sceneId: target.id });
    const elevation = token.elevation === here ? there : token.elevation;
    ops.push({ t: "token.update", tokenId: token.id, patch: { sceneId: target.id, ...(elevation !== token.elevation ? { elevation } : {}) } });
  }
  return ops;
}
