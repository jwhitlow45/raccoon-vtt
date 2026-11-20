import type { RoomState, Scene, Token } from "#shared/model.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { floorsOf, onPlayersScene, openFloor, unhiddenPartyMember } from "#shared/rules/floors.ts";
import { footprintSize, occupiedHexes } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { hexInScene } from "#shared/rules/hex.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { carriedGroup, onHolder } from "#shared/rules/attach.ts";
import { linkDir, linksOn, spaceOn } from "#shared/rules/floorLinks.ts";
import { planMove, type Pose } from "#shared/rules/moveLeg.ts";
import { ownEntry } from "#shared/records.ts";
import { displayName } from "../../lib/scene.ts";
import type { RoomActions } from "../../state/types.ts";
import type { Labels } from "../../lib/labels.ts";

/*
 * Move to floor (docs/design/design-v1-floors.md 7.4): the DM moves the
 * selected creatures, with what they carry and drag, to the same squares on
 * another floor of their scene. It is one `token.update` with a new
 * `sceneId` for each creature named, in one gesture and so one undo step,
 * and the reducer takes the passengers and the attached areas along.
 */

/** The whole copy: the landings are planned by the reducer's own planner, which reads the room as the server does. */
type View = RoomState;

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

/** Move to floor is the DM's, and the reducer counts every holder for a DM's op (shared/reducer/falls.ts heldUp). */
const MOVER = { role: "dm", memberId: "" } as const;

/**
 * Where each token of the move lands on the floor: the ops moveToFloorOps sends, holders first, each planned by the
 * reducer's own planner (shared/rules/moveLeg.ts planMove) on the room as it is, so a passenger lands where its
 * holder's op takes it and its own op, which names only the floor, moves it no further.
 */
function landings(view: View, named: readonly Token[], floor: Scene): Map<string, Pose> {
  const out = new Map<string, Pose>();
  for (const op of moveToFloorOps(view, named, floor)) {
    for (const moved of planMove(op as Op, view, MOVER, {})) if (!out.has(moved.tokenId)) out.set(moved.tokenId, moved.to);
  }
  return out;
}

/**
 * Whether the move would set a token down on the ground wholly over an opening on the floor
 * (docs/design/design-v1-floors.md phase 4, 4.1 and 11, D-261119-061), read at the pose it lands in (`landings`): a
 * creature that keeps its height in the air lands on the ground where the floor's ground is that high, and a dragged
 * one lands as the reducer lands it. A passenger whose holder lands there too stays on its holder. Move to floor is a
 * placement and drops no one, so such a floor is off.
 */
function landsOverOpening(view: View, named: readonly Token[], moved: readonly Token[], floor: Scene): boolean {
  const holes = linksOn(view, floor.id).filter((l) => l.kind === "opening" && linkDir(view, l) === "down");
  if (holes.length === 0) return false;
  const landed = landings(view, named, floor);
  return moved.some((t) => {
    const pose = landed.get(t.id);
    if (pose === undefined || pose.sceneId !== floor.id) return false;
    if (t.attached && onHolder(t.attached.kind) && landed.get(t.attached.to)?.sceneId === floor.id) return false;
    // It lands full size, since a change of floor drops the squeeze.
    const { squeeze: _squeeze, ...full } = t;
    const there = { ...full, ...pose };
    return there.elevation === footprintGround(view.buildChunks, there) && holes.some((l) => spaceOn(view, there, l));
  });
}

/**
 * The floors of the named creatures' scene they can move to, top first: every floor but the one all of them
 * already stand on. A floor is off where a creature's full space lies outside it ("Outside Attic"), or where one would
 * land on the ground wholly over an opening ("Over an opening on Upper floor"). A floor players have not reached
 * warns, in one line, when the whole move holds an unhidden party member (D-261102-484).
 */
export function floorChoices(view: View, named: readonly Token[], labels: Labels): FloorChoice[] {
  const first = named[0];
  if (!first) return [];
  const moved = movedTokens(view, named);
  const party = moved.filter((t) => unhiddenPartyMember(view as RoomState, t));
  const choices: FloorChoice[] = [];
  for (const floor of floorsOf(view, first.sceneId).slice().reverse()) {
    if (named.every((t) => t.sceneId === floor.id)) continue;
    const name = floor.floor?.name ?? floor.name;
    const outside = moved.some((t) => !fitsOn(floor, t));
    const overOpening = !outside && landsOverOpening(view, named, moved, floor);
    // Only the players' scene opens by a party member's arrival (markOpened), so a move on a scene the DM prepares in private opens nothing and warns of nothing.
    const warns = party.length > 0 && onPlayersScene(view, floor.id) && !openFloor(view as RoomState, floor.id);
    choices.push({
      floor,
      name,
      off: outside ? `Outside ${name}` : overOpening ? `Over an opening on ${name}` : null,
      warning: warns ? `Players haven't reached ${name}. Moving ${nameList(party.map((t) => displayName(t, labels)))} there opens it to them.` : null,
    });
  }
  return choices;
}

/** How many links up `attached.to` a token stands from one that sits on nothing, each token counted once on a loop. */
function linkDepth(tokens: RoomState["tokens"], token: Token): number {
  const seen = new Set([token.id]);
  let depth = 0;
  for (let to = token.attached?.to; to !== undefined && !seen.has(to); to = ownEntry(tokens, to)?.attached?.to) {
    seen.add(to);
    depth += 1;
  }
  return depth;
}

/**
 * The ops of the move: one `token.update` for each creature named. A creature standing on the ground lands on the
 * ground of its place on the floor, one flying keeps its height, and one already on the floor is left.
 *
 * The server takes each op alone, and each ends with the link pass, so a rider sent before its mount would stand on
 * the floor alone and come loose. Holders go first, down every chain of links: the mount takes its rider along, and
 * the rider's own op then drops the rider's nudge, as for every creature the move names (7.4). Each op is planned
 * from the room as the ops before it leave it, so a creature an earlier op took along keeps the place and height it
 * was given there, and its own op names only the floor (FLRBUILD-ASTRA-06). The reducer's plan gives that height: a
 * rider keeps its mount's, and a dragged creature on the ground lands on the ground under its own new space
 * (shared/rules/moveLeg.ts, FLRBUILD-ASTRA-08).
 */
export function moveToFloorOps(view: Pick<RoomState, "buildChunks" | "tokens">, named: readonly Token[], target: Scene): ClientOp[] {
  const ops: ClientOp[] = [];
  const depth = new Map(named.map((t) => [t.id, linkDepth(view.tokens, t)]));
  const holdersFirst = [...named].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
  // What the ops so far took to the floor: a scene change takes a holder's whole group (shared/rules/moveLeg.ts planMove).
  const along = new Set<string>();
  for (const token of holdersFirst) {
    if (token.sceneId === target.id) continue;
    if (along.has(token.id)) {
      ops.push({ t: "token.update", tokenId: token.id, patch: { sceneId: target.id } });
      continue;
    }
    for (const id of carriedGroup(view.tokens, token.id, new Set([token.id]))) along.add(id);
    // Whether it stands on the ground reads the space it stands in now, squeezed or not. It lands full size, since the
    // change of floor drops the squeeze (FLRBUILD-ASTRA-02), so its landing reads the ground under its full space.
    const { squeeze: _squeeze, ...landing } = token;
    const here = footprintGround(view.buildChunks, token);
    const there = footprintGround(view.buildChunks, { ...landing, sceneId: target.id });
    const elevation = token.elevation === here ? there : token.elevation;
    ops.push({ t: "token.update", tokenId: token.id, patch: { sceneId: target.id, ...(elevation !== token.elevation ? { elevation } : {}) } });
  }
  return ops;
}

/**
 * Sends a move to one floor of `floorChoices`: the list's tap and the search's row both run this, so they cannot
 * drift apart. The move shows the floor at once, as the DM's view follows the creatures it moved (7.3). Returns the
 * reason when the floor is off or the move has nothing to send, and sends nothing then. `onSettled` runs once every
 * op has an answer.
 */
export function sendMoveToFloor(
  actions: Pick<RoomActions, "dispatch" | "newId" | "showFloor">,
  view: Pick<RoomState, "buildChunks" | "tokens">,
  tokens: readonly Token[],
  choice: Pick<FloorChoice, "floor" | "off">,
  onSettled?: () => void,
): string | null {
  if (choice.off !== null) return choice.off;
  const ops = moveToFloorOps(view, tokens, choice.floor);
  if (ops.length === 0) return "Nothing to move";
  const group = ops.length > 1 ? actions.newId() : undefined;
  let waiting = 0;
  const settle = () => {
    if (--waiting > 0) return;
    onSettled?.();
  };
  for (const op of ops) {
    waiting += 1;
    if (actions.dispatch(op, { ...(group !== undefined ? { group } : {}), onAnswer: settle }) === null) settle();
  }
  actions.showFloor(choice.floor.id);
  return null;
}
