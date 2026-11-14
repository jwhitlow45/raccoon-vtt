import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR_TREATMENT, farRule } from "./farLine.ts";
import { ID_RULES, clientOps, mintedIds, serverOnlyOps, type Op, type OpType } from "./protocol.ts";

function allTypes(): OpType[] {
  const typeOf = (schema: unknown) => (schema as { shape?: { t?: { value?: string } } }).shape?.t?.value;
  const types = [...clientOps, ...serverOnlyOps].map(typeOf).filter((t): t is string => t !== undefined);
  return [...new Set(types)].sort() as OpType[];
}

describe("every op type and the far line", () => {
  test("every op type has a treatment, and every type an id rule", () => {
    const types = allTypes();
    assert.ok(types.length > 150, `${types.length} types`);
    assert.ok(types.includes("undo") && types.includes("redo"));
    assert.deepEqual(types.filter((t) => !Object.hasOwn(FAR_TREATMENT, t)), []);
    assert.deepEqual(types.filter((t) => !Object.hasOwn(ID_RULES, t)), []);
  });

  test("rolls, talk, turns, HP and conditions are bookkeeping, deletions free, and creates and text meet the line", () => {
    const exempt: Op[] = [
      { t: "token.move", tokenId: "t", x: 1, y: 1 },
      { t: "encounter.next" },
      { t: "actor.hp", target: { tokenId: "t" }, change: { kind: "damage", amount: 3 } },
      { t: "actor.damageMany", hits: [{ target: { tokenId: "t" }, amount: 2 }] },
      { t: "actor.life", target: { tokenId: "t" }, life: "alive" },
      { t: "actor.effect.add", target: { tokenId: "t" }, effect: { id: "e", key: "blessed" } },
      { t: "log.chat", text: "hi" },
      { t: "log.whisper", to: ["p1"], text: "hi" },
      { t: "roll.answer", rollId: "r", target: { tokenId: "t" }, total: 12, tag: "x" },
      { t: "token.deleteMany", tokenIds: ["t"] },
      { t: "scene.delete", sceneId: "s1" },
      { t: "music.pause" },
    ];
    for (const op of exempt) assert.equal(farRule(op), "exempt", op.t);
    const meets: Op[] = [
      { t: "token.create", token: { id: "t", sceneId: "s1", kind: "pc", name: "A", size: "medium", x: 1, y: 1, actor: { ref: "c" } } },
      { t: "companionBlock.update", blockId: "b", patch: { name: "Wolf" } },
      { t: "journal.update", pageId: "p", patch: { title: "Notes" } },
    ];
    for (const op of meets) assert.equal(farRule(op), "meets", op.t);
    assert.equal(farRule({ t: "room.setPlayerScene", sceneId: "s1" }), "own");
    assert.equal(farRule({ t: "undo" } as Op), "restore");
  });

  test("an update that carries text meets the line, one of fixed-width fields alone does not", () => {
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { elevation: 5 } }), "exempt");
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { actor: { hp: { cur: 3, max: 9, temp: 0 }, ac: 12 } } as never }), "exempt");
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { actor: { notes: "x" } } as never }), "meets");
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { name: "Orc" } }), "meets");
    assert.equal(farRule({ t: "character.update", characterId: "c", patch: { actor: { ac: 15, wildShape: null } } as never }), "exempt");
    assert.equal(farRule({ t: "character.update", characterId: "c", patch: { actor: { notes: "x" } } as never }), "meets");
    assert.equal(farRule({ t: "character.update", characterId: "c", patch: { actor: { sheetUrl: "https://example.com" } } as never }), "meets");
    assert.equal(farRule({ t: "character.update", characterId: "c", patch: { name: "Thorn" } }), "meets");
    assert.equal(farRule({ t: "template.update", templateId: "a", patch: { origin: { x: 1, y: 1, z: 0 }, size: 30 } }), "exempt");
    assert.equal(farRule({ t: "template.update", templateId: "a", patch: { label: "Fire" } }), "meets");
  });
});

describe("ids a device makes", () => {
  test("a create's key, a row's, a condition's and an ask's are minted, and natural and copied keys are not", () => {
    const id = (n: number) => `0192f0aa-0000-7000-8000-00000000000${n}`;
    const cases: [Op, string[]][] = [
      [{ t: "token.create", token: { id: id(1), sceneId: "s1", kind: "monster", name: "A", size: "medium", x: 1, y: 1, actor: { inline: { effects: [{ id: id(2), key: "prone" }] } } } } as never, [id(1), id(2)]],
      [{ t: "template.create", template: { id: id(1) } } as never, [id(1)]],
      [{ t: "drawing.create", drawing: { id: id(1) } } as never, [id(1)]],
      [{ t: "encounter.add", entries: [{ id: id(1), tokenId: "t" }, { id: id(2), tokenId: "u" }] }, [id(1), id(2)]],
      [{ t: "actor.effect.add", target: { tokenId: "t" }, effect: { id: id(1), key: "prone" } }, [id(1)]],
      [{ t: "actor.effects", add: [{ target: { tokenId: "t" }, effect: { id: id(1), key: "prone" } }] }, [id(1)]],
      [{ t: "actor.effect.update", target: { tokenId: "t" }, effectId: "unconscious@0", patch: { hiddenFromPlayers: true }, as: id(3) }, [id(3)]],
      [{ t: "actor.effect.update", target: { tokenId: "t" }, effectId: "e", patch: { label: "x" } }, []],
      [{ t: "cast.ask", cast: { id: id(1) } } as never, [id(1)]],
      [{ t: "scene.duplicate", sceneId: "s1", newSceneId: id(4), name: "Copy", include: { creatures: true, characters: true, fog: true, drawings: true } }, [id(4)]],
      [{ t: "floorLink.put", link: { id: id(1), pairId: id(2) } } as never, [id(1), id(2)]],
      [{ t: "monster.setSrdImage", srdId: "goblin", image: null }, []],
      [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] }, []],
      [{ t: "fog.live", sceneId: "s1", ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 1, h: 1 } }] }, []],
      [{ t: "pin.put", pin: { id: "p" } } as never, []],
      [{ t: "sys.restore", entries: [], from: "undo" } as never, []],
      [{ t: "undo" } as never, []],
    ];
    for (const [op, ids] of cases) assert.deepEqual(mintedIds(op), ids, op.t);
  });
});
