import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { reachInput, turnReach, type Chunks } from "#shared/rules/opportunity.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import type { RoutePiece } from "#shared/rules/route.ts";
import { actor, character, DM, env, P1, P2, token } from "#shared/testutil.ts";
import { dragLabel, pathNow } from "../measure/movement.ts";
import { dropView, moveOpsOf, planWalk } from "./drop.ts";
import { dragLeaves, walkPreview, type DragReach } from "./preview.ts";
import { NO_TURN_LEAVES, type TurnLeaves } from "./store.ts";
import { onTurn, thorn, world } from "./testing.ts";

/*
 * The drag's Opportunity Attacks line (docs/design/design-v1-opportunity-attacks.md
 * 1 and 4): who gets it, what it names, when it waits for the drop, and that
 * it names exactly what the stored leg's scan adds (DRAG-EQUALS-CARD).
 */

const NO_CHUNKS: Chunks = { rolls: "failed", monsters: "failed" };
const LABELS = new Map();
const LOADED: TurnLeaves = { ...NO_TURN_LEAVES, chunks: { rolls: "failed", monsters: "failed" } };

/** Thorn, p1's, beside a goblin on Thorn's turn, every square 5 ft. */
function beside(more: Token[] = []): RoomState {
  const goblin = token("goblin", { name: "Goblin", x: 6, y: 5, actor: { inline: actor() } });
  return onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), goblin, ...more] }), "thorn");
}

function reach(viewer: Viewer, over: Partial<DragReach> = {}): DragReach {
  return { viewer, shown: true, turn: LOADED, ...over };
}

/** A straight drag of `id` to `to`, as the board's picture reads it. */
function drag(state: RoomState, id: string, to: { x: number; y: number }, r: DragReach | null, role: "dm" | "player" = r?.viewer.role ?? "dm", pieces?: RoutePiece[]) {
  const view = dropView(state, role);
  const answer = pieces ? { kind: "route" as const, route: { pieces, points: [], endsBlocked: false } } : { kind: "none" as const, capped: false };
  return walkPreview({ labels: new Map(), view, token: view.tokens[id]!, target: to, answer, held: null, world: null, role, reach: r });
}

function moved(state: RoomState, id: string, to: { x: number; y: number }, who: Viewer = DM, pieces?: RoutePiece[]): RoomState {
  const view = dropView(state, who.role);
  const plan = planWalk(view, view.tokens[id]!, to, who.role === "dm" ? "free" : "walk", pieces ? { kind: "route", route: { pieces } } : { kind: "none", capped: false }, view.meta.settings.feetPerCell);
  let out = state;
  for (const [k, op] of moveOpsOf(plan.moves).entries()) {
    const r = applyOp(out, op as Op, who, env(50 + k));
    assert.ok(r.ok, r.ok ? "" : r.message);
    out = r.state;
  }
  return out;
}

describe("the drag's Opportunity Attacks line", () => {
  test("Thorn stepping away from the goblin names it, the DM's line plain and his player's counted at 5 ft", () => {
    const state = beside();
    const dm = drag(state, "thorn", { x: 8, y: 5 }, reach(DM));
    assert.deepEqual(dm.read.leaves, { names: ["Goblin"], fiveFt: false });
    assert.deepEqual(dm.leaving, ["goblin"]);
    assert.equal(dragLabel(dm.read).split("\n").at(-1), "Leaves Goblin's reach");
    const player = drag(state, "thorn", { x: 8, y: 5 }, reach(P1));
    assert.equal(dragLabel(player.read).split("\n").at(-1), "Leaves 5 ft of Goblin");
    // A step that stays beside it leaves nothing.
    assert.equal(drag(state, "thorn", { x: 5, y: 6 }, reach(DM)).read.leaves, undefined);
  });

  test("a character shown by two tokens is named once, and both tokens keep their rings (LP62-OA-TWICE)", () => {
    const shade = (id: string, x: number, y: number) => token(id, { name: "Shade", x, y, actor: { ref: "shade" } });
    const set = beside([shade("s1", 6, 6), shade("s2", 6, 4)]);
    const state = { ...set, characters: { ...set.characters, shade: character("shade", { name: "Shade", ownerIds: [] }) } };
    const out = drag(state, "thorn", { x: 8, y: 5 }, reach(DM));
    assert.deepEqual(out.read.leaves, { names: ["Goblin", "Shade"], fiveFt: false });
    assert.deepEqual([...out.leaving].sort(), ["goblin", "s1", "s2"]);
  });

  test("only on a DM device or the turn's answerer's, with the part and the room's notices on", () => {
    const state = beside();
    assert.equal(drag(state, "thorn", { x: 8, y: 5 }, reach(P2)).read.leaves, undefined, "p2 does not answer for Thorn");
    assert.equal(drag(state, "thorn", { x: 8, y: 5 }, reach(DM, { shown: false })).read.leaves, undefined, "the part hidden here");
    const off = { ...state, meta: { ...state.meta, settings: { ...state.meta.settings, opportunityNotices: false } } } as RoomState;
    assert.equal(drag(off, "thorn", { x: 8, y: 5 }, reach(DM)).read.leaves, undefined, "the room's notices off");
    assert.equal(drag(state, "thorn", { x: 8, y: 5 }, null).read.leaves, undefined, "no reach given");
    const leaving = drag(state, "thorn", { x: 8, y: 5 }, reach(DM, { shown: false })).leaving;
    assert.deepEqual(leaving, [], "no rings either");
  });

  test("a player dragging the goblin on its own turn under Who can move any token gets no line, the DM does", () => {
    const base = beside();
    const state = onTurn({ ...base, encounter: null, tokens: { ...base.tokens, thorn: { ...base.tokens.thorn!, path: undefined } } }, "goblin");
    assert.equal(drag(state, "goblin", { x: 9, y: 5 }, reach(P1)).read.leaves, undefined);
    assert.deepEqual(drag(state, "goblin", { x: 9, y: 5 }, reach(DM)).read.leaves, { names: ["Thorn"], fiveFt: false });
  });

  test("off its own turn, or outside a fight, a drag names no one", () => {
    const state = beside([token("ogre", { name: "Ogre", x: 12, y: 12 })]);
    assert.equal(drag(state, "ogre", { x: 4, y: 4 }, reach(DM)).read.leaves, undefined, "the ogre's drag on Thorn's turn");
    const calm = { ...state, encounter: null };
    assert.equal(drag(calm, "thorn", { x: 8, y: 5 }, reach(DM)).read.leaves, undefined);
  });

  test("while an earlier leg's job of the turn is unfinished, or the data the scan reads is on its way, the line says the drop checks it (R3-02)", () => {
    const after = moved(beside([token("wolf", { name: "Wolf", x: 9, y: 6 })]), "thorn", { x: 8, y: 5 });
    const turn = pathNow(after.encounter, after.tokens.thorn!, "dm")!.turn;
    const later = "Opportunity Attacks are checked after the drop.";
    const line = (t: TurnLeaves) => dragLabel(drag(after, "thorn", { x: 11, y: 5 }, reach(DM, { turn: t })).read).split("\n").at(-1);
    assert.equal(line(LOADED), later, "no job has said anything of the turn's leg");
    assert.equal(line({ ...LOADED, movers: { thorn: { turn, skip: new Set(["goblin"]), settled: false } } }), later, "its job still runs");
    assert.equal(line({ ...LOADED, movers: { thorn: { turn: turn - 1, skip: new Set(), settled: true } } }), later, "an earlier turn's word");
    assert.equal(line({ ...LOADED, movers: { thorn: { turn, skip: new Set(["goblin"]), settled: true } } }), "Leaves Wolf's reach", "settled: the goblin is skipped, its Reaction spoken for");
    assert.deepEqual(drag(after, "thorn", { x: 11, y: 5 }, reach(DM, { turn: { ...LOADED, movers: { thorn: { turn, skip: new Set(["goblin"]), settled: true } } } })).leaving, ["wolf"]);
    assert.equal(line({ ...LOADED, movers: { thorn: { turn, skip: new Set(["goblin", "wolf"]), settled: true } } }), "15 ft · 0 ft left", "a creature an earlier leg left is never named again: its Reaction is spoken for");
  });

  test("a creature its block says reaches 10 ft waits for the SRD's rolls table, then reads its reach, and 5 ft where the table failed (SOL-06)", async () => {
    const ogre = token("ogre", { name: "Air Elemental", x: 6, y: 5, size: "large", actor: { inline: actor({ srdId: "air-elemental" }) } });
    const state = onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), ogre] }), "thorn");
    const leavesWith = (rolls: TurnLeaves["chunks"]["rolls"]) => drag(state, "thorn", { x: 4, y: 5 }, reach(DM, { turn: { ...NO_TURN_LEAVES, chunks: { rolls, monsters: "failed" } } })).read.leaves;
    assert.equal(leavesWith(null), "over", "the table still on its way");
    // From 5 ft to 10 ft of the Air Elemental: within its 10 ft reach all the way, but past the 5 ft a failed table reads.
    assert.equal(leavesWith(await loadSrdRolls()), undefined);
    assert.deepEqual(leavesWith("failed"), { names: ["Air Elemental"], fiveFt: false });
  });

  test("past the drag's work cap the line says the drop checks it, and names no one for its rings", () => {
    const state = beside();
    const view = dropView(state, "dm");
    const thornNow = view.tokens.thorn!;
    const at = (cap?: number) => dragLeaves({ view, token: thornNow, landed: { ...thornNow, x: 8 }, corners: [], reach: reach(DM), labels: LABELS, role: "dm", ...(cap !== undefined ? { cap } : {}) });
    assert.deepEqual(at(1), { leaves: "over", ids: [] });
    assert.deepEqual(at(), { leaves: { names: ["Goblin"], fiveFt: false }, ids: ["goblin"] });
  });

  test("the line names what the stored leg's scan adds, straight, round corners and out of a squeeze (DRAG-EQUALS-CARD)", () => {
    const cases: { name: string; to: { x: number; y: number }; pieces?: RoutePiece[]; more?: Token[]; mover?: Partial<Token> }[] = [
      { name: "straight away", to: { x: 9, y: 5 } },
      { name: "a Large Thorn squeezed beside it, landing whole", to: { x: 9, y: 4 }, mover: { size: "large", squeeze: true } },
      { name: "round two corners", to: { x: 8, y: 9 }, pieces: [[5, 8, 0, 0], [8, 8, 0, 0], [8, 9, 0, 0]], more: [token("wolf", { name: "Wolf", x: 4, y: 8 })] },
      { name: "past a second goblin", to: { x: 5, y: 12 }, more: [token("g2", { name: "Goblin", number: 2, x: 6, y: 8 })] },
    ];
    for (const c of cases) {
      const base = beside(c.more);
      const state = c.mover ? { ...base, tokens: { ...base.tokens, thorn: { ...base.tokens.thorn!, ...c.mover } } } : base;
      const shown = drag(state, "thorn", c.to, reach(DM), "dm", c.pieces);
      const after = moved(state, "thorn", c.to, DM, c.pieces);
      const path = pathNow(after.encounter, after.tokens.thorn!, "dm");
      const built = reachInput(after, "thorn", path, NO_CHUNKS, DM)!;
      const scanned = turnReach(built.input, built.legs).at(-1)!;
      assert.notEqual(scanned.leaves, "over", c.name);
      assert.deepEqual([...shown.leaving].sort(), (scanned.leaves as { id: string }[]).map((l) => l.id).sort(), c.name);
    }
  });

  test("the same reading twice reads the scan once, and a changed room reads it again", () => {
    const state = beside();
    const view = dropView(state, "dm");
    const r = reach(DM);
    const once = dragLeaves({ view, token: view.tokens.thorn!, landed: { ...view.tokens.thorn!, x: 8 }, corners: [], reach: r, labels: LABELS, role: "dm" });
    const twice = dragLeaves({ view, token: view.tokens.thorn!, landed: { ...view.tokens.thorn!, x: 8 }, corners: [], reach: r, labels: LABELS, role: "dm" });
    assert.ok(once !== null && once === twice);
    const gone = { ...view, tokens: { thorn: view.tokens.thorn! } };
    assert.equal(dragLeaves({ view: gone, token: view.tokens.thorn!, landed: { ...view.tokens.thorn!, x: 8 }, corners: [], reach: r, labels: LABELS, role: "dm" }), null);
  });
});
