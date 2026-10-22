import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttachKind, RoomState, Token, Viewer } from "#shared/model.ts";
import { inSightOfNonOwners, projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { carriedGroup, getOffSpot, holderOf, seatSpot } from "#shared/rules/attach.ts";
import { DM, P1, P2, actor, chance, deepClone, env, int, pick, rng, room, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * The hidden-state generator (docs/design-v1-attach.md 8.0, the class of
 * reviews AT-ASTRA-1, AT-ASTRA-10 and AT-O-16): no hidden link or hidden
 * token changes anything a player receives. Each run builds a room with
 * random holder chains up to four tokens deep, each token visible or not,
 * so each link is seen or not, and a fight. Two rooms start from it alike.
 * Then random steps: now and then the DM changes something no player sees
 * in room b alone (room a takes a neutral edit in its place, so the op
 * numbers stay in step), and otherwise the DM or a player takes the same
 * step in both, through the room actor's own checks: moves, group moves,
 * attaches, detaches, drags off a mount, undos, redos and Next.
 *
 * After every step each player's answer must be the same in both rooms,
 * and so must each player's copy: tokens with their paths and costs, the
 * tracker and the log. The one thing that may differ is the carried-object
 * reveal: a visible token with a hidden token or link above it may move
 * with its hidden holder in one room alone. Such a token, once moved apart,
 * is left out of what is compared, and no player step names it after.
 */

const IDS = ["thorn", "bree", "pip", "horse", "pony", "elk", "dog", "imp", "rat", "steed", "torch", "light", "cart"] as const;
const SHOWN_SOMETIMES = new Set(["horse", "pony", "elk", "dog", "imp", "rat", "torch", "light", "cart"]);

/** The room: three player characters, four mounts, two small creatures, a steed and three objects, a lurker for neutral edits. */
function world(r: () => number): RoomState {
  const walk = (feet: number) => ({ actor: { inline: actor({ speeds: { walk: feet } }) } });
  const hidden = (id: string) => (SHOWN_SOMETIMES.has(id) && chance(r, 0.35) ? { visibility: "dm" as const } : {});
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 3, y: 6, ...walk(30) }),
    token("bree", { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p2"], x: 8, y: 6, ...walk(30) }),
    token("pip", { name: "Pip", kind: "pc", size: "small", disposition: "ally", ownerIds: ["p1"], x: 5, y: 8, ...walk(25) }),
    token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: chance(r, 0.5) ? ["p1"] : [], x: 3, y: 3, ...walk(60), ...hidden("horse") }),
    token("pony", { name: "Pony", kind: "npc", size: "large", x: 8, y: 3, ...walk(40), ...hidden("pony") }),
    token("elk", { name: "Elk", kind: "npc", size: "huge", x: 12, y: 5, ...walk(50), ...hidden("elk") }),
    token("dog", { name: "Mastiff", kind: "npc", x: 6, y: 10, ...walk(40), ...hidden("dog") }),
    token("imp", { name: "Imp", size: "tiny", x: 4, y: 4, ...hidden("imp") }),
    token("rat", { name: "Rat", size: "small", x: 2, y: 7, ...hidden("rat") }),
    token("steed", { name: "Phantom steed", kind: "npc", size: "large", x: 3, y: 6, visibility: "dm", ...walk(100) }),
    token("torch", { name: "Torch", kind: "object", size: "tiny", x: 3.5, y: 6.5, ...hidden("torch") }),
    token("light", { name: "Light", kind: "object", size: "tiny", x: 4.5, y: 3.5, ...hidden("light") }),
    token("cart", { name: "Cart", kind: "object", size: "large", x: 12, y: 10, ...hidden("cart") }),
    token("lurker", { name: "Lurker", x: 22, y: 22, visibility: "dm" }),
  ];
  let state = room({ tokens: Object.fromEntries(list.map((t) => [t.id, t])) });
  state.meta.settings = { ...state.meta.settings, diagonal: pick(r, ["five", "fiveTen"] as const), revealHiddenOnTurn: false };
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: chance(r, 0.5), autoWalls: "off" };
  let seq = 1;
  const dm = (op: Op) => {
    const out = applyOp(state, op, DM, env(seq++));
    if (out.ok) state = out.state;
  };
  // Random links, kept where the reducer takes them, so chains run up to its depth limit.
  for (let i = 0; i < 14; i++) {
    const carried = state.tokens[pick(r, IDS)]!;
    const holder = state.tokens[pick(r, IDS)]!;
    if (carried.id === holder.id) continue;
    const kind: AttachKind = carried.kind === "object" || holder.kind === "object" ? "carry" : carried.size === "tiny" ? "perch" : chance(r, 0.3) ? "drag" : "ride";
    const seat = kind === "drag" ? carried : seatSpot(carried, holder);
    if (!seat) continue;
    dm({ t: "token.attach", tokenId: carried.id, to: holder.id, kind, ...(kind === "ride" && chance(r, 0.5) ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? carried.elevation : holder.elevation });
  }
  // Often the chain of the reviews: a horse carrying a hidden imp that holds a visible torch with a light on it.
  if (chance(r, 0.4)) {
    const horse = (state.tokens.horse = { ...state.tokens.horse!, visibility: "all", ownerIds: ["p1"] });
    const on = { x: horse.x, y: horse.y, elevation: horse.elevation };
    state.tokens.imp = { ...state.tokens.imp!, visibility: "dm", ...on };
    state.tokens.torch = { ...state.tokens.torch!, visibility: "all", ...on };
    state.tokens.light = { ...state.tokens.light!, visibility: "all", ...on };
    for (const [carried, holder, kind] of [["imp", "horse", "perch"], ["torch", "imp", "carry"], ["light", "torch", "carry"]] as const) {
      const seat = seatSpot(state.tokens[carried]!, state.tokens[holder]!);
      if (!seat) continue;
      // The light goes on by a player's attach, whose depth limit counts only what every player sees (8.0): the DM's counts the imp.
      const by = carried === "light" ? P1 : DM;
      const out = applyOp(state, { t: "token.attach", tokenId: carried, to: holder, kind, x: seat.x, y: seat.y, elevation: state.tokens[holder]!.elevation }, by, env(seq++));
      if (out.ok) state = out.state;
    }
  }
  // Often Thorn rides the phantom steed no player sees.
  if (chance(r, 0.4)) dm({ t: "token.attach", tokenId: "thorn", to: "steed", kind: "ride", ...(chance(r, 0.5) ? { steer: true as const } : {}), x: 3, y: 6, elevation: 0 });
  dm({ t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eb", tokenId: "bree", value: 15 }, { id: "ep", tokenId: "pip", value: 12 }, { id: "eh", tokenId: "horse", value: 10 }, { id: "ey", tokenId: "pony", value: 8 }] });
  dm({ t: "encounter.next" });
  return state;
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
  if (n < 0.62) return { who, op: { t: "token.move", tokenId: a.id, x: nearBy(r, a.x), y: nearBy(r, a.y) } };
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

/** A change only the DM sees, for room b: candidates the check below keeps only when no player's copy changes. */
function unseenOp(r: () => number, state: RoomState, focus?: ReadonlySet<string>): Op | null {
  // A creature with a row stays: a row whose creature is gone is the tracker's own matter, not a link's.
  const rows = new Set((state.encounter?.entries ?? []).map((e) => e.tokenId));
  const near = Object.values(state.tokens).filter((t) => !focus || focus.has(t.id));
  const hidden = near.filter((t) => t.id !== "lurker" && !inSightOfNonOwners(state, t, {}));
  const deletable = hidden.filter((t) => !rows.has(t.id));
  const hiddenLinks = near.filter((t) => {
    const holder = t.attached ? state.tokens[t.attached.to] : undefined;
    return holder !== undefined && (!inSightOfNonOwners(state, t, {}) || !inSightOfNonOwners(state, holder, {}));
  });
  const n = r();
  if (n < 0.4 && hiddenLinks.length > 0) {
    const t = pick(r, hiddenLinks);
    // A ride comes off only with a place, which moves the rider: its holder goes instead.
    if (t.attached!.kind === "ride") return rows.has(t.attached!.to) ? null : { t: "token.delete", tokenId: t.attached!.to };
    return { t: "token.detach", tokenId: t.id };
  }
  if (hidden.length === 0) return null;
  const h = pick(r, hidden);
  if (n < 0.6) return deletable.length > 0 ? { t: "token.delete", tokenId: pick(r, deletable).id } : null;
  if (n < 0.8) return { t: "token.move", tokenId: h.id, x: nearBy(r, h.x), y: nearBy(r, h.y) };
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
 * Every player's copies of the two rooms, compared. A token apart in its
 * place, with something hidden above it in either room, is the reveal and
 * joins `apart`. Any other difference, a cost or a path on the same spot
 * included, fails.
 */
function compare(a: { before: RoomState; after: RoomState }, b: { before: RoomState; after: RoomState }, apart: Set<string>, where: string): void {
  for (const who of [P1, P2]) {
    const ca = copyOf(a.after, who);
    const cb = copyOf(b.after, who);
    for (const id of new Set([...Object.keys(ca.tokens), ...Object.keys(cb.tokens)])) {
      if (apart.has(id)) continue;
      const ta = ca.tokens[id];
      const tb = cb.tokens[id];
      try {
        assert.deepEqual(ta, tb);
      } catch {
        const moved = !ta || !tb || POSE.some((f) => ta[f] !== tb[f]);
        const reveal = [a.before, a.after, b.before, b.after].some((s) => underHidden(s, id));
        assert.ok(moved && reveal, `${where}: ${who.memberId} sees ${id} differ: ${JSON.stringify(ta)} against ${JSON.stringify(tb)}`);
        apart.add(id);
      }
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

/** One run: its seed, the steps it took, and how often it reached the cases that matter. */
function run(seed: number, steps = 70): { unseen: number; compared: number; restores: number } {
  const r = rng(seed);
  const start = world(r);
  const a = new UndoTable(deepClone(start));
  const b = new UndoTable(deepClone(start));
  a.seq = b.seq = 100;
  const apart = new Set<string>();
  const seen = { unseen: 0, compared: 0, restores: 0 };
  let where = "";
  /** The DM's unseen change in room b, kept only when no player's copy changes, with a neutral edit in room a. */
  const unseen = (focus?: ReadonlySet<string>): void => {
    const op = unseenOp(r, b.state, focus);
    if (!op) return;
    const trial = applyOp(b.state, op, DM, env(b.seq + 1));
    if (!trial.ok || [P1, P2].some((p) => !isSame(copyOf(trial.state, p), copyOf(b.state, p)))) return;
    assert.equal(b.play(DM, op), "ok", `${where}: the unseen ${op.t}`);
    assert.equal(a.play(DM, NEUTRAL), "ok");
    seen.unseen++;
  };
  /** The same step in both rooms, compared. False when the DM's answers part the rooms, which ends the run. */
  const shared = (step: Step): boolean => {
    if (step.who.role === "player" && namedBy(step).some((id) => apart.has(id))) return true;
    const before = { a: a.state, b: b.state };
    const answer = (t: UndoTable) => ("restore" in step ? (step.restore === "undo" ? t.undo(step.who) : t.redo(step.who)) : t.play(step.who, step.op));
    const ra = answer(a);
    const rb = answer(b);
    a.seq = b.seq = Math.max(a.seq, b.seq);
    const label = "restore" in step ? step.restore : step.op.t;
    if (step.who.role === "player" && !("restore" in step && apart.size > 0)) {
      assert.equal(ra, rb, `${where}: ${step.who.memberId}'s ${label} answers differ`);
      seen.compared++;
      if ("restore" in step && ra === "ok") seen.restores++;
    }
    // The DM's own answer may read what the DM knows. Where it differs the rooms part ways, and the run ends there.
    if (step.who.role === "dm" && ra !== rb) return false;
    compare({ before: before.a, after: a.state }, { before: before.b, after: b.state }, apart, `${where} (${step.who.memberId}'s ${label})`);
    return true;
  };
  for (let i = 0; i < steps; i++) {
    where = `seed ${seed} step ${i + 1}`;
    const roll = r();
    if (roll < 0.2) {
      unseen();
      continue;
    }
    if (roll < 0.35) {
      // The shape of the reviews' cases: a player moves a group of theirs, the DM changes something unseen in it, perhaps
      // locks the token, and the player takes the move back and forth.
      const who = chance(r, 0.7) ? P1 : P2;
      const own = Object.values(a.state.tokens).filter((t) => t.ownerIds.includes(who.memberId!) && !apart.has(t.id) && copyOf(a.state, who).tokens[t.id]);
      if (own.length === 0) continue;
      // Mostly a holder, whose group the DM's unseen change can reach.
      const holding = own.filter((t) => Object.values(a.state.tokens).some((x) => x.attached?.to === t.id));
      const root = holding.length > 0 && chance(r, 0.7) ? pick(r, holding) : pick(r, own);
      if (!shared({ who, op: { t: "token.move", tokenId: root.id, x: nearBy(r, root.x, 2), y: nearBy(r, root.y, 2) } })) break;
      const group = new Set([...carriedGroup(b.state.tokens, root.id), ...carriedGroup(b.state.tokens, holderOf(b.state.tokens, b.state.tokens[root.id]!)?.id ?? root.id)]);
      for (const id of [...group]) for (const t of Object.values(b.state.tokens)) if (t.attached?.to === id) group.add(t.id);
      unseen(group);
      if (chance(r, 0.4) && !shared({ who: DM, op: { t: "token.update", tokenId: root.id, patch: { locked: chance(r, 0.8) } } })) break;
      if (!(["undo", "redo", "undo"] as const).every((restore) => shared({ who, restore }))) break;
      continue;
    }
    if (!shared(sharedStep(r, a.state, apart))) break;
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
  test("random chains, random visibility and random steps by the DM and both players, in pairs of rooms that differ only unseen", () => {
    const total = { unseen: 0, compared: 0, restores: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const seen = run(seed);
      total.unseen += seen.unseen;
      total.compared += seen.compared;
      total.restores += seen.restores;
    }
    // A run that never reaches the cases it is for tests nothing.
    assert.ok(total.unseen > 100 && total.compared > 800 && total.restores > 50, JSON.stringify(total));
  });
});
