import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, UPPER, applied, onThornsTurn, putOp, run, thornToken, tower, withOpening, withStairs } from "./floorLinksTestutil.ts";
import { keys } from "./keys.ts";
import type { AreaTemplate, FallRecord, FloorLink, RoomState, Token, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import type { Op, RestoreEntry } from "./protocol.ts";
import { LINK_WORDS } from "./rules/floorLinks.ts";
import { DM, token } from "./testutil.ts";

/*
 * Who may go through an opening and how each refusal reads
 * (docs/design/design-v1-floors.md phase 4, 5, 8.1, 4.5, 4.6): Fly up and Fly
 * down for a creature in the air, a creature on the ground refused, hidden
 * stairs that are no stairs to a player, a player's undo and redo of a fall
 * under its server-made records, and pits and trapdoors kept off every end.
 * The tower's opening (o1, the hole on Upper floor, over o2 on Ground floor)
 * lies 2 by 2 at 6, 6.
 */

const deps = { canUseAsset: () => true };
const decide = (state: RoomState, op: Op, who: Viewer = ANA) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const climb = (linkId: string, tokenId = "thorn"): Op => ({ t: "token.climb", tokenId, linkId });

/** The tower with its opening and Thorn placed as told, Ana's creature. */
function holed(thorn: Partial<Token> = {}, over: Partial<RoomState> = {}): RoomState {
  return withOpening(tower({ tokens: { thorn: thornToken(thorn) }, ...over }));
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

const raise = (sceneId: string, cells: string[], height: number): Op => ({ t: "build.height", sceneId, cells, height });

function blocking(state: RoomState, ...floors: string[]): RoomState {
  const scenes = { ...state.scenes };
  for (const id of floors) scenes[id] = { ...scenes[id]!, blockMovement: true };
  return { ...state, scenes };
}

describe("Fly up and Fly down (5)", () => {
  test("Thorn in the air over the hole flies down, and under it flies up, each 5 ft over the far ground for the floor's height", () => {
    const over = onThornsTurn(holed({ sceneId: UPPER, x: 6, y: 6, elevation: 10 }));
    assert.equal(decide(over, climb("o1")), "ok");
    const down = applied(over, climb("o1"), ANA).state.tokens.thorn!;
    assert.deepEqual([down.sceneId, down.x, down.y, down.elevation], [GROUND, 6, 6, 5]);
    const leg = down.path!.stops[down.path!.stops.length - 1]!;
    assert.deepEqual([leg.moved, leg.cost], [10, 10], "the floor's height, no ladder's doubling");
    const under = onThornsTurn(holed({ x: 6, y: 6, elevation: 5 }));
    assert.equal(decide(under, climb("o2")), "ok");
    const up = applied(under, climb("o2"), ANA).state.tokens.thorn!;
    assert.deepEqual([up.sceneId, up.elevation], [UPPER, 5]);
  });

  test("a prone flier costs the floor's height alone, as no crawl comes into it", () => {
    const prone = onThornsTurn(holed({ sceneId: UPPER, x: 6, y: 6, elevation: 10 }));
    const thornChar = prone.characters.thorn!;
    const state = { ...prone, characters: { ...prone.characters, thorn: { ...thornChar, actor: { ...thornChar.actor, effects: [{ id: "e1", key: "prone", name: "Prone" } as never] } } } };
    const down = applied(state, climb("o1"), ANA).state.tokens.thorn!;
    assert.equal(down.path!.stops[down.path!.stops.length - 1]!.cost, 10);
  });

  test("a creature on the ground over or under the hole is refused, the DM's too", () => {
    const words = `invalid: ${LINK_WORDS.onlyInAir}`;
    assert.equal(LINK_WORDS.onlyInAir, "Only a creature in the air goes through an opening.");
    const over = holed({ sceneId: UPPER, x: 6, y: 6 });
    assert.equal(decide(over, climb("o1")), words);
    const under = holed({ x: 6, y: 6 });
    assert.equal(decide(under, climb("o2")), words);
    assert.equal(decide(under, climb("o2"), DM), "ok", "the reducer answers the DM");
    assert.throws(() => applied(under, climb("o2"), DM), /Only a creature in the air goes through an opening\./);
    // In the air but off the squares: no opening here, as for stairs.
    assert.equal(decide(holed({ x: 12, y: 12, elevation: 5 }), climb("o2")), `invalid: ${LINK_WORDS.noStairs}`);
  });

  test("too big reads the opening's words, and a creature that fits flies through", () => {
    // Where squeezing is not allowed, as on open ground, too big is too big (rules/floorLinks.ts standsOn).
    assert.equal(decide(holed({ x: 6, y: 6, elevation: 5, size: "huge" }), climb("o2")), "invalid: Too big for this opening.");
    assert.equal(decide(holed({ x: 6, y: 6, elevation: 5, size: "large" }), climb("o2")), "ok");
  });

  test("on a holder Ana receives, its holder goes through the opening, and on one she does not Thorn flies alone", () => {
    const riding = (visibility: Token["visibility"]) => withTokens(holed({ x: 6, y: 6, elevation: 5, attached: { to: "griffon", kind: "ride" } }), token("griffon", { name: "Griffon", size: "large", x: 6, y: 6, elevation: 5, visibility }));
    assert.equal(decide(riding("all"), climb("o2")), "invalid: Thorn is carried. Its holder goes through the opening.");
    assert.equal(decide(riding("dm"), climb("o2")), "ok");
    const alone = applied(riding("dm"), climb("o2"), ANA).state;
    assert.deepEqual([alone.tokens.thorn!.sceneId, alone.tokens.thorn!.attached, alone.tokens.griffon!.sceneId], [UPPER, undefined, GROUND]);
  });
});

describe("hidden stairs (8.1)", () => {
  /** Both ends hidden as stored, at the rev they had, so only the hiding differs. */
  function hidden(state: RoomState): RoomState {
    return { ...state, floorLinks: Object.fromEntries(Object.entries(state.floorLinks ?? {}).map(([id, link]) => [id, { ...link, hidden: true as const }])) };
  }

  test("a player's climb of hidden stairs is no stairs, and the DM climbs them", () => {
    const s = hidden(withStairs());
    assert.equal(decide(s, climb("l1")), `invalid: ${LINK_WORDS.noStairs}`);
    assert.equal(decide(s, climb("l1"), DM), "ok");
    assert.equal(applied(s, climb("l1"), DM).state.tokens.thorn!.sceneId, UPPER);
  });

  test("a player's undo of an earlier climb up a ladder hidden since answers as an end they cannot see", () => {
    const ladder = withStairs(tower(), { kind: "ladder" });
    const r = applied(ladder, climb("l1"), ANA);
    const link = ladder.floorLinks!.l1!;
    const undo: Op = { t: "sys.restore", entries: [...(r.inverse ?? [])], from: "undo", deps: true, climb: { tokenId: "thorn", linkId: "l1", rev: link.rev, made: link.made, from: GROUND, to: UPPER } };
    assert.equal(decide(r.state, undo), "ok");
    // The words of an end gone, never "the ladder changed", which names what they cannot see.
    assert.equal(decide(hidden(r.state), undo), `invalid: ${LINK_WORDS.changed("stairs")}`);
  });
});

describe("a player's undo and redo of a fall (4.5)", () => {
  type Restore = Extract<Op, { t: "sys.restore" }>;

  /** A player's inverse as the actor keeps it: every fall card out of it (4.5). */
  function playerEntries(entries: readonly RestoreEntry[] | null): RestoreEntry[] {
    return (entries ?? []).filter((e) => !e.key.startsWith("fall:"));
  }

  /** Thorn walks from 4, 6 on Upper floor onto the hole and falls, with the undo the server builds. */
  function fell(state: RoomState = holed({ sceneId: UPPER, x: 4, y: 6 }), op: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 6 }) {
    const r = applied(state, op, ANA);
    const records = r.falls!;
    assert.equal(records.length, 1, "it fell");
    assert.equal(r.state.tokens[records[0]!.tokenId]!.sceneId, GROUND);
    const undo = (entries: readonly RestoreEntry[] = playerEntries(r.inverse), falls: FallRecord[] = records): Restore => ({ t: "sys.restore", entries: [...entries], from: "undo", deps: true, falls });
    return { before: state, after: r.state, records, inverse: r.inverse, undo };
  }

  /** The redo the server builds from the undo it ran, its records carrying the card the undo removed. */
  function redoOf(f: ReturnType<typeof fell>, from: RoomState = f.after) {
    const down = applied(from, f.undo(), ANA);
    const card = from.falls?.[f.records[0]!.fallId];
    const falls = f.records.map((rec) => ({ ...rec, ...(card ? { card } : {}) }));
    const redo: Restore = { t: "sys.restore", entries: playerEntries(down.inverse), from: "redo", deps: true, falls };
    return { up: down.state, redo };
  }

  test("the undo takes Thorn back up over the hole, and the redo down again with its card", () => {
    const f = fell();
    assert.equal(decide(f.after, f.undo()), "ok");
    const { up, redo } = redoOf(f);
    assert.equal(up.tokens.thorn!.sceneId, UPPER);
    assert.equal(Object.keys(up.falls ?? {}).length, 0, "the card goes with the undo");
    assert.equal(decide(up, redo), "ok");
    const again = applied(up, redo, ANA).state;
    assert.equal(again.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(Object.keys(again.falls ?? {}), [f.records[0]!.fallId]);
    // Undo, then redo, then undo again.
    const second = { ...f, after: again };
    assert.equal(decide(again, second.undo()), "ok");
  });

  test("without the records the change of floor is no move of the player's", () => {
    const f = fell();
    const { falls: _falls, ...bare } = f.undo();
    assert.match(decide(f.after, bare), /^forbidden/);
    // An undo goes back the way the fall came, never on down.
    assert.notEqual(decide(f.after, f.undo(undefined, f.records.map((r) => ({ ...r, from: GROUND, to: UPPER })))), "ok");
  });

  test("a redo after a wall was built across the walk is refused as a wall in the way", () => {
    const f = fell(blocking(holed({ sceneId: UPPER, x: 4, y: 6 }), UPPER));
    const { up, redo } = redoOf(f);
    assert.equal(decide(up, redo), "ok");
    const walled = run(up, { t: "build.edge", sceneId: UPPER, edges: [{ key: "5,6,w", feature: { kind: "wall" } }] });
    assert.equal(decide(walled, redo), "forbidden: a wall is in the way");
  });

  test("an undo after the DM moved the opening reads the opening changed", () => {
    const f = fell();
    const moved = run(f.after, { t: "floorLink.update", linkId: "o1", patch: { rect: { x: 12, y: 12, w: 2, h: 2 } } });
    assert.equal(decide(moved, f.undo()), `invalid: ${LINK_WORDS.changed("opening")}`);
    assert.equal(LINK_WORDS.changed("opening"), "the opening changed");
    // Its rev alone, the squares as they were: the opening Ana was shown, so taken (STAIRS-REV-1).
    const revved = { ...f.after, floorLinks: Object.fromEntries(Object.entries(f.after.floorLinks!).map(([id, l]) => [id, { ...l, rev: l.rev + 1 }])) };
    assert.equal(decide(revved, f.undo()), "ok");
  });

  test("a redo after the hole was moved or locked in the stored state reads the opening changed, and one at another rev or `made` alone goes", () => {
    const f = fell();
    const { up, redo } = redoOf(f);
    const ends = (state: RoomState, patch: Partial<FloorLink>): RoomState => ({ ...state, floorLinks: Object.fromEntries(Object.entries(state.floorLinks!).map(([id, l]) => [id, { ...l, ...patch }])) });
    // A player is shown neither, so neither decides (STAIRS-REV-1).
    assert.equal(decide(ends(up, { rev: 5 }), redo), "ok");
    assert.equal(decide(ends(up, { made: 999 }), redo), "ok");
    assert.equal(decide(ends(up, { locked: true }), redo), "invalid: the opening changed");
    const moved = run(up, { t: "floorLink.update", linkId: "o1", patch: { rect: { x: 12, y: 12, w: 2, h: 2 } } });
    assert.equal(decide(moved, redo), "invalid: the opening changed");
    // Thorn walked off the floor it fell from since: no redo from there.
    const elsewhere = run(up, { t: "token.update", tokenId: "thorn", patch: { sceneId: GROUND } });
    assert.notEqual(decide(elsewhere, redo), "ok");
  });

  test("a redo whose space would not lie wholly inside the hole on the floor it fell from is refused", () => {
    const f = fell();
    const { up, redo } = redoOf(f);
    const offHole = { ...redo, entries: redo.entries.map((e) => (e.key === keys.token("thorn") ? { ...e, value: { ...(e.value as Token), x: 9 } } : e)) };
    assert.equal(decide(up, offHole), "invalid: the opening changed");
  });

  test("a redo of a hole the player is not sent answers as an end they cannot see", () => {
    const f = fell();
    const { up, redo } = redoOf(f);
    const gone = run(up, { t: "floorLink.delete", linkId: "o1" });
    assert.equal(decide(gone, redo), `invalid: ${LINK_WORDS.changed("stairs")}`);
    // Under full fog the hole is withheld from Ana, though it stands at its rev.
    const fogged = { ...up, scenes: { ...up.scenes, [UPPER]: { ...up.scenes[UPPER]!, fogEnabled: true } } };
    assert.equal(decide(fogged, redo), `invalid: ${LINK_WORDS.changed("stairs")}`);
  });

  test("a redo walks to the spot over the hole at the floor's own ground, not the height it landed at below", () => {
    // Ground floor's squares under the hole lie 5 ft down, so the landing is lower than the walk's end.
    const sunk = run(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }), raise(GROUND, ["6,6", "7,6", "6,7", "7,7"], -5));
    const f = fell(blocking(withOpening(sunk), UPPER));
    assert.equal(f.after.tokens.thorn!.elevation, -5);
    const { up, redo } = redoOf(f);
    assert.equal(decide(up, redo), "ok");
    // A 10 ft step on the way stops a walk on the ground there, whatever height Ground floor's squares lie at below.
    const high = run(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }), raise(GROUND, ["6,6", "7,6", "6,7", "7,7"], 20));
    const back = redoOf(fell(blocking(withOpening(high), UPPER)));
    const ledge = run(back.up, raise(UPPER, ["5,6"], 10));
    assert.equal(decide(ledge, back.redo), "forbidden: a ledge is in the way");
  });

  test("a root hidden from the player since answers that it is not here, before any end is read", () => {
    // A rat Ana moves under Players move any token, which the DM may hide from her, as she owns none of it.
    const base = withTokens(holed({ sceneId: UPPER, x: 4, y: 6 }), token("rat", { name: "Rat", sceneId: UPPER, x: 4, y: 8 }));
    const anyToken = { ...base, meta: { ...base.meta, settings: { ...base.meta.settings, playersMoveAny: "all" as const } } };
    const f = fell(anyToken, { t: "token.move", tokenId: "rat", x: 6, y: 6 });
    const hiddenRat = (state: RoomState) => ({ ...state, tokens: { ...state.tokens, rat: { ...state.tokens.rat!, visibility: "dm" as const } } });
    assert.equal(decide(f.after, f.undo()), "ok");
    assert.equal(decide(hiddenRat(f.after), f.undo()), "gone: that is not here");
    // The opening gone too: still the gone token's words, so nothing of the end is read.
    const both = run(hiddenRat(f.after), { t: "floorLink.delete", linkId: "o1" });
    assert.equal(decide(both, f.undo()), "gone: that is not here");
    const { up, redo } = redoOf(f);
    assert.equal(decide(hiddenRat(up), redo), "gone: that is not here");
  });

  test("an area following Thorn comes back up with it, and one that changed more than its floor does not", () => {
    const aura = { id: "aura", rev: 0, sceneId: UPPER, shape: "sphere", size: 10, origin: { x: 4.5, y: 6.5, z: 0 }, yaw: 0, includeOrigin: true, ownerId: "p1", attachedTo: "thorn" } as AreaTemplate;
    const f = fell(holed({ sceneId: UPPER, x: 4, y: 6 }, { templates: { aura } }));
    assert.equal(f.after.templates.aura!.sceneId, GROUND);
    assert.equal(decide(f.after, f.undo()), "ok");
    const changed = playerEntries(f.inverse).map((e) => (e.key === keys.template("aura") ? { ...e, value: { ...(e.value as AreaTemplate), size: 30 } } : e));
    assert.match(decide(f.after, f.undo(changed)), /^forbidden/);
    const { up, redo } = redoOf(f);
    assert.equal(decide(up, redo), "ok");
  });

  test("a Large Thorn shrinking through a one-square opening is put back and shrunk again, each judged on the floor it fell from", () => {
    const one = { x: 6, y: 6, w: 1, h: 1 };
    // A wall inside the Large space on Ground floor alone: judged there, the growth back would not stand clear.
    const base = blocking(withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 6, y: 6, size: "large" }) } }), { rect: one }), UPPER, GROUND);
    const walledBelow = run(base, { t: "build.edge", sceneId: GROUND, edges: [{ key: "7,6,w", feature: { kind: "wall" } }] });
    const f = fell(walledBelow, { t: "token.update", tokenId: "thorn", patch: { size: "medium" } });
    assert.deepEqual([f.after.tokens.thorn!.size, f.after.tokens.thorn!.sceneId], ["medium", GROUND]);
    assert.equal(decide(f.after, f.undo()), "ok");
    const { up, redo } = redoOf(f);
    assert.deepEqual([up.tokens.thorn!.size, up.tokens.thorn!.sceneId], ["large", UPPER]);
    assert.equal(decide(up, redo), "ok");
    // The same wall on Upper floor, where the resize was made, refuses the growth back.
    const walledAbove = run(f.after, { t: "build.edge", sceneId: UPPER, edges: [{ key: "7,6,w", feature: { kind: "wall" } }] });
    assert.notEqual(decide(walledAbove, f.undo()), "ok");
  });
});

describe("pits and trapdoors kept off every end (4.6)", () => {
  const rig = { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false };
  const create = (sceneId: string, cells: { x: number; y: number; w: number; h: number }, extra: object): Op => ({ t: "trap.create", trap: { id: "t9", sceneId, name: "Pit", zone: { cells: [cells] }, rig: { ...rig, ...extra } } }) as Op;
  const ends = () => withOpening(withStairs(withStairs(tower(), {}), { id: "l3", pairId: "l4", rect: { x: 10, y: 3, w: 1, h: 1 }, kind: "ladder" }));

  test("a pit or a trapdoor created over stairs, a ladder, or either end of an opening is refused in the trap pane's words, by the DM too", () => {
    const s = ends();
    const cases: [string, { x: number; y: number; w: number; h: number }, string][] = [
      [GROUND, { x: 3, y: 3, w: 1, h: 1 }, "A pit can't open under stairs. Remove them first."],
      [UPPER, { x: 10, y: 3, w: 1, h: 1 }, "A pit can't open under a ladder. Remove it first."],
      [UPPER, { x: 7, y: 7, w: 1, h: 1 }, "A pit can't open under an opening. Remove it first."],
      [GROUND, { x: 6, y: 6, w: 2, h: 1 }, "A pit can't open under an opening. Remove it first."],
    ];
    for (const [sceneId, cells, words] of cases) {
      for (const extra of [{ pit: { floor: -10 } }, { below: true }]) {
        assert.equal(decide(s, create(sceneId, cells, extra), DM), `invalid: ${words}`, `${sceneId} ${JSON.stringify(extra)}`);
      }
    }
    assert.equal(decide(s, create(UPPER, { x: 14, y: 14, w: 2, h: 2 }, { below: true }), DM), "ok", "a trapdoor away from every end");
  });

  test("a plain trap patched into a trapdoor over an end, or a trapdoor moved onto one, is refused", () => {
    const s = run(ends(), { t: "trap.create", trap: { id: "t1", sceneId: UPPER, name: "Plate", zone: { cells: [{ x: 6, y: 6, w: 1, h: 1 }] }, rig } });
    assert.equal(decide(s, { t: "trap.update", trapId: "t1", patch: { rig: { below: true } } } as Op, DM), "invalid: A pit can't open under an opening. Remove it first.");
    const away = run(ends(), create(UPPER, { x: 14, y: 14, w: 2, h: 2 }, { below: true }));
    assert.equal(decide(away, { t: "trap.update", trapId: "t9", patch: { zone: { cells: [{ x: 10, y: 3, w: 1, h: 1 }] } } } as Op, DM), "invalid: A pit can't open under a ladder. Remove it first.");
    assert.equal(decide(away, { t: "trap.update", trapId: "t9", patch: { rig: { below: null } } } as unknown as Op, DM), "ok");
  });

  test("placing stairs over a trapdoor is refused in the builder's words", () => {
    const s = run(tower(), create(UPPER, { x: 3, y: 3, w: 1, h: 1 }, { below: true }));
    const d = canApply(putOp(), DM, s, deps);
    const r = d.ok ? null : d.message;
    // The put is the reducer's to refuse: a trapdoor lies under those squares.
    assert.equal(r, null);
    assert.throws(() => applied(s, putOp()), /A pit trap lies under those squares on Upper floor\./);
  });
});
