import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lineAudience } from "./logRings.ts";
import type { LifeState, RoomState, Token, Viewer } from "./model.ts";
import { hpAccess, projectState } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, env, room, token } from "./testutil.ts";

/*
 * A creature's companion link decides a player's HP, life and life line
 * rules only as their copy holds it (docs/design/design-v1-combat-flow.md
 * 3.6.5, 3.6.6): a companion of a character no player plays reaches players
 * as a plain token, so it reads as one in every such rule. A line's readers
 * are fixed by that rule from change format 65 (shared/migrate.ts
 * companionByCopy). Twins: Kel's weapon, an object companion of a character
 * no player plays, against the same object with no link.
 */

type Shape = { max: number; life: LifeState; hpVisibility: Token["hpVisibility"] };

function twin(linked: boolean, shape: Shape): RoomState {
  const state = room({ characters: { kel: character("kel", { name: "Kel", ownerIds: [] }) } });
  state.tokens.sw = token("sw", {
    kind: "object",
    name: "Spiritual Weapon",
    ownerIds: [],
    hpVisibility: shape.hpVisibility,
    ...(linked ? { companion: { of: "kel", turn: "none" as const } } : {}),
    actor: { inline: actor({ hp: { cur: shape.max, max: shape.max, temp: 0 }, life: shape.life, ac: 10 }) },
    x: 4,
    y: 2,
  });
  return state;
}

const SHAPES: Shape[] = [];
for (const max of [0, 12]) for (const life of ["alive", "dead"] as const) for (const hpVisibility of ["label", "hidden", "exact"] as const) SHAPES.push({ max, life, hpVisibility });

const name = (s: Shape) => `HP max ${s.max}, ${s.life}, HP ${s.hpVisibility}`;

let seq = 500;
function play(state: RoomState, op: Op, who: Viewer = DM, opVersion?: number): RoomState {
  const r = applyOp(state, opSchema.parse(op), who, { ...env(seq++), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

const copy = (state: RoomState, viewer: Viewer) => projectState(state, viewer, { sceneId: "s1" });

describe("an unplayed character's object companion reads to players as a plain object (6)", () => {
  for (const shape of SHAPES) {
    test(`${name(shape)}: every player's copy, its HP access, life and lines equal the plain object's`, () => {
      const [a, b] = [twin(true, shape), twin(false, shape)];
      for (const viewer of [P1, P2]) {
        assert.deepEqual(copy(a, viewer), copy(b, viewer), `${viewer.memberId}: the copy`);
        assert.equal(hpAccess(a, viewer, { token: a.tokens.sw! }), hpAccess(b, viewer, { token: b.tokens.sw! }), `${viewer.memberId}: HP access`);
      }
      // The DM deals damage, brings it to 0 and sets its life, each writing a line the twins' players read alike.
      const ops: Op[] = [
        { t: "actor.hp", target: { tokenId: "sw" }, change: { kind: "damage", amount: 3 } },
        { t: "actor.life", target: { tokenId: "sw" }, life: shape.life === "dead" ? "alive" : "dead" },
        { t: "actor.life", target: { tokenId: "sw" }, life: "dying" },
      ];
      let [x, y] = [a, b];
      for (const op of ops) {
        const at = seq;
        x = play(x, op);
        seq = at;
        y = play(y, op);
        for (const viewer of [P1, P2]) assert.deepEqual(copy(x, viewer), copy(y, viewer), `${viewer.memberId} after ${op.t}`);
        assert.deepEqual(
          x.log.map((l) => [l.id, lineAudience(l)]),
          y.log.map((l) => [l.id, lineAudience(l)]),
          `the lines' ids and audiences after ${op.t}`,
        );
      }
    });
  }
});

describe("a line's readers by the copy's link from change format 65 (companionByCopy)", () => {
  const shape: Shape = { max: 12, life: "alive", hpVisibility: "label" };
  const dies: Op = { t: "actor.life", target: { tokenId: "sw" }, life: "dead" };

  test("at 65 the linked weapon's life line is shared, as the plain object's is", () => {
    for (const linked of [true, false]) {
      const after = play(twin(linked, shape), dies, DM, 65);
      const line = after.log.find((l) => l.data?.type === "life");
      assert.ok(line, "a life line");
      assert.equal(lineAudience(line), "shared", linked ? "linked" : "plain");
    }
  });

  test("an op stored at 64 replays to the readers it fixed then: the linked weapon's life line is the DM's", () => {
    const linked = play(twin(true, shape), dies, DM, 64);
    const plain = play(twin(false, shape), dies, DM, 64);
    const audience = (s: RoomState) => s.log.filter((l) => l.data?.type === "life").map((l) => [l.id, lineAudience(l)]);
    assert.deepEqual(audience(linked), [[audience(linked)[0]![0], "dm"]], "the stored link read as stored");
    assert.equal(audience(plain)[0]![1], "shared");
    // The plain object's line, at 64 too, is shared: only the stored link moved the linked one's to the DM.
    assert.notDeepEqual(audience(linked).map((a) => a[1]), audience(plain).map((a) => a[1]));
  });

  test("a companion a player plays keeps its rules: its owner reads its life, others read it alive", () => {
    const state = twin(true, shape);
    state.characters.kel = { ...state.characters.kel!, ownerIds: ["p1"] };
    state.tokens.sw = { ...state.tokens.sw!, ownerIds: ["p1"] };
    const after = play(state, dies, DM, 65);
    const life = (viewer: Viewer) => {
      const sw = copy(after, viewer).tokens.sw;
      return sw && "inline" in sw.actor ? sw.actor.inline.life : undefined;
    };
    assert.equal(life(P1), "dead");
    assert.equal(life(P2), "alive");
    assert.equal(hpAccess(after, P2, { token: after.tokens.sw! }), "none");
  });
});
