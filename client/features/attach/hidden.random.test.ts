import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Connection } from "#server/rooms/connection.ts";
import { buildSnapshot, publishBatch } from "#server/rooms/fanout.ts";
import type { Pose } from "#server/rooms/undo.ts";
import { UndoTable } from "#server/rooms/undoTesting.ts";
import { keys } from "#shared/keys.ts";
import { CHUNK_CELLS, type AttachKind, type BuildChunk, type EdgeFeature, type RoomState, type Token, type Viewer } from "#shared/model.ts";
import { canApply, mayMoveToken } from "#shared/permissions.ts";
import { applyChanges, inSightOfNonOwners, isPartyMember, projectState, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { carriedGroup, getOffSpot, holderOf, seatSpot } from "#shared/rules/attach.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { DM, P1, P2, actor, chance, deepClone, effect, env, int, pick, rng, room, token } from "#shared/testutil.ts";
import { dragOf, groupDragOf, type Drag, type GroupDrag } from "../movement/dragTesting.ts";
import { turnMoverId } from "./turns.ts";
import { barSlots, detachChoice, detachOp, getOffPlace } from "./detach.ts";
import { dragLead } from "./groups.ts";
import { attachOp, attachRows } from "./list.ts";

/**
 * The hidden-state generator (docs/design-v1-attach.md 8.0, the class of
 * reviews AT-ASTRA-1, AT-ASTRA-10, AT-ASTRA-13, AT-O-16, AT-O-20 and
 * AT-O-22): no hidden link or hidden token changes anything a player
 * receives. Each run builds a room with random holder chains up to four
 * tokens deep, each token visible or not, so each link is seen or not,
 * walls, raised ground, fog or the party's sight, Grappled marks and rows
 * the DM may hide, a hidden creature riding a visible mount under control,
 * and a fight. Two rooms start from it alike. Then random steps: now and
 * then the DM changes something no player sees in room b alone (room a
 * takes a neutral edit in its place, so the op numbers stay in step), and
 * otherwise the DM or a player takes the same step in both, through the
 * room actor's own checks: moves, group moves into walls, attaches,
 * detaches, drags off a mount, undos, redos and Next.
 *
 * Most steps are built as the actor's device builds them, from that
 * actor's own copy of each room, the DM's included: a drag and a group
 * drag by the board's own drag stops (dragTesting.ts), the drag's route from
 * the search, an attach from a row of the Attach list, and Get off, Put
 * down and Let go from the carried token's bar. A player's copies of the
 * two rooms are alike, so are the ops and the drag's frames they build, and
 * a group's label reads the cost the move stores (review AT-ASTRA-15). So
 * must the DM's be, for an op that names only tokens every player sees:
 * a hidden link or token never shapes the DM's op either (8.0, the
 * landings). The rest are sent as written, the shapes of the reviews'
 * cases among them.
 *
 * After every step each player's answer must be the same in both rooms,
 * and so must each player's copy (tokens with their paths and costs, the
 * tracker and the log), which tokens they may drag, and the `ev` changes
 * the room's fan-out sends them (fanout.ts), each socket's copy built from
 * those changes alike with a fresh projection. The one thing that may
 * differ is the carried-object reveal: a visible token with a hidden token
 * or link above it may move with its hidden holder in one room alone. Such
 * a token, once moved apart, is left out of what is compared until the
 * rooms agree on it again, and so is a token the DM changed unseen that
 * comes into sight as the DM left it. No player step names a token apart,
 * and an undo or a redo that would put one back by its own answer is the
 * one answer not compared. Where that answer or the DM's own parts the
 * rooms, both go back to before the step and the run goes on.
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
  // Else often review AT-O-22's case: a hidden imp hovering 10 ft up carries the visible light, which a drop by the DM lands as
  // it would with no holder, since no player sees the imp.
  if (!chain && chance(r, 0.4)) {
    const over = { x: int(r, 8, 12), y: int(r, 7, 9), elevation: 10 };
    loose("imp", { visibility: "dm", ...over });
    loose("light", { visibility: "all", ...over });
    dm({ t: "token.attach", tokenId: "light", to: "imp", kind: "carry", ...over });
  }
  // Often turn sharing behind a hidden rider (7.1): the hidden mastiff, with a row of its own, rides the visible pony under
  // control, so its turn would share the pony's but for the rule that reads only a link every player sees.
  // Not where a visible party member rides the mastiff on a scene of the party's sight (the random links' note).
  const party = (id: string) => carriedGroup(state.tokens, id).some((c) => c !== id && isPartyMember(state, state.tokens[c]!) && state.tokens[c]!.visibility !== "dm");
  if (chance(r, 0.5) && !(vision && party("dog"))) {
    loose("pony", { visibility: "all" });
    loose("dog", { visibility: "dm" });
    const seat = seatSpot(state.tokens.dog!, state.tokens.pony!);
    if (seat) dm({ t: "token.attach", tokenId: "dog", to: "pony", kind: "ride", steer: true, x: seat.x, y: seat.y, elevation: state.tokens.pony!.elevation });
  }
  // Often Thorn rides the phantom steed no player sees, but not where his sight is the party's.
  if (!vision && chance(r, 0.4)) dm({ t: "token.attach", tokenId: "thorn", to: "steed", kind: "ride", ...(chance(r, 0.5) ? { steer: true as const } : {}), x: 3, y: 6, elevation: 0 });
  // The blocks above hide holders the random links used, so on a scene of the party's sight a visible party member under one
  // gets off it after all (the random links' note).
  if (vision) for (const t of Object.values(state.tokens)) if (t.visibility !== "dm" && isPartyMember(state, t) && underHidden(state, t.id)) loose(t.id, {});
  const row = (id: string, tokenId: string, value: number) => ({ id, tokenId, value, ...(SHOWN_SOMETIMES.has(tokenId) && chance(r, 0.3) ? { hidden: true } : {}) });
  dm({ t: "encounter.start", entries: [row("et", "thorn", 20), row("eb", "bree", 15), row("ep", "pip", 12), row("eh", "horse", 10), row("ey", "pony", 8), row("ed", "dog", 6)] });
  // The fight starts on any row's turn, so the turns of a rider and its mount come up early in a run.
  for (let k = int(r, 1, 6); k > 0; k--) dm({ t: "encounter.next" });
  return { state, vision, chain };
}

const copies = new WeakMap<RoomState, Map<string, RoomState>>();

/** A player's copy of the room, as their device holds it. A state is never changed after, so each is projected once. */
function copyOf(state: RoomState, who: Viewer): RoomState {
  let held = copies.get(state);
  if (!held) copies.set(state, (held = new Map()));
  let copy = held.get(who.memberId!);
  if (!copy) held.set(who.memberId!, (copy = projectState(state, who, { sceneId: "s1" }) as unknown as RoomState));
  return copy;
}

/** The actor's own copy: the DM's device holds the whole room. */
function deviceCopy(state: RoomState, who: Viewer): RoomState {
  return who.role === "dm" ? state : copyOf(state, who);
}

const nearBy = (r: () => number, v: number, by = 3) => Math.max(0, Math.min(24, v + int(r, -by, by)));

/** A step: the same op in both rooms, or each room's own (`opB`) where the DM's device built them apart, or an undo or a redo. */
type Step = { who: Viewer; op: Op; opB?: Op } | { who: Viewer; restore: "undo" | "redo" };

/** The tokens an op names, which no player step may name once moved apart by the reveal. */
function namedIn(op: Op): string[] {
  if (op.t === "token.moveMany") return op.moves.map((m) => m.tokenId);
  if (op.t === "token.attach") return [op.tokenId, op.to];
  return "tokenId" in op && typeof op.tokenId === "string" ? [op.tokenId] : [];
}

function namedBy(step: Step): string[] {
  if ("restore" in step) return [];
  return [...namedIn(step.op), ...(step.opB ? namedIn(step.opB) : [])];
}

/** A step by the DM or a player, written from what that viewer's own copy holds, as a device never builds some of them. */
function rawStep(r: () => number, state: RoomState, apart: ReadonlySet<string>): Step {
  const who = pick(r, [DM, P1, P1, P2]);
  const view = deviceCopy(state, who);
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
 * What a lone drag shows: the fields its frames carry to the other devices
 * (stageHooks.ts frameFields), where the board holds the token, and on a
 * player's board the whole picture, its line, its label and its words. The
 * DM's own picture reads what only the DM sees, so only what it sends is
 * compared.
 */
type Frame = { sent: Drag["frame"] | GroupDrag["frame"]; to?: { x: number; y: number }; picture?: Drag["preview"] | GroupDrag["label"] };

function frameOf(drag: Drag, who: Viewer): Frame {
  return { sent: drag.frame, to: drag.preview.to, ...(who.role === "player" ? { picture: drag.preview } : {}) };
}

/** The same for a group drag: what its lead's frames send, and on a player's board its label. */
function groupFrameOf(drag: GroupDrag, who: Viewer): Frame {
  return { sent: drag.frame, ...(who.role === "player" ? { picture: drag.label } : {}) };
}

/** What each room's device builds for the same gesture, from the actor's copy of each: null where it sends nothing. */
type Built = {
  what: "drag" | "group" | "attach" | "getOff";
  a: Op | null;
  b: Op | null;
  frames?: [Frame, Frame];
  /** A group drag's lead and the cost its label reads in each room, which must be what the reducer stores (review AT-ASTRA-15). */
  costs?: { lead: string; ft: [number | null, number | null] };
  /**
   * The DM's Get off, whose place may differ by what only the DM sees, and
   * by nothing else: it avoids every creature the viewer sees (4.3), and
   * lies beside the holder, which may be one no player sees. True where the
   * holder is such a one in either room, or where the places built with no
   * creature some player cannot see agree.
   */
  dmSees?: boolean;
};

/**
 * A gesture by the DM or a player, made on the same token, spot or row in
 * both rooms and built by the device's own planners from the actor's copy
 * of each: a lone drag of the token the board moves for a press
 * (groups.ts dragLead), a drag of two, an attach from the Attach list, or
 * the detach the carried token's bar offers.
 */
function builtStep(r: () => number, a: RoomState, b: RoomState, apart: ReadonlySet<string>): { who: Viewer; built: Built } | null {
  const who = pick(r, [DM, P1, P1, P2]);
  const copies = [deviceCopy(a, who), deviceCopy(b, who)] as const;
  const tokens = Object.values(copies[0].tokens).filter((t) => !apart.has(t.id) && t.id !== "lurker" && (who.role === "player" || t.visibility !== "dm"));
  if (tokens.length === 0) return null;
  const n = r();
  if (n < 0.45) {
    // The DM's drag, half the time, of a token on a holder some player cannot see in either room, whose drop must land it as
    // in a room without that holder (8.0, the landings).
    const onHidden = who.role === "dm" ? tokens.filter((t) => underHiddenHolder(a, t.id) || underHiddenHolder(b, t.id)) : [];
    const lead = dragLead(copies[0].tokens, onHidden.length > 0 && chance(r, 0.5) ? pick(r, onHidden) : pick(r, tokens));
    const far = chance(r, 0.3) ? 6 : 3;
    const raw = { x: nearBy(r, lead.x, far), y: nearBy(r, lead.y, far) };
    const drags = copies.map((copy) => (copy.tokens[lead.id] ? dragOf(copy, who.role, lead.id, raw) : null));
    const [da, db] = drags;
    return { who, built: { what: "drag", a: (da?.op as Op | null | undefined) ?? null, b: (db?.op as Op | null | undefined) ?? null, ...(da && db ? { frames: [frameOf(da, who), frameOf(db, who)] } : {}) } };
  }
  if (n < 0.58) {
    // Half the time led by the creature whose turn it is, so its label is checked against what its move stores.
    const mover = tokens.find((t) => t.id === turnMoverId(copies[0]));
    const first = dragLead(copies[0].tokens, mover && chance(r, 0.5) ? mover : pick(r, tokens));
    const second = dragLead(copies[0].tokens, pick(r, tokens));
    if (first.id === second.id) return null;
    const dx = int(r, -3, 3);
    const dy = int(r, -3, 3);
    // As the board drags them (dragTesting.ts groupDragOf), by the same offset from where each copy has the lead: its plan,
    // its lead's label and the cost its frames send.
    const [ga, gb] = copies.map((copy): GroupDrag | null => {
      const lead = copy.tokens[first.id];
      if (!lead || !copy.tokens[second.id] || carriedGroup(copy.tokens, first.id).includes(second.id) || carriedGroup(copy.tokens, second.id).includes(first.id)) return null;
      return groupDragOf(copy, who.role, [first.id, second.id], { x: lead.x + dx, y: lead.y + dy });
    });
    return {
      who,
      built: {
        what: "group",
        a: (ga?.op as Op | null | undefined) ?? null,
        b: (gb?.op as Op | null | undefined) ?? null,
        ...(ga && gb ? { frames: [groupFrameOf(ga, who), groupFrameOf(gb, who)] as [Frame, Frame] } : {}),
        costs: { lead: first.id, ft: [ga?.label.dragFt ?? null, gb?.label.dragFt ?? null] },
      },
    };
  }
  if (n < 0.82) {
    // A token whose list offers something, as the bar shows Attach only then.
    const listed = tokens.map((t) => ({ selected: t, rows: attachRows(copies[0], who, t.id) })).filter((x) => x.rows.length > 0);
    if (listed.length === 0) return null;
    const { selected, rows } = pick(r, listed);
    const key = pick(r, rows).key;
    const steer = chance(r, 0.5);
    const [oa, ob] = copies.map((copy) => {
      const row = attachRows(copy, who, selected.id).find((x) => x.key === key);
      return row ? (attachOp(row, steer) as Op) : null;
    });
    return { who, built: { what: "attach", a: oa!, b: ob! } };
  }
  const offers = (copy: RoomState, t: Token | undefined): t is Token => t !== undefined && barSlots(copy, who, t).includes("detach");
  const carried = tokens.filter((t) => offers(copies[0], t));
  if (carried.length === 0) return null;
  const id = pick(r, carried).id;
  const off = (copy: RoomState): Op | null => {
    const t = copy.tokens[id];
    if (!offers(copy, t)) return null;
    if (detachChoice(copy.tokens, t) !== "getOff") return detachOp(id, null) as Op;
    // No room to get off: the bar says so and sends nothing.
    const place = getOffPlace(copy, who, t);
    return place ? (detachOp(id, place) as Op) : null;
  };
  const [oa, ob] = copies.map(off);
  if (who.role === "player") return { who, built: { what: "getOff", a: oa!, b: ob! } };
  const seenBy = copies.map((copy) => {
    const t = copy.tokens[id];
    const own = new Set([...(t ? carriedGroup(copy.tokens, id) : []), ...(t?.attached ? [t.attached.to] : [])]);
    const tokens = Object.fromEntries(Object.entries(copy.tokens).filter(([k, x]) => own.has(k) || x.kind === "object" || inSightOfNonOwners(copy, x, {})));
    return off({ ...copy, tokens });
  });
  return { who, built: { what: "getOff", a: oa!, b: ob!, dmSees: underHiddenHolder(a, id) || underHiddenHolder(b, id) || isSame(seenBy[0], seenBy[1]) } };
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

/** Whether a token's own holder is one some player cannot see. */
function underHiddenHolder(state: RoomState, id: string): boolean {
  const token = state.tokens[id];
  const holder = token ? (holderOf(state.tokens, token) as Token | undefined) : undefined;
  return holder !== undefined && !inSightOfNonOwners(state, holder, {});
}

/** Whether a visible party member would ride a holder some player cannot see, which the reveal would carry apart. */
function partyOnHidden(state: RoomState, carriedId: string, holderId: string): boolean {
  const carried = state.tokens[carriedId];
  const holder = state.tokens[holderId];
  return carried !== undefined && holder !== undefined && carried.visibility !== "dm" && isPartyMember(state, carried) && !inSightOfNonOwners(state, holder, {});
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

/** The links up from a token, as the room holds them: two rooms that agree on these and on every copy of it agree on the token. */
function chainOf(state: RoomState, id: string): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (let t = state.tokens[id]; t && !seen.has(t.id); t = holderOf(state.tokens, t) as Token | undefined) {
    seen.add(t.id);
    out.push([t.id, t.attached ?? null, t.visibility ?? null]);
  }
  return out;
}

const POSE = ["sceneId", "x", "y", "elevation"] as const;

/** What the tokens apart and the tokens the DM changed unseen are, kept for the run. */
type Marks = {
  /** Moved apart by the reveal, and not compared until the rooms agree on it again. */
  apart: Set<string>;
  /** Ever apart: a step made while it was apart holds where each room had it. */
  ever: Set<string>;
  /**
   * Changed by one of the DM's unseen ops in room b, or moved apart by the
   * reveal while no player saw it: only such a token may come into sight
   * differing.
   */
  touched: Set<string>;
};

/** Whether a log line names a token apart, or a turn of one, which shows where each room has the token in sight. */
function logOnApart(entry: RoomState["log"][number], rooms: readonly RoomState[], apart: ReadonlySet<string>): boolean {
  const data = entry.data;
  if (!data) return false;
  if ("tokenId" in data && data.tokenId !== undefined && apart.has(data.tokenId)) return true;
  if (data.type !== "turn") return false;
  const rows = [data.entryId, data.to].filter((id) => id !== undefined);
  return rooms.some((s) => s.encounter?.entries.some((e) => rows.includes(e.id) && e.tokenId !== undefined && apart.has(e.tokenId)) === true);
}

/**
 * The encounter as compared: a turn that starts on a token moved apart
 * starts where each room has it, and a row of a token apart shows where
 * each room has the token in sight.
 */
function comparedEncounter(encounter: RoomState["encounter"], apart: ReadonlySet<string>): RoomState["encounter"] {
  if (!encounter) return encounter;
  // Numbered again, since a player's tracker numbers only the rows they see.
  const entries = encounter.entries.filter((e) => e.tokenId === undefined || !apart.has(e.tokenId)).map((e, i) => ({ ...e, tieOrder: i }));
  const start = encounter.turnStart;
  return { ...encounter, entries, ...(start && apart.has(start.tokenId) ? { turnStart: { ...start, x: 0, y: 0, elevation: 0 } } : {}) };
}

/**
 * Every player's copies of the two rooms, compared, and the tokens each may
 * drag. A token apart in its place, with something hidden above it in
 * either room, is the reveal and joins `apart`, and so does one in
 * `mayPart`, a step made while it was apart put back. Any other difference,
 * a cost or a path on the same spot included, fails. A token apart that
 * both rooms hold alike again, its links up and every player's copy, is
 * compared again from here.
 */
function compare(a: { before: RoomState; after: RoomState }, b: { before: RoomState; after: RoomState }, marks: Marks, mayPart: ReadonlySet<string>, where: string): number {
  const { apart } = marks;
  let rejoined = 0;
  for (const id of [...apart]) {
    // Alike links up from it, or none hidden above it in either room, so what moves it from here is what every player sees.
    if (!isSame(chainOf(a.after, id), chainOf(b.after, id)) && (underHidden(a.after, id) || underHidden(b.after, id))) continue;
    if ([P1, P2].every((who) => isSame(copyOf(a.after, who).tokens[id], copyOf(b.after, who).tokens[id]))) {
      apart.delete(id);
      rejoined++;
    }
  }
  // A token the reveal moved apart where no player sees it comes into sight later as each room moved it.
  for (const id of Object.keys(a.after.tokens)) {
    const [ta, tb] = [a.after.tokens[id], b.after.tokens[id]];
    if (!ta || !tb || !POSE.some((f) => ta[f] !== tb[f]) || [P1, P2].some((who) => copyOf(a.after, who).tokens[id] || copyOf(b.after, who).tokens[id])) continue;
    if ([a.before, a.after, b.before, b.after].some((s) => underHidden(s, id))) marks.touched.add(id);
  }
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
        // A token the DM changed unseen, or the reveal moved unseen, that neither room showed this player before the step comes
        // into sight as each room left it, and so does a link to a holder coming into sight, where the one or the other was.
        const unshown = (key: string) => was.every((c) => c.tokens[key] === undefined);
        const linkOnly = ta !== undefined && tb !== undefined && isSame({ ...ta, attached: undefined }, { ...tb, attached: undefined });
        const holders = [ta, tb].flatMap((t) => (t?.attached ? [t.attached.to] : []));
        const shown = (marks.touched.has(id) && unshown(id)) || (linkOnly && holders.some(unshown) && [id, ...holders].some((x) => marks.touched.has(x)));
        assert.ok((moved && reveal) || onApart || shown || mayPart.has(id), `${where}: ${who.memberId} sees ${id} differ: ${JSON.stringify(ta)} against ${JSON.stringify(tb)}`);
        apart.add(id);
        marks.ever.add(id);
      }
    }
    // A drag's frames go out only for a token the player may move: no hidden holder lends that right (8.0). A mount whose
    // rider is apart is steered or not as each room has the rider.
    const ridden = new Set([a.after, b.after].flatMap((s) => [...apart].flatMap((x) => (s.tokens[x]?.attached ? [s.tokens[x]!.attached!.to] : []))));
    for (const id of Object.keys(ca.tokens)) {
      if (apart.has(id) || ridden.has(id) || !cb.tokens[id]) continue;
      assert.equal(mayMoveToken(a.after, who, id).ok, mayMoveToken(b.after, who, id).ok, `${where}: ${who.memberId} may drag ${id} in one room alone`);
    }
    const rest = (c: RoomState) => {
      const { tokens: _tokens, ...others } = c;
      return { ...others, encounter: comparedEncounter(others.encounter, apart), log: others.log.filter((e) => !logOnApart(e, [a.after, b.after], apart)) };
    };
    assert.deepEqual(rest(ca), rest(cb), `${where}: ${who.memberId} sees the rest of the rooms differ`);
  }
  return rejoined;
}

/** A player's socket on a room: the room's fan-out sends it `ev`s, which build its copy from the snapshot. */
type Feed = { who: Viewer; conn: Connection; view: ProjectedState; inbox: ServerMessage[]; changes: Change[] };

function feedsOf(state: RoomState): Feed[] {
  return [P1, P2].map((who) => {
    const inbox: ServerMessage[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
    const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "HIDDEN00", memberId: who.memberId!, role: who.role }, "203.0.113.4");
    conn.sceneId = "s1";
    const snapshot = buildSnapshot(state, 0, conn, 0);
    conn.held = snapshot.held;
    return { who, conn, view: snapshot.message.state as ProjectedState, inbox, changes: [] };
  });
}

/** The room's fan-out of the op the table just applied, if one did, as the actor publishes a batch. */
function publish(t: UndoTable, feeds: readonly Feed[]): void {
  const last = t.last;
  if (!last) return;
  publishBatch({ seq: t.seq, before: last.before, after: t.state, touched: last.applied.touched, global: last.applied.global, acks: new Map(), rejects: new Map(), restored: new Map() }, feeds.map((f) => f.conn), () => undefined);
  for (const f of feeds) {
    for (const msg of f.inbox.splice(0)) {
      if (msg.t !== "ev") continue;
      f.view = applyChanges(f.view, msg.changes as Change[]);
      f.changes.push(...(msg.changes as Change[]));
    }
  }
}

/**
 * The `ev` changes each player got from the two rooms since the last
 * look, compared, and each socket's copy against a fresh projection of its
 * room. A token apart is left out, and so are its log lines and the
 * tracker while a row's or the turn's token is apart.
 */
function compareFeeds(fa: readonly Feed[], fb: readonly Feed[], a: RoomState, b: RoomState, apart: ReadonlySet<string>, where: string): void {
  // The tracker's own change too while a row's or the turn's token is apart: it goes out where that token's row changes.
  const rowApart = [a, b].some((s) => s.encounter !== null && (s.encounter.entries.some((e) => e.tokenId !== undefined && apart.has(e.tokenId)) || (s.encounter.turnStart !== undefined && apart.has(s.encounter.turnStart.tokenId))));
  const lines = new Map([a, b].flatMap((s) => s.log.map((e) => [keys.log(e.id), e] as const)));
  const sent = (f: Feed) =>
    f.changes
      .filter((c) => !(c.key.startsWith("token:") && apart.has(c.key.slice("token:".length))) && !(c.key === keys.encounter && rowApart))
      .filter((c) => !(c.key.startsWith("log:") && lines.has(c.key) && logOnApart(lines.get(c.key)!, [a, b], apart)))
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (let i = 0; i < fa.length; i++) {
    const [x, y] = [fa[i]!, fb[i]!];
    assert.deepEqual(sent(x), sent(y), `${where}: ${x.who.memberId} receives other changes from the two rooms`);
    // The tokens, the tracker and the log, which links and turns change: the map's own keys have the fan-out tests (fanout.test.ts).
    // Each value as JSON, as the socket carries it, which keeps the projection's own order of fields.
    for (const [f, state] of [[x, a], [y, b]] as const) {
      const view = f.view as unknown as RoomState;
      const fresh = copyOf(state, f.who);
      for (const id of new Set([...Object.keys(view.tokens), ...Object.keys(fresh.tokens)])) {
        assert.equal(JSON.stringify(view.tokens[id]), JSON.stringify(fresh.tokens[id]), `${where}: ${f.who.memberId}'s socket copy of ${id} drifts from the room`);
      }
      assert.equal(JSON.stringify([view.encounter, view.log]), JSON.stringify([fresh.encounter, fresh.log]), `${where}: ${f.who.memberId}'s socket copy of the tracker or the log drifts from the room`);
      f.changes = [];
    }
  }
}

const NEUTRAL: Op = { t: "token.update", tokenId: "lurker", patch: { notes: "" } };

/** What a run reached, so the totals can say the generator tests the cases it is for. */
type Seen = {
  unseen: number;
  compared: number;
  restores: number;
  restoresCompared: number;
  restoresApart: number;
  parted: number;
  brokenLinks: number;
  chains: number;
  /** Steps built by the device's planners, those by a player, and those by the DM whose two ops were compared. */
  built: number;
  builtByPlayers: number;
  dmBuiltCompared: number;
  /** The DM's gestures built in one room alone, by a link or a token only the DM sees: the DM's answer, not taken. */
  dmOneRoom: number;
  /** The DM's Get offs placed apart by a creature or a holder only the DM sees (4.3): not taken. */
  dmSees: number;
  /** Player attaches from the Attach list and Get offs from the bar, and how many the room took. */
  attaches: number;
  attachesTaken: number;
  getOffs: number;
  getOffsTaken: number;
  /** Drag frames compared between the rooms. */
  frames: number;
  /** Group drags whose lead's label was checked against the cost the move stored. */
  groupCosts: number;
  /** A turn of a creature some player cannot see, riding a mount every player sees under its control. */
  hiddenRiderTurns: number;
  /** Trackers the DM's undo left apart, made alike by hand. */
  trackersApart: number;
  /** Tokens ever apart, and those the rooms came to agree on again. */
  everApart: number;
  rejoined: number;
};

const ZERO: Seen = { unseen: 0, compared: 0, restores: 0, restoresCompared: 0, restoresApart: 0, parted: 0, brokenLinks: 0, chains: 0, built: 0, builtByPlayers: 0, dmBuiltCompared: 0, dmOneRoom: 0, dmSees: 0, attaches: 0, attachesTaken: 0, getOffs: 0, getOffsTaken: 0, frames: 0, groupCosts: 0, hiddenRiderTurns: 0, trackersApart: 0, everApart: 0, rejoined: 0 };

/** One run: its seed and the steps it took. */
function run(seed: number, steps = 70): Seen {
  const r = rng(seed);
  const start = world(r);
  let a = new UndoTable(deepClone(start.state));
  let b = new UndoTable(deepClone(start.state));
  a.seq = b.seq = 100;
  let fa = feedsOf(a.state);
  let fb = feedsOf(b.state);
  const marks: Marks = { apart: new Set(), ever: new Set(), touched: new Set() };
  const { apart } = marks;
  const seen: Seen = { ...ZERO, chains: start.chain ? 1 : 0 };
  let where = "";
  /** The DM's unseen change in room b, kept only when no player's copy changes, with a neutral edit in room a. */
  const unseen = (focus?: ReadonlySet<string>, tracker = false): Op | null => {
    const op = unseenOp(r, b.state, start.vision, focus, tracker);
    if (!op) return null;
    const trial = applyOp(b.state, op, DM, env(b.seq + 1));
    if (!trial.ok || [P1, P2].some((p) => !isSame(copyOf(trial.state, p), copyOf(b.state, p)))) return null;
    const before = b.state;
    assert.equal(b.play(DM, op), "ok", `${where}: the unseen ${op.t}`);
    for (const id of new Set([...Object.keys(before.tokens), ...Object.keys(b.state.tokens)])) if (before.tokens[id] !== b.state.tokens[id]) marks.touched.add(id);
    publish(b, fb);
    assert.equal(a.play(DM, NEUTRAL), "ok");
    publish(a, fa);
    // Nothing reaches a player: no change at all, not even one that leaves their copy as it was.
    for (const f of [...fa, ...fb]) assert.deepEqual(f.changes, [], `${where}: the unseen ${op.t} sends ${f.who.memberId} changes`);
    seen.unseen++;
    return op;
  };
  /**
   * Whether a player's undo or redo would put back, by its own answer, a
   * token moved apart or a link to one, or a token as it stood while apart.
   * Only a token the step named answers so, or a passenger the step kept
   * loud that nothing hidden carries in either room now. A passenger the
   * step kept silent never answers, even once the hidden holder that made
   * it silent is gone. And a loud mark under something hidden is not
   * trusted, since the marks are what the test is for: that passenger's
   * answer is compared.
   * The second set: the tokens the restore puts back as each room held
   * them while apart, which may come out apart again.
   */
  const putsBackApart = (step: Step): { back: boolean; mayPart: Set<string> } => {
    const mayPart = new Set<string>();
    if (!("restore" in step)) return { back: false, mayPart };
    const tops = [a, b].map((t) => t.stacks.peek(step.who.memberId, step.restore));
    const valued = tops.map((top) => new Map((top?.entries ?? []).map((e) => [e.key, e.value])));
    const posed = tops.map((top) => (top?.poses ?? {}) as Record<string, Pose>);
    const loud = (id: string, pose: Pose) => pose.root === true || (pose.silent !== true && ![a.state, b.state].some((s) => underHidden(s, id)));
    for (const id of marks.ever) if (!isSame([posed[0]![id], valued[0]!.get(`token:${id}`)], [posed[1]![id], valued[1]!.get(`token:${id}`)])) mayPart.add(id);
    const back = posed.some((poses, i) =>
      Object.entries(poses).some(([id, pose]) => {
        if (!loud(id, pose)) return false;
        const value = valued[i]!.get(`token:${id}`);
        const to = value && typeof value === "object" ? (value as Token).attached?.to : undefined;
        return apart.has(id) || mayPart.has(id) || (to !== undefined && apart.has(to));
      }),
    );
    return { back, mayPart };
  };
  /** Both rooms back to before a step whose answers parted them, the stacks cleared alike and the sockets opened afresh. */
  const part = (before: { a: RoomState; b: RoomState }) => {
    const seq = a.seq;
    a = new UndoTable(before.a);
    b = new UndoTable(before.b);
    a.seq = b.seq = seq;
    fa = feedsOf(a.state);
    fb = feedsOf(b.state);
    seen.parted++;
  };
  /**
   * Whether the DM's newest undo or redo step is one both rooms took alike:
   * the same words over the same entities. One the DM took unseen in room b
   * alone, the neutral edit in room a in its place, may be taken back or
   * put back only by the tracker's own rule in `run`, since the change it
   * restores may be one every player sees by now.
   */
  const alike = (which: "undo" | "redo"): boolean => {
    const x = a.stacks.peek(DM.memberId!, which);
    const y = b.stacks.peek(DM.memberId!, which);
    const keysOf = (e: NonNullable<typeof x>) => e.entries.map((n) => n.key).sort();
    return x !== null && y !== null && x.label === y.label && isSame(keysOf(x), keysOf(y)) && !keysOf(x).includes(keys.token("lurker"));
  };
  /** The same step in both rooms, compared. Where the DM's answers part the rooms, both go back to before it. */
  const shared = (step: Step, built?: Built["what"], unseenBack = false): void => {
    if (step.who.role === "player" && namedBy(step).some((id) => apart.has(id))) return;
    if (step.who.role === "dm" && "restore" in step && !unseenBack && !alike(step.restore)) return;
    // On a scene of the party's sight, no visible party member gets on a holder some player cannot see (world's note).
    if (start.vision && "op" in step && [step.op, step.opB].some((op) => op?.t === "token.attach" && [a.state, b.state].some((s) => partyOnHidden(s, op.tokenId, op.to)))) return;
    const before = { a: a.state, b: b.state };
    const restoring = putsBackApart(step);
    const apartBack = restoring.back;
    const answer = (t: UndoTable, op: Op | undefined) => ("restore" in step ? (step.restore === "undo" ? t.undo(step.who) : t.redo(step.who)) : t.play(step.who, op!));
    const ra = answer(a, "op" in step ? step.op : undefined);
    publish(a, fa);
    const rb = answer(b, "op" in step ? (step.opB ?? step.op) : undefined);
    publish(b, fb);
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
      if (built === "attach") {
        seen.attaches++;
        if (ra === "ok") seen.attachesTaken++;
      }
      if (built === "getOff") {
        seen.getOffs++;
        if (ra === "ok") seen.getOffsTaken++;
      }
    }
    // The DM's own answer may read what the DM knows. Where it parts the rooms, both go back to before the step, with the
    // stacks cleared alike, and the run goes on.
    if (step.who.role === "dm" && ra !== rb) return part(before);
    // So may an undo or a redo that puts back a token moved apart, whose answer reads where every player sees it stand.
    if (apartBack && ra !== rb) return part(before);
    // A link a step broke on the way, a drag stopped at a wall among them: the passengers its undo must still class by its plan.
    if (!("restore" in step) && Object.values(before.b.tokens).some((t) => t.attached && b.state.tokens[t.id] && !b.state.tokens[t.id]!.attached)) seen.brokenLinks++;
    const at = `${where} (${step.who.memberId}'s ${label})`;
    // A token that comes back from apart this step got its own changes in one room alone, as it stood apart there.
    const apartBefore = new Set(apart);
    seen.rejoined += compare({ before: before.a, after: a.state }, { before: before.b, after: b.state }, marks, restoring.mayPart, at);
    compareFeeds(fa, fb, a.state, b.state, new Set([...apartBefore, ...apart]), at);
    const turn = b.state.encounter?.turnStart;
    const rider = turn ? b.state.tokens[turn.tokenId] : undefined;
    const mount = rider ? (holderOf(b.state.tokens, rider) as Token | undefined) : undefined;
    if (rider && mount && rider.attached?.steer && !inSightOfNonOwners(b.state, rider, {}) && inSightOfNonOwners(b.state, mount, {})) seen.hiddenRiderTurns++;
  };
  /**
   * A gesture both rooms' devices built. A player's copies are alike but
   * for tokens apart, so are the ops and the frames, and a gesture whose
   * ops a token apart parted is not taken. The DM's ops for tokens every
   * player sees must be alike too, and so must their frames, which every
   * player receives. Where the DM's device builds an op in one room alone,
   * a row the DM's own limits drop or a Get off with no room, the DM's
   * answer parts the rooms and the step is not taken. Otherwise each room
   * takes its own.
   */
  const builtShared = (who: Viewer, step: Built): void => {
    if (!step.a && !step.b) return;
    const same = isSame(step.a, step.b) && (!step.frames || isSame(step.frames[0], step.frames[1]));
    const named = [step.a, step.b].flatMap((op) => (op ? namedIn(op) : []));
    const publicNamed = named.every((id) => [a.state, b.state].every((s) => s.tokens[id] !== undefined && inSightOfNonOwners(s, s.tokens[id]!, {})));
    if (!same) {
      if (who.role === "dm" && (!step.a || !step.b)) {
        seen.dmOneRoom++;
        return;
      }
      if (step.dmSees) {
        seen.dmSees++;
        return;
      }
      const what = `${where}: ${who.memberId}'s ${step.what} builds ${JSON.stringify(step.a)} against ${JSON.stringify(step.b)}${step.frames ? `, frames ${JSON.stringify(step.frames[0])} against ${JSON.stringify(step.frames[1])}` : ""}`;
      assert.ok(apart.size > 0 || (who.role === "dm" && !publicNamed), what);
      if (who.role === "player" || publicNamed || !step.a || !step.b) return;
      // On a scene of the party's sight, a visible party member sent apart moves what the whole party sees (world's note).
      if (start.vision && named.some((id) => [a.state, b.state].some((s) => s.tokens[id] !== undefined && s.tokens[id]!.visibility !== "dm" && isPartyMember(s, s.tokens[id]!)))) return;
      seen.built++;
      shared({ who, op: step.a, opB: step.b }, step.what);
      return;
    }
    if (step.frames) seen.frames++;
    if (who.role === "dm" && publicNamed) seen.dmBuiltCompared++;
    seen.built++;
    if (who.role === "player") seen.builtByPlayers++;
    const costs = step.costs;
    const pathsBefore = [a.state, b.state].map((s) => (costs ? (s.tokens[costs.lead]?.path?.stops.length ?? 0) : 0));
    shared({ who, op: step.a! }, step.what);
    // The lead's label reads the cost the move stores on its turn, a dismount included, in each room.
    if (costs)
      [a.state, b.state].forEach((s, i) => {
        const stops = s.tokens[costs.lead]?.path?.stops ?? [];
        if (stops.length <= pathsBefore[i]! || costs.ft[i] === null) return;
        const stored = stops.slice(pathsBefore[i]).reduce((sum, st) => sum + (st.cost ?? 0), 0);
        assert.equal(costs.ft[i], stored, `${where}: ${who.memberId}'s group label reads ${costs.ft[i]} ft where room ${i === 0 ? "a" : "b"} stores ${stored} for ${JSON.stringify(step.a)}`);
        seen.groupCosts++;
      });
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
      else if (chance(r, 0.5)) {
        // Half the time as the board drags it, its route searched round the walls.
        const drags = [a.state, b.state].map((s) => dragOf(copyOf(s, who), "player", root.id, to));
        builtShared(who, { what: "drag", a: (drags[0]!.op as Op | null) ?? null, b: (drags[1]!.op as Op | null) ?? null, frames: [frameOf(drags[0]!, who), frameOf(drags[1]!, who)] });
      } else shared({ who, op: { t: "token.move", tokenId: root.id, ...to } });
      const rooted = b.state.tokens[root.id];
      const group = new Set([...carriedGroup(b.state.tokens, root.id), ...carriedGroup(b.state.tokens, (rooted && holderOf(b.state.tokens, rooted)?.id) ?? root.id)]);
      for (const id of [...group]) for (const t of Object.values(b.state.tokens)) if (t.attached?.to === id) group.add(t.id);
      // A change to the tracker only off a scene of the party's sight, where an undo's move can bring a row into sight before the
      // DM takes the change back.
      const change = unseen(group, !start.vision);
      // The DM may lock the token, or take the passenger it named from the player, so the undo needs a right of its own.
      const locks = chance(r, 0.4);
      if (locks) shared({ who: DM, op: rider && chance(r, 0.5) ? { t: "token.update", tokenId: rider.id, patch: { ownerIds: [] } } : { t: "token.update", tokenId: root.id, patch: { locked: chance(r, 0.8) } } });
      for (const restore of ["undo", "redo", "undo"] as const) shared({ who, restore });
      // The DM takes a change to the tracker back in both rooms, the neutral edit in room a, so both trackers are alike again.
      if (change?.t.startsWith("encounter.")) {
        for (let k = locks ? 2 : 1; k > 0; k--) shared({ who: DM, restore: "undo" }, undefined, k === 1);
        // Nor does a later redo of the DM's put the change back in room b alone.
        for (const t of [a, b]) while (t.stacks.popRedo(DM.memberId!)) continue;
        if (!isSame(a.state.encounter, b.state.encounter)) {
          // Where that fails, room b takes room a's tracker, which every player's copy shows alike already: with whose turn it
          // is apart, a move would record its path by each room's own turn.
          seen.trackersApart++;
          b.state = { ...b.state, encounter: a.state.encounter };
        }
      }
      continue;
    }
    // An undo or a redo now and then by anyone, of whatever step is newest, a device's own steps among them.
    if (roll < 0.45) {
      shared({ who: pick(r, [DM, P1, P1, P2]), restore: chance(r, 0.6) ? "undo" : "redo" });
      continue;
    }
    if (roll < 0.66) {
      shared(rawStep(r, a.state, apart));
      continue;
    }
    const step = builtStep(r, a.state, b.state, apart);
    if (step) builtShared(step.who, step.built);
  }
  seen.everApart = marks.ever.size;
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
  test("random chains, walls, fog and sight, and random steps by the DM and both players built on their own copies, in pairs of rooms that differ only unseen", () => {
    const total: Seen = { ...ZERO };
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
    // And the devices' own steps: player attaches and Get offs the room takes, the DM's ops and frames compared, and turns
    // of a hidden rider on a mount every player sees.
    assert.ok(total.attachesTaken > 25 * per60 && total.getOffsTaken > 40 * per60 && total.dmBuiltCompared > 150 * per60 && total.frames > 600 * per60 && total.groupCosts > 30 * per60 && total.hiddenRiderTurns > 60 * per60, summary);
    if (process.env.ATTACH_RANDOM_SEEDS) console.log(summary);
  });
});
