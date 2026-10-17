import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOps } from "#shared/protocol.ts";
import { actor, apply, character, companionBlock, room, scene, token } from "#shared/testutil.ts";
import { UndoStacks } from "./undo.ts";
import { addTally, describeOp, describeTally, tallyOf } from "./undoLabels.ts";

function state() {
  return room({
    scenes: { s1: scene("s1", { name: "Goblin cave" }) },
    tokens: { g2: token("g2", { name: "Goblin", number: 2 }), long: token("long", { name: "A".repeat(70) }) },
    characters: { c1: character("c1", { name: "Ayla", actor: actor() }) },
  });
}

describe("undo step labels", () => {
  test("name what the op did, from the state before it, so a deleted thing keeps its name", () => {
    const s = state();
    assert.equal(describeOp({ t: "token.move", tokenId: "g2", x: 1, y: 1 }, s), "moving Goblin 2");
    assert.equal(describeOp({ t: "token.countLeg", tokenId: "g2", counts: false }, s), "not counting the last move of Goblin 2");
    assert.equal(describeOp({ t: "token.countLeg", tokenId: "g2", counts: true }, s), "counting the last move of Goblin 2 again");
    assert.equal(describeOp({ t: "token.delete", tokenId: "g2" }, s), "deleting Goblin 2");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { name: "Snik" } }, s), "renaming Goblin 2 to Snik");
    assert.equal(describeOp({ t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 3 } }, s), "damaging Ayla");
    assert.equal(describeOp({ t: "actor.damageMany", hits: [{ target: { tokenId: "g2" }, amount: 14 }] }, s), "damaging Goblin 2");
    assert.equal(
      describeOp({ t: "actor.damageMany", hits: [{ target: { tokenId: "g2" }, amount: 14 }, { target: { characterId: "c1" }, amount: 7 }, { target: { tokenId: "long" }, amount: 14 }] }, s),
      "damaging 3 creatures",
    );
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { name: "Lair" } }, s), "changing the scene Goblin cave");
    assert.equal(describeOp({ t: "handout.close", handoutId: "gone" }, s), "closing a handout");
    assert.equal(describeOp({ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] }, s), "painting floor");
    assert.equal(describeOp({ t: "drawing.clear", sceneId: "s1", scope: "own" }, s), "clearing your drawings");
    const kept = { id: "r1", sceneId: "s1", kind: "ruler" as const, points: [0, 0, 3, 0], style: { stroke: "#ffffff", width: 3, opacity: 1 }, ownerId: "dm1", visibility: "dm" as const };
    assert.equal(describeOp({ t: "drawing.create", drawing: kept }, s), "keeping a ruler");
    assert.equal(describeOp({ t: "drawing.delete", drawingId: "r1" }, { ...s, drawings: { r1: { ...kept, rev: 0 } } }), "removing a kept ruler");
    assert.equal(describeOp({ t: "drawing.delete", drawingId: "r1" }, s), "erasing a drawing");
    const image = { assetId: "a", crop: { cx: 0, cy: 0, zoom: 1 } };
    assert.equal(describeOp({ t: "monster.setSrdImage", srdId: "goblin-warrior", image }, s), "setting the image of Goblin Warrior");
    assert.equal(describeOp({ t: "monster.setSrdImage", srdId: "adult-red-dragon", image: null }, s), "removing the image of Adult Red Dragon");
    const saved = { ...s, savedEncounters: { e1: { id: "e1", rev: 0, name: "Crypt guards", monsters: [] } } };
    assert.equal(describeOp({ t: "savedEncounter.create", encounter: { id: "e2", name: "Wolves", monsters: [] } }, s), "saving the encounter Wolves");
    assert.equal(describeOp({ t: "savedEncounter.update", encounterId: "e1", patch: { name: "Crypt" } }, saved), "changing the encounter Crypt guards");
    assert.equal(describeOp({ t: "savedEncounter.delete", encounterId: "e1" }, saved), "deleting the encounter Crypt guards");
    assert.equal(describeOp({ t: "savedEncounter.delete", encounterId: "gone" }, s), "deleting an encounter");
  });

  test("a document of handout pages is saved and deleted by its title, and a show of one says showing (docs/design-v1-pdf-handouts.md 3.3)", () => {
    const s = state();
    const pages = [{ assetId: "a", width: 1584, height: 2048 }];
    const saved = { ...s, handoutDocs: { d1: { id: "d1", rev: 0, title: "Strange letter", pages, createdAt: "" } } };
    assert.equal(describeOp({ t: "handoutDoc.create", doc: { id: "d2", title: "Strange letter", pages } }, s), "saving the handout Strange letter");
    assert.equal(describeOp({ t: "handoutDoc.delete", docId: "d1" }, saved), "deleting the handout Strange letter");
    assert.equal(describeOp({ t: "handoutDoc.delete", docId: "gone" }, s), "deleting a handout");
    assert.equal(describeOp({ t: "handout.show", handout: { id: "h1", pages, title: "Strange letter", to: "all" } }, s), "showing the handout Strange letter");
  });

  test("a companion block is added, changed and deleted by its name, and goes on the DM's stack alone (docs/design-v1-companion-stat-blocks.md 3.3)", () => {
    const s = { ...state(), companionBlocks: { b1: companionBlock("b1", "c1", { name: "Owl" }) } };
    const { rev: _rev, ...block } = companionBlock("b2", "c1", { name: "Owl" });
    assert.equal(describeOp({ t: "companionBlock.create", block }, s), "adding the stat block Owl");
    assert.equal(describeOp({ t: "companionBlock.update", blockId: "b1", patch: { ac: 13 } }, s), "changing the stat block Owl");
    assert.equal(describeOp({ t: "companionBlock.delete", blockId: "b1" }, s), "deleting the stat block Owl");
    assert.equal(describeOp({ t: "companionBlock.delete", blockId: "gone" }, s), "deleting a stat block");
    for (const op of [{ t: "companionBlock.create", block } as const, { t: "companionBlock.delete", blockId: "b1" } as const]) {
      assert.equal(UndoStacks.records("dm", op), true, op.t);
      assert.equal(UndoStacks.records("player", op), false, op.t);
    }
  });

  test("cut long names, so the toast stays short", () => {
    const label = describeOp({ t: "token.move", tokenId: "long", x: 1, y: 1 }, state());
    assert.ok(label.length < 60, label);
    assert.ok(label.endsWith("…"));
  });

  test("every client op has one, short enough for the ev's 200 characters", () => {
    const s = state();
    for (const schema of clientOps) {
      const t = schema.shape.t.value;
      // The smallest op of each type the label can read: fields it does not use stay unset.
      const label = describeOp({ t, sceneId: "s1", tokenId: "g2", target: { tokenId: "g2" }, moves: [], hits: [], patch: {}, change: { kind: "heal", amount: 1 }, effect: { key: "prone" }, token: { name: "x" }, scene: { name: "x" }, character: { name: "x" }, monster: { name: "x" }, block: { name: "x" }, encounter: { name: "x" }, srdId: "goblin-warrior", image: null, template: {}, drawing: {}, handout: { title: "x" }, doc: { title: "x" }, label: null, door: { edge: "0,0,n" }, tokenIds: ["g2"], rollIds: ["r1"], page: { title: "x" }, pin: { id: "p1" }, request: { test: { kind: "save", choices: [{ ability: "dex" }] } } } as never, s);
      assert.ok(label.length > 0 && label.length <= 200, `${t}: ${label}`);
    }
  });

  test("wave 3's map ops say what they did", () => {
    const s = state();
    s.scenes.s1!.phases = [{ id: "p2", name: "On fire", assetId: "a", widthPx: 1, heightPx: 1 }];
    s.stamps.st = { id: "st", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    const put = (id: string) => ({ id, art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const });
    assert.equal(describeOp({ t: "scene.duplicate", sceneId: "s1", newSceneId: "s2", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } }, s), "duplicating the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.setPhase", sceneId: "s1", phaseId: "p2" }, s), "switching the scene Goblin cave to the phase On fire");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { folder: "Act 1" } }, s), "moving the scene Goblin cave to the folder Act 1");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { folder: null } }, s), "taking the scene Goblin cave out of its folder");
    assert.equal(describeOp({ t: "build.stamps", sceneId: "s1", put: [put("new")] }, s), "placing a stamp");
    assert.equal(describeOp({ t: "build.stamps", sceneId: "s1", put: [put("st")] }, s), "changing a stamp");
    assert.equal(describeOp({ t: "build.stamps", sceneId: "s1", remove: ["st"] }, s), "deleting a stamp");
    assert.equal(describeOp({ t: "build.walls", sceneId: "s1", remove: [{ cx: 0, cy: 0, id: "abcdefabcdef" }] }, s), "changing walls and doors");
  });

  test("the scene setting that stops players' moves says which way it went", () => {
    const s = state();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { blockMovement: true } }, s), "making walls and ledges block players' moves on the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { blockMovement: false } }, s), "letting players' moves pass walls and ledges on the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { blockMovement: true, name: "Lair" } }, s), "changing the scene Goblin cave");
  });

  test("a resize names the new size (docs/design-v1-token-window.md 8.7)", () => {
    const s = state();
    s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"] });
    assert.equal(describeOp({ t: "token.update", tokenId: "thorn", patch: { size: "large" } }, s), "resizing Thorn to Large");
    assert.equal(describeOp({ t: "token.update", tokenId: "thorn", patch: { size: "huge", x: 2, y: 2 } }, s, { memberId: "p1", role: "player" }), "resizing Thorn to Huge");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { size: "custom", w: 2, h: 3 } }, s), "resizing Goblin 2 to 2 by 3 squares");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { size: "large", locked: true } }, s), "changing Goblin 2", "a patch with more than a resize is a change");
  });

  test("vision settings, a token's light and a teleport say what they did", () => {
    const s = state();
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "bright" } } }, s), "turning on party vision on the scene Goblin cave");
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright" } };
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright" } } }, s), "turning off party vision on the scene Goblin cave");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" } } }, s), "making the scene Goblin cave dark");
    assert.equal(describeOp({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" }, name: "Lair" } }, s), "changing the scene Goblin cave");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { light: { bright: 20, dim: 20 } } }, s), "giving Goblin 2 a light");
    s.tokens.g2 = { ...s.tokens.g2!, light: { bright: 20, dim: 20 } };
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { light: { bright: 15, dim: 30 } } }, s), "changing the light of Goblin 2");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { light: null } }, s), "putting out the light of Goblin 2");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { partyVision: true } }, s), "letting Goblin 2 share its sight with the party");
    assert.equal(describeOp({ t: "token.update", tokenId: "g2", patch: { partyVision: false } }, s), "stopping Goblin 2 sharing its sight with the party");
    assert.equal(describeOp({ t: "token.move", tokenId: "g2", x: 4, y: 1, teleport: "wall" }, s), "teleporting Goblin 2");
  });

  test("a door edit names what it did to the door as it was: open, close, lock, unlock, mark found and hide", () => {
    const s = state();
    const door = (doorState: "open" | "closed" | "locked") => ({ kind: "door" as const, state: doorState, secret: true, discovered: false });
    s.buildChunks["s1:0,0"] = {
      sceneId: "s1",
      cx: 0,
      cy: 0,
      rev: 0,
      cells: {},
      edges: { "1,1,n": door("open"), "2,1,n": door("closed"), "3,1,n": door("locked") },
      walls: [{ id: "freedoorfree", a: [5, 5], b: [6, 5], f: door("locked") }],
    };
    const set = (edge: string, to: "open" | "closed" | "locked", found?: boolean) =>
      describeOp({ t: "door.set", sceneId: "s1", door: { edge }, state: to, ...(found === undefined ? {} : { found }) }, s);
    assert.equal(set("2,1,n", "open"), "opening a door");
    assert.equal(set("3,1,n", "open"), "opening a door");
    assert.equal(set("1,1,n", "closed"), "closing a door");
    assert.equal(set("3,1,n", "closed"), "unlocking a door");
    assert.equal(set("2,1,n", "locked"), "locking a door");
    assert.equal(set("1,1,n", "locked"), "locking a door");
    assert.equal(set("2,1,n", "closed", true), "marking a secret door found");
    assert.equal(set("3,1,n", "locked", false), "hiding a secret door");
    assert.equal(describeOp({ t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: "freedoorfree" }, state: "closed" }, s), "unlocking a door");
    // A door no longer there reads by what the op asked.
    assert.equal(set("9,9,n", "closed"), "closing a door");
  });
});

describe("an erase's undo label", () => {
  /** A scene with an imported map's things on it, laid out one per cell, and a room built on the floor at (8, 8). */
  function built() {
    let s = room({ scenes: { s1: scene("s1", { name: "Crypt", bounds: { w: 16, h: 16 } }) } });
    s = apply(s, { t: "build.walls", sceneId: "s1", put: [{ id: "wallAAAAAAAA", a: [1, 1.25], b: [1.75, 1.5], f: { kind: "wall" } }] });
    s = apply(s, { t: "build.lights", sceneId: "s1", put: [{ id: "light1", x: 3.5, y: 1.5, bright: 20, dim: 20, on: true, walls: true }] });
    const stamp = (id: string, x: number) => ({ id, art: { key: "barrel" }, x, y: 1.5, w: 0.5, h: 0.5, rotation: 0, z: 0, visibility: "all" as const });
    s = apply(s, { t: "build.stamps", sceneId: "s1", put: [stamp("stamp1", 5.5), stamp("stamp2", 6.5)] });
    s = apply(s, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["8,8"] });
    s = apply(s, { t: "build.edge", sceneId: "s1", edges: [{ key: "8,8,n", feature: { kind: "door", state: "closed", secret: false, discovered: false } }] });
    return s;
  }

  function label(cells: string[]): string {
    const before = built();
    const op = { t: "build.erase" as const, sceneId: "s1", cells };
    return describeOp(op, before, undefined, apply(before, op));
  }

  test("names the one kind of thing it took, since an imported map has no floor to erase", () => {
    assert.equal(label(["1,1"]), "erasing walls and doors");
    assert.equal(label(["3,1"]), "erasing a light");
    assert.equal(label(["5,1"]), "erasing a stamp");
    assert.equal(label(["5,1", "6,1"]), "erasing stamps");
  });

  test("says erasing floor when floor went, with whatever stood on it", () => {
    assert.equal(label(["8,8"]), "erasing floor");
    assert.equal(label(["8,8", "3,1"]), "erasing floor");
  });

  test("is neutral when it took several kinds of thing but no floor, or nothing", () => {
    assert.equal(label(["3,1", "5,1"]), "erasing");
    assert.equal(label(["12,12"]), "erasing");
  });

  test("names a brush stroke sent as several erases for what all of them took", () => {
    /** The stroke's erases in order, each pushed as the actor pushes it, in one undo group. */
    const stroke = (...parts: string[][]) => {
      const stacks = new UndoStacks();
      let state = built();
      for (const [i, cells] of parts.entries()) {
        const op = { t: "build.erase" as const, sceneId: "s1", cells };
        const after = apply(state, op);
        stacks.push("dm1", [{ key: `stroke:${i}`, value: null, expectRev: i }], describeOp(op, state, undefined, after), "stroke", undefined, undefined, tallyOf(op, state, after));
        state = after;
      }
      return stacks.popUndo("dm1")?.label;
    };
    assert.equal(stroke(["5,1"]), "erasing a stamp");
    assert.equal(stroke(["5,1"], ["6,1"]), "erasing stamps");
    assert.equal(stroke(["5,1"], ["8,8"]), "erasing floor");
    assert.equal(stroke(["5,1"], ["3,1"]), "erasing");
    assert.equal(stroke(["12,12"], ["1,1"]), "erasing walls and doors");
  });
});

describe("wave 5 undo labels (docs/design-v1-dm-tools.md 2.2)", () => {
  function wave5() {
    const s = state();
    s.journal.pg1 = { id: "pg1", rev: 0, title: "Old map", access: "all", blocks: [] };
    s.pins.p1 = { id: "p1", rev: 0, sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" };
    s.rolls.r1 = { id: "r1", rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: "x", targets: [{ characterId: "c1" }] };
    s.tokens.g3 = token("g3", { name: "Goblin", number: 3, actor: { inline: actor({ effects: [{ id: "e1", key: "frightened" }] }) } });
    return s;
  }

  test("each op says what it did", () => {
    const s = wave5();
    assert.equal(describeOp({ t: "journal.create", page: { id: "pg2", title: "Lore", access: "dm", blocks: [] } }, s), "adding the page Lore");
    assert.equal(describeOp({ t: "journal.update", pageId: "pg1", patch: { title: "Older" } }, s), "changing the page Old map");
    assert.equal(describeOp({ t: "journal.reveal", pageId: "pg1", blockId: "abcdefghijkl", revealed: true }, s), "revealing a secret on the page Old map");
    assert.equal(describeOp({ t: "journal.reveal", pageId: "pg1", blockId: "abcdefghijkl", revealed: false }, s), "hiding a secret on the page Old map");
    assert.equal(describeOp({ t: "journal.delete", pageId: "pg1" }, s), "deleting the page Old map");
    assert.equal(describeOp({ t: "pin.put", pin: { id: "p1", sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" } }, s), "changing a pin");
    assert.equal(describeOp({ t: "pin.put", pin: { id: "p2", sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" } }, s), "placing a pin");
    assert.equal(describeOp({ t: "pin.remove", pinId: "p1" }, s), "deleting a pin");
    const ask = { id: "r2", test: { kind: "check" as const, choices: [{ ability: "str" as const, skill: "athletics" as const }, { ability: "dex" as const, skill: "acrobatics" as const }] }, dcShown: true, resultShown: true, targets: [{ characterId: "c1" }] };
    assert.equal(describeOp({ t: "roll.ask", request: ask }, s), "asking for a Strength (Athletics) or Dexterity (Acrobatics) check");
    assert.equal(describeOp({ t: "roll.answer", rollId: "r1", target: { characterId: "c1" }, result: "pass" }, s), "marking the roll of Ayla");
    assert.equal(describeOp({ t: "roll.answer", rollId: "r1", target: { characterId: "c1" }, total: 9 }, s), "entering the roll of Ayla");
    assert.equal(describeOp({ t: "roll.reopen", rollId: "r1", target: { characterId: "c1" } }, s), "reopening the roll of Ayla");
    assert.equal(describeOp({ t: "roll.reopen", rollId: "r1", target: { characterId: "c1" }, change: "a1" }, s), "letting Ayla fix the total");
    assert.equal(describeOp({ t: "roll.close", rollIds: ["r1"] }, s), "closing the request for a Dexterity saving throw");
    assert.equal(describeOp({ t: "roll.close", rollIds: ["r1", "r9"] }, s), "closing 2 roll requests");
  });

  test("group edits name the group: changing or deleting 6 tokens, adding Frightened to 4 creatures", () => {
    const s = wave5();
    assert.equal(describeOp({ t: "token.updateMany", tokenIds: ["g2", "g3"], patch: { locked: true } }, s), "changing 2 tokens");
    assert.equal(describeOp({ t: "token.updateMany", tokenIds: ["g2"], patch: { locked: true } }, s), "changing Goblin 2");
    assert.equal(describeOp({ t: "token.deleteMany", tokenIds: ["g2", "g3", "long"] }, s), "deleting 3 tokens");
    const add = (ids: string[]) => ids.map((tokenId, i) => ({ target: { tokenId }, effect: { id: `e${i}`, key: "frightened" as const } }));
    assert.equal(describeOp({ t: "actor.effects", add: add(["g2", "g3", "long"]).concat([{ target: { tokenId: "x" }, effect: { id: "e9", key: "frightened" } }]) }, s), "adding Frightened to 4 creatures");
    assert.equal(describeOp({ t: "actor.effects", add: add(["g2"]) }, s), "adding Frightened to Goblin 2");
    assert.equal(describeOp({ t: "actor.effects", remove: [{ target: { tokenId: "g3" }, effectId: "e1" }] }, s), "removing Frightened from Goblin 3");
    assert.equal(describeOp({ t: "actor.effects", add: add(["g2"]), remove: [{ target: { tokenId: "g3" }, effectId: "e1" }] }, s), "changing effects on 2 creatures");
    // A selection over 100 goes as several group ops under one undo group, named for all of it.
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const step = addTally(tallyOf({ t: "token.updateMany", tokenIds: many, patch: { locked: true } }), tallyOf({ t: "token.updateMany", tokenIds: ["t100", "t101"], patch: { locked: true } }));
    assert.equal(step && describeTally(step), "changing 102 tokens");
    const deleted = addTally(tallyOf({ t: "token.deleteMany", tokenIds: many }), tallyOf({ t: "token.deleteMany", tokenIds: ["t100"] }));
    assert.equal(deleted && describeTally(deleted), "deleting 101 tokens");
  });

  test("a condition put on over 100 creatures is named for all of them, not the first batch (LP5-ROLLS-6)", () => {
    const s = wave5();
    const add = (ids: string[]) => ids.map((tokenId, i) => ({ target: { tokenId }, effect: { id: `p${tokenId}${i}`, key: "prone" as const } }));
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const first = { t: "actor.effects" as const, add: add(many) };
    const rest = { t: "actor.effects" as const, add: add(["t100", "t101", "t102"]) };
    assert.equal(describeOp(first, s), "adding Prone to 100 creatures");
    const step = addTally(tallyOf(first, s), tallyOf(rest, s));
    assert.equal(step && describeTally(step), "adding Prone to 103 creatures");
    const removed = addTally(
      tallyOf({ t: "actor.effects", remove: many.map((tokenId) => ({ target: { tokenId }, effectId: "e1" })) }, s),
      tallyOf({ t: "actor.effects", remove: [{ target: { tokenId: "t100" }, effectId: "e1" }] }, s),
    );
    assert.equal(removed && describeTally(removed), "removing an effect from 101 creatures", "as one op names an effect it cannot find");
    // One creature keeps the op's own phrase, which names it.
    assert.equal(describeTally(tallyOf({ t: "actor.effects", add: add(["g2"]) }, s)!), undefined);
    // A different kind of op in the same step ends the count, as for tokens.
    assert.equal(addTally(tallyOf(first, s), tallyOf({ t: "token.updateMany", tokenIds: ["g2"], patch: { locked: true } })), undefined);
  });
});
