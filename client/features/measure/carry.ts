import type { Actor, FloorLink, RoomState, SceneId, Token } from "#shared/model.ts";
import { MAX_RULER_ENDS, MAX_RULER_STOPS, type EphEvent, type RulerPrior, type RulerPriorIn } from "#shared/protocol.ts";
import { sharedGround } from "#shared/project.ts";
import { ownEntry } from "#shared/records.ts";
import type { DiagonalCounter } from "#shared/rules/distance.ts";
import { climbKeepsSqueeze, linkDir, linkHeight, linksOn, standsOn, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { footprintSize, storedCenter, type CellRange } from "#shared/rules/footprint.ts";
import { zoneFogged } from "#shared/rules/traps.ts";
import { validEph } from "../../state/actions.ts";
import { groundSource, seenGround } from "../builder/heights/ground.ts";
import type { Point, RulerStop } from "./ruler.ts";
import { rulerWalker, type WalkInput, type WalkMeasure } from "./walkRuler.ts";

/*
 * The walking ruler over stairs (docs/design/design-v1-floors.md phase 3,
 * 4.1 and 4.2): when its row offers the stairs, what a press carries to the
 * far floor, and the frame a carried ruler sends. Plain functions, so node
 * --test runs them.
 */

/**
 * A ruler this device carried over stairs. `floor` is the floor it went
 * to, `landing` its first stop there, so a ruler started afresh elsewhere
 * under the same id is carried no more. `shared` holds while every crossing
 * was made shared, counting only ends and ground players see, so a DM's
 * ruler carried private stays private. `tokenId` is the walk's own walker,
 * kept on this device only, whose speeds the DM's private ruler walks on
 * with.
 */
export type Carry = { prior: RulerPriorIn; floor: SceneId; shared: boolean; tokenId: string | null; landing: RulerStop };

/** Where a known walk leaves its walker, with its 5-10-5 count and its feet so far, the prior's included. */
export type WalkEnd = { walker: Token; counter: DiagonalCounter; ft: number };

/** The stairs a ruler's walker stands on, which its row offers: the end, the floor it reaches, the way and the far floor's name. */
export type StairsOffer = { link: LinkEnd; to: SceneId; dir: "up" | "down"; kind: FloorLink["kind"]; floor: string };

/** Whether `carry` still describes `stops`: the ruler starts on the landing. */
export function stillCarried(carry: Carry | null, stops: readonly RulerStop[]): Carry | null {
  const first = stops[0];
  if (!carry || !first) return null;
  const at = carry.landing;
  return first.x === at.x && first.y === at.y && first.z === at.z && first.tokenId === undefined ? carry : null;
}

/**
 * Whether the DM's Shared is off: a ruler carried while private counted
 * every end and all the ground, so it stays private (D-261110-078). One
 * carried while shared counted only what players see, and may turn Shared
 * off and on again.
 */
export function shareLocked(carried: Carry | null, share: boolean): boolean {
  return carried !== null && !carried.shared && !share;
}

/**
 * The creatures a carried frame names (D-261110-115): every one a stop of
 * the ruler has sat on, on this floor and every floor before, and the walk's
 * own walker where it is a token, the mount for a rider. The server sends
 * the frame only to a receiver who sees all of them.
 */
export function rulerAnchors(carry: Carry | null, stops: readonly RulerStop[], walkerId: string | null): string[] {
  const out = new Set(carry?.prior.anchors ?? []);
  if (walkerId) out.add(walkerId);
  for (const s of stops) if (s.tokenId !== undefined) out.add(s.tokenId);
  return [...out];
}

/**
 * Whether players can see an end, as their copies receive it
 * (project.ts projectFloorLinkCtx): on a scene with fog, its squares are not
 * all under the fog every player shares, the ground a shared walk reads
 * (walkWorld.ts sharedGround).
 */
export function publicEnd(view: RoomState, link: Pick<LinkEnd, "sceneId" | "rect">): boolean {
  const scene = ownEntry(view.scenes, link.sceneId);
  if (!scene?.fogEnabled) return true;
  const ground = sharedGround(view, link.sceneId);
  const rangeFogged = (r: CellRange) => {
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (ground(x, y)) return false;
    return true;
  };
  return !zoneFogged(view, link.sceneId, { cells: [link.rect] }, rangeFogged, (sx, sy) => !ground.sub(sx, sy));
}

/**
 * The stairs a known walk's walker stands on, as Go up asks (`standsOn`
 * "on" alone, D-261110-184), that lead to a floor this device holds and are
 * not locked, or null. A shared ruler counts only ends players can see,
 * and the DM's private one every end. A ruler that has crossed
 * MAX_RULER_ENDS ends, or would name more than MAX_RULER_STOPS creatures,
 * takes no more.
 */
export function stairsOffer(input: {
  view: RoomState;
  held: readonly SceneId[];
  end: WalkEnd | null;
  shared: boolean;
  role: "dm" | "player";
  carry: Carry | null;
  anchors: readonly string[];
}): StairsOffer | null {
  const { view, end } = input;
  if (!end) return null;
  if ((input.carry?.prior.ends.length ?? 0) >= MAX_RULER_ENDS || input.anchors.length > MAX_RULER_STOPS) return null;
  const viewer = { memberId: "", role: input.role };
  for (const link of linksOn(view, end.walker.sceneId) as LinkEnd[]) {
    if (link.locked === true || link.to === undefined || !input.held.includes(link.to)) continue;
    if (standsOn(view, viewer, end.walker, link) !== "on") continue;
    if (input.shared && !publicEnd(view, link)) continue;
    const dir = linkDir(view, link);
    const floor = ownEntry(view.scenes, link.to)?.floor?.name;
    if (dir === null || floor === undefined) continue;
    return { link, to: link.to, dir, kind: link.kind, floor };
  }
  return null;
}

/** A creature's actor: its own, or its character's. */
export function actorOfToken(view: Pick<RoomState, "tokens" | "characters">, tokenId: string | null): Actor | undefined {
  const token = tokenId ? ownEntry(view.tokens, tokenId) : undefined;
  if (!token) return undefined;
  return "inline" in token.actor ? token.actor.inline : ownEntry(view.characters, token.actor.ref)?.actor;
}

/**
 * The climb's feet, as `climbCost` prices it without crawling, since a
 * ruler leaves crawling out: stairs the climb's height, a ladder twice
 * that. A Climb Speed halves a ladder only on the DM's private ruler, read
 * from the walker's actor, which there is the real creature's
 * (D-261110-082): a shared ruler would tell players a speed only owners
 * receive. The height is `linkHeight`, which on a player's copy reads the
 * end's `rise`.
 */
export function climbFeet(view: Pick<RoomState, "scenes" | "characters">, walker: Token, link: Pick<FloorLink, "sceneId" | "to" | "kind">, privateRuler: boolean): number {
  const height = linkHeight(view, link);
  const actor = "inline" in walker.actor ? walker.actor.inline : ownEntry(view.characters, walker.actor.ref)?.actor;
  const climbs = privateRuler && (actor?.speeds.climb ?? 0) > 0;
  return link.kind === "ladder" && !climbs ? height * 2 : height;
}

/**
 * The walker's shape on the landing: its size, a custom walker's sides, and
 * whether it lands squeezed, as a climb lands it (climbKeepsSqueeze).
 */
export function landedShape(view: Pick<RoomState, "scenes">, walker: Token, link: Pick<FloorLink, "sceneId" | "rect">): RulerPrior["walker"] {
  const sides = walker.size === "custom" ? footprintSize(walker) : null;
  return {
    size: walker.size,
    ...(sides ? { w: sides.w, h: sides.h } : {}),
    ...(climbKeepsSqueeze(view, walker, link) ? { squeeze: true as const } : {}),
  };
}

const COUNT_MAX = 100_000;
/** To the half, as the schema takes it: a Tiny walker's feet and diagonals come in halves (review FL3-ASTRA-01). */
const count = (n: number) => Math.min(COUNT_MAX, Math.max(0, Math.round(n * 2) / 2));

/**
 * What a press of the stairs button carries: the next carry, with its
 * prior (the feet so far and the climb, the count, the landed shape, the
 * creatures and the ends crossed, this one last), and the landing stop,
 * free, at the walker's middle on the same squares, standing on the ground
 * this device reads there (`ground`).
 */
export function carryOver(input: {
  view: Pick<RoomState, "scenes" | "characters">;
  offer: StairsOffer;
  end: WalkEnd;
  privateRuler: boolean;
  shared: boolean;
  carry: Carry | null;
  anchors: readonly string[];
  tokenId: string | null;
  ground: (cell: Point) => number;
}): { carry: Carry; stop: RulerStop } {
  const { end, offer } = input;
  const prior: RulerPriorIn = {
    // The end whole, so a player's copy prices it by its `rise`.
    ft: count(end.ft + climbFeet(input.view, end.walker, { ...offer.link, to: offer.to }, input.privateRuler)),
    diag: { h: count(end.counter.h), v: count(end.counter.v) },
    walker: landedShape(input.view, end.walker, offer.link),
    anchors: [...input.anchors],
    ends: [...(input.carry?.prior.ends ?? []), offer.link.id],
  };
  const mid = storedCenter(end.walker);
  const z = input.ground({ x: Math.floor(mid.x), y: Math.floor(mid.y) });
  const stop: RulerStop = z === 0 ? { x: mid.x, y: mid.y } : { x: mid.x, y: mid.y, z };
  return {
    carry: { prior, floor: offer.to, shared: (input.carry?.shared ?? true) && input.shared, tokenId: input.carry ? input.carry.tokenId : input.tokenId, landing: stop },
    stop,
  };
}

/** A ruler's frame, carrying its prior while carried: a carried ruler always walks. */
export function rulerFrame(id: string, points: RulerStop[], shared: boolean, walk: boolean, carry: Carry | null): Extract<EphEvent, { k: "ruler" }> {
  return { k: "ruler", id, points, shared, ...(walk || carry ? { walk: true as const } : {}), ...(carry ? { prior: carry.prior } : {}) };
}

/**
 * Whether the server would take a frame (actions.ts validEph): a carried
 * frame grows by every creature and end it names, and past MAX_EPH_BYTES
 * the server drops it without a word, so the device measures it first.
 */
export function frameFits(e: EphEvent): boolean {
  return validEph(e);
}

const outbound = new WeakMap<RulerPriorIn, RulerPrior>();

/** A carry's prior as receivers get it, without the creatures and ends, kept per prior so the walks keyed by it hold. */
export function priorOut(prior: RulerPriorIn): RulerPrior {
  let out = outbound.get(prior);
  if (!out) {
    const { anchors: _anchors, ends: _ends, ...rest } = prior;
    outbound.set(prior, (out = rest));
  }
  return out;
}

/**
 * Where a ruler's walk leaves its walker for the stairs button, once the
 * walk is known and no leg of it finds no way, or its walker at its one
 * stop: null while it searches or where a leg has no way through.
 */
export function walkEndOf(walked: WalkMeasure | null, oneStop: Token | null): WalkEnd | null {
  if (walked) return walked.searching || walked.legs.some((l) => l.none) ? null : { walker: walked.end.walker, counter: walked.end.counter, ft: walked.totalFt };
  return oneStop ? { walker: oneStop, counter: { h: 0, v: 0 }, ft: 0 } : null;
}

/** What the stairs button offers and what a press carries. */
export type Stairs = { offer: StairsOffer; plan: { carry: Carry; stop: RulerStop } };

/**
 * The stairs button's offer and its press for a ruler (4.1), or null where
 * the row shows none. `walkInput` is the ruler's walk on the floor shown,
 * `walked` its measure (null for one stop without a prior), and `whole` this
 * device's whole view, which holds the far floor's ground. A press must fit
 * the server's frame cap from the landing, or the button hides.
 */
export function stairsPlan(input: {
  role: "dm" | "player";
  share: boolean;
  rulerId: string;
  walkInput: WalkInput;
  walked: WalkMeasure | null;
  carried: Carry | null;
  held: readonly SceneId[];
  whole: Pick<RoomState, "scenes" | "buildChunks" | "fogTiles">;
}): Stairs | null {
  const { role, walkInput, carried } = input;
  const stops = walkInput.stops;
  const lead = rulerWalker(walkInput);
  const end = walkEndOf(input.walked, input.walked === null && stops.length === 1 ? lead : null);
  if (!end) return null;
  // A carried ruler's walker is a fresh creature, and the real one stays the carry's.
  const walkerId = lead && lead.id !== "" ? lead.id : null;
  const anchors = rulerAnchors(carried, stops, walkerId);
  const shared = role === "player" || input.share;
  const offer = stairsOffer({ view: walkInput.view, held: input.held, end, shared, role, carry: carried, anchors });
  const far = offer ? ownEntry(input.whole.scenes, offer.to) : undefined;
  if (!offer || !far) return null;
  const src = groundSource(input.whole, far, role);
  const plan = carryOver({ view: walkInput.view, offer, end, privateRuler: !shared, shared, carry: carried, anchors, tokenId: walkerId, ground: (cell) => seenGround(src, cell) ?? 0 });
  return frameFits(rulerFrame(input.rulerId, [plan.stop], shared, true, plan.carry)) ? { offer, plan } : null;
}
