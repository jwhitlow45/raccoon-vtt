import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Drawing, RoomState, WhichPlayers } from "./model.ts";
import { NO_DRAWING, NO_DRAWING_BACK, NO_TYPED_TOTALS, PAGE_FOR_A_PLAYER, canApply, drawsAllowed, playersTypeTotals, type Decision, type PermissionDeps } from "./permissions.ts";
import { clientOpSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, effect, env, imageRef, room, token } from "./testutil.ts";

/**
 * Wave 5's permissions (docs/design-v1-dm-tools.md): the drawing
 * permission on new drawings and on a player's undo and redo, roll
 * answers, group edits by owners, DM-only ops, icons that need no asset
 * check, and restores that would bring back a deleted image.
 */
const deps: PermissionDeps = { canUseAsset: () => true };
const noAssets: PermissionDeps = { canUseAsset: () => false };

/** The decision, with its refusal's code read flat: `ok`, or the code. */
function decide(state: RoomState, op: Op, who = P1, d: PermissionDeps = deps): Decision & { code?: string } {
  return canApply(op, who, state, d);
}

function drawing(id: string, kind: Drawing["kind"], ownerId = "p1"): Omit<Drawing, "rev"> {
  return { id, sceneId: "s1", kind, points: [0, 0, 2, 2], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId, visibility: "all" };
}

function drawRoom(who: WhichPlayers | undefined): RoomState {
  const state = room();
  if (who !== undefined) state.meta.settings = { ...state.meta.settings, playersDraw: who };
  return state;
}

describe("the drawing permission (section 3.9)", () => {
  test("every answer of the setting for each kind of drawing, rulers always allowed", () => {
    const kinds = ["free", "line", "rect", "ellipse", "polygon", "arrow", "text"] as const;
    for (const [who, p1, p2] of [
      [undefined, true, true],
      ["all", true, true],
      ["none", false, false],
      [["p1"], true, false],
    ] as const) {
      const state = drawRoom(who as WhichPlayers | undefined);
      for (const kind of kinds) {
        for (const [viewer, allowed] of [
          [P1, p1],
          [P2, p2],
        ] as const) {
          const d = decide(state, { t: "drawing.create", drawing: drawing(`d-${kind}`, kind, viewer.memberId) }, viewer);
          assert.deepEqual(d, allowed ? { ok: true } : { ok: false, code: "forbidden", message: NO_DRAWING }, `${JSON.stringify(who)} ${kind} ${viewer.memberId}`);
        }
      }
      assert.equal(decide(state, { t: "drawing.create", drawing: drawing("r", "ruler") }).ok, true);
    }
    assert.equal(drawsAllowed({}, "p1"), true);
    assert.equal(drawsAllowed({ playersDraw: "none" }, "p1"), false);
  });

  test("erasing and clearing one's own drawings needs no permission, and an undo that puts one back does", () => {
    let state = drawRoom("all");
    const made = applyOp(state, { t: "drawing.create", drawing: drawing("d1", "free") }, P1, env(1));
    assert.ok(made.ok);
    const erased = applyOp(made.state, { t: "drawing.delete", drawingId: "d1" }, P1, env(2));
    assert.ok(erased.ok && erased.inverse && made.inverse);
    state = { ...erased.state, meta: { ...erased.state.meta, settings: { ...erased.state.meta.settings, playersDraw: "none" } } };
    assert.equal(decide(made.state, { t: "drawing.delete", drawingId: "d1" }).ok, true);
    assert.equal(decide(state, { t: "drawing.clear", sceneId: "s1", scope: "own" }).ok, true);
    // Undoing the erase would draw it again.
    assert.deepEqual(decide(state, { t: "sys.restore", entries: erased.inverse, from: "undo", deps: true }), { ok: false, code: "forbidden", message: NO_DRAWING_BACK });
    // Undoing the drawing itself only takes it away.
    const withDrawing = { ...made.state, meta: state.meta };
    assert.equal(decide(withDrawing, { t: "sys.restore", entries: made.inverse, from: "undo", deps: true }).ok, true);
    // A kept ruler stays allowed both ways.
    const ruler = applyOp(drawRoom("all"), { t: "drawing.create", drawing: drawing("r1", "ruler") }, P1, env(1));
    assert.ok(ruler.ok);
    const unkept = applyOp(ruler.state, { t: "drawing.delete", drawingId: "r1" }, P1, env(2));
    assert.ok(unkept.ok && unkept.inverse);
    assert.equal(decide({ ...unkept.state, meta: state.meta }, { t: "sys.restore", entries: unkept.inverse, from: "undo", deps: true }).ok, true);
  });
});

describe("roll answers (section 3.3)", () => {
  function asked(): RoomState {
    const state = room();
    state.characters.thorn = character("thorn", { ownerIds: ["p1"] });
    state.characters.vex = character("vex", { ownerIds: ["p2"] });
    state.rolls.r1 = { id: "r1", rev: 1, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: false, resultShown: true, at: "x", targets: [{ characterId: "thorn" }] };
    state.rolls.r2 = { id: "r2", rev: 1, test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, dcShown: true, resultShown: true, at: "x", targets: [{ characterId: "thorn" }, { characterId: "vex" }] };
    return state;
  }

  test("a player answers only for a creature they own in a request that names it, and anything else is gone", () => {
    const state = asked();
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, total: 12, tag: "a1" }).ok, true);
    for (const [op, who] of [
      [{ t: "roll.answer", rollId: "r9", target: { characterId: "thorn" }, total: 12, tag: "a1" }, P1],
      [{ t: "roll.answer", rollId: "r1", target: { characterId: "vex" }, total: 12, tag: "a1" }, P1],
      [{ t: "roll.answer", rollId: "r1", target: { characterId: "vex" }, total: 12, tag: "a1" }, P2],
      [{ t: "roll.answer", rollId: "r2", target: { characterId: "vex" }, total: 12, tag: "a1" }, P1],
    ] as const) {
      assert.deepEqual(decide(state, op as Op, who), { ok: false, code: "gone", message: "that is not here" });
    }
  });

  test("a player fails only a save without rolling, and never marks a pass", () => {
    const state = asked();
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, result: "fail", tag: "a1" }).ok, true);
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, result: "pass", tag: "a1" }).code, "forbidden");
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, total: 9, result: "fail", tag: "a1" }).code, "forbidden");
    assert.equal(decide(state, { t: "roll.answer", rollId: "r2", target: { characterId: "thorn" }, result: "fail", tag: "a1" }).code, "forbidden");
    assert.equal(decide(state, { t: "roll.answer", rollId: "r2", target: { characterId: "vex" }, result: "pass", tag: "a1" }, DM).ok, true);
  });

  test("with typed totals off a player's typed answer and Fix my total are refused, while rolls, a fail without rolling and the DM's totals go (owner's setting)", () => {
    const state = asked();
    assert.equal(playersTypeTotals(state.meta.settings), true, "on in a new room");
    assert.equal(playersTypeTotals({}), true, "a room from before it reads as on");
    state.meta.settings.playersTypeTotals = false;
    assert.deepEqual(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, total: 12, tag: "a1" }), { ok: false, code: "forbidden", message: NO_TYPED_TOTALS });
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, result: "fail", tag: "a1" }).ok, true, "a fail types no number");
    assert.equal(decide(state, { t: "roll.dice", tag: "d1", rollId: "r1", target: { characterId: "thorn" }, bonus: 3 }).ok, true, "a roll on the server goes, a typed bonus with it");
    assert.equal(decide(state, { t: "roll.answer", rollId: "r1", target: { characterId: "thorn" }, total: 12, tag: "a1" }, DM).ok, true, "the DM's own total is unaffected");
    assert.deepEqual(decide(state, { t: "roll.change", rollId: "r1", target: { characterId: "thorn" }, ask: { id: "c1", on: "a0", reason: "fix-total" } }), { ok: false, code: "forbidden", message: NO_TYPED_TOTALS });
    assert.equal(decide(state, { t: "roll.change", rollId: "r1", target: { characterId: "thorn" }, ask: { id: "c1", on: "a0", reason: "lucky" } }).ok, true, "other asks stay");
    assert.equal(decide(state, { t: "roll.change", rollId: "r9", target: { characterId: "thorn" }, ask: { id: "c1", on: "a0", reason: "fix-total" } }).code, "gone", "a missing request is still gone first");
  });

  test("asking, reopening and closing are the DM's", () => {
    const state = asked();
    for (const op of [
      { t: "roll.ask", request: { id: "r3", test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: "thorn" }] } },
      { t: "roll.reopen", rollId: "r1", target: { characterId: "thorn" } },
      { t: "roll.close", rollIds: ["r1"] },
    ] as Op[]) {
      assert.equal(decide(state, op).code, "forbidden", op.t);
      assert.equal(decide(state, op, DM).ok, true, op.t);
    }
  });
});

describe("a page's private reader (section 3.7)", () => {
  test("is a player, never a DM, who reads every page anyway, on a new page and when its reader changes", () => {
    const state = room({ journal: { pg: { id: "pg", rev: 0, title: "P", access: "all", blocks: [] } } });
    const create = (member: string): Op => ({ t: "journal.create", page: { id: "pg2", title: "Note", access: { member }, blocks: [] } });
    assert.equal(decide(state, create("p1"), DM).ok, true);
    assert.deepEqual(decide(state, create("dm1"), DM), { ok: false, code: "invalid", message: PAGE_FOR_A_PLAYER });
    assert.deepEqual(decide(state, { t: "journal.update", pageId: "pg", patch: { access: { member: "dm1" } } }, DM), { ok: false, code: "invalid", message: PAGE_FOR_A_PLAYER });
    assert.equal(decide(state, { t: "journal.update", pageId: "pg", patch: { access: { member: "p2" } } }, DM).ok, true);
    assert.equal(decide(state, { t: "journal.update", pageId: "pg", patch: { title: "Q" } }, DM).ok, true);
    // A stored op from before the rule replays as it was: replay runs the reducer, never permissions.
    assert.ok(applyOp(state, create("dm1"), DM, env(1)).ok);
  });
});

describe("DM-only wave 5 ops", () => {
  test("journal pages, pins and group deletes are the DM's", () => {
    const state = room({ journal: { pg: { id: "pg", rev: 0, title: "P", access: "all", blocks: [] } }, pins: { a: { id: "a", rev: 0, sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" } }, tokens: { mine: token("mine", { ownerIds: ["p1"] }) } });
    for (const op of [
      { t: "journal.create", page: { id: "pg2", title: "P", access: "all", blocks: [] } },
      { t: "journal.update", pageId: "pg", patch: { title: "Q" } },
      { t: "journal.reveal", pageId: "pg", blockId: "abcdefghijkl", revealed: true },
      { t: "journal.delete", pageId: "pg" },
      { t: "pin.put", pin: { id: "b", sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" } },
      { t: "pin.remove", pinId: "a" },
      { t: "token.deleteMany", tokenIds: ["mine"] },
    ] as Op[]) {
      assert.equal(decide(state, op).code, "forbidden", op.t);
      assert.equal(decide(state, op, DM).ok, true, op.t);
    }
  });
});

describe("group edits by owners (section 3.5)", () => {
  function owned(): RoomState {
    const state = room();
    state.tokens.a = token("a", { ownerIds: ["p1"] });
    state.tokens.b = token("b", { ownerIds: ["p1"] });
    state.tokens.c = token("c", { ownerIds: ["p2"] });
    state.tokens.hidden = token("hidden", { visibility: "dm" });
    return state;
  }

  test("a player may set the owner fields among a group edit's, on tokens they own", () => {
    const state = owned();
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "b"], patch: { light: { bright: 20, dim: 20 } } }).ok, true);
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "b"], patch: { image: { icon: "lorc/wolf-head", color: "#336699" } } }, P1, noAssets).ok, true);
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "b"], patch: { image: imageRef("someone-elses") } }, P1, noAssets).code, "gone");
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "c"], patch: { light: null } }).code, "forbidden");
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "hidden"], patch: { light: null } }).code, "gone");
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "b"], patch: { visibility: "dm" } }).code, "forbidden");
    assert.equal(decide(state, { t: "token.updateMany", tokenIds: ["a", "c", "hidden"], patch: { visibility: "dm" } }, DM).ok, true);
  });

  test("conditions on several creatures are each checked as their single op, hidden ones answered as gone", () => {
    const state = owned();
    state.tokens.a = token("a", { ownerIds: ["p1"], actor: { inline: actor({ effects: [effect("secret", { key: "poisoned", hiddenFromPlayers: true })] }) } });
    const add = (target: string, key: "frightened" | "exhaustion", level?: number): Op => ({ t: "actor.effects", add: [{ target: { tokenId: target }, effect: { id: `e-${target}`, key, ...(level !== undefined ? { level } : {}) } }] });
    assert.equal(decide(state, { t: "actor.effects", add: [{ target: { tokenId: "a" }, effect: { id: "f1", key: "frightened" } }, { target: { tokenId: "b" }, effect: { id: "f2", key: "frightened" } }] }).ok, true);
    assert.equal(decide(state, add("c", "frightened")).code, "forbidden");
    assert.equal(decide(state, { t: "actor.effects", remove: [{ target: { tokenId: "a" }, effectId: "secret" }] }).code, "gone");
    assert.equal(decide(state, add("a", "exhaustion", 9), DM).code, "invalid");
  });
});

describe("icons and images", () => {
  test("a shipped icon passes without an asset check, a bad key never reaches permissions, and a player's own character may wear one", () => {
    const state = room();
    state.meta.settings = { ...state.meta.settings, playersCreateCharacters: true };
    const icon = { icon: "lorc/wolf-head", color: "#336699" };
    assert.equal(decide(state, { t: "token.create", token: { id: "t1", sceneId: "s1", kind: "monster", name: "Wolf", size: "medium", x: 1, y: 1, image: icon, actor: { inline: actor() } } }, DM, noAssets).ok, true);
    assert.equal(decide(state, { t: "character.create", character: { id: "c1", name: "Thorn", size: "medium", ownerIds: ["p1"], defaultImage: icon, actor: actor({ dmNotes: "" }) } }, P1, noAssets).ok, true);
    for (const key of ["../etc/passwd", "lorc", "Lorc/Wolf", "lorc/wolf/head", `${"a".repeat(41)}/x`]) {
      assert.equal(clientOpSchema.safeParse({ t: "monster.setSrdImage", srdId: "wolf", image: { icon: key, color: "#336699" } }).success, false, key);
    }
  });

  test("a player's own character starts with no room monster link, and owners never set one", () => {
    const state = room();
    state.meta.settings = { ...state.meta.settings, playersCreateCharacters: true };
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    const plain = { id: "c2", name: "Vex", size: "medium" as const, ownerIds: ["p1"], actor: actor({ dmNotes: "" }) };
    assert.equal(decide(state, { t: "character.create", character: plain }).ok, true);
    assert.equal(decide(state, { t: "character.create", character: { ...plain, actor: actor({ dmNotes: "", monsterId: "m1" }) } }).code, "forbidden");
    assert.equal(decide(state, { t: "character.update", characterId: "c1", patch: { actor: { monsterId: "m1" } } }).code, "forbidden");
    assert.equal(decide(state, { t: "character.update", characterId: "c1", patch: { actor: { monsterId: "m1" } } }, DM).ok, true);
  });

  test("a DM's restore that would bring back a deleted image is refused, and one the state still names passes", () => {
    const state = room({ tokens: { t1: token("t1", { image: imageRef("face") }) } });
    const deleted = applyOp(state, { t: "token.delete", tokenId: "t1" }, DM, env(1));
    assert.ok(deleted.ok && deleted.inverse);
    const undo: Op = { t: "sys.restore", entries: deleted.inverse, from: "undo", deps: true };
    const gone: PermissionDeps = { canUseAsset: () => true, restoredAssetUsable: (id) => id !== "face" };
    assert.deepEqual(canApply(undo, DM, deleted.state, gone), { ok: false, code: "gone", message: "its image was deleted since" });
    assert.equal(canApply(undo, DM, deleted.state, { canUseAsset: () => true, restoredAssetUsable: () => true }).ok, true);
    // Without the facts, as on the dev fixture's local server, restores are not checked.
    assert.equal(canApply(undo, DM, deleted.state, deps).ok, true);
    // An image the token wears now is in use, so an undo of an edit that kept it is not asked about.
    const renamed = applyOp(state, { t: "token.update", tokenId: "t1", patch: { name: "Snik" } }, DM, env(1));
    assert.ok(renamed.ok && renamed.inverse);
    assert.equal(canApply({ t: "sys.restore", entries: renamed.inverse, from: "undo", deps: true }, DM, renamed.state, gone).ok, true);
  });
});
