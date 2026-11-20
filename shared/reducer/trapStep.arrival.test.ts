import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, applied, thornToken, tower, trapdoor, withOpening, withStairs, withTrapdoor } from "../floorLinksTestutil.ts";
import type { LogEntry, RoomState, Token, Trap, TrapRig } from "../model.ts";
import { DM, token, trap } from "../testutil.ts";

/*
 * The arrival step (docs/design/design-v1-floors.md phase 4, 6, 4.3 step
 * 6): each creature's last landing in an op sets off the armed traps on the
 * landing floor that go off on entering, as a walk's would, once an op,
 * from change format 64. The tower's stairs (withStairs) climb from Ground
 * floor at 3, 3 to the same squares of Upper floor, and its opening lies at
 * 6, 6.
 */

/** A trap on Upper floor's squares, armed, going off on entering and stopping nothing, its rig changed by `rig`. */
function upTrap(id: string, cells: Trap["zone"], rig: Partial<TrapRig> = {}): Trap {
  const base = trap(id, { sceneId: UPPER, name: id, zone: cells });
  return { ...base, rig: { ...base.rig!, stops: false, ...rig } };
}

/** Upper floor's landing of the stairs, 3, 3 to 4, 3. */
const LANDING: Trap["zone"] = { cells: [{ x: 3, y: 3, w: 2, h: 1 }] };

function withTraps(state: RoomState, ...traps: Trap[]): RoomState {
  return { ...state, traps: { ...state.traps, ...Object.fromEntries(traps.map((t) => [t.id, t])) } };
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

/** The DM's trap lines the op left, each as its trap, how and who set it off. */
function sprung(state: RoomState): { trapId: string; how: string; by: string[]; hidden: boolean }[] {
  return (state.trapLog ?? []).flatMap((line: LogEntry) => (line.data?.type === "trap" ? [{ trapId: line.data.trapId, how: line.data.how, by: line.data.by, hidden: line.data.hidden === true }] : []));
}

const climb = (tokenId: string, linkId = "l1") => ({ t: "token.climb" as const, tokenId, linkId });

describe("the arrival step (6)", () => {
  test("a climb onto an armed trap that goes off on entering springs it, in the public pass, as entering", () => {
    const r = applied(withTraps(withStairs(), upTrap("snare", LANDING)), climb("thorn"), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.deepEqual(sprung(r.state), [{ trapId: "snare", how: "enter", by: ["thorn"], hidden: false }]);
    assert.equal(r.state.traps.snare!.state, "sprung");
    assert.equal(r.state.traps.snare!.found, true, "found on its springing, as players saw Thorn land");
  });

  test("a trap that goes off only on leaving, or on a turn, stays armed under a landing", () => {
    for (const on of [["leave"], ["turnStart"]] as TrapRig["on"][]) {
      const r = applied(withTraps(withStairs(), upTrap("snare", LANDING, { on })), climb("thorn"), ANA);
      assert.equal(r.state.traps.snare!.state, "armed", on.join());
      assert.deepEqual(sprung(r.state), []);
    }
  });

  test("a flier landing 5 ft over the far ground skips a trap only creatures on the floor set off, and sets off one any creature does", () => {
    const bat = token("bat", { sceneId: GROUND, name: "Bat", size: "tiny", x: 6, y: 6, elevation: 5 });
    const hole: Trap["zone"] = { cells: [{ x: 6, y: 6, w: 2, h: 2 }] };
    // Players have reached Upper floor, so its traps are live though no party member stands there.
    const state = { ...withTokens(withOpening(tower()), bat), openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } };
    const floorOnly = applied(withTraps(state, upTrap("plate", hole)), climb("bat", "o2"));
    assert.deepEqual([floorOnly.state.tokens.bat!.sceneId, floorOnly.state.tokens.bat!.elevation], [UPPER, 5]);
    assert.equal(floorOnly.state.traps.plate!.state, "armed");
    const any = applied(withTraps(state, upTrap("glyph", hole, { floor: false })), climb("bat", "o2"));
    assert.deepEqual(sprung(any.state).map((s) => [s.trapId, s.by]), [["glyph", ["bat"]]]);
  });

  test("who and the smallest size decide who a landing sets a trap off for", () => {
    const party = applied(withTraps(withStairs(), upTrap("snare", LANDING, { who: "others" })), climb("thorn"), ANA);
    assert.equal(party.state.traps.snare!.state, "armed", "a party member is not one of the others");
    const theirs = applied(withTraps(withStairs(), upTrap("snare", LANDING, { who: "party" })), climb("thorn"), ANA);
    assert.equal(theirs.state.traps.snare!.state, "sprung");
    const rat = token("rat", { sceneId: GROUND, name: "Rat", size: "tiny", x: 3, y: 3 });
    const tiny = applied(withTraps(withStairs(tower({ tokens: { rat } })), upTrap("snare", LANDING, { minSize: "small" })), climb("rat"));
    assert.equal(tiny.state.tokens.rat!.sceneId, UPPER);
    assert.equal(tiny.state.traps.snare!.state, "armed", "a Tiny creature is under the smallest size");
  });

  test("a trapdoor dropping Thorn onto a second trapdoor drops twice, and the floor below that sets nothing off", () => {
    const attic = trapdoor("td1", { sceneId: ATTIC });
    const upper = trapdoor("td2");
    const ground = trap("tg", { sceneId: GROUND, name: "Plate", zone: { cells: [{ x: 10, y: 10, w: 2, h: 2 }] } });
    const state = withTraps(withTrapdoor(withTrapdoor(tower({ tokens: { thorn: thornToken({ sceneId: ATTIC, x: 10, y: 10 }) } }), attic), upper), ground);
    const r = applied(state, { t: "trap.spring", trapId: "td1", tokenIds: ["thorn"] });
    assert.deepEqual([r.state.tokens.thorn!.sceneId, r.state.tokens.thorn!.x, r.state.tokens.thorn!.y], [GROUND, 10, 10]);
    assert.deepEqual(
      sprung(r.state).map((s) => [s.trapId, s.how]),
      [
        ["td1", "hand"],
        ["td2", "enter"],
      ],
    );
    assert.equal(r.state.traps.tg!.state, "armed", "no third springing");
    assert.deepEqual(
      Object.values(r.state.falls ?? {})
        .map((c) => `${c.from}>${c.sceneId} ${c.ft}`)
        .sort(),
      [`${ATTIC}>${UPPER} 10`, `${UPPER}>${GROUND} 10`],
    );
  });

  test("a hidden creature a player's climb lands springs a trap only in the private pass, which runs nothing and leaves it armed", () => {
    // Ana's horse carries a rat the DM hid. Only the rat is one of the others the trap goes off for.
    const horse = token("horse", { name: "Horse", kind: "npc", size: "large", x: 3, y: 3, ownerIds: ["p1"], disposition: "ally" });
    const rat = token("rat", { name: "Rat", size: "tiny", x: 4, y: 4, visibility: "dm", attached: { to: "horse", kind: "ride" } });
    const light = { id: "lamp", rev: 0, sceneId: UPPER, x: 1, y: 1, on: false, bright: 10, dim: 20 } as unknown as NonNullable<RoomState["lights"]>[string];
    const snare = upTrap("snare", { cells: [{ x: 4, y: 4, w: 1, h: 1 }] }, { who: "others", actions: [{ light: "lamp", on: true }] });
    const state = { ...withTraps(withStairs(tower({ tokens: { horse, rat } }), { rect: { x: 3, y: 3, w: 2, h: 2 } }), snare), lights: { lamp: light } };
    const r = applied(state, climb("horse"), ANA);
    assert.deepEqual([r.state.tokens.horse!.sceneId, r.state.tokens.rat!.sceneId], [UPPER, UPPER]);
    assert.deepEqual(sprung(r.state), [{ trapId: "snare", how: "enter", by: ["rat"], hidden: true }]);
    assert.equal(r.state.traps.snare!.state, "armed");
    assert.equal(r.state.lights.lamp!.on, false, "its action waits for the DM");
    assert.equal(r.state.traps.snare!.rig!.due?.[0]?.hidden, true);
    const dm = applied(state, climb("horse"), DM);
    assert.equal(dm.state.traps.snare!.state, "sprung", "the DM's own op sets a private springing off as the trap is set");
    assert.equal(dm.state.lights.lamp!.on, true);
  });

  test("creatures landing together on one trap set it off in one springing", () => {
    const horse = token("horse", { name: "Horse", kind: "npc", size: "large", x: 3, y: 3, ownerIds: ["p1"], disposition: "ally" });
    const thorn = thornToken({ x: 3, y: 3, attached: { to: "horse", kind: "ride" } });
    const snare = upTrap("snare", { cells: [{ x: 3, y: 3, w: 2, h: 2 }] }, { floor: false });
    const r = applied(withTraps(withStairs(tower({ tokens: { horse, thorn } }), { rect: { x: 3, y: 3, w: 2, h: 2 } }), snare), climb("horse"), ANA);
    assert.deepEqual([r.state.tokens.horse!.sceneId, r.state.tokens.thorn!.sceneId], [UPPER, UPPER]);
    assert.deepEqual(sprung(r.state), [{ trapId: "snare", how: "enter", by: ["horse", "thorn"], hidden: false }]);
  });

  test("a trap already sprung, or disarmed, is not sprung by a landing", () => {
    for (const state of ["sprung", "disarmed"] as const) {
      const r = applied(withTraps(withStairs(), { ...upTrap("snare", LANDING), state }), climb("thorn"), ANA);
      assert.deepEqual(sprung(r.state), [], state);
    }
  });

  test("a trap on a floor players have not reached stays armed under a landing, as every trap there", () => {
    const base = withTraps(withStairs(), upTrap("snare", LANDING));
    // The DM's goblin climbs to Upper floor, where no party member stands and no mark opens it.
    const goblin = token("goblin", { name: "Goblin", x: 3, y: 3 });
    const r = applied({ ...base, tokens: { goblin } }, climb("goblin"));
    assert.equal(r.state.tokens.goblin!.sceneId, UPPER);
    assert.equal(r.state.traps.snare!.state, "armed");
  });

  test("ops stored before change format 64 land on no arrival trap", () => {
    const r = applied(withTraps(withStairs(), upTrap("snare", LANDING)), climb("thorn"), ANA, 63);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.equal(r.state.traps.snare!.state, "armed");
    assert.deepEqual(sprung(r.state), []);
  });

  test("the arrival's writes are trap keys, and a player who sees them changed cannot undo the step themselves", () => {
    const r = applied(withTraps(withStairs(), upTrap("snare", LANDING)), climb("thorn"), ANA);
    assert.ok(r.trapWrote?.has("trap:snare"));
    assert.ok(!r.trapWrote?.has("token:thorn"), "the climb's own write stays the move's");
    assert.equal(r.trapped, true);
    const plain = r.withoutTraps?.();
    assert.ok(plain?.ok && plain.state.traps.snare!.state === "armed", "the op without its trap step springs nothing");
    const dm = applied(withTraps(withStairs(), upTrap("snare", LANDING)), climb("thorn"), DM);
    assert.equal(dm.trapped, undefined, "only a player's step is marked");
  });
});
