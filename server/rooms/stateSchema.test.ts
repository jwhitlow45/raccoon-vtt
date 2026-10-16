import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import { migrateSnapshot } from "#shared/migrate.ts";
import { MAX_PATH_STOPS } from "#shared/protocol.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { actor, apply, character, customMonster, DM, imageRef, randomState, rng, room, srdImage, token } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

describe("roomStateSchema", () => {
  test("a fresh room and random rooms parse after a JSON round trip", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(fresh))).ok);
    for (let seed = 1; seed <= 20; seed++) {
      const state = randomState(rng(seed));
      const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
      assert.ok(parsed.ok, parsed.ok ? "" : `seed ${seed}: ${parsed.message}`);
    }
  });

  test("companions, their spent Reactions, the saved Reactions of a step, the companion line and healing the dead parse, all optional (docs/design-v1-combat-flow.md 4.7)", () => {
    const state = room({ characters: { bree: character("bree") } });
    state.meta.settings = { ...state.meta.settings, healRevives: false };
    state.tokens.ws = token("ws", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    state.encounterHistory = [{ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] }, effects: {}, revealed: [], companionReactions: ["ws"], at: "x" }];
    state.log = [{ id: "1:0", at: "x", kind: "event", data: { type: "companion", tokenId: "ws", characterId: "bree", memberId: "p1", name: "Wildfire Spirit" } }];
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const bad = JSON.parse(JSON.stringify(state));
    bad.tokens.ws.companion.turn = "sometimes";
    assert.equal(parseRoomState(bad).ok, false);
    const older = JSON.parse(JSON.stringify(state));
    delete older.meta.settings.healRevives;
    assert.ok(parseRoomState(older).ok, "a backup from before the setting");
  });

  test("the DM's line for a character a player deleted parses, with whole counts of zero and up", () => {
    const state = room();
    const line = { type: "characterDeleted", characterId: "bree", memberId: "p1", name: "Bree", tokens: 2, companions: 0, rows: 1 };
    state.log = [{ id: "1:0", at: "x", kind: "event", data: line as never }];
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    for (const bad of [{ tokens: -1 }, { rows: 1.5 }, { companions: undefined }, { extra: true }]) {
      const broken = JSON.parse(JSON.stringify(state));
      broken.log[0].data = { ...line, ...bad };
      assert.equal(parseRoomState(broken).ok, false, JSON.stringify(bad));
    }
  });

  test("a room where a member was removed parses, so its backup can be imported", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    const removed = { ...fresh, log: [{ id: "1:0", at: new Date().toISOString(), kind: "event", data: { type: "member", memberId: "m2", action: "remove" } }] };
    const parsed = parseRoomState(JSON.parse(JSON.stringify(removed)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("unknown fields and bad values are refused", () => {
    const state = JSON.parse(JSON.stringify(randomState(rng(3))));
    const extra = { ...state, surprise: true };
    assert.equal(parseRoomState(extra).ok, false);
    const badToken = JSON.parse(JSON.stringify(state));
    const first = Object.keys(badToken.tokens)[0]!;
    badToken.tokens[first].x = "far";
    const result = parseRoomState(badToken);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /tokens/);
    assert.equal(parseRoomState({ ...state, log: [{ id: "oops", at: "x", kind: "chat" }] }).ok, false);
  });

  test("a character's level is 1 to 20 or absent, as in backups from before levels", () => {
    const state = JSON.parse(JSON.stringify(randomState(rng(3))));
    const first = Object.keys(state.characters)[0]!;
    const withLevel = (level: unknown) => {
      const s = JSON.parse(JSON.stringify(state));
      if (level === undefined) delete s.characters[first].level;
      else s.characters[first].level = level;
      return parseRoomState(s).ok;
    };
    assert.equal(withLevel(undefined), true);
    assert.equal(withLevel(1), true);
    assert.equal(withLevel(20), true);
    assert.equal(withLevel(0), false);
    assert.equal(withLevel(21), false);
    assert.equal(withLevel(4.5), false);
  });

  test("an Exhaustion level from before the 1 to 6 rule is brought within it, and any other effect keeps its 0 to 99", () => {
    const state = JSON.parse(JSON.stringify(randomState(rng(3))));
    const first = Object.keys(state.characters)[0]!;
    const imported = (key: string, level: number) => {
      const s = JSON.parse(JSON.stringify(state));
      s.characters[first].actor.effects = [{ id: "e", key, level }];
      const parsed = parseRoomState(s);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
      return parsed.state.characters[first]!.actor.effects[0]!.level;
    };
    assert.equal(imported("exhaustion", 1), 1);
    assert.equal(imported("exhaustion", 6), 6);
    assert.equal(imported("exhaustion", 0), 1);
    assert.equal(imported("exhaustion", 7), 6);
    assert.equal(imported("blessed", 0), 0);
    assert.equal(imported("blessed", 99), 99);
  });

  test("a token or character any op may create imports as it was created", () => {
    const deps = { canUseAsset: () => true };
    for (const level of [undefined, 0, 1, 6, 7, 99]) {
      const effects = [{ id: "e", key: "exhaustion" as const, ...(level === undefined ? {} : { level }) }];
      const ops: Op[] = [
        { t: "token.create", token: { id: "t9", sceneId: "s1", kind: "monster", name: "Gob", size: "medium", x: 1, y: 1, actor: { inline: actor({ effects }) } } },
        { t: "character.create", character: { id: "c9", name: "Bo", size: "small", ownerIds: [], actor: actor({ effects }) } },
      ];
      for (const op of ops) {
        const start = room();
        if (!canApply(op, DM, start, deps).ok) {
          assert.ok(level === 0 || level === 7 || level === 99, `${op.t} refused level ${level}`);
          continue;
        }
        const after = apply(start, op);
        const parsed = parseRoomState(JSON.parse(JSON.stringify(after)));
        assert.ok(parsed.ok, `${op.t} with level ${level}: ${parsed.ok ? "" : parsed.message}`);
        assert.deepEqual(JSON.parse(JSON.stringify(parsed.state)), JSON.parse(JSON.stringify(after)), `${op.t} with level ${level} imports unchanged`);
      }
    }
  });

  test("custom monsters parse with the create op's bounds, and a backup from before them still imports", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    const withMonster = JSON.parse(JSON.stringify({ ...fresh, monsters: { x1: customMonster("x1", { sizeAlt: "small", xpInLair: 700 }) } }));
    assert.ok(parseRoomState(withMonster).ok);
    const bad = (patch: Record<string, unknown>) => {
      const s = JSON.parse(JSON.stringify(withMonster));
      Object.assign(s.monsters.x1, patch);
      return parseRoomState(s);
    };
    assert.equal(bad({ cr: "1/3" }).ok, false);
    assert.equal(bad({ name: "\u001b[2J" }).ok, false);
    assert.equal(bad({ rev: undefined }).ok, false);
    assert.equal(bad({ notes: "extra" }).ok, false);
    assert.equal(bad({ actions: [{ name: "Bite", text: "x", damage: 7 }] }).ok, false);

    const { monsters: _monsters, ...v1 } = JSON.parse(JSON.stringify(fresh));
    assert.equal(parseRoomState(v1).ok, false);
    const migrated = parseRoomState(migrateSnapshot(v1, 1));
    assert.ok(migrated.ok && Object.keys(migrated.state.monsters).length === 0);
  });

  test("monster images parse with a token image's bounds, and a backup from before SRD images still imports", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    const withImages = JSON.parse(
      JSON.stringify({ ...fresh, monsters: { x1: customMonster("x1", { defaultImage: imageRef("a1") }) }, srdImages: { "goblin-warrior": srdImage("goblin-warrior", "a2") } }),
    );
    assert.ok(parseRoomState(withImages).ok);
    type Loose = { monsters: { x1: { defaultImage: Record<string, unknown> } }; srdImages: Record<string, Record<string, unknown>> };
    const bad = (change: (s: Loose, srd: Record<string, unknown>) => void) => {
      const s = JSON.parse(JSON.stringify(withImages)) as Loose;
      change(s, s.srdImages["goblin-warrior"]!);
      return parseRoomState(s).ok;
    };
    assert.equal(bad((s) => (s.monsters.x1.defaultImage.crop = { cx: 0, cy: 0, zoom: 50 })), false);
    assert.equal(bad((s) => (s.monsters.x1.defaultImage.url = "https://example.com")), false);
    assert.equal(bad((_, srd) => (srd.id = "Goblin Warrior")), false);
    assert.equal(bad((s, srd) => (s.srdImages["Goblin Warrior"] = srd)), false);
    assert.equal(bad((_, srd) => delete srd.image), false);
    assert.equal(bad((_, srd) => (srd.name = "Goblin Warrior")), false);

    const { srdImages: _srdImages, ...v2 } = JSON.parse(JSON.stringify(fresh));
    assert.equal(parseRoomState(v2).ok, false);
    const migrated = parseRoomState(migrateSnapshot(v2, 2));
    assert.ok(migrated.ok && Object.keys(migrated.state.srdImages).length === 0);
  });

  test("saved encounters parse with the create op's bounds, and a backup from before them still imports", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    const saved = { id: "e1", rev: 2, name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }, { monsterId: "x1", count: 1, inLair: true }], party: [{ count: 4, level: 3 }] };
    const withOne = JSON.parse(JSON.stringify({ ...fresh, savedEncounters: { e1: saved } }));
    assert.ok(parseRoomState(withOne).ok);
    const bad = (patch: Record<string, unknown>) => parseRoomState(JSON.parse(JSON.stringify({ ...fresh, savedEncounters: { e1: { ...saved, ...patch } } }))).ok;
    assert.equal(bad({ monsters: [{ srdId: "wolf", count: 51 }] }), false);
    assert.equal(bad({ monsters: [{ srdId: "Wolf", count: 1 }] }), false);
    assert.equal(bad({ party: [{ count: 4, level: 0 }] }), false);
    assert.equal(bad({ hidden: true }), false);
    assert.equal(bad({ rev: undefined }), false);

    const { savedEncounters: _saved, ...v4 } = JSON.parse(JSON.stringify(fresh));
    assert.equal(parseRoomState(v4).ok, false);
    const migrated = parseRoomState(migrateSnapshot(v4, 4));
    assert.ok(migrated.ok && Object.keys(migrated.state.savedEncounters).length === 0);
  });

  test("who may move any token parses as no one, everyone or a list, and a backup with the older switch still imports", () => {
    const fresh = JSON.parse(JSON.stringify(createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } })));
    const withMovers = (value: unknown) => parseRoomState({ ...fresh, meta: { ...fresh.meta, settings: { ...fresh.meta.settings, playersMoveAny: value } } }).ok;
    assert.equal(withMovers("none"), true);
    assert.equal(withMovers("all"), true);
    assert.equal(withMovers(["m1"]), true);
    assert.equal(withMovers(true), false);
    assert.equal(withMovers("some"), false);
    const { playersMoveAny: _new, ...settings } = fresh.meta.settings;
    const v3 = { ...fresh, meta: { ...fresh.meta, settings: { ...settings, playersMoveAnyToken: true } } };
    assert.equal(parseRoomState(v3).ok, false);
    const migrated = parseRoomState(migrateSnapshot(v3, 3));
    assert.ok(migrated.ok && migrated.state.meta.settings.playersMoveAny === "all");
  });

  test("a path parses within its bounds, with the seq naming its turn, and a backup from before paths still imports", () => {
    const stop = { x: 1, y: 2, elevation: 0, seen: true };
    const withPath = (stops: object[]) => {
      const state = room({ tokens: { t1: token("t1", { path: { turn: 4, stops: stops as never } }) } });
      state.encounter = { rev: 0, round: 1, activeEntryId: "n1", entries: [], turnStart: { entryId: "n1", tokenId: "t1", sceneId: "s1", x: 1, y: 2, elevation: 0, seq: 4 } };
      return parseRoomState(JSON.parse(JSON.stringify(state)));
    };
    assert.equal(withPath([stop, { ...stop, x: 3, uncounted: true }]).ok, true);
    assert.equal(withPath(Array.from({ length: MAX_PATH_STOPS }, () => stop)).ok, true);
    assert.equal(withPath(Array.from({ length: MAX_PATH_STOPS + 1 }, () => stop)).ok, false);
    assert.equal(withPath([]).ok, false);
    assert.equal(withPath([{ ...stop, seen: false }]).ok, false, "marks are present or absent, never false");
    assert.equal(withPath([{ ...stop, why: "x" }]).ok, false);
    assert.equal(parseRoomState(JSON.parse(JSON.stringify(room({ tokens: { t1: token("t1") } })))).ok, true);
  });

  test("names and short texts follow the protocol's text rules", () => {
    const fresh = createInitialState({ roomName: "R", dm: { id: "m1", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: new Date().toISOString() } });
    const withName = (name: string) => {
      const s = JSON.parse(JSON.stringify(fresh));
      s.members.m1.name = name;
      return s;
    };
    assert.equal(parseRoomState(withName("Café 梟 🦉")).ok, true);
    assert.equal(parseRoomState(withName("")).ok, false);
    assert.equal(parseRoomState(withName("\u001b]0;pwned\u0007")).ok, false);
    assert.equal(parseRoomState(withName("evil\u202Etxt")).ok, false);
    const renamed = JSON.parse(JSON.stringify(fresh));
    renamed.meta.name = "\u001b[2JRoom";
    assert.equal(parseRoomState(renamed).ok, false);
    const sceneId = fresh.meta.playerSceneId!;
    const labelled = JSON.parse(JSON.stringify(fresh));
    labelled.labels.l1 = { id: "l1", rev: 1, sceneId, x: 1, y: 1, text: "Trap\u0000", size: 1 };
    assert.equal(parseRoomState(labelled).ok, false);
    labelled.labels.l1.text = "";
    assert.equal(parseRoomState(labelled).ok, true);
  });

  test("names follow the protocol's text rules", () => {
    const state = JSON.parse(JSON.stringify(randomState(rng(4))));
    assert.equal(parseRoomState({ ...state, meta: { ...state.meta, name: "\u001b[2J" } }).ok, false);
    assert.equal(parseRoomState({ ...state, meta: { ...state.meta, name: "" } }).ok, false);
    assert.equal(parseRoomState({ ...state, members: { ...state.members, p1: { ...state.members.p1, name: "p\u202E1" } } }).ok, false);
    assert.equal(parseRoomState({ ...state, log: [{ id: "1:0", at: "x", kind: "chat", from: "p1", text: "two\nlines" }] }).ok, true);
  });

  test("wave 3: free walls, stamps, lights and phases parse with the ops' bounds, and a backup from before them still imports", () => {
    const { stamps: _stamps, lights: _lights, ...v5 } = JSON.parse(JSON.stringify(room()));
    assert.ok(parseRoomState(migrateSnapshot(v5, 5)).ok);
    const wall = (a: number[], b: number[]) => ({ id: "abcdefabcdef", a, b, f: { kind: "door", state: "locked", secret: true, discovered: false } });
    const withWalls = (walls: unknown[]) => {
      const state = JSON.parse(JSON.stringify(room()));
      state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls };
      return parseRoomState(state).ok;
    };
    assert.ok(withWalls([wall([1023 / 64, 0], [1023 / 64 - 5.5, 45 / 64])]));
    assert.equal(withWalls([wall([0, 0], [8.015625, 0])]), false, "longer than 8 cells");
    assert.equal(withWalls([wall([0.01, 0], [1, 0])]), false, "off the lattice");
    assert.equal(withWalls([]), false, "an empty list is stored as no field");
    const state = JSON.parse(JSON.stringify(room()));
    state.stamps.st = { id: "st", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "dm" };
    state.lights.l = { id: "l", rev: 0, sceneId: "s1", x: 1.5, y: 1, bright: 60, dim: 60, on: false, walls: true };
    const map = { assetId: "m", widthPx: 100, heightPx: 50, cellPx: 10, originPx: { x: 0, y: 0 } };
    const phases = [{ id: "p1", name: "Day", assetId: "m", widthPx: 100, heightPx: 50 }];
    const grid = { refWidthPx: 100, refHeightPx: 50, cellPx: 10, originPx: { x: 0, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1, map, phases, phaseId: "p1", phaseGrid: grid, folder: "Act 1", thumb: "t", autoWalls: "floor" };
    assert.ok(parseRoomState(state).ok);
    assert.equal(parseRoomState({ ...state, lights: { l: { ...state.lights.l, bright: 121 } } }).ok, false);
    assert.equal(parseRoomState({ ...state, stamps: { st: { ...state.stamps.st, art: { key: "../x" } } } }).ok, false);
    const scene = (patch: Record<string, unknown>) => parseRoomState({ ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1, ...patch } } }).ok;
    assert.equal(scene({ phaseId: "nope" }), false, "the active phase is in the list");
    assert.equal(scene({ phaseGrid: undefined }), false, "phases come with their grid");
    assert.equal(scene({ phases: undefined }), false, "a grid without phases");
    assert.equal(scene({ autoWalls: "some" }), false);
  });

  test("wave 4: heights, stairs, the explored layer, squeezes, lights, party members, vision and teleport lines parse, and a backup from before them still imports", () => {
    const { exploredTiles: _explored, ...v6 } = JSON.parse(JSON.stringify(room()));
    assert.ok(parseRoomState(migrateSnapshot(v6, 6)).ok);
    const bits = "A".repeat(683) + "=";
    const state = JSON.parse(JSON.stringify(room()));
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights: bits, up: ".".repeat(255) + "a" };
    state.exploredTiles["s1:0,0"] = { sceneId: "s1", tx: 0, ty: 0, rev: 3, bits };
    state.scenes.s1 = { ...state.scenes.s1, vision: { on: true, light: "dark" }, blockMovement: true };
    state.tokens.t = token("t", { size: "large", squeeze: true, light: { bright: 20, dim: 40 }, partyVision: true });
    state.log = [{ id: "1:0", at: "x", kind: "event", data: { type: "teleport", tokenId: "t", past: "wall" } }];
    const parsed = parseRoomState(state);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const chunk = (patch: Record<string, unknown>) => parseRoomState({ ...state, buildChunks: { "s1:0,0": { ...state.buildChunks["s1:0,0"], ...patch } } }).ok;
    assert.equal(chunk({ heights: "A".repeat(684) }), false, "not 512 bytes of base64");
    assert.equal(chunk({ up: ".".repeat(255) + "x" }), false, "not a stair mark");
    assert.equal(chunk({ up: "." }), false, "one mark per cell");
    assert.equal(parseRoomState({ ...state, exploredTiles: { "s1:0,0": { ...state.exploredTiles["s1:0,0"], bits: "short" } } }).ok, false);
    const tok = (patch: Record<string, unknown>) => parseRoomState({ ...state, tokens: { t: { ...state.tokens.t, ...patch } } }).ok;
    assert.equal(tok({ squeeze: false }), false, "a squeeze is stored only while it holds");
    assert.equal(tok({ light: { bright: 121, dim: 0 } }), false);
    assert.equal(parseRoomState({ ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1, vision: { on: true, light: "dusk" } } } }).ok, false);
    assert.equal(parseRoomState({ ...state, log: [{ id: "1:0", at: "x", kind: "event", data: { type: "teleport", tokenId: "t", past: "door" } }] }).ok, false);
  });

  test("a kept ruler's ground heights parse within the stepper's model bounds, and a ruler from before them still imports", () => {
    const state = JSON.parse(JSON.stringify(room()));
    const ruler = { id: "k", rev: 0, sceneId: "s1", kind: "ruler", points: [0.5, 0.5, 1.5, 0.5], style: { stroke: "#ffffff", width: 3, opacity: 1 }, ownerId: "p1", visibility: "all" };
    const parses = (patch: Record<string, unknown>) => parseRoomState({ ...state, drawings: { k: { ...ruler, ...patch } } }).ok;
    assert.ok(parses({}));
    assert.ok(parses({ z: [0, 10] }));
    assert.ok(parses({ z: [-100, 200], anchors: [null, null] }));
    assert.equal(parses({ z: [0, 201] }), false);
    assert.equal(parses({ z: [0, 2.5] }), false);
  });

  test("every phase fits its scene's grid as the reducer checks it, and the map is the showing phase's image", () => {
    const state = JSON.parse(JSON.stringify(room()));
    const at = (patch: Record<string, unknown>) => parseRoomState({ ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1, ...patch } } });
    const day = { id: "p1", name: "Day", assetId: "day", widthPx: 1000, heightPx: 500 };
    const night = { id: "p2", name: "Night", assetId: "night", widthPx: 2000, heightPx: 1000 };
    const grid = { refWidthPx: 1000, refHeightPx: 500, cellPx: 50, originPx: { x: 10, y: 0 } };
    const showingNight = { assetId: "night", widthPx: 2000, heightPx: 1000, cellPx: 100, originPx: { x: 20, y: 0 } };
    assert.ok(at({ map: showingNight, phases: [day, night], phaseId: "p2", phaseGrid: grid }).ok);
    const refused = (patch: Record<string, unknown>) => {
      const parsed = at({ map: showingNight, phases: [day, night], phaseId: "p2", phaseGrid: grid, ...patch });
      return parsed.ok ? "parsed" : parsed.message;
    };
    const message = "scenes.s1: a scene's phases fit its grid, and its map is the showing phase's image";
    assert.equal(refused({ map: { ...showingNight, cellPx: 99 } }), message, "a map off the showing phase's grid");
    assert.equal(refused({ map: { ...showingNight, assetId: "day" } }), message, "a map of another image");
    assert.equal(refused({ phases: [{ ...day, heightPx: 600 }, night] }), message, "a phase of another shape");
    // A backup made by hand: every field within its own bounds, but switching to the second phase would scale the grid to
    // 26,843,545,600 pixels a cell, which the protocol refuses and the room could never export again.
    const crafted = {
      map: { assetId: "day", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } },
      phases: [{ ...day, widthPx: 1, heightPx: 1 }, { ...night, widthPx: 100, heightPx: 100 }],
      phaseId: "p1",
      phaseGrid: { refWidthPx: 1, refHeightPx: 1, cellPx: 16_384 * 16_384, originPx: { x: 0, y: 0 } },
    };
    assert.equal(refused(crafted), message);
  });
});

describe("roomStateSchema, wave 5 (docs/design-v1-dm-tools.md 2.5)", () => {
  /** Pages, pins and rolls made by their ops, so the import takes exactly what the ops store. */
  function wave5(): ReturnType<typeof room> {
    let state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"], name: "Thorn", actor: actor({ monsterId: "m1" }) });
    state.tokens.t1 = token("t1", { image: { icon: "lorc/wolf-head", color: "#336699" }, altImages: [imageRef("a1"), { icon: "delapouite/goblin-head", color: "#000000" }] });
    state.meta.settings = { ...state.meta.settings, playersDraw: ["p1"] };
    const ops: Op[] = [
      { t: "journal.create", page: { id: "pg1", title: "Old map", folder: "Lore", access: { member: "p1" }, blocks: [{ id: "abcdefghijkl", text: "Hush.", secret: true }, { id: "bcdefghijklm", text: "Open." }] } },
      { t: "journal.reveal", pageId: "pg1", blockId: "abcdefghijkl", revealed: true },
      { t: "pin.put", pin: { id: "pin1", sceneId: "s1", x: 2.5, y: 3, label: "Here", pageId: "pg1", color: "#ff8800", visibility: "all" } },
      { t: "roll.ask", request: { id: "r1", test: { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] }, dc: 12, dcShown: false, resultShown: true, note: "the grapple", targets: [{ characterId: "c1" }] } },
      { t: "roll.answer", rollId: "r1", target: { characterId: "c1" }, choice: 1, total: 9 },
      { t: "roll.reopen", rollId: "r1", target: { characterId: "c1" } },
      { t: "roll.answer", rollId: "r1", target: { characterId: "c1" }, choice: 0, total: 15 },
    ];
    ops.forEach((op, i) => {
      state = apply(state, op, op.t === "roll.answer" ? { memberId: "p1", role: "player" } : DM, i + 1);
    });
    return state;
  }

  test("pages, pins, rolls and their lines, icons, links to room monsters and who may draw parse as their ops stored them", () => {
    const state = wave5();
    assert.ok(state.rolls.r1!.targets[0]!.previous);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.ok && parsed.state, JSON.parse(JSON.stringify(state)));
  });

  test("a backup from before wave 5 still imports, with none of them", () => {
    const { journal: _journal, pins: _pins, rolls: _rolls, ...v7 } = room();
    const parsed = parseRoomState(migrateSnapshot(JSON.parse(JSON.stringify(v7)), 7));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.ok && "playersDraw" in parsed.state.meta.settings, false);
  });

  test("what no op stores is refused: a block twice, a target that is two creatures or none, a projection's dcHidden", () => {
    const state = JSON.parse(JSON.stringify(wave5()));
    const twice = JSON.parse(JSON.stringify(state));
    twice.journal.pg1.blocks.push({ ...twice.journal.pg1.blocks[0] });
    assert.equal(parseRoomState(twice).ok, false);
    const both = JSON.parse(JSON.stringify(state));
    both.rolls.r1.targets[0].tokenId = "t1";
    assert.equal(parseRoomState(both).ok, false);
    const none = JSON.parse(JSON.stringify(state));
    delete none.rolls.r1.targets[0].characterId;
    assert.equal(parseRoomState(none).ok, false);
    const projected = JSON.parse(JSON.stringify(state));
    projected.rolls.r1.dcHidden = true;
    assert.equal(parseRoomState(projected).ok, false);
    const badIcon = JSON.parse(JSON.stringify(state));
    badIcon.tokens.t1.image.icon = "../../etc/passwd";
    assert.equal(parseRoomState(badIcon).ok, false);
  });
});
