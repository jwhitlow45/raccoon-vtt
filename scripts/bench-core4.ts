/**
 * Part 4A's rows for the wave 4 gate (docs/design-v1-maps-vision.md 4.3.6):
 * what the core adds around sight on the largest vision scene, at the
 * scene caps. The party's explored layer written by one explore of the whole
 * scene, the fan-out candidates that explore makes, the explored layer's
 * reserve that every op's size check adds, a player's snapshot with both fog
 * layers full, and a hide over the whole scene that clears the layer. Sight
 * itself is part 4C's and is not computed here: the stand-in party sees
 * nothing, so the snapshot row is the projection without sight's own cost.
 * Run it alone on the machine being gated:
 *
 *   node scripts/bench-core4.ts
 */
import { exploredReserve } from "../shared/limits.ts";
import { DEFAULT_SETTINGS, type FogTile, type RoomState, type Scene, type Token } from "../shared/model.ts";
import { dependents, projectState } from "../shared/project.ts";
import { applyOp } from "../shared/reducer.ts";
import { encodeTile, fullTileBits, TILE_BYTES } from "../shared/rules/fog.ts";

const SIZE = 200;
const TILES = Math.ceil(SIZE / 16);
const SCENE = "0193b7a5-2c4e-7c3a-9f3e-0a1b2c3d4e5f";
const DM = { memberId: "dm", role: "dm" as const };
const PLAYER = { memberId: "p1", role: "player" as const };

/** A layer of every tile of the scene, all bits set, as a long game leaves the explored layer. */
function fullLayer(): Record<string, FogTile> {
  const out: Record<string, FogTile> = {};
  const bits = encodeTile(fullTileBits());
  for (let ty = 0; ty < TILES; ty++) for (let tx = 0; tx < TILES; tx++) out[`${SCENE}:${tx},${ty}`] = { sceneId: SCENE, tx, ty, rev: 1, bits };
  return out;
}

/** Every tile with a different half of its bits set, so a merge has work to do. */
function halfLayer(offset: number): Record<string, FogTile> {
  const out: Record<string, FogTile> = {};
  const bytes = new Uint8Array(TILE_BYTES);
  for (let i = offset; i < bytes.length; i += 2) bytes[i] = 0xff;
  const bits = encodeTile(bytes);
  for (let ty = 0; ty < TILES; ty++) for (let tx = 0; tx < TILES; tx++) out[`${SCENE}:${tx},${ty}`] = { sceneId: SCENE, tx, ty, rev: 3, bits };
  return out;
}

/** The largest vision scene at the caps: 500 tokens, 500 labels and 500 stamps spread over it. */
function room(): RoomState {
  const scene: Scene = {
    id: SCENE,
    rev: 1,
    name: "Bench",
    order: 0,
    bounds: { w: SIZE, h: SIZE },
    grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
    background: "#000000",
    fogEnabled: true,
    wallsVersion: 0,
    vision: { on: true, light: "dark" },
  };
  const state: RoomState = {
    meta: { name: "Bench", settings: { ...DEFAULT_SETTINGS }, playerSceneId: SCENE, view: { follow: false, blackout: false } },
    members: { dm: { id: "dm", rev: 0, name: "DM", color: "#ff0000", kind: "dm", createdAt: "" }, p1: { id: "p1", rev: 0, name: "P", color: "#00ff00", kind: "player", createdAt: "" } },
    scenes: { [SCENE]: scene },
    buildChunks: {},
    labels: {},
    fogTiles: halfLayer(0),
    fogDrafts: {},
    tokens: {},
    characters: {},
    templates: {},
    drawings: {},
    encounter: null,
    encounterHistory: [],
    handouts: {},
    log: [],
    monsters: {},
    srdImages: {},
    savedEncounters: {},
    stamps: {},
    lights: {},
    exploredTiles: {},
    journal: {},
    pins: {},
    rolls: {},
    handoutDocs: {},
    companionBlocks: {},
    casts: {},
  };
  for (let i = 0; i < 500; i++) {
    const x = (i * 37) % SIZE;
    const y = Math.floor((i * 37) / SIZE) * 3 % SIZE;
    const token: Token = {
      id: `t${i}`,
      rev: 0,
      sceneId: SCENE,
      kind: i % 10 === 0 ? "pc" : "monster",
      name: `Creature ${i}`,
      nameHidden: false,
      size: i % 7 === 0 ? "large" : "medium",
      x,
      y,
      elevation: 0,
      rotation: 0,
      disposition: "hostile",
      visibility: "all",
      fogExempt: false,
      fogExemptAuto: false,
      locked: false,
      layer: "token",
      ownerIds: i % 10 === 0 ? ["p1"] : [],
      actor: { inline: { hp: { cur: 10, max: 10, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } },
      hpVisibility: "label",
    };
    state.tokens[token.id] = token;
    state.labels[`l${i}`] = { id: `l${i}`, rev: 0, sceneId: SCENE, x: y + 0.5, y: x + 0.5, text: "Room", size: 1 };
    state.stamps[`s${i}`] = { id: `s${i}`, rev: 0, sceneId: SCENE, art: { key: "crate" }, x: (x + 100) % SIZE, y: y + 0.5, w: 1, h: 1, rotation: 0, z: i, visibility: "all" };
  }
  return state;
}

type Ms = { median: number; max: number };

function time(runs: number, work: () => void): Ms {
  const times: number[] = [];
  for (let r = 0; r < runs + 2; r++) {
    const t = performance.now();
    work();
    // The first two runs warm the engine up.
    if (r >= 2) times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)]!, max: times[times.length - 1]! };
}

export type BenchRow = { row: string; ms: Ms };

export function runBench(runs = 15): BenchRow[] {
  const base = room();
  const full = { ...base, exploredTiles: halfLayer(1) };
  const everything = Object.values(fullLayer()).map((t) => ({ tx: t.tx, ty: t.ty, bits: t.bits }));
  let seq = 1;
  const rows: BenchRow[] = [];
  let touched: string[] = [];
  rows.push({
    row: `an explore of all ${everything.length} tiles, applied`,
    ms: time(runs, () => {
      const r = applyOp(base, { t: "sys.explore", sceneId: SCENE, tiles: everything }, DM, { seq: seq++, at: "" });
      if (!r.ok) throw new Error(r.message);
      touched = r.touched;
    }),
  });
  rows.push({ row: "its fan-out candidates, 500 tokens, labels and stamps", ms: time(runs, () => void dependents(full, touched)) });
  rows.push({ row: "the explored reserve, in every op's size check", ms: time(runs, () => void exploredReserve(full)) });
  rows.push({ row: "a player's snapshot with both fog layers on every tile", ms: time(runs, () => void projectState(full, PLAYER, { sceneId: null })) });
  rows.push({ row: "the same snapshot with the explored layer empty, as before wave 4", ms: time(runs, () => void projectState(base, PLAYER, { sceneId: null })) });
  rows.push({ row: "the DM's snapshot of the same scene", ms: time(runs, () => void projectState(full, DM, { sceneId: SCENE })) });
  rows.push({
    row: "a hide over the whole scene, clearing the explored layer",
    ms: time(runs, () => {
      const r = applyOp(full, { t: "fog.live", sceneId: SCENE, ops: [{ id: "h", mode: "hide", shape: { kind: "all" } }] }, DM, { seq: seq++, at: "" });
      if (!r.ok) throw new Error(r.message);
    }),
  });
  return rows;
}

export function formatBench(rows: readonly BenchRow[]): string {
  const lines = ["row | ms (median / max)", "--- | ---"];
  for (const r of rows) lines.push(`${r.row} | ${r.ms.median.toFixed(2)} / ${r.ms.max.toFixed(2)}`);
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  console.log(formatBench(runBench()));
}
