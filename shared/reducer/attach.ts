import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { InitEntry, PathStop, Token, TokenPath } from "../model.ts";
import { gridOfToken, inSightOfNonOwners } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { attaches } from "../migrate.ts";
import { getOffFits, isCreature, kindRefusal, landsAt, linkHolds, linkLimitRefusal, onHolder, withinReach, type LinkNames } from "../rules/attach.ts";
import { footprintSize } from "../rules/footprint.ts";
import { sceneGrid } from "../rules/grid.ts";
import { sameSpot, turnUnderWay, withStop } from "../rules/path.ts";
import { renumber, sortEntries } from "../rules/initiative.ts";
import { rowLeadsMounts, sharedMounts, tokenRow, writeEncounter } from "./encounter.ts";
import { carriedAlong, dismounted, hiddenTurnOf, judgedIn, mountCost, placeCarried, sharesTurn, sortedById, startStop, withPath } from "./tokens.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * Attaching and detaching tokens (docs/design-v1-attach.md 5 and 8.2), and
 * the link pass that ends every op's dispatch. A link lives on the carried
 * token, so attaching and detaching write that token alone, and its holder's
 * data never says what it carries.
 */

/** A token's name as the actor knows it: a hidden name reaches a player as the name players see. */
function nameFor(tx: Tx, token: Token): string {
  if (tx.actor.role === "dm" || !token.nameHidden) return token.name;
  return token.publicName ?? "Unknown creature";
}

function namesOf(tx: Tx, carried: Token, holder: Token): LinkNames {
  return { carried: nameFor(tx, carried), holder: nameFor(tx, holder) };
}

export const ONLY_A_RIDE_STEERS = "only a ride is controlled";
export const DRAG_STAYS = "a dragged creature stays where it stands";
export const PUT_DOWN_IN_PLACE = "Put down and Let go leave it where it stands";
export const GET_OFF_NEEDS_A_PLACE = "getting off a mount needs a place beside it";

/**
 * Attaches a token (8.2): the kind is checked against the two as they
 * stand and stored, never worked out again. What sits on its holder steps
 * onto its seat, a walk carrying what it carries in turn, and a drag leaves
 * the creature where it stands. The limits and loops are judged on the
 * whole graph for the DM and on what every player sees and the two named
 * tokens for a player (8.0), so a player's refusal never reads a hidden
 * link. An attach of a token already attached replaces its link.
 */
export function tokenAttach(tx: Tx, op: OpOf<"token.attach">): void {
  const carried = tx.token(op.tokenId);
  const holder = tx.token(op.to);
  const names = namesOf(tx, carried, holder);
  const settings = tx.state.meta.settings;
  if (carried.id === holder.id) throw invalid(`${names.carried} would carry itself`);
  if (carried.sceneId !== holder.sceneId) throw invalid(`${names.carried} and ${names.holder} are on different scenes`);
  if (op.steer && op.kind !== "ride") throw invalid(ONLY_A_RIDE_STEERS);
  const why = kindRefusal(op.kind, carried, holder, names);
  const grid = gridOfToken(tx.state, carried);
  if (why) throw invalid(why);
  // A seat is at its holder's elevation (4.1), whatever the op says, so no attach lifts a token another way.
  const elevation = onHolder(op.kind) ? holder.elevation : op.elevation;
  if (onHolder(op.kind)) {
    if (!linkHolds(grid, settings, op.kind, { ...carried, x: op.x, y: op.y, elevation }, holder)) throw invalid(`${names.carried} does not sit on ${names.holder} there`);
  } else {
    if (op.x !== carried.x || op.y !== carried.y || op.elevation !== carried.elevation) throw invalid(DRAG_STAYS);
    if (!withinReach(grid, settings, carried, holder)) throw invalid(`${names.carried} is too far to drag`);
  }
  const named = new Set([carried.id, holder.id]);
  const inGraph = tx.actor.role === "dm" ? () => true : (t: { id: string }) => named.has(t.id) || seenByAll(tx, t.id);
  const limit = linkLimitRefusal(tx.state.tokens, carried.id, holder.id, inGraph, names);
  if (limit) throw invalid(limit);

  const link: Token["attached"] = { to: holder.id, kind: op.kind, ...(op.steer ? { steer: true as const } : {}) };
  if (!onHolder(op.kind)) {
    tx.write(keys.token(carried.id), { ...carried, attached: link });
    return;
  }
  const along = carriedAlong(tx, op);
  const next: Token = { ...carried, x: op.x, y: op.y, elevation, attached: link };
  delete next.squeeze;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  const cost = op.kind === "ride" ? mountingCost(tx, carried, holder.id) : null;
  const seated = withPath(tx, carried, next, judged, false, undefined, undefined, cost ?? undefined);
  tx.write(keys.token(carried.id), cost !== null && sameSpot(carried, next) ? mountedInPlace(tx, seated, cost) : seated);
  placeCarried(tx, along, judged);
  if (op.steer && attaches(tx.env.opVersion)) controlledRide(tx, carried.id, holder.id);
}

/** A token's initiative row: its own, or for a character's token the character's row without a token. */
function rowOf(tx: Tx, tokenId: string): InitEntry | undefined {
  return tokenRow(tx.state.encounter?.entries ?? [], tx.state, tokenId);
}

/**
 * A controlled ride taken during a fight (7.1). "The Initiative of a
 * controlled mount changes to match yours when you mount it": for a ride
 * every player sees, the mount's row takes its rider's value and goes
 * right after its rider's, unless it is the acting row, which no row moves
 * around. One that had its turn this round already is passed over for the
 * rest of it (`skipRound`). Taken on the chain of controlled rides the
 * acting creature directs, each pair seen by every player (sharedMounts),
 * the mount and any mount above it join the turn's `mounts` and their rows
 * mark time this round (`markRound`), as they would at the turn's start.
 *
 * Every player sees the mount's row, its value, place, `skipRound` and
 * `markRound`, so from op version 18 two rows decide (rowLeadsMounts,
 * reviews FU21A-OP-1 and FU21A-OP-6). The rider's own row gives the value
 * and the place, and `skipRound` reads where the acting row stands, so the
 * rows move only while every player sees both. The acting row, the turn
 * creature's, decides the sharing. On a chain the two differ: a controlled
 * horse Bree rides, getting on an elephant, gives the elephant the horse's
 * value and joins Bree's turn. A ride, or a row, some player cannot see
 * leaves the rows as they stand.
 */
function controlledRide(tx: Tx, riderId: string, mountId: string): void {
  const encounter = tx.state.encounter;
  if (!encounter) return;
  let entries = encounter.entries;
  const riderRow = rowOf(tx, riderId);
  const mountRow = rowOf(tx, mountId);
  const actingRow = encounter.entries.find((e) => e.id === encounter.activeEntryId);
  const turnShown = encounter.activeEntryId === null || rowLeadsMounts(tx, encounter, actingRow);
  // The rows move only for a ride every player sees, both tokens and so the link, since the tracker shows the move to all (section 10).
  const shown = seenByAll(tx, riderId) && seenByAll(tx, mountId) && rowLeadsMounts(tx, encounter, riderRow) && turnShown;
  if (shown && riderRow && mountRow && riderRow.id !== mountRow.id && mountRow.id !== encounter.activeEntryId) {
    const sorted = sortEntries(entries);
    const acting = sorted.findIndex((e) => e.id === encounter.activeEntryId);
    const hadTurn = acting >= 0 && sorted.findIndex((e) => e.id === mountRow.id) < acting;
    const moved: InitEntry = { ...mountRow, value: riderRow.value, ...(hadTurn ? { skipRound: encounter.round } : {}) };
    const rest = sorted.filter((e) => e.id !== mountRow.id);
    rest.splice(rest.findIndex((e) => e.id === riderRow.id) + 1, 0, moved);
    entries = renumber(rest);
  }
  let turnStart = encounter.turnStart;
  const turn = turnUnderWay(encounter);
  // The new ride joins the turn when it is on the chain the turn's creature directs, with every mount above it there.
  const chain = turn && turnShown ? sharedMounts(tx, turn.tokenId) : [];
  if (turn && chain.includes(mountId)) {
    const mounts = [...(turn.mounts ?? [])];
    const marked = new Set([mountId]);
    for (const id of chain) {
      if (mounts.includes(id) || mounts.length >= LIMITS.turnMounts) continue;
      mounts.push(id);
      marked.add(id);
    }
    if (mounts.length !== (turn.mounts ?? []).length) turnStart = { ...turn, mounts };
    const rows = new Set([...marked].flatMap((id) => rowOf(tx, id)?.id ?? []));
    entries = entries.map((e) => (rows.has(e.id) ? { ...e, markRound: encounter.round } : e));
  }
  if (entries !== encounter.entries || turnStart !== encounter.turnStart) writeEncounter(tx, { ...encounter, entries, ...(turnStart ? { turnStart } : {}) });
}

/**
 * The turn's `mounts` after an op (7.1): a mount leaves the list in the op
 * that ends its ride, whatever ends it (getting off, Let go, the link pass,
 * a deletion, an undo), since sharing is bound to one turn and one ride.
 * It changes no row: a row that marks time this round goes on marking it.
 */
export function settleMounts(tx: Tx): void {
  const encounter = tx.state.encounter;
  const start = encounter?.turnStart;
  if (!encounter || !start?.mounts) return;
  const turn = turnUnderWay(encounter);
  const kept = turn ? start.mounts.filter((id) => sharesTurn(tx.state, id, turn)) : [];
  if (kept.length === start.mounts.length) return;
  const { mounts: _left, ...rest } = start;
  writeEncounter(tx, { ...encounter, turnStart: kept.length > 0 ? { ...rest, mounts: kept } : rest });
}

/**
 * What getting on a ride costs (7.3): half the rider's Speed on its own
 * turn, whatever the leg. "Doesn't count" can take it back as any leg. A
 * rider already on that mount pays nothing: it only changes Controlled or
 * Independent, or its seat, and mounts nothing.
 */
function mountingCost(tx: Tx, rider: Token, mountId: string): number | null {
  if (rider.attached?.kind === "ride" && rider.attached.to === mountId) return null;
  return mountCost(tx, rider, tx.token(mountId));
}

/**
 * A rider already in its seat still pays to mount, since mounting costs the
 * movement and not the walk: its path this turn, or one from the turn's
 * start, gains a stop where it sits, through the path's own bound (withStop),
 * so a full path joins its oldest legs as for any other stop.
 */
function mountedInPlace(tx: Tx, seated: Token, cost: number): Token {
  const turn = turnUnderWay(tx.state.encounter) ?? hiddenTurnOf(tx.state.encounter, seated);
  if (!turn) return seated;
  const start = startStop(turn);
  const path: TokenPath = seated.path?.turn === turn.seq ? seated.path : { turn: turn.seq, stops: turn.sceneId === seated.sceneId ? [start] : [] };
  const last = path.stops[path.stops.length - 1];
  if (!last || !sameSpot(last, seated)) return seated;
  // The stop where it sits, seen by whoever saw it get there (docs/design-v1-per-player-vision.md 6.5).
  const stop: PathStop = { x: seated.x, y: seated.y, elevation: seated.elevation, ...(last.seen ? { seen: true as const } : {}), ...(last.seenBy ? { seenBy: last.seenBy } : {}), moved: 0, cost };
  return { ...seated, path: withStop(path, stop, footprintSize(seated), { token: seated, rules: tx.state.meta.settings, grid: gridOfToken(tx.state, seated) }) };
}

/**
 * Detaches a token (8.2): Get off, Put down or Let go. Only a creature
 * getting off a ride, a perch or a carry takes a place, which lies inside
 * the scene, within reach of its holder and clear of it, a walk carrying
 * what it carries. Whether the place is free of creatures is the device's
 * to judge, since the server's answer would tell where a hidden one stands.
 */
export function tokenDetach(tx: Tx, op: OpOf<"token.detach">): void {
  const carried = tx.token(op.tokenId);
  const link = carried.attached;
  if (!link) throw invalid(`${nameFor(tx, carried)} is not attached to anything`);
  const { attached: _link, ...loose } = carried;
  if (op.x === undefined || op.y === undefined) {
    // Getting off a ride is a walk to a place beside the mount, which costs what the rules say on the rider's turn (7.3).
    if (link.kind === "ride") throw invalid(GET_OFF_NEEDS_A_PLACE);
    tx.write(keys.token(carried.id), loose);
    return;
  }
  if (link.kind === "drag" || !isCreature(carried)) throw invalid(PUT_DOWN_IN_PLACE);
  const holder = tx.token(link.to);
  const scene = tx.scene(carried.sceneId);
  const spot = { x: op.x, y: op.y, elevation: op.elevation ?? carried.elevation };
  if (!getOffFits(sceneGrid(scene), tx.state.meta.settings, scene.bounds, carried, holder, spot)) throw invalid(`${nameFor(tx, carried)} can only get off beside ${nameFor(tx, holder)}`);
  // It lands as a walk lands (4.3): on the ground there, or at its own height, as one that flies keeps it.
  if (!landsAt(tx.state.buildChunks, carried, spot)) throw invalid(`${nameFor(tx, carried)} gets off onto the ground there or at its own height`);
  const along = carriedAlong(tx, op);
  const next: Token = { ...loose, ...spot };
  delete next.squeeze;
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  const cost = link.kind === "ride" ? mountCost(tx, carried, holder) : null;
  tx.write(keys.token(carried.id), cost === null ? withPath(tx, carried, next, judged) : dismounted(tx, carried, next, holder, judged, cost));
  placeCarried(tx, along, judged);
}

function seenByAll(tx: Tx, tokenId: string): boolean {
  const token = tx.state.tokens[tokenId];
  return token !== undefined && inSightOfNonOwners(tx.state, token, tx.env);
}

/**
 * The link pass (5.2, "Links must hold"), the last part of every op's
 * dispatch: each link to or from a token the op wrote, or every link when
 * it wrote the room's settings, in token id order, that no longer holds is
 * dropped, the token loose where it stands. The
 * holder is gone, the two are on different scenes, what sits on its holder
 * no longer fits it, or a dragged creature is out of reach. One rule
 * covers a deletion, Enlarge ending, a teleport and every move of a
 * carried token alone, so no token is ever carried from afar.
 */
export function linkPass(tx: Tx): void {
  const touched = new Set<string>();
  // The room's distance rules (feet per square, the diagonal rule) decide every drag's reach, so an op that writes them meets every link.
  let everyLink = false;
  for (const key of tx.touched()) {
    if (key.startsWith("token:")) touched.add(key.slice("token:".length));
    else if (key === keys.meta) everyLink = true;
  }
  if (touched.size === 0 && !everyLink) return;
  const candidates: Token[] = [];
  for (const token of Object.values(tx.state.tokens)) {
    const link = token.attached;
    if (link && (everyLink || touched.has(token.id) || touched.has(link.to))) candidates.push(token);
  }
  const settings = tx.state.meta.settings;
  for (const token of sortedById(candidates)) {
    const link = token.attached!;
    const holder = tx.state.tokens[link.to];
    if (holder && holder.id !== token.id && linkHolds(gridOfToken(tx.state, token), settings, link.kind, token, holder)) continue;
    const { attached: _gone, ...loose } = token;
    tx.write(keys.token(token.id), loose);
  }
}
