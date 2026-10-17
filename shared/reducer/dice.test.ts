import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult, LogEvent, RoomState } from "../model.ts";
import { opSchema, type Op, type OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, apply, character, comparable, env, refused, reveal, room, scene, token } from "../testutil.ts";

const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";
const BATCH = "AbCdEfGhIjKlMnOp";

function asked(overrides: Partial<OpOf<"dice.roll">> = {}): OpOf<"dice.roll"> {
  return { t: "dice.roll", tag: TAG, to: "all", rolls: [{ formula: "2d6+3", label: "Longsword" }], ...overrides };
}

function result(formula: string, faces: number[], total: number, extra: Partial<DiceResult> = {}): DiceResult {
  return { formula, faces, total, ...extra };
}

function sysDice(op: OpOf<"dice.roll">, results: DiceResult[]): Op {
  return { t: "sys.dice", asked: op, batch: BATCH, results };
}

function diceLine(state: RoomState): Extract<LogEvent, { type: "dice" }> {
  const data = state.log.at(-1)?.data;
  assert.equal(data?.type, "dice");
  return data as Extract<LogEvent, { type: "dice" }>;
}

/** A fogged scene whose left half is revealed, with a goblin in sight, one in the dark, and Thorn, p1's, in the dark, which as a party member players see anyway. */
function foggedRoom(): RoomState {
  const state = room({
    scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2", { order: 1 }) },
    tokens: {
      g1: token("g1", { x: 2, y: 2 }),
      g3: token("g3", { x: 30, y: 2 }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 31, y: 3, ownerIds: ["p1"] }),
    },
  });
  reveal(state, "s1", { x: 0, y: 0, w: 20, h: 30 });
  return state;
}

describe("sys.dice (docs/design-v1-dice.md 5.1)", () => {
  test("a free roll writes one dice line with the roller, the tag, the batch and what was drawn", () => {
    const state = apply(room(), sysDice(asked(), [result("2d6+3", [4, 6], 13)]), P1, 7);
    const entry = state.log.at(-1)!;
    assert.equal(entry.id, "7:0");
    assert.equal(entry.kind, "event");
    assert.deepEqual(entry.data, { type: "dice", tag: TAG, batch: BATCH, by: "p1", to: "all", rolls: [{ formula: "2d6+3", faces: [4, 6], total: 13, label: "Longsword" }] });
  });

  test("each roll keeps its creature, its critical range, a mode and cancelled, and a token's roll is marked seen only where non-owners saw it", () => {
    const op = asked({
      to: "dm",
      ac: 15,
      rolls: [
        { formula: "1d20+4", mode: "adv", label: "Scimitar", creature: { tokenId: "g1" }, critOn: 19 },
        { formula: "1d20+4", creature: { tokenId: "g3" }, cancelled: true },
        { formula: "1d20+2", creature: { tokenId: "thorn" } },
      ],
    });
    const state = apply(foggedRoom(), sysDice(op, [result("2d20kh1+4", [19, 3], 23, { mode: "adv" }), result("1d20+4", [8], 12, { cancelled: true }), result("1d20+2", [5], 7)]), DM);
    const line = diceLine(state);
    assert.equal(line.to, "dm");
    assert.equal(line.ac, 15);
    assert.deepEqual(line.rolls, [
      { formula: "2d20kh1+4", faces: [19, 3], total: 23, mode: "adv", label: "Scimitar", tokenId: "g1", seen: true, critOn: 19 },
      { formula: "1d20+4", faces: [8], total: 12, cancelled: true, tokenId: "g3" },
      { formula: "1d20+2", faces: [5], total: 7, tokenId: "thorn", seen: true },
    ]);
  });

  test("a character's roll names the character, and a creature that is gone refuses the op", () => {
    const state = room({ characters: { c1: character("c1", { name: "Bree" }) } });
    const done = apply(state, sysDice(asked({ rolls: [{ formula: "1d20", creature: { characterId: "c1" } }] }), [result("1d20", [11], 11)]), P1);
    assert.equal(diceLine(done).rolls[0]?.characterId, "c1");
    assert.equal(refused(room(), sysDice(asked({ rolls: [{ formula: "1d20", creature: { tokenId: "nobody" } }] }), [result("1d20", [11], 11)])).code, "gone");
  });

  test("one result per roll, or the op is refused", () => {
    assert.equal(refused(room(), sysDice(asked(), [])).code, "invalid");
    assert.equal(refused(room(), sysDice(asked(), [result("2d6+3", [1, 1], 5), result("2d6+3", [1, 1], 5)])).code, "invalid");
  });

  test("a dc and an ac go on the line", () => {
    const state = apply(room(), sysDice(asked({ dc: 15, rolls: [{ formula: "1d20+5", label: "Dexterity save" }] }), [result("1d20+5", [12], 17)]));
    assert.equal(diceLine(state).dc, 15);
  });

  test("the client's dice.roll never reaches the reducer: the server resolves it", () => {
    const answer = refused(room(), asked());
    assert.equal(answer.code, "invalid");
    assert.match(answer.message, /resolved by the server/);
  });

  test("a stored sys.dice replays to the same state, parsed with the protocol schema as replay parses it", () => {
    const ops: Op[] = [
      sysDice(asked(), [result("2d6+3", [4, 6], 13)]),
      sysDice(asked({ to: "dm", rolls: [{ formula: "1d20+4", mode: "dis", creature: { tokenId: "g1" } }] }), [result("2d20kl1+4", [17, 2], 6, { mode: "dis" })]),
    ];
    const run = () => {
      let state = foggedRoom();
      ops.forEach((op, i) => {
        const parsed = opSchema.safeParse(JSON.parse(JSON.stringify(op)));
        assert.ok(parsed.success, parsed.success ? "" : parsed.error.issues[0]?.message);
        const out = applyOp(state, parsed.data, i === 0 ? P1 : DM, env(i + 1));
        assert.ok(out.ok);
        state = out.state;
      });
      return state;
    };
    assert.deepEqual(comparable(run()), comparable(run()));
    assert.equal(run().log.length, 2);
  });

  test("a stored op's formula is never parsed, so a later grammar never stops its replay", () => {
    const old = sysDice(asked({ rolls: [{ formula: "2d6 bonus words" }] }), [result("2d6 bonus words", [1, 2], 3)]);
    assert.equal(opSchema.safeParse(old).success, true);
    const state = apply(room(), old, P1);
    assert.equal(diceLine(state).rolls[0]?.formula, "2d6 bonus words");
  });
});
