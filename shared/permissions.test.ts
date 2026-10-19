import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MoveAnyToken, RoomState } from "./model.ts";
import { canApply, MOVE_PLAYERS_FIRST, movesAnyToken, PLAYED_WITH_OTHERS, WALL_IN_THE_WAY, type AssetKind, type PermissionDeps } from "./permissions.ts";
import { projectState } from "./project.ts";
import { isPoseOp, isResizeOp, onPlayerUndoStack, type Op, type OpOf, type RestoreEntry } from "./protocol.ts";
import { NO_ROOM_TO_GROW, OWNER_SIZES, RESIZE_KEEPS_PLACE, resizeSpot } from "./rules/resize.ts";
import { DM, P1, P2, actor, apply, blockOf, character, customMonster, drawing, entry, imageRef, reveal, room, template, token } from "./testutil.ts";

const deps: PermissionDeps = { canUseAsset: (memberId, assetId) => assetId.startsWith(`${memberId}-`) || assetId === "shared" };

function setup() {
  const state = room();
  state.scenes.s1!.fogEnabled = true;
  // New rooms let players create characters. Most tests here want the setting off.
  state.meta.settings.playersCreateCharacters = false;
  state.characters.c1 = character("c1", { ownerIds: ["p1"] });
  state.tokens.pc1 = token("pc1", { kind: "pc", name: "Ayla", actor: { ref: "c1" }, x: 1, y: 1 });
  state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 1, y: 2 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 2, y: 2 });
  state.tokens.hidden = token("hidden", { name: "Assassin", visibility: "dm", x: 2, y: 3 });
  state.tokens.dark = token("dark", { name: "Lurker", x: 30, y: 30 });
  state.tokens.locked = token("locked", { name: "Statue", locked: true, x: 3, y: 3 });
  state.tokens.other = token("other", { name: "Pet", ownerIds: ["p2"], x: 3, y: 1, sceneId: "s2" });
  state.monsters.mon = customMonster("mon");
  reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
  return state;
}

const code = (op: Op, who = P1, state = setup()) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : d.code;
};

describe("DM", () => {
  test("may do everything a client sends, except editing other members", () => {
    assert.equal(code({ t: "fog.reset", sceneId: "s1", to: "hidden" }, DM), "ok");
    assert.equal(code({ t: "token.move", tokenId: "locked", x: 0, y: 0 }, DM), "ok");
    assert.equal(code({ t: "actor.life", target: { tokenId: "gob" }, life: "dead" }, DM), "ok");
    assert.equal(code({ t: "member.update", memberId: "dm1", name: "G" }, DM), "ok");
    assert.equal(code({ t: "member.update", memberId: "p1", name: "G" }, DM), "forbidden");
    assert.equal(code({ t: "undo" }, DM), "ok");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:gob", value: null, expectRev: 1 }], from: "undo" }, DM), "ok");
  });

  // Deleting the players' scene sent them to the first scene in the list, which can be one the DM is preparing (LP9-PLAY-2).
  test("may delete any scene but the players' one, which needs them moved first", () => {
    const state = setup();
    assert.equal(state.meta.playerSceneId, "s1");
    const decision = canApply({ t: "scene.delete", sceneId: "s1" }, DM, state, deps);
    assert.deepEqual(decision, { ok: false, code: "invalid", message: MOVE_PLAYERS_FIRST });
    assert.equal(code({ t: "scene.delete", sceneId: "s2" }, DM, state), "ok");
    state.meta.playerSceneId = "s2";
    assert.equal(code({ t: "scene.delete", sceneId: "s1" }, DM, state), "ok");
    assert.equal(code({ t: "scene.delete", sceneId: "s2" }, DM, state), "invalid");
  });

  test("roster changes never come from a socket", () => {
    assert.equal(code({ t: "sys.memberJoin", member: { id: "x", name: "X", color: "#000000", kind: "player", createdAt: "" } }, DM), "forbidden");
    assert.equal(code({ t: "sys.memberSetKind", memberId: "p1", kind: "dm" }, DM), "forbidden");
  });

  test("asset references go through the predicate", () => {
    const img = (assetId: string) => ({ assetId, crop: { cx: 0, cy: 0, zoom: 1 } });
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { image: img("dm1-pic") } }, DM), "ok");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { image: img("p1-pic") } }, DM), "gone");
    assert.equal(code({ t: "scene.setMap", sceneId: "s1", map: { assetId: "nope", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } } }, DM), "gone");
    assert.equal(code({ t: "handout.show", handout: { id: "h", assetId: "dm1-h", title: "x", to: "all" } }, DM), "ok");
    assert.equal(code({ t: "handout.show", handout: { id: "h", assetId: "other", title: "x", to: "all" } }, DM), "gone");
    assert.equal(code({ t: "character.create", character: { id: "c9", name: "n", size: "medium", ownerIds: [], defaultImage: img("x"), actor: actor() } }, DM), "gone");
  });
});

describe("custom monsters", () => {
  const create: Op = { t: "monster.create", monster: { id: "mon2", ...blockOf(customMonster("mon2")) } };
  const ops: Op[] = [create, { t: "monster.update", monsterId: "mon", patch: { ac: 20 } }, { t: "monster.delete", monsterId: "mon" }];

  test("the DM creates, edits and deletes them", () => {
    for (const op of ops) assert.equal(code(op, DM), "ok", op.t);
  });

  test("players may not touch them, nor undo their way into them", () => {
    for (const op of ops) for (const who of [P1, P2]) assert.equal(code(op, who), "forbidden", `${op.t} by ${who.memberId}`);
    assert.equal(code({ t: "sys.restore", entries: [{ key: "monster:mon", value: null, expectRev: 0 }], from: "undo" }), "forbidden");
  });
});

describe("monster images", () => {
  const withImage = (assetId: string): Op[] => [
    { t: "monster.create", monster: { id: "mon2", ...blockOf(customMonster("mon2")), defaultImage: imageRef(assetId) } },
    { t: "monster.update", monsterId: "mon", patch: { defaultImage: imageRef(assetId) } },
    { t: "monster.setSrdImage", srdId: "goblin-warrior", image: imageRef(assetId) },
  ];

  test("the DM sets them with an image the DM may use, as for a token", () => {
    for (const op of withImage("dm1-goblin")) assert.equal(code(op, DM), "ok", op.t);
    for (const op of withImage("p1-goblin")) assert.equal(code(op, DM), "gone", op.t);
    assert.equal(code({ t: "monster.update", monsterId: "mon", patch: { defaultImage: null } }, DM), "ok");
    assert.equal(code({ t: "monster.setSrdImage", srdId: "goblin-warrior", image: null }, DM), "ok");
  });

  test("players set none, even with an image of their own, nor undo their way into one", () => {
    for (const op of withImage("p1-goblin")) assert.equal(code(op, P1), "forbidden", op.t);
    assert.equal(code({ t: "monster.setSrdImage", srdId: "goblin-warrior", image: null }, P1), "forbidden");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "srdImage:goblin-warrior", value: null, expectRev: null }], from: "undo" }), "forbidden");
  });
});

describe("saved encounters", () => {
  const ops: Op[] = [
    { t: "savedEncounter.create", encounter: { id: "enc2", name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }] } },
    { t: "savedEncounter.update", encounterId: "enc1", patch: { name: "Renamed" } },
    { t: "savedEncounter.delete", encounterId: "enc1" },
  ];

  test("only the DM builds them, and players cannot undo their way into one", () => {
    for (const op of ops) {
      assert.equal(code(op, DM), "ok", op.t);
      assert.equal(code(op, P1), "forbidden", op.t);
    }
    assert.equal(code({ t: "sys.restore", entries: [{ key: "savedEncounter:enc1", value: null, expectRev: null }], from: "undo" }), "forbidden");
  });
});

describe("player role rules", () => {
  test("DM-only ops are forbidden", () => {
    const ops: Op[] = [
      { t: "room.update", name: "x" },
      { t: "room.setPlayerScene", sceneId: "s2" },
      { t: "view.blackout", blackout: true },
      { t: "scene.create", scene: { id: "n", name: "n", bounds: { w: 1, h: 1 } } },
      { t: "token.create", token: { id: "t", sceneId: "s1", kind: "monster", name: "g", size: "medium", x: 0, y: 0, actor: { inline: actor() } } },
      { t: "token.delete", tokenId: "own" },
      { t: "actor.life", target: { tokenId: "own" }, life: "dead" },
      { t: "character.create", character: { id: "c9", name: "n", size: "medium", ownerIds: ["p1"], actor: actor() } },
      { t: "fog.live", sceneId: "s1", ops: [{ id: "a", mode: "reveal", shape: { kind: "all" } }] },
      { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] },
      { t: "encounter.start", entries: [] },
      { t: "encounter.end" },
      { t: "encounter.setValues", values: [{ entryId: "n1", value: 1 }] },
      { t: "encounter.reorder", entryIds: ["n1"] },
      { t: "encounter.prev" },
      { t: "handout.show", handout: { id: "h", assetId: "p1-x", title: "t", to: "all" } },
      { t: "drawing.clear", sceneId: "s1", scope: "all" },
    ];
    for (const op of ops) assert.equal(code(op), "forbidden", op.t);
  });

  test("members edit only themselves, and anyone chats", () => {
    assert.equal(code({ t: "member.update", memberId: "p1", color: "#00ff00" }), "ok");
    assert.equal(code({ t: "member.update", memberId: "p2", color: "#00ff00" }), "forbidden");
    assert.equal(code({ t: "log.chat", text: "hi" }), "ok");
    assert.equal(code({ t: "log.whisper", to: ["p2"], text: "hi" }), "ok");
    assert.equal(code({ t: "log.whisper", to: ["ghost"], text: "hi" }), "gone");
    assert.equal(code({ t: "undo" }), "ok");
    // Taking an HP change back from the log is the DM's.
    assert.equal(code({ t: "undo", log: "4:0" }), "forbidden");
    assert.equal(code({ t: "undo", log: "4:0" }, DM), "ok");
  });

  test("behind a blackout an op on the table answers as if nothing were there, a fight or the scene alike", () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = true;
    delete state.tokens.pc1;
    const ops: Op[] = [
      { t: "encounter.add", entries: [{ id: "x", label: "probe", hidden: true }] },
      { t: "token.create", token: { id: "t9", sceneId: "s1", kind: "pc", name: "Ayla", size: "medium", x: 4, y: 4, actor: { ref: "c1" } } },
      { t: "token.create", token: { id: "t9", sceneId: "s1", kind: "pc", name: "Ayla", size: "medium", x: 500, y: 4, actor: { ref: "c1" } } },
      { t: "drawing.create", drawing: drawing("d9", { ownerId: "p1" }) },
      { t: "template.create", template: template("a9", { ownerId: "p1" }) },
    ];
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n1", { tokenId: "gob" })] };
    assert.deepEqual(
      ops.map((op) => code(op, P1, state)),
      ["forbidden", "ok", "forbidden", "ok", "ok"],
      "in the light",
    );
    state.meta.view.blackout = true;
    const paused = ops.map((op) => code(op, P1, state));
    assert.deepEqual(paused, ops.map(() => "gone"), "behind the blackout, with a fight");
    state.encounter = null;
    assert.deepEqual(ops.map((op) => code(op, P1, state)), paused, "behind the blackout, without one");
  });
});

describe("movement", () => {
  test("owners move their own, others need the room's leave, and locked never moves", () => {
    assert.equal(code({ t: "token.move", tokenId: "own", x: 0, y: 0 }), "ok");
    assert.equal(code({ t: "token.move", tokenId: "pc1", x: 0, y: 0 }), "ok");
    assert.equal(code({ t: "token.move", tokenId: "gob", x: 0, y: 0 }), "forbidden");
    const open = setup();
    open.meta.settings.playersMoveAny = "all";
    assert.equal(code({ t: "token.move", tokenId: "gob", x: 0, y: 0 }, P1, open), "ok");
    assert.equal(code({ t: "token.move", tokenId: "locked", x: 0, y: 0 }, P1, open), "forbidden");
    assert.equal(code({ t: "token.moveMany", moves: [{ tokenId: "own", x: 0, y: 0 }, { tokenId: "gob", x: 1, y: 1 }] }), "forbidden");
    assert.equal(code({ t: "token.moveMany", moves: [{ tokenId: "own", x: 0, y: 0 }, { tokenId: "gob", x: 1, y: 1 }] }, P1, open), "ok");
  });

  test("no one, everyone, or the players the DM picked move tokens they do not own", () => {
    const moves = (who: MoveAnyToken, viewer: typeof P1, tokenId = "gob") => {
      const state = setup();
      state.meta.settings.playersMoveAny = who;
      return [code({ t: "token.move", tokenId, x: 0, y: 0 }, viewer, state), code({ t: "token.moveMany", moves: [{ tokenId, x: 0, y: 0 }] }, viewer, state)];
    };
    assert.deepEqual(moves("none", P1), ["forbidden", "forbidden"]);
    assert.deepEqual(moves("none", P1, "own"), ["ok", "ok"], "owners always move their own");
    assert.deepEqual(moves("all", P1), ["ok", "ok"]);
    assert.deepEqual(moves("all", P2), ["ok", "ok"]);
    assert.deepEqual(moves(["p1"], P1), ["ok", "ok"]);
    assert.deepEqual(moves(["p1"], P2), ["forbidden", "forbidden"]);
    assert.deepEqual(moves([], P1), ["forbidden", "forbidden"]);
    assert.deepEqual(moves(["p1"], P1, "locked"), ["forbidden", "forbidden"]);
    assert.deepEqual(moves(["p1"], P1, "hidden"), ["gone", "gone"]);
    assert.deepEqual(moves(["p2"], P2, "own"), ["ok", "ok"], "a chosen player moves other players' tokens too");
    assert.equal(code({ t: "token.move", tokenId: "gob", x: 0, y: 0 }, DM), "ok");
    for (const [who, p1, p2] of [["none", false, false], ["all", true, true], [["p1"], true, false], [["p2", "p9"], false, true], [[], false, false]] as const) {
      const settings = { playersMoveAny: (Array.isArray(who) ? [...who] : who) as MoveAnyToken };
      assert.deepEqual([movesAnyToken(settings, "p1"), movesAnyToken(settings, "p2")], [p1, p2], JSON.stringify(who));
    }
    assert.equal(movesAnyToken({}, "p1"), false, "a view without settings moves nothing");
  });

  test("a hidden token, a token under fog or one on another scene is gone, whatever the setting", () => {
    const open = setup();
    open.meta.settings.playersMoveAny = "all";
    assert.equal(code({ t: "token.move", tokenId: "hidden", x: 0, y: 0 }, P1, open), "gone");
    assert.equal(code({ t: "token.move", tokenId: "dark", x: 0, y: 0 }, P1, open), "gone");
    assert.equal(code({ t: "token.move", tokenId: "other", x: 0, y: 0 }, P2, open), "gone");
    assert.equal(code({ t: "token.move", tokenId: "nope", x: 0, y: 0 }, P1, open), "gone");
    open.scenes.s1!.fogEnabled = false;
    assert.equal(code({ t: "token.move", tokenId: "dark", x: 0, y: 0 }, P1, open), "ok");
  });
});

describe("a move that doesn't count", () => {
  test("the DM and the token's owners mark it, a locked token included, and nobody else", () => {
    const state = setup();
    const op = (tokenId: string): Op => ({ t: "token.countLeg", tokenId, counts: false });
    assert.equal(code(op("gob"), DM, state), "ok");
    assert.equal(code(op("own"), P1, state), "ok");
    assert.equal(code(op("pc1"), P1, state), "ok", "through the character");
    state.tokens.own!.locked = true;
    assert.equal(code(op("own"), P1, state), "ok", "it says how the creature moved, which owners may on a locked token");
    state.meta.settings.playersMoveAny = "all";
    assert.equal(code(op("gob"), P1, state), "forbidden", "moving it is not owning it");
    assert.equal(code(op("hidden"), P1, state), "gone");
    assert.equal(code(op("dark"), P1, state), "gone");
  });
});

describe("a player's undo of a move", () => {
  const back = (state: ReturnType<typeof setup>, id: string, patch: object = {}): Op => ({
    t: "sys.restore",
    entries: [{ key: `token:${id}`, value: { ...state.tokens[id]!, x: 0, y: 0, elevation: 10, rotation: 90, rev: 7, ...patch } }],
    from: "undo",
    deps: true,
  });

  test("puts back a token the player may move, and changes nothing else about it", () => {
    const state = setup();
    assert.equal(code(back(state, "own"), P1, state), "ok");
    assert.equal(code(back(state, "pc1"), P1, state), "ok");
    assert.equal(code(back(state, "own", { path: { turn: 3, stops: [{ x: 0, y: 0, elevation: 0 }] } }), P1, state), "ok", "with the path of its turn as it was there");
    assert.equal(code(back(state, "own", { name: "Renamed" }), P1, state), "forbidden");
    assert.equal(code(back(state, "own", { visibility: "dm" }), P1, state), "forbidden");
    assert.equal(code(back(state, "own", { ownerIds: ["p1", "p2"] }), P1, state), "forbidden");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:own", value: null }], from: "undo", deps: true }, P1, state), "forbidden");
  });

  test("only on a token the player may move now", () => {
    const state = setup();
    assert.equal(code(back(state, "gob"), P1, state), "forbidden");
    state.meta.settings.playersMoveAny = "all";
    assert.equal(code(back(state, "gob"), P1, state), "ok");
    assert.equal(code(back(state, "locked"), P1, state), "forbidden");
    assert.equal(code(back(state, "hidden"), P1, state), "gone");
    assert.equal(code(back(state, "dark"), P1, state), "gone");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:nope", value: state.tokens.own }], from: "undo", deps: true }, P1, state), "gone");
  });

  test("on a locked token, an owner takes back a change of elevation or facing, which they may make, but no move", () => {
    const state = setup();
    state.tokens.own!.locked = true;
    const { x, y } = state.tokens.own!;
    assert.equal(code(back(state, "own", { x, y }), P1, state), "ok", "elevation and facing alone, as an owner may change them");
    assert.equal(code(back(state, "own"), P1, state), "forbidden", "a move back needs the token unlocked");
    assert.equal(code(back(state, "own", { x, y, sceneId: "s2" }), P1, state), "forbidden", "nor another scene");
    state.meta.settings.playersMoveAny = "all";
    const statue = state.tokens.locked!;
    assert.equal(code(back(state, "locked", { x: statue.x, y: statue.y }), P1, state), "forbidden", "a mover who does not own it needs it unlocked");
    state.tokens.own!.visibility = "dm";
    state.tokens.own!.ownerIds = ["p2"];
    assert.equal(code(back(state, "own", { x, y }), P1, state), "gone");
  });
});

describe("token and character fields", () => {
  test("owners patch only the allowed token fields, names only on PCs", () => {
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { rotation: 90, elevation: 5 } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { rangeRings: [30, 60] } }), "ok", "owners set their creature's range rings");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { rangeRings: [30] } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { name: "Fluffy" } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "pc1", patch: { name: "Ayla", publicName: "A" } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { visibility: "dm" } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { ownerIds: ["p1", "p2"] } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { actor: { dmNotes: "x" } } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { notes: "Raging" } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "pc1", patch: { notes: null } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { notes: "Mine now" } }), "forbidden");
    const img = (assetId: string) => ({ assetId, crop: { cx: 0, cy: 0, zoom: 1 } });
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { image: img("p1-wolf"), altImages: [img("p1-elf"), img("shared")] } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { altImages: [img("p1-elf"), img("p2-secret")] } }), "gone");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { altImages: null } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { altImages: [img("p1-elf")] } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { altImages: [img("dm1-face"), img("p1-elf")] } }, DM), "gone");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { altImages: [img("dm1-face")] } }, DM), "ok");
    assert.equal(code({ t: "token.update", tokenId: "gob", patch: { rotation: 1 } }), "forbidden");
    assert.equal(code({ t: "token.update", tokenId: "hidden", patch: { rotation: 1 } }), "gone");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { image: { assetId: "p1-pic", crop: { cx: 0, cy: 0, zoom: 1 } } } }), "ok");
    assert.equal(code({ t: "token.update", tokenId: "own", patch: { image: { assetId: "dm1-secret", crop: { cx: 0, cy: 0, zoom: 1 } } } }), "gone");
  });

  test("character owners edit the allowed fields only", () => {
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { name: "A", actor: { hp: { cur: 5 }, ac: 16, sheetUrl: "https://x" } } }), "ok");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { ownerIds: ["p2"] } }), "forbidden");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { actor: { dmNotes: "x" } } }), "forbidden");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { actor: { legendary: null } } }), "forbidden");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { name: "A" } }, P2), "forbidden");
    // A player keeps their own character's level, for the DM's encounter budget.
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { level: 5 } }), "ok");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { level: null } }), "ok");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { level: 5 } }, P2), "forbidden");
    assert.equal(code({ t: "character.update", characterId: "nope", patch: { name: "A" } }), "gone");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { defaultImage: { assetId: "shared", crop: { cx: 0, cy: 0, zoom: 1 } } } }), "ok");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { defaultImage: { assetId: "dm1-x", crop: { cx: 0, cy: 0, zoom: 1 } } } }), "gone");
  });

  test("a character's known forms are the DM's and its players' to choose, and no one else's (docs/design-v1-known-forms.md 3.2)", () => {
    const state = setup();
    state.characters.c1!.ownerIds = ["p1", "p2"];
    state.characters.c2 = character("c2", { ownerIds: ["p1"] });
    // P2 owns a token of c2, which is not owning c2.
    state.tokens.lent = token("lent", { kind: "pc", ownerIds: ["p2"], actor: { ref: "c2" }, x: 4, y: 4 });
    const forms = (characterId: string): Op => ({ t: "character.update", characterId, patch: { knownForms: ["wolf", "owl"] } });
    assert.equal(code(forms("c1"), DM, state), "ok");
    assert.equal(code(forms("c2"), DM, state), "ok");
    assert.equal(code(forms("c1"), P1, state), "ok");
    assert.equal(code(forms("c1"), P2, state), "ok", "a co-owner");
    assert.equal(code({ t: "character.update", characterId: "c1", patch: { knownForms: [] } }, P1, state), "ok");
    const refusal = canApply(forms("c2"), P2, state, deps);
    assert.deepEqual(refusal, { ok: false, code: "forbidden", message: "that is not yours" }, "a token's owner, not the character's");
    const other = setup();
    assert.equal(code(forms("c1"), P2, other), "forbidden", "another player");
  });
});

describe("HP and effects", () => {
  test("owners apply any change, others need playersApplyDamage and only for damage and healing", () => {
    assert.equal(code({ t: "actor.hp", target: { tokenId: "own" }, change: { kind: "set", cur: 1 } }), "ok");
    assert.equal(code({ t: "actor.hp", target: { characterId: "c1" }, change: { kind: "temp", amount: 3 } }), "ok");
    assert.equal(code({ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 3 } }), "forbidden");
    const open = setup();
    open.meta.settings.playersApplyDamage = true;
    assert.equal(code({ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 3 } }, P1, open), "ok");
    assert.equal(code({ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "heal", amount: 3 } }, P1, open), "ok");
    assert.equal(code({ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "set", cur: 0 } }, P1, open), "forbidden");
    assert.equal(code({ t: "actor.hp", target: { tokenId: "hidden" }, change: { kind: "damage", amount: 3 } }, P1, open), "gone");
    assert.equal(code({ t: "actor.hp", target: { tokenId: "dark" }, change: { kind: "damage", amount: 3 } }, P1, open), "gone");
    assert.equal(code({ t: "actor.hp", target: { characterId: "c1" }, change: { kind: "damage", amount: 3 } }, P2, open), "forbidden");
    assert.equal(code({ t: "actor.hp", target: { characterId: "nope" }, change: { kind: "damage", amount: 3 } }, P2, open), "gone");
  });

  test("an area's damage is the DM's to confirm, whatever the targets and the room's settings", () => {
    const op: Op = { t: "actor.damageMany", hits: [{ target: { tokenId: "own" }, amount: 3 }, { target: { tokenId: "gob" }, amount: 1 }] };
    assert.equal(code(op, DM), "ok");
    const open = setup();
    open.meta.settings.playersApplyDamage = true;
    assert.equal(code(op, P1, open), "forbidden");
    // The same answer for a hidden creature, so the refusal tells a player nothing.
    assert.equal(code({ t: "actor.damageMany", hits: [{ target: { tokenId: "hidden" }, amount: 3 }] }, P1, open), "forbidden");
  });

  test("death saves and effects belong to owners, and anchors must be visible", () => {
    assert.equal(code({ t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 0 }), "ok");
    assert.equal(code({ t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 0 }, P2), "forbidden");
    assert.equal(code({ t: "actor.effect.add", target: { tokenId: "own" }, effect: { id: "e", key: "blessed" } }), "ok");
    assert.equal(code({ t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "e", key: "blessed" } }), "forbidden");
    assert.equal(code({ t: "actor.effect.add", target: { tokenId: "own" }, effect: { id: "e", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "gob" } } } }), "ok");
    assert.equal(code({ t: "actor.effect.add", target: { tokenId: "own" }, effect: { id: "e", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "hidden" } } } }), "gone");
    assert.equal(code({ t: "actor.effect.add", target: { tokenId: "own" }, effect: { id: "e", key: "blessed", duration: { mode: "turnEnd", of: { entryId: "nope" } } } }), "gone");
    const state = setup();
    (state.tokens.own!.actor as { inline: { effects: object[] } }).inline.effects = [{ id: "e", key: "blessed" }];
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n1", { tokenId: "gob" }), entry("n2", { tokenId: "hidden" }), entry("n3", { tokenId: "own", hidden: true })] };
    assert.equal(code({ t: "actor.effect.update", target: { tokenId: "own" }, effectId: "e", patch: { duration: { mode: "rounds", rounds: 2, of: { entryId: "n1" } } } }, P1, state), "ok");
    assert.equal(code({ t: "actor.effect.update", target: { tokenId: "own" }, effectId: "e", patch: { duration: { mode: "rounds", rounds: 2, of: { entryId: "n2" } } } }, P1, state), "gone");
    assert.equal(code({ t: "actor.effect.update", target: { tokenId: "own" }, effectId: "e", patch: { duration: { mode: "rounds", rounds: 2, of: { entryId: "n3" } } } }, P1, state), "gone");
    assert.equal(code({ t: "actor.effect.remove", target: { tokenId: "own" }, effectId: "e" }, P1, state), "ok");
    assert.equal(code({ t: "actor.effect.remove", target: { tokenId: "hidden" }, effectId: "e" }), "gone");
  });

  test("a condition the DM hid is not there for the creature's owner, and only the DM hides one", () => {
    const state = setup();
    const hidden = { id: "secret", key: "poisoned" as const, hiddenFromPlayers: true };
    state.characters.c1!.actor.effects = [hidden, { id: "seen", key: "blessed" }];
    (state.tokens.own!.actor as { inline: { effects: object[] } }).inline.effects = [hidden];
    for (const target of [{ characterId: "c1" }, { tokenId: "pc1" }, { tokenId: "own" }]) {
      // The same answer as an effect that does not exist, so a refusal never confirms a hidden one.
      assert.equal(code({ t: "actor.effect.remove", target, effectId: "secret" }, P1, state), "gone");
      assert.equal(code({ t: "actor.effect.update", target, effectId: "secret", patch: { level: 2 } }, P1, state), "gone");
      assert.equal(code({ t: "actor.effect.add", target, effect: { id: "secret", key: "blessed" } }, P1, state), "gone");
      assert.equal(code({ t: "actor.effect.add", target, effect: { id: "mine", key: "blessed", hiddenFromPlayers: true } }, P1, state), "forbidden");
      assert.equal(code({ t: "actor.effect.remove", target, effectId: "secret" }, DM, state), "ok");
      assert.equal(code({ t: "actor.effect.add", target, effect: { id: "mine", key: "blessed", hiddenFromPlayers: true } }, DM, state), "ok");
    }
    assert.equal(code({ t: "actor.effect.remove", target: { characterId: "c1" }, effectId: "seen" }, P1, state), "ok");
    assert.equal(code({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "seen", patch: { hiddenFromPlayers: true } }, P1, state), "forbidden");
    assert.equal(code({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "seen", patch: { hiddenFromPlayers: false } }, P1, state), "forbidden");
    assert.equal(code({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "seen", patch: { hiddenFromPlayers: true } }, DM, state), "ok");
  });

  test("an owner's change to a hidden condition gets the very answer one that is not there gets, whatever the change", () => {
    const state = setup();
    state.characters.c1!.actor.effects = [{ id: "secret", key: "poisoned", hiddenFromPlayers: true }];
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n2", { tokenId: "hidden" })] };
    const target = { characterId: "c1" };
    const patches = [{ level: 2 }, { hiddenFromPlayers: false }, { label: "x" }, { duration: { mode: "rounds" as const, rounds: 2, of: { entryId: "n2" } } }, { duration: null }];
    const answer = (op: Op) => canApply(op, P1, state, deps);
    for (const patch of patches) {
      const hidden = answer({ t: "actor.effect.update", target, effectId: "secret", patch });
      assert.deepEqual(answer({ t: "actor.effect.update", target, effectId: "removed", patch }), hidden, JSON.stringify(patch));
      assert.deepEqual(hidden, { ok: false, code: "gone", message: "that is not here" });
    }
    assert.deepEqual(answer({ t: "actor.effect.remove", target, effectId: "secret" }), answer({ t: "actor.effect.remove", target, effectId: "removed" }));
    assert.deepEqual(answer({ t: "actor.effect.remove", target, effectId: "secret" }), { ok: false, code: "gone", message: "that is not here" });
  });
});

describe("an Exhaustion level", () => {
  const bad = { ok: false, code: "invalid", message: "Exhaustion is level 1 to 6" };

  test("is 1 to 6 on every op that sets one, from the DM or an owner, and any other counter 0 to 99", () => {
    const state = setup();
    state.characters.c1!.actor.effects = [{ id: "x", key: "exhaustion", level: 2 }, { id: "c", key: "blessed", level: 3 }];
    const target = { characterId: "c1" };
    for (const who of [DM, P1]) {
      for (const level of [0, 7, 99]) assert.deepEqual(canApply({ t: "actor.effect.add", target, effect: { id: "n", key: "exhaustion", level } }, who, state, deps), bad);
      for (const level of [1, 6]) assert.equal(code({ t: "actor.effect.add", target, effect: { id: "n", key: "exhaustion", level } }, who, state), "ok");
      assert.equal(code({ t: "actor.effect.add", target, effect: { id: "n", key: "blessed", level: 99 } }, who, state), "ok");
      for (const level of [0, 7, null]) assert.deepEqual(canApply({ t: "actor.effect.update", target, effectId: "x", patch: { level } }, who, state, deps), bad, String(level));
      assert.equal(code({ t: "actor.effect.update", target, effectId: "x", patch: { level: 6 } }, who, state), "ok");
      assert.equal(code({ t: "actor.effect.update", target, effectId: "c", patch: { level: 0 } }, who, state), "ok");
      assert.equal(code({ t: "actor.effect.update", target, effectId: "x", patch: { label: "x" } }, who, state), "ok", "a change that leaves the level alone");
    }
  });

  test("holds for the actor a new token or character brings, and a hidden one is still answered as not there", () => {
    const state = setup();
    const actorWith = (level: number) => actor({ effects: [{ id: "e", key: "exhaustion", level }] });
    for (const level of [0, 9]) {
      assert.deepEqual(canApply({ t: "token.create", token: { id: "t9", sceneId: "s1", kind: "monster", name: "Gob", size: "medium", x: 1, y: 1, actor: { inline: actorWith(level) } } }, DM, state, deps), bad);
      assert.deepEqual(canApply({ t: "character.create", character: { id: "c9", name: "Bo", size: "small", ownerIds: [], actor: actorWith(level) } }, DM, state, deps), bad);
    }
    assert.equal(code({ t: "character.create", character: { id: "c9", name: "Bo", size: "small", ownerIds: [], actor: actorWith(3) } }, DM, state), "ok");
    state.characters.c1!.actor.effects = [{ id: "secret", key: "exhaustion", level: 2, hiddenFromPlayers: true }];
    assert.equal(code({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "secret", patch: { level: 9 } }, P1, state), "gone");
  });
});

describe("areas and drawings", () => {
  const area = (overrides: object) => ({ id: "new", sceneId: "s1", shape: "sphere" as const, size: 20, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff0000", ownerId: "p1", visibility: "all" as const, ...overrides });

  test("players create their own visible areas on the player scene, with visible references", () => {
    assert.equal(code({ t: "template.create", template: area({}) }), "ok");
    assert.equal(code({ t: "template.create", template: area({ ownerId: "p2" }) }), "forbidden");
    assert.equal(code({ t: "template.create", template: area({ visibility: "dm" }) }), "forbidden");
    assert.equal(code({ t: "template.create", template: area({ sceneId: "s2" }) }), "gone");
    assert.equal(code({ t: "template.create", template: area({ attachedTo: "hidden" }) }), "gone");
    assert.equal(code({ t: "template.create", template: area({ casterId: "dark" }) }), "gone");
    assert.equal(code({ t: "template.create", template: area({ attachedTo: "gob", casterId: "own" }) }), "ok");
    const state = setup();
    state.templates.new = template("new", { visibility: "dm", ownerId: "dm1" });
    assert.equal(code({ t: "template.create", template: area({}) }, P1, state), "gone");
  });

  test("players edit and delete only their own, and cannot see withheld ones", () => {
    const state = setup();
    state.templates.mine = template("mine", { ownerId: "p1" });
    state.templates.theirs = template("theirs", { ownerId: "p2" });
    state.templates.secret = template("secret", { ownerId: "p1", attachedTo: "hidden" });
    assert.equal(code({ t: "template.update", templateId: "mine", patch: { size: 30 } }, P1, state), "ok");
    assert.equal(code({ t: "template.update", templateId: "mine", patch: { visibility: "dm" } }, P1, state), "forbidden");
    assert.equal(code({ t: "template.update", templateId: "mine", patch: { attachedTo: "hidden" } }, P1, state), "gone");
    assert.equal(code({ t: "template.update", templateId: "theirs", patch: { size: 30 } }, P1, state), "forbidden");
    assert.equal(code({ t: "template.update", templateId: "secret", patch: { size: 30 } }, P1, state), "gone");
    assert.equal(code({ t: "template.delete", templateId: "mine" }, P1, state), "ok");
    assert.equal(code({ t: "template.delete", templateId: "theirs" }, P1, state), "forbidden");
    assert.equal(code({ t: "template.delete", templateId: "nope" }, P1, state), "gone");
    state.meta.settings.playersSeeAoeOfOthers = false;
    assert.equal(code({ t: "template.delete", templateId: "theirs" }, P1, state), "gone");
  });

  test("drawings follow the same shape", () => {
    const state = setup();
    state.drawings.mine = drawing("mine", { ownerId: "p1" });
    state.drawings.theirs = drawing("theirs", { ownerId: "p2" });
    state.drawings.dm = drawing("dm", { ownerId: "dm1", visibility: "dm" });
    const d = (overrides: object) => ({ id: "new", sceneId: "s1", kind: "line" as const, points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "p1", visibility: "all" as const, ...overrides });
    assert.equal(code({ t: "drawing.create", drawing: d({}) }, P1, state), "ok");
    assert.equal(code({ t: "drawing.create", drawing: d({ id: "dm" }) }, P1, state), "gone");
    assert.equal(code({ t: "drawing.create", drawing: d({ ownerId: "p2" }) }, P1, state), "forbidden");
    assert.equal(code({ t: "drawing.create", drawing: d({ visibility: "dm" }) }, P1, state), "forbidden");
    assert.equal(code({ t: "drawing.create", drawing: d({ sceneId: "s2" }) }, P1, state), "gone");
    assert.equal(code({ t: "drawing.delete", drawingId: "mine" }, P1, state), "ok");
    assert.equal(code({ t: "drawing.delete", drawingId: "theirs" }, P1, state), "forbidden");
    assert.equal(code({ t: "drawing.delete", drawingId: "dm" }, P1, state), "gone");
    assert.equal(code({ t: "drawing.clear", sceneId: "s1", scope: "own" }, P1, state), "ok");
    assert.equal(code({ t: "drawing.clear", sceneId: "s2", scope: "own" }, P1, state), "gone");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "drawing:mine", value: state.drawings.mine, expectRev: null }], from: "undo" }, P1, state), "ok");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "drawing:theirs", value: null, expectRev: 0 }], from: "undo" }, P1, state), "forbidden");
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:own", value: null, expectRev: 0 }], from: "undo" }, P1, state), "forbidden");
  });

  test("a player's restore of a drawing off the player scene answers gone, whether that scene is there or deleted", () => {
    const state = setup();
    state.drawings.away = drawing("away", { ownerId: "p1", sceneId: "s2" });
    const restore = (entry: { key: string; value: unknown }): Op => ({ t: "sys.restore", entries: [entry], from: "undo", deps: true });
    // Putting back an erased drawing, on the players' scene, on another, and on one deleted since.
    assert.equal(code(restore({ key: "drawing:gone1", value: drawing("gone1", { ownerId: "p1" }) }), P1, state), "ok");
    assert.equal(code(restore({ key: "drawing:gone2", value: drawing("gone2", { ownerId: "p1", sceneId: "s2" }) }), P1, state), "gone");
    assert.equal(code(restore({ key: "drawing:gone3", value: drawing("gone3", { ownerId: "p1", sceneId: "deleted" }) }), P1, state), "gone");
    // Taking back a drawing that now stands on another scene.
    assert.equal(code(restore({ key: "drawing:away", value: null }), P1, state), "gone");
  });

  test("a player's kept ruler stands only on tokens they can see", () => {
    const ruler = (anchors: (string | null)[]) => ({
      id: "kept",
      sceneId: "s1",
      kind: "ruler" as const,
      points: [1.5, 1.5, 2.5, 2.5],
      style: { stroke: "#ffffff", width: 3, opacity: 1 },
      ownerId: "p1",
      visibility: "all" as const,
      anchors,
    });
    assert.equal(code({ t: "drawing.create", drawing: ruler(["pc1", "gob"]) }), "ok");
    assert.equal(code({ t: "drawing.create", drawing: ruler(["pc1", null]) }), "ok");
    for (const unseen of ["hidden", "dark", "other", "missing"]) {
      assert.equal(code({ t: "drawing.create", drawing: ruler(["pc1", unseen]) }), "gone", unseen);
    }
    assert.equal(code({ t: "drawing.create", drawing: { ...ruler(["pc1", "hidden"]), ownerId: "dm1", visibility: "dm" } }, DM), "ok");
  });
});

describe("encounter", () => {
  function combat() {
    const state = setup();
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "n1",
      entries: [entry("n1", { tokenId: "pc1", value: 20 }), entry("n2", { tokenId: "gob", value: 10, tieOrder: 1 }), entry("n3", { tokenId: "hidden", value: 5, tieOrder: 2 }), entry("n4", { label: "Lair", value: 20, tieOrder: 3 })],
    };
    return state;
  }

  test("players add and remove their own creatures and set their own values", () => {
    const state = combat();
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "own" }] }, P1, state), "ok");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", characterId: "c1" }] }, P1, state), "ok");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "gob" }] }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "hidden" }] }, P1, state), "gone");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "n1", tokenId: "own" }] }, P1, state), "gone");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", label: "Lair" }] }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "own", hidden: true }] }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "own" }] }, P1, setup()), "gone");
    assert.equal(code({ t: "encounter.remove", entryIds: ["n1"] }, P1, state), "ok");
    assert.equal(code({ t: "encounter.remove", entryIds: ["n2"] }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.remove", entryIds: ["n3"] }, P1, state), "gone");
    assert.equal(code({ t: "encounter.remove", entryIds: ["n4"] }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 3 }, P1, state), "ok");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 3 }, P2, state), "forbidden");
    assert.equal(code({ t: "encounter.setValue", entryId: "n3", value: 3 }, P1, state), "gone");
  });

  test("with typed totals off a player sets their initiative only to the total of their own roll for that creature (owner's setting)", () => {
    const state = combat();
    state.meta.settings.playersTypeTotals = false;
    const line = (by: string, tag: string, total: number, tokenId = "pc1", initiative = true) => ({
      id: `${state.log.length + 1}:0`,
      at: "2026-10-17T20:00:00.000Z",
      kind: "event" as const,
      data: { type: "dice" as const, tag, by, to: "all" as const, rolls: [{ formula: "1d20+2", faces: [total - 2], total, label: initiative ? "Initiative" : "Longsword", tokenId, ...(initiative ? { initiative: true as const } : {}) }] },
    });
    // An initiative from an earlier fight, then this fight's start, then this fight's lines.
    state.log.push(line(P1.memberId, "t-old", 17));
    state.log.push({ id: `${state.log.length + 1}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "encounter", action: "start" } });
    state.log.push(line(P1.memberId, "t-mine", 14), line(P2.memberId, "t-theirs", 18), line(P1.memberId, "t-other", 16, "own"), line(P1.memberId, "t-atk", 25, "pc1", false));
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 14 }, P1, state), "forbidden", "a typed value");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 14, roll: "t-mine" }, P1, state), "ok", "the roll's own total");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 19, roll: "t-mine" }, P1, state), "forbidden", "another number than it rolled");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 18, roll: "t-theirs" }, P1, state), "forbidden", "someone else's roll");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 16, roll: "t-other" }, P1, state), "forbidden", "a roll for another creature");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 25, roll: "t-atk" }, P1, state), "forbidden", "an attack's total is no initiative (B7B-P-2)");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 17, roll: "t-old" }, P1, state), "forbidden", "an initiative from an earlier fight (B7B-P-2)");
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: null }, P1, state), "ok", "clearing types no number");
    assert.equal(code({ t: "encounter.setValues", values: [{ entryId: "n1", value: 3 }] }, DM, state), "ok", "the DM's values are unaffected");
    state.meta.settings.playersTypeTotals = true;
    assert.equal(code({ t: "encounter.setValue", entryId: "n1", value: 3 }, P1, state), "ok", "on, a typed value goes");
  });

  test("with typed totals off a player's row joins the fight with no value, or with their own roll's total, by every way it joins (B7B-ASTRA-02)", () => {
    const state = combat();
    state.meta.settings.playersTypeTotals = false;
    state.tokens.wolf = token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], x: 2, y: 1, companion: { of: "c1", turn: "own" }, actor: { inline: actor() } });
    state.log.push({ id: "1:0", at: "2026-10-17T20:00:00.000Z", kind: "event", data: { type: "dice", tag: "t-own", by: P1.memberId, to: "all", rolls: [{ formula: "1d20+1", faces: [11], total: 12, label: "Initiative", tokenId: "own", initiative: true }] } });
    const add = (entries: OpOf<"encounter.add">["entries"]) => code({ t: "encounter.add", entries }, P1, state);
    assert.equal(add([{ id: "x", tokenId: "own", value: 100 }]), "forbidden", "a typed value on joining");
    assert.equal(add([{ id: "x", tokenId: "own" }]), "ok", "no value");
    assert.equal(add([{ id: "x", tokenId: "own", value: null }]), "ok", "an empty value");
    assert.equal(add([{ id: "x", tokenId: "own", value: 12, roll: "t-own" }]), "ok", "its own roll's total");
    assert.equal(add([{ id: "x", tokenId: "own", value: 13, roll: "t-own" }]), "forbidden", "another number than it rolled");
    assert.equal(add([{ id: "x", tokenId: "own" }, { id: "y", characterId: "c1", value: 18 }]), "forbidden", "a group join with one typed value");
    assert.equal(add([{ id: "x", tokenId: "wolf", value: 15 }]), "forbidden", "a companion's own row");
    const readd = apply(state, { t: "encounter.remove", entryIds: ["n1"] }, P1);
    assert.equal(code({ t: "encounter.add", entries: [{ id: "n9", tokenId: "pc1", value: 20 }] }, P1, readd), "forbidden", "a re-add after removing the row");
    assert.equal(code({ t: "encounter.add", entries: [{ id: "x", tokenId: "gob", value: 9 }] }, DM, state), "ok", "the DM's values are unaffected");
    assert.equal(code({ t: "encounter.start", entries: [{ id: "x", tokenId: "own", value: 9 }] }, P1, state), "forbidden", "a fight is the DM's to start");
    state.meta.settings.playersTypeTotals = true;
    assert.equal(add([{ id: "x", tokenId: "own", value: 100 }]), "ok", "on, a typed value goes");
  });

  test("players mark their own row's reaction spent, and every other row flag stays the DM's", () => {
    const state = combat();
    assert.equal(code({ t: "encounter.update", entryId: "n1", patch: { reactionUsed: true } }, P1, state), "ok");
    assert.equal(code({ t: "encounter.update", entryId: "n1", patch: { reactionUsed: false } }, P1, state), "ok");
    assert.equal(code({ t: "encounter.update", entryId: "n1", patch: { reactionUsed: true } }, P2, state), "forbidden");
    assert.equal(code({ t: "encounter.update", entryId: "n2", patch: { reactionUsed: true } }, P1, state), "forbidden");
    assert.equal(code({ t: "encounter.update", entryId: "n3", patch: { reactionUsed: true } }, P1, state), "gone");
    for (const patch of [{ hidden: false }, { inLair: true }, { advantage: "adv" as const }, { label: "x" }, { groupKey: null }, { reactionUsed: true, hidden: false }]) {
      assert.equal(code({ t: "encounter.update", entryId: "n1", patch }, P1, state), "forbidden", JSON.stringify(patch));
    }
    assert.equal(code({ t: "encounter.update", entryId: "n1", patch: { reactionUsed: true } }, P1, setup()), "gone");
  });

  test("End Turn is allowed only on the player's own turn", () => {
    const state = combat();
    assert.equal(code({ t: "encounter.next" }, P1, state), "ok");
    assert.equal(code({ t: "encounter.next" }, P2, state), "forbidden");
    state.encounter!.activeEntryId = "n3";
    assert.equal(code({ t: "encounter.next" }, P1, state), "gone");
    state.encounter!.activeEntryId = null;
    assert.equal(code({ t: "encounter.next" }, P1, state), "gone");
    assert.equal(code({ t: "encounter.next" }, P1, setup()), "gone");
  });

  test("an End Turn that arrives after the turn moved on is taken, since it changes nothing, and never tells whose turn it is", () => {
    const state = combat();
    const next = (entry: string | null, round = 1): Op => ({ t: "encounter.next", from: { entry, round } });
    assert.equal(code(next("n1"), P1, state), "ok");
    assert.equal(code(next("n1"), P2, state), "forbidden");
    // The DM pressed Next first: the turn is a goblin's now, and the player's late press does nothing.
    state.encounter!.activeEntryId = "n2";
    assert.equal(code(next("n1"), P1, state), "ok");
    assert.equal(code(next("n1"), P2, state), "ok");
    // The same row in a later round is another turn.
    state.encounter!.activeEntryId = "n1";
    state.encounter!.round = 2;
    assert.equal(code(next("n1"), P1, state), "ok");
    assert.equal(code(next("n1", 2), P2, state), "forbidden");
    assert.equal(code(next("n1"), P1, setup()), "gone");
    // Previous stays the DM's, late or not.
    assert.equal(code({ t: "encounter.prev", from: { entry: "n1", round: 1 } }, P1, state), "forbidden");
  });

  test("while a hidden row acts, every guarded press is answered alike, whichever row it names", () => {
    const state = combat();
    state.encounter!.activeEntryId = "n3";
    const answers = ["n3", "n1", "n2", null].map((entry) => code({ t: "encounter.next", from: { entry, round: 1 } }, P1, state));
    assert.deepEqual(answers, ["ok", "ok", "ok", "ok"]);
    assert.equal(code({ t: "encounter.next", from: { entry: "n3", round: 2 } }, P1, state), "ok");
    // Before the first turn too: no row acts, and a player cannot start the fight.
    state.encounter!.activeEntryId = null;
    assert.equal(code({ t: "encounter.next", from: { entry: null, round: 1 } }, P1, state), "ok");
    assert.equal(code({ t: "encounter.next", from: { entry: "n1", round: 1 } }, P1, state), "ok");
  });

  test("while the player's own row acts out of their view, every guarded press is answered alike too", () => {
    for (const hide of ["row", "scene"] as const) {
      const state = combat();
      if (hide === "row") state.encounter!.entries.find((e) => e.id === "n1")!.hidden = true;
      else state.tokens.pc1!.sceneId = "s2";
      const answers = ["n1", "n2", null].map((entry) => code({ t: "encounter.next", from: { entry, round: 1 } }, P1, state));
      assert.deepEqual(answers, ["ok", "ok", "ok"], hide);
      assert.equal(code({ t: "encounter.next" }, P1, state), "gone", hide);
    }
  });

  test("behind a blackout every press is gone, whether a row acts and whichever it names", () => {
    for (const active of ["n1", "n2", "n3", null]) {
      const state = combat();
      state.meta.view.blackout = true;
      state.encounter!.activeEntryId = active;
      for (const entry of ["n1", "n2", "n3", null]) {
        assert.equal(code({ t: "encounter.next", from: { entry, round: 1 } }, P1, state), "gone", `${active} acting, ${entry} named`);
      }
      assert.equal(code({ t: "encounter.next" }, P1, state), "gone");
    }
  });
});

describe("players creating their own characters", () => {
  const img = (assetId: string) => ({ assetId, crop: { cx: 0, cy: 0, zoom: 1 } });
  const on = () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = true;
    return state;
  };
  const create = (over: Record<string, unknown> = {}): Op =>
    ({ t: "character.create", character: { id: "new", name: "Wren", size: "medium", ownerIds: ["p1"], actor: actor({ dmNotes: "" }), ...over } }) as Op;
  const place = (over: Record<string, unknown> = {}): Op =>
    ({ t: "token.create", token: { id: "t9", sceneId: "s1", kind: "pc", name: "Ayla", size: "medium", x: 4, y: 4, actor: { ref: "c1" }, ...over } }) as Op;

  test("off, and in rooms from before the setting, players get today's refusal", () => {
    assert.equal(code(create()), "forbidden");
    assert.equal(code(place()), "forbidden");
    const old = setup();
    delete (old.meta.settings as Partial<typeof old.meta.settings>).playersCreateCharacters;
    assert.equal(code(create(), P1, old), "forbidden");
    assert.equal(code(place(), P1, old), "forbidden");
  });

  test("on, a player makes a plain character owned by themselves alone, with their own portrait", () => {
    assert.equal(code(create(), P1, on()), "ok");
    assert.equal(code(create({ defaultImage: img("p1-face") }), P1, on()), "ok");
    assert.equal(code(create({ defaultImage: img("p2-face") }), P1, on()), "gone");
    assert.equal(code(create({ ownerIds: ["p2"] }), P1, on()), "forbidden");
    assert.equal(code(create({ ownerIds: ["p1", "p2"] }), P1, on()), "forbidden");
    assert.equal(code(create({ ownerIds: [] }), P1, on()), "forbidden");
    assert.equal(code(create({ id: "c1" }), P1, on()), "gone");
    assert.equal(code(create({ actor: actor({ dmNotes: "secret" }) }), P1, on()), "forbidden");
    assert.equal(code(create({ actor: actor({ dmNotes: "", life: "dead" }) }), P1, on()), "forbidden");
    assert.equal(code(create({ actor: actor({ dmNotes: "", effects: [{ id: "e", key: "blessed" }] }) }), P1, on()), "forbidden");
  });

  test("a player's new character starts unhurt: full HP above 0 and no temporary HP", () => {
    const hp = (cur: number, max: number, temp = 0) => create({ actor: actor({ dmNotes: "", hp: { cur, max, temp } }) });
    assert.equal(code(hp(12, 12), P1, on()), "ok");
    assert.equal(code(hp(5, 12), P1, on()), "forbidden", "wounded");
    assert.equal(code(hp(0, 12), P1, on()), "forbidden", "down");
    assert.equal(code(hp(0, 0), P1, on()), "forbidden", "no HP at all");
    assert.equal(code(hp(12, 12, 999), P1, on()), "forbidden", "temporary HP");
    assert.equal(code(create({ actor: actor({ dmNotes: "", deathSaves: { ok: 0, fail: 2 } }) }), P1, on()), "forbidden");
    // The DM sets up a character however the story needs.
    assert.equal(code(hp(0, 12, 999), DM, on()), "ok");
  });

  test("a player's token takes its character's size, under any name", () => {
    const state = on();
    delete state.tokens.pc1;
    assert.equal(code(place({ name: "Ayla the Bold" }), P1, state), "ok", "owners may name a PC's token");
    assert.equal(code(place({ size: "large" }), P1, state), "forbidden");
    assert.equal(code(place({ size: "custom", w: 20, h: 20, x: 0, y: 0 }), P1, state), "forbidden");
    assert.equal(code(place({ w: 2 }), P1, state), "forbidden");
    state.characters.c1 = character("c1", { ownerIds: ["p1"], size: "small" });
    assert.equal(code(place({ size: "small" }), P1, state), "ok");
    assert.equal(code(place(), P1, state), "forbidden", "medium is not this character's size");
  });

  test("a player's token never carries the DM's party mark, set or unset", () => {
    const state = on();
    delete state.tokens.pc1;
    assert.equal(code(place(), P1, state), "ok");
    assert.equal(code(place({ partyVision: true }), P1, state), "forbidden");
    assert.equal(code(place({ partyVision: false }), P1, state), "forbidden");
    // The token's own light is the owner's (docs/design-v1-maps-vision.md 4.3.9).
    assert.equal(code(place({ light: { bright: 20, dim: 20 } }), P1, state), "ok");
  });

  test("at most three characters each, counting the ones the DM gave them", () => {
    const state = on();
    state.characters.c2 = character("c2", { ownerIds: ["p1"] });
    assert.equal(code(create(), P1, state), "ok");
    state.characters.c3 = character("c3", { ownerIds: ["p1", "p2"] });
    const d = canApply(create(), P1, state, deps);
    assert.ok(!d.ok && d.code === "forbidden" && /at most 3/.test(d.message));
    assert.equal(code(create({ ownerIds: ["p2"] }), P2, state), "ok", "p2 owns one of them");
  });

  test("a player places their own character's token on the players' scene, inside it, once", () => {
    const state = on();
    delete state.tokens.pc1;
    assert.equal(code(place(), P1, state), "ok");
    assert.equal(code(place({ ownerIds: ["p1"] }), P1, state), "ok");
    assert.equal(code(place({ image: img("p1-face") }), P1, state), "ok");
    assert.equal(code(place({ hpVisibility: "exact", disposition: "ally" }), P1, state), "ok");
    assert.equal(code(place(), P2, state), "forbidden", "not their character");
    assert.equal(code(place({ actor: { ref: "nope" } }), P1, state), "gone");
    assert.equal(code(place({ sceneId: "s2" }), P1, state), "gone");
    assert.equal(code(place({ x: -1 }), P1, state), "forbidden");
    assert.equal(code(place({ x: state.scenes.s1!.bounds.w - 0.5 }), P1, state), "forbidden");
    assert.equal(code(place({ ownerIds: ["p1", "p2"] }), P1, state), "forbidden");
    assert.equal(code(place({ id: "gob" }), P1, state), "gone");
    assert.equal(code(place({ image: img("p2-face") }), P1, state), "gone");
    for (const over of [{ kind: "monster" }, { visibility: "dm" }, { fogExempt: true }, { locked: true }, { nameHidden: true }, { number: 2 }, { hpVisibility: "hidden" }, { layer: "object" }]) {
      assert.equal(code(place(over), P1, state), "forbidden", JSON.stringify(over));
    }
    assert.equal(code(place({ actor: { inline: actor() } }), P1, state), "forbidden");
    state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
    assert.equal(code(place(), P1, state), "forbidden", "already on the map");
  });

  test("the DM still edits, takes over and deletes them", () => {
    const state = on();
    state.characters.mine = character("mine", { ownerIds: ["p1"] });
    assert.equal(code({ t: "character.update", characterId: "mine", patch: { ownerIds: ["p2"] } }, DM, state), "ok");
    assert.equal(code({ t: "character.delete", characterId: "mine" }, DM, state), "ok");
    assert.equal(code({ t: "token.delete", tokenId: "pc1" }, DM, state), "ok");
    // The player deletes the character they play alone, never a token of it on its own.
    assert.equal(code({ t: "character.delete", characterId: "mine" }, P1, state), "ok");
    assert.equal(code({ t: "token.delete", tokenId: "pc1" }, P1, state), "forbidden");
  });
});

describe("players deleting characters they play alone", () => {
  const del = (characterId: string): Op => ({ t: "character.delete", characterId });
  const why = (op: Op, who = P1, state = setup()) => {
    const d = canApply(op, who, state, deps);
    return d.ok ? "ok" : `${d.code}: ${d.message}`;
  };

  test("a player deletes one they alone play, whether they or the DM made it, with the setting on or off", () => {
    // c1 is the DM's, given to p1 alone, and the room has players creating their own off.
    assert.equal(code(del("c1")), "ok");
    const on = setup();
    on.meta.settings.playersCreateCharacters = true;
    on.characters.made = character("made", { ownerIds: ["p1"] });
    assert.equal(code(del("made"), P1, on), "ok");
    assert.equal(code(del("c1"), P1, on), "ok");
  });

  test("not one someone else also plays, nor another player's, nor one nobody plays, nor one that is not there", () => {
    const state = setup();
    state.characters.both = character("both", { ownerIds: ["p1", "p2"] });
    state.characters.theirs = character("theirs", { ownerIds: ["p2"] });
    state.characters.nobody = character("nobody", { ownerIds: [] });
    assert.equal(why(del("both"), P1, state), `forbidden: ${PLAYED_WITH_OTHERS}`);
    assert.equal(why(del("both"), P2, state), `forbidden: ${PLAYED_WITH_OTHERS}`);
    assert.equal(why(del("theirs"), P1, state), "forbidden: that is not yours");
    assert.equal(why(del("c1"), P2, state), "forbidden: that is not yours");
    assert.equal(why(del("nobody"), P1, state), "forbidden: that is not yours");
    assert.equal(why(del("missing"), P1, state), "gone: that is not here");
    // A token's id is not a character's, a companion's included.
    state.tokens.wisp = token("wisp", { ownerIds: ["p1"], companion: { of: "c1", turn: "shared" }, x: 2, y: 1 });
    assert.equal(why(del("wisp"), P1, state), "gone: that is not here");
    assert.equal(why(del("pc1"), P1, state), "gone: that is not here");
  });

  test("the DM keeps every power: shared, another player's, nobody's", () => {
    const state = setup();
    state.characters.both = character("both", { ownerIds: ["p1", "p2"] });
    state.characters.nobody = character("nobody", { ownerIds: [] });
    for (const id of ["c1", "both", "nobody"]) assert.equal(code(del(id), DM, state), "ok", id);
  });

  test("reads who plays it now: the DM sharing it or giving it away takes the delete with it, and giving it back returns it", () => {
    let state = setup();
    state = apply(state, { t: "character.update", characterId: "c1", patch: { ownerIds: ["p1", "p2"] } }, DM, 1);
    assert.equal(why(del("c1"), P1, state), `forbidden: ${PLAYED_WITH_OTHERS}`);
    state = apply(state, { t: "character.update", characterId: "c1", patch: { ownerIds: ["p2"] } }, DM, 2);
    assert.equal(code(del("c1"), P1, state), "forbidden");
    assert.equal(code(del("c1"), P2, state), "ok");
    state = apply(state, { t: "character.update", characterId: "c1", patch: { ownerIds: ["p1"] } }, DM, 3);
    assert.equal(code(del("c1"), P1, state), "ok");
  });

  test("whatever goes with it: companions, its row in the fight, its turn, tokens on another scene or hidden, and behind a blackout", () => {
    const state = setup();
    state.tokens.wisp = token("wisp", { ownerIds: ["p1"], companion: { of: "c1", turn: "own" }, x: 2, y: 1 });
    state.tokens.away = token("away", { kind: "pc", actor: { ref: "c1" }, sceneId: "s2", x: 4, y: 4 });
    state.tokens.veiled = token("veiled", { kind: "pc", actor: { ref: "c1" }, visibility: "dm", x: 5, y: 5 });
    state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [entry("n1", { tokenId: "pc1" }), entry("n2", { tokenId: "wisp" }), entry("n3", { characterId: "c1" }), entry("n4", { tokenId: "gob" })] };
    assert.equal(code(del("c1"), P1, state), "ok");
    state.meta.view.blackout = true;
    assert.equal(code(del("c1"), P1, state), "ok", "a character is the room's, not the table's");
  });

  test("no undo of the player's own brings it back", () => {
    const state = setup();
    const gone = apply(state, del("c1"), P1, 1);
    const restore = (key: string, value: unknown): Op => ({ t: "sys.restore", entries: [{ key, value, expectRev: null }], from: "undo" });
    assert.equal(code(restore("character:c1", state.characters.c1), P1, gone), "forbidden");
    assert.equal(code(restore("token:pc1", state.tokens.pc1), P1, gone), "gone");
  });

  test("a delete frees a slot under the cap of three", () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = true;
    state.characters.c2 = character("c2", { ownerIds: ["p1"] });
    state.characters.c3 = character("c3", { ownerIds: ["p1"] });
    const create: Op = { t: "character.create", character: { id: "new", name: "Wren", size: "medium", ownerIds: ["p1"], actor: actor({ dmNotes: "" }) } };
    const full = canApply(create, P1, state, deps);
    assert.ok(!full.ok && /at most 3/.test(full.message));
    const freed = apply(state, del("c2"), P1, 1);
    assert.equal(code(create, P1, freed), "ok");
  });
});

describe("wave 3 map ops", () => {
  /** An asset of each kind the DM may use: its id names its kind, as the room's asset rows would. */
  const kinds: PermissionDeps = { canUseAsset: (_memberId, assetId, kind) => assetId.startsWith(`${kind}-`) };
  const dmCode = (op: Op) => {
    const d = canApply(op, DM, setup(), kinds);
    return d.ok ? "ok" : d.code;
  };
  const stamp = (art: { key: string } | { assetId: string }) => ({ id: "st", art, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const });
  const phase = (assetId: string) => ({ id: "p", name: "Day", assetId, widthPx: 10, heightPx: 10 });

  test("are the DM's alone", () => {
    const ops: Op[] = [
      { t: "build.walls", sceneId: "s1", put: [{ id: "abcdefabcdef", a: [0, 0], b: [1, 1], f: { kind: "wall" } }] },
      { t: "build.stamps", sceneId: "s1", put: [stamp({ key: "oak" })] },
      { t: "build.lights", sceneId: "s1", put: [{ id: "l", x: 1, y: 1, bright: 20, dim: 20, on: true, walls: true }] },
      { t: "scene.setPhase", sceneId: "s1", phaseId: "p" },
      { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } },
      { t: "scene.update", sceneId: "s1", patch: { folder: "Act 1" } },
    ];
    for (const op of ops) assert.equal(code(op), "forbidden", op.t);
  });

  test("a thumbnail must be a thumb asset, a phase a map and a stamp's image a token image", () => {
    assert.equal(dmCode({ t: "scene.update", sceneId: "s1", patch: { thumb: "thumb-1" } }), "ok");
    assert.equal(dmCode({ t: "scene.update", sceneId: "s1", patch: { thumb: "map-1" } }), "gone");
    assert.equal(dmCode({ t: "scene.update", sceneId: "s1", patch: { thumb: null } }), "ok");
    assert.equal(dmCode({ t: "scene.update", sceneId: "s1", patch: { phases: [phase("map-1"), { ...phase("map-2"), id: "q" }] } }), "ok");
    assert.equal(dmCode({ t: "scene.update", sceneId: "s1", patch: { phases: [phase("map-1"), { ...phase("token-2"), id: "q" }] } }), "gone");
    assert.equal(dmCode({ t: "build.stamps", sceneId: "s1", put: [stamp({ key: "oak" }), stamp({ assetId: "token-1" })] }), "ok");
    assert.equal(dmCode({ t: "build.stamps", sceneId: "s1", put: [stamp({ assetId: "map-1" })] }), "gone");
  });
});

describe("pdf handouts (docs/design-v1-pdf-handouts.md 3.3)", () => {
  // The room's rows by kind. Any other id is another room's image, or none.
  const rows: Record<string, AssetKind> = { h1: "handout", h2: "handout", map: "map", tok: "token" };
  const byKind: PermissionDeps = { canUseAsset: (_member, assetId, kind) => rows[assetId] === kind };
  const kindCode = (op: Op, who = DM) => {
    const d = canApply(op, who, setup(), byKind);
    return d.ok ? "ok" : d.code;
  };
  const pages = (...ids: string[]) => ids.map((assetId) => ({ assetId, width: 1584, height: 2048 }));
  const show = (...ids: string[]): Op => ({ t: "handout.show", handout: { id: "h", pages: pages(...ids), title: "Strange letter", to: "all" } });

  test("a show checks every page as a handout image of the room, a repeated page included", () => {
    assert.equal(kindCode(show("h1", "h2", "h1")), "ok");
    assert.equal(kindCode(show("h1", "map")), "gone");
    assert.equal(kindCode(show("tok", "h1")), "gone");
    assert.equal(kindCode(show("h1", "elsewhere")), "gone");
    assert.equal(kindCode(show("h1"), P1), "forbidden");
  });

  test("both document ops are the DM's, and a save checks every page as a show does", () => {
    const create = (...ids: string[]): Op => ({ t: "handoutDoc.create", doc: { id: "d2", title: "Strange letter", pages: pages(...ids) } });
    const remove: Op = { t: "handoutDoc.delete", docId: "d1" };
    assert.equal(kindCode(create("h1", "h2", "h1")), "ok");
    assert.equal(kindCode(create("h1", "map")), "gone");
    assert.equal(kindCode(create("tok")), "gone");
    assert.equal(kindCode(create("elsewhere", "h1")), "gone");
    assert.equal(kindCode(remove), "ok");
    for (const op of [create("h1"), remove]) {
      assert.equal(kindCode(op, P1), "forbidden", op.t);
      assert.equal(kindCode(op, P2), "forbidden", op.t);
    }
  });

  test("an undo that puts a document back is refused once one of its pages is gone, and a show's as well", () => {
    const state = setup();
    const doc = { id: "d1", rev: 3, title: "Strange letter", pages: pages("h1", "deleted"), createdAt: "" };
    // The restore's facts: the rows of this room still there.
    const restoring: PermissionDeps = { ...byKind, restoredAssetUsable: (assetId, kind) => rows[assetId] === kind };
    const back = (entries: RestoreEntry[]) => {
      const d = canApply({ t: "sys.restore", entries, from: "undo", deps: true }, DM, state, restoring);
      return d.ok ? "ok" : `${d.code}: ${d.message}`;
    };
    assert.equal(back([{ key: "handoutDoc:d1", value: doc, expectRev: null }]), "gone: its image was deleted since");
    assert.equal(back([{ key: "handoutDoc:d1", value: { ...doc, pages: pages("h1", "h2") }, expectRev: null }]), "ok");
    const handout = { id: "h9", rev: 1, assetId: "h1", pages: pages("h1", "deleted"), title: "Strange letter", to: "all", shownAt: "" };
    assert.equal(back([{ key: "handout:h9", value: handout, expectRev: null }]), "gone: its image was deleted since");
  });
});

describe("a player's resize (docs/design-v1-token-window.md 8.6)", () => {
  /**
   * Scene s1, which blocks moves: P1's familiar at 4,4 with a free wall at
   * x 4.375 inside its square, a Large of theirs at 4,10, one in a walled
   * corner at 30,10, their PC through its character, its companion, and
   * the DM's goblin, a locked token and a Custom one.
   */
  function sized() {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "free", a: [4.375, 4], b: [4.375, 5], f: { kind: "wall" } }] };
    state.buildChunks["s1:1,0"] = { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: {}, edges: { "30,10,w": { kind: "wall" }, "30,10,n": { kind: "wall" } } };
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    state.tokens.own = token("own", { kind: "npc", name: "Owl", ownerIds: ["p1"], x: 4, y: 4 });
    state.tokens.big = token("big", { kind: "npc", name: "Bear", size: "large", ownerIds: ["p1"], x: 4, y: 10 });
    state.tokens.cornered = token("cornered", { kind: "npc", name: "Thorn", ownerIds: ["p1"], x: 30, y: 10 });
    state.tokens.pc1 = token("pc1", { kind: "pc", name: "Ayla", actor: { ref: "c1" }, x: 12, y: 4 });
    state.tokens.spirit = token("spirit", { kind: "npc", name: "Spirit", ownerIds: ["p1"], x: 16, y: 4, companion: { of: "c1", turn: "shared" } });
    state.tokens.gob = token("gob", { x: 20, y: 4 });
    state.tokens.locked = token("locked", { kind: "npc", name: "Statue", ownerIds: ["p1"], locked: true, x: 22, y: 4 });
    state.tokens.custom = token("custom", { kind: "npc", name: "Wagon", ownerIds: ["p1"], size: "custom", w: 2, h: 3, x: 24, y: 4 });
    return state;
  }
  const resize = (tokenId: string, patch: object): Op => ({ t: "token.update", tokenId, patch: patch as never });
  /** The answer on the server's state and on the player's own projected copy, which the device checks before it sends. */
  const both = (op: Op, state = sized(), who = P1): string => {
    const words = (d: ReturnType<typeof canApply>) => (d.ok ? "ok" : d.message);
    const server = words(canApply(op, who, state, deps));
    const copy = projectState(state, who, { sceneId: state.meta.playerSceneId }) as unknown as RoomState;
    assert.equal(words(canApply(op, who, copy, deps)), server, `the device's check agrees on ${JSON.stringify(op)}`);
    return server;
  };

  test("an owner resizes their own token, their PC through its character, and their companion, by one rule", () => {
    assert.equal(both(resize("own", { size: "large" })), "ok");
    assert.equal(both(resize("pc1", { size: "huge", x: 11, y: 3 })), "ok");
    assert.equal(both(resize("spirit", { size: "large" })), "ok");
    assert.equal(both(resize("big", { size: "medium" })), "ok", "a shrink to its top-left square, the place left out");
    assert.equal(both(resize("own", { size: "small" })), "ok", "Small and Medium are one footprint");
  });

  test("a token they do not own is not theirs, even where they may move any token, and a locked one keeps its size", () => {
    // The device offers no resize on a token it does not own, so only the server answers these.
    const server = (state: RoomState) => {
      const d = canApply(resize("gob", { size: "large" }), P1, state, deps);
      return d.ok ? "ok" : d.message;
    };
    assert.equal(server(sized()), "that is not yours");
    const state = sized();
    state.meta.settings.playersMoveAny = "all";
    assert.equal(server(state), "that is not yours");
    assert.equal(both(resize("locked", { size: "large" })), "that token is locked");
  });

  test("owners pick one of the six sizes, never Custom, and send the size and the place alone", () => {
    assert.equal(both(resize("own", { size: "custom", w: 2, h: 2 })), OWNER_SIZES);
    assert.equal(both(resize("custom", { size: "large" })), OWNER_SIZES, "a Custom token is the DM's to resize");
    assert.equal(both(resize("own", { size: "large", w: 2 })), OWNER_SIZES);
    assert.equal(both(resize("own", { size: "large", h: null })), OWNER_SIZES);
    assert.equal(both(resize("own", { size: "large", name: "Big Owl" })), OWNER_SIZES);
    assert.equal(both(resize("own", { size: "large", elevation: 10 })), OWNER_SIZES);
    assert.equal(both(resize("spirit", { size: "large", actor: { ac: 15 } })), OWNER_SIZES, "a companion's numbers never ride with its size");
  });

  test("a spot the resize may not take keeps the creature where it stands, on the device too", () => {
    assert.equal(both(resize("big", { size: "large", x: 3 })), RESIZE_KEEPS_PLACE, "keeping its size keeps its place");
    assert.equal(both(resize("own", { size: "small", y: 5 })), RESIZE_KEEPS_PLACE);
    assert.equal(both(resize("own", { size: "large", x: 3.5 })), RESIZE_KEEPS_PLACE, "off the new size's grid");
    assert.equal(both(resize("own", { size: "huge", x: 38, y: 28 })), RESIZE_KEEPS_PLACE, "not over its square");
    assert.equal(both(resize("big", { size: "huge", x: 5, y: 9 })), RESIZE_KEEPS_PLACE, "holding its middle but not every old square");
    assert.equal(both(resize("big", { size: "medium", x: 6, y: 10 })), RESIZE_KEEPS_PLACE, "a shrink outside its footprint");
    const edge = sized();
    edge.tokens.own = { ...edge.tokens.own!, x: 39, y: 29 };
    assert.equal(both(resize("own", { size: "large", x: 39, y: 29 }), edge), RESIZE_KEEPS_PLACE, "outside the scene");
    assert.equal(both(resize("own", { size: "large", x: 38, y: 28 }), edge), "ok");
  });

  test("on a scene that blocks moves, a growth with no room and a shrink across a wall are refused, and allowed where nothing blocks", () => {
    assert.equal(both(resize("cornered", { size: "huge", x: 29, y: 9 })), NO_ROOM_TO_GROW);
    assert.equal(both(resize("cornered", { size: "huge", x: 30, y: 10 })), "ok", "the spot the search finds");
    assert.deepEqual(resizeSpot(sized(), sized().tokens.cornered!, { size: "huge" }, { checked: true }), { x: 30, y: 10, shifted: true });
    assert.equal(both(resize("own", { size: "tiny", x: 4, y: 4 })), WALL_IN_THE_WAY, "its middle would cross the free wall at x 4.375");
    assert.equal(both(resize("own", { size: "tiny", x: 4.5, y: 4 })), "ok");
    assert.deepEqual(resizeSpot(sized(), sized().tokens.own!, { size: "tiny" }, { checked: true }), { x: 4.5, y: 4, shifted: true }, "the device never sends (4, 4)");
    const open = sized();
    open.scenes.s1!.blockMovement = false;
    assert.equal(both(resize("cornered", { size: "huge", x: 29, y: 9 }), open), "ok");
    assert.equal(both(resize("own", { size: "tiny", x: 4, y: 4 }), open), "ok");
  });

  test("a companion's owner is judged the same way, through companionUpdateCheck", () => {
    const state = sized();
    state.tokens.spirit = { ...state.tokens.spirit!, x: 30, y: 10 };
    delete state.tokens.cornered;
    assert.equal(both(resize("spirit", { size: "huge", x: 29, y: 9 }), state), NO_ROOM_TO_GROW);
    assert.equal(both(resize("spirit", { size: "huge", x: 30, y: 10 }), state), "ok");
    assert.equal(both(resize("spirit", { size: "large", x: 31 }), state), RESIZE_KEEPS_PLACE);
    state.tokens.spirit!.locked = true;
    assert.equal(both(resize("spirit", { size: "large" }), state), "that token is locked");
  });

  test("the DM is never refused", () => {
    const dm = (op: Op) => canApply(op, DM, sized(), deps).ok;
    assert.ok(dm(resize("cornered", { size: "huge", x: 29, y: 9 })));
    assert.ok(dm(resize("own", { size: "tiny", x: 4, y: 4 })));
    assert.ok(dm(resize("gob", { size: "custom", w: 3, h: 2, x: 7, y: 1 })));
    assert.ok(dm(resize("locked", { size: "gargantuan", x: 0, y: 0, name: "Colossus" })));
  });

  test("a resize patch goes on a player's undo stack, a patch with another field does not", () => {
    assert.equal(isResizeOp(resize("own", { size: "large", x: 4, y: 4 })), true);
    assert.equal(onPlayerUndoStack(resize("own", { size: "large" })), true);
    assert.equal(onPlayerUndoStack(resize("own", { size: "custom", w: 2, h: 3 })), true, "the DM's Custom fields belong to it");
    assert.equal(onPlayerUndoStack(resize("own", { size: "large", name: "Big Owl" })), false);
    assert.equal(onPlayerUndoStack(resize("own", { x: 4, y: 4 })), false);
    assert.equal(isPoseOp(resize("own", { size: "large" })), false, "a resize is not a move");
  });
});

describe("a player's undo or redo of a resize (restorePoseCheck)", () => {
  /** P1's bear grown from Medium at 4,4 to Large at 4,4, on a scene that blocks moves. */
  function grown() {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
    state.tokens.bear = token("bear", { kind: "npc", name: "Bear", size: "large", ownerIds: ["p1"], x: 4, y: 4 });
    state.tokens.wolf = token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], x: 10, y: 4 });
    return state;
  }
  const restore = (state: RoomState, id: string, value: object, from: "undo" | "redo" = "undo"): Op => ({ t: "sys.restore", entries: [{ key: `token:${id}`, value: { ...state.tokens[id]!, ...value } }], from, deps: true });
  const answer = (op: Op, state: RoomState) => {
    const d = canApply(op, P1, state, deps);
    return d.ok ? "ok" : d.message;
  };

  test("an undo of a growth puts back the size and the place, and nothing else", () => {
    const state = grown();
    assert.equal(answer(restore(state, "bear", { size: "medium" }), state), "ok");
    assert.equal(answer(restore(state, "bear", { size: "medium", path: { turn: 3, stops: [{ x: 4, y: 4, elevation: 0 }] } }), state), "ok", "with the path it had");
    assert.equal(answer(restore(state, "bear", { size: "medium", name: "Cub" }), state), "an undo of yours only moves or resizes tokens back");
    assert.equal(answer(restore(state, "bear", { size: "medium", visibility: "dm" }), state), "an undo of yours only moves or resizes tokens back");
    assert.equal(answer(restore(state, "bear", { size: "medium", x: 6 }), state), RESIZE_KEEPS_PLACE, "judged as a shrink to that footprint");
    assert.equal(answer(restore(state, "bear", { size: "custom", w: 1, h: 1 }), state), OWNER_SIZES);
  });

  test("needs the rights of a resize at the undo and the redo: owned now, unlocked, not Custom", () => {
    const locked = grown();
    locked.tokens.bear!.locked = true;
    assert.equal(answer(restore(locked, "bear", { size: "medium" }), locked), "that token is locked");
    const custom = grown();
    custom.tokens.bear = { ...custom.tokens.bear!, size: "custom", w: 2, h: 2 };
    assert.equal(answer(restore(custom, "bear", { size: "medium", w: undefined, h: undefined }), custom), OWNER_SIZES);
    for (const from of ["undo", "redo"] as const) {
      const given = grown();
      given.meta.settings.playersMoveAny = "all";
      given.tokens.bear!.ownerIds = ["p2"];
      given.tokens.wolf!.ownerIds = ["p2"];
      const value = from === "undo" ? { size: "medium" } : { size: "huge", x: 3, y: 3 };
      assert.equal(answer(restore(given, "bear", value, from), given), "that is not yours", `the ${from} of a resize`);
      assert.equal(answer(restore(given, "wolf", { x: 12 }, from), given), "ok", `while the ${from} of a move passes, as the player may move any token`);
    }
  });

  test("a redo of a growth needs room again, and a restore that keeps the size is a move's, as before", () => {
    const medium = grown();
    medium.tokens.bear = { ...medium.tokens.bear!, size: "medium" };
    assert.equal(answer(restore(medium, "bear", { size: "large" }, "redo"), medium), "ok");
    // A new chunk collection, as the reducer writes one: the walls are worked out once per collection.
    medium.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 2, cells: {}, edges: { "5,4,w": { kind: "wall" }, "5,5,w": { kind: "wall" } } } };
    assert.equal(answer(restore(medium, "bear", { size: "large" }, "redo"), medium), NO_ROOM_TO_GROW, "a wall drawn since through the grown footprint");
    assert.equal(answer(restore(medium, "bear", { x: 6 }, "redo"), medium), WALL_IN_THE_WAY, "a move's redo meets the wall as a move");
    medium.tokens.bear!.locked = true;
    assert.equal(answer(restore(medium, "bear", { elevation: 20 }), medium), "ok", "an owner's undo in place on a locked token, as before");
  });
});
