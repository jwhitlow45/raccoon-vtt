import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { HttpError } from "../auth/http.ts";
import { exploredReserve, LIMITS, NO_ROOM_TO_EXPLORE, serializedBytes } from "#shared/limits.ts";
import { projectState } from "#shared/project.ts";
import { sightEntryMaxBytes } from "#shared/rules/vision.ts";
import { splitRefusal } from "#shared/rules/walls.ts";
import type { FreeWall, RoomState } from "#shared/model.ts";
import { apply, AT, room, scene, token, trap } from "#shared/testutil.ts";
import { sightPieces, tooManySightPieces } from "#shared/visionLimits.ts";
import { MANIFEST_VERSION, type ExportManifest, type ManifestAsset } from "./exportRoom.ts";
import { assertWithinLimits, entryToFile, IMPORT_LIMITS, InflatedCounter } from "./importRoom.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { SizeGuard } from "./sizeGuard.ts";

async function zipWith(name: string, data: Buffer): Promise<{ zip: yauzl.ZipFile; entry: yauzl.Entry }> {
  const out = new yazl.ZipFile();
  out.addBuffer(data, name);
  out.end();
  const chunks: Buffer[] = [];
  for await (const chunk of out.outputStream as AsyncIterable<Buffer>) chunks.push(chunk);
  const zip = await yauzl.fromBufferPromise(Buffer.concat(chunks));
  for await (const entry of zip.eachEntry()) return { zip, entry };
  throw new Error("empty zip");
}

describe("import entries", () => {
  test("an entry is written whole and hashed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rvtt-import-"));
    try {
      const data = Buffer.alloc(300_000, 7);
      const { zip, entry } = await zipWith("assets/a.webp", data);
      const digest = await entryToFile(zip, entry, join(dir, "a"), 1_000_000, new InflatedCounter());
      assert.deepEqual(digest, createHash("sha256").update(data).digest());
      assert.deepEqual(await readFile(join(dir, "a")), data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file that cannot be written is a refusal of this import, not a crash", async () => {
    const { zip, entry } = await zipWith("assets/a.webp", Buffer.alloc(300_000, 7));
    await assert.rejects(entryToFile(zip, entry, join(tmpdir(), "rvtt-no-such-dir", "a"), 1_000_000, new InflatedCounter()), { code: "ENOENT" });
  });

  test("an entry over its cap is refused as too large", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rvtt-import-"));
    try {
      const { zip, entry } = await zipWith("assets/a.webp", Buffer.alloc(300_000, 7));
      await assert.rejects(entryToFile(zip, entry, join(dir, "a"), 1_000, new InflatedCounter()), (err: unknown) => err instanceof HttpError && err.status === 413);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("import limits", () => {
  const wall = (k: number): FreeWall => ({ id: `w${String(k).padStart(11, "0")}`, a: [10 + (k % 64) / 64, 10], b: [10 + ((k * 7) % 64) / 64, 11], f: { kind: "wall" } });
  const pile = (n: number) => {
    const base = room({ scenes: { s1: scene("s1") } });
    return apply(base, { t: "build.walls", sceneId: "s1", put: Array.from({ length: n }, (_, k) => wall(k)) });
  };

  test("a scene whose free walls split past the caps is refused, as an op making it would be", () => {
    assert.throws(
      () => assertWithinLimits(pile(300)),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === splitRefusal("pieces"),
    );
  });

  test("a scene within the caps passes", () => {
    assert.doesNotThrow(() => assertWithinLimits(pile(20)));
  });

  test("a room with more trap springings waiting than the room's cap is refused, as the reducer never keeps more", () => {
    const waiting = (perTrap: number[]) => {
      const state = room({ scenes: { s1: scene("s1") } });
      perTrap.forEach((count, i) => {
        const t = trap(`t${i}`);
        state.traps[t.id] = { ...t, rig: { ...t.rig!, due: Array.from({ length: count }, (_, k) => ({ id: `${i + 1}:${k}`, at: AT, how: "enter" as const, by: [], hits: [] })) } };
      });
      return state;
    };
    assert.doesNotThrow(() => assertWithinLimits(waiting([3, 3, 3, 1])));
    assert.throws(
      () => assertWithinLimits(waiting([3, 3, 3, 3])),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === `at most ${LIMITS.trapDuePerRoom} trap springings can wait for the DM at once`,
    );
  });

  test("a scene with more drawn edges than the cap is refused", () => {
    const drawn = (count: number) => {
      let state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }) } });
      const edges = Array.from({ length: count }, (_, k) => ({ key: `${1 + (k % 199)},${Math.floor(k / 199)},w`, feature: { kind: "wall" } as const }));
      for (let k = 0; k < edges.length; k += 500) state = apply(state, { t: "build.edge", sceneId: "s1", edges: edges.slice(k, k + 500) });
      return state;
    };
    assert.doesNotThrow(() => assertWithinLimits(drawn(LIMITS.drawnEdgesPerScene)));
    assert.throws(
      () => assertWithinLimits(drawn(LIMITS.drawnEdgesPerScene + 1)),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === `this scene can hold at most ${LIMITS.drawnEdgesPerScene.toLocaleString("en-US")} walls, doors, windows and No wall marks on the grid`,
    );
  });

  test("a scene with more doors and windows than the cap is refused", () => {
    const openings = (count: number) => {
      let state = room({ scenes: { s1: scene("s1", { bounds: { w: 100, h: 100 } }) } });
      const edges = Array.from({ length: count }, (_, k) => ({ key: `${1 + (k % 99)},${Math.floor(k / 99)},w`, feature: k % 2 ? ({ kind: "window" } as const) : ({ kind: "door", state: "locked", secret: true, discovered: false } as const) }));
      for (let k = 0; k < edges.length; k += 500) state = apply(state, { t: "build.edge", sceneId: "s1", edges: edges.slice(k, k + 500) });
      return state;
    };
    assert.doesNotThrow(() => assertWithinLimits(openings(LIMITS.doorsAndWindowsPerScene)));
    assert.throws(
      () => assertWithinLimits(openings(LIMITS.doorsAndWindowsPerScene + 1)),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === `this scene can hold at most ${LIMITS.doorsAndWindowsPerScene.toLocaleString("en-US")} doors and windows`,
    );
  });

  test("a scene with more pillars than the cap is refused", () => {
    const columns = (count: number) => {
      const base = room({ scenes: { s1: scene("s1", { bounds: { w: 100, h: 100 } }) } });
      const cells = Array.from({ length: count }, (_, k) => `${k % 100},${Math.floor(k / 100)}`);
      let state = base;
      for (let k = 0; k < cells.length; k += 2_000) state = apply(state, { t: "build.paint", sceneId: "s1", terrain: "pillar", cells: cells.slice(k, k + 2_000) });
      return state;
    };
    assert.doesNotThrow(() => assertWithinLimits(columns(LIMITS.pillarsPerScene)));
    assert.throws(
      () => assertWithinLimits(columns(LIMITS.pillarsPerScene + 1)),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === `this scene can hold at most ${LIMITS.pillarsPerScene.toLocaleString("en-US")} pillars`,
    );
  });
});

describe("wave 4 import limits (docs/design-v1-maps-vision.md 2.4)", () => {
  test("a vision scene with more potential sight pieces than the cap is refused, and the same scene without vision passes", () => {
    const state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 } }), s2: scene("s2", { order: 1 }) } });
    for (let y = 0; y < 162; y += 2) {
      for (let x = 0; x < 200; x += 2) {
        const key = `s1:${Math.floor(x / 16)},${Math.floor(y / 16)}`;
        const chunk = (state.buildChunks[key] ??= { sceneId: "s1", cx: Math.floor(x / 16), cy: Math.floor(y / 16), rev: 0, cells: {}, edges: {} });
        chunk.edges[`${x},${y},n`] = { kind: "wall" };
      }
    }
    assert.doesNotThrow(() => assertWithinLimits(state));
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark" } };
    assert.throws(
      () => assertWithinLimits(state),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === tooManySightPieces(sightPieces(state, "s1")),
    );
  });

  /**
   * A room of exactly `bytes` serialized, its player scene a 200 x 200
   * vision scene. Tokens' long notes on four other scenes pad it: the limits
   * step never reads their length, which the protocol bounds where ops
   * arrive, and each scene's projection stays inside its 3 MiB.
   */
  function roomOf(bytes: number): RoomState {
    const state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark" } }) } });
    const pads = [2, 3, 4, 5].map((i) => {
      state.scenes[`s${i}`] = scene(`s${i}`, { order: i - 1 });
      return (state.tokens[`pad${i}`] = token(`pad${i}`, { sceneId: `s${i}`, notes: "" }));
    });
    const room0 = serializedBytes(state);
    for (const [i, pad] of pads.entries()) pad.notes = "x".repeat(Math.floor((bytes - room0) / 4) + (i === 0 ? (bytes - room0) % 4 : 0));
    assert.equal(serializedBytes(state), bytes);
    return state;
  }

  test("each scene is checked as the ops on it will be, its sight and exploration reserved, so an import never holds a scene that refuses its first move", () => {
    const DM_VIEW = { memberId: "dm1", role: "dm" as const };
    const sceneLimit = LIMITS.projectedSceneBytes;
    const sightReserve = 13 * 13 * sightEntryMaxBytes("s1");
    /** The player scene's DM projection, sight left out, padded by one token's notes to `bytes`. */
    const sceneOf = (bytes: number): RoomState => {
      const state = room({ scenes: { s1: scene("s1", { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark" } }) } });
      const pad = token("pad", { sceneId: "s1", notes: "" });
      state.tokens.pad = pad;
      const measured = () => serializedBytes(projectState({ ...state, sight: {} } as unknown as RoomState, DM_VIEW, { sceneId: "s1" }));
      pad.notes = "x".repeat(bytes - measured());
      assert.equal(measured(), bytes);
      return state;
    };
    const explored = exploredReserve(sceneOf(100_000));
    const fits = sceneOf(sceneLimit - sightReserve - explored);
    assert.ok(serializedBytes(fits) < LIMITS.stateBytes);
    assert.doesNotThrow(() => assertWithinLimits(fits));
    // A player's first move there passes, and so does any op that leaves the scene as it is: what players' copies may hold
    // beyond the DM's (docs/design-v1-map-discovery.md 5.5) refuses only a DM's edit that grows it, as at the deploy.
    assert.deepEqual(new SizeGuard().check(fits, ["s1"], 0, undefined, "player"), { ok: true }, "the scene the import keeps takes its first move");
    assert.deepEqual(new SizeGuard().check(fits, ["s1"], 0, fits), { ok: true }, "and an op that does not grow it");
    // A byte more, and the stored room still fits, but the scene's exploration does not: the DM reads what to do.
    const exploring = sceneOf(sceneLimit - sightReserve - explored + 1);
    assert.throws(
      () => assertWithinLimits(exploring),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === NO_ROOM_TO_EXPLORE,
    );
    assert.equal(new SizeGuard().check(exploring, ["s1"], 0, undefined, "player").ok, false, "every op on it would be refused");
    // Past its sight's reserve too, the scene is simply full.
    const full = sceneOf(sceneLimit - sightReserve + 1);
    assert.throws(
      () => assertWithinLimits(full),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === "this scene is at its 3 MiB size limit",
    );
    // Without vision there is nothing to reserve, and the same scene fits.
    full.scenes.s1 = { ...full.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.doesNotThrow(() => assertWithinLimits(full));
  });

  test("a room whose player scene's explored layer could not grow to its full size is refused with the message for the DM", () => {
    const reserve = exploredReserve(roomOf(1_000_000));
    assert.ok(reserve > 100_000);
    // Players' memory of the scene is reserved at its cap beside it (docs/design-v1-map-discovery.md 5.5).
    assert.doesNotThrow(() => assertWithinLimits(roomOf(LIMITS.stateBytes - reserve - MEMORY_CAP)));
    const tight = roomOf(LIMITS.stateBytes - reserve + 1);
    assert.throws(
      () => assertWithinLimits(tight),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.extra?.reason === NO_ROOM_TO_EXPLORE,
    );
    // Vision off there, nothing is reserved.
    tight.scenes.s1 = { ...tight.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.doesNotThrow(() => assertWithinLimits(tight));
  });
});

describe("pdf handout import caps (docs/design-v1-pdf-handouts.md 3.6)", () => {
  test("a room at its handout pages comes back: two entries a page beside room.json and assets.json, and every page in the manifest", () => {
    const pages = LIMITS.handoutPagesPerRoom;
    assert.ok(IMPORT_LIMITS.entries >= 2 * pages + 2, `${IMPORT_LIMITS.entries} entries`);
    assert.ok(IMPORT_LIMITS.assets >= pages, `${IMPORT_LIMITS.assets} assets`);
    // As an export writes each row (exportRoom.ts roomManifest), with more uploaders than one DM's devices make.
    const uuid = (i: number) => `0192f0aa-0000-7000-8000-${String(i).padStart(12, "0")}`;
    const asset = (i: number): ManifestAsset => ({
      id: uuid(i),
      sha256: createHash("sha256").update(String(i)).digest("hex"),
      kind: "handout",
      width: 2048,
      height: 2048,
      variants: ["full", "thumb"],
      uploaders: [uuid(900_000 + i), uuid(910_000 + i), uuid(920_000 + i)],
    });
    const manifest: ExportManifest = { formatVersion: MANIFEST_VERSION, assets: Array.from({ length: IMPORT_LIMITS.assets }, (_, i) => asset(i)) };
    const bytes = Buffer.byteLength(JSON.stringify(manifest));
    assert.ok(bytes <= IMPORT_LIMITS.manifestBytes, `a manifest of ${IMPORT_LIMITS.assets} handout pages is ${bytes} bytes`);
  });
});
