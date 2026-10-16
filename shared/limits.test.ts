import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { roomHandoutPages } from "./handouts.ts";
import { HANDOUT_PAGES_FULL, LIMITS, SHOWING_COUNTS_AGAIN, checkLimits, serializedBytes, utf8Bytes } from "./limits.ts";
import type { EdgeFeature, FreeWall } from "./model.ts";
import { customMonster, drawing, room, srdImage, token } from "./testutil.ts";

describe("checkLimits", () => {
  test("passes an ordinary room and fails past each count", () => {
    const state = room();
    assert.deepEqual(checkLimits(state, "s1"), { ok: true });
    for (let i = 0; i <= LIMITS.tokensPerScene; i++) state.tokens[`t${i}`] = token(`t${i}`);
    const r = checkLimits(state, "s1");
    assert.ok(!r.ok && r.code === "quota");
    assert.deepEqual(checkLimits(state, "s2"), { ok: true });
    assert.deepEqual(checkLimits(state), { ok: true });
  });

  test("counts drawing points per drawing and per scene", () => {
    const state = room();
    state.drawings.big = drawing("big", { points: new Array(LIMITS.drawingPointValues + 1).fill(0) });
    assert.ok(!checkLimits(state, "s1").ok);
    delete state.drawings.big;
    for (let i = 0; i < 51; i++) state.drawings[`d${i}`] = drawing(`d${i}`, { points: new Array(2000).fill(0) });
    assert.ok(!checkLimits(state, "s1").ok);
  });

  test("room-level limits apply without a scene", () => {
    const state = room();
    for (let i = 0; i <= LIMITS.scenesPerRoom; i++) state.scenes[`x${i}`] = { ...state.scenes.s1!, id: `x${i}` };
    assert.ok(!checkLimits(state).ok);
    const wide = room();
    wide.scenes.s1!.bounds = { w: 201, h: 10 };
    assert.ok(!checkLimits(wide).ok);
    assert.equal(serializedBytes({ a: 1 }), 7);
  });

  test("custom monsters: a count, a size for each, and a size for all of them", () => {
    const state = room();
    for (let i = 0; i < LIMITS.monstersPerRoom; i++) state.monsters[`m${i}`] = customMonster(`m${i}`);
    assert.deepEqual(checkLimits(state), { ok: true });
    state.monsters.extra = customMonster("extra");
    const many = checkLimits(state);
    assert.ok(!many.ok && /200 custom monsters/.test(many.message));

    const big = room();
    big.monsters.m1 = customMonster("m1", { traits: Array.from({ length: 5 }, (_, i) => ({ name: `Trait ${i}`, text: "x".repeat(4_000) })) });
    const one = checkLimits(big);
    assert.ok(!one.ok && /16 KiB/.test(one.message));

    const all = room();
    const sized = (id: string) => customMonster(id, { traits: Array.from({ length: 3 }, (_, i) => ({ name: `Trait ${i}`, text: "x".repeat(3_900) })) });
    for (let i = 0; i < 80; i++) all.monsters[`m${i}`] = sized(`m${i}`);
    assert.ok(serializedBytes(all.monsters) < LIMITS.monstersBytes);
    assert.deepEqual(checkLimits(all), { ok: true });
    for (let i = 80; i < 100; i++) all.monsters[`m${i}`] = sized(`m${i}`);
    const total = checkLimits(all);
    assert.ok(!total.ok && /the room is full: it can hold at most 1 MiB of custom monsters/.test(total.message));
  });

  test("SRD monster images: more than the SRD has monsters, and no more", () => {
    const state = room();
    for (let i = 0; i < LIMITS.srdImagesPerRoom; i++) state.srdImages[`monster-${i}`] = srdImage(`monster-${i}`, `img-${i}`);
    assert.ok(LIMITS.srdImagesPerRoom > 330);
    assert.deepEqual(checkLimits(state), { ok: true });
    state.srdImages.extra = srdImage("extra", "img-extra");
    const many = checkLimits(state);
    assert.ok(!many.ok && /400 SRD monster images/.test(many.message));
  });

  test("saved encounters: a count per room", () => {
    const state = room();
    for (let i = 0; i < LIMITS.savedEncountersPerRoom; i++) state.savedEncounters[`e${i}`] = { id: `e${i}`, rev: 0, name: "Wolves", monsters: [{ srdId: "wolf", count: 3 }] };
    assert.deepEqual(checkLimits(state), { ok: true });
    state.savedEncounters.extra = { id: "extra", rev: 0, name: "One more", monsters: [] };
    const many = checkLimits(state);
    assert.ok(!many.ok && /100 saved encounters/.test(many.message));
  });

  test("handout pages: every page of every document and of every handout showing, one image as one page, a document shown counted again (docs/design-v1-pdf-handouts.md 3.7)", () => {
    const pages = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ assetId: `${prefix}${i}`, width: 1584, height: 2048 }));
    const state = room();
    // 19 documents of 100 pages and one of 99: 1,999 pages.
    for (let i = 0; i < 20; i++) state.handoutDocs[`d${i}`] = { id: `d${i}`, rev: 0, title: "Strange letter", pages: pages(i === 19 ? 99 : 100, `d${i}-`), createdAt: "" };
    assert.equal(roomHandoutPages(state), 1_999);
    // One image showing is one page: the room is at its 2,000.
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "img", title: "Letter", to: "all", shownAt: "" };
    assert.equal(roomHandoutPages(state), LIMITS.handoutPagesPerRoom);
    assert.deepEqual(checkLimits(state), { ok: true });
    // A save past it says what frees some.
    const saved = { ...state, handoutDocs: { ...state.handoutDocs, d20: { id: "d20", rev: 0, title: "One more", pages: pages(1, "x"), createdAt: "" } } };
    assert.deepEqual(checkLimits(saved, null, state), { ok: false, code: "quota", message: HANDOUT_PAGES_FULL });
    assert.equal(HANDOUT_PAGES_FULL, "the room holds at most 2,000 handout pages. Delete a document or close a handout, then try again");
    // A show of a saved document counts its pages again, and says so.
    const shown = { ...state, handouts: { ...state.handouts, h2: { id: "h2", rev: 0, assetId: "d0-0", pages: state.handoutDocs.d0!.pages, title: "Strange letter", to: "all" as const, shownAt: "" } } };
    assert.equal(roomHandoutPages(shown), 2_100);
    assert.deepEqual(checkLimits(shown, null, state), { ok: false, code: "quota", message: `${HANDOUT_PAGES_FULL}. ${SHOWING_COUNTS_AGAIN}` });
    assert.equal(SHOWING_COUNTS_AGAIN, "Showing a document counts its pages again while it shows");
    // Without the state before, as for an import, the words are the save's.
    assert.deepEqual(checkLimits(shown), { ok: false, code: "quota", message: HANDOUT_PAGES_FULL });
  });

  test("pillars: a cap per scene, absolute without the state before, and with it only for an op that raises the count", () => {
    const withPillars = (count: number) => {
      const state = room();
      for (let k = 0; k < count; k++) {
        const x = k % 100;
        const y = Math.floor(k / 100);
        const chunk = (state.buildChunks[`s1:${Math.floor(x / 16)},${Math.floor(y / 16)}`] ??= { sceneId: "s1", cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 0, cells: {}, edges: {} });
        chunk.cells[`${x},${y}`] = "pillar";
      }
      return state;
    };
    const message = `this scene can hold at most ${LIMITS.pillarsPerScene.toLocaleString("en-US")} pillars`;
    const atCap = withPillars(LIMITS.pillarsPerScene);
    const over = withPillars(LIMITS.pillarsPerScene + 1);
    assert.deepEqual(checkLimits(atCap, "s1"), { ok: true });
    assert.deepEqual(checkLimits(over, "s1"), { ok: false, code: "quota", message });
    assert.deepEqual(checkLimits(over, "s2"), { ok: true });
    // A scene already over the cap keeps its other edits, and refuses one more pillar.
    assert.deepEqual(checkLimits(over, "s1", over), { ok: true });
    assert.deepEqual(checkLimits(over, "s1", withPillars(LIMITS.pillarsPerScene + 5)), { ok: true });
    assert.deepEqual(checkLimits(over, "s1", atCap), { ok: false, code: "quota", message });
    assert.deepEqual(checkLimits(withPillars(LIMITS.pillarsPerScene + 2), "s1", over), { ok: false, code: "quota", message });
  });

  test("doors and windows: on the grid and free, secret doors included, with the same rule for the state before", () => {
    const cap = LIMITS.doorsAndWindowsPerScene;
    const withOpenings = (grid: number, free: number) => {
      const state = room();
      const chunk = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} as Record<string, EdgeFeature>, walls: [] as FreeWall[] };
      for (let k = 0; k < grid; k++) {
        chunk.edges[`${k % 200},${Math.floor(k / 200)},w`] = k % 3 === 0 ? { kind: "window" } : { kind: "door", state: "closed", secret: k % 3 === 1, discovered: false };
      }
      // Plain walls, on the grid and free, never count.
      chunk.edges["0,150,n"] = { kind: "wall" };
      chunk.walls.push({ id: "wall00000000", a: [1, 1], b: [2, 2], f: { kind: "wall" } });
      for (let k = 0; k < free; k++) chunk.walls.push({ id: `door${String(k).padStart(8, "0")}`, a: [k / 8, 1], b: [k / 8, 2], f: k % 2 ? { kind: "window" } : { kind: "door", state: "open", secret: false, discovered: false } });
      state.buildChunks["s1:0,0"] = chunk;
      return state;
    };
    const message = `this scene can hold at most ${cap.toLocaleString("en-US")} doors and windows`;
    assert.deepEqual(checkLimits(withOpenings(cap - 10, 10), "s1"), { ok: true });
    const over = withOpenings(cap - 10, 11);
    assert.deepEqual(checkLimits(over, "s1"), { ok: false, code: "quota", message });
    assert.deepEqual(checkLimits(withOpenings(cap + 1, 0), "s1"), { ok: false, code: "quota", message });
    assert.deepEqual(checkLimits(over, "s1", over), { ok: true });
    assert.deepEqual(checkLimits(over, "s1", withOpenings(cap, 0)), { ok: false, code: "quota", message });
  });

  test("drawn edges: every stored edge entry, with the same rule for the state before", () => {
    const cap = LIMITS.drawnEdgesPerScene;
    const withEdges = (count: number) => {
      const state = room();
      const chunk = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {} as Record<string, EdgeFeature>, walls: [] as FreeWall[] };
      for (let k = 0; k < count; k++) chunk.edges[`${k % 200},${Math.floor(k / 200)},n`] = k % 5 === 0 ? { kind: "none" } : k % 50 === 1 ? { kind: "window" } : { kind: "wall" };
      // Free walls are capped on their own.
      chunk.walls.push({ id: "wall00000000", a: [1, 1], b: [2, 2], f: { kind: "wall" } });
      state.buildChunks["s1:0,0"] = chunk;
      return state;
    };
    const message = `this scene can hold at most ${cap.toLocaleString("en-US")} walls, doors, windows and No wall marks on the grid`;
    // Only the drawn edge cap: a fiftieth of them are windows, under their own cap.
    assert.ok(Math.ceil((cap + 1) / 50) <= LIMITS.doorsAndWindowsPerScene);
    assert.deepEqual(checkLimits(withEdges(cap), "s1"), { ok: true });
    const over = withEdges(cap + 1);
    assert.deepEqual(checkLimits(over, "s1"), { ok: false, code: "quota", message });
    assert.deepEqual(checkLimits(over, "s1", over), { ok: true });
    assert.deepEqual(checkLimits(over, "s1", withEdges(cap)), { ok: false, code: "quota", message });
  });

  test("byte limits count UTF-8 bytes, not UTF-16 code units", () => {
    for (const text of ["plain", "café", "梟熊の巣", "🦉🐻", "mixed é 梟 🦉 text", "\ud800 lone", "\udc00", "\ud800\ud800"]) {
      assert.equal(utf8Bytes(text), Buffer.byteLength(text, "utf8"), JSON.stringify(text));
    }
    const notes = { notes: "梟".repeat(4_000) };
    assert.equal(serializedBytes(notes), Buffer.byteLength(JSON.stringify(notes)));
    assert.equal(serializedBytes(notes), 12_012);
  });
});
