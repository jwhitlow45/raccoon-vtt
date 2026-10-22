import { keys } from "../keys.ts";
import { attaches, healRevivesDead, oneLinkPerActor, resizeStop, shapeKeepsOwnNumbers, syncsFromDdb, walksRoutes } from "../migrate.ts";
import type { Actor, AreaTemplate, Character, DdbSync, Drawing, PathStop, RoomState, Token, TokenPath, TurnStart } from "../model.ts";
import { inSightOfNonOwners, seenAtEvery } from "../project.ts";
import { MAX_RULER_STOPS, SYNC_AT_AHEAD, syncAtAhead, syncStamp, type ActorPatch, type DdbSyncPatch, type Op, type OpOf, type TokenPatch } from "../protocol.ts";
import { LIMITS, serializedBytes } from "../limits.ts";
import { applyHpSet, type ActorEvent } from "../rules/hp.ts";
import { footprintSize, isSqueezed, snapStep, stopFootprint } from "../rules/footprint.ts";
import { pathCounters, pathThisTurn, reshapeLeg, sameSpot, turnUnderWay, withStop, type Walked } from "../rules/path.ts";
import { onTrace, routeFeet, routePoints, routeWalk, routeWalkBeforeV14, routeWalkers, straightCost, type LegCost, type RoutePiece, type RoutePoint, type WalkTrace } from "../rules/route.ts";
import { planMove, type MovedToken } from "../rules/moveLeg.ts";
import { holderOf, linkHolds, walkerFor } from "../rules/attach.ts";
import { dismountSplit } from "../rules/dismount.ts";
import { walkFrom } from "../rules/movement.ts";
import { deleteCharacterBlocks } from "./companionBlocks.ts";
import {
  BLOCK_LINKS,
  BLOCK_OF_ITS_CHARACTER,
  COMPANION_OWNERS,
  NO_NUMBER,
  NOT_SHARED,
  ONE_LINK,
  actsOnCharacterTurn,
  checkBlockLink,
  checkCompanion,
  dropRows,
  linksSet,
  syncOwners,
} from "./companions.ts";
import { removeEntries } from "./encounter.ts";
import { applyPcStatsPatch, EMPTY_PC_STATS, pcNumbersFromBlock, pcStatsFits, pcStatsTooBig, WILD_SHAPE_ALONE, withPcActorNumbers, withUnshaped } from "../rules/pcStats.ts";
import { gone, invalid, Refuse, type Env, type ResolvedActor, type Tx } from "./tx.ts";

function tokenDefaults(kind: Token["kind"]): Pick<Token, "disposition" | "layer" | "hpVisibility"> {
  return {
    disposition: kind === "pc" ? "ally" : kind === "monster" ? "hostile" : "neutral",
    layer: kind === "object" ? "object" : "token",
    hpVisibility: kind === "pc" ? "exact" : "label",
  };
}

/**
 * Numbers duplicates: a second Goblin on the scene makes the first "Goblin 1"
 * and becomes "Goblin 2". Siblings are visited by id, never by map order,
 * because a snapshot loaded from jsonb loses insertion order and replay must
 * number the same way the live run did.
 */
function autoNumber(tx: Tx, token: Token): number | undefined {
  if (token.kind !== "npc" && token.kind !== "monster") return undefined;
  // A companion is never numbered, nor counted among the siblings: a player's new "Owl 2" would tell them a hidden Owl
  // stands there (docs/design-v1-combat-flow.md 3.6.3).
  if (token.companion) return undefined;
  const siblings = Object.values(tx.state.tokens)
    .filter((t) => t.id !== token.id && t.sceneId === token.sceneId && t.name === token.name && t.kind !== "pc" && !t.companion)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (siblings.length === 0) return undefined;
  const used = new Set(siblings.map((t) => t.number).filter((n): n is number => n !== undefined));
  for (const sibling of siblings) {
    if (sibling.number !== undefined) continue;
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    tx.write(keys.token(sibling.id), { ...sibling, number: n });
  }
  return Math.max(...used) + 1;
}

export function tokenCreate(tx: Tx, op: OpOf<"token.create">): void {
  const input = op.token;
  if (tx.state.tokens[input.id]) throw invalid("token already exists");
  tx.scene(input.sceneId);
  if ("ref" in input.actor) tx.character(input.actor.ref);
  // An actor links one stat block, and one of its character's only on a companion (docs/design-v1-companion-stat-blocks.md 3.2).
  if ("inline" in input.actor && input.actor.inline.blockId !== undefined && linksSet(input.actor.inline) > 1) throw invalid(ONE_LINK);
  if ("inline" in input.actor && input.actor.inline.wildShape !== undefined) throw invalid(WILD_SHAPE_ALONE);
  const defaults = tokenDefaults(input.kind);
  const token: Token = {
    id: input.id,
    rev: 0,
    sceneId: input.sceneId,
    kind: input.kind,
    name: input.name,
    nameHidden: input.nameHidden ?? false,
    size: input.size,
    x: input.x,
    y: input.y,
    elevation: input.elevation ?? 0,
    rotation: input.rotation ?? 0,
    disposition: input.disposition ?? defaults.disposition,
    visibility: input.visibility ?? "all",
    fogExempt: input.fogExempt ?? false,
    fogExemptAuto: false,
    locked: input.locked ?? false,
    layer: input.layer ?? defaults.layer,
    ownerIds: input.ownerIds ?? [],
    actor: input.actor,
    hpVisibility: input.hpVisibility ?? defaults.hpVisibility,
  };
  if (input.publicName !== undefined) token.publicName = input.publicName;
  if (input.image !== undefined) token.image = input.image;
  if (input.w !== undefined) token.w = input.w;
  if (input.h !== undefined) token.h = input.h;
  if (input.height !== undefined) token.height = input.height;
  if (input.notes !== undefined) token.notes = input.notes;
  if (input.altImages !== undefined && input.altImages.length > 0) token.altImages = input.altImages;
  if (input.rangeRings !== undefined && input.rangeRings.length > 0) token.rangeRings = normalRings(input.rangeRings);
  if (input.light !== undefined) token.light = input.light;
  if (input.partyVision === true) token.partyVision = true;
  if (input.companion) {
    // A companion is played by whoever plays its character, and carries no number (docs/design-v1-combat-flow.md 3.6.3).
    if (input.number !== undefined) throw invalid(NO_NUMBER);
    const character = tx.character(input.companion.of);
    if (input.ownerIds !== undefined && !sameMembers(input.ownerIds, character.ownerIds)) throw invalid(COMPANION_OWNERS);
    token.companion = { of: input.companion.of, turn: input.companion.turn };
    token.ownerIds = [...character.ownerIds];
    checkCompanion(tx, token);
    checkBlockLink(tx, token);
    tx.write(keys.token(token.id), token);
    // The DM learns that a player brought one, in a line only the DM's log carries.
    if (tx.actor.role !== "dm") tx.addEvent({ type: "companion", tokenId: token.id, characterId: character.id, memberId: tx.actor.memberId, name: token.name });
    return;
  }
  checkBlockLink(tx, token);
  const number = input.number ?? autoNumber(tx, token);
  if (number !== undefined) token.number = number;
  tx.write(keys.token(token.id), token);
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Applies the shared actor patch. HP edits go through the rules so life
 * states follow. A patch that sets one stat block link clears the other two
 * (docs/design-v1-companion-stat-blocks.md 3.2, rule 1), so a player can
 * replace a link they cannot see, such as the DM's `monsterId`. Ops stored
 * before op version 6 kept the others (`oneLinkPerActor`). A character's
 * actor never holds a companion's block, whichever op writes it.
 */
export function applyActorPatch(tx: Tx, resolved: ResolvedActor, patch: ActorPatch): { actor: Actor; events: ActorEvent[] } {
  const oneLink = oneLinkPerActor(tx.env.opVersion);
  const linking = linksSet(patch);
  if (oneLink && linking > 1) throw invalid(ONE_LINK);
  if (resolved.holder === "character" && patch.blockId !== undefined && patch.blockId !== null) throw invalid(BLOCK_OF_ITS_CHARACTER);
  if (patch.wildShape !== undefined && (resolved.holder !== "character" || patch.srdId === undefined || patch.srdId === null)) throw invalid(WILD_SHAPE_ALONE);
  // A block gives these two, and its next edit would write over a typed one anyway (docs/design-v1-pc-stats.md 3.5). The DM too.
  if (resolved.character?.stats && (patch.initBonus !== undefined || patch.passivePerception !== undefined)) throw invalid(pcNumbersFromBlock(resolved.character.name));
  let actor: Actor = { ...resolved.actor };
  const events: ActorEvent[] = [];
  if (patch.hp) {
    const settings = tx.state.meta.settings;
    const r = applyHpSet(actor, patch.hp, resolved.kind, settings, healRevivesDead(settings, tx.env.opVersion));
    actor = r.actor;
    events.push(...r.events);
  }
  if (patch.ac !== undefined) actor.ac = patch.ac;
  if (patch.speeds !== undefined) actor.speeds = patch.speeds;
  if (patch.initBonus !== undefined) actor.initBonus = patch.initBonus;
  if (patch.passivePerception !== undefined) actor.passivePerception = patch.passivePerception;
  if (patch.senses !== undefined) actor.senses = patch.senses;
  if (patch.notes !== undefined) actor.notes = patch.notes;
  if (patch.dmNotes !== undefined) actor.dmNotes = patch.dmNotes;
  setOrDelete(actor, "initScore", patch.initScore);
  setOrDelete(actor, "creatureType", patch.creatureType);
  setOrDelete(actor, "cr", patch.cr);
  setOrDelete(actor, "xp", patch.xp);
  setOrDelete(actor, "srdId", patch.srdId);
  setOrDelete(actor, "monsterId", patch.monsterId);
  setOrDelete(actor, "blockId", patch.blockId);
  if (oneLink && linking === 1) {
    for (const field of BLOCK_LINKS) if (patch[field] === undefined || patch[field] === null) delete actor[field];
  }
  // A shape is set whole: the patch that links the creature says whether it is Wild Shape, and a shape that ends takes the mark with it.
  if (patch.srdId !== undefined && patch.srdId !== null && patch.wildShape === true) actor.wildShape = true;
  else if (patch.srdId !== undefined || actor.srdId === undefined) delete actor.wildShape;
  setOrDelete(actor, "sheetUrl", patch.sheetUrl);
  setOrDelete(actor, "legendary", patch.legendary);
  if (resolved.holder === "character" && shapeKeepsOwnNumbers(tx.env.opVersion)) actor = withUnshaped(resolved.actor, actor, patch);
  return { actor, events };
}

/** Optional fields take null in a patch to mean "remove", and undefined to mean "leave alone". */
function setOrDelete<T extends object, K extends keyof T>(target: T, field: K, value: T[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete target[field];
  else target[field] = value;
}

export function tokenUpdate(tx: Tx, op: OpOf<"token.update">): void {
  const token = tx.token(op.tokenId);
  // Planned before anything is written: what its group does follows where it stood (docs/design-v1-attach.md 8.2).
  const along = carriedAlong(tx, op);
  const p = op.patch;
  const next: Token = { ...token };
  if (p.sceneId !== undefined) {
    tx.scene(p.sceneId);
    next.sceneId = p.sceneId;
  }
  if (p.kind !== undefined) next.kind = p.kind;
  if (p.name !== undefined) next.name = p.name;
  if (p.nameHidden !== undefined) next.nameHidden = p.nameHidden;
  if (p.size !== undefined) next.size = p.size;
  if (p.x !== undefined) next.x = p.x;
  if (p.y !== undefined) next.y = p.y;
  if (p.elevation !== undefined) next.elevation = p.elevation;
  if (p.rotation !== undefined) next.rotation = p.rotation;
  if (p.disposition !== undefined) next.disposition = p.disposition;
  if (p.visibility !== undefined) next.visibility = p.visibility;
  if (p.fogExempt !== undefined) next.fogExempt = p.fogExempt;
  if (p.locked !== undefined) next.locked = p.locked;
  if (p.layer !== undefined) next.layer = p.layer;
  if (p.ownerIds !== undefined) next.ownerIds = p.ownerIds;
  if (p.hpVisibility !== undefined) next.hpVisibility = p.hpVisibility;
  setOrDelete(next, "publicName", p.publicName);
  setOrDelete(next, "image", p.image);
  setOrDelete(next, "w", p.w);
  setOrDelete(next, "h", p.h);
  setOrDelete(next, "height", p.height);
  setOrDelete(next, "number", p.number);
  setOrDelete(next, "notes", p.notes);
  setOrDelete(next, "altImages", p.altImages?.length === 0 ? null : p.altImages);
  if (p.rangeRings !== undefined) {
    const rings = normalRings(p.rangeRings);
    if (rings.length > 0) next.rangeRings = rings;
    else delete next.rangeRings;
  }
  setOrDelete(next, "light", p.light);
  // Membership is stored only while it holds, so a creature taken out of the party is as one that never was.
  if (p.partyVision === true) next.partyVision = true;
  else if (p.partyVision === false) delete next.partyVision;
  // A squeeze is where the token stood, at its size: a new size, scene or place leaves it standing full size (section 4.1).
  if (SQUEEZE_FIELDS.some((field) => p[field] !== undefined)) delete next.squeeze;
  updateCompanion(tx, token, next, p);
  const judged = judgedIn(tx, [next, ...along.map((c) => c.next)]);
  tx.write(keys.token(token.id), walkedOwn(tx, token, next, judged));
  placeCarried(tx, along, judged);
  // Coming to act on its character's turn takes its rows out of the fight and its history (docs/design-v1-combat-flow.md 3.6.7).
  if (p.companion && actsOnCharacterTurn(next)) dropRows(tx, tx.token(token.id), true);
  if (next.sceneId !== token.sceneId) areasFollow(tx, token.id, next.sceneId);
  if (p.actor) {
    const resolved = tx.resolveActor({ tokenId: token.id });
    const r = applyActorPatch(tx, resolved, p.actor);
    tx.putActor(resolved, r.actor);
    tx.addActorEvents(resolved, r.events);
    // Checked against the companion as the op leaves it, so one patch may give it to another character and that one's block.
    if (p.actor.blockId !== undefined && p.actor.blockId !== null) checkBlockLink(tx, tx.token(token.id));
  }
}

/**
 * The companion rules on a token.update (docs/design-v1-combat-flow.md
 * 3.6.3, 3.6.4 and 3.6.8), applied to `next`, the token as the rest of the
 * patch leaves it. Attaching clears an inherited number first, then the
 * result is checked, so a numbered Owl attaches, while a number the op
 * itself supplies is refused. Owners always come from the character, and a
 * spent Reaction stays only while the companion acts on its character's
 * turn listed under it.
 */
function updateCompanion(tx: Tx, token: Token, next: Token, p: TokenPatch): void {
  if (p.companion === null) delete next.companion;
  else if (p.companion !== undefined) {
    const keep = token.companion?.turn === "shared" && token.companion.reactionUsed === true && p.companion.turn === "shared";
    next.companion = { of: p.companion.of, turn: p.companion.turn, ...(keep ? { reactionUsed: true as const } : {}) };
    delete next.number;
  }
  // A companion block is its character's, so a companion given to another character, or no longer one, lets it go
  // (docs/design-v1-companion-stat-blocks.md 3.2, rule 3). An SRD link holds nothing of the character's and stays.
  if (next.companion?.of !== token.companion?.of && "inline" in next.actor && next.actor.inline.blockId !== undefined) {
    const { blockId: _theirs, ...actor } = next.actor.inline;
    next.actor = { inline: actor };
  }
  if (p.companionReaction !== undefined) {
    if (next.companion?.turn !== "shared") throw invalid(NOT_SHARED);
    const { reactionUsed: _spent, ...link } = next.companion;
    next.companion = p.companionReaction ? { ...link, reactionUsed: true } : link;
  }
  if (!next.companion) return;
  if (p.number !== undefined && p.number !== null) throw invalid(NO_NUMBER);
  if (p.ownerIds !== undefined) throw invalid(COMPANION_OWNERS);
  checkCompanion(tx, next);
  next.ownerIds = [...tx.character(next.companion.of).ownerIds];
}

/** An attached area follows its token, to another scene too, rather than staying behind at a stale origin. */
function areasFollow(tx: Tx, tokenId: string, sceneId: string): void {
  for (const template of sortedById(Object.values(tx.state.templates))) {
    if (template.attachedTo === tokenId) tx.write(keys.template(template.id), { ...template, sceneId });
  }
}

/** A token a holder's move takes along: as it was, where the plan puts it, and the plan's entry. */
export type Carried = { token: Token; next: Token; plan: MovedToken };

/**
 * What an op's named moves take along (docs/design-v1-attach.md 8.2):
 * every token of their groups the plan moves, each where it puts it, from
 * op version 14. Asked before the op writes anything, since every member
 * follows the walk its holder took from where it stood. A move of a carried
 * token alone takes along only what it carries itself.
 */
export function carriedAlong(tx: Tx, op: Op): Carried[] {
  if (!attaches(tx.env.opVersion)) return [];
  const out: Carried[] = [];
  for (const plan of planMove(op, tx.state, tx.actor, tx.env)) {
    if (plan.carriedBy === undefined) continue;
    const token = tx.token(plan.tokenId);
    const next: Token = { ...token, sceneId: plan.to.sceneId, x: plan.to.x, y: plan.to.y, elevation: plan.to.elevation };
    // A squeeze is where the token stood at its size, and only its own move takes one.
    delete next.squeeze;
    out.push({ token, next, plan });
  }
  return out;
}

/** Writes the tokens a move took along, each with a carried leg on its path when it is the turn's creature, and its areas sent along to another scene. */
export function placeCarried(tx: Tx, carried: readonly Carried[], judged: Judged): void {
  for (const { token, next, plan } of carried) {
    tx.write(keys.token(token.id), withPath(tx, token, next, judged, true, undefined, plan));
    if (next.sceneId !== token.sceneId) areasFollow(tx, token.id, next.sceneId);
  }
}

/** Removes a token with what hangs off it: attached templates, caster references and its initiative rows. */
export function deleteToken(tx: Tx, tokenId: string): void {
  const token = tx.token(tokenId);
  // A companion's rows leave the fight's history too, so Previous never brings one back (docs/design-v1-combat-flow.md 3.6.8).
  if (token.companion) dropRows(tx, token, false);
  for (const template of sortedById(Object.values(tx.state.templates))) {
    if (template.attachedTo === tokenId) tx.remove(keys.template(template.id));
    else if (template.casterId === tokenId) {
      const next = { ...template };
      delete next.casterId;
      tx.write(keys.template(template.id), next);
    }
  }
  const entryIds = tx.state.encounter?.entries.filter((e) => e.tokenId === tokenId).map((e) => e.id) ?? [];
  if (entryIds.length > 0) removeEntries(tx, entryIds);
  tx.remove(keys.token(token.id));
}

export function tokenDelete(tx: Tx, op: OpOf<"token.delete">): void {
  deleteToken(tx, op.tokenId);
}

/** The fields of a token.update that clear a squeeze: its size, its scene and its place. */
const SQUEEZE_FIELDS = ["size", "w", "h", "sceneId", "x", "y"] as const;

type Move = Omit<OpOf<"token.move">, "t">;

/**
 * One token's move. `squeeze` stops it squeezed and any move without it
 * stands it full size again (section 4.1): permissions decide whether the
 * squeeze is real. A teleport's leg on the turn's path does not count, and
 * the DM's log says what it passed, whoever moved it and whether or not a
 * fight is on. Both flags are in the stored op, so replay does the same.
 */
function movedToken(tx: Tx, move: Move): { move: Move; token: Token; next: Token } {
  const token = tx.token(move.tokenId);
  const next: Token = { ...token, x: move.x, y: move.y };
  if (move.elevation !== undefined) next.elevation = move.elevation;
  if (move.rotation !== undefined) next.rotation = move.rotation;
  if (move.squeeze) next.squeeze = true;
  else delete next.squeeze;
  return { move, token, next };
}

/**
 * The two states a move's stops are judged in. `before` is the state as it
 * stood before the op wrote any of its tokens: where a stop is added where
 * the creature stood. `after` has every token of the op where it ends:
 * where the last stop is judged, so a light carried by another token of the
 * same group move counts as it will be, whatever order the moves are listed
 * in. Each is a state of its own, which no later write of the op changes
 * (shared/writable.ts), and `after` is made only when a stop is judged, so
 * a move with no path to mark copies nothing.
 */
export type Judged = { before: RoomState; after: () => RoomState };

export function judgedIn(tx: Tx, tokens: readonly Token[]): Judged {
  const before = { ...tx.state };
  let arrived: RoomState | undefined;
  const after = () => {
    if (!arrived) {
      const all = { ...before.tokens };
      for (const t of tokens) all[t.id] = t;
      arrived = { ...before, tokens: all };
    }
    return arrived;
  };
  return { before, after };
}

function placeMoved(tx: Tx, { move, token, next }: { move: Move; token: Token; next: Token }, judged: Judged): void {
  tx.write(keys.token(token.id), walkedOwn(tx, token, next, judged, move.teleport !== undefined, move.route));
  if (move.teleport !== undefined) tx.addEvent({ type: "teleport", tokenId: token.id, past: move.teleport });
}

/**
 * A token after a move of its own (withPath), or, when the turn's creature
 * walks off its own ride, after a Get off (docs/design-v1-attach.md 7.3),
 * since leaving a mount costs the same whether the rider is dragged off it
 * or taps Get off. A teleport uses no movement and pays nothing.
 */
function walkedOwn(tx: Tx, token: Token, next: Token, judged: Judged, teleport = false, route?: readonly RoutePiece[]): Token {
  const mount = teleport ? undefined : leftMount(tx, token, next, judged);
  const cost = mount ? mountCost(tx, token, mount) : null;
  return mount && cost !== null ? dismounted(tx, token, next, mount, judged, cost, route) : withPath(tx, token, next, judged, teleport, route);
}

/** The mount a rider's move leaves: its ride, which no longer holds where the op puts the two, on the same scene. */
function leftMount(tx: Tx, rider: Token, next: Token, judged: Judged): Token | undefined {
  const link = rider.attached;
  if (link?.kind !== "ride" || next.sceneId !== rider.sceneId || !attaches(tx.env.opVersion)) return undefined;
  const mount = holderOf(tx.state.tokens, rider) as Token | undefined;
  const there = judged.after().tokens[link.to];
  if (!mount || !there || linkHolds(tx.state.meta.settings, "ride", next, there)) return undefined;
  return mount;
}

/**
 * Half the rider's walking Speed, rounded down (docs/design-v1-attach.md
 * 7.3): what getting on or off a mount costs on the rider's own turn,
 * whatever the leg's length. Null when it costs nothing: not the rider's
 * turn, a mount some player cannot see, or an op from before walked legs or
 * attached tokens recorded what they took. The cost lands on the rider's
 * own path, which only the DM and the rider's owners receive, and they
 * always see their own rider. So only the mount is a private input: like
 * turn sharing (7.1) the cost reads only a mount every player sees, and a
 * hidden mount leaves the leg an ordinary one (8.0). A hidden rider, such
 * as an invisible PC, still pays.
 */
export function mountCost(tx: Tx, rider: Token, mount: Token): number | null {
  if (!walksRoutes(tx.env.opVersion) || !attaches(tx.env.opVersion)) return null;
  const turn = turnUnderWay(tx.state.encounter);
  if (!turn || turn.tokenId !== rider.id) return null;
  if (!inSightOfNonOwners(tx.state, mount, tx.env)) return null;
  return Math.floor((speedsOf(tx.state, rider)?.walk ?? 0) / 2);
}

/** Whether every player sees a token as the op finds the room, by its envelope: what a walk off a holder reads (rules/attach.ts walkerFor). */
function seenNow(tx: Tx): (t: { id: string }) => boolean {
  return (t) => {
    const token = tx.state.tokens[t.id];
    return token !== undefined && inSightOfNonOwners(tx.state, token, tx.env);
  };
}

/**
 * Getting off a ride on the rider's turn (docs/design-v1-attach.md 7.3):
 * from the seat to the first spot of the walk clear of the mount costs half
 * its Speed, and the rest of the leg what any leg costs, along the rest of
 * its route when it has one, two stops when the two differ.
 */
export function dismounted(tx: Tx, rider: Token, next: Token, mount: Token, judged: Judged, cost: number, route?: readonly RoutePiece[]): Token {
  // It walks off on the ground, crossing only its mount's inner ledges, where its mount stands on it (rules/attach.ts walkerFor), as the drag searched it,
  // from the ground under its own footprint (movement.ts walkFrom).
  const walking = walkerFor(tx.state, rider, seenNow(tx), { opVersion: tx.env.opVersion });
  const from = { x: rider.x, y: rider.y, elevation: walkFrom(tx.state.buildChunks, walking).elevation };
  const points = route ? routePoints(tx.state.buildChunks, walking, route, next.elevation) : [from, { x: next.x, y: next.y, elevation: next.elevation }];
  // The same split a drag's band reads (rules/dismount.ts dismountCost), so the preview and the stored stops agree.
  const split = dismountSplit(tx.state, walking, mount, points, route);
  const off: Token = { ...next, ...split.off };
  const first = withPath(tx, rider, off, judgedIn(tx, [off]), false, split.prefix, undefined, cost);
  return split.whole || sameSpot(off, next) ? first : withPath(tx, first, next, judged, false, split.rest);
}

/**
 * The token after a move, with the move on its path when it is the active
 * creature's on its own turn (features section 4), whoever moved it. The
 * turn passing writes no token, so the first move of a turn finds no path
 * of this turn and starts one where the turn began. A move outside its
 * turn, or to another scene, drops the path, which counts as empty by then
 * anyway. A change of facing alone is not movement and leaves it be.
 *
 * A change of the footprint is not movement either
 * (docs/design-v1-token-window.md 8.7) where it is not a move: a resize,
 * wherever it leaves the creature, and a squeeze taken or left in place,
 * as a same-size update or a group's resize to the size a member already
 * has does when it clears a squeeze. Each appends an uncounted stop where
 * it leaves the creature, even in place, since a squeezed footprint is
 * read centered and unsnapped and a full one snapped, so the two differ
 * by up to half a square where nothing moved. Whenever the footprint
 * changes, by those or by a move into or out of a squeeze, every earlier
 * stop that holds no footprint takes the old one, squeeze and all, so each
 * leg keeps the feet and the look it had: a stop is read with the
 * footprint now unless it holds its own. Ops stored before version 6 did
 * neither (`resizeStop`), and replay as they were.
 */
export function withPath(tx: Tx, before: Token, after: Token, judged: Judged, uncounted = false, route?: readonly RoutePiece[], carried?: Pick<MovedToken, "route" | "trace">, cost?: number): Token {
  if (after.sceneId !== before.sceneId) return withoutPath(after);
  const from = footprintSize(before);
  const to = footprintSize(after);
  const sinceV6 = resizeStop(tx.env.opVersion);
  const resized = (from.w !== to.w || from.h !== to.h) && sinceV6;
  const reshaped = resized || (sinceV6 && isSqueezed(before) !== isSqueezed(after));
  const inPlace = sameSpot(before, after);
  if (!reshaped && inPlace) return after;
  const encounter = tx.state.encounter;
  const turn = turnUnderWay(encounter);
  if (!turn) {
    // A player's copy lacks the start of a turn they could not see begin (design 7.3), so their device cannot tell this
    // turn's path from an earlier one's. It leaves the active creature's path for the server's answer.
    const active = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
    return active?.tokenId === after.id ? after : withoutPath(after);
  }
  // A controlled mount sharing its rider's turn moves on its own path then (docs/design-v1-attach.md 7.2), from op version 14.
  const mount = turn.tokenId !== after.id && attaches(tx.env.opVersion) && sharesTurn(tx.state, after.id, turn);
  // A mount's path this turn outlives a move that shares no turn, which records nothing, so a remount the same turn goes on with it (7.2).
  if (turn.tokenId !== after.id && !mount) return attaches(tx.env.opVersion) && before.path?.turn === turn.seq ? after : withoutPath(after);
  // A row that marks time had its movement on its rider's turn, so its moves there are outside its turn (7.1).
  if (!mount && attaches(tx.env.opVersion) && marksTime(encounter, turn.entryId)) return withoutPath(after);
  // Since op version 13 every leg records what it took, and full paths join by those sums (walksRoutes).
  const walked: Walked | undefined = walksRoutes(tx.env.opVersion) ? { token: after, rules: tx.state.meta.settings } : undefined;
  // A mount's path starts where it stood before its first move this turn, since the turn's start is its rider's.
  const first = !mount && turn.sceneId === before.sceneId ? [startStop(turn)] : [];
  let path: TokenPath = before.path?.turn === turn.seq ? before.path : { turn: turn.seq, stops: first };
  // Every move of the creature this turn is a leg, so the last stop is where it stood. The check keeps a stop from being skipped if not.
  const last = path.stops[path.stops.length - 1];
  if (!last || !sameSpot(last, before)) {
    // A mount moved between two shares of the turn: that move shared no turn, so its leg does not count.
    const gap = stopAt(judged.before, before, tx.env);
    path = withStop(path, mount && last ? { ...gap, uncounted: true } : gap, undefined, walked);
  }
  // Where it stops is judged as the finished move will be: with it and every token moving with it there, their lights too.
  let stop = stopAt(judged.after(), after, tx.env);
  if (reshaped) {
    const old = stopFootprint(before);
    path = { turn: path.turn, stops: path.stops.map((s): PathStop => (s.footprint ? s : { ...s, footprint: old })) };
  }
  if (walked) stop = walkedStop(tx, path, stop, before, after, judged, route, carried);
  // Getting on or off a mount costs what the rules say whatever the leg (docs/design-v1-attach.md 7.3), set before the stop joins the path.
  if (cost !== undefined) stop = { ...stop, cost };
  // A leg a holder's move took the creature along never counts, and only the DM learns how it was made (7.2).
  if (carried) stop = { ...stop, uncounted: true, carried: true };
  const counts = !resized && !(reshaped && inPlace) && !uncounted;
  return { ...after, path: withStop(path, counts ? stop : { ...stop, uncounted: true }, to, walked) };
}

/** Whether the row marks time this round: its mount shared a rider's turn in it (docs/design-v1-attach.md 7.1). */
function marksTime(encounter: RoomState["encounter"], entryId: string): boolean {
  const row = encounter?.entries.find((e) => e.id === entryId);
  return row?.markRound !== undefined && row.markRound === encounter!.round;
}

/**
 * Whether a token is a controlled mount sharing the turn under way
 * (docs/design-v1-attach.md 7.1): it joined the turn's list, and the turn's
 * creature still rides it, by controlled rides all the way up its chain.
 */
export function sharesTurn(state: RoomState, mountId: string, turn: TurnStart): boolean {
  const mounts = turn.mounts;
  if (!mounts?.includes(mountId)) return false;
  const seen = new Set<string>();
  let rider = state.tokens[turn.tokenId];
  while (rider && !seen.has(rider.id)) {
    seen.add(rider.id);
    const link = rider.attached;
    const holder = link?.kind === "ride" && link.steer ? holderOf(state.tokens, rider) : undefined;
    if (!holder || !mounts.includes(holder.id)) return false;
    if (holder.id === mountId) return true;
    rider = state.tokens[holder.id];
  }
  return false;
}

/**
 * The new stop with what its leg took (docs/design-v1-movement.md 6.2):
 * `moved`, `cost` and `diag` by one pure rule from the op's route, or from
 * the plain straight leg's geometry, with the 5-10-5 count running on from
 * the turn's counted legs. A Swim Speed, which only the DM and the owners
 * receive, takes the swimming foot off `cost` alone. The route's corners
 * are `via`, and `routeSeen` marks a leg players who do not own the token
 * saw at every spot, before and after the move (7.2).
 */
function walkedStop(tx: Tx, path: TokenPath, stop: PathStop, before: Token, after: Token, judged: Judged, route: readonly RoutePiece[] | undefined, carried?: Pick<MovedToken, "route" | "trace">): PathStop {
  const rules = tx.state.meta.settings;
  const from = path.stops[path.stops.length - 1]!;
  const counter = pathCounters(after, path.stops, rules);
  const walker = walkerFor(tx.state, before, seenNow(tx), { opVersion: tx.env.opVersion });
  let taken: LegCost;
  // The walk's trace (route.ts WalkTrace): its own, its route's or the straight leg's, or its holder's taking it along.
  let trace: WalkTrace;
  if (carried) {
    // Carried, its feet are its holder's walk offset by its place, and it took nothing off its own speed: no cost, no corners (M13).
    trace = carried.trace;
    taken = routeFeet(carried.route, carried.route.slice(1).map(() => ({ extra: 0, swim: 0 as const })), rules, counter, { swimSpeed: false, step: snapStep(before) });
  } else if (route) {
    trace = routeWalkers(tx.state.buildChunks, walker, route, after.elevation);
    const swimSpeed = (speedsOf(tx.state, before)?.swim ?? 0) > 0;
    taken = routeFeet(pointsOf(trace), route.map(([, , extra, swim]) => ({ extra, swim })), rules, counter, { swimSpeed, step: snapStep(before) });
  } else {
    trace = routeWalkers(tx.state.buildChunks, walker, [[after.x, after.y, 0, 0]], after.elevation);
    // From where the walk starts, on the ground under its footprint off a holder on the ground, as a route's first piece does (movement.ts walkFrom).
    taken = straightCost(after, { ...from, elevation: trace[0]!.elevation }, stop, rules, counter);
  }
  const walk = carried ? [...carried.route] : pointsOf(trace);
  const out: PathStop = carried ? { ...stop, moved: taken.moved } : { ...stop, moved: taken.moved, cost: taken.cost };
  if (taken.diag[0] !== 0 || taken.diag[1] !== 0) out.diag = taken.diag;
  if (route && route.length > 1) out.via = route.slice(0, -1).flatMap(([x, y]) => [x, y]);
  // Each spot with the footprint the walk's trace has there, squeezed where it ends as it will be (route.ts onTrace). Ops
  // before version 14 read the full footprint between its ends, squeezed only where it starts.
  const spots = attaches(tx.env.opVersion)
    ? routeWalk(trace, judged.before).map((p) => ({ ...p, squeezed: isSqueezed(onTrace(trace, p.progress[0], p.progress[1] === p.progress[2] && p.progress[2] > 0, after)) }))
    : routeWalkBeforeV14(walk, walker, judged.before).map((p, i, all) => ({ ...p, squeezed: i === all.length - 1 ? isSqueezed(after) : i === 0 && isSqueezed(before) }));
  if (seenAtEvery(judged.before, after, spots, tx.env) && seenAtEvery(judged.after(), after, spots, tx.env)) out.routeSeen = true;
  return out;
}

function pointsOf(trace: WalkTrace): RoutePoint[] {
  return trace.map(({ x, y, elevation }) => ({ x, y, elevation }));
}

/** The speeds the token's actor holds: its own, or its character's. */
export function speedsOf(state: RoomState, token: Token): Actor["speeds"] | undefined {
  return "inline" in token.actor ? token.actor.inline.speeds : state.characters[token.actor.ref]?.actor.speeds;
}

function startStop(turn: TurnStart): PathStop {
  return { x: turn.x, y: turn.y, elevation: turn.elevation, ...(turn.seen ? { seen: true as const } : {}) };
}

/** A stop where the token stands in `state`, marked seen by the turn start's rule (design 7.3). */
function stopAt(state: RoomState, token: Token, env: Env): PathStop {
  return { x: token.x, y: token.y, elevation: token.elevation, ...(inSightOfNonOwners(state, token, env) ? { seen: true as const } : {}) };
}

function withoutPath(token: Token): Token {
  if (token.path === undefined) return token;
  const { path: _path, ...rest } = token;
  return rest;
}

/** A holder's move takes its group along (docs/design-v1-attach.md 8.2), every stop judged with all of them where they end. */
export function tokenMove(tx: Tx, op: OpOf<"token.move">): void {
  const along = carriedAlong(tx, op);
  const moved = movedToken(tx, op);
  const judged = judgedIn(tx, [moved.next, ...along.map((c) => c.next)]);
  placeMoved(tx, moved, judged);
  placeCarried(tx, along, judged);
}

/** Every token is placed first, so each stop is judged with the whole group where it stood or where it ends. */
export function tokenMoveMany(tx: Tx, op: OpOf<"token.moveMany">): void {
  const seen = new Set<string>();
  const moves = op.moves.map((move) => {
    if (seen.has(move.tokenId)) throw invalid("a token appears twice");
    seen.add(move.tokenId);
    return movedToken(tx, move);
  });
  const along = carriedAlong(tx, op);
  const judged = judgedIn(tx, [...moves.map((m) => m.next), ...along.map((c) => c.next)]);
  for (const moved of moves) placeMoved(tx, moved, judged);
  placeCarried(tx, along, judged);
}

/** The refusal of "Doesn't count" on a resize's leg or a squeeze's in place, which is no move and counts no movement. */
export const RESHAPE_NOT_A_MOVE = "its last change was to its size or squeeze, not a move";

/**
 * "Doesn't count" (features section 4): the last leg of the active
 * creature's path this turn stops counting against its speed, or counts
 * again. A shove, Misty Step or a teleport moves a creature without using
 * its movement. Only the last leg, the move just made, since the button
 * sits beside the move's own undo.
 */
export function tokenCountLeg(tx: Tx, op: OpOf<"token.countLeg">): void {
  const token = tx.token(op.tokenId);
  const path = pathThisTurn(tx.state.encounter, token);
  const last = path?.stops[path.stops.length - 1];
  if (!path || !last || path.stops.length < 2) throw invalid("it has not moved this turn");
  // A resize's leg, or a squeeze's in place, never counts (docs/design-v1-token-window.md 8.7). Only paths from version 6 on hold one, so replay is unchanged.
  if (reshapeLeg(path.stops[path.stops.length - 2]!, last, stopFootprint(token))) throw invalid(RESHAPE_NOT_A_MOVE);
  if ((last.uncounted !== true) === op.counts) return;
  // A carried leg counted is the table's choice, and loses its mark, so no refusal says how the leg was made (7.2).
  const { uncounted: _uncounted, carried: _carried, ...counted } = last;
  const stops = [...path.stops.slice(0, -1), op.counts ? counted : { ...counted, uncounted: true as const }];
  tx.write(keys.token(token.id), { ...token, path: { turn: path.turn, stops } });
}

export function characterCreate(tx: Tx, op: OpOf<"character.create">): void {
  const input = op.character;
  if (tx.state.characters[input.id]) throw invalid("character already exists");
  if (input.actor.blockId !== undefined) throw invalid(BLOCK_OF_ITS_CHARACTER);
  if (input.actor.wildShape !== undefined && input.actor.srdId === undefined) throw invalid(WILD_SHAPE_ALONE);
  const character: Character = {
    id: input.id,
    rev: 0,
    ownerIds: input.ownerIds,
    name: input.name,
    size: input.size,
    actor: input.actor,
  };
  if (input.defaultImage !== undefined) character.defaultImage = input.defaultImage;
  if (input.level !== undefined) character.level = input.level;
  if (input.stats !== undefined) character.stats = input.stats;
  tx.write(keys.character(character.id), withPcActorNumbers(character));
}

export function characterUpdate(tx: Tx, op: OpOf<"character.update">): void {
  const character = tx.character(op.characterId);
  const p = op.patch;
  const next: Character = { ...character };
  if (p.name !== undefined) next.name = p.name;
  if (p.size !== undefined) next.size = p.size;
  if (p.ownerIds !== undefined) next.ownerIds = p.ownerIds;
  setOrDelete(next, "defaultImage", p.defaultImage);
  setOrDelete(next, "level", p.level);
  // The list replaces the old one whole, and an empty one is stored as none. No SRD data is read, so replay never depends on it (docs/design-v1-known-forms.md 3.2).
  if (p.knownForms !== undefined) setOrDelete(next, "knownForms", p.knownForms.length > 0 ? p.knownForms : null);
  if (p.stats === null) delete next.stats;
  else if (p.stats !== undefined) {
    next.stats = applyPcStatsPatch(character.stats ?? EMPTY_PC_STATS, p.stats);
    // The patch's own bound holds what it sends. What it keeps from the block may still take the whole past it.
    if (!pcStatsFits(next.stats)) throw new Refuse("quota", pcStatsTooBig(next.name));
  }
  if (syncsFromDdb(tx.env.opVersion)) syncRecord(next, p.ddbSync, p.stats === null, tx.env.at);
  // Written before the actor patch, which reads whether the character ends the op with a block.
  tx.write(keys.character(character.id), next);
  // Whoever plays the character plays its companions, on every scene (docs/design-v1-combat-flow.md 3.6.4).
  if (p.ownerIds !== undefined) syncOwners(tx, [character.id]);
  if (p.actor) {
    const resolved = tx.resolveActor({ characterId: character.id });
    const r = applyActorPatch(tx, resolved, p.actor);
    tx.putActor(resolved, r.actor);
    tx.addActorEvents(resolved, r.events);
  }
  // Initiative and Passive Perception follow the block after every edit, a level's included (docs/design-v1-pc-stats.md 3.5).
  const after = tx.character(character.id);
  const derived = withPcActorNumbers(after);
  if (derived !== after) tx.write(keys.character(character.id), derived);
}

/**
 * A character's D&D Beyond sync record as a patch leaves it
 * (docs/design-v1-resync.md 4): stored as sent, with a stamp as `at` when
 * the patch has none, which a sync's never has. Removing the block removes
 * the record too, since its base then describes no block. The record may
 * still name rolls the block no longer holds.
 *
 * An `at` the patch sends is an earlier server stamp, as Undo puts back.
 * One more than a day past the op's time is refused, so no stored record
 * is from the future, which an import would have to change. The op's time
 * is the envelope's, so replay decides the same.
 */
function syncRecord(next: Character, record: DdbSyncPatch | null | undefined, blockRemoved: boolean, at: string): void {
  if (blockRemoved || record === null) {
    delete next.ddbSync;
    return;
  }
  if (record === undefined) return;
  if (record.at !== undefined && syncAtAhead(record.at, Date.parse(at))) throw new Refuse("invalid", SYNC_AT_AHEAD);
  const stored: DdbSync = { ...record, at: record.at ?? syncStamp(at, next.ddbSync?.at) };
  if (serializedBytes(stored) > LIMITS.ddbSyncBytes) throw new Refuse("quota", `${next.name}'s sync record would be too large to save.`);
  next.ddbSync = stored;
}

/**
 * The `at` `syncRecord` wrote on a record that came without one, read from
 * the state the op left, for the op's answer. A re-sync's Undo expects
 * exactly that record, so its sender learns the `at` from the answer, never
 * from a view that may already hold another device's later sync
 * (docs/design-v1-resync.md 3.4).
 */
export function stampedAt(op: Op, after: RoomState): string | undefined {
  if (op.t !== "character.update" || !op.patch.ddbSync || op.patch.ddbSync.at !== undefined) return undefined;
  return after.characters[op.characterId]?.ddbSync?.at;
}

/**
 * Removes a character with every token that points at it, so no token is
 * left with a dangling actor, its companions, and the stat blocks it kept
 * for them (docs/design-v1-companion-stat-blocks.md 3.3).
 */
export function characterDelete(tx: Tx, op: OpOf<"character.delete">): void {
  const character = tx.character(op.characterId);
  const rowsBefore = tx.state.encounter?.entries.length ?? 0;
  let tokens = 0;
  let companions = 0;
  for (const token of sortedById(Object.values(tx.state.tokens))) {
    const companion = token.companion?.of === character.id;
    if (!companion && !("ref" in token.actor && token.actor.ref === character.id)) continue;
    deleteToken(tx, token.id);
    if (companion) companions++;
    else tokens++;
  }
  const entryIds = tx.state.encounter?.entries.filter((e) => e.characterId === character.id).map((e) => e.id) ?? [];
  if (entryIds.length > 0) removeEntries(tx, entryIds);
  deleteCharacterBlocks(tx, character.id);
  tx.remove(keys.character(character.id));
  // The DM learns that a player deleted one, and what went with it, in a line only the DM's log carries: the DM cannot undo it.
  if (tx.actor.role !== "dm") {
    const rows = rowsBefore - (tx.state.encounter?.entries.length ?? 0);
    tx.addEvent({ type: "characterDeleted", characterId: character.id, memberId: tx.actor.memberId, name: character.name, tokens, companions, rows });
  }
}

/** An area is drawn on its own scene, so the token it follows must stand there too. */
function checkAttachment(tx: Tx, sceneId: string, tokenId: string): void {
  if (tx.token(tokenId).sceneId !== sceneId) throw invalid("an attached area must be on its token's scene");
}

export function templateCreate(tx: Tx, op: OpOf<"template.create">): void {
  const input = op.template;
  if (tx.state.templates[input.id]) throw invalid("template already exists");
  tx.scene(input.sceneId);
  if (input.attachedTo !== undefined) checkAttachment(tx, input.sceneId, input.attachedTo);
  if (input.casterId !== undefined) tx.token(input.casterId);
  const template: AreaTemplate = { ...input, rev: 0 };
  tx.write(keys.template(template.id), template);
}

export function templateUpdate(tx: Tx, op: OpOf<"template.update">): void {
  const template = tx.state.templates[op.templateId];
  if (!template) throw gone("template");
  const p = op.patch;
  const next: AreaTemplate = { ...template };
  if (p.shape !== undefined) next.shape = p.shape;
  if (p.size !== undefined) next.size = p.size;
  if (p.origin !== undefined) next.origin = p.origin;
  if (p.yaw !== undefined) next.yaw = p.yaw;
  if (p.includeOrigin !== undefined) next.includeOrigin = p.includeOrigin;
  if (p.color !== undefined) next.color = p.color;
  if (p.visibility !== undefined) next.visibility = p.visibility;
  setOrDelete(next, "width", p.width);
  setOrDelete(next, "height", p.height);
  setOrDelete(next, "pitch", p.pitch);
  setOrDelete(next, "faceOffset", p.faceOffset);
  setOrDelete(next, "anchor", p.anchor);
  setOrDelete(next, "footprint", p.footprint);
  setOrDelete(next, "triggers", p.triggers);
  setOrDelete(next, "oncePerTurn", p.oncePerTurn);
  setOrDelete(next, "slows", p.slows);
  setOrDelete(next, "label", p.label);
  setOrDelete(next, "spell", p.spell);
  if (p.attachedTo !== undefined && p.attachedTo !== null) checkAttachment(tx, template.sceneId, p.attachedTo);
  if (p.casterId !== undefined && p.casterId !== null) tx.token(p.casterId);
  setOrDelete(next, "attachedTo", p.attachedTo);
  setOrDelete(next, "casterId", p.casterId);
  tx.write(keys.template(template.id), next);
}

export function templateDelete(tx: Tx, op: OpOf<"template.delete">): void {
  if (!tx.state.templates[op.templateId]) throw gone("template");
  tx.remove(keys.template(op.templateId));
}

export function drawingCreate(tx: Tx, op: OpOf<"drawing.create">): void {
  const input = op.drawing;
  if (tx.state.drawings[input.id]) throw invalid("drawing already exists");
  tx.scene(input.sceneId);
  if (input.kind === "ruler") {
    const stops = input.points.length / 2;
    if (!Number.isInteger(stops) || stops < 2 || stops > MAX_RULER_STOPS) throw invalid(`a kept ruler has 2 to ${MAX_RULER_STOPS} stops`);
    if (input.anchors !== undefined && input.anchors.length !== stops) throw invalid("a kept ruler names one token or none for each stop");
    if (input.z !== undefined) {
      if (input.z.length !== stops) throw invalid("a kept ruler names one ground height for each stop");
      // A stop on a token stands at the token's height, so a ground height there would measure from the wrong place.
      if (input.z.some((feet, i) => feet !== 0 && input.anchors?.[i] != null)) throw invalid("a kept ruler's stop on a token stands on no ground");
    }
  } else if (input.walk !== undefined) {
    throw invalid("only a kept ruler walks");
  } else if (input.anchors !== undefined) {
    throw invalid("only a kept ruler stands on tokens");
  } else if (input.z !== undefined) {
    throw invalid("only a kept ruler stands on the ground");
  }
  const drawing: Drawing = { ...input, rev: 0 };
  tx.write(keys.drawing(drawing.id), drawing);
}

export function drawingDelete(tx: Tx, op: OpOf<"drawing.delete">): void {
  if (!tx.state.drawings[op.drawingId]) throw gone("drawing");
  tx.remove(keys.drawing(op.drawingId));
}

export function drawingClear(tx: Tx, op: OpOf<"drawing.clear">): void {
  tx.scene(op.sceneId);
  for (const drawing of sortedById(Object.values(tx.state.drawings))) {
    if (drawing.sceneId !== op.sceneId) continue;
    if (op.scope === "own" && drawing.ownerId !== tx.actor.memberId) continue;
    tx.remove(keys.drawing(drawing.id));
  }
}

/** Map order is not stable across a jsonb round trip, so scans that touch entities go by id. */
export function sortedById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Nearest first and each once, so the rings and their labels never stack. */
function normalRings(rings: readonly number[]): number[] {
  return [...new Set(rings)].sort((a, b) => a - b);
}
