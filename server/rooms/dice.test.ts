import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FORMULA_ERRORS } from "#shared/dice/formula.ts";
import type { CritRule, LogEntry, LogEvent } from "#shared/model.ts";
import { AT, DM, P1, actor, apply, character, member, room, token } from "#shared/testutil.ts";
import { batchOf, resolveDice } from "./dice.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";

describe("the server's dice (docs/design-v1-dice.md 4.2)", () => {
  test("a batch id is 16 characters of the roller and the tag, the same for every batch of one tag, and says nothing of the tag", () => {
    const id = batchOf("p1", TAG);
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(batchOf("p1", TAG), id);
    assert.notEqual(batchOf("p2", TAG), id, "another member's same tag is another batch");
    assert.notEqual(batchOf("p1", `${TAG}x`), id);
    assert.ok(!TAG.replaceAll("-", "").includes(id.slice(0, 8)));
  });

  test("the resolve draws each die in order, applies each mode and keeps cancelled", () => {
    const faces = [6, 5, 17, 3, 9];
    const resolved = resolveDice(
      {
        t: "dice.roll",
        tag: TAG,
        part: 1,
        to: "all",
        rolls: [
          { formula: "2d6+3", label: "Longsword" },
          { formula: "1d20+4", mode: "adv" },
          { formula: "1d20+1", cancelled: true },
        ],
      },
      room(),
      P1,
      { draw: () => faces.shift()! },
    );
    assert.ok(resolved.ok);
    assert.equal(resolved.op.batch, batchOf("p1", TAG));
    assert.deepEqual(resolved.op.results, [
      { formula: "2d6+3", faces: [6, 5], total: 14 },
      { formula: "2d20kh1+4", faces: [17, 3], total: 21, mode: "adv" },
      { formula: "1d20+1", faces: [9], total: 10, cancelled: true },
    ]);
    assert.equal(resolved.op.asked.t, "dice.roll");
  });

  test("an SRD creature's save rolls with the table loaded at boot (docs/design-v1-roll-options.md 3.4), and with none it has no bonus", () => {
    const state = room({
      tokens: { gob: token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ srdId: "goblin-warrior" }) } }) },
      rolls: {
        r1: {
          id: "r1",
          rev: 0,
          test: { kind: "save", choices: [{ ability: "dex" }] },
          dc: 13,
          dcShown: false,
          resultShown: true,
          at: AT,
          targets: [{ tokenId: "gob" }],
        },
      },
    });
    const op = { t: "roll.dice", tag: TAG, rollId: "r1", target: { tokenId: "gob" } } as const;
    const loaded = resolveDice(op, state, DM, { draw: () => 9 });
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.op.results, [{ formula: "1d20+2", faces: [9], total: 11 }]);
    assert.equal(resolveDice(op, state, DM, { draw: () => 9, srd: null }).ok, false);
  });
});

describe("a critical hit's damage rolls by the room's rule (the critical hit rules addendum)", () => {
  const crit = (rolls: { formula: string; label?: string; critical?: true }[]) => ({ t: "dice.roll", tag: TAG, to: "all", rolls }) as const;
  const withRule = (critRule?: CritRule) => {
    const state = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") } });
    if (critRule === undefined) delete state.meta.settings.critRule;
    else state.meta.settings.critRule = critRule;
    return state;
  };

  test("each rule from the room's settings, an absent one rolling twice, and a plain roll beside it untouched", () => {
    const op = crit([{ formula: "2d6+3", label: "Scimitar critical damage, slashing", critical: true }, { formula: "2d6+3" }]);
    const results = (critRule: CritRule | undefined, faces: number[]) => {
      const resolved = resolveDice(op, withRule(critRule), P1, { draw: () => faces.shift()! });
      assert.ok(resolved.ok, resolved.ok ? "" : resolved.message);
      return resolved.op.results;
    };
    assert.deepEqual(results(undefined, [1, 2, 5, 6, 3, 3]), [
      { formula: "4d6+3", faces: [1, 2, 5, 6], total: 17, crit: "rollTwice" },
      { formula: "2d6+3", faces: [3, 3], total: 9 },
    ]);
    assert.deepEqual(results("maxPlusRoll", [4, 6, 3, 3])[0], { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll" });
    assert.deepEqual(results("doubleDice", [4, 6, 3, 3])[0], { formula: "2d6+3", faces: [4, 6], total: 23, crit: "doubleDice" });
    assert.deepEqual(results("doubleTotal", [4, 6, 3, 3])[0], { formula: "2d6+3", faces: [4, 6], total: 26, crit: "doubleTotal" });
  });

  test("the line keeps the rule it was rolled under after the DM picks another, and replays to the same line", () => {
    const state = withRule("maxPlusRoll");
    const resolved = resolveDice(crit([{ formula: "1d6+2", label: "Scimitar critical damage, slashing", critical: true }]), state, P1, { draw: () => 4 });
    assert.ok(resolved.ok);
    const rolled = apply(state, resolved.op, P1, 1);
    const changed = apply(rolled, { t: "room.update", settings: { critRule: "doubleTotal" } }, DM, 2);
    const line = changed.log.flatMap((e) => (e.data?.type === "dice" ? [e.data] : []))[0];
    assert.deepEqual(line?.rolls, [{ formula: "1d6+2", faces: [4], total: 12, crit: "maxPlusRoll", label: "Scimitar critical damage, slashing" }]);
    const again = apply(withRule("doubleTotal"), resolved.op, P1, 1);
    assert.deepEqual(again.log.at(-1)?.data, rolled.log.at(-1)?.data, "a stored sys.dice replays the same under any later setting");
  });

  test("a crit past the op's 100 dice under the most drawing rule is refused before any draw", () => {
    const resolved = resolveDice(crit([{ formula: "51d6", critical: true }]), withRule("maxPlusRoll"), P1, {
      draw: () => assert.fail("no die is drawn"),
    });
    assert.deepEqual(resolved, { ok: false, code: "invalid", message: FORMULA_ERRORS.dice });
  });
});

describe("dice lines in a room's export (5.3)", () => {
  function withLines(): ReturnType<typeof room> {
    const state = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, tokens: { g1: token("g1") }, characters: { bree: character("bree") } });
    const line: LogEvent = {
      type: "dice",
      tag: TAG,
      batch: batchOf("p1", TAG),
      by: "p1",
      to: "dm",
      ac: 15,
      rolls: [
        { formula: "2d20kh1+4", faces: [17, 3], total: 21, mode: "adv", label: "Scimitar", tokenId: "g1", seen: true, critOn: 19 },
        { formula: "1d20", faces: [4], total: 4, characterId: "bree", cancelled: true },
        { formula: "1d6+2", faces: [4], total: 12, label: "Scimitar critical damage, slashing", tokenId: "g1", crit: "maxPlusRoll" },
      ],
    };
    const bare: LogEvent = { type: "dice", by: "dm1", to: "dm", rolls: [] };
    const entries: LogEntry[] = [
      { id: "3:0", at: AT, kind: "event", data: line },
      { id: "4:0", at: AT, kind: "event", data: bare },
    ];
    return { ...state, log: entries };
  }

  test("the import schema takes a dice line, its rolls and a bare line", () => {
    const parsed = parseRoomState(JSON.parse(JSON.stringify(withLines())));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const tooLong = withLines();
    (tooLong.log[0]!.data as Extract<LogEvent, { type: "dice" }>).rolls[0]!.label = "x".repeat(61);
    assert.equal(parseRoomState(JSON.parse(JSON.stringify(tooLong))).ok, false);
    const otherRule = JSON.parse(JSON.stringify(withLines()));
    otherRule.log[0].data.rolls[2].crit = "tripleDice";
    assert.equal(parseRoomState(otherRule).ok, false, "a crit's rule is one of the four");
    // An initiative roll the DM kept from players (docs/design-v1-combat-flow.md 11.3).
    const kept = JSON.parse(JSON.stringify(withLines()));
    kept.log[0].data.rolls[0].hidden = true;
    assert.ok(parseRoomState(kept).ok);
    kept.log[0].data.rolls[0].hidden = false;
    assert.equal(parseRoomState(kept).ok, false);
  });

  test("remap moves the roller and every roll's creature to their new ids", () => {
    const out = remapState(withLines(), { assets: new Map() });
    const data = out.log[0]?.data as Extract<LogEvent, { type: "dice" }>;
    const p1 = Object.values(out.members).find((m) => m.name === "p1")!;
    assert.equal(data.by, p1.id);
    assert.equal(data.rolls[0]?.tokenId, Object.keys(out.tokens)[0]);
    assert.equal(data.rolls[1]?.characterId, Object.keys(out.characters)[0]);
    assert.notEqual(data.by, "p1");
    assert.deepEqual(data.rolls[0]?.faces, [17, 3]);
  });
});
