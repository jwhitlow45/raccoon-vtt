import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkOps, serverApply } from "./differential.ts";
import { ANA, ATTIC, BREE, GROUND, UPPER, run, thornToken, tower, withOpening, withStairs } from "./floorLinksTestutil.ts";
import { keys } from "./keys.ts";
import type { RoomState, Token, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectEntity } from "./project.ts";
import type { Op } from "./protocol.ts";
import { DM, deepClone, reveal, template, token } from "./testutil.ts";

/*
 * A player's cast across an opening (docs/design/design-v1-floors.md phase 4,
 * 9.2, D-261119-111): a target on the floor an opening on the caster's floor
 * leads to, by an end the player was sent, where players see both floors.
 * The answer is structural: it reads no wall, ground or creature the player
 * was not sent, so a refusal never says what lies under fog (twins O10 and
 * O10b, 10.5).
 */

const deps = { canUseAsset: () => true };
const decide = (state: RoomState, op: Op, who: Viewer = ANA) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const GONE = "gone: that is not here";
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

const cast = (targets: string[], sceneId = UPPER, id = "k1"): Op => ({ t: "cast.ask", cast: { id, caster: "thorn", sceneId, spell: "Fireball", targets } });
const reached = (state: RoomState, ...ids: string[]): RoomState => ({ ...state, openFloors: { ...state.openFloors, ...Object.fromEntries(ids.map((id) => [id, { sceneId: id, rev: 1 }])) } });
const goblin = (id: string, sceneId: string, x: number, y: number, over: Partial<Token> = {}): Token => token(id, { name: "Goblin", sceneId, x, y, ...over });

/** Thorn upstairs at 4, 8, Upper floor reached, a goblin below the hole on Ground floor and one on the Attic, and the opening o1 over o2 at 6, 6. */
function holed(over: { thorn?: Partial<Token>; opening?: boolean } = {}): RoomState {
  const base = reached(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 8, ...over.thorn }), below: goblin("below", GROUND, 6, 6), attic: goblin("attic", ATTIC, 6, 6) } }), UPPER);
  return over.opening === false ? base : withOpening(base);
}

describe("a cast's target across an opening", () => {
  test("a target below through the hole on the caster's floor is allowed, and one above through its lower end", () => {
    assert.equal(decide(holed(), cast(["below"])), "ok");
    const fromBelow = { ...holed({ thorn: { sceneId: GROUND, x: 4, y: 8 } }), tokens: { ...holed().tokens, thorn: thornToken({ sceneId: GROUND, x: 4, y: 8 }), above: goblin("above", UPPER, 6, 6) } };
    assert.equal(decide(fromBelow, cast(["above"], GROUND)), "ok");
  });

  test("with no opening, through stairs, or to a floor the opening does not lead to, it answers as a target not there", () => {
    assert.equal(decide(holed({ opening: false }), cast(["below"])), GONE);
    assert.equal(decide(withStairs(holed({ opening: false }), { sceneId: UPPER, to: GROUND, rect: { x: 6, y: 6, w: 2, h: 1 } }), cast(["below"])), GONE, "stairs join floors for walking, not for spells");
    assert.equal(decide(reached(holed(), ATTIC), cast(["attic"])), GONE, "the Attic, which no opening on Upper floor leads to");
    assert.equal(decide(holed(), cast(["below", "thorn"])), "ok", "a target on the caster's floor beside one below");
  });

  test("the gate is the players': a caster's floor held only through a creature the DM hid, or a hidden target, joins nothing", () => {
    const hiddenThorn = { ...holed({ thorn: { visibility: "dm" } }), openFloors: {} };
    assert.equal(decide(hiddenThorn, cast(["thorn"])), "ok", "Ana still casts on her own floor");
    assert.equal(decide(hiddenThorn, cast(["below"])), GONE, "but Upper floor, held only through hidden Thorn, is not seen by players");
    // An opening from the Attic down to Upper floor, the Attic held by Ana only through her owl the DM hid there.
    const owl = token("owl", { kind: "npc", ownerIds: ["p1"], visibility: "dm", sceneId: ATTIC, x: 2, y: 2 });
    const attic = withOpening({ ...holed({ opening: false }), tokens: { ...holed().tokens, owl } }, { upper: ATTIC, lower: UPPER });
    assert.ok(projectEntity(keys.token("attic"), attic, ANA, { sceneId: null }), "Ana sees the goblin on the Attic");
    assert.equal(decide(attic, cast(["attic"])), GONE, "but players do not see the Attic, so the opening joins nothing");
    assert.equal(decide(reached(attic, ATTIC), cast(["attic"])), "ok", "once they reach it, it does");
    const hiddenGoblin = { ...holed(), tokens: { ...holed().tokens, below: goblin("below", GROUND, 6, 6, { visibility: "dm" }) } };
    assert.equal(decide(hiddenGoblin, cast(["below"])), GONE);
    const dark = { ...holed(), meta: { ...holed().meta, view: { follow: false, blackout: true } } };
    assert.equal(decide(dark, cast(["below"])), GONE);
  });

  test("an area is still the caster's floor's own", () => {
    const area = template("a1", { sceneId: GROUND, ownerId: "p1", visibility: "all" });
    const state = { ...holed(), templates: { a1: area } };
    assert.equal(decide(state, { t: "cast.ask", cast: { id: "k1", caster: "thorn", sceneId: UPPER, spell: "Fireball", area: "a1" } }), GONE);
  });
});

describe("O10b: an opening the player was not sent", () => {
  /** Fog on both floors, revealed round Thorn upstairs and round a goblin below away from the hole, so only the opening's squares lie under full fog. */
  function fogged(opening: boolean): RoomState {
    const base = holed({ opening, thorn: { x: 2, y: 2 } });
    const s: RoomState = deepClone({
      ...base,
      tokens: { ...base.tokens, below: goblin("below", GROUND, 12, 12) },
      scenes: { ...base.scenes, [UPPER]: { ...base.scenes[UPPER]!, fogEnabled: true }, [GROUND]: { ...base.scenes[GROUND]!, fogEnabled: true } },
    });
    reveal(s, UPPER, { x: 0, y: 0, w: 5, h: 5 });
    reveal(s, GROUND, { x: 10, y: 10, w: 5, h: 5 });
    return s;
  }

  test("a fully fogged opening answers as none, both ends unsent, and revealed it is allowed", () => {
    const [a, b] = [fogged(true), fogged(false)];
    assert.equal(projectEntity(keys.floorLink("o1"), a, ANA, { sceneId: null }), null, "Ana holds neither end");
    assert.ok(projectEntity(keys.token("below"), a, ANA, { sceneId: null }), "but sees the goblin below");
    assert.equal(decide(a, cast(["below"])), GONE);
    checkOps({
      name: "O10b",
      a,
      b,
      equal: [ANA, BREE, DISPLAY],
      steps: [
        { who: ANA, op: cast(["below"]), note: "a hand-made cast through the hole" },
        { who: ANA, op: cast(["thorn"], UPPER, "k2"), note: "and one on her own floor" },
      ],
    }, serverApply);
    const shown = deepClone(a);
    reveal(shown, UPPER, { x: 6, y: 6, w: 2, h: 2 });
    assert.equal(decide(shown, cast(["below"])), "ok", "the end sent, the cast goes");
  });
});

describe("O10: what lies under fog below never changes the answer", () => {
  /** Ana's Thorn upstairs, both floors fogged with fog revealed upstairs, the hole and the goblin below revealed, and below either a wall at the reach's edge, raised ground, or a hidden goblin, all under fog. */
  function room(below: "wall" | "ground" | "hidden" | "none"): RoomState {
    const base = holed({ thorn: { x: 2, y: 2 } });
    let s: RoomState = deepClone({
      ...base,
      scenes: { ...base.scenes, [UPPER]: { ...base.scenes[UPPER]!, fogEnabled: true }, [GROUND]: { ...base.scenes[GROUND]!, fogEnabled: true } },
      ...(below === "hidden" ? { tokens: { ...base.tokens, lurker: goblin("lurker", GROUND, 7, 6, { visibility: "dm" }) } } : {}),
    });
    if (below === "wall") s = { ...s, buildChunks: { [`${GROUND}:0,0`]: { sceneId: GROUND, cx: 0, cy: 0, rev: 1, cells: {}, edges: { "9,6,w": { kind: "wall" }, "9,7,w": { kind: "wall" } } } } };
    if (below === "ground") s = run(s, { t: "build.height", sceneId: GROUND, cells: ["9,6", "9,7", "8,8"], height: 10 });
    reveal(s, UPPER, { x: 0, y: 0, w: 10, h: 10 });
    reveal(s, GROUND, { x: 6, y: 6, w: 2, h: 2 });
    return s;
  }

  for (const below of ["wall", "ground", "hidden"] as const) {
    test(`${below} under fog below or none: the same cast answers and copies`, () => {
      const [a, b] = [room(below), room("none")];
      assert.notDeepEqual(below === "hidden" ? a.tokens : a.buildChunks, below === "hidden" ? b.tokens : b.buildChunks, "the rooms differ, under fog");
      assert.deepEqual([decide(a, cast(["below"])), decide(a, cast(["lurker"]))], ["ok", GONE]);
      checkOps({
        name: `O10 ${below}`,
        a,
        b,
        equal: [ANA, BREE, DISPLAY],
        steps: [
          { who: ANA, op: cast(["below"]), note: "a target below the hole" },
          { who: ANA, op: cast(["lurker"], UPPER, "k2"), note: "a hidden one named by hand" },
          { who: DM, op: { t: "cast.close", castId: "k1", end: "dismissed" } },
          { who: ANA, op: cast(["below", "thorn"], UPPER, "k3"), note: "both floors at once" },
        ],
      }, serverApply);
    });
  }
});
