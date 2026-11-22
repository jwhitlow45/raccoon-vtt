import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR_TREATMENT, farRule, restoresToggles } from "./farLine.ts";
import { ID_RULES, clientOps, mintedIds, serverOnlyOps, type Op, type OpType } from "./protocol.ts";
import { room, template, token } from "./testutil.ts";

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

  test("LP47A-SHOW-1: a hide or a show, of a creature, a group, an area or a name, and a lock, are bookkeeping alone, and anything beside them meets the line", () => {
    for (const visibility of ["all", "dm"] as const) {
      assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { visibility } }), "exempt", `a creature's ${visibility}`);
      assert.equal(farRule({ t: "token.updateMany", tokenIds: ["t", "u"], patch: { visibility } }), "exempt", `a group's ${visibility}`);
      assert.equal(farRule({ t: "template.update", templateId: "a", patch: { visibility } }), "exempt", `an area's ${visibility}`);
    }
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { locked: true } }), "exempt", "a lock");
    assert.equal(farRule({ t: "token.updateMany", tokenIds: ["t"], patch: { visibility: "all", locked: false } }), "exempt", "a show and an unlock");
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { nameHidden: false } }), "exempt", "a name shown (D-261122-042)");
    assert.equal(farRule({ t: "token.updateMany", tokenIds: ["t"], patch: { locked: true } }), "exempt", "a group locked");
    assert.equal(farRule({ t: "token.update", tokenId: "t", patch: { visibility: "all", name: "Orc" } }), "meets", "a show with a name");
    assert.equal(farRule({ t: "token.updateMany", tokenIds: ["t"], patch: { visibility: "all", disposition: "ally" } }), "meets", "a group's show with a side");
    assert.equal(farRule({ t: "template.update", templateId: "a", patch: { visibility: "all", label: "Fire" } }), "meets", "an area's show with a label");
  });

  test("LP47A-SHOW-1: a restore of hides, shows and locks alone is bookkeeping as they were, and one that puts back anything else is not", () => {
    const state = room({ tokens: { g: token("g", { rev: 4 }), h: token("h") }, templates: { a: template("a", { rev: 2 }) } });
    const restore = (entries: { key: string; value: unknown }[]): Op => ({ t: "sys.restore", entries, from: "undo" }) as Op;
    const g = state.tokens.g!;
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, visibility: "dm", rev: 3 } }]), state), true, "a hide's undo");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, visibility: "dm" } }, { key: "token:h", value: { ...state.tokens.h!, locked: true } }]), state), true, "a group's");
    assert.equal(restoresToggles(restore([{ key: "template:a", value: { ...state.templates.a!, visibility: "dm", rev: 1 } }]), state), true, "an area's");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, visibility: "dm", x: 9 } }]), state), false, "a hide and a move");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, nameHidden: true } }]), state), true, "a name hidden");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, publicName: "Hooded figure" } }]), state), false, "a public name");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, notes: "x" } }]), state), false, "a field added");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, visibility: "dm", name: "Orc" } }]), state), false, "a name");
    assert.equal(restoresToggles(restore([{ key: "token:z", value: { ...g, id: "z" } }]), state), false, "a creature brought back");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: null }]), state), false, "a creature taken away");
    assert.equal(restoresToggles(restore([{ key: "token:g", value: { ...g, visibility: "dm" } }, { key: "encounter", value: null }]), state), false, "beside a fight");
    assert.equal(restoresToggles(restore([]), state), false, "nothing");
    assert.equal(restoresToggles({ t: "token.update", tokenId: "g", patch: { visibility: "dm" } }, state), false, "a live op");
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
