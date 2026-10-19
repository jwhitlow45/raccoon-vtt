import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readEntity, type EntityKey } from "#shared/keys.ts";
import type { AttachKind, CreatureSize, Encounter, InitEntry, RoomState, Token, Viewer } from "#shared/model.ts";
import { inSightOfNonOwners } from "#shared/project.ts";
import { MAX_PATH_STOPS, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { sharesTurn } from "#shared/reducer/tokens.ts";
import { ATTACH_KINDS, carriedGroup, getOffSpot, holderOf, linkHolds, seatSpot } from "#shared/rules/attach.ts";
import { describeMove, planMove } from "#shared/rules/moveLeg.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { DM, P1, P2, actor, chance, effect, env, int, pick, reveal, rng, room, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * The randomized test of attached tokens (docs/design-v1-attach.md 13):
 * attach, detach, holder and carried moves, resizes, deletes, teleports,
 * scene changes, Next, Previous, undos and redos, and visibility flips of
 * riders and mounts (hide, reveal, fog), by the DM and two players through
 * the room actor's own checks (undoTesting.ts). After every step it checks
 * the invariants below, each by name, and at the end of a run that the
 * stored ops replay to the same room.
 */

const INVARIANTS = {
  links: "no link spans scenes or reach, and every carried token fits its holder",
  groups: "no group goes past its scene's tokens, and an op moves each token at most once",
  plan: "describeMove equals planMove: the reducer put every token where the plan said",
  recordsOnce: "no controlled mount records movement on two turns in one round unless a new qualifying mounting came between",
  sharesJoined: "a mount shares only a turn whose list it joined at a qualifying event",
  restoreWhole: "every restore applies whole or refuses",
  replay: "replaying the stored ops rebuilds the same state",
  pathBound: "no path holds more stops than the room keeps",
} as const;

type Invariant = keyof typeof INVARIANTS;

function holds(name: Invariant, ok: boolean, where: string, detail = ""): void {
  assert.ok(ok, `${INVARIANTS[name]} (${name}), ${where}${detail ? `: ${detail}` : ""}`);
}

const SIZES: readonly CreatureSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const IDS = ["thorn", "bree", "horse", "pony", "gob", "ogre", "imp", "owl", "cart", "torch"] as const;

/** The table, nearly all within a few squares, in a fight that has started on Thorn's turn. */
function world(r: () => number): RoomState {
  const state = room({
    tokens: {
      thorn: token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 2, y: 6 }),
      bree: token("bree", { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p2"], x: 3, y: 8 }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: ["p1"], x: 2, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      pony: token("pony", { name: "Pony", kind: "npc", size: "large", disposition: "ally", x: 5, y: 6, actor: { inline: actor({ speeds: { walk: 40 } }) } }),
      gob: token("gob", { name: "Goblin", size: "small", x: 4, y: 7, actor: { inline: actor({ effects: [effect("g", { key: "grappled", ...(chance(r, 0.3) ? { hiddenFromPlayers: true } : {}) })] }) } }),
      ogre: token("ogre", { name: "Ogre", size: "large", x: 7, y: 8 }),
      imp: token("imp", { name: "Imp", size: "tiny", x: 3, y: 5, visibility: chance(r, 0.5) ? "dm" : "all" }),
      owl: token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p1"], x: 2.5, y: 6.5 }),
      cart: token("cart", { name: "Cart", kind: "object", size: "large", x: 8, y: 4 }),
      torch: token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 2.5, y: 7 }),
    },
  });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen", "euclid"] as const), playersMoveAny: pick(r, ["none", "all", ["p1"]] as const), revealHiddenOnTurn: chance(r, 0.5) };
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: chance(r, 0.6), autoWalls: "off" };
  if (chance(r, 0.6)) {
    const edges: Record<string, { kind: "wall" }> = {};
    for (let y = 0; y < 6; y++) edges[`10,${y},w`] = { kind: "wall" };
    for (let x = 4; x < 7; x++) edges[`${x},11,n`] = { kind: "wall" };
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
  }
  // Fog that leaves a strip along the west unseen, when the DM turns it on.
  reveal(state, "s1", { x: 2, y: 0, w: 40, h: 40 });
  if (chance(r, 0.4)) state.tokens.thorn = { ...state.tokens.thorn!, x: 2, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
  return state;
}

function startFight(r: () => number): Step[] {
  const rows = ["thorn", "bree", "horse", "pony", "gob", "ogre"].map((id, i) => ({ id: `e${id}`, tokenId: id, value: 20 - i * 2 - (chance(r, 0.3) ? 1 : 0) }));
  return [
    { who: DM, op: { t: "encounter.start", entries: rows } },
    { who: DM, op: { t: "encounter.next" } },
  ];
}

type Step = { who: Viewer; op: Op } | { who: Viewer; restore: "undo" | "redo" };

const near = (r: () => number, v: number, by = 4) => Math.max(0, Math.min(24, v + int(r, -by, by)));

/** One step for this room, mostly ones that make, use or end links. */
function nextStep(r: () => number, state: RoomState): Step {
  const roll = r();
  const who = roll < 0.5 ? DM : roll < 0.75 ? P1 : P2;
  const tokens = Object.values(state.tokens);
  const anyId = () => (tokens.length > 0 && chance(r, 0.95) ? pick(r, tokens).id : pick(r, IDS));
  const carriedOnes = tokens.filter((x) => x.attached);
  const holders = tokens.filter((x) => tokens.some((y) => y.attached?.to === x.id));
  const encounter = state.encounter;
  // Mounted combat, often: the turn's creature gets on a mount, or moves the one it directs.
  const acting = encounter?.turnStart ? state.tokens[encounter.turnStart.tokenId] : undefined;
  if (acting && chance(r, 0.15)) {
    const owner = acting.ownerIds?.[0] === "p1" ? P1 : acting.ownerIds?.[0] === "p2" ? P2 : DM;
    const by = chance(r, 0.8) ? owner : DM;
    const mount = acting.attached ? state.tokens[acting.attached.to] : undefined;
    if (mount) return { who: by, op: { t: "token.move", tokenId: mount.id, x: near(r, mount.x, 3), y: near(r, mount.y, 3) } };
    const steed = state.tokens[pick(r, ["horse", "pony"])];
    if (steed && steed.sceneId === acting.sceneId) {
      const seat = seatSpot(acting, steed) ?? steed;
      return { who: by, op: { t: "token.attach", tokenId: acting.id, to: steed.id, kind: "ride", steer: true, x: seat.x, y: seat.y, elevation: steed.elevation } };
    }
  }
  const n = r();
  if (n < 0.22) {
    const carried = state.tokens[anyId()];
    const others = tokens.filter((x) => carried && x.id !== carried.id && x.sceneId === carried.sceneId);
    const holder = others.length > 0 ? pick(r, others) : undefined;
    if (!carried || !holder) return { who, op: { t: "encounter.next" } };
    const fitting: AttachKind = carried.kind === "object" ? "carry" : carried.size === "tiny" ? "perch" : holder.kind === "object" ? "carry" : chance(r, 0.25) ? "drag" : "ride";
    const kind = chance(r, 0.8) ? fitting : pick(r, ATTACH_KINDS);
    const seat = kind === "drag" ? carried : (seatSpot(carried, holder) ?? holder);
    const steer = kind === "ride" && chance(r, 0.7);
    return { who, op: { t: "token.attach", tokenId: carried.id, to: holder.id, kind, ...(steer ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? carried.elevation : holder.elevation } };
  }
  if (n < 0.3) {
    const carried = carriedOnes.length > 0 ? pick(r, carriedOnes) : state.tokens[anyId()];
    if (!carried) return { who, op: { t: "token.detach", tokenId: anyId() } };
    const holder = holderOf(state.tokens, carried) as Token | undefined;
    const scene = state.scenes[carried.sceneId];
    const spot = holder && scene && chance(r, 0.7) ? getOffSpot(state.meta.settings, scene.bounds, carried, holder) : null;
    return { who, op: { t: "token.detach", tokenId: carried.id, ...(spot ? { x: spot.x, y: spot.y } : {}) } };
  }
  if (n < 0.5) {
    // A holder's move, now and then a teleport or a walk with a corner.
    const mover = holders.length > 0 && chance(r, 0.7) ? pick(r, holders) : state.tokens[anyId()];
    if (!mover) return { who, op: { t: "encounter.next" } };
    const x = near(r, mover.x);
    const y = near(r, mover.y);
    const style = r();
    if (style < 0.1) return { who, op: { t: "token.move", tokenId: mover.id, x, y, teleport: "wall" } };
    if (style < 0.25) return { who, op: { t: "token.move", tokenId: mover.id, x, y, route: [[x, mover.y, 0, 0], [x, y, 0, 0]] } };
    return { who, op: { t: "token.move", tokenId: mover.id, x, y } };
  }
  if (n < 0.58) {
    // A carried token's own move: a new seat on its holder, or away.
    const carried = carriedOnes.length > 0 ? pick(r, carriedOnes) : state.tokens[anyId()];
    const holder = carried ? state.tokens[carried.attached?.to ?? ""] : undefined;
    if (!carried) return { who, op: { t: "encounter.next" } };
    const inside = holder && chance(r, 0.5) ? { x: holder.x + (chance(r, 0.5) ? 0.5 : 0), y: holder.y } : { x: near(r, carried.x, 2), y: near(r, carried.y, 2) };
    return { who, op: { t: "token.move", tokenId: carried.id, ...inside } };
  }
  if (n < 0.62) {
    const a = state.tokens[anyId()];
    const b = state.tokens[anyId()];
    if (!a || !b || a.id === b.id) return { who, op: { t: "encounter.next" } };
    return { who, op: { t: "token.moveMany", moves: [{ tokenId: a.id, x: near(r, a.x, 2), y: near(r, a.y, 2) }, { tokenId: b.id, x: near(r, b.x, 2), y: near(r, b.y, 2) }] } };
  }
  if (n < 0.65) return { who, op: { t: "token.update", tokenId: anyId(), patch: { size: pick(r, SIZES) } } };
  if (n < 0.67) return { who, op: { t: "token.update", tokenId: anyId(), patch: { elevation: pick(r, [0, 0, 10, 20]) } } };
  if (n < 0.685) return { who: DM, op: { t: "token.delete", tokenId: anyId() } };
  if (n < 0.71) return { who: DM, op: { t: "token.update", tokenId: anyId(), patch: { sceneId: pick(r, ["s1", "s2"]), x: int(r, 0, 10), y: int(r, 0, 10) } } };
  if (n < 0.8) {
    if (who.role === "player" && encounter) return { who, op: { t: "encounter.next", from: { entry: encounter.activeEntryId ?? null, round: encounter.round } } };
    return { who: DM, op: { t: "encounter.next" } };
  }
  if (n < 0.83) return { who: DM, op: { t: "encounter.prev" } };
  if (n < 0.91) return { who, restore: chance(r, 0.7) ? "undo" : "redo" };
  if (n < 0.96) return { who: DM, op: { t: "token.update", tokenId: pick(r, ["thorn", "bree", "horse", "pony", "imp", "owl"]), patch: { visibility: chance(r, 0.5) ? "dm" : "all" } } };
  if (n < 0.98) return { who: DM, op: { t: "scene.update", sceneId: "s1", patch: { fogEnabled: chance(r, 0.5) } } };
  return { who, op: { t: "token.countLeg", tokenId: encounter?.turnStart?.tokenId ?? anyId(), counts: chance(r, 0.5) } };
}

/** What the checks remember across steps. */
class Watch {
  /** Every mount a turn's list held after joining it at a qualifying event, as `seq:mount`. */
  joined = new Set<string>();
  /** The turns each token recorded movement on, per round. */
  recorded = new Map<string, Map<number, Set<number>>>();
  /** How often the run reached the cases that matter, so a run that never gets there fails. */
  seen = { joins: 0, mountLegs: 0, linksDropped: 0, quietPassengers: 0 };
  initial: RoomState;
  constructor(initial: RoomState) {
    this.initial = initial;
  }

  /** After a step: one that applied is `t.last`, and one refused must leave the room as it was. */
  check(t: UndoTable, before: RoomState, answer: string, where: string): void {
    if (answer !== "ok" || !t.last) {
      assert.equal(t.state, before, `${where}: a refused step changed the room`);
      return;
    }
    const after = t.state;
    const { op, who } = t.last;
    this.#links(after, where);
    for (const t of Object.values(after.tokens)) holds("pathBound", (t.path?.stops.length ?? 0) <= MAX_PATH_STOPS, where, `${t.id} holds ${t.path?.stops.length} stops`);
    for (const [id, was] of Object.entries(before.tokens)) {
      if (was.attached && after.tokens[id] && !after.tokens[id]!.attached && op.t !== "token.detach") this.seen.linksDropped++;
    }
    if (op.t === "sys.restore" && who.role === "player" && op.entries.some((e) => Object.values(before.tokens).some((x) => x.visibility === "dm" && e.key === `token:${x.id}`))) this.seen.quietPassengers++;
    this.#groups(op, who, before, after, where);
    this.#shares(op, before, after, where);
    this.#records(op, before, after, where);
    if (op.t === "sys.restore") this.#restoreWhole(op, after, where);
  }

  #links(after: RoomState, where: string): void {
    for (const carried of Object.values(after.tokens)) {
      const link = carried.attached;
      if (!link) continue;
      const holder = after.tokens[link.to];
      holds("links", holder !== undefined, where, `${carried.id} holds on to a missing ${link.to}`);
      holds("links", holder!.sceneId === carried.sceneId, where, `${carried.id} and ${link.to} on different scenes`);
      holds("links", linkHolds(after.meta.settings, link.kind, carried, holder!), where, `${carried.id} ${link.kind} ${link.to} does not hold`);
    }
  }

  #groups(op: Op, who: Viewer, before: RoomState, after: RoomState, where: string): void {
    for (const id of Object.keys(after.tokens)) {
      const group = carriedGroup(after.tokens, id, new Set([id]));
      const onScene = Object.values(after.tokens).filter((x) => x.sceneId === after.tokens[id]!.sceneId).length;
      holds("groups", new Set(group).size === group.length && group.length <= onScene, where, `${id}'s group ${group.join(",")}`);
    }
    const versioned = { opVersion: undefined };
    const plan = planMove(op, before, who, versioned);
    const ids = plan.map((m) => m.tokenId);
    holds("groups", new Set(ids).size === ids.length, where, `moved twice: ${ids.join(",")}`);
    const described = describeMove(op, before, after, who, versioned);
    holds("plan", isDeepEqual(described, plan.filter((m) => after.tokens[m.tokenId])), where, `${op.t}: ${JSON.stringify(diffPlans(plan, described))}`);
    // Every token whose place changed is one the plan moved, for the ops that move tokens.
    if (op.t === "token.move" || op.t === "token.moveMany" || op.t === "token.attach" || op.t === "token.detach" || (op.t === "token.update" && ("x" in op.patch || "sceneId" in op.patch || "elevation" in op.patch || "size" in op.patch))) {
      for (const [id, now] of Object.entries(after.tokens)) {
        const was = before.tokens[id];
        if (!was || (was.x === now.x && was.y === now.y && was.elevation === now.elevation && was.sceneId === now.sceneId)) continue;
        holds("groups", ids.includes(id), where, `${id} moved outside the plan of ${op.t}`);
      }
    }
  }

  #shares(op: Op, before: RoomState, after: RoomState, where: string): void {
    const turn = turnUnderWay(after.encounter);
    const was = before.encounter?.turnStart;
    for (const mount of turn?.mounts ?? []) {
      holds("sharesJoined", sharesTurn(after, mount, turn!), where, `${mount} is on turn ${turn!.seq}'s list without its rider's controlled ride`);
      const key = `${turn!.seq}:${mount}`;
      const already = was?.seq === turn!.seq && (was.mounts ?? []).includes(mount);
      if (already) continue;
      const startsTurn = was?.seq !== turn!.seq;
      if (op.t === "sys.restore" || op.t === "encounter.prev") {
        holds("sharesJoined", this.joined.has(key), where, `${op.t} put ${mount} on turn ${turn!.seq}'s list, which it never joined`);
        continue;
      }
      const mounting = op.t === "token.attach" && op.kind === "ride" && op.steer === true;
      holds("sharesJoined", startsTurn || mounting, where, `${mount} joined turn ${turn!.seq} on ${op.t}`);
      // Every player sees each token from the turn's creature up to the mount.
      for (let rider = after.tokens[turn!.tokenId]; rider; rider = after.tokens[rider.attached?.to ?? ""]) {
        holds("sharesJoined", inSightOfNonOwners(after, rider, {}), where, `${mount} joined turn ${turn!.seq} with ${rider.id} unseen`);
        if (rider.id === mount) break;
      }
      this.joined.add(key);
      this.seen.joins++;
    }
  }

  #records(op: Op, before: RoomState, after: RoomState, where: string): void {
    // A restore puts back a leg recorded earlier, and Previous a turn already run: neither records anew.
    if (op.t === "sys.restore" || op.t === "encounter.prev") return;
    const turn = turnUnderWay(after.encounter);
    if (!turn || !after.encounter) return;
    const round = after.encounter.round;
    const stops = (state: RoomState, id: string) => {
      const path = state.tokens[id]?.path;
      return path && path.turn === turn.seq ? path.stops.length : 0;
    };
    for (const id of Object.keys(after.tokens)) {
      if (stops(after, id) <= Math.max(1, stops(before, id))) continue;
      if (id === turn.tokenId) {
        const active = rowOf(after.encounter, after.encounter.activeEntryId);
        holds("recordsOnce", active?.markRound !== round, where, `${id} recorded on its own row while it marks time`);
      } else {
        const lists = [...(before.encounter?.turnStart?.seq === turn.seq ? (before.encounter.turnStart.mounts ?? []) : []), ...(turn.mounts ?? [])];
        holds("recordsOnce", lists.includes(id), where, `${id} recorded on turn ${turn.seq}, which it does not share`);
        this.seen.mountLegs++;
      }
      const rounds = this.recorded.get(id) ?? new Map<number, Set<number>>();
      const turns = rounds.get(round) ?? new Set<number>();
      if (!turns.has(turn.seq) && turns.size > 0 && id !== turn.tokenId) {
        holds("recordsOnce", this.joined.has(`${turn.seq}:${id}`), where, `${id} recorded on a second turn of round ${round} with no qualifying mounting`);
      }
      turns.add(turn.seq);
      rounds.set(round, turns);
      this.recorded.set(id, rounds);
    }
  }

  #restoreWhole(op: Extract<Op, { t: "sys.restore" }>, after: RoomState, where: string): void {
    for (const entry of op.entries) {
      if (!entry.key.startsWith("token:") && entry.key !== "encounter") continue;
      const want = normalized(entry.key, entry.value ?? null, after);
      const got = normalized(entry.key, readEntity(after, entry.key as EntityKey), after);
      holds("restoreWhole", isDeepEqual(got, want), where, `${entry.key} was not written as the restore said`);
    }
  }

  replay(t: UndoTable, where: string): void {
    let state = this.initial;
    for (const p of t.played) {
      const r = applyOp(state, p.op, p.who, env(p.seq));
      holds("replay", r.ok, where, `${p.op.t} at ${p.seq} refused on replay: ${r.ok ? "" : r.message}`);
      if (r.ok) state = r.state;
    }
    holds("replay", isDeepEqual(state, t.state), where);
  }
}

function rowOf(encounter: Encounter, entryId: string | null | undefined): InitEntry | undefined {
  return encounter.entries.find((e) => e.id === entryId);
}

/**
 * A restored value as the room keeps it once the op's own passes ran: the
 * link pass drops a link that no longer holds, and the turn's list is the
 * shared mounts the op settled, so neither is part of the comparison.
 */
function normalized(key: string, value: unknown, after: RoomState): unknown {
  if (value === null || typeof value !== "object") return value;
  const out = { ...(value as Record<string, unknown>) };
  delete out.rev;
  if (key.startsWith("token:")) {
    const link = out.attached as Token["attached"];
    const holder = link ? after.tokens[link.to] : undefined;
    if (!link || !holder || !linkHolds(after.meta.settings, link.kind, out as unknown as Token, holder)) delete out.attached;
  }
  if (key === "encounter" && out.turnStart) {
    const { mounts: _mounts, ...start } = out.turnStart as Record<string, unknown>;
    out.turnStart = start;
  }
  return out;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function diffPlans(plan: unknown[], described: unknown[]): unknown {
  return plan.flatMap((p, i) => (isDeepEqual(p, described[i]) ? [] : [{ planned: p, described: described[i] }]));
}

function run(seed: number, steps: number, script: readonly Step[] = [], setup?: (s: RoomState) => void): { applied: Record<string, number>; seen: Watch["seen"] } {
  const r = rng(seed);
  const initial = world(r);
  setup?.(initial);
  const t = new UndoTable(initial);
  const watch = new Watch(initial);
  const applied: Record<string, number> = {};
  const take = (step: Step, i: number) => {
    const before = t.state;
    const answer = "op" in step ? t.play(step.who, step.op) : t.restore(step.who, step.restore);
    const label = "op" in step ? step.op.t : step.restore;
    const where = `seed ${seed} step ${i} (${label} by ${step.who.memberId}: ${answer})`;
    watch.check(t, before, answer, where);
    if (answer === "ok") applied[label] = (applied[label] ?? 0) + 1;
  };
  [...startFight(r), ...script].forEach((step, i) => take(step, i));
  const undone: { by: Viewer | null } = { by: null };
  for (let i = 0; i < steps; i++) {
    // An undo that applied is often redone at once, before a new op clears the redo.
    const step: Step = undone.by && chance(r, 0.5) ? { who: undone.by, restore: "redo" } : nextStep(r, t.state);
    take(step, script.length + 2 + i);
    undone.by = "restore" in step && step.restore === "undo" && t.last !== null ? step.who : null;
  }
  watch.replay(t, `seed ${seed}, replaying ${t.played.length} ops`);
  return { applied, seen: watch.seen };
}

const hideThorn: Step = { who: DM, op: { t: "token.update", tokenId: "thorn", patch: { visibility: "dm" } } };
const showThorn: Step = { who: DM, op: { t: "token.update", tokenId: "thorn", patch: { visibility: "all" } } };
const horseTo = (x: number, y: number): Step => ({ who: P1, op: { t: "token.move", tokenId: "horse", x, y } });
const dmNext: Step = { who: DM, op: { t: "encounter.next" } };
const riding = (s: RoomState) => {
  s.tokens.thorn = { ...s.tokens.thorn!, x: 2, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
  s.meta.settings = { ...s.meta.settings, revealHiddenOnTurn: false };
};

describe("attached tokens, randomized (docs/design-v1-attach.md 13)", () => {
  test("random steps keep every invariant", () => {
    const totals: Record<string, number> = {};
    for (let seed = 1; seed <= 100; seed++) {
      const { applied, seen } = run(seed, 200);
      for (const [k, v] of [...Object.entries(applied), ...Object.entries(seen)]) totals[k] = (totals[k] ?? 0) + v;
    }
    // The run must reach what it claims to test.
    for (const kind of ["token.attach", "token.detach", "token.move", "token.moveMany", "token.update", "token.delete", "encounter.next", "encounter.prev", "undo", "redo", "joins", "mountLegs", "linksDropped", "quietPassengers"]) {
      assert.ok((totals[kind] ?? 0) >= 10, `${kind} applied only ${totals[kind] ?? 0} times`);
    }
  });

  test("a rider hidden at its turn's start, then revealed, and the mount moved: no sharing, and the mount's row is ordinary", () => {
    // Thorn rides already. The DM hides him on the goblin's turn of the round before, so his turn starts hidden.
    for (let seed = 100; seed < 110; seed++) {
      run(seed, 60, [{ who: DM, op: { t: "encounter.prev" } }, hideThorn, dmNext, showThorn, horseTo(2, 8), dmNext, dmNext, horseTo(2, 10)], riding);
    }
  });

  test("a rider hidden mid-turn after the mount moved keeps sharing, and the mount's row marks time", () => {
    for (let seed = 110; seed < 120; seed++) run(seed, 60, [horseTo(2, 8), hideThorn, horseTo(2, 10), dmNext, dmNext, horseTo(2, 12)], riding);
  });

  test("a getting off, then the mount's own row", () => {
    for (let seed = 120; seed < 130; seed++) {
      run(seed, 60, [horseTo(4, 4), { who: P1, op: { t: "token.detach", tokenId: "thorn", x: 6, y: 4 } }, horseTo(4, 8), dmNext, dmNext, horseTo(4, 10)], riding);
    }
  });
});
