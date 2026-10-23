import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareLogIds } from "#shared/keys.ts";
import { DM_LINE_BASE, dmNumbered, eventLines, lineAudience, MAX_LOG_LINES, memberRing, partyIndex, ringed, rosterRanks } from "#shared/logRings.ts";
import { compareLogIds as byId } from "#shared/keys.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { LogEntry, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { Tx } from "#shared/reducer/tx.ts";
import { projectArchivedLog, projectState, stableStringify, visibleAssetIds } from "#shared/project.ts";
import { AT, DM, P1, actor, apply, env, castAsk, castTable, character, companionBlock, customMonster, drawing, entry, imageRef, randomState, rng, room, srdImage, template, token, trap } from "#shared/testutil.ts";
import type { AssetKind } from "../assets/kinds.ts";
import { exportableState } from "./exportRoom.ts";
import { assertWithinLimits } from "./importRoom.ts";
import { remapState, type ImportedAsset } from "./remap.ts";
import { measuredStateBytes } from "./sizeGuard.ts";
import { parseRoomState } from "./stateSchema.ts";
import { imageAssetId } from "#shared/imageRef.ts";

function allIds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allIds(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && /Id$|^id$|^ref$|^from$|^attachedTo$|^casterId$|^of$/.test(k)) out.add(v);
      else allIds(v, out);
    }
  }
  return out;
}

/** Old asset id to the asset the import made of it, from `{ old: [newId, kind] }`. */
function kinds(table: Record<string, [string, AssetKind]>): Map<string, ImportedAsset> {
  return new Map(Object.entries(table).map(([old, [id, kind]]) => [old, { id, kind }]));
}

describe("remapState", () => {
  test("every entity gets a new id, references follow, and nothing old survives", () => {
    const state = randomState(rng(11));
    state.monsters.mx = customMonster("mx", { defaultImage: imageRef("img-mx") });
    state.srdImages.bandit = srdImage("bandit", "img-bandit");
    state.savedEncounters.ex = { id: "ex", rev: 0, name: "Lurkers", monsters: [{ srdId: "bandit", count: 2 }, { monsterId: "mx", count: 1, inLair: true }, { monsterId: "deleted-monster", count: 1 }], party: [{ count: 4, level: 3 }] };
    // What a seed draws moves with every addition to randomState, so the HP line that can be taken back is made here.
    const vitals = (cur: number) => ({ hp: { cur, max: 7, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    const hurt = Object.keys(state.tokens)[0]!;
    state.log.push({ id: "9:0", at: AT, kind: "event", data: { type: "hp", tokenId: hurt, change: "damage", amount: 4, left: { cur: 3, max: 7, temp: 0 }, revert: { before: vitals(7), after: vitals(3) } } });
    const assets = new Map<string, ImportedAsset>();
    const asToken = (id: string) => assets.set(id, { id: `new-${id}`, kind: "token" });
    // A shipped icon names no asset (docs/design-v1-dm-tools.md 3.12), so only uploads go through the image pipeline.
    const upload = (image: Parameters<typeof imageAssetId>[0]) => {
      const id = imageAssetId(image);
      if (id !== undefined) asToken(id);
    };
    for (const t of Object.values(state.tokens)) upload(t.image);
    for (const t of Object.values(state.tokens)) for (const image of t.altImages ?? []) upload(image);
    for (const m of Object.values(state.monsters)) if (m.defaultImage) asToken(imageAssetId(m.defaultImage)!);
    for (const e of Object.values(state.srdImages)) asToken(imageAssetId(e.image)!);
    const out = remapState(state, { assets, newId: (() => {
      let n = 0;
      return () => `n${n++}`;
    })() });
    const oldIds = new Set([...Object.keys(state.members), ...Object.keys(state.scenes), ...Object.keys(state.tokens), ...Object.keys(state.characters), ...Object.keys(state.templates), ...Object.keys(state.drawings), ...Object.keys(state.handouts), ...Object.keys(state.monsters), ...Object.keys(state.savedEncounters), ...Object.keys(state.companionBlocks)]);
    const referenced = allIds(out);
    for (const id of oldIds) assert.ok(!referenced.has(id), `old id ${id} survived`);
    assert.ok(stableStringify(out) !== stableStringify(state));
    for (const t of Object.values(out.tokens)) {
      assert.ok(out.scenes[t.sceneId], "token scene exists");
      if ("ref" in t.actor) assert.ok(out.characters[t.actor.ref], "token character exists");
      for (const owner of t.ownerIds) assert.ok(out.members[owner]);
      // An icon's key means the same in every room, and an upload follows its new id.
      for (const image of [...(t.image ? [t.image] : []), ...(t.altImages ?? [])]) assert.ok("icon" in image || /^new-/.test(image.assetId));
    }
    assert.ok(Object.values(out.tokens).some((t) => t.altImages), "the random room has a token with other images");
    for (const tpl of Object.values(out.templates)) {
      assert.ok(out.scenes[tpl.sceneId]);
      if (tpl.attachedTo) assert.ok(out.tokens[tpl.attachedTo], "attachedTo resolves or was dropped");
    }
    for (const key of Object.keys(out.buildChunks)) assert.ok(out.scenes[key.split(":")[0]!]);
    for (const key of Object.keys(out.fogTiles)) assert.ok(out.scenes[key.split(":")[0]!]);
    for (const m of Object.values(out.members)) assert.equal(m.kind, "player");
    // Nothing points at a custom monster, so each comes through whole under its new id, its image remapped like a token's.
    const withoutId = ({ id: _id, defaultImage: _image, ...block }: (typeof out.monsters)[string]) => block;
    for (const [id, m] of Object.entries(out.monsters)) assert.equal(m.id, id);
    assert.deepEqual(Object.values(out.monsters).map(withoutId), Object.values(state.monsters).map(withoutId));
    assert.deepEqual(
      Object.values(out.monsters).map((m) => m.defaultImage),
      Object.values(state.monsters).map((m) => (m.defaultImage ? { ...m.defaultImage, assetId: `new-${imageAssetId(m.defaultImage)}` } : undefined)),
    );
    // SRD ids mean the same in every room, so only the images change.
    assert.deepEqual(Object.keys(out.srdImages).sort(), Object.keys(state.srdImages).sort());
    for (const [srdId, e] of Object.entries(out.srdImages)) {
      assert.equal(e.id, srdId);
      assert.deepEqual(e.image, { ...state.srdImages[srdId]!.image, assetId: `new-${imageAssetId(state.srdImages[srdId]!.image)}` });
    }
    // A saved encounter keeps its SRD monsters and follows the room's own to their new ids. One deleted before the backup has no new id and goes.
    // Monsters come through in order, so the nth new id is the nth old monster's.
    const newMonsterId = new Map(Object.keys(state.monsters).map((id, i) => [id, Object.keys(out.monsters)[i]!]));
    const before = Object.values(state.savedEncounters);
    const after = Object.values(out.savedEncounters);
    assert.equal(after.length, before.length);
    after.forEach((e, i) => {
      const old = before[i]!;
      assert.equal(out.savedEncounters[e.id], e);
      assert.equal(e.name, old.name);
      assert.deepEqual(e.party, old.party);
      const kept = old.monsters.filter((m) => "srdId" in m || newMonsterId.has(m.monsterId));
      assert.deepEqual(e.monsters, kept.map((m) => ("srdId" in m ? m : { ...m, monsterId: newMonsterId.get(m.monsterId)! })));
      for (const m of e.monsters) if ("monsterId" in m) assert.ok(out.monsters[m.monsterId]);
    });
    assert.ok(out.meta.playerSceneId && out.scenes[out.meta.playerSceneId]);
    // The lines a player may get count one after another, and the DM's on their own from DM_LINE_BASE with the trap
    // log's, so no id a player gets counts a line only the DM holds (shared/logRings.ts).
    out.log.filter((e) => lineAudience(e) !== "dm").forEach((e, i) => assert.equal(e.id, `0:${i}`));
    const dmIds = out.log.filter((e) => lineAudience(e) === "dm").map((e) => e.id);
    assert.ok(dmIds.length > 0, "the random room has lines only the DM gets");
    for (const id of dmIds) assert.ok(dmNumbered(id), id);
    assert.equal(new Set([...dmIds, ...out.trapLog.map((e) => e.id)]).size, dmIds.length + out.trapLog.length, "no two DM lines share an id");
    assert.deepEqual(out.log.map((e) => e.id), [...out.log].sort((a, b) => compareLogIds(a.id, b.id)).map((e) => e.id), "the log is in id order");
    // An imported HP line is history: it keeps what it says and loses what the change replaced.
    assert.ok(state.log.some((e) => e.data?.type === "hp" && e.data.revert), "the random room has HP lines that can be taken back");
    for (const e of out.log) if (e.data?.type === "hp") assert.ok(!("revert" in e.data) && !("of" in e.data), `log ${e.id}`);
    for (const e of out.encounter?.entries ?? []) {
      if (e.tokenId) assert.ok(out.tokens[e.tokenId]);
      if (e.characterId) assert.ok(out.characters[e.characterId]);
    }
    if (out.encounter?.activeEntryId) assert.ok(out.encounter.entries.some((e) => e.id === out.encounter!.activeEntryId));
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("references to assets that did not come through are dropped, handouts with them", () => {
    const state = randomState(rng(5));
    state.monsters.mx = customMonster("mx", { defaultImage: imageRef("img-mx") });
    state.srdImages.bandit = srdImage("bandit", "img-bandit");
    const out = remapState(state, { assets: new Map() });
    // Shipped icons need no asset, so only they stay.
    for (const t of Object.values(out.tokens)) assert.ok(t.image === undefined || "icon" in t.image);
    for (const t of Object.values(out.tokens)) assert.ok(t.altImages === undefined || t.altImages.every((image) => "icon" in image), "a list left with nothing goes");
    // A monster keeps its stat block without the image, and an SRD monster's choice goes with its image.
    assert.equal(Object.keys(out.monsters).length, Object.keys(state.monsters).length);
    for (const m of Object.values(out.monsters)) assert.equal(m.defaultImage, undefined);
    assert.deepEqual(out.srdImages, {});
    for (const s of Object.values(out.scenes)) assert.equal(s.map, undefined);
    assert.equal(Object.keys(out.handouts).length, 0);
    for (const e of out.log) assert.notEqual(e.data?.type, "handout");
  });

  test("the legendary actions a turn reset stay in the history, so Previous still gives them back", () => {
    let state = room();
    state.tokens.gob1 = token("gob1", { actor: { inline: actor({ legendary: { actionsMax: 3, actionsUsed: 2, resistMax: 3, resistUsed: 1 } }) } });
    state.tokens.pc1 = token("pc1", { kind: "pc", name: "Pip" });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob1", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, undefined, 2);
    state = apply(state, { t: "encounter.next" }, undefined, 3);
    const out = remapState(state, { assets: new Map() });
    const goblin = Object.values(out.tokens).find((t) => t.name === "Goblin")!;
    assert.deepEqual(out.encounterHistory.at(-1)!.legendary, { holderId: goblin.id, actionsUsed: 2 });
    const back = apply(out, { t: "encounter.prev" }, undefined, 4);
    const restored = back.tokens[goblin.id]!.actor;
    assert.equal("inline" in restored ? restored.inline.legendary?.actionsUsed : undefined, 2);
  });

  test("where a turn began and the tokens kept rulers stand on follow their new ids", () => {
    let state = room();
    state.tokens.pc1 = token("pc1", { kind: "pc", name: "Pip", x: 2, y: 3 });
    state.tokens.gob = token("gob", { x: 6, y: 3 });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }] });
    state = apply(state, { t: "encounter.next" }, undefined, 2);
    state = apply(state, { t: "token.move", tokenId: "pc1", x: 4, y: 3 }, undefined, 3);
    assert.ok(state.tokens.pc1!.path);
    state.drawings.k1 = drawing("k1", { kind: "ruler", points: [2.5, 3.5, 6.5, 3.5], anchors: ["pc1", "gob"] });
    state.drawings.k2 = drawing("k2", { kind: "ruler", points: [2.5, 3.5, 9.5, 3.5], anchors: [null, "no-such-token"] });
    const out = remapState(state, { assets: new Map() });
    const pip = Object.values(out.tokens).find((t) => t.name === "Pip")!;
    const goblin = Object.values(out.tokens).find((t) => t.name === "Goblin")!;
    assert.deepEqual(out.encounter!.turnStart, { entryId: out.encounter!.activeEntryId, tokenId: pip.id, sceneId: pip.sceneId, x: 2, y: 3, elevation: 0, seen: true });
    assert.equal(state.encounter!.startSeq, 1);
    assert.equal("startSeq" in out.encounter!, false, "nor does the seq that started the fight");
    // The seq that names a turn counts the old room's ops, and the new room counts again from the start.
    assert.equal(pip.path, undefined, "the path of the turn stays behind with the seq naming the turn");
    const kept = Object.values(out.drawings);
    assert.equal(kept.length, 1, "a ruler on a token that did not come through goes with it");
    assert.deepEqual(kept[0]!.anchors, [pip.id, goblin.id]);
  });

  test("the record of the running turn's reminders stays out of the export, and a file that carries it imports without it", () => {
    let state = room();
    state.tokens.gob = token("gob", { x: 12, y: 5 });
    state.templates.sg = template("sg", { shape: "sphere", size: 10, origin: { x: 6.5, y: 5.5, z: 0 }, ownerId: "dm1", triggers: ["enter"] });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-gob", entries: [entry("e-gob", { tokenId: "gob", value: 15 })] };
    state = apply(state, { t: "token.move", tokenId: "gob", x: 6, y: 5 }, DM, 2);
    assert.deepEqual(state.reminded, { shared: { sg: { gob: 1 } } });
    assert.equal("reminded" in exportableState(state, DM), false);
    const parsed = parseRoomState(JSON.parse(JSON.stringify({ ...exportableState(state, DM), reminded: state.reminded })));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.equal("reminded" in remapState(parsed.state, { assets: new Map() }), false);
  });

  test("a take-back line names the row it resumed by its new id", () => {
    let state = room();
    state.tokens.a = token("a", { name: "A" });
    state.tokens.b = token("b", { name: "B", x: 3 });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "a", value: 20 }, { id: "n2", tokenId: "b", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, undefined, 2);
    state = apply(state, { t: "encounter.next" }, undefined, 3);
    state = apply(state, { t: "encounter.prev" }, undefined, 4);
    const out = remapState(state, { assets: new Map() });
    const back = out.log.find((e) => e.data?.type === "turn" && e.data.back)?.data;
    assert.ok(back?.type === "turn");
    assert.equal(back.to, out.encounter!.activeEntryId);
    assert.notEqual(back.to, "n1");
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(out))).ok);
  });

  test("the players chosen to move any token follow their new ids, and only members of the room stay chosen", () => {
    const state = room();
    state.meta.settings.playersMoveAny = ["p2", "gone"];
    const out = remapState(state, { assets: new Map(), memberIds: new Map([["p2", "new-p2"]]), newId: () => "x" });
    assert.deepEqual(out.meta.settings.playersMoveAny, ["new-p2"]);
    state.meta.settings.playersMoveAny = "all";
    assert.equal(remapState(state, { assets: new Map() }).meta.settings.playersMoveAny, "all");
  });

  test("a preset member map is honored", () => {
    const state = randomState(rng(2));
    const memberIds = new Map(Object.keys(state.members).map((id) => [id, `member-${id}`]));
    const out = remapState(state, { assets: new Map(), memberIds });
    assert.deepEqual(Object.keys(out.members).sort(), [...memberIds.values()].sort());
    for (const d of Object.values(out.drawings)) assert.match(d.ownerId, /^member-/);
  });

  test("wave 3: stamps and lights get new ids, free walls keep theirs, and phases, thumbnails and stamps follow their images or go", () => {
    const state = room();
    const day = { id: "p1", name: "Day", assetId: "day", widthPx: 1000, heightPx: 500 };
    const night = { id: "p2", name: "Night", assetId: "night", widthPx: 2000, heightPx: 1000 };
    const grid = { refWidthPx: 1000, refHeightPx: 500, cellPx: 50, originPx: { x: 10, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1!, thumb: "thumb1", autoWalls: "off", folder: "Act 1", map: { assetId: "day", widthPx: 1000, heightPx: 500, cellPx: 50, originPx: { x: 10, y: 0 } }, phases: [day, night], phaseId: "p1", phaseGrid: grid };
    state.scenes.s2 = { ...state.scenes.s2!, thumb: "lost-thumb", map: { assetId: "lost", widthPx: 1000, heightPx: 500, cellPx: 50, originPx: { x: 10, y: 0 } }, phases: [{ ...day, assetId: "lost" }, night], phaseId: "p1", phaseGrid: grid };
    const walls = [{ id: "abcdefabcdef", a: [1, 1] as [number, number], b: [2, 2] as [number, number], f: { kind: "door" as const, state: "locked" as const, secret: true, discovered: false } }];
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls };
    const stamp = { rev: 0, sceneId: "s1", x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const };
    state.stamps.st1 = { ...stamp, id: "st1", art: { key: "oak-tree" } };
    state.stamps.st2 = { ...stamp, id: "st2", art: { assetId: "chair" } };
    state.stamps.st3 = { ...stamp, id: "st3", art: { assetId: "lost-chair" } };
    state.lights.l1 = { id: "l1", rev: 0, sceneId: "s2", x: 1, y: 1, bright: 20, dim: 20, on: true, walls: true };
    const assets = kinds({ day: ["day2", "map"], night: ["night2", "map"], thumb1: ["thumb2", "thumb"], chair: ["chair2", "token"] });
    let n = 0;
    const out = remapState(state, { assets, newId: () => `n${n++}` });
    const [s1, s2] = Object.values(out.scenes).sort((a, b) => a.order - b.order);
    assert.equal(s1!.thumb, "thumb2");
    assert.equal(s1!.autoWalls, "off");
    assert.equal(s1!.folder, "Act 1");
    assert.deepEqual(s1!.phases, [{ ...day, assetId: "day2" }, { ...night, assetId: "night2" }]);
    assert.equal(s1!.map!.assetId, "day2");
    // The active phase's image did not come through, so the scene switched to the first one left, on the same grid.
    assert.equal("thumb" in s2!, false);
    assert.deepEqual(s2!.phases, [{ ...night, assetId: "night2" }]);
    assert.equal(s2!.phaseId, "p2");
    assert.deepEqual(s2!.map, { assetId: "night2", widthPx: 2000, heightPx: 1000, cellPx: 100, originPx: { x: 20, y: 0 } });
    assert.deepEqual(out.buildChunks[`${s1!.id}:0,0`]!.walls, walls);
    const stamps = Object.values(out.stamps);
    assert.deepEqual(stamps.map((st) => st.art).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ assetId: "chair2" }, { key: "oak-tree" }]);
    for (const st of stamps) {
      assert.equal(st.sceneId, s1!.id);
      assert.ok(!["st1", "st2", "st3"].includes(st.id));
    }
    assert.deepEqual(Object.values(out.lights).map((l) => [l.sceneId, l.id === "l1"]), [[s2!.id, false]]);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("wave 4: the explored layer follows its scene, and squeezes, lights, party members, heights, stairs, vision, phase light and teleport lines keep", () => {
    const state = room();
    const bits = "A".repeat(683) + "=";
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dim" }, blockMovement: true, fogEnabled: true };
    state.exploredTiles["s1:1,0"] = { sceneId: "s1", tx: 1, ty: 0, rev: 7, bits };
    state.exploredTiles["gone:0,0"] = { sceneId: "gone", tx: 0, ty: 0, rev: 1, bits };
    const heights = "B".repeat(683) + "=";
    const up = "n".repeat(256);
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights, up };
    state.tokens.ogre = token("ogre", { size: "large", x: 2.5, y: 3, squeeze: true, light: { bright: 20, dim: 20 }, partyVision: true });
    state.log.push({ id: "3:0", at: AT, kind: "event", data: { type: "teleport", tokenId: "ogre", past: "ledge" } });
    let n = 0;
    const out = remapState(state, { assets: new Map(), newId: () => `n${n++}` });
    const s1 = Object.values(out.scenes).find((sc) => sc.order === 0)!;
    assert.deepEqual(out.exploredTiles, { [`${s1.id}:1,0`]: { sceneId: s1.id, tx: 1, ty: 0, rev: 7, bits } });
    assert.deepEqual([s1.vision, s1.blockMovement], [{ on: true, light: "dim" }, true]);
    assert.deepEqual(out.buildChunks[`${s1.id}:0,0`], { sceneId: s1.id, cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, heights, up });
    const ogre = Object.values(out.tokens)[0]!;
    assert.deepEqual([ogre.squeeze, ogre.light, ogre.partyVision], [true, { bright: 20, dim: 20 }, true]);
    assert.deepEqual(out.log[0]!.data, { type: "teleport", tokenId: ogre.id, past: "ledge" });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("an image is kept only where its kind belongs, so a hand-made file cannot show players a thumbnail or another phase", () => {
    const state = room();
    const day = { id: "p1", name: "Day", assetId: "day", widthPx: 100, heightPx: 100 };
    const night = { id: "p2", name: "Night", assetId: "night", widthPx: 100, heightPx: 100 };
    const map = { assetId: "day", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1!, thumb: "thumb", map, phases: [day, night], phaseId: "p1", phaseGrid: { refWidthPx: 100, refHeightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } } };
    // Each kind where another belongs: a map on a token, a thumbnail on the other scene's map, a token image as its thumbnail.
    state.scenes.s2 = { ...state.scenes.s2!, thumb: "art", map: { ...map, assetId: "thumb" } };
    const stamp = { rev: 0, sceneId: "s1", x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const };
    state.stamps.onThumb = { ...stamp, id: "onThumb", art: { assetId: "thumb" } };
    state.stamps.onPhase = { ...stamp, id: "onPhase", art: { assetId: "night" } };
    state.stamps.onArt = { ...stamp, id: "onArt", art: { assetId: "art" } };
    state.tokens.t1 = token("t1", { image: imageRef("night"), altImages: [imageRef("thumb"), imageRef("art")] });
    state.tokens.t2 = token("t2", { image: imageRef("art") });
    state.characters.c1 = { id: "c1", rev: 0, ownerIds: [], name: "Ayla", size: "medium", actor: actor(), defaultImage: imageRef("thumb") };
    state.monsters.mx = customMonster("mx", { defaultImage: imageRef("night") });
    state.srdImages.bandit = srdImage("bandit", "thumb");
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "night", title: "Letter", to: "all", shownAt: AT };
    const assets = kinds({ day: ["day2", "map"], night: ["night2", "map"], thumb: ["thumb2", "thumb"], art: ["art2", "token"] });
    const out = remapState(state, { assets });
    const [s1, s2] = Object.values(out.scenes).sort((a, b) => a.order - b.order);
    assert.equal(s1!.thumb, "thumb2");
    assert.deepEqual(s1!.phases?.map((p) => p.assetId), ["day2", "night2"]);
    assert.equal(s1!.map?.assetId, "day2");
    assert.equal("thumb" in s2!, false, "a token image is no thumbnail");
    assert.equal("map" in s2!, false, "a thumbnail is no map");
    assert.deepEqual(Object.values(out.stamps).map((st) => st.art), [{ assetId: "art2" }]);
    const tokens = Object.values(out.tokens).sort((a, b) => a.name.localeCompare(b.name));
    for (const t of tokens) {
      if (imageAssetId(t.image) === "art2") continue;
      assert.equal(t.image, undefined, "a phase image is no token image");
      assert.deepEqual(t.altImages, [imageRef("art2")], "a thumbnail is no token image");
    }
    assert.equal(Object.values(out.characters)[0]!.defaultImage, undefined);
    assert.equal(Object.values(out.monsters)[0]!.defaultImage, undefined);
    assert.deepEqual(out.srdImages, {});
    assert.deepEqual(out.handouts, {}, "a map is no handout");
    // The thumbnail and the phase not showing stay the DM's: no player's visible set holds them, which is all the asset route checks.
    out.meta.playerSceneId = s1!.id;
    const visible = visibleAssetIds(out, P1, { sceneId: s1!.id });
    assert.ok(visible.has("day2") && visible.has("art2"));
    assert.ok(!visible.has("thumb2") && !visible.has("night2"), [...visible].join(", "));
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("a scene whose showing phase's image went switches to the first phase left with that phase's light", () => {
    const state = room();
    const grid = { refWidthPx: 1000, refHeightPx: 500, cellPx: 50, originPx: { x: 0, y: 0 } };
    const day = { id: "p1", name: "Day", assetId: "day", widthPx: 1000, heightPx: 500, light: "bright" as const };
    const night = { id: "p2", name: "Night", assetId: "lost-night", widthPx: 1000, heightPx: 500, light: "dark" as const };
    const map = { assetId: "lost-night", widthPx: 1000, heightPx: 500, cellPx: 50, originPx: { x: 0, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1!, map, phases: [day, night], phaseId: "p2", phaseGrid: grid, vision: { on: true, light: "dark" } };
    state.scenes.s2 = { ...state.scenes.s2!, map: { ...map, assetId: "day" }, phases: [day, night], phaseId: "p1", phaseGrid: grid, vision: { on: true, light: "dim" } };
    let n = 0;
    const out = remapState(state, { assets: kinds({ day: ["day2", "map"] }), newId: () => `n${n++}` });
    const [s1, s2] = Object.values(out.scenes).sort((a, b) => a.order - b.order);
    assert.equal(s1!.phaseId, "p1");
    assert.deepEqual(s1!.vision, { on: true, light: "bright" });
    assert.deepEqual(s2!.vision, { on: true, light: "dim" }, "a scene still showing its phase keeps its level");
  });

  test("a scene whose every phase image went has no phases and no map", () => {
    const state = room();
    const grid = { refWidthPx: 100, refHeightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1!, map: { assetId: "gone", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } }, phases: [{ id: "p1", name: "Day", assetId: "gone", widthPx: 100, heightPx: 100 }], phaseId: "p1", phaseGrid: grid };
    const out = remapState(state, { assets: new Map() });
    const s1 = Object.values(out.scenes).find((s) => s.name === "s1")!;
    for (const field of ["map", "phases", "phaseId", "phaseGrid"]) assert.equal(field in s1, false, field);
  });
});

describe("remapState, wave 5 (docs/design-v1-dm-tools.md 2.5)", () => {
  function wave5() {
    const state = room();
    state.monsters.m1 = customMonster("m1");
    state.characters.c1 = character("c1", { ownerIds: ["p1"], defaultImage: { icon: "lorc/wolf-head", color: "#336699" }, actor: actor({ monsterId: "gone-monster" }) });
    state.tokens.t1 = token("t1", { ownerIds: ["p1"], image: { icon: "delapouite/goblin-head", color: "#000000" }, actor: { inline: actor({ monsterId: "m1" }) } });
    state.journal = {
      all: { id: "all", rev: 3, title: "Shared", access: "all", blocks: [{ id: "abcdefghijkl", text: "Hush", secret: { revealed: true } }] },
      mine: { id: "mine", rev: 0, title: "Thorn's", access: { member: "p1" }, blocks: [] },
      ghost: { id: "ghost", rev: 0, title: "Gone reader's", access: { member: "nobody" }, blocks: [] },
    };
    state.pins = {
      a: { id: "a", rev: 0, sceneId: "s1", x: 1, y: 1, color: "#ff8800", visibility: "all", pageId: "all" },
      b: { id: "b", rev: 0, sceneId: "s2", x: 1, y: 1, color: "#ff8800", visibility: "all", pageId: "missing" },
      c: { id: "c", rev: 0, sceneId: "nowhere", x: 1, y: 1, color: "#ff8800", visibility: "all" },
    };
    state.rolls.r1 = { id: "r1", rev: 1, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, at: AT, targets: [{ characterId: "c1", total: 12, by: "p1" }] };
    state.log.push({ id: "1:0", at: AT, kind: "event", data: { type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c1", total: 12 } });
    state.meta.settings = { ...state.meta.settings, playersDraw: ["p1", "nobody"] };
    return state;
  }

  test("pages, pins and links get new ids, a player's access and who may draw follow the member, and open requests stay behind", () => {
    const state = wave5();
    const out = remapState(state, { assets: new Map() });
    const p1 = out.members[Object.keys(out.members).find((id) => out.members[id]!.name === "p1")!]!;
    const pages = Object.values(out.journal);
    assert.equal(pages.length, 3);
    for (const page of pages) assert.ok(!(page.id in state.journal), `page ${page.id} kept its old id`);
    const byTitle = (title: string) => pages.find((p) => p.title === title)!;
    assert.deepEqual(byTitle("Shared").blocks, state.journal.all!.blocks);
    assert.deepEqual(byTitle("Thorn's").access, { member: p1.id });
    assert.equal(byTitle("Gone reader's").access, "dm", "a page whose reader did not come through is the DM's");
    const pins = Object.values(out.pins);
    assert.equal(pins.length, 2, "a pin of a scene that did not come through goes with it");
    const shared = pins.find((p) => p.visibility === "all")!;
    assert.equal(shared.pageId, byTitle("Shared").id);
    assert.ok(out.scenes[shared.sceneId]);
    const unlinked = pins.find((p) => p !== shared)!;
    assert.deepEqual([unlinked.pageId, unlinked.visibility], [undefined, "dm"], "a pin whose page did not come through is made the DM's");
    assert.deepEqual(out.rolls, {});
    assert.deepEqual(out.meta.settings.playersDraw, [p1.id]);
    // Icons keep their keys, a link to a room monster follows its new id, and one to a monster that is gone goes.
    const token = Object.values(out.tokens)[0]!;
    assert.deepEqual(token.image, state.tokens.t1!.image);
    assert.equal((token.actor as { inline: { monsterId?: string } }).inline.monsterId, Object.keys(out.monsters)[0]);
    const character = Object.values(out.characters)[0]!;
    assert.deepEqual(character.defaultImage, state.characters.c1!.defaultImage);
    assert.equal("monsterId" in character.actor, false);
    // A roll line is history, and follows its creature to its new id.
    const line = out.log.find((e) => e.data?.type === "roll")?.data as { characterId?: string } | undefined;
    assert.equal(line?.characterId, character.id);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("old line ids are numbered in the old room's order, whichever trap holds them, so the newest occurrence stays the newest, and each ring counts on its own", () => {
    const state = room();
    const due = (id: string) => ({ id, at: AT, how: "enter" as const, by: [], hits: [] });
    // The trap listed first holds the newer occurrence.
    state.traps.a = { ...trap("a"), name: "a", rig: { ...trap("a").rig!, due: [due("12:0")] } };
    state.traps.b = { ...trap("b"), name: "b", rig: { ...trap("b").rig!, due: [due("4:0"), due("10:900000")] } };
    state.trapSeen = [{ id: "12:1", at: AT, kind: "event", data: { type: "trapSeen", by: [], message: "Click." } }];
    const out = remapState(state, { assets: new Map() });
    const all = Object.values(out.traps).flatMap((t) => (t.rig?.due ?? []).map((d) => ({ name: t.name, id: d.id })));
    const sorted = [...all].sort((x, y) => compareLogIds(x.id, y.id)).map((d) => d.name);
    assert.deepEqual(sorted, ["b", "b", "a"], "4:0, then 10:900000, then 12:0");
    // The players' line counts after the log and the DM's from DM_LINE_BASE, as a live room numbers them, so 12:1 comes before 12:0 now.
    assert.equal(out.trapSeen[0]!.id, `0:${out.log.length}`, "12:1 is the players' first line");
    assert.equal(all.find((d) => d.name === "a")!.id, `0:${DM_LINE_BASE + 2}`, "12:0 is the DM's third");
    assert.ok(compareLogIds(out.trapSeen[0]!.id, all.find((d) => d.name === "a")!.id) < 0);
  });
});

describe("companions in an import (docs/design-v1-combat-flow.md 4.7)", () => {
  function party() {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), gone: character("gone") } });
    state.meta.settings = { ...state.meta.settings, healRevives: false };
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" } });
    state.tokens.ws = token("ws", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.tokens.own = token("own", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "own" } });
    state.tokens.orphan = token("orphan", { kind: "npc", companion: { of: "missing", turn: "shared" } });
    state.log.push({ id: "4:0", at: AT, kind: "event", data: { type: "companion", tokenId: "ws", characterId: "bree", memberId: "p1", name: "Wildfire Spirit" } });
    // A hand-made fight: the shared spirit holds a row, which the rules never allow, with an effect counting it.
    state.tokens.gob = token("gob", { actor: { inline: actor({ effects: [{ id: "b", key: "blinded", duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-ws" } } }] }) } });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-bree", { tokenId: "bt", value: 20 }), entry("e-ws", { tokenId: "ws", value: 15, tieOrder: 1 }), entry("e-gob", { tokenId: "gob", value: 10, tieOrder: 2 })] };
    state.encounterHistory = [{ encounter: structuredClone(state.encounter), effects: {}, revealed: [], companionReactions: ["ws", "nowhere"], at: AT }];
    return state;
  }

  test("companion.of follows its character, goes with a character that did not come through, and the log line's ids follow", () => {
    let n = 0;
    const out = remapState(party(), { assets: new Map(), newId: () => `n${n++}` });
    const bree = Object.values(out.characters).find((c) => c.name === "Bree")!;
    const tokens = Object.values(out.tokens);
    const spirit = tokens.find((t) => t.companion?.turn === "shared")!;
    assert.equal(spirit.companion!.of, bree.id);
    assert.equal(spirit.companion!.reactionUsed, true, "a spent Reaction comes with its token");
    assert.equal(tokens.filter((t) => t.companion).length, 2, "the orphan is a plain token now");
    const line = out.log.find((e) => e.data?.type === "companion")!.data!;
    assert.deepEqual(line, { type: "companion", tokenId: spirit.id, characterId: bree.id, memberId: out.characters[bree.id]!.ownerIds[0], name: "Wildfire Spirit" });
    assert.equal(out.meta.settings.healRevives, false);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("companion blocks get new ids and follow their character, a block whose character did not come through goes, and a picture follows its image or goes (docs/design-v1-companion-stat-blocks.md 3.6)", () => {
    const state = party();
    state.companionBlocks.moth = companionBlock("moth", "bree", { defaultImage: imageRef("moth-art") });
    state.companionBlocks.owl = companionBlock("owl", "bree", { name: "Owl", fromSrd: "owl", defaultImage: imageRef("lost-art") });
    state.companionBlocks.stray = companionBlock("stray", "missing");
    let n = 0;
    const out = remapState(state, { assets: kinds({ "moth-art": ["moth-art2", "token"], "lost-art": ["lost-art2", "map"] }), newId: () => `n${n++}` });
    const bree = Object.values(out.characters).find((c) => c.name === "Bree")!;
    const blocks = Object.values(out.companionBlocks);
    assert.equal(blocks.length, 2, "the stray block's character is not in the file");
    for (const b of blocks) {
      assert.equal(out.companionBlocks[b.id], b);
      assert.ok(!["moth", "owl"].includes(b.id), `new id for ${b.name}`);
      assert.equal(b.characterId, bree.id);
    }
    const moth = blocks.find((b) => b.name === "Moth Spirit")!;
    const owl = blocks.find((b) => b.name === "Owl")!;
    assert.deepEqual(moth.defaultImage, imageRef("moth-art2"));
    assert.equal("defaultImage" in owl, false, "an image that came through as another kind is dropped");
    assert.equal(owl.fromSrd, "owl");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("a companion's block link follows its block's new id, goes with a block that did not come through, and comes within the link rules (docs/design-v1-companion-stat-blocks.md 3.6)", () => {
    const state = party();
    state.characters.cy = character("cy", { name: "Cy" });
    state.companionBlocks.moth = companionBlock("moth", "bree");
    state.companionBlocks.wolf = companionBlock("wolf", "cy", { name: "Wolf" });
    const rename = (id: string, name: string, inline: Parameters<typeof actor>[0]) => {
      state.tokens[id] = { ...state.tokens[id]!, name, actor: { inline: actor(inline) } };
    };
    rename("ws", "Both links", { blockId: "moth", srdId: "owl" });
    rename("own", "Cy's block", { blockId: "wolf" });
    rename("gob", "Not a companion", { blockId: "moth" });
    state.tokens.lost = token("lost", { kind: "npc", name: "Deleted block", ownerIds: ["p1"], companion: { of: "bree", turn: "none" }, actor: { inline: actor({ blockId: "deleted-before-the-backup" }) } });
    let n = 0;
    const out = remapState(state, { assets: new Map(), newId: () => `n${n++}` });
    const bree = Object.values(out.characters).find((c) => c.name === "Bree")!;
    const moth = Object.values(out.companionBlocks).find((b) => b.characterId === bree.id)!;
    const inlineOf = (name: string) => {
      const t = Object.values(out.tokens).find((x) => x.name === name)!;
      assert.ok("inline" in t.actor, name);
      return t.actor.inline;
    };
    assert.deepEqual([inlineOf("Both links").blockId, inlineOf("Both links").srdId], [moth.id, undefined], "blockId alone, under its new id");
    assert.equal(inlineOf("Cy's block").blockId, undefined, "a block of another character");
    assert.equal(inlineOf("Not a companion").blockId, undefined, "not a companion");
    assert.equal(inlineOf("Deleted block").blockId, undefined, "a block the file does not hold");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("the DM's line for a character a player deleted keeps its name and counts, and its member follows", () => {
    let n = 0;
    const state = party();
    state.log.push({ id: "5:0", at: AT, kind: "event", data: { type: "characterDeleted", characterId: "wren", memberId: "p1", name: "Wren", tokens: 2, companions: 1, rows: 1 } });
    const out = remapState(state, { assets: new Map(), newId: () => `n${n++}` });
    const bree = Object.values(out.characters).find((c) => c.name === "Bree")!;
    const line = out.log.find((e) => e.data?.type === "characterDeleted")!.data!;
    // The character is gone, so its id has nothing to follow and stays, as other lines' ids of things gone do.
    assert.deepEqual(line, { type: "characterDeleted", characterId: "wren", memberId: bree.ownerIds[0], name: "Wren", tokens: 2, companions: 1, rows: 1 });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("the rules run over the import: the shared spirit's rows leave the fight and its history, saved effects rebound, and saved Reactions are filtered and mapped", () => {
    let n = 0;
    const out = remapState(party(), { assets: new Map(), newId: () => `n${n++}` });
    const spirit = Object.values(out.tokens).find((t) => t.companion?.turn === "shared")!;
    const breeToken = Object.values(out.tokens).find((t) => t.kind === "pc")!;
    const breeRow = out.encounter!.entries.find((e) => e.tokenId === breeToken.id)!;
    assert.equal(out.encounter!.entries.some((e) => e.tokenId === spirit.id), false);
    assert.equal(out.encounterHistory[0]!.encounter.entries.some((e) => e.tokenId === spirit.id), false);
    const gob = Object.values(out.tokens).find((t) => "inline" in t.actor && t.actor.inline.effects.length > 0)!;
    assert.ok("inline" in gob.actor);
    assert.deepEqual(gob.actor.inline.effects[0]!.duration!.anchor, { entryId: breeRow.id });
    assert.deepEqual(out.encounterHistory[0]!.companionReactions, [spirit.id]);
    // Previous after the import sets the flag again on the mapped token.
    const cleared = { ...out, tokens: { ...out.tokens, [spirit.id]: { ...spirit, companion: { of: spirit.companion!.of, turn: "shared" as const } } } };
    const dm = Object.keys(out.members)[0]!;
    cleared.members[dm] = { ...cleared.members[dm]!, kind: "dm" };
    const back = apply(cleared, { t: "encounter.prev" }, { ...DM, memberId: dm });
    assert.equal(back.tokens[spirit.id]!.companion!.reactionUsed, true);
  });
});


describe("remapState, pdf handouts (docs/design-v1-pdf-handouts.md 3.6)", () => {
  const page = (assetId: string, width = 1584, height = 2048) => ({ assetId, width, height });

  test("a handout's pages follow their new ids in order, a page that did not come through or came as another kind is dropped, and its image is its first page left", () => {
    const state = room();
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "p1", pages: [page("p1"), page("p2", 2048, 1584), page("p3"), page("p2", 2048, 1584), page("p4")], title: "Strange letter", to: "all", shownAt: AT };
    state.log = [{ id: "1:0", at: AT, kind: "event", data: { type: "handout", handoutId: "h1" } }];
    const assets = kinds({ p2: ["n2", "handout"], p3: ["n3", "map"], p4: ["n4", "handout"] });
    const out = remapState(state, { assets });
    const [h] = Object.values(out.handouts);
    assert.ok(h);
    assert.notEqual(h.id, "h1");
    assert.equal(h.assetId, "n2");
    assert.deepEqual(h.pages, [page("n2", 2048, 1584), page("n2", 2048, 1584), page("n4")]);
    assert.deepEqual(out.log.map((e) => e.data), [{ type: "handout", handoutId: h.id }]);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("a handout left with no page is dropped with its log line, and one image keeps today's shape", () => {
    const state = room();
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "p1", pages: [page("p1"), page("p2")], title: "Strange letter", to: "all", shownAt: AT };
    state.handouts.h2 = { id: "h2", rev: 0, assetId: "img", title: "Letter", to: "all", shownAt: AT };
    state.log = [{ id: "1:0", at: AT, kind: "event", data: { type: "handout", handoutId: "h1" } }];
    const out = remapState(state, { assets: kinds({ p1: ["n1", "token"], img: ["n9", "handout"] }) });
    assert.deepEqual(Object.values(out.handouts).map(({ id: _id, ...h }) => h), [{ rev: 0, assetId: "n9", title: "Letter", to: "all", shownAt: AT }]);
    assert.deepEqual(out.log, []);
  });

  test("a document gets a new id and its pages follow in order, the rest dropped, and one left with no page is dropped", () => {
    const state = room();
    state.handoutDocs.d1 = { id: "d1", rev: 2, title: "Strange letter", pages: [page("p1"), page("p2"), page("p3"), page("p1")], createdAt: AT };
    state.handoutDocs.d2 = { id: "d2", rev: 0, title: "Gone", pages: [page("p3")], createdAt: AT };
    const out = remapState(state, { assets: kinds({ p1: ["n1", "handout"], p2: ["n2", "token"], p3: ["n3", "map"] }) });
    const docs = Object.values(out.handoutDocs);
    assert.equal(docs.length, 1);
    assert.notEqual(docs[0]!.id, "d1");
    assert.deepEqual(docs[0], { id: docs[0]!.id, rev: 2, title: "Strange letter", pages: [page("n1"), page("n1")], createdAt: AT });
    assert.deepEqual(out.handoutDocs[docs[0]!.id], docs[0]);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });
});

describe("remapState, a player's asks for saves (docs/design-v1-player-save-spell.md 5.7)", () => {
  const asks = () =>
    castTable({
      casts: { k1: castAsk("k1"), k2: castAsk("k2", { area: undefined, targets: ["g1"], spell: "Hold Person" }) },
      log: [
        { id: "40:0", at: AT, kind: "event", data: { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3 } },
        { id: "41:0", at: AT, kind: "event", data: { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3, end: "done" } },
      ],
    });

  test("an import drops the open asks, as it drops open requests, and keeps their lines with the caster's new id", () => {
    const out = remapState(asks(), { assets: new Map() });
    assert.deepEqual(out.casts, {});
    const lines = out.log.filter((e) => e.data?.type === "cast");
    assert.equal(lines.length, 2);
    const thorn = Object.values(out.tokens).find((t) => t.name === "Thorn")!;
    for (const e of lines) assert.equal(e.data?.type === "cast" && e.data.tokenId, thorn.id);
    assert.notEqual(thorn.id, "thorn");
  });
});

describe("attached tokens in an import (docs/design-v1-attach.md 5.2)", () => {
  test("a link follows its holder's new id, goes when the holder did not come through, and the turn's mounts stay behind", () => {
    let state = room();
    state.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4 });
    state.tokens.bree = token("bree", { name: "Bree", kind: "pc", x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
    state.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 9, y: 9, attached: { to: "nowhere", kind: "carry" } });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "bree", value: 20 }] });
    state = apply(state, { t: "encounter.next" }, undefined, 2);
    assert.deepEqual(state.encounter!.turnStart!.mounts, ["horse"]);
    const out = remapState(state, { assets: new Map() });
    const tokens = Object.values(out.tokens);
    const horse = tokens.find((t) => t.name === "Warhorse")!;
    assert.deepEqual(tokens.find((t) => t.name === "Bree")!.attached, { to: horse.id, kind: "ride", steer: true });
    assert.equal(tokens.find((t) => t.name === "Torch")!.attached, undefined);
    assert.equal(out.encounter!.turnStart!.mounts, undefined);
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });
});

describe("traps in an import (docs/design-v1-traps.md 6.8)", () => {
  test("traps get new ids and follow their scene, actions follow the lights, stamps and creatures that came through, and occurrences and lines follow their creatures", () => {
    const state = room();
    state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc" });
    state.lights.brazier = { id: "brazier", rev: 0, sceneId: "s1", x: 2, y: 2, bright: 20, dim: 20, on: true, walls: false, label: "Light-Brazier" };
    const t = trap("plate");
    t.rig = {
      ...t.rig!,
      actions: [{ light: "brazier", on: false }, { show: { tokenId: "thorn" } }, { show: { tokenId: "nobody" } }, { door: { edge: "5,5,n" }, state: "locked" }],
      noticedBy: "thorn",
      due: [{ id: "7:0", at: AT, how: "enter", by: ["thorn", "nobody"], hits: ["thorn"] }],
    };
    state.traps.plate = t;
    state.trapLog = [{ id: "7:0", at: AT, kind: "event", data: { type: "trap", trapId: "plate", sceneId: "s1", name: "Hidden Pit", how: "enter", by: ["thorn", "nobody"], hits: 1, did: [], seen: [0] } }];
    state.trapSeen = [{ id: "7:1", at: AT, kind: "event", data: { type: "trapSeen", by: ["thorn"], message: "Click." } }];
    const out = remapState(state, { assets: new Map() });
    const traps = Object.values(out.traps);
    assert.equal(traps.length, 1);
    const copy = traps[0]!;
    const thorn = Object.values(out.tokens).find((x) => x.name === "Thorn")!;
    const light = Object.values(out.lights)[0]!;
    const sceneId = Object.values(out.scenes).find((s) => s.name === "s1")!.id;
    assert.notEqual(copy.id, "plate");
    assert.equal(copy.sceneId, sceneId);
    assert.deepEqual(copy.rig!.actions, [{ light: light.id, on: false }, { show: { tokenId: thorn.id } }, { door: { edge: "5,5,n" }, state: "locked" }]);
    assert.equal(copy.rig!.noticedBy, thorn.id);
    const due = copy.rig!.due![0]!;
    assert.deepEqual([due.by, due.more, due.hits], [[thorn.id], 1, [thorn.id]]);
    const line = out.trapLog[0]!;
    assert.equal(due.id, line.id, "the occurrence still names its line");
    assert.deepEqual(line.data, { type: "trap", trapId: copy.id, sceneId, name: "Hidden Pit", how: "enter", by: [thorn.id], more: 1, hits: 1, did: [], seen: [0] });
    assert.deepEqual(out.trapSeen[0]!.data, { type: "trapSeen", by: [thorn.id], message: "Click." });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("the players' trap lines are numbered one after another, and the DM's lines and occurrences on their own, so no id players get counts a line only the DM holds", () => {
    const state = room();
    state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc" });
    const t = trap("plate");
    t.rig = { ...t.rig!, due: [{ id: "9:900000", at: AT, how: "enter", by: ["thorn"], hits: ["thorn"], hidden: true }] };
    state.traps.plate = t;
    const dmLine = (id: string, hidden = false) => ({ id, at: AT, kind: "event" as const, data: { type: "trap" as const, trapId: "plate", sceneId: "s1", name: "Plate", how: "enter" as const, by: ["thorn"], hits: 1, did: [], ...(hidden ? { hidden: true as const } : {}) } });
    const seenLine = (id: string) => ({ id, at: AT, kind: "event" as const, data: { type: "trapSeen" as const, by: ["thorn"], message: "Click." } });
    // A springing players saw, a hidden one only the DM holds, then another they saw.
    state.trapLog = [dmLine("7:900000"), dmLine("9:900000", true), dmLine("11:900000")];
    state.trapSeen = [seenLine("7:0"), seenLine("11:0")];
    const out = remapState(state, { assets: new Map() });
    const n = out.log.length;
    assert.deepEqual(out.trapSeen.map((e) => e.id), [`0:${n}`, `0:${n + 1}`], "no gap where the hidden springing was");
    assert.deepEqual(out.trapLog.map((e) => e.id), ["0:900000", "0:900001", "0:900002"]);
    assert.equal(Object.values(out.traps)[0]!.rig!.due![0]!.id, "0:900001", "the occurrence still names its line");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });
});

describe("party lines in an import (shared/logRings.ts)", () => {
  test("each reader's copies count on in their own run, a copy whose reader did not come through goes, and the DM reads each line once", () => {
    const state = room();
    state.tokens.pet = token("pet", { visibility: "dm", ownerIds: ["p1"] });
    state.tokens.mount = token("mount", { visibility: "dm", ownerIds: ["p1", "p2"] });
    state.tokens.gob = token("gob", { visibility: "dm" });
    const hp = (id: string, tokenId: string, to?: string[], copyOf?: string) => ({ id, at: AT, kind: "event" as const, ...(to ? { to } : {}), ...(copyOf ? { copyOf } : {}), data: { type: "hp" as const, tokenId, change: "damage" as const, amount: 1 } });
    state.log = [
      { id: "1:0", at: AT, kind: "chat", from: "p1", text: "hi" },
      hp("2:802000", "pet", ["p1"], "2:900000"),
      hp("2:900000", "pet"),
      hp("3:802000", "mount", ["p1"], "3:900000"),
      hp("3:804000", "mount", ["p2"], "3:900000"),
      hp("3:900000", "mount"),
      // A line of a member who left before the export: their copy, and the DM's line.
      hp("4:806000", "gob", ["gone1"], "4:900000"),
      hp("4:900000", "gob"),
      // A copy whose DM line the file no longer holds.
      hp("5:802000", "pet", ["p1"], "5:900000"),
    ];
    const memberIds = new Map([["dm1", "m-dm"], ["p1", "m-p1"], ["p2", "m-p2"]]);
    const out = remapState(state, { assets: new Map(), memberIds });
    const ranks = rosterRanks(out.members);
    const run = (id: string) => partyIndex(ranks.get(id)!, 0);
    assert.deepEqual(out.log.map((e) => [e.id, e.to, e.copyOf]), [
      ["0:0", undefined, undefined],
      [`0:${run("m-p1")}`, ["m-p1"], `0:${DM_LINE_BASE}`],
      [`0:${run("m-p1") + 1}`, ["m-p1"], `0:${DM_LINE_BASE + 1}`],
      [`0:${run("m-p1") + 2}`, ["m-p1"], undefined],
      [`0:${run("m-p2")}`, ["m-p2"], `0:${DM_LINE_BASE + 1}`],
      [`0:${DM_LINE_BASE}`, undefined, undefined],
      [`0:${DM_LINE_BASE + 1}`, undefined, undefined],
      [`0:${DM_LINE_BASE + 2}`, undefined, undefined],
    ]);
    assert.deepEqual(eventLines(out.log).map((e) => e.id), ["0:0", `0:${run("m-p1") + 2}`, `0:${DM_LINE_BASE}`, `0:${DM_LINE_BASE + 1}`, `0:${DM_LINE_BASE + 2}`], "each copy names its DM line's new id, and one whose line did not come stands for it");
    const p2 = projectState(out, { memberId: "m-p2", role: "player" }, { sceneId: "s1" }).log;
    assert.deepEqual(p2.map((e) => [e.id, e.to, e.copyOf]), [["0:0", undefined, undefined], [`0:${run("m-p2")}`, ["m-p2"], undefined]]);
    const dm = projectState(out, { memberId: "m-dm", role: "dm" }, { sceneId: "s1" }).log;
    assert.deepEqual(dm.map((e) => e.id), ["0:0", `0:${DM_LINE_BASE}`, `0:${DM_LINE_BASE + 1}`, `0:${DM_LINE_BASE + 2}`], "the DM reads each line once");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });

  test("a shared line's part readers follow their new ids, and those who did not come through go", () => {
    const state = room();
    state.log = [{ id: "1:0", at: AT, kind: "event", data: { type: "hp", tokenId: "t1", change: "damage", amount: 2, label: "Healthy" }, parts: { exact: ["p1", "gone1"], rolls: [null, ["p2"]] } }];
    state.tokens.t1 = token("t1", { ownerIds: ["p1"] });
    const out = remapState(state, { assets: new Map(), memberIds: new Map([["dm1", "m-dm"], ["p1", "m-p1"], ["p2", "m-p2"]]) });
    assert.deepEqual(out.log[0]!.parts, { exact: ["m-p1"], rolls: [null, ["m-p2"]] });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(out)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  });
});

describe("an imported log (importRoom)", () => {
  /** As importRoom keeps it: the log's rings in memory, and the whole log in the archive. */
  function imported(state: RoomState): { room: RoomState; archive: LogEntry[] } {
    const out = remapState(state, { assets: new Map(), memberIds: new Map([["dm1", "m-dm"], ["p1", "m-p1"], ["p2", "m-p2"]]) });
    return { room: { ...out, log: ringed(out.log, out.members) }, archive: out.log };
  }

  /** Every line a viewer may read is in their live log or on an archive page before its oldest line. */
  function reachable(room: RoomState, archive: readonly LogEntry[], memberId: string, role: "dm" | "player", name: string): void {
    const viewer = { memberId, role };
    const live = projectState(room, viewer, { sceneId: null }).log;
    const readable = projectArchivedLog(room, archive, viewer, { sceneId: null }).sort((a, b) => byId(a.id, b.id));
    const first = live[0]?.id;
    const pages = first === undefined ? readable : readable.filter((e) => byId(e.id, first) < 0);
    assert.deepEqual([...pages, ...live].map((e) => e.id), readable.map((e) => e.id), `${name}: ${memberId}`);
  }

  const teleport = (id: string): LogEntry => ({ id, at: AT, kind: "event", data: { type: "teleport", tokenId: "t1", past: "wall" } });
  const chat = (id: string): LogEntry => ({ id, at: AT, kind: "chat", from: "p1", text: id });

  test("an old room's 200 lines, half the DM's: the DM reaches every chat line, live or on Show older's pages", () => {
    const state = room();
    state.tokens.t1 = token("t1");
    state.log = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? chat(`${i + 1}:0`) : teleport(`${i + 1}:0`)));
    const { room: out, archive } = imported(state);
    assert.equal(archive.length, 200);
    reachable(out, archive, "m-dm", "dm", "old room");
    reachable(out, archive, "m-p1", "player", "old room");
  });

  test("100 of the DM's lines then 10 chat lines: none of the chat is out of reach", () => {
    const state = room();
    state.tokens.t1 = token("t1");
    state.log = [...Array.from({ length: 100 }, (_, i) => teleport(`${i + 1}:900000`)), ...Array.from({ length: 10 }, (_, i) => chat(`${101 + i}:0`))];
    const { room: out, archive } = imported(state);
    reachable(out, archive, "m-dm", "dm", "notes then chat");
    reachable(out, archive, "m-p1", "player", "notes then chat");
  });

  test("each ring's own bounds hold, the DM line's bytes included, however the file filled them", () => {
    const state = room();
    state.tokens.t1 = token("t1");
    const roll = { formula: "5d1000-1000", faces: [1000, 1000, 1000, 1000, 1000], total: 4000, label: "x".repeat(LIMITS.diceLabelChars), tokenId: "t1", critOn: 19 as const, save: "dex" as const, hidden: true as const };
    // The DM's dice lines of 20 hidden rolls, each with text and a sender no event line uses.
    state.log = Array.from({ length: MAX_LOG_LINES }, (_, i) => ({
      id: `1${String(i + 1).padStart(17, "0")}:900000`,
      at: AT,
      kind: "event" as const,
      from: "f".repeat(64),
      text: "\u{1F600}".repeat(1_000),
      data: { type: "dice" as const, by: "dm1", to: "dm" as const, rolls: Array.from({ length: LIMITS.diceRollsPerOp }, () => roll) },
    }));
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.ok(serializedBytes(parsed.state.log[0]) > LIMITS.apartLineBytes);
    const { room: out, archive } = imported(parsed.state);
    assert.equal(archive.length, MAX_LOG_LINES, "the archive takes them all");
    assert.equal(out.log.length, LIMITS.dmLogLines);
    for (const e of out.log) {
      assert.ok(serializedBytes(e) <= LIMITS.apartLineBytes);
      assert.equal(e.data?.type === "dice" && e.data.rolls.length, LIMITS.diceRollsPerOp, "the text went, and every roll stays");
    }
    // So the lines the measures leave out are bounded as in any room.
    assert.ok(serializedBytes(out) - measuredStateBytes(out) <= LIMITS.dmLogLines * LIMITS.apartLineBytes);
    reachable(out, archive, "m-dm", "dm", "full of notes");
  });

  test("a file's lines outside the measures lose their part readers and fit their bound, however many readers it lists, and all stay in the live log", () => {
    const state = room();
    state.tokens.pet = token("pet", { visibility: "dm", ownerIds: ["p1"] });
    const readers = Array.from({ length: LIMITS.membersPerRoom }, (_, i) => `r${String(i).padStart(63, "0")}`);
    const parts = { exact: readers, label: readers, to: readers, rolls: Array.from({ length: LIMITS.diceRollsPerOp }, () => readers) };
    const hp = { type: "hp" as const, tokenId: "pet", change: "damage" as const, amount: 1 };
    state.log = [
      ...Array.from({ length: LIMITS.dmLogLines - 1 }, (_, i) => ({ id: `${i + 1}:900000`, at: AT, kind: "event" as const, data: { type: "encounter" as const, action: "start" as const }, parts })),
      { id: "200:802000", at: AT, kind: "event", to: ["p1"], copyOf: "200:900000", data: hp, parts },
      { id: "200:900000", at: AT, kind: "event", data: hp, parts },
      { id: "201:0", at: AT, kind: "whisper", from: "p1", to: ["dm1"], text: "psst", data: hp, parts },
    ];
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.ok(serializedBytes(parsed.state.log[0]) > 4 * LIMITS.apartLineBytes, "each line of the file is far past the bound");
    const { room: out, archive } = imported(parsed.state);
    assert.equal(out.log.length, archive.length, "the rings hold every line");
    for (const e of out.log) {
      assert.equal(e.parts, undefined, e.id);
      assert.ok(serializedBytes(e) <= LIMITS.apartLineBytes, e.id);
    }
    assert.deepEqual(out.log.find((e) => e.kind === "whisper"), { id: "0:0", at: AT, kind: "whisper", from: "m-p1", to: ["m-dm"], text: "psst" }, "a whisper is who it is from and for and what it says");
    assert.ok(serializedBytes(out) - measuredStateBytes(out) <= (LIMITS.dmLogLines + 2) * LIMITS.apartLineBytes);
    assertWithinLimits(out);
  });

  test("a file's trap logs out of id order come in order, so the next trap line trims its ring as any room's", () => {
    const state = room();
    const seen = (i: number): LogEntry => ({ id: `${i + 1}:0`, at: AT, kind: "event", data: { type: "trapSeen", by: [], message: `seen ${i}` } });
    const sprung = (i: number): LogEntry => ({ id: `${i + 1}:900000`, at: AT, kind: "event", data: { type: "trap", trapId: "t1", sceneId: "s1", name: "Pit", how: "enter", by: [], hits: 0, did: [] } });
    state.trapSeen = Array.from({ length: LIMITS.trapSeenLines }, (_, i) => seen(i)).reverse();
    state.trapLog = Array.from({ length: LIMITS.trapLogLines }, (_, i) => sprung(i)).reverse();
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const out = remapState(parsed.state, { assets: new Map() });
    for (const lines of [out.trapSeen, out.trapLog]) assert.deepEqual(lines.map((e) => e.id), lines.map((e) => e.id).sort(byId));
    const tx = new Tx(out, DM, { seq: 5, at: AT });
    tx.addTrapLine("trapSeen", { type: "trapSeen", by: [], message: "Darts fly." }, LIMITS.trapSeenLines);
    tx.finish();
    assert.equal(tx.state.trapSeen.length, LIMITS.trapSeenLines);
    assert.ok(!tx.state.trapSeen.some((e) => e.id === out.trapSeen[0]!.id), "the oldest went");
  });

  test("a member's whispers past their bound keep their newest, and the rest are on Show older's pages", () => {
    const state = room();
    state.log = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? chat(`${i + 1}:0`) : { id: `${i + 1}:0`, at: AT, kind: "whisper" as const, from: "p1", to: ["dm1"], text: `w${i}` }));
    const { room: out, archive } = imported(state);
    assert.equal(out.log.filter((e) => e.kind === "whisper").length, memberRing("whisper", Object.keys(out.members).length).lines);
    reachable(out, archive, "m-dm", "dm", "whispers");
    reachable(out, archive, "m-p1", "player", "whispers");
    reachable(out, archive, "m-p2", "player", "whispers");
  });
});

describe("whispers through an export (shared/logRings.ts)", () => {
  test("56 members who join, whisper the DM and leave stay within an import's limit, and the export imports", () => {
    let state = room();
    let seq = 0;
    const run = (op: Op, who: { memberId: string; role: "dm" | "player" }) => {
      const r = applyOp(state, op, who, env(++seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    };
    for (let i = 0; i < 56; i++) {
      const id = `guest${i}`;
      run({ t: "sys.memberJoin", member: { id, name: id, color: "#ff0000", kind: "player", createdAt: AT } }, DM);
      for (let w = 0; w < 52; w++) run({ t: "log.whisper", to: ["dm1"], text: `${i}.${w}` }, { memberId: id, role: "player" });
      run({ t: "sys.memberRemove", memberId: id }, DM);
    }
    assert.ok(state.log.length <= MAX_LOG_LINES, `${state.log.length} lines`);
    // Only the DM, still on the roster, keeps any: their newest.
    assert.equal(state.log.filter((e) => e.kind === "whisper").length, memberRing("whisper", Object.keys(state.members).length).lines);
    const exported = parseRoomState(JSON.parse(JSON.stringify(exportableState(state, DM))));
    assert.ok(exported.ok, exported.ok ? "" : exported.message);
    const imported = remapState(exported.state, { assets: new Map() });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(imported)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assertWithinLimits(imported);
  });
});

