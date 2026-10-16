import { SIZE_CELLS, type Actor, type BuildChunk, type Character, type CompanionBlock, type CreatureSize, type ImageRef, type Token, type TokenKind } from "#shared/model.ts";
import type { CharacterInput, TokenInput } from "#shared/protocol.ts";
import { monsterActor, type StatBlockMonster } from "#shared/srd/monsters.ts";
import { footprint } from "../../lib/scene.ts";
import { landedElevation } from "../movement/drop.ts";

/**
 * Builds the `token.create` and `character.create` inputs for every way the
 * DM adds a creature (features sections 5 and 15): a blank token, a
 * character's token, monsters from the browser (SRD or the room's own),
 * and a duplicate. Each returns exactly the strict protocol shape, so a
 * view-only field (a rev, the projection's `aboveFog`) can never make the
 * op invalid.
 *
 * Numbers for duplicates ("Goblin 2") are left to the reducer, which counts
 * every sibling on the scene (shared/reducer/tokens.ts).
 */

export type Point = { x: number; y: number };
export type Bounds = { w: number; h: number };
type Footprint = { w: number; h: number };

export function blankActor(patch: Partial<Actor> = {}): Actor {
  return {
    hp: { cur: 10, max: 10, temp: 0 },
    life: "alive",
    ac: 10,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
    ...patch,
  };
}

const BLANK_NAMES: Record<TokenKind, string> = { pc: "Hero", npc: "NPC", monster: "Monster", object: "Object" };

export function blankToken(input: { id: string; sceneId: string; kind: TokenKind; at: Point }): TokenInput {
  return {
    id: input.id,
    sceneId: input.sceneId,
    kind: input.kind,
    name: BLANK_NAMES[input.kind],
    size: "medium",
    x: input.at.x,
    y: input.at.y,
    hpVisibility: input.kind === "object" ? "hidden" : input.kind === "pc" ? "exact" : "label",
    actor: { inline: blankActor() },
  };
}

export type MonsterDrop = {
  /** The DM's typed HP, or null for the stat block's average. */
  hp: number | null;
  hidden: boolean;
  inLair: boolean;
};

/**
 * A token for one monster, SRD or the room's own: average or typed HP, its
 * stats, hostile, hidden when the DM asks, and the monster's default image
 * when the DM set one (client/features/monsters/images.ts).
 *
 * `monsterId` links a room monster's token to the stat block it came from,
 * as an SRD monster's keeps its `srdId`, so the DM reads the full block on
 * the token (docs/design-v1-dm-tools.md 3.6).
 */
export function monsterToken(
  m: StatBlockMonster,
  drop: MonsterDrop,
  input: { id: string; sceneId: string; at: Point; image?: ImageRef; monsterId?: string },
): TokenInput {
  const hp = drop.hp === null ? undefined : Math.max(1, Math.min(100_000, Math.floor(drop.hp)));
  const actor = monsterActor(m, { ...(hp !== undefined ? { hp } : {}), inLair: drop.inLair });
  if (input.monsterId !== undefined) actor.monsterId = input.monsterId;
  const token: TokenInput = {
    id: input.id,
    sceneId: input.sceneId,
    kind: "monster",
    name: m.name,
    size: m.size,
    x: input.at.x,
    y: input.at.y,
    disposition: "hostile",
    visibility: drop.hidden ? "dm" : "all",
    hpVisibility: "label",
    actor: { inline: actor },
  };
  if (input.image) token.image = copyImage(input.image);
  return token;
}

/** Whether the stat block has different numbers in its lair, so the drop form offers the toggle. */
export function hasLairValues(m: StatBlockMonster): boolean {
  return m.xpInLair !== undefined || m.legendaryActions?.usesInLair !== undefined || m.legendaryResistance?.usesInLair !== undefined;
}

/** A token that points at a character, so HP and conditions follow the PC across scenes (design section 6). */
export function characterToken(c: Pick<Character, "id" | "name" | "size" | "defaultImage">, input: { id: string; sceneId: string; at: Point }): TokenInput {
  const token: TokenInput = {
    id: input.id,
    sceneId: input.sceneId,
    kind: "pc",
    name: c.name,
    size: c.size,
    x: input.at.x,
    y: input.at.y,
    disposition: "ally",
    hpVisibility: "exact",
    actor: { ref: c.id },
  };
  if (c.defaultImage) token.image = c.defaultImage;
  return token;
}

export function newCharacter(input: {
  id: string;
  name: string;
  ownerIds: string[];
  size: CreatureSize;
  hpMax: number;
  ac: number;
  walk: number;
  initBonus: number;
  passivePerception: number;
  defaultImage?: Character["defaultImage"];
}): CharacterInput {
  const hp = Math.max(0, Math.min(100_000, Math.floor(input.hpMax)));
  const character: CharacterInput = {
    id: input.id,
    name: input.name,
    size: input.size,
    ownerIds: input.ownerIds,
    actor: blankActor({
      hp: { cur: hp, max: hp, temp: 0 },
      ac: input.ac,
      speeds: { walk: input.walk },
      initBonus: input.initBonus,
      passivePerception: input.passivePerception,
    }),
  };
  if (input.defaultImage) character.defaultImage = input.defaultImage;
  return character;
}

/**
 * A copy of a token, as a fresh creature: full HP, no effects, no death
 * saves, legendary uses refilled. Duplicating is how the DM adds another of
 * the same monster, not a way to clone a wounded one. A PC's copy points at
 * the same character, so it shares that character's HP. The reducer numbers
 * the copy.
 *
 * The copy lands where it goes as its original would if dropped there
 * (movement/drop.ts landedElevation): a copy of a creature on the ground
 * stands on the ground there, the floor or a platform, a flier's copy flies
 * at its height or the ground there, whichever is higher, and a burrower's
 * keeps its depth.
 */
export function duplicateToken(
  source: Token,
  input: { id: string; at: Point; chunks: Readonly<Record<string, BuildChunk>>; blocks?: Readonly<Record<string, CompanionBlock | undefined>> },
): TokenInput {
  const copy: TokenInput = {
    id: input.id,
    sceneId: source.sceneId,
    kind: source.kind,
    name: source.name,
    nameHidden: source.nameHidden ?? false,
    size: source.size,
    x: input.at.x,
    y: input.at.y,
    elevation: landedElevation(input.chunks, source, input.at),
    rotation: source.rotation ?? 0,
    disposition: source.disposition,
    visibility: source.visibility ?? "all",
    fogExempt: source.fogExempt ?? false,
    locked: source.locked ?? false,
    layer: source.layer,
    ownerIds: [...(source.ownerIds ?? [])],
    hpVisibility: source.hpVisibility ?? "label",
    actor: "ref" in source.actor ? { ref: source.actor.ref } : { inline: freshActor(source.actor.inline, input.blocks) },
  };
  if (source.publicName !== undefined) copy.publicName = source.publicName;
  if (source.image) copy.image = copyImage(source.image);
  if (source.w !== undefined) copy.w = source.w;
  if (source.h !== undefined) copy.h = source.h;
  if (source.height !== undefined) copy.height = source.height;
  if (source.notes !== undefined) copy.notes = source.notes;
  if (source.altImages) copy.altImages = source.altImages.map(copyImage);
  if (source.rangeRings) copy.rangeRings = [...source.rangeRings];
  // Built field by field: a spent Reaction is the source's own, and the strict schema takes no stored field
  // (docs/design-v1-combat-flow.md 4.2). The reducer gives the copy its character's owners and no number.
  if (source.companion) copy.companion = { of: source.companion.of, turn: source.companion.turn };
  return copy;
}

function freshActor(actor: Actor, blocks: Readonly<Record<string, CompanionBlock | undefined>> | undefined): Actor {
  const next: Actor = {
    ...actor,
    hp: { cur: actor.hp.max, max: actor.hp.max, temp: 0 },
    life: "alive",
    speeds: { ...actor.speeds },
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
  };
  if (actor.legendary) next.legendary = { ...actor.legendary, actionsUsed: 0, resistUsed: 0 };
  // A new link must name a block that is there (docs/design-v1-companion-stat-blocks.md 3.2), so a copy of a companion
  // whose block was deleted starts with none rather than being refused.
  if (next.blockId !== undefined && blocks !== undefined && blocks[next.blockId] === undefined) delete next.blockId;
  return next;
}

export function sizeFootprint(size: CreatureSize, custom?: Footprint): Footprint {
  if (size === "custom") return footprint({ size, w: custom?.w, h: custom?.h });
  const side = SIZE_CELLS[size];
  return { w: side, h: side };
}

function snapStep(fp: Footprint): number {
  return Math.min(fp.w, fp.h) < 1 ? 0.5 : 1;
}

/** The top-left corner that centers a footprint on a tapped point, snapped as a drag would be. */
export function cornerFor(center: Point, fp: Footprint): Point {
  const step = snapStep(fp);
  return { x: Math.round((center.x - fp.w / 2) / step) * step, y: Math.round((center.y - fp.h / 2) / step) * step };
}

type Placed = { x: number; y: number; w: number; h: number };

function overlaps(a: Placed, b: Placed): boolean {
  const eps = 1e-6;
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}

function inside(p: Placed, bounds: Bounds): boolean {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= bounds.w && p.y + p.h <= bounds.h;
}

/**
 * Where to put `count` creatures of one footprint around a tapped point: the
 * nearest free spots on the grid, ring by ring, never on top of each other
 * or of tokens already there, and inside the scene. When there is no room
 * nearby, the rest stack on the tapped spot rather than fail.
 */
export function spreadPositions(input: {
  center: Point;
  footprint: Footprint;
  count: number;
  bounds: Bounds;
  occupied: Placed[];
}): Point[] {
  const out = freeSpots(input);
  const start = clampCorner(cornerFor(input.center, input.footprint), input.footprint, input.bounds);
  while (out.length < input.count) out.push(start);
  return out;
}

/**
 * The nearest free spot around a point that `accept` also takes, or null
 * when none does: a companion's place beside its character
 * (docs/design-v1-combat-flow.md 3.6.3), which must not stack anywhere.
 */
export function firstFreeSpot(input: { center: Point; footprint: Footprint; bounds: Bounds; occupied: Placed[]; accept(p: Point): boolean }): Point | null {
  return freeSpots({ ...input, count: 1 })[0] ?? null;
}

/** Up to `count` free spots, ring by ring from the tapped point, each one `accept` takes. */
function freeSpots(input: { center: Point; footprint: Footprint; count: number; bounds: Bounds; occupied: Placed[]; accept?(p: Point): boolean }): Point[] {
  const { footprint: fp, bounds } = input;
  const step = Math.max(snapStep(fp), Math.max(fp.w, fp.h) >= 1 ? 1 : 0.5);
  const start = clampCorner(cornerFor(input.center, fp), fp, bounds);
  const taken: Placed[] = [...input.occupied];
  const out: Point[] = [];
  // Forty rings is a 400 ft search, far past anywhere the DM meant to drop a creature.
  const maxRing = Math.min(40, Math.ceil(Math.max(bounds.w, bounds.h) / step) + 1);
  for (let ring = 0; ring <= maxRing && out.length < input.count; ring++) {
    for (const p of ringCells(start, ring, step)) {
      if (out.length >= input.count) break;
      const box = { x: p.x, y: p.y, w: fp.w, h: fp.h };
      if (!inside(box, bounds) || taken.some((t) => overlaps(t, box))) continue;
      if (input.accept && !input.accept(p)) continue;
      taken.push(box);
      out.push(p);
    }
  }
  return out;
}

function clampCorner(p: Point, fp: Footprint, bounds: Bounds): Point {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, bounds.w - fp.w)),
    y: Math.min(Math.max(0, p.y), Math.max(0, bounds.h - fp.h)),
  };
}

/** The cells on the square ring at Chebyshev distance `ring`, starting east of center and going clockwise. */
function* ringCells(center: Point, ring: number, step: number): Generator<Point> {
  if (ring === 0) {
    yield center;
    return;
  }
  const d = ring * step;
  for (let i = -ring + 1; i <= ring; i++) yield { x: center.x + d, y: center.y + i * step };
  for (let i = ring - 1; i >= -ring; i--) yield { x: center.x + i * step, y: center.y + d };
  for (let i = ring - 1; i >= -ring; i--) yield { x: center.x - d, y: center.y + i * step };
  for (let i = -ring + 1; i <= ring; i++) yield { x: center.x + i * step, y: center.y - d };
}

/** The boxes of the tokens already on a scene, for `spreadPositions`. */
export function occupiedBoxes(tokens: Iterable<Pick<Token, "sceneId" | "x" | "y" | "size" | "w" | "h">>, sceneId: string): Placed[] {
  const boxes: Placed[] = [];
  for (const t of tokens) {
    if (t.sceneId !== sceneId) continue;
    const fp = footprint(t);
    boxes.push({ x: t.x, y: t.y, w: fp.w, h: fp.h });
  }
  return boxes;
}

/** A copy of an image a new token can wear, so no two tokens share one crop object. */
function copyImage(image: ImageRef): ImageRef {
  return "icon" in image ? { icon: image.icon, color: image.color } : { assetId: image.assetId, crop: { ...image.crop } };
}
