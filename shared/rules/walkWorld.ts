import type { AreaSlows, AreaTemplate, BuildChunk, Effect, PathStop, RoomState, Token } from "../model.ts";
import { inSightOfNonOwners, isPartyMember, perPlayerScene, playersSeeGround, projectChunkForPlayer, sharedGround, withheldWhereItStands } from "../project.ts";
import { computeCoverage, creaturesInArea, type AreaContext, type AreaToken } from "./aoe.ts";
import { carriedGroup, dragExtra, onHolder, publicMembers } from "./attach.ts";
import type { DiagonalCounter, DistanceSettings } from "./distance.ts";
import { footprintRect, sizeCategory, sizeSteps, verticalExtentFt } from "./footprint.ts";
import { INCAPACITATING_KEYS } from "./hp.ts";
import { publicCounters } from "./path.ts";
import type { Walker } from "./movement.ts";
import { followerTrace } from "./route.ts";
import type { WalkArea, WalkCreature, WalkInput } from "./walk.ts";
import { sceneWalls } from "./walls.ts";
import { SQUARES } from "./grid.ts";

/**
 * The public world a route is searched in (docs/design-v1-movement.md 5.5):
 * what every player can observe, built the same from the DM's whole state
 * as from a player's copy, so a hidden monster, an unfound door or a
 * DM-only area never bends a route, on any device. The search itself is
 * walk.ts's. This only chooses its inputs.
 *
 * Ground: squares players have seen, not fully under the fog they get, on a
 * player's device and for a party member's drag on the DM's. Any other DM
 * drag reads all the ground, fog ignored. Creatures: those players see
 * where they stand, as their copy shows them. Areas: as a player who owns
 * none of them receives them. Prone: only where players receive it.
 * Speeds: none (the band reads them, never the route).
 */

export type WalkViewer = { role: "dm" | "player" };

/** A creature's space as the drag's label names it: "Ends in Goblin 2's space". */
export type WalkSpace = { id: string; x0: number; y0: number; x1: number; y1: number; lo: number; hi: number };

export type PublicWorld = {
  input: WalkInput;
  /** The creatures in the input, by token, in the same order: the label reads whose space a walk ends in. */
  spaces: WalkSpace[];
} & SpeedAreas;

/** Half Speed areas that affect the mover (4.2), for the band, read where the mover stands at each spot, and what they are judged against: the scene, its walls and the tokens players see. */
export type SpeedAreas = { halfSpeed: AreaTemplate[]; areaCtx: AreaContext };

export type WorldOptions = {
  /** A walking ruler leaves out other creatures' spaces, since they will move before anyone walks there (3.3). */
  creatures?: boolean;
  /**
   * The DM's own ruler, before it is shared, may use everything the DM
   * knows: all the ground, every area and every creature where it stands.
   * Every drag and every shared ruler keeps to the public world.
   */
  everything?: boolean;
  /**
   * Keep to ground players have seen whatever walks. A shared or kept
   * walking ruler reads the same on every device, so even on the DM's it
   * keeps to that ground, for a monster or for nobody in particular, where a
   * DM's drag of a monster reads the DM's own map.
   */
  seenGround?: boolean;
  /**
   * Keep to the ground every player shares (docs/design-v1-per-player-vision.md
   * 6.6): a shared or kept walking ruler reads the same on every device, so
   * on a per-player scene it never reads one player's own memory, which a
   * player's copy holds as its fog. Elsewhere it is the ground players see.
   */
  sharedGround?: boolean;
  /**
   * The tokens a walking ruler's earlier legs moved, on the room it
   * simulates them in: players see each where it now stands, by the rule
   * the server judges every player's sight by (project.ts
   * inSightOfNonOwners), even on a player's copy, which still holds it
   * there (reviews AT-SOL-5 and AT-SOL-6).
   */
  moved?: ReadonlySet<string>;
  /**
   * The tokens players did not see where a shared walking ruler starts: no
   * leg of it sees them, wherever its legs leave them, since a player's
   * copy never held them (review AT-SOL-6).
   */
  unseen?: ReadonlySet<string>;
};

/**
 * Whether players see a token where it stands, as the projection judges it:
 * not hidden by the DM, and on the DM's state neither behind the DM's
 * blackout nor withheld by fog or sight, as the server's seen marks judge it
 * (project.ts inSightOfNonOwners, review AT-O-24). A player's copy of a
 * whole-party scene holds only such tokens. On a per-player scene it holds
 * creatures only that player sees too, so there every device judges by
 * what every viewer shares (docs/design-v1-per-player-vision.md decision
 * 10): the shared sight with vision on, the shared fog with fog alone, and
 * every token with both off. A copy holds no owners of another's token, so
 * there a party member reads as one by the projection's `aboveFog`, as in
 * seenWhereMoved.
 */
export function publicToken(state: RoomState, token: Token, viewer: WalkViewer): boolean {
  if (token.visibility === "dm") return false;
  if (viewer.role === "player" && !perPlayerScene(state.scenes[token.sceneId])) return true;
  const above = viewer.role === "player" && (token as Token & { aboveFog?: boolean }).aboveFog === true;
  return state.meta.view?.blackout !== true && !withheldWhereItStands(state, above ? { ...token, fogExempt: true } : token);
}

function actorOf(state: RoomState, token: Token) {
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

/** The conditions players receive on a token: none the DM hid. A player's copy has dropped those already. */
function publicKeys(state: RoomState, token: Token): Set<Effect["key"]> {
  return new Set((actorOf(state, token)?.effects ?? []).filter((e) => e.hiddenFromPlayers !== true).map((e) => e.key));
}

/**
 * How another creature stands in the mover's way (4.3): an ally's space or
 * a Tiny creature's costs nothing, any other creature's is difficult
 * terrain, and the mover cannot pass one that is neither Incapacitated nor
 * two sizes from it. With moves not stopped on the scene nothing is in the
 * way, and such a space only costs.
 */
export function creatureWay(mover: Token, other: Token, keys: ReadonlySet<Effect["key"]>, blocks: boolean): WalkCreature["way"] {
  if (sizeCategory(other) === "tiny" || other.disposition === mover.disposition) return "free";
  if (!blocks) return "difficult";
  const incapacitated = [...keys].some((k) => INCAPACITATING_KEYS.has(k));
  return incapacitated || sizeSteps(mover, other) >= 2 ? "difficult" : "blocked";
}

/** Whether an area that slows only the caster's enemies slows this mover: not the caster, not of its disposition. Without a caster players see, it slows everyone. */
function slowsMover(slows: AreaSlows, caster: Token | undefined, mover: Token): boolean {
  if (!slows.foes || !caster) return true;
  return caster.id !== mover.id && caster.disposition !== mover.disposition;
}

/**
 * The areas on the scene as a player who owns none of them receives them
 * (shared/project.ts projectTemplateCtx): not DM-only, not on a token
 * players cannot see, another's only where players see others' areas or a
 * DM placed it, and without a caster players cannot see.
 */
function publicAreas(state: RoomState, sceneId: string, seen: (id: string) => Token | undefined, everything = false): { template: AreaTemplate; caster: Token | undefined }[] {
  const out: { template: AreaTemplate; caster: Token | undefined }[] = [];
  for (const t of Object.values(state.templates)) {
    if (!t || t.sceneId !== sceneId) continue;
    if (everything) {
      out.push({ template: t, caster: t.casterId ? seen(t.casterId) : undefined });
      continue;
    }
    if (t.visibility === "dm") continue;
    if (t.attachedTo !== undefined && !seen(t.attachedTo)) continue;
    if (!state.meta.settings.playersSeeAoeOfOthers && state.members[t.ownerId]?.kind !== "dm") continue;
    out.push({ template: t, caster: t.casterId ? seen(t.casterId) : undefined });
  }
  return out.sort((a, b) => (a.template.id < b.template.id ? -1 : a.template.id > b.template.id ? 1 : 0));
}

/**
 * The public world for a walk by `token` on its scene, as this device sees
 * it. `stops` are the creature's earlier stops this turn as this viewer
 * holds them, for the public counters, or none outside a turn.
 */
export function publicWorld(state: RoomState, token: Token & Walker, viewer: WalkViewer, stops: readonly PathStop[] = [], opts: WorldOptions = {}): PublicWorld {
  const scene = state.scenes[token.sceneId];
  const rules: DistanceSettings = { feetPerCell: state.meta.settings.feetPerCell, diagonal: state.meta.settings.diagonal };
  const blocks = scene?.blockMovement === true;
  const everything = opts.everything === true && viewer.role === "dm";
  const shown = shownTokens(state, token, viewer, everything, opts);
  // The DM's own ruler reads every area, so it judges every link seen too: an area that rides with the mover then costs it nothing, as on the DM's drag and in the store (review AT-O-37).
  const rigid = rigidWith(state, token, everything ? () => true : shownBy(state, viewer, opts));
  // A player's drag, the DM's of a party member and every shared ruler keep to ground players have seen. The DM's other drags read the DM's own map.
  const publicGround = !everything && (opts.seenGround === true || viewer.role === "player" || isPartyMember(state, token));
  const ground = publicGround && scene && scene.fogEnabled !== false ? (opts.sharedGround === true ? sharedGround : playersSeeGround)(state, scene.id) : null;
  const fpc = rules.feetPerCell;
  const creatures: WalkCreature[] = [];
  const spaces: WalkSpace[] = [];
  if (opts.creatures !== false) {
    for (const other of [...shown.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (other.id === token.id || (other.kind !== "pc" && other.kind !== "npc" && other.kind !== "monster")) continue;
      if (actorOf(state, other)?.life === "dead") continue;
      const r = footprintRect(SQUARES, other);
      const { lo, hi } = verticalExtentFt(other, fpc);
      creatures.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, lo, hi, way: creatureWay(token, other, publicKeys(state, other), blocks) });
      spaces.push({ id: other.id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, lo, hi });
    }
  }
  const areaCtx = areaContext(state, token, shown, viewer.role === "dm" && !everything);
  const areas: WalkArea[] = [];
  const halfSpeed: AreaTemplate[] = [];
  for (const { template, kind } of slowingAreas(state, token, shown, rigid, everything)) {
    if (kind === "halfSpeed") halfSpeed.push(template);
    else areas.push({ extra: kind === "quarter" ? 3 : 1, cells: computeCoverage(template, areaCtx).cells });
  }
  const input: WalkInput = {
    build: { scenes: state.scenes, buildChunks: state.buildChunks },
    token,
    rules,
    seen: ground ? (x, y) => ground(x, y) : null,
    creatures,
    areas,
    prone: publicKeys(state, token).has("prone"),
    counter: publicCounters(SQUARES, token, stops, rules, viewer.role === "dm"),
  };
  return { input, spaces, halfSpeed, areaCtx };
}

/**
 * The public world for a walk by `token` and what it carries
 * (docs/design-v1-attach.md 7.3 and 9), read from its public members alone,
 * those every player sees by links every player sees, so no hidden link
 * changes a route. It keeps to ground players have seen when any of them
 * is a party member, the mover included. While it drags or carries a
 * creature every foot costs one more (dragExtra), which every piece of its
 * route then carries. What moves with it never stands in its way, since it
 * is not there once the holder has gone. The creatures among them it drags
 * beside it walk each step with it (WalkInput `towed`), so its route is one
 * they all fit through (4.2, review LP12-AT-2).
 */
export function groupWalkWorld(state: RoomState, token: Token & Walker, viewer: WalkViewer, stops: readonly PathStop[] = [], opts: WorldOptions = {}): PublicWorld {
  const shown = shownBy(state, viewer, opts);
  const seen = (t: { id: string }) => {
    const other = state.tokens[t.id];
    return other !== undefined && shown(other);
  };
  const members = publicMembers(state.tokens, token.id, seen).slice(1);
  const party = members.some((id) => isPartyMember(state, state.tokens[id]!));
  const world = publicWorld(state, token, viewer, stops, party ? { ...opts, seenGround: true } : opts);
  const drag = dragExtra(state.tokens, token.id, seen);
  if (drag === 0 && members.length === 0) return world;
  const moving = new Set(members);
  const keep = world.spaces.map((space) => !moving.has(space.id));
  // Each as itself, never squeezed, as its holder's walk takes it along (moveLeg.ts follow).
  const towed = members.flatMap((id) => {
    const member = state.tokens[id]!;
    return member.attached?.kind === "drag" ? followerTrace(member, [member]) : [];
  });
  return {
    ...world,
    input: { ...world.input, drag, creatures: world.input.creatures.filter((_, i) => keep[i]), ...(towed.length > 0 ? { towed } : {}) },
    spaces: world.spaces.filter((_, i) => keep[i]),
  };
}

/** The tokens on the mover's scene players see, by id. */
function shownTokens(state: RoomState, token: Token, viewer: WalkViewer, everything = false, opts: Pick<WorldOptions, "moved" | "unseen"> = {}): Map<string, Token> {
  const onScene = Object.values(state.tokens).filter((t): t is Token => t !== undefined && t.sceneId === token.sceneId);
  const shown = shownBy(state, viewer, opts);
  return new Map(onScene.filter((t) => everything || shown(t)).map((t) => [t.id, t]));
}

/** Whether players see a token, as `publicToken` reads it, a token a walking ruler's earlier legs moved where those legs left it (WorldOptions `moved` and `unseen`). */
function shownBy(state: RoomState, viewer: WalkViewer, opts: Pick<WorldOptions, "moved" | "unseen">): (t: Token) => boolean {
  return (t) => !opts.unseen?.has(t.id) && (opts.moved?.has(t.id) ? seenWhereMoved(state, t) : publicToken(state, t, viewer));
}

/**
 * Whether players who do not own a token see it where a walking ruler's
 * earlier legs left it, by the rule the server judges every player's sight
 * by (project.ts inSightOfNonOwners), on the DM's room or a player's copy.
 * A copy holds no owners of another's token, so there a party member reads
 * as one by the projection's `aboveFog`, set for a party member or a token
 * the DM exempted, which tells no one who owns it (review AT-SOL-7).
 */
export function seenWhereMoved(state: RoomState, token: Token): boolean {
  const above = (token as Token & { aboveFog?: boolean }).aboveFog === true;
  return inSightOfNonOwners(state, above ? { ...token, fogExempt: true } : token, {});
}

/**
 * Where the areas reach, by the walls players know (review MV-O-10). Areas
 * pass a secret door by its real state, and players hold one nobody found
 * as a wall, so on the DM's device the public world reads the scene's
 * chunks as players hold them (`asPlayers`). A player's copy already is.
 */
function areaContext(state: RoomState, token: Token, shown: ReadonlyMap<string, Token>, asPlayers: boolean): AreaContext {
  const scene = state.scenes[token.sceneId];
  return {
    settings: state.meta.settings,
    bounds: scene?.bounds ?? { w: 0, h: 0 },
    // Areas that slow a walk are square until hex grids' phase H2, which refuses routes on hexes.
    grid: SQUARES,
    walls: scene ? sceneWalls(scene, asPlayers ? playersChunks(state, scene.id) : state.buildChunks) : null,
    tokens: Object.fromEntries([...shown].map(([id, t]) => [id, t as AreaToken])),
  };
}

/**
 * The mover and the tokens carried rigidly with it (docs/design-v1-movement.md
 * 15, review AT-ASTRA-28): its public members on links that sit on their
 * holder (attach.ts onHolder), which go where it goes. A creature it drags
 * trails behind it, and its holder stays where it is. Only links every
 * player sees count, as `shown` judges them, so no hidden link changes what
 * an area costs. The DM's own ruler, which reads every area, judges every
 * link seen.
 */
function rigidWith(state: RoomState, token: Token, shown: (t: Token) => boolean): ReadonlySet<string> {
  const pub = (t: { id: string }) => {
    const other = state.tokens[t.id];
    return other !== undefined && shown(other);
  };
  const rigid = carriedGroup(state.tokens, token.id, new Set(), (child, holder) => child.attached !== undefined && onHolder(child.attached.kind) && pub(child) && pub(holder));
  return new Set([token.id, ...rigid]);
}

/** The public areas that slow this mover, each without a caster players cannot see. An area on the mover, or on a token carried rigidly with it (`rigid`), goes with it, so it never meets the mover along the way. */
function slowingAreas(state: RoomState, token: Token, shown: ReadonlyMap<string, Token>, rigid: ReadonlySet<string>, everything = false): { template: AreaTemplate; kind: AreaSlows["kind"] }[] {
  const out: { template: AreaTemplate; kind: AreaSlows["kind"] }[] = [];
  for (const { template, caster } of publicAreas(state, token.sceneId, (id) => shown.get(id), everything)) {
    const slows = template.slows;
    if (!slows || (template.attachedTo !== undefined && rigid.has(template.attachedTo)) || !slowsMover(slows, caster, token)) continue;
    const { casterId: _hidden, ...uncast } = template;
    out.push({ template: caster ? template : uncast, kind: slows.kind });
  }
  return out;
}

/** The Half Speed areas that affect `token` (4.2), as the public world holds them, for the movement marker where it stands. */
export function speedAreas(state: RoomState, token: Token, viewer: WalkViewer): SpeedAreas {
  const shown = shownTokens(state, token, viewer);
  return { halfSpeed: slowingAreas(state, token, shown, rigidWith(state, token, shownBy(state, viewer, {}))).flatMap((a) => (a.kind === "halfSpeed" ? [a.template] : [])), areaCtx: areaContext(state, token, shown, viewer.role === "dm") };
}

/*
 * A scene's chunks as players hold them (project.ts projectChunkForPlayer,
 * kept per chunk object), by the room's chunk collection, which is replaced
 * and never changed, and the scene's automatic walls rule, so the walls
 * derived from them are kept too.
 */
const playerBuilds = new WeakMap<object, Map<string, Record<string, BuildChunk>>>();

function playersChunks(state: RoomState, sceneId: string): Record<string, BuildChunk> {
  let byScene = playerBuilds.get(state.buildChunks);
  if (!byScene) playerBuilds.set(state.buildChunks, (byScene = new Map()));
  const autoWalls = state.scenes[sceneId]?.autoWalls;
  const key = `${sceneId},${autoWalls ?? ""}`;
  const hit = byScene.get(key);
  if (hit) return hit;
  const out: Record<string, BuildChunk> = {};
  for (const [key, chunk] of Object.entries(state.buildChunks)) {
    if (!chunk || chunk.sceneId !== sceneId) continue;
    const seen = projectChunkForPlayer(state.buildChunks, chunk, autoWalls);
    if (seen) out[key] = seen;
  }
  byScene.set(key, out);
  return out;
}

/**
 * The Half Speed area that holds the mover as it stands, or as a spot of
 * its walk places it with the footprint its trace has there (route.ts
 * placedOnTrace), by the area rules' creature test in three dimensions
 * (4.2), or null. However many hold it, its Speed is halved once.
 */
export function halvedAt(areas: SpeedAreas, placed: Token): AreaTemplate | null {
  if (areas.halfSpeed.length === 0) return null;
  const at = placed as AreaToken;
  const ctx: AreaContext = { ...areas.areaCtx, tokens: { ...areas.areaCtx.tokens, [placed.id]: at } };
  return areas.halfSpeed.find((t) => creaturesInArea(t, [at], ctx).length > 0) ?? null;
}
