import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type AttachKind, type BuildChunk, type EdgeFeature, type RoomState, type Token, type Viewer } from "#shared/model.ts";
import { canApply, mayMoveToken } from "#shared/permissions.ts";
import { inSightOfNonOwners, isPartyMember, projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { carriedGroup, getOffSpot, holderOf, seatSpot } from "#shared/rules/attach.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { DM, P1, P2, actor, chance, deepClone, effect, env, int, pick, rng, room, token } from "#shared/testutil.ts";
import type { Pose } from "./undo.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * The hidden-state generator (docs/design-v1-attach.md 8.0, the class of
 * reviews AT-ASTRA-1, AT-ASTRA-10, AT-O-16 and AT-O-20): no hidden link or
 * hidden token changes anything a player receives. Each run builds a room
 * with random holder chains up to four tokens deep, each token visible or
 * not, so each link is seen or not, walls, raised ground, fog or the
 * party's sight, Grappled marks and rows the DM may hide, and a fight. Two
 * rooms start from it alike. Then random steps: now and then the DM changes
 * something no player sees in room b alone (room a takes a neutral edit in
 * its place, so the op numbers stay in step), and otherwise the DM or a
 * player takes the same step in both, through the room actor's own checks:
 * moves, group moves into walls, attaches, detaches, drags off a mount,
 * undos, redos and Next.
 *
 * After every step each player's answer must be the same in both rooms,
 * and so must each player's copy (tokens with their paths and costs, the
 * tracker and the log) and which tokens they may drag. The one thing that
 * may differ is the carried-object reveal: a visible token with a hidden
 * token or link above it may move with its hidden holder in one room
 * alone. Such a token, once moved apart, is left out of what is compared,
 * and so is a token that comes into sight as the DM left it unseen. No
 * player step names a token apart after, and an undo or a redo that would
 * put one back by its own answer is the one answer not compared. Where
 * that answer or the DM's own parts the rooms, both go back to before the
 * step and the run goes on.
 */

const IDS = ["thorn", "bree", "pip", "horse", "pony", "elk", "dog", "imp", "rat", "steed", "torch", "light", "cart", "lizard", "lamp"] as const;
const SHOWN_SOMETIMES = new Set(["horse", "pony", "elk", "dog", "imp", "rat", "torch", "light", "cart", "lizard", "lamp"]);
const deps = { canUseAsset: () => true };

/** The scene's build: wall edges and ground heights by global cell key, split into chunks the way the reducer stores them. */
function built(edges: Record<string, EdgeFeature>, heights: Record<string, number>): Record<string, BuildChunk> {
  const chunks: Record<string, BuildChunk> = {};
  const at = (key: string) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const chunk = (chunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
    return { chunk, k: (y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS) };
  };
  for (const [key, feature] of Object.entries(edges)) at(key).chunk.edges[key] = feature;
  const feet = new Map<BuildChunk, number[]>();
  for (const [key, v] of Object.entries(heights)) {
    const { chunk, k } = at(key);
    if (!feet.has(chunk)) feet.set(chunk, new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0));
    feet.get(chunk)![k] = v;
  }
  for (const [chunk, f] of feet) chunk.heights = encodeHeights(f);
  return chunks;
}

/** One run's room and what it has, for the totals. */
type World = { state: RoomState; vision: boolean; chain: boolean };

/**
 * The room: three player characters, four mounts, three small creatures, a
 * steed and four objects, a lurker for neutral edits, on a scene with walls
 * and raised ground, fog or the party's sight now and then.
 */
function world(r: () => number): World {
  const walk = (feet: number, grappled = false) => ({
    actor: { inline: actor({ speeds: { walk: feet }, ...(grappled ? { effects: [effect("g", { key: "grappled", ...(chance(r, 0.5) ? { hiddenFromPlayers: true } : {}) })] } : {}) }) },
  });
  const hidden = (id: string) => (SHOWN_SOMETIMES.has(id) && chance(r, 0.35) ? { visibility: "dm" as const } : {});
  const owners = (): string[] => pick(r, [[], [], ["p1"], ["p2"]]);
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 3, y: 6, ...walk(30) }),
    token("bree", { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p2"], x: 8, y: 6, ...walk(30) }),
    token("pip", { name: "Pip", kind: "pc", size: "small", disposition: "ally", ownerIds: ["p1"], x: 5, y: 8, ...walk(25) }),
    token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: chance(r, 0.5) ? ["p1"] : [], x: 3, y: 3, ...walk(60), ...hidden("horse") }),
    token("pony", { name: "Pony", kind: "npc", size: "large", ownerIds: owners(), x: 8, y: 3, ...walk(40, chance(r, 0.3)), ...hidden("pony") }),
    token("elk", { name: "Elk", kind: "npc", size: "huge", x: 12, y: 5, ...walk(50), ...hidden("elk") }),
    token("dog", { name: "Mastiff", kind: "npc", ownerIds: owners(), x: 6, y: 10, ...walk(40, chance(r, 0.4)), ...hidden("dog") }),
    token("imp", { name: "Imp", size: "tiny", x: 4, y: 4, ...hidden("imp") }),
    token("rat", { name: "Rat", size: "small", x: 2, y: 7, ...walk(20, chance(r, 0.5)), ...hidden("rat") }),
    token("lizard", { name: "Lizard", size: "small", x: 3, y: 5, ...walk(20, chance(r, 0.5)), ...hidden("lizard") }),
    token("steed", { name: "Phantom steed", kind: "npc", size: "large", x: 3, y: 6, visibility: "dm", ...walk(100) }),
    token("torch", { name: "Torch", kind: "object", size: "tiny", x: 3.5, y: 6.5, ...hidden("torch") }),
    token("light", { name: "Light", kind: "object", size: "tiny", x: 4.5, y: 3.5, ...hidden("light") }),
    token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 3, y: 5, ...hidden("lamp") }),
    token("cart", { name: "Cart", kind: "object", size: "large", x: 12, y: 10, ...hidden("cart") }),
    token("lurker", { name: "Lurker", x: 22, y: 22, visibility: "dm" }),
  ];
  // Walls across the ground the tokens walk on, a raised block now and then, and often the wall of review AT-ASTRA-1.
  const edges: Record<string, EdgeFeature> = {};
  const heights: Record<string, number> = {};
  const stopped = chance(r, 0.4);
  if (stopped) for (const y of [5, 6]) edges[`6,${y},w`] = { kind: "wall" };
  for (let i = int(r, 1, 3); i > 0; i--) {
    const at = int(r, 4, 14);
    const from = int(r, 0, 10);
    for (let v = from; v < from + int(r, 2, 6); v++) edges[chance(r, 0.5) ? `${at},${v},w` : `${v},${at},n`] = { kind: "wall" };
  }
  if (chance(r, 0.5)) {
    const x = int(r, 2, 12);
    const y = int(r, 2, 10);
    for (let dy = 0; dy < int(r, 1, 3); dy++) for (let dx = 0; dx < int(r, 1, 3); dx++) heights[`${x + dx},${y + dy}`] = pick(r, [5, 10]);
  }
  let state = room({ tokens: Object.fromEntries(list.map((t) => [t.id, t])), buildChunks: built(edges, heights) });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen"] as const), revealHiddenOnTurn: false };
  const vision = chance(r, 0.2);
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: chance(r, 0.6), autoWalls: "off", ...(vision ? { fogEnabled: true, vision: { on: true, light: "bright" as const } } : {}) };
  let seq = 1;
  const dm = (op: Op) => {
    const out = applyOp(state, op, DM, env(seq++));
    if (out.ok) state = out.state;
  };
  // Fog the DM lifts from part of the scene, so a creature past it reaches no player who does not own it.
  if (!vision && chance(r, 0.4)) {
    state = { ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1!, fogEnabled: true } } };
    dm({ t: "fog.live", sceneId: "s1", ops: [{ id: "lift", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: int(r, 6, 20), h: int(r, 8, 25) } }] });
  }
  // Random links, kept where the reducer takes them, so chains run up to its depth limit.
  for (let i = 0; i < 14; i++) {
    const carried = state.tokens[pick(r, IDS)]!;
    const holder = state.tokens[pick(r, IDS)]!;
    if (carried.id === holder.id) continue;
    // On a scene of the party's sight, a visible party member never rides a hidden holder: carried apart by the reveal, it
    // would change what the whole party sees, a difference every player sees and no hidden state's.
    if (vision && isPartyMember(state, carried) && carried.visibility !== "dm" && holder.visibility === "dm") continue;
    const kind: AttachKind = carried.kind === "object" || holder.kind === "object" ? "carry" : carried.size === "tiny" ? "perch" : chance(r, 0.3) ? "drag" : "ride";
    const seat = kind === "drag" ? carried : seatSpot(carried, holder);
    if (!seat) continue;
    dm({ t: "token.attach", tokenId: carried.id, to: holder.id, kind, ...(kind === "ride" && chance(r, 0.5) ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? carried.elevation : holder.elevation });
  }
  /** A token set loose from its holder and changed, written as a new tokens record, since the reducer indexes each one it reads. */
  const loose = (id: string, over: Partial<Token>) => {
    const { attached: _link, ...rest } = state.tokens[id]!;
    state = { ...state, tokens: { ...state.tokens, [id]: { ...rest, ...over } } };
  };
  // Often review AT-ASTRA-1's case: P1's horse drags a hidden lizard that holds a visible lamp, and a walk east stops the
  // lizard at the wall, out of reach, so the drag breaks on the way.
  if (stopped) {
    loose("horse", { visibility: "all", ownerIds: ["p1"] });
    loose("lizard", { x: 3, y: 5, elevation: 0, visibility: "dm" });
    loose("lamp", { x: 3, y: 5, elevation: 0, visibility: "all" });
    dm({ t: "token.attach", tokenId: "lizard", to: "horse", kind: "drag", x: 3, y: 5, elevation: 0 });
    dm({ t: "token.attach", tokenId: "lamp", to: "lizard", kind: "carry", x: 3, y: 5, elevation: 0 });
  }
  // Often the chain of the reviews: a horse carrying a hidden imp that holds P1's torch with P1's light on it, four deep. Only a
  // player's attach forms it, through the actor's own check: the player's depth limit counts only what every player sees
  // (8.0), so the hidden imp leaves room for the light, where the DM's counts the imp and refuses it.
  let chain = false;
  if (chance(r, 0.4)) {
    const horse = state.tokens.horse!;
    const on = { x: horse.x, y: horse.y, elevation: horse.elevation };
    loose("horse", { visibility: "all", ownerIds: ["p1"] });
    loose("imp", { visibility: "dm", ...on });
    loose("torch", { visibility: "all", ownerIds: ["p1"], ...on });
    loose("light", { visibility: "all", ownerIds: ["p1"], ...on });
    for (const [carried, holder, kind] of [["imp", "horse", "perch"], ["torch", "imp", "carry"], ["light", "torch", "carry"]] as const) {
      const seat = seatSpot(state.tokens[carried]!, state.tokens[holder]!);
      if (!seat) continue;
      const op: Op = { t: "token.attach", tokenId: carried, to: holder, kind, x: seat.x, y: seat.y, elevation: state.tokens[holder]!.elevation };
      const by = carried === "light" ? P1 : DM;
      if (by === P1 && !canApply(op, P1, state, deps).ok) continue;
      const out = applyOp(state, op, by, env(seq++));
      if (out.ok) state = out.state;
    }
    chain = state.tokens.light!.attached?.to === "torch" && state.tokens.torch!.attached?.to === "imp" && state.tokens.imp!.attached?.to === "horse";
    // Then the DM takes the light, and now and then the torch, from P1, so the chain carries tokens P1 may not move.
    if (chain) for (const id of ["light", "torch"]) if (id === "light" || chance(r, 0.5)) dm({ t: "token.update", tokenId: id, patch: { ownerIds: [] } });
  }
  // Often Thorn rides the phantom steed no player sees, but not where his sight is the party's.
  if (!vision && chance(r, 0.4)) dm({ t: "token.attach", tokenId: "thorn", to: "steed", kind: "ride", ...(chance(r, 0.5) ? { steer: true as const } : {}), x: 3, y: 6, elevation: 0 });
  const row = (id: string, tokenId: string, value: number) => ({ id, tokenId, value, ...(SHOWN_SOMETIMES.has(tokenId) && chance(r, 0.3) ? { hidden: true } : {}) });
  dm({ t: "encounter.start", entries: [row("et", "thorn", 20), row("eb", "bree", 15), row("ep", "pip", 12), row("eh", "horse", 10), row("ey", "pony", 8), row("ed", "dog", 6)] });
  dm({ t: "encounter.next" });
  return { state, vision, chain };
}

/** A player's copy of the room, as their device holds it. */
function copyOf(state: RoomState, who: Viewer): RoomState {
  return projectState(state, who, { sceneId: "s1" }) as unknown as RoomState;
}

const nearBy = (r: () => number, v: number, by = 3) => Math.max(0, Math.min(24, v + int(r, -by, by)));

type Step = { who: Viewer; op: Op } | { who: Viewer; restore: "undo" | "redo" };

/** The tokens a step names, which no player step may name once moved apart by the reveal. */
function namedBy(step: Step): string[] {
  if ("restore" in step) return [];
  const op = step.op;
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  if (op.t === "token.attach") return [op.tokenId, op.to];
  return "tokenId" in op && typeof op.tokenId === "string" ? [op.tokenId] : [];
}

/** A step by the DM or a player, made from what that viewer's own copy holds. */
function sharedStep(r: () => number, state: RoomState, apart: ReadonlySet<string>): Step {
  const who = pick(r, [DM, P1, P1, P2]);
  const view = who.role === "dm" ? state : copyOf(state, who);
  const tokens = Object.values(view.tokens).filter((t) => !apart.has(t.id) && t.id !== "lurker" && (who.role === "player" || t.visibility !== "dm"));
  const any = () => (tokens.length > 0 ? pick(r, tokens) : undefined);
  const encounter = view.encounter;
  const acting = encounter?.activeEntryId ? encounter.entries.find((e) => e.id === encounter.activeEntryId)?.tokenId : undefined;
  const n = r();
  if (n < 0.12) return { who, restore: chance(r, 0.7) ? "undo" : "redo" };
  if (n < 0.2) {
    if (who.role === "player" && encounter) return { who, op: { t: "encounter.next", from: { entry: encounter.activeEntryId ?? null, round: encounter.round } } };
    return { who: DM, op: { t: "encounter.next" } };
  }
  // The turn's creature, a rider now and then, walks or is dragged off what it rides.
  const self = acting ? view.tokens[acting] : undefined;
  if (n < 0.38 && self && !apart.has(self.id)) {
    const by = self.ownerIds?.includes("p1") ? P1 : self.ownerIds?.includes("p2") ? P2 : DM;
    const x = nearBy(r, self.x, 2);
    const y = nearBy(r, self.y, 2);
    if (chance(r, 0.3)) return { who: by, op: { t: "token.moveMany", moves: [{ tokenId: self.id, x, y }, ...(tokens.some((t) => t.id === "pip" && t.id !== self.id) ? [{ tokenId: "pip", x: nearBy(r, view.tokens.pip!.x, 1), y: nearBy(r, view.tokens.pip!.y, 1) }] : [])] } };
    return { who: by, op: { t: "token.move", tokenId: self.id, x, y, ...(chance(r, 0.2) ? { route: [[x, self.y, 0, 0], [x, y, 0, 0]] as [number, number, number, 0 | 1][] } : {}) } };
  }
  const a = any();
  if (!a) return { who: DM, op: { t: "encounter.next" } };
  if (n < 0.62) return { who, op: { t: "token.move", tokenId: a.id, x: nearBy(r, a.x, chance(r, 0.3) ? 6 : 3), y: nearBy(r, a.y) } };
  if (n < 0.7) {
    const b = any();
    if (!b || b.id === a.id) return { who, op: { t: "token.move", tokenId: a.id, x: nearBy(r, a.x), y: nearBy(r, a.y) } };
    return { who, op: { t: "token.moveMany", moves: [{ tokenId: a.id, x: nearBy(r, a.x, 2), y: nearBy(r, a.y, 2) }, { tokenId: b.id, x: nearBy(r, b.x, 2), y: nearBy(r, b.y, 2) }] } };
  }
  if (n < 0.86) {
    const holder = any();
    if (!holder || holder.id === a.id) return { who: DM, op: { t: "encounter.next" } };
    const kind: AttachKind = a.kind === "object" || holder.kind === "object" ? "carry" : a.size === "tiny" ? "perch" : chance(r, 0.4) ? "drag" : "ride";
    const seat = kind === "drag" ? a : (seatSpot(a, holder) ?? holder);
    return { who, op: { t: "token.attach", tokenId: a.id, to: holder.id, kind, ...(kind === "ride" && chance(r, 0.5) ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? a.elevation : holder.elevation } };
  }
  const carried = tokens.filter((t) => t.attached && view.tokens[t.attached.to]);
  const c = carried.length > 0 ? pick(r, carried) : a;
  const holder = holderOf(view.tokens, c) as Token | undefined;
  const scene = view.scenes[c.sceneId];
  const place = holder && scene && c.kind !== "object" && c.attached?.kind !== "drag" ? getOffSpot(view.meta.settings, scene.bounds, c, holder) : null;
  return { who, op: { t: "token.detach", tokenId: c.id, ...(place ? { x: place.x, y: place.y } : {}) } };
}

/**
 * A change only the DM sees, for room b: candidates the check in `run`
 * keeps only when no player's copy changes. Links and tokens, heights,
 * sizes, a teleport, a leg's count, a Grappled mark, a ride's control and
 * the scene, and with `tracker` a hidden row added or removed or the turn
 * taken back. Those last decide where a later Next lands by the tracker's
 * own rule, which shows players a hidden creature's turn, so `run` takes
 * them only between a move and its undos, and takes them back after.
 */
function unseenOp(r: () => number, state: RoomState, vision: boolean, focus?: ReadonlySet<string>, tracker = false): Op | null {
  // A creature with a row stays: a row whose creature is gone is the tracker's own matter, not a link's.
  const rows = new Set((state.encounter?.entries ?? []).map((e) => e.tokenId));
  const near = Object.values(state.tokens).filter((t) => !focus || focus.has(t.id));
  const hidden = near.filter((t) => t.id !== "lurker" && !inSightOfNonOwners(state, t, {}));
  // Where the party's sight is shared, a visible party member keeps its holder (world's note).
  const keeps = (t: Token) => vision && isPartyMember(state, t) && t.visibility !== "dm";
  const deletable = hidden.filter((t) => !rows.has(t.id) && !Object.values(state.tokens).some((c) => c.attached?.to === t.id && keeps(c)));
  const hiddenLinks = near.filter((t) => {
    const holder = t.attached ? state.tokens[t.attached.to] : undefined;
    return holder !== undefined && !keeps(t) && (!inSightOfNonOwners(state, t, {}) || !inSightOfNonOwners(state, holder, {}));
  });
  const n = r();
  if (n < 0.3 && hiddenLinks.length > 0) {
    const t = pick(r, hiddenLinks);
    if (t.attached!.kind === "ride") {
      // A ride's control turns, or the ride comes off with its holder, since a Get off moves the rider.
      if (chance(r, 0.5)) return { t: "token.attach", tokenId: t.id, to: t.attached!.to, kind: "ride", ...(t.attached!.steer ? {} : { steer: true as const }), x: t.x, y: t.y, elevation: t.elevation };
      return deletable.some((d) => d.id === t.attached!.to) ? { t: "token.delete", tokenId: t.attached!.to } : null;
    }
    return { t: "token.detach", tokenId: t.id };
  }
  if (n < 0.36) return tracker ? { t: "encounter.prev" } : null;
  if (n < 0.42) {
    if (!tracker) return null;
    const quiet = (state.encounter?.entries ?? []).filter((e) => e.hidden || (e.tokenId !== undefined && state.tokens[e.tokenId] !== undefined && !inSightOfNonOwners(state, state.tokens[e.tokenId]!, {})));
    return quiet.length > 0 ? { t: "encounter.remove", entryIds: [pick(r, quiet).id] } : null;
  }
  if (hidden.length === 0) return null;
  const h = pick(r, hidden);
  if (n < 0.5) return deletable.length > 0 ? { t: "token.delete", tokenId: pick(r, deletable).id } : null;
  if (n < 0.6) return { t: "token.move", tokenId: h.id, x: nearBy(r, h.x), y: nearBy(r, h.y), ...(chance(r, 0.3) ? { teleport: "wall" as const } : {}) };
  if (n < 0.66) return { t: "token.update", tokenId: h.id, patch: chance(r, 0.5) ? { elevation: pick(r, [0, 5, 10, 20]) } : { size: pick(r, ["tiny", "small", "medium", "large"] as const) } };
  if (n < 0.7) return h.path ? { t: "token.countLeg", tokenId: h.id, counts: chance(r, 0.5) } : null;
  if (n < 0.74) return { t: "token.update", tokenId: h.id, patch: { sceneId: "s2" } };
  if (n < 0.82) {
    // A Grappled mark no player sees, put on or taken off, on any creature: a player's drag never reads it (8.0).
    const creatures = near.filter((x) => x.kind !== "object" && x.id !== "lurker");
    const t = creatures.length > 0 ? pick(r, creatures) : undefined;
    if (!t || !("inline" in t.actor)) return null;
    const mark = t.actor.inline.effects?.find((e) => e.key === "grappled" && e.hiddenFromPlayers);
    return mark ? { t: "actor.effect.remove", target: { tokenId: t.id }, effectId: mark.id } : { t: "actor.effect.add", target: { tokenId: t.id }, effect: { id: `g${int(r, 100, 999)}`, key: "grappled", hiddenFromPlayers: true } };
  }
  if (n < 0.86) return !tracker || rows.has(h.id) ? null : { t: "encounter.add", entries: [{ id: `r${int(r, 100, 999)}`, tokenId: h.id, value: int(r, 1, 25), hidden: true }] };
  const target = pick(r, Object.values(state.tokens).filter((t) => t.id !== h.id && t.id !== "lurker"));
  const seat = seatSpot(h, target);
  return seat ? { t: "token.attach", tokenId: h.id, to: target.id, kind: h.size === "tiny" ? "perch" : h.kind === "object" ? "carry" : "ride", x: seat.x, y: seat.y, elevation: target.elevation } : null;
}

/** Whether a token has a token or a link no player sees anywhere above it: one the reveal may move with a hidden holder. */
function underHidden(state: RoomState, id: string): boolean {
  const seen = new Set<string>([id]);
  for (let t = state.tokens[id]; t; ) {
    const holder = holderOf(state.tokens, t) as Token | undefined;
    if (!holder || seen.has(holder.id)) return false;
    if (!inSightOfNonOwners(state, t, {}) || !inSightOfNonOwners(state, holder, {})) return true;
    seen.add(holder.id);
    t = holder;
  }
  return false;
}

const POSE = ["sceneId", "x", "y", "elevation"] as const;

/**
 * Every player's copies of the two rooms, compared, and the tokens each may
 * drag. A token apart in its place, with something hidden above it in
 * either room, is the reveal and joins `apart`. Any other difference, a
 * cost or a path on the same spot included, fails.
 */
function compare(a: { before: RoomState; after: RoomState }, b: { before: RoomState; after: RoomState }, apart: Set<string>, where: string): void {
  for (const who of [P1, P2]) {
    const ca = copyOf(a.after, who);
    const cb = copyOf(b.after, who);
    const was = [copyOf(a.before, who), copyOf(b.before, who)];
    for (const id of new Set([...Object.keys(ca.tokens), ...Object.keys(cb.tokens)])) {
      if (apart.has(id)) continue;
      const ta = ca.tokens[id];
      const tb = cb.tokens[id];
      try {
        assert.deepEqual(ta, tb);
      } catch {
        const moved = !ta || !tb || POSE.some((f) => ta[f] !== tb[f]);
        const reveal = [a.before, a.after, b.before, b.after].some((s) => underHidden(s, id));
        // A link to a token moved apart holds or not by where that token stands, which every player sees.
        const onApart = [ta, tb].some((t) => t?.attached !== undefined && apart.has(t.attached.to));
        // A token neither room showed this player before the step comes into sight as the DM left it while unseen, and so does
        // its link to a holder that comes into sight.
        const unshown = (key: string) => was.every((c) => c.tokens[key] === undefined);
        const linkOnly = ta !== undefined && tb !== undefined && isSame({ ...ta, attached: undefined }, { ...tb, attached: undefined });
        const shown = unshown(id) || (linkOnly && [ta, tb].some((t) => t.attached !== undefined && unshown(t.attached.to)));
        assert.ok((moved && reveal) || onApart || shown, `${where}: ${who.memberId} sees ${id} differ: ${JSON.stringify(ta)} against ${JSON.stringify(tb)}`);
        apart.add(id);
      }
    }
    // A drag's frames go out only for a token the player may move: no hidden holder lends that right (8.0).
    for (const id of Object.keys(ca.tokens)) {
      if (apart.has(id) || !cb.tokens[id]) continue;
      assert.equal(mayMoveToken(a.after, who, id).ok, mayMoveToken(b.after, who, id).ok, `${where}: ${who.memberId} may drag ${id} in one room alone`);
    }
    const rest = (c: RoomState) => {
      const { tokens: _tokens, ...others } = c;
      const encounter = others.encounter;
      // A turn that starts on a token moved apart starts where each room has it.
      if (encounter?.turnStart && apart.has(encounter.turnStart.tokenId)) return { ...others, encounter: { ...encounter, turnStart: { ...encounter.turnStart, x: 0, y: 0, elevation: 0 } } };
      return others;
    };
    assert.deepEqual(rest(ca), rest(cb), `${where}: ${who.memberId} sees the rest of the rooms differ`);
  }
}

const NEUTRAL: Op = { t: "token.update", tokenId: "lurker", patch: { notes: "" } };

/** What a run reached, so the totals can say the generator tests the cases it is for. */
type Seen = { unseen: number; compared: number; restores: number; restoresCompared: number; restoresApart: number; parted: number; brokenLinks: number; chains: number };

/** One run: its seed and the steps it took. */
function run(seed: number, steps = 70): Seen {
  const r = rng(seed);
  const start = world(r);
  let a = new UndoTable(deepClone(start.state));
  let b = new UndoTable(deepClone(start.state));
  a.seq = b.seq = 100;
  const apart = new Set<string>();
  let trackerApart = false;
  const seen: Seen = { unseen: 0, compared: 0, restores: 0, restoresCompared: 0, restoresApart: 0, parted: 0, brokenLinks: 0, chains: start.chain ? 1 : 0 };
  let where = "";
  /** The DM's unseen change in room b, kept only when no player's copy changes, with a neutral edit in room a. */
  const unseen = (focus?: ReadonlySet<string>, tracker = false): Op | null => {
    const op = unseenOp(r, b.state, start.vision, focus, tracker);
    if (!op) return null;
    const trial = applyOp(b.state, op, DM, env(b.seq + 1));
    if (!trial.ok || [P1, P2].some((p) => !isSame(copyOf(trial.state, p), copyOf(b.state, p)))) return null;
    assert.equal(b.play(DM, op), "ok", `${where}: the unseen ${op.t}`);
    assert.equal(a.play(DM, NEUTRAL), "ok");
    seen.unseen++;
    return op;
  };
  /**
   * Whether a player's undo or redo would put back, by its own answer, a
   * token moved apart or a link to one. Only a token the step named, or
   * one every player sees carried in both rooms now, answers so. The
   * step's own silent marks are not trusted here, since they are what the
   * test is for: a token under something hidden that the step left loud is
   * still compared.
   */
  const putsBackApart = (step: Step): boolean => {
    if (!("restore" in step)) return false;
    return [a, b].some((t) => {
      const top = t.stacks.peek(step.who.memberId, step.restore);
      const before = new Map((top?.entries ?? []).map((e) => [e.key, e.value]));
      return Object.entries(top?.poses ?? {}).some(([id, pose]) => {
        if (pose.root !== true && [a.state, b.state].some((s) => underHidden(s, id))) return false;
        const value = before.get(`token:${id}`);
        const to = value && typeof value === "object" ? (value as Token).attached?.to : undefined;
        return apart.has(id) || (to !== undefined && apart.has(to));
      });
    });
  };
  /** The same step in both rooms, compared. Where the DM's answers part the rooms, both go back to before it. */
  const shared = (step: Step): void => {
    if (step.who.role === "player" && namedBy(step).some((id) => apart.has(id))) return;
    if (trackerApart && "op" in step && step.op.t.startsWith("encounter.")) return;
    const before = { a: a.state, b: b.state };
    const apartBack = putsBackApart(step);
    const answer = (t: UndoTable) => ("restore" in step ? (step.restore === "undo" ? t.undo(step.who) : t.redo(step.who)) : t.play(step.who, step.op));
    const ra = answer(a);
    const rb = answer(b);
    a.seq = b.seq = Math.max(a.seq, b.seq);
    const label = "restore" in step ? step.restore : step.op.t;
    if (step.who.role === "player") {
      if ("restore" in step && apartBack) seen.restoresApart++;
      else {
        assert.equal(ra, rb, `${where}: ${step.who.memberId}'s ${label} answers differ`);
        seen.compared++;
        if ("restore" in step) {
          seen.restoresCompared++;
          if (ra === "ok") seen.restores++;
        }
      }
    }
    // The DM's own answer may read what the DM knows. Where it parts the rooms, both go back to before the step, with the
    // stacks cleared alike, and the run goes on.
    const part = () => {
      const seq = a.seq;
      a = new UndoTable(before.a);
      b = new UndoTable(before.b);
      a.seq = b.seq = seq;
      seen.parted++;
    };
    if (step.who.role === "dm" && ra !== rb) return part();
    // So may an undo or a redo that puts back a token moved apart, whose answer reads where every player sees it stand.
    if (apartBack && ra !== rb) return part();
    // A link a step broke on the way, a drag stopped at a wall among them: the passengers its undo must still class by its plan.
    if (!("restore" in step) && Object.values(before.b.tokens).some((t) => t.attached && b.state.tokens[t.id] && !b.state.tokens[t.id]!.attached)) seen.brokenLinks++;
    compare({ before: before.a, after: a.state }, { before: before.b, after: b.state }, apart, `${where} (${step.who.memberId}'s ${label})`);
  };
  for (let i = 0; i < steps; i++) {
    where = `seed ${seed} step ${i + 1}`;
    const roll = r();
    if (roll < 0.2) {
      unseen();
      continue;
    }
    if (roll < 0.38) {
      // The shape of the reviews' cases: a player moves a group of theirs, the DM changes something unseen in it, perhaps
      // locks the token, and the player takes the move back and forth. A long walk east meets the walls.
      const who = chance(r, 0.7) ? P1 : P2;
      const own = Object.values(a.state.tokens).filter((t) => t.ownerIds.includes(who.memberId!) && !apart.has(t.id) && copyOf(a.state, who).tokens[t.id]);
      if (own.length === 0) continue;
      // Mostly a holder, whose group the DM's unseen change can reach.
      const holding = own.filter((t) => Object.values(a.state.tokens).some((x) => x.attached?.to === t.id));
      const root = holding.length > 0 && chance(r, 0.7) ? pick(r, holding) : pick(r, own);
      const far = chance(r, 0.4);
      const to = { x: far ? Math.min(24, root.x + int(r, 4, 7)) : nearBy(r, root.x, 2), y: far ? root.y : nearBy(r, root.y, 2) };
      // Now and then the move names a passenger the player sees beside its root, each by the same offset.
      const mine = copyOf(a.state, who);
      const riders = carriedGroup(a.state.tokens, root.id).filter((id) => id !== root.id && mine.tokens[id] && !apart.has(id));
      const rider = riders.length > 0 && chance(r, 0.3) ? mine.tokens[pick(r, riders)]! : undefined;
      if (rider) shared({ who, op: { t: "token.moveMany", moves: [{ tokenId: root.id, ...to }, { tokenId: rider.id, x: rider.x + to.x - root.x, y: rider.y + to.y - root.y }] } });
      else shared({ who, op: { t: "token.move", tokenId: root.id, ...to } });
      const rooted = b.state.tokens[root.id];
      const group = new Set([...carriedGroup(b.state.tokens, root.id), ...carriedGroup(b.state.tokens, (rooted && holderOf(b.state.tokens, rooted)?.id) ?? root.id)]);
      for (const id of [...group]) for (const t of Object.values(b.state.tokens)) if (t.attached?.to === id) group.add(t.id);
      const change = unseen(group, true);
      // The DM may lock the token, or take the passenger it named from the player, so the undo needs a right of its own.
      const locks = chance(r, 0.4);
      if (locks) shared({ who: DM, op: rider && chance(r, 0.5) ? { t: "token.update", tokenId: rider.id, patch: { ownerIds: [] } } : { t: "token.update", tokenId: root.id, patch: { locked: chance(r, 0.8) } } });
      for (const restore of ["undo", "redo", "undo"] as const) shared({ who, restore });
      // The DM takes a change to the tracker back in both rooms, the neutral edit in room a, so both trackers are alike again.
      // Where that fails, no turn moves on in this run after.
      if (change?.t.startsWith("encounter.")) {
        for (let k = locks ? 2 : 1; k > 0; k--) shared({ who: DM, restore: "undo" });
        if (!isSame(a.state.encounter, b.state.encounter)) trackerApart = true;
      }
      continue;
    }
    shared(sharedStep(r, a.state, apart));
  }
  return seen;
}

function isSame(x: unknown, y: unknown): boolean {
  try {
    assert.deepEqual(x, y);
    return true;
  } catch {
    return false;
  }
}

describe("no hidden link or hidden token changes anything a player receives (8.0)", () => {
  test("random chains, walls, fog and sight, and random steps by the DM and both players, in pairs of rooms that differ only unseen", () => {
    const total: Seen = { unseen: 0, compared: 0, restores: 0, restoresCompared: 0, restoresApart: 0, parted: 0, brokenLinks: 0, chains: 0 };
    // ATTACH_RANDOM_SEEDS=1-2000 sweeps more seeds by hand. Some mutants of the rules here show only past the first hundreds.
    const [from, to] = (process.env.ATTACH_RANDOM_SEEDS ?? "1-200").split("-").map(Number) as [number, number];
    for (let seed = from; seed <= to; seed++) {
      const seen = run(seed);
      for (const key of Object.keys(total) as (keyof Seen)[]) total[key] += seen[key];
    }
    // A run that never reaches the cases it is for tests nothing. Nearly every restore is compared, not only those before a reveal.
    const summary = JSON.stringify(total);
    const per60 = (to - from + 1) / 60;
    assert.ok(total.unseen > 100 * per60 && total.compared > 800 * per60 && total.restores > 50 * per60 && total.chains > 5 * per60 && total.brokenLinks > 5 * per60, summary);
    assert.ok(total.restoresApart * 20 < total.restoresCompared, summary);
  });
});
