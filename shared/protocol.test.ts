import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_EPH_BYTES,
  clientMessageSchema,
  clientOpSchema,
  opSchema,
  serverMessageSchema,
  serverOnlyOpSchema,
} from "./protocol.ts";
import { blockOf, customMonster } from "./testutil.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(!schema.safeParse(value).success, JSON.stringify(value));

describe("ops", () => {
  test("accepts well-formed client ops and refuses unknown fields and types", () => {
    ok(clientOpSchema, { t: "token.move", tokenId: "t1", x: 1, y: 2 });
    bad(clientOpSchema, { t: "token.move", tokenId: "t1", x: 1, y: 2, extra: true });
    bad(clientOpSchema, { t: "token.teleport", tokenId: "t1" });
    bad(clientOpSchema, { t: "token.move", tokenId: "t1", x: Number.POSITIVE_INFINITY, y: 2 });
    bad(clientOpSchema, { t: "token.move", tokenId: "t1", x: 5000, y: 2 });
  });

  test("server-only ops are refused from clients and accepted on the full schema", () => {
    const join = { t: "sys.memberJoin", member: { id: "m", name: "N", color: "#000000", kind: "player", createdAt: "x" } };
    bad(clientOpSchema, join);
    ok(serverOnlyOpSchema, join);
    ok(opSchema, join);
    ok(opSchema, { t: "sys.restore", entries: [{ key: "token:t1", value: null, expectRev: 3 }], from: "undo" });
    ok(opSchema, { t: "sys.restore", entries: [{ key: "token:t1", value: null, expectRev: 3 }], from: "undo", deps: true });
    bad(opSchema, { t: "sys.restore", entries: [{ key: "token:t1", value: null, expectRev: 3 }], from: "undo", deps: false });
    bad(clientOpSchema, { t: "sys.restore", entries: [{ key: "token:t1", value: null, expectRev: 3 }], from: "undo", deps: true });
    bad(clientOpSchema, { t: "sys.restore", entries: [], from: "undo" });
    bad(clientOpSchema, { t: "encounter.rollMonsters" });
    ok(clientOpSchema, { t: "encounter.setValues", values: [{ entryId: "n1", value: 12 }] });
  });

  test("string and array bounds hold", () => {
    ok(clientOpSchema, { t: "log.chat", text: "a".repeat(1000) });
    bad(clientOpSchema, { t: "log.chat", text: "a".repeat(1001) });
    bad(clientOpSchema, { t: "log.chat", text: "" });
    bad(clientOpSchema, { t: "room.update", name: "n".repeat(81) });
    bad(clientOpSchema, { t: "log.whisper", to: Array.from({ length: 17 }, (_, i) => `m${i}`), text: "x" });
    const drawing = { id: "d", sceneId: "s", kind: "free", points: [0, 0], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "p", visibility: "all" };
    ok(clientOpSchema, { t: "drawing.create", drawing });
    bad(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, points: new Array(2001).fill(0) } });
    bad(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, style: { ...drawing.style, stroke: "red" } } });
    bad(clientOpSchema, { t: "build.paint", sceneId: "s", terrain: "stone", cells: new Array(2001).fill("1,1") });
    bad(clientOpSchema, { t: "build.paint", sceneId: "s", terrain: "stone", cells: ["1;1"] });
    bad(clientOpSchema, { t: "fog.live", sceneId: "s", ops: [{ id: "a", mode: "reveal", shape: { kind: "poly", points: new Array(402).fill(1) } }] });
    ok(clientOpSchema, { t: "fog.live", sceneId: "s", ops: [{ id: "a", mode: "reveal", shape: { kind: "cells", cells: ["1,2"] } }] });
  });

  test("names refuse control and direction characters and need a character, notes keep line breaks", () => {
    // A room name reaches the admin CLI, so an escape sequence must never get that far.
    bad(clientOpSchema, { t: "room.update", name: "\u001b]0;pwned\u0007\u001b[2J" });
    bad(clientOpSchema, { t: "room.update", name: "" });
    bad(clientOpSchema, { t: "member.update", memberId: "m", name: "Ana\u202Eesoj" });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s", patch: { name: "Line\u2028break" } });
    ok(clientOpSchema, { t: "member.update", memberId: "m", name: "Zoë 🧙‍♂️ عبد" });
    const token = { id: "t", sceneId: "s", kind: "monster", name: "Goblin", size: "medium", x: 0, y: 0, actor: { ref: "c" } };
    ok(clientOpSchema, { t: "token.create", token });
    bad(clientOpSchema, { t: "token.create", token: { ...token, name: "" } });
    bad(clientOpSchema, { t: "token.create", token: { ...token, publicName: "\t" } });
    bad(clientOpSchema, { t: "build.label", sceneId: "s", labelId: "l", label: { x: 0, y: 0, text: "Trap\nhere", size: 1 } });
    ok(clientOpSchema, { t: "build.label", sceneId: "s", labelId: "l", label: { x: 0, y: 0, text: "", size: 1 } });
    bad(clientOpSchema, { t: "encounter.update", entryId: "n", patch: { label: "\u0000" } });
    bad(clientOpSchema, { t: "token.update", tokenId: "t", patch: { actor: { senses: "darkvision\r60 ft" } } });
    ok(clientOpSchema, { t: "token.update", tokenId: "t", patch: { actor: { notes: "Line one\n\tLine two\r\n", dmNotes: "" } } });
    bad(clientOpSchema, { t: "token.update", tokenId: "t", patch: { actor: { notes: "bell\u0007" } } });
    ok(clientOpSchema, { t: "log.chat", text: "two\nlines" });
    bad(clientOpSchema, { t: "log.chat", text: "\u001b[31mred" });
    bad(clientOpSchema, { t: "log.whisper", to: ["m"], text: "\u009b2J" });
  });

  test("actor bounds: effects per actor, sheet urls, areas and custom sizes", () => {
    const actor = {
      hp: { cur: 1, max: 1, temp: 0 },
      life: "alive",
      ac: 10,
      speeds: { walk: 30 },
      initBonus: 0,
      passivePerception: 10,
      senses: "",
      effects: [],
      deathSaves: { ok: 0, fail: 0 },
      notes: "",
      dmNotes: "",
    };
    const tokenOf = (extra: object) => ({ t: "token.create", token: { id: "t", sceneId: "s", kind: "monster", name: "G", size: "medium", x: 0, y: 0, actor: { inline: actor }, ...extra } });
    ok(clientOpSchema, tokenOf({}));
    bad(clientOpSchema, tokenOf({ actor: { inline: { ...actor, effects: Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, key: "blessed" })) } } }));
    bad(clientOpSchema, tokenOf({ actor: { inline: { ...actor, sheetUrl: "http://example.com" } } }));
    ok(clientOpSchema, tokenOf({ actor: { inline: { ...actor, sheetUrl: "https://example.com" } } }));
    bad(clientOpSchema, tokenOf({ actor: { inline: { ...actor, notes: "n".repeat(4001) } } }));
    bad(clientOpSchema, tokenOf({ size: "custom", w: 25 }));
    bad(clientOpSchema, tokenOf({ ownerIds: Array.from({ length: 17 }, (_, i) => `m${i}`) }));
    const template = { id: "a", sceneId: "s", shape: "cone", size: 15, origin: { x: 0, y: 0, z: 0 }, yaw: 90, includeOrigin: false, color: "#ff0000", ownerId: "p", visibility: "all" };
    ok(clientOpSchema, { t: "template.create", template });
    bad(clientOpSchema, { t: "template.create", template: { ...template, size: 1001 } });
    bad(clientOpSchema, { t: "template.create", template: { ...template, size: 4 } });
    // Aim up to straight up or down, and each reminder at most once.
    ok(clientOpSchema, { t: "template.create", template: { ...template, pitch: -90, triggers: ["enter", "turnEnd"] } });
    bad(clientOpSchema, { t: "template.create", template: { ...template, pitch: 91 } });
    bad(clientOpSchema, { t: "template.create", template: { ...template, triggers: ["enter", "enter"] } });
    bad(clientOpSchema, { t: "template.create", template: { ...template, triggers: [] } });
    ok(clientOpSchema, { t: "template.update", templateId: "a", patch: { pitch: null, triggers: null } });
  });

  test("a character's level is a whole number from 1 to 20, and null clears it", () => {
    for (const level of [1, 20]) ok(clientOpSchema, { t: "character.update", characterId: "c", patch: { level } });
    for (const level of [0, 21, 2.5, "3"]) bad(clientOpSchema, { t: "character.update", characterId: "c", patch: { level } });
    ok(clientOpSchema, { t: "character.update", characterId: "c", patch: { level: null } });
  });

  test("entries need a token, a character or a label", () => {
    ok(clientOpSchema, { t: "encounter.add", entries: [{ id: "n", label: "Lair" }] });
    bad(clientOpSchema, { t: "encounter.add", entries: [{ id: "n" }] });
    ok(clientOpSchema, { t: "actor.effect.add", target: { tokenId: "t" }, effect: { id: "e", key: "blessed", duration: { mode: "rounds", rounds: 3, of: { entryId: "n" } } } });
    bad(clientOpSchema, { t: "actor.effect.add", target: { tokenId: "t" }, effect: { id: "e", key: "blessed", duration: { mode: "rounds", of: { entryId: "n" } } } });
    bad(clientOpSchema, { t: "actor.effect.add", target: { tokenId: "t" }, effect: { id: "e", key: "bogus" } });
  });

  test("Next and Previous may name the turn they end, by row and round, and ops stored without it still pass", () => {
    for (const t of ["encounter.next", "encounter.prev"]) {
      ok(clientOpSchema, { t, from: { entry: "n1", round: 3 } });
      ok(clientOpSchema, { t, from: { entry: null, round: 1 } });
      ok(clientOpSchema, { t });
      ok(opSchema, { t });
      bad(clientOpSchema, { t, from: "n1" });
      bad(clientOpSchema, { t, from: null });
      bad(clientOpSchema, { t, from: { entry: "n1" } });
      bad(clientOpSchema, { t, from: { entry: "", round: 1 } });
      bad(clientOpSchema, { t, from: { entry: "n1", round: 1.5 } });
      bad(clientOpSchema, { t, from: { entry: "n1", round: 1, extra: true } });
    }
  });
});

describe("saved encounter ops", () => {
  const create = (patch: Record<string, unknown>) => ({ t: "savedEncounter.create", encounter: { id: "e1", name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }], ...patch } });

  test("an encounter names SRD monsters or the room's own, each with a count", () => {
    ok(clientOpSchema, create({}));
    ok(clientOpSchema, create({ monsters: [] }));
    ok(clientOpSchema, create({ monsters: [{ srdId: "adult-red-dragon", count: 1, inLair: true }, { monsterId: "m1", count: 2 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "wolf", monsterId: "m1", count: 1 }] }));
    bad(clientOpSchema, create({ monsters: [{ count: 1 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "Wolf", count: 1 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "wolf", count: 0 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "wolf", count: 2.5 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "wolf", count: 1, hp: 7 }] }));
    bad(clientOpSchema, create({ name: "" }));
    bad(clientOpSchema, create({ name: "Wolves\u202E" }));
    bad(clientOpSchema, create({ rev: 1 }));
  });

  test("at most 20 kinds of monster and 50 creatures, so placing one stays inside the op burst", () => {
    const kinds = (n: number, count = 1) => Array.from({ length: n }, (_, i) => ({ srdId: `monster-${i}`, count }));
    ok(clientOpSchema, create({ monsters: kinds(20) }));
    bad(clientOpSchema, create({ monsters: kinds(21) }));
    ok(clientOpSchema, create({ monsters: [{ srdId: "wolf", count: 50 }] }));
    bad(clientOpSchema, create({ monsters: [{ srdId: "wolf", count: 51 }] }));
    bad(clientOpSchema, create({ monsters: kinds(11, 5) }));
    bad(clientOpSchema, { t: "savedEncounter.update", encounterId: "e1", patch: { monsters: kinds(11, 5) } });
  });

  test("a party is up to 10 levels from 1 to 20, and null in an edit goes back to the room's characters", () => {
    ok(clientOpSchema, create({ party: [{ count: 4, level: 3 }, { count: 1, level: 20 }] }));
    ok(clientOpSchema, create({ party: [] }));
    bad(clientOpSchema, create({ party: null }));
    bad(clientOpSchema, create({ party: [{ count: 4, level: 21 }] }));
    bad(clientOpSchema, create({ party: [{ count: 0, level: 3 }] }));
    bad(clientOpSchema, create({ party: Array.from({ length: 11 }, () => ({ count: 1, level: 1 })) }));
    ok(clientOpSchema, { t: "savedEncounter.update", encounterId: "e1", patch: { party: null } });
    ok(clientOpSchema, { t: "savedEncounter.update", encounterId: "e1", patch: {} });
    bad(clientOpSchema, { t: "savedEncounter.update", encounterId: "e1", patch: { name: null } });
    ok(clientOpSchema, { t: "savedEncounter.delete", encounterId: "e1" });
  });
});

describe("custom monster ops", () => {
  const block = blockOf(customMonster("m1"));
  const create = (patch: Record<string, unknown>) => ({ t: "monster.create", monster: { id: "m1", ...block, ...patch } });

  test("a whole stat block is accepted, with every field bounded", () => {
    ok(clientOpSchema, create({}));
    ok(clientOpSchema, create({ sizeAlt: "small", xpInLair: 900, cr: "1/4" }));
    bad(clientOpSchema, create({ name: "" }));
    bad(clientOpSchema, create({ name: "Lurker\u202E" }));
    bad(clientOpSchema, create({ type: "Monstrosity\nfiend" }));
    bad(clientOpSchema, create({ skills: "x".repeat(501) }));
    bad(clientOpSchema, create({ cr: "1/3" }));
    bad(clientOpSchema, create({ cr: "31" }));
    bad(clientOpSchema, create({ size: "custom" }));
    bad(clientOpSchema, create({ ac: 101 }));
    bad(clientOpSchema, create({ abilities: { ...block.abilities, str: { score: 100, save: 0 } } }));
    bad(clientOpSchema, create({ abilities: { ...block.abilities, luck: { score: 10, save: 0 } } }));
    bad(clientOpSchema, create({ surprise: true }));
    bad(clientOpSchema, create({ rev: 3 }));
    // Entry text keeps its line breaks, as notes do, and refuses other control characters.
    ok(clientOpSchema, create({ traits: [{ name: "Two Paragraphs", text: "One.\nTwo." }] }));
    bad(clientOpSchema, create({ traits: [{ name: "Bell", text: "\u0007" }] }));
    bad(clientOpSchema, create({ traits: [{ name: "Two\nLines", text: "" }] }));
    bad(clientOpSchema, create({ actions: Array.from({ length: 41 }, (_, i) => ({ name: `A${i}`, text: "" })) }));
  });

  test("a monster is at most 16 KiB, whatever its fields allow", () => {
    const traits = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `T${i}`, text: "x".repeat(3_000) }));
    ok(clientOpSchema, create({ traits: traits(4) }));
    bad(clientOpSchema, create({ traits: traits(6) }));
    bad(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { traits: traits(6) } });
  });

  test("an update carries any lines, and null clears only the optional ones", () => {
    ok(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: {} });
    ok(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { ac: 15, sizeAlt: null, xpInLair: null, actions: [] } });
    bad(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { ac: null } });
    bad(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { id: "m2" } });
    ok(clientOpSchema, { t: "monster.delete", monsterId: "m1" });
  });

  test("a default image has a token image's shape, on a new monster, in an edit, and for an SRD monster by its id", () => {
    const image = { assetId: "a1", crop: { cx: 0.2, cy: -0.1, zoom: 1.5 } };
    ok(clientOpSchema, create({ defaultImage: image }));
    bad(clientOpSchema, create({ defaultImage: null }));
    bad(clientOpSchema, create({ defaultImage: { ...image, crop: { ...image.crop, zoom: 11 } } }));
    bad(clientOpSchema, create({ defaultImage: { ...image, url: "https://example.com/x.png" } }));
    ok(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { defaultImage: image } });
    ok(clientOpSchema, { t: "monster.update", monsterId: "m1", patch: { defaultImage: null } });
    ok(clientOpSchema, { t: "monster.setSrdImage", srdId: "goblin-warrior", image });
    ok(clientOpSchema, { t: "monster.setSrdImage", srdId: "adult-red-dragon", image: null });
    bad(clientOpSchema, { t: "monster.setSrdImage", srdId: "goblin-warrior" });
    for (const srdId of ["", "Goblin", "goblin warrior", "-goblin", "goblin--warrior", "goblin\n", "x".repeat(81)]) {
      bad(clientOpSchema, { t: "monster.setSrdImage", srdId, image });
    }
  });
});

describe("messages", () => {
  test("client messages", () => {
    ok(clientMessageSchema, { t: "hello", clientId: "c", resumeFrom: 1 });
    bad(clientMessageSchema, { t: "hello", clientId: "c", resumeFrom: 0 });
    ok(clientMessageSchema, { t: "op", n: 1, op: { anything: true } });
    bad(clientMessageSchema, { t: "op", n: 1.5, op: {} });
    ok(clientMessageSchema, { t: "op", n: 1, op: {}, g: "0192f0aa-0000-7000-8000-000000000001" });
    bad(clientMessageSchema, { t: "op", n: 1, op: {}, g: "" });
    bad(clientMessageSchema, { t: "op", n: 1, op: {}, g: "g".repeat(65) });
    ok(clientMessageSchema, { t: "eph", sceneId: "s", e: { k: "ping", x: 1, y: 2 } });
    ok(clientMessageSchema, { t: "eph", sceneId: "s", e: { k: "dragMove", tokenId: "t", x: 1, y: 2 } });
    bad(clientMessageSchema, { t: "eph", sceneId: "s", e: { k: "dragMove", tokenId: "t" } });
    ok(clientMessageSchema, { t: "scene", sceneId: "s" });
    ok(clientMessageSchema, { t: "ping", k: 3 });
  });

  test("an ephemeral payload is capped at 4 KiB", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i, tokenId: "t".repeat(60) }));
    const e = { k: "ruler", id: "r", points };
    assert.ok(JSON.stringify(e).length > MAX_EPH_BYTES);
    bad(clientMessageSchema, { t: "eph", sceneId: "s", e });
    ok(clientMessageSchema, { t: "eph", sceneId: "s", e: { k: "ruler", id: "r", points: points.slice(0, 5) } });
  });

  test("a ruler stop stands on ground from -100 to 200 ft, and a stop on a token on none", () => {
    const frame = (points: unknown[]) => ({ t: "eph", sceneId: "s", e: { k: "ruler", id: "r", points } });
    ok(clientMessageSchema, frame([{ x: 1.5, y: 1.5 }, { x: 2.5, y: 1.5, z: 10 }, { x: 3.5, y: 1.5, z: -100 }, { x: 4.5, y: 1.5, z: 200 }]));
    bad(clientMessageSchema, frame([{ x: 1.5, y: 1.5, z: 201 }]));
    bad(clientMessageSchema, frame([{ x: 1.5, y: 1.5, z: -101 }]));
    bad(clientMessageSchema, frame([{ x: 1.5, y: 1.5, z: 2.5 }]));
    bad(clientMessageSchema, frame([{ x: 1.5, y: 1.5, z: 10, tokenId: "t1" }]));
    ok(clientMessageSchema, frame([{ x: 1.5, y: 1.5, tokenId: "t1" }]));
    // The widest free stop, 32 bytes: 50 of them stay well inside the cap, with the longest ids.
    const widest = Array.from({ length: 50 }, () => ({ x: -999.5, y: -999.5, z: -100 }));
    assert.equal(JSON.stringify(widest[0]).length, 32);
    const e = { k: "ruler", id: "r".repeat(64), points: widest, shared: true };
    assert.ok(JSON.stringify(e).length <= MAX_EPH_BYTES);
    ok(clientMessageSchema, { t: "eph", sceneId: "s".repeat(64), e });

    const drawing = { id: "d", sceneId: "s", kind: "ruler", points: [0.5, 0.5, 1.5, 0.5], style: { stroke: "#ffffff", width: 3, opacity: 1 }, ownerId: "m", visibility: "all" };
    ok(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, z: [0, 10] } });
    ok(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, z: [-100, 200] } });
    bad(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, z: [0, 201] } });
    bad(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, z: [0, 0.5] } });
    bad(clientOpSchema, { t: "drawing.create", drawing: { ...drawing, z: new Array(51).fill(0) } });
  });

  test("server messages", () => {
    ok(serverMessageSchema, { t: "snapshot", seq: 3, state: {}, you: { memberId: "m", role: "dm", sceneId: "s" }, watermark: 0 });
    ok(serverMessageSchema, { t: "ev", seq: 4, changes: [{ key: "token:t", value: {} }, { key: "token:u", deleted: true }], acks: [1], rejects: [{ n: 2, code: "gone", message: "x" }] });
    ok(serverMessageSchema, { t: "ev", seq: 5, changes: [], acks: [3], restored: [{ n: 3, what: "moving Goblin 2" }] });
    bad(serverMessageSchema, { t: "ev", seq: 5, changes: [], restored: [{ n: 0, what: "x" }] });
    bad(serverMessageSchema, { t: "ev", seq: 4, changes: [{ key: "token:t" }] });
    ok(serverMessageSchema, { t: "retry", code: "busy" });
    ok(serverMessageSchema, { t: "retry", n: 2, code: "gap" });
    ok(serverMessageSchema, { t: "wait", ms: 2000 });
    ok(serverMessageSchema, { t: "presence", online: ["a"] });
    ok(serverMessageSchema, { t: "pong", k: 1 });
    ok(serverMessageSchema, { t: "resync", reason: "scene" });
    ok(serverMessageSchema, { t: "eph", from: "m", e: { k: "dragCancel", tokenId: "t" } });
  });
});

describe("wave 3 map ops", () => {
  const W = "abcdefABCDEF";
  const walls = (put: unknown[]) => ({ t: "build.walls", sceneId: "s1", put });
  const w = (a: number[], b: number[], extra: Record<string, unknown> = {}) => ({ id: W, a, b, f: { kind: "wall" }, ...extra });

  test("a free wall's ends lie on the 1/64 lattice inside the largest scene, at most 8 cells apart and not on one point", () => {
    ok(clientOpSchema, walls([w([0, 0], [8, 0])]));
    ok(clientOpSchema, walls([w([1023 / 64, 0], [1023 / 64 - 5.5, 45 / 64])]));
    bad(clientOpSchema, walls([w([0, 0], [8.015625, 0])]));
    bad(clientOpSchema, walls([w([0, 0], [6, 6])]));
    bad(clientOpSchema, walls([w([0.01, 0], [1, 0])]));
    bad(clientOpSchema, walls([w([1, 1], [1, 1])]));
    bad(clientOpSchema, walls([w([-1 / 64, 0], [1, 0])]));
    bad(clientOpSchema, walls([w([200, 0], [200.015625, 1])]));
    bad(clientOpSchema, walls([w([0, 0], [1, 0], { f: { kind: "none" } })]));
    bad(clientOpSchema, walls([{ ...w([0, 0], [1, 0]), id: "short" }]));
    bad(clientOpSchema, walls([w([0, 0, 0], [1, 0])]));
    ok(clientOpSchema, { t: "build.walls", sceneId: "s1", remove: [{ cx: 12, cy: 0, id: W }] });
    bad(clientOpSchema, { t: "build.walls", sceneId: "s1", remove: [{ cx: 13, cy: 0, id: W }] });
  });

  test("a free walls op is at most 500 walls and 48 KiB", () => {
    const door = { kind: "door", state: "closed", secret: false, discovered: false };
    const many = (n: number, f: unknown) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(12, "0"), a: [i % 200, 0], b: [i % 200, 1], f }));
    ok(clientOpSchema, walls(many(500, { kind: "wall" })));
    bad(clientOpSchema, walls(many(501, { kind: "wall" })));
    // 500 doors pass the count but not the byte bound, as the design measured.
    bad(clientOpSchema, walls(many(500, door)));
  });

  test("stamps, lights, phases, folders and the new scene fields keep their bounds", () => {
    const stamp = { id: "st1", art: { key: "oak-tree" }, x: 1, y: 1, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" };
    ok(clientOpSchema, { t: "build.stamps", sceneId: "s1", put: [stamp, { ...stamp, id: "st2", art: { assetId: "a1" }, tint: "#ff0000", flip: true }] });
    bad(clientOpSchema, { t: "build.stamps", sceneId: "s1", put: [{ ...stamp, art: { key: "../etc/passwd" } }] });
    bad(clientOpSchema, { t: "build.stamps", sceneId: "s1", put: [{ ...stamp, w: 0.2 }] });
    bad(clientOpSchema, { t: "build.stamps", sceneId: "s1", put: Array.from({ length: 101 }, (_, i) => ({ ...stamp, id: `s${i}` })) });
    const light = { id: "l1", x: 3.5, y: 2.015625, bright: 20, dim: 20, on: true, walls: true };
    ok(clientOpSchema, { t: "build.lights", sceneId: "s1", put: [light] });
    bad(clientOpSchema, { t: "build.lights", sceneId: "s1", put: [{ ...light, x: 3.51 }] });
    bad(clientOpSchema, { t: "build.lights", sceneId: "s1", put: [{ ...light, dim: 121 }] });
    const phase = { id: "p1", name: "Day", assetId: "a1", widthPx: 100, heightPx: 100 };
    ok(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: [phase], folder: "Act 1", thumb: "t1", autoWalls: "floor" } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: [] } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: [phase, phase] } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: Array.from({ length: 9 }, (_, i) => ({ ...phase, id: `p${i}` })) } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { folder: "a".repeat(41) } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { folder: "a‮b" } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { autoWalls: "some" } });
    ok(clientOpSchema, { t: "scene.setPhase", sceneId: "s1", phaseId: "p1" });
    ok(clientOpSchema, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s2", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    bad(clientOpSchema, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s2", name: "Copy", include: { creatures: true } });
  });
});

describe("wave 4 ops (docs/design-v1-maps-vision.md section 4)", () => {
  const bits = "A".repeat(683) + "=";

  test("moves may squeeze or teleport, and nothing else rides on them", () => {
    ok(clientOpSchema, { t: "token.move", tokenId: "t1", x: 2.5, y: 3, squeeze: true, teleport: "wall" });
    ok(clientOpSchema, { t: "token.move", tokenId: "t1", x: 2, y: 3, teleport: "ledge" });
    bad(clientOpSchema, { t: "token.move", tokenId: "t1", x: 2, y: 3, squeeze: false });
    bad(clientOpSchema, { t: "token.move", tokenId: "t1", x: 2, y: 3, teleport: "door" });
    bad(clientOpSchema, { t: "token.moveMany", moves: [{ tokenId: "t1", x: 2, y: 3, squeeze: true }] });
  });

  test("doors are named by an edge or a free wall's chunk and id", () => {
    ok(clientOpSchema, { t: "door.set", sceneId: "s1", door: { edge: "3,4,n" }, state: "open" });
    ok(clientOpSchema, { t: "door.set", sceneId: "s1", door: { cx: 1, cy: 0, id: "abcdefabcdef" }, state: "locked", found: true });
    bad(clientOpSchema, { t: "door.set", sceneId: "s1", door: { edge: "3,4,e" }, state: "open" });
    bad(clientOpSchema, { t: "door.set", sceneId: "s1", door: { cx: 1, cy: 0, id: "short" }, state: "open" });
    bad(clientOpSchema, { t: "door.set", sceneId: "s1", door: { edge: "3,4,n" }, state: "ajar" });
  });

  test("heights are whole feet from -100 to 200 and stairs point by the rule or one way, 2,000 cells an op", () => {
    ok(clientOpSchema, { t: "build.height", sceneId: "s1", cells: ["1,2"], height: -100 });
    ok(clientOpSchema, { t: "build.height", sceneId: "s1", cells: ["1,2"], height: 200 });
    bad(clientOpSchema, { t: "build.height", sceneId: "s1", cells: ["1,2"], height: 201 });
    bad(clientOpSchema, { t: "build.height", sceneId: "s1", cells: ["1,2"], height: 2.5 });
    bad(clientOpSchema, { t: "build.height", sceneId: "s1", cells: Array.from({ length: 2_001 }, (_, i) => `${i % 200},${Math.floor(i / 200)}`), height: 5 });
    for (const up of ["a", "n", "e", "s", "w", null]) ok(clientOpSchema, { t: "build.stairs", sceneId: "s1", cells: ["1,2"], up });
    bad(clientOpSchema, { t: "build.stairs", sceneId: "s1", cells: ["1,2"], up: "." });
  });

  test("vision, movement blocking, carried lights, party members and phase light keep their bounds", () => {
    ok(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" }, blockMovement: true } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true } } });
    ok(clientOpSchema, { t: "scene.create", scene: { id: "s2", name: "Cave", bounds: { w: 10, h: 10 }, blockMovement: true, vision: { on: false, light: "dim" } } });
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { light: { bright: 120, dim: 120 }, partyVision: true } });
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { light: null } });
    bad(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { light: { bright: 121, dim: 0 } } });
    const phase = { id: "p1", name: "Night", assetId: "a1", widthPx: 100, heightPx: 100, light: "dark" };
    ok(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: [phase] } });
    bad(clientOpSchema, { t: "scene.update", sceneId: "s1", patch: { phases: [{ ...phase, light: "pitch" }] } });
  });

  test("explore is the server's alone, its tiles are tiles of bits inside the largest scene, and a teleport's redo says so", () => {
    const explore = { t: "sys.explore", sceneId: "s1", tiles: [{ tx: 12, ty: 0, bits }] };
    bad(clientOpSchema, explore);
    ok(serverOnlyOpSchema, explore);
    bad(serverOnlyOpSchema, { ...explore, tiles: [{ tx: 13, ty: 0, bits }] });
    bad(serverOnlyOpSchema, { ...explore, tiles: [{ tx: 0, ty: 0, bits: "A".repeat(684) }] });
    bad(serverOnlyOpSchema, { ...explore, tiles: [] });
    ok(serverOnlyOpSchema, { t: "sys.restore", entries: [{ key: "token:t", value: null }], from: "redo", deps: true, teleport: true });
  });

  test("drag frames may carry the dragging client's squeeze", () => {
    ok(clientMessageSchema, { t: "eph", sceneId: "s1", e: { k: "dragMove", tokenId: "t1", x: 1, y: 1, squeeze: true } });
    ok(clientMessageSchema, { t: "eph", sceneId: "s1", e: { k: "dragEnd", tokenId: "t1", x: 1, y: 1, squeeze: true } });
    bad(clientMessageSchema, { t: "eph", sceneId: "s1", e: { k: "dragStart", tokenId: "t1", x: 1, y: 1, squeeze: true } });
  });
});

describe("wave 5 ops and messages (docs/design-v1-dm-tools.md)", () => {
  const BLOCK = "abcdefghijkl";
  const page = { id: "pg1", title: "Old map", access: "all", blocks: [{ id: BLOCK, text: "North." }] };

  test("an image is an upload with its crop or a shipped icon by key and color, wherever a token image goes", () => {
    const icon = { icon: "lorc/wolf-head", color: "#336699" };
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { image: icon, altImages: [icon, { assetId: "a1", crop: { cx: 0, cy: 0, zoom: 1 } }] } });
    ok(clientOpSchema, { t: "character.update", characterId: "c1", patch: { defaultImage: icon } });
    ok(clientOpSchema, { t: "monster.setSrdImage", srdId: "wolf", image: icon });
    bad(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { image: { ...icon, crop: { cx: 0, cy: 0, zoom: 1 } } } });
    bad(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { image: { icon: "lorc/wolf-head", color: "blue" } } });
    for (const key of ["lorc", "lorc/", "/wolf", "Lorc/wolf", "lorc/wolf head", "lorc/../x", `${"a".repeat(41)}/b`, `a/${"b".repeat(61)}`]) {
      bad(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { image: { icon: key, color: "#336699" } } });
    }
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { image: { icon: `${"a".repeat(40)}/${"b".repeat(60)}`, color: "#336699" } } });
  });

  test("a journal op carries blocks that say only whether they are secret, and is at most 32 KiB with the rest of the op", () => {
    ok(clientOpSchema, { t: "journal.create", page: { ...page, blocks: [{ id: BLOCK, text: "Lich.", secret: true }] } });
    bad(clientOpSchema, { t: "journal.create", page: { ...page, blocks: [{ id: BLOCK, text: "Lich.", secret: { revealed: true } }] } });
    bad(clientOpSchema, { t: "journal.create", page: { ...page, blocks: [{ id: BLOCK, text: "a" }, { id: BLOCK, text: "b" }] } });
    bad(clientOpSchema, { t: "journal.create", page: { ...page, blocks: [{ id: "short", text: "a" }] } });
    bad(clientOpSchema, { t: "journal.create", page: { ...page, access: { member: "p1", extra: true } } });
    ok(clientOpSchema, { t: "journal.update", pageId: "pg1", patch: { folder: null, access: { member: "p1" } } });
    const block = (i: number, text: string) => ({ id: `block${String(i).padStart(7, "0")}`, text });
    // Eight full blocks pass the frame, nine do not, though each block is within its own bound.
    const blocks = (n: number) => Array.from({ length: n }, (_, i) => block(i, "x".repeat(3_900)));
    ok(clientOpSchema, { t: "journal.update", pageId: "pg1", patch: { blocks: blocks(8) } });
    bad(clientOpSchema, { t: "journal.update", pageId: "pg1", patch: { blocks: blocks(9) } });
    bad(clientOpSchema, { t: "journal.update", pageId: "pg1", patch: { blocks: [block(0, "x".repeat(4_001))] } });
    bad(clientOpSchema, { t: "journal.update", pageId: "pg1", patch: { blocks: Array.from({ length: 101 }, (_, i) => block(i, "")) } });
    ok(clientOpSchema, { t: "journal.reveal", pageId: "pg1", blockId: BLOCK, revealed: true });
  });

  test("a roll request holds one or two choices, a skill only in a check, a DC from 1 to 50, and distinct targets", () => {
    const ask = (request: Record<string, unknown>) => ({ t: "roll.ask", request: { id: "r1", test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: "c1" }], ...request } });
    ok(clientOpSchema, ask({ dc: 15, note: "against the poison" }));
    ok(clientOpSchema, ask({ test: { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] } }));
    bad(clientOpSchema, ask({ test: { kind: "save", choices: [{ ability: "dex", skill: "acrobatics" }] } }));
    bad(clientOpSchema, ask({ test: { kind: "save", choices: [] } }));
    bad(clientOpSchema, ask({ test: { kind: "save", choices: [{ ability: "str" }, { ability: "dex" }, { ability: "con" }] } }));
    bad(clientOpSchema, ask({ test: { kind: "save", choices: [{ ability: "dex" }, { ability: "dex" }] } }));
    bad(clientOpSchema, ask({ dc: 0 }));
    bad(clientOpSchema, ask({ dc: 51 }));
    bad(clientOpSchema, ask({ note: "x".repeat(81) }));
    bad(clientOpSchema, ask({ targets: [{ characterId: "c1" }, { characterId: "c1" }] }));
    bad(clientOpSchema, ask({ targets: Array.from({ length: 51 }, (_, i) => ({ tokenId: `t${i}` })) }));
    bad(clientOpSchema, ask({ dcHidden: true }));
    ok(clientOpSchema, { t: "roll.answer", rollId: "r1", target: { tokenId: "t1" }, choice: 1, total: -50 });
    ok(clientOpSchema, { t: "roll.answer", rollId: "r1", target: { tokenId: "t1" }, result: "fail" });
    bad(clientOpSchema, { t: "roll.answer", rollId: "r1", target: { tokenId: "t1" } });
    bad(clientOpSchema, { t: "roll.answer", rollId: "r1", target: { tokenId: "t1" }, total: 101 });
    bad(clientOpSchema, { t: "roll.answer", rollId: "r1", target: { tokenId: "t1" }, choice: 2, total: 3 });
    ok(clientOpSchema, { t: "roll.close", rollIds: ["r1", "r2"] });
    bad(clientOpSchema, { t: "roll.close", rollIds: [] });
  });

  test("group edits name 1 to 100 distinct tokens and only the fields a group shares", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    ok(clientOpSchema, { t: "token.updateMany", tokenIds: ids(100), patch: { visibility: "dm", light: null, ownerIds: [] } });
    bad(clientOpSchema, { t: "token.updateMany", tokenIds: ids(101), patch: { locked: true } });
    bad(clientOpSchema, { t: "token.updateMany", tokenIds: ["a", "a"], patch: { locked: true } });
    bad(clientOpSchema, { t: "token.updateMany", tokenIds: ["a"], patch: {} });
    for (const patch of [{ name: "x" }, { x: 1 }, { sceneId: "s2" }, { notes: "x" }, { actor: { ac: 3 } }, { altImages: [] }]) bad(clientOpSchema, { t: "token.updateMany", tokenIds: ["a"], patch });
    ok(clientOpSchema, { t: "token.deleteMany", tokenIds: ids(100) });
    ok(clientOpSchema, { t: "actor.effects", add: [{ target: { tokenId: "a" }, effect: { id: "e1", key: "frightened" } }] });
    ok(clientOpSchema, { t: "actor.effects", remove: [{ target: { characterId: "c" }, effectId: "e1" }] });
    bad(clientOpSchema, { t: "actor.effects" });
    bad(clientOpSchema, { t: "actor.effects", add: [], remove: [] });
    bad(clientOpSchema, { t: "actor.effects", add: Array.from({ length: 101 }, (_, i) => ({ target: { tokenId: "a" }, effect: { id: `e${i}`, key: "prone" } })) });
  });

  test("pins, the drawing setting and the room monster link", () => {
    ok(clientOpSchema, { t: "pin.put", pin: { id: "p1", sceneId: "s1", x: 1.5, y: 2, label: "Crypt", pageId: "pg1", color: "#ff8800", visibility: "all" } });
    bad(clientOpSchema, { t: "pin.put", pin: { id: "p1", sceneId: "s1", x: 1.5, y: 2, label: "two\nlines", color: "#ff8800", visibility: "all" } });
    bad(clientOpSchema, { t: "pin.put", pin: { id: "p1", sceneId: "s1", x: 1.5, y: 2, color: "#ff8800", visibility: "all", rev: 3 } });
    for (const playersDraw of ["none", "all", ["p1"]]) ok(clientOpSchema, { t: "room.update", settings: { playersDraw } });
    bad(clientOpSchema, { t: "room.update", settings: { playersDraw: "some" } });
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { actor: { monsterId: "m1" } } });
    ok(clientOpSchema, { t: "token.update", tokenId: "t1", patch: { actor: { monsterId: null } } });
  });

  test("the display's camera, the X-card, presence counts and the display role", () => {
    ok(clientMessageSchema, { t: "eph", sceneId: "s1", e: { k: "view", x: 10, y: 8, w: 24, h: 13.5 } });
    bad(clientMessageSchema, { t: "eph", sceneId: "s1", e: { k: "view", x: 10, y: 8, w: 0, h: 13.5 } });
    ok(serverMessageSchema, { t: "xcard", at: "2026-10-14T20:00:00.000Z" });
    bad(serverMessageSchema, { t: "xcard", at: "2026-10-14T20:00:00.000Z", from: "p1" });
    ok(serverMessageSchema, { t: "presence", online: ["p1"], displays: 2 });
    ok(serverMessageSchema, { t: "snapshot", seq: 1, state: {}, you: { memberId: "display:abcdefghijkl", role: "display", sceneId: "s1" }, watermark: 0 });
  });
});
