import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { RollTarget, RoomState } from "#shared/model.ts";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { actor, character, effect, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { countWords, groupRows, rowResult, type RowState } from "./rows.ts";

/** A group save's rows and their results (docs/design-v1-roll-options.md 5.2 and 5.3). */

let monsters: readonly SrdMonster[] = [];
let rolls: SrdRolls = {};
before(async () => {
  [monsters, rolls] = await Promise.all([loadMonsters(), loadSrdRolls()]);
});

/** Three goblins (one Stunned, one dead), a cart, Bree (p1) by two tokens, and her owl on the players' scene, Vex's on another. */
function state(): RoomState {
  const gob = (id: string, extra: Partial<Parameters<typeof actor>[0]> = {}) => token(id, { kind: "monster", name: "Goblin", number: Number(id.slice(1)), actor: { inline: actor({ srdId: "goblin-warrior", ...extra }) } });
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), vex: character("vex", { name: "Vex", ownerIds: ["p2"] }) },
    tokens: {
      g1: gob("g1"),
      g2: gob("g2", { effects: [effect("s", { key: "stunned" })] }),
      g3: gob("g3", { life: "dead" }),
      cart: token("cart", { kind: "object", name: "Cart" }),
      bree1: token("bree1", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      bree2: token("bree2", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p2"], sceneId: "s2", actor: { inline: actor() } }),
    },
  });
}

const dice = (): DiceView => ({ you: { memberId: "dm1", role: "dm" }, view: state(), srd: { monsters, rolls } });

describe("who rolls how", () => {
  test("each holder once, the living first, objects and the dead at the end set to Skip, each with its ways in order", () => {
    const rows = groupRows(dice(), ["g1", "g2", "g3", "cart", "bree1", "bree2", "owl"], { kind: "save", ability: "dex" }, false);
    assert.deepEqual(
      rows.map((r) => [r.name, r.ways, r.skip]),
      [
        ["Bree", ["ask", "type"], false],
        ["Goblin 1", ["server", "type"], false],
        ["Goblin 2", ["fails", "server", "type"], false],
        ["Owl", ["type"], false],
        ["Cart", ["type"], true],
        ["Goblin 3", ["server", "type"], true],
      ],
    );
    assert.deepEqual(rows[0]!.askRef, { characterId: "bree" }, "a party character is asked as itself");
    assert.equal(rows[1]!.bonus, 2);
    assert.equal(rows[2]!.fails, "stunned");
    assert.match(rows[3]!.why ?? "", /players/, "off the players' scene it cannot be asked");
  });
});

describe("a row's result", () => {
  const row = { fails: undefined };
  const answer = (t: Partial<RollTarget>): RollTarget => ({ characterId: "bree", tag: "t1", ...t });

  test("the DM's mark, then the answer by doc 4's order against the page's DC, then the automatic fail, then the total", () => {
    const save = { kind: "save" as const, ability: "dex" as const };
    assert.equal(rowResult(row, { way: "server", mark: "pass", rolled: { formula: "1d20", faces: [2], total: 2 } }, save, 15), "pass");
    assert.equal(rowResult(row, { way: "ask", asked: { rollId: "r" }, answer: answer({ total: 12 }) }, save, 15), "fail");
    assert.equal(rowResult(row, { way: "ask", asked: { rollId: "r" }, answer: answer({ total: 12, mark: "pass" }) }, save, 15), "pass", "the live card's mark stands through the DC");
    assert.equal(rowResult(row, { way: "ask", asked: { rollId: "r" }, answer: answer({ total: 18, dice: { formula: "1d20+2", faces: [16], total: 18, fails: "stunned" } }) }, save, 15), "fail");
    assert.equal(rowResult(row, { way: "ask", asked: { rollId: "r" } }, save, 15), null, "waiting");
    assert.equal(rowResult({ fails: "stunned" }, { way: "fails" }, save, 15), "fail");
    assert.equal(rowResult(row, { way: "server", rolled: { formula: "1d20+2", faces: [16], total: 18 } }, save, 15), "pass");
    assert.equal(rowResult(row, { way: "type", typed: 9 }, save, 15), "fail");
    assert.equal(rowResult(row, { way: "type", typed: 9 }, save, null), null, "no DC needs a mark");
  });

  test("a changed DC judges totals again and never a mark, and No save fails everyone unmarked", () => {
    const save = { kind: "save" as const, ability: "dex" as const };
    const typed: RowState = { way: "type", typed: 12 };
    assert.equal(rowResult(row, typed, save, 15), "fail");
    assert.equal(rowResult(row, typed, save, 10), "pass");
    const marked: RowState = { way: "type", typed: 12, mark: "fail" };
    assert.equal(rowResult(row, marked, save, 10), "fail");
    assert.equal(rowResult(row, { way: "type" }, { kind: "none" }, null), "fail");
    assert.equal(rowResult(row, { way: "type", mark: "skip" }, { kind: "none" }, null), "skip");
    assert.equal(countWords(["pass", "pass", "fail", null, "skip"]), "2 pass, 1 fail, 1 waiting");
  });
});
