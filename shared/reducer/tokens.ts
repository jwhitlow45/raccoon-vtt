import { keys } from "../keys.ts";
import { healRevivesDead } from "../migrate.ts";
import type { Actor, AreaTemplate, Character, Drawing, PathStop, RoomState, Token, TokenPath, TurnStart } from "../model.ts";
import { inSightOfNonOwners } from "../project.ts";
import { MAX_RULER_STOPS, type ActorPatch, type OpOf } from "../protocol.ts";
import { applyHpSet, type ActorEvent } from "../rules/hp.ts";
import { pathThisTurn, sameSpot, turnUnderWay, withStop } from "../rules/path.ts";
import { removeEntries } from "./encounter.ts";
import { gone, invalid, type Env, type ResolvedActor, type Tx } from "./tx.ts";

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
  const siblings = Object.values(tx.state.tokens)
    .filter((t) => t.id !== token.id && t.sceneId === token.sceneId && t.name === token.name && t.kind !== "pc")
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
  const number = input.number ?? autoNumber(tx, token);
  if (number !== undefined) token.number = number;
  tx.write(keys.token(token.id), token);
}

/** Applies the shared actor patch. HP edits go through the rules so life states follow. */
export function applyActorPatch(tx: Tx, resolved: ResolvedActor, patch: ActorPatch): { actor: Actor; events: ActorEvent[] } {
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
  setOrDelete(actor, "sheetUrl", patch.sheetUrl);
  setOrDelete(actor, "legendary", patch.legendary);
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
  tx.write(keys.token(token.id), withPath(tx, token, next, judgedIn(tx, [next])));
  if (next.sceneId !== token.sceneId) {
    // An attached area follows its token, to another scene too, rather than staying behind at a stale origin.
    for (const template of sortedById(Object.values(tx.state.templates))) {
      if (template.attachedTo === token.id) tx.write(keys.template(template.id), { ...template, sceneId: next.sceneId });
    }
  }
  if (p.actor) {
    const resolved = tx.resolveActor({ tokenId: token.id });
    const r = applyActorPatch(tx, resolved, p.actor);
    tx.putActor(resolved, r.actor);
    tx.addActorEvents(resolved, r.events);
  }
}

/** Removes a token with what hangs off it: attached templates, caster references and its initiative rows. */
export function deleteToken(tx: Tx, tokenId: string): void {
  const token = tx.token(tokenId);
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
type Judged = { before: RoomState; after: () => RoomState };

function judgedIn(tx: Tx, tokens: readonly Token[]): Judged {
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
  tx.write(keys.token(token.id), withPath(tx, token, next, judged, move.teleport !== undefined));
  if (move.teleport !== undefined) tx.addEvent({ type: "teleport", tokenId: token.id, past: move.teleport });
}

/**
 * The token after a move, with the move on its path when it is the active
 * creature's on its own turn (features section 4), whoever moved it. The
 * turn passing writes no token, so the first move of a turn finds no path
 * of this turn and starts one where the turn began. A move outside its
 * turn, or to another scene, drops the path, which counts as empty by then
 * anyway. A change of facing alone is not movement and leaves it be.
 */
function withPath(tx: Tx, before: Token, after: Token, judged: Judged, uncounted = false): Token {
  if (after.sceneId !== before.sceneId) return withoutPath(after);
  if (sameSpot(before, after)) return after;
  const encounter = tx.state.encounter;
  const turn = turnUnderWay(encounter);
  if (!turn) {
    // A player's copy lacks the start of a turn they could not see begin (design 7.3), so their device cannot tell this
    // turn's path from an earlier one's. It leaves the active creature's path for the server's answer.
    const active = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
    return active?.tokenId === after.id ? after : withoutPath(after);
  }
  if (turn.tokenId !== after.id) return withoutPath(after);
  let path: TokenPath = before.path?.turn === turn.seq ? before.path : { turn: turn.seq, stops: turn.sceneId === before.sceneId ? [startStop(turn)] : [] };
  // Every move of the creature this turn is a leg, so the last stop is where it stood. The check keeps a stop from being skipped if not.
  const last = path.stops[path.stops.length - 1];
  if (!last || !sameSpot(last, before)) path = withStop(path, stopAt(judged.before, before, tx.env));
  // Where it stops is judged as the finished move will be: with it and every token moving with it there, their lights too.
  const stop = stopAt(judged.after(), after, tx.env);
  return { ...after, path: withStop(path, uncounted ? { ...stop, uncounted: true } : stop) };
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

export function tokenMove(tx: Tx, op: OpOf<"token.move">): void {
  const moved = movedToken(tx, op);
  placeMoved(tx, moved, judgedIn(tx, [moved.next]));
}

/** Every token is placed first, so each stop is judged with the whole group where it stood or where it ends. */
export function tokenMoveMany(tx: Tx, op: OpOf<"token.moveMany">): void {
  const seen = new Set<string>();
  const moves = op.moves.map((move) => {
    if (seen.has(move.tokenId)) throw invalid("a token appears twice");
    seen.add(move.tokenId);
    return movedToken(tx, move);
  });
  const judged = judgedIn(tx, moves.map((m) => m.next));
  for (const moved of moves) placeMoved(tx, moved, judged);
}

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
  if ((last.uncounted !== true) === op.counts) return;
  const { uncounted: _uncounted, ...counted } = last;
  const stops = [...path.stops.slice(0, -1), op.counts ? counted : { ...counted, uncounted: true as const }];
  tx.write(keys.token(token.id), { ...token, path: { turn: path.turn, stops } });
}

export function characterCreate(tx: Tx, op: OpOf<"character.create">): void {
  const input = op.character;
  if (tx.state.characters[input.id]) throw invalid("character already exists");
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
  tx.write(keys.character(character.id), character);
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
  tx.write(keys.character(character.id), next);
  if (p.actor) {
    const resolved = tx.resolveActor({ characterId: character.id });
    const r = applyActorPatch(tx, resolved, p.actor);
    tx.putActor(resolved, r.actor);
    tx.addActorEvents(resolved, r.events);
  }
}

/** Removes a character and every token that points at it, so no token is left with a dangling actor. */
export function characterDelete(tx: Tx, op: OpOf<"character.delete">): void {
  const character = tx.character(op.characterId);
  for (const token of sortedById(Object.values(tx.state.tokens))) {
    if ("ref" in token.actor && token.actor.ref === character.id) deleteToken(tx, token.id);
  }
  const entryIds = tx.state.encounter?.entries.filter((e) => e.characterId === character.id).map((e) => e.id) ?? [];
  if (entryIds.length > 0) removeEntries(tx, entryIds);
  tx.remove(keys.character(character.id));
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
