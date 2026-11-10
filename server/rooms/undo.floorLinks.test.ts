import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER, putOp, thornToken, tower } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { ClientOp, Op } from "#shared/protocol.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { DM, template, token } from "#shared/testutil.ts";
import { MOVED_SINCE, UndoStacks } from "./undo.ts";
import { describeOp } from "./undoLabels.ts";
import { UndoTable } from "./undoTesting.ts";

/**
 * A climb's undo and redo (docs/design/design-v1-floors.md phase 2, 8,
 * lane FL2-C), through the room actor's own steps (undoTesting.ts): the
 * step keeps the stairs it took, never merges, and its restore carries
 * them, so the climber, what rode with it and their areas cross back and
 * forth between the climb's two floors and nowhere else. Twin rooms that
 * differ only in what Ana may not learn give her the same answers and
 * every player the same copies.
 *
 * The tower (shared/floorLinksTestutil.ts): stairs l1 on Ground floor at
 * 3, 3, 2 by 1, up to l2 on Upper floor. Ana owns Thorn.
 */

const climb = (linkId = "l1", tokenId = "thorn"): Op => ({ t: "token.climb", tokenId, linkId });
const UP = "moving Thorn up the stairs";

/**
 * The tower with its stairs, on Thorn's turn, every op played through the
 * table, so two tables built alike share every seq and differ only where
 * their rooms do.
 */
function table(over: Partial<RoomState> = {}): UndoTable {
  const t = new UndoTable(tower(over));
  for (const op of [{ t: "encounter.start", entries: [{ id: "n1", tokenId: "thorn", value: 20 }] }, { t: "encounter.next" }, putOp()] as Op[]) assert.equal(t.play(DM, op), "ok", op.t);
  return t;
}

/** Where a token stands and the path of its turn there. */
function pose(t: UndoTable, id = "thorn") {
  const token: Token | undefined = t.state.tokens[id];
  return token && { sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation, squeeze: token.squeeze, attached: token.attached, path: token.path };
}

/** Every player's copy, of every floor they hold. */
function copies(t: UndoTable, players: readonly Viewer[] = [ANA, BREE]) {
  return players.map((who) => projectState(t.state, who, { sceneId: null }));
}

describe("a climb's step (8)", () => {
  test("Ana's Undo takes Thorn down the stairs it took and her Redo up again, twice, its path as it was each time", () => {
    const t = table();
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 4, y: 3 }), "ok");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 3, y: 3 }), "ok");
    const below = pose(t);
    assert.equal(t.play(ANA, climb()), "ok");
    const above = pose(t);
    assert.equal(above?.sceneId, UPPER);
    assert.equal(t.stacks.peek("p1", "undo")?.label, UP);
    assert.deepEqual(t.stacks.peek("p1", "undo")?.climb, { tokenId: "thorn", linkId: "l1", rev: 1, made: t.state.floorLinks!.l1!.made, from: GROUND, to: UPPER });
    for (let i = 0; i < 2; i++) {
      assert.equal(t.undo(ANA), "ok", `undo ${i + 1}`);
      assert.deepEqual(pose(t), below, `undo ${i + 1}: on Ground floor where Thorn stood, with the walk's path`);
      assert.equal(t.stacks.peek("p1", "redo")?.label, UP);
      assert.equal(t.redo(ANA), "ok", `redo ${i + 1}`);
      assert.deepEqual(pose(t), above, `redo ${i + 1}: upstairs, Moved as it was`);
    }
    // The steps before it undo in order after it.
    assert.equal(t.undo(ANA), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual(pose(t), { ...below!, x: 4, path: t.state.tokens.thorn!.path });
  });

  test("from Upper floor down: Undo takes Thorn back up, Redo down again, twice", () => {
    const t = table({ tokens: { thorn: thornToken({ sceneId: UPPER }) } });
    const above = pose(t);
    assert.equal(t.play(ANA, climb("l2")), "ok");
    const below = pose(t);
    assert.equal(below?.sceneId, GROUND);
    assert.equal(t.stacks.peek("p1", "undo")?.label, "moving Thorn down the stairs");
    for (let i = 0; i < 2; i++) {
      assert.equal(t.undo(ANA), "ok");
      assert.deepEqual(pose(t), above);
      assert.equal(t.redo(ANA), "ok");
      assert.deepEqual(pose(t), below);
    }
  });

  test("the DM's own climb undoes by the generic restore, and redoes", () => {
    const t = table();
    assert.equal(t.play(DM, climb()), "ok");
    assert.equal(t.undo(DM), "ok");
    assert.equal(t.state.tokens.thorn!.sceneId, GROUND);
    assert.equal(t.redo(DM), "ok");
    assert.equal(t.state.tokens.thorn!.sceneId, UPPER);
  });

  test("two climbs, or a walk and a climb, sent under one gesture are separate steps, either order", () => {
    const t = table();
    assert.equal(t.play(ANA, climb(), "g1"), "ok");
    assert.equal(t.play(ANA, climb("l2"), "g1"), "ok");
    assert.equal(t.stacks.depth("p1").undo, 2, "up then down");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 4, y: 3 }, "g2"), "ok");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 3, y: 3 }, "g2"), "ok");
    assert.equal(t.stacks.depth("p1").undo, 3, "the two walks are one step");
    assert.equal(t.play(ANA, climb(), "g2"), "ok");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 4, y: 3 }, "g2"), "ok");
    assert.equal(t.stacks.depth("p1").undo, 5, "the climb and the walks around it stand apart");
    for (const [i, where] of [UPPER, GROUND, GROUND, UPPER, GROUND].entries()) {
      assert.equal(t.undo(ANA), "ok", `undo ${i + 1}`);
      assert.equal(t.state.tokens.thorn!.sceneId, where, `undo ${i + 1}`);
    }
  });

  test("the stacks never merge a climb's step with another under one gesture, either way", () => {
    const stacks = new UndoStacks();
    const record = { tokenId: "thorn", linkId: "l1", rev: 1, made: 1, from: GROUND, to: UPPER };
    const entry = (n: number) => [{ key: "token:thorn", value: thornToken({ x: n }), expectHash: `h${n}` }];
    stacks.push("p1", entry(1), "moving Thorn", "g", {});
    stacks.push("p1", entry(2), UP, "g", {}, undefined, undefined, false, undefined, undefined, false, { climb: record });
    stacks.push("p1", entry(3), "moving Thorn", "g", {});
    assert.equal(stacks.depth("p1").undo, 3);
    assert.deepEqual(stacks.peek("p1", "undo")?.climb, undefined);
    stacks.popUndo("p1");
    assert.deepEqual(stacks.peek("p1", "undo")?.climb, record);
  });
});

describe("a climb's undo and redo refused (8)", () => {
  test("after the DM locks the stairs, removes them, or moves Thorn: the stairs changed, the stairs changed, moved since", () => {
    for (const [name, op, words] of [
      ["locked", { t: "floorLink.update", linkId: "l1", patch: { locked: true } }, LINK_WORDS.changed("stairs")],
      ["removed", { t: "floorLink.delete", linkId: "l1" }, LINK_WORDS.changed("stairs")],
      ["moved", { t: "token.move", tokenId: "thorn", x: 6, y: 6 }, MOVED_SINCE],
    ] as const) {
      const t = table();
      assert.equal(t.play(ANA, climb()), "ok");
      assert.equal(t.play(DM, op), "ok", name);
      assert.equal(t.undo(ANA), words, name);
      assert.equal(t.state.tokens.thorn!.sceneId, UPPER, `${name}: Thorn stays`);
      assert.equal(t.stacks.depth("p1").undo, 0, `${name}: the step goes, as a refused player's undo's does`);
    }
  });

  test("a redo after the DM locks the stairs, or turns them to a ladder: the stairs changed", () => {
    for (const patch of [{ locked: true }, { kind: "ladder" as const }]) {
      const t = table();
      assert.equal(t.play(ANA, climb()), "ok");
      assert.equal(t.undo(ANA), "ok");
      assert.equal(t.play(DM, { t: "floorLink.update", linkId: "l1", patch }), "ok");
      assert.equal(t.redo(ANA), patch.kind ? LINK_WORDS.changed("ladder") : LINK_WORDS.changed("stairs"));
      assert.equal(t.state.tokens.thorn!.sceneId, GROUND);
    }
  });

  test("under fog the stairs turned to a ladder answer Ana's undo and redo as stairs left alone do, in the same words (FL2-ASTRA-01)", () => {
    const fogged = (t: UndoTable) => {
      t.state = { ...t.state, scenes: { ...t.state.scenes, [GROUND]: { ...t.state.scenes[GROUND]!, fogEnabled: true }, [UPPER]: { ...t.state.scenes[UPPER]!, fogEnabled: true } } };
    };
    for (const from of ["undo", "redo"] as const) {
      const [a, b] = [table(), table()];
      for (const t of [a, b]) {
        assert.equal(t.play(ANA, climb()), "ok");
        if (from === "redo") assert.equal(t.undo(ANA), "ok");
        fogged(t);
      }
      assert.equal(a.play(DM, { t: "floorLink.update", linkId: "l1", patch: { kind: "ladder" } }), "ok");
      assert.deepEqual([a.state.floorLinks!.l1!.kind, a.state.floorLinks!.l2!.kind, b.state.floorLinks!.l1!.kind], ["ladder", "ladder", "stairs"]);
      assert.deepEqual(copies(a), copies(b), `${from}: every player's copy, neither with an end`);
      assert.doesNotMatch(JSON.stringify(copies(a)), /"floorLinks":\{"l/, `${from}: no end reaches a player`);
      const answers = [a, b].map((t) => t.restore(ANA, from));
      assert.deepEqual(answers, [LINK_WORDS.changed("stairs"), LINK_WORDS.changed("stairs")], from);
      assert.deepEqual(copies(a), copies(b), `${from}: after the answer`);
    }
  });

  test("a ladder Ana sees, locked since, is named as a ladder", () => {
    const t = table();
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(t.play(DM, { t: "floorLink.update", linkId: "l1", patch: { kind: "ladder" } }), "ok");
    assert.equal(t.undo(ANA), LINK_WORDS.changed("ladder"));
  });

  test("Ana's own walk after the climb undoes first, then the climb (moved since only for another's move)", () => {
    const t = table();
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 6, y: 3 }), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.equal(t.state.tokens.thorn!.sceneId, GROUND);
  });

  test("stairs removed and placed again with the same ids, over a landing raised meanwhile or not, are other stairs: the stairs changed (ASTRA-14)", () => {
    for (const raise of [true, false]) {
      const t = table();
      assert.equal(t.play(ANA, climb()), "ok");
      assert.equal(t.play(DM, { t: "floorLink.delete", linkId: "l1" }), "ok");
      if (raise) assert.equal(t.play(DM, { t: "build.height", sceneId: GROUND, cells: ["3,3", "4,3"], height: 5 }), "ok");
      assert.equal(t.play(DM, putOp()), "ok");
      const again = t.state.floorLinks!.l2!;
      assert.equal(again.rev, 1, "a new record's rev starts where the old one's did");
      assert.equal(t.undo(ANA), LINK_WORDS.changed("stairs"), raise ? "raised" : "level");
      assert.equal(t.state.tokens.thorn!.sceneId, UPPER);
    }
  });

  test("ground raised beside the stairs leaves the undo landing where Thorn stood, its Moved as it was (D-261109-106)", () => {
    const t = table();
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 3, y: 4 }), "ok");
    assert.equal(t.play(ANA, { t: "token.move", tokenId: "thorn", x: 3, y: 3 }), "ok");
    const below = pose(t);
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(t.play(DM, { t: "build.height", sceneId: GROUND, cells: ["5,3", "3,4"], height: 10 }), "ok");
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual(pose(t), below);
  });
});

describe("what rode with the climber, and areas Ana does not receive (4, 8)", () => {
  const owl = (over: Partial<Token> = {}) => token("owl", { name: "Owl", size: "tiny", kind: "npc", x: 3, y: 3, visibility: "dm", attached: { to: "thorn", kind: "perch" }, ...over });
  const pip = token("pip", { name: "Pip", size: "small", kind: "npc", ownerIds: ["p1"], disposition: "ally", x: 3, y: 3, attached: { to: "thorn", kind: "ride" } });
  const torch = token("torch", { name: "Torch", size: "tiny", kind: "object", x: 3, y: 3, light: { bright: 20, dim: 20 }, attached: { to: "thorn", kind: "carry" } });
  const area = (id: string, on: string) => template(id, { sceneId: GROUND, ownerId: "dm1", visibility: "dm", attachedTo: on, origin: { x: 3.5, y: 3.5, z: 0 } });
  const goblin = token("gob", { name: "Goblin", sceneId: UPPER, x: 12, y: 12, visibility: "dm" });

  /** The same steps in both rooms: every answer and every player's copy agree. */
  function twins(a: UndoTable, b: UndoTable, steps: readonly ((t: UndoTable) => string)[], name: string): void {
    assert.deepEqual(copies(a), copies(b), `${name}: the rooms start equal`);
    for (const [i, step] of steps.entries()) {
      const ra = step(a);
      const rb = step(b);
      assert.equal(ra, rb, `${name}, step ${i + 1}: the answer`);
      assert.equal(ra, "ok", `${name}, step ${i + 1}`);
      assert.deepEqual(copies(a), copies(b), `${name}, step ${i + 1}: every player's copy`);
    }
  }

  const backAndForth = [(t: UndoTable) => t.undo(ANA), (t: UndoTable) => t.redo(ANA), (t: UndoTable) => t.undo(ANA), (t: UndoTable) => t.redo(ANA)];

  test("a visible rider, a hidden perch, the climber's torch and the hidden owl's area all go back and forth, with the answers of a room without the hidden ones", () => {
    const a = table({ tokens: { thorn: thornToken(), pip, torch, owl: owl() }, templates: { aura: area("aura", "owl") } });
    const b = table({ tokens: { thorn: thornToken(), pip, torch } });
    twins(a, b, [(t) => t.play(ANA, climb())], "the climb");
    const floorOf = (t: UndoTable) => ({ thorn: t.state.tokens.thorn!.sceneId, pip: t.state.tokens.pip!.sceneId, torch: t.state.tokens.torch!.sceneId, owl: t.state.tokens.owl?.sceneId, aura: t.state.templates.aura?.sceneId });
    assert.deepEqual(floorOf(a), { thorn: UPPER, pip: UPPER, torch: UPPER, owl: UPPER, aura: UPPER });
    const up = { tokens: Object.fromEntries(["thorn", "pip", "torch", "owl"].map((id) => [id, pose(a, id)])), aura: a.state.templates.aura };
    for (const [i, step] of backAndForth.entries()) {
      twins(a, b, [step], `step ${i + 1}`);
      const where = i % 2 === 0 ? GROUND : UPPER;
      assert.deepEqual(floorOf(a), { thorn: where, pip: where, torch: where, owl: where, aura: where }, `step ${i + 1}: all on one floor`);
      for (const id of ["pip", "torch", "owl"]) assert.deepEqual(a.state.tokens[id]!.attached, { to: "thorn", kind: id === "pip" ? "ride" : id === "owl" ? "perch" : "carry" }, `step ${i + 1}: ${id} still rides`);
    }
    assert.deepEqual({ tokens: Object.fromEntries(["thorn", "pip", "torch", "owl"].map((id) => [id, pose(a, id)])), aura: { ...a.state.templates.aura!, rev: up.aura!.rev } }, up, "back where the climb left them");
  });

  for (const [name, holder, after] of [
    ["a DM-only area on Thorn, deleted after the climb", "thorn", { t: "template.delete", templateId: "ward" }],
    ["a DM-only area on Thorn, moved to a goblin after the climb", "thorn", { t: "template.update", templateId: "ward", patch: { attachedTo: "gob" } }],
    ["a DM-only area on Thorn, kept", "thorn", null],
    ["a DM-only area on the hidden owl, deleted after the climb", "owl", { t: "template.delete", templateId: "ward" }],
    ["a DM-only area on the hidden owl, moved to a goblin after the climb", "owl", { t: "template.update", templateId: "ward", patch: { attachedTo: "gob" } }],
    ["a DM-only area on the hidden owl, kept", "owl", null],
    ["a DM-only area on Thorn, moved to the hidden owl after the climb", "thorn", { t: "template.update", templateId: "ward", patch: { attachedTo: "owl" } }],
  ] as const) {
    test(`${name}: Ana's undo and redo answer as with no area`, () => {
      const a = table({ tokens: { thorn: thornToken(), owl: owl(), gob: goblin }, templates: { ward: area("ward", holder) } });
      const b = table({ tokens: { thorn: thornToken(), owl: owl(), gob: goblin } });
      twins(a, b, [(t) => t.play(ANA, climb())], name);
      if (after) assert.equal(a.play(DM, after as Op), "ok");
      twins(a, b, backAndForth, name);
      // Each step ends upstairs, and an area is always on the floor of what it follows, the goblin's or Thorn's party's.
      const ward = a.state.templates.ward;
      if (after?.t === "template.update") assert.deepEqual([ward?.sceneId, ward?.attachedTo], [UPPER, after.patch.attachedTo], "the area stays with what it follows now");
      if (after === null) assert.equal(ward?.sceneId, UPPER, "the area went back and forth with what it follows");
      if (after?.t === "template.update" && after.patch.attachedTo === "owl") {
        assert.equal(a.undo(ANA), "ok");
        assert.deepEqual([a.state.tokens.owl!.sceneId, a.state.templates.ward!.sceneId], [GROUND, GROUND], "an area moved onto a passenger crosses with it");
      }
    });
  }

  /** An area cast on a creature where it stands now, by the DM or by Ana. */
  const cast = (t: UndoTable, who: Viewer, on: string, visibility: "all" | "dm"): string => {
    const holder = t.state.tokens[on]!;
    return t.play(who, { t: "template.create", template: { id: "late", sceneId: holder.sceneId, shape: "sphere", size: 10, origin: { x: holder.x + 0.5, y: holder.y + 0.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: who.memberId, visibility, attachedTo: on } });
  };

  for (const [on, visibility] of [
    ["thorn", "all"],
    ["thorn", "dm"],
    ["pip", "all"],
    ["pip", "dm"],
    ["owl", "dm"],
  ] as const) {
    for (const from of ["undo", "redo"] as const) {
      test(`an area ${visibility === "dm" ? "only the DM sees" : "everyone sees"}, attached to ${on} after the climb${from === "redo" ? "'s undo" : ""}, crosses with it on Ana's ${from} and back again (FL2-OPUS-1)`, () => {
        const a = table({ tokens: { thorn: thornToken(), pip, owl: owl() } });
        const b = table({ tokens: { thorn: thornToken(), pip, owl: owl() } });
        twins(a, b, [(t) => t.play(ANA, climb()), ...(from === "redo" ? [(t: UndoTable) => t.undo(ANA)] : [])], "before the area");
        const [here, there] = from === "undo" ? [UPPER, GROUND] : [GROUND, UPPER];
        assert.equal(cast(a, DM, on, visibility), "ok");
        assert.equal(a.state.templates.late!.sceneId, here);
        const steps = from === "undo" ? backAndForth : [backAndForth[1]!, backAndForth[0]!, backAndForth[1]!, backAndForth[0]!];
        for (const [i, step] of steps.entries()) {
          // The room without the area answers alike, and where the area is the DM's alone every player's copy is the same too.
          if (visibility === "dm") twins(a, b, [step], `step ${i + 1}`);
          else assert.deepEqual([step(a), step(b)], ["ok", "ok"], `step ${i + 1}`);
          const where = i % 2 === 0 ? there : here;
          const late = a.state.templates.late!;
          assert.deepEqual([a.state.tokens[on]!.sceneId, late.sceneId, late.attachedTo], [where, where, on], `step ${i + 1}: the area is on its creature's floor, still attached`);
        }
      });
    }
  }

  test("Ana's own area on Thorn, cast upstairs, leaves the climb her next undo and goes down with him", () => {
    const t = table();
    assert.equal(t.play(ANA, climb()), "ok");
    assert.equal(cast(t, ANA, "thorn", "all"), "ok");
    assert.equal(t.stacks.peek("p1", "undo")?.label, UP, "a cast takes no undo step of hers");
    assert.equal(t.undo(ANA), "ok");
    assert.deepEqual([t.state.tokens.thorn!.sceneId, t.state.templates.late!.sceneId], [GROUND, GROUND]);
    assert.equal(t.redo(ANA), "ok");
    assert.deepEqual([t.state.tokens.thorn!.sceneId, t.state.templates.late!.sceneId], [UPPER, UPPER]);
  });

  for (const [name, move] of [
    ["Move to floor", { t: "token.update", tokenId: "thorn", patch: { sceneId: UPPER } }],
    ["climb", climb()],
  ] as const) {
    test(`the DM's undo and redo of a ${name} take along an area Ana cast on Thorn since, and one the step itself moved`, () => {
      const t = table({ templates: { ward: area("ward", "thorn") } });
      assert.equal(t.play(DM, move as Op), "ok");
      assert.equal(cast(t, ANA, "thorn", "all"), "ok");
      const floors = () => [t.state.tokens.thorn!.sceneId, t.state.templates.ward!.sceneId, t.state.templates.late!.sceneId];
      assert.deepEqual(floors(), [UPPER, UPPER, UPPER]);
      for (const [i, where] of [GROUND, UPPER, GROUND, UPPER].entries()) {
        assert.equal(i % 2 === 0 ? t.undo(DM) : t.redo(DM), "ok", `step ${i + 1}`);
        assert.deepEqual(floors(), [where, where, where], `step ${i + 1}`);
      }
    });
  }

  test("the hidden owl taken off Thorn by the DM after the climb stays upstairs, with the answers of a room without it", () => {
    const a = table({ tokens: { thorn: thornToken(), owl: owl() }, templates: { aura: area("aura", "owl") } });
    const b = table({ tokens: { thorn: thornToken() } });
    twins(a, b, [(t) => t.play(ANA, climb())], "the climb");
    assert.equal(a.play(DM, { t: "token.detach", tokenId: "owl", x: 3, y: 4 }), "ok");
    twins(a, b, backAndForth, "after the DM took the owl off");
    assert.deepEqual([a.state.tokens.owl!.sceneId, a.state.templates.aura!.sceneId], [UPPER, UPPER]);
  });
});

describe("stairs' undo labels (6.3, 7.2)", () => {
  const s = table().state;
  const label = (op: Op, who: Viewer = DM, state: RoomState = s) => describeOp(op as ClientOp, state, who);

  test("placing, removing, locking, unlocking and changing the kind name the kind and, where it names one, the far floor", () => {
    assert.equal(label(putOp({ id: "l3", pairId: "l4", rect: { x: 8, y: 8, w: 1, h: 1 } })), "placing stairs to Upper floor");
    assert.equal(label(putOp({ id: "l3", pairId: "l4", sceneId: UPPER, to: GROUND, kind: "ladder", rect: { x: 8, y: 8, w: 1, h: 1 } })), "placing a ladder to Ground floor");
    assert.equal(label({ t: "floorLink.delete", linkId: "l1" }), "removing stairs to Upper floor");
    assert.equal(label({ t: "floorLink.delete", linkId: "l2" }), "removing stairs to Ground floor");
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { locked: true } }), "locking the stairs");
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { locked: false } }), "unlocking the stairs");
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { kind: "ladder" } }), "changing stairs to a ladder");
    // A kind sent as it is, beside the lock, changes the lock alone.
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { kind: "stairs", locked: true } }), "locking the stairs");
    const ladder = structuredClone(table().state);
    ladder.floorLinks = Object.fromEntries(Object.entries(ladder.floorLinks!).map(([id, l]) => [id, { ...l, kind: "ladder" as const }]));
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { kind: "stairs" } }, DM, ladder), "changing a ladder to stairs");
    assert.equal(label({ t: "floorLink.update", linkId: "l1", patch: { locked: true } }, DM, ladder), "locking the ladder");
  });

  test("a climb names the creature as its player saw it, the way and the kind, never the far floor", () => {
    assert.equal(label(climb(), ANA), UP);
    assert.equal(label(climb("l2"), ANA), "moving Thorn down the stairs");
    const hidden = table({ tokens: { thorn: thornToken({ sceneId: UPPER }), gob: token("gob", { name: "Goblin", number: 3, sceneId: UPPER, x: 3, y: 3, nameHidden: true, publicName: "Shadow" }) } }).state;
    assert.equal(label(climb("l2", "gob"), ANA, hidden), "moving Shadow down the stairs");
    assert.equal(label(climb("l2", "gob"), DM, hidden), "moving Goblin 3 down the stairs");
  });
});
