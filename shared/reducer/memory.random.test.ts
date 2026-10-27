import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey } from "../keys.ts";
import type { FogTile, Label, MemoryChunk, RememberedWall, RoomState, Stamp } from "../model.ts";
import { projectState, stableStringify } from "../project.ts";
import type { MemoryEntriesInput, MemoryKeysInput, Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { decodeTile, encodeTile, getBit, TILE_SUB } from "../rules/fog.ts";
import { DM, chance, env, int, member, pick, rng, room, scene } from "../testutil.ts";

/**
 * A state machine of players' memory (docs/design-v1-map-discovery.md 5.3
 * and 5.4, lane MD1) against a plain model: random runs of the map step's
 * `sys.remember` and its forgetting, explores, hides, Fog all, vision and
 * fog off and on, the switch to Per player and the fold back, picks of who
 * sees for themselves, the scene shrinking and growing, a member's removal
 * and undos of the DM's steps, on one scene with three players.
 *
 * The model keeps each layer as a set of whole cells and each memory as a
 * map from an element to what that layer remembers, and applies each rule
 * in its plainest form. After every step:
 * - M1: every layer's memory is the model's, entry for entry.
 * - M2: every entry's element touches a cell its layer holds, a free
 *   wall's versions each cell of theirs.
 * - M3: memory lives only on a scene with fog and party vision on, and a
 *   holder's only while they see for themselves.
 * - M4: every explored layer is the model's.
 * - M5: no viewer's projection holds memory or a mark.
 * Every reveal, hide and forgotten tile covers whole cells, so a cell is
 * held exactly when the model's set has it.
 */

const SIZE = 32;
const PLAYERS = ["p1", "p2", "p3"] as const;
type Layer = string | null;
const layerName = (l: Layer) => l ?? "party";

/** One element of a chunk's memory: its kind and key, the chunk named for kinds keyed by id. */
type Element = string;
const element = (cx: number, cy: number, field: string, key: string): Element => `${cx},${cy}|${field}|${key}`;

/** The plain model: whole cells held per layer, and each layer's memory by element. */
type Model = { held: Map<string, Set<string>>; memory: Map<string, Map<Element, unknown>> };

const wallId = (cx: number, cy: number) => `wall${cx}${cy}aaaaaa`.slice(0, 12);
/** The one free wall each chunk can remember, filed in that chunk by its midpoint. */
const wallOf = (cx: number, cy: number, kind: "wall" | "window") => ({ id: wallId(cx, cy), a: [cx * 16 + 1, cy * 16 + 2.5] as [number, number], b: [cx * 16 + 7, cy * 16 + 2.5] as [number, number], f: { kind } });
const wallCells = (cx: number, cy: number) => Array.from({ length: 6 }, (_, i) => `${cx * 16 + 1 + i},${cy * 16 + 2}`);
const label = (id: string, x: number, y: number): Label => ({ id, rev: 0, sceneId: "s1", x: x + 0.5, y: y + 0.5, text: "Hall", size: 1 });
const stamp = (id: string, x: number, y: number): Stamp => ({ id, rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: x + 0.5, y: y + 0.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });

/** The cells an element touches, worked out plainly: a label "Hall" at a cell's middle spans the cells beside it on its row, a stamp its cell. */
function touches(field: string, key: string, value: unknown): string[] {
  if (field === "labels" || field === "stamps") {
    if (value === null) return [];
    const v = value as { x: number; y: number };
    const x = Math.floor(v.x);
    const y = Math.floor(v.y);
    return field === "labels" ? [`${x - 1},${y}`, `${x},${y}`, `${x + 1},${y}`] : [`${x},${y}`];
  }
  if (field !== "edges") return [key];
  const [x, y, side] = key.split(",");
  return [`${x},${y}`, side === "n" ? `${x},${Number(y) - 1}` : `${Number(x) - 1},${y}`];
}

function cellsOfRect(x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push(`${i},${j}`);
  return out;
}

/** Tiles revealing exactly these cells, in a layer's stored shape. */
function tilesOf(cells: Iterable<string>): { tx: number; ty: number; bits: string }[] {
  const byTile = new Map<string, Uint8Array>();
  for (const cell of cells) {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    const tx = Math.floor(x / 16);
    const ty = Math.floor(y / 16);
    let bits = byTile.get(`${tx},${ty}`);
    if (!bits) byTile.set(`${tx},${ty}`, (bits = new Uint8Array((TILE_SUB * TILE_SUB) / 8)));
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const i = ((y % 16) * 4 + sy) * TILE_SUB + (x % 16) * 4 + sx;
        bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
      }
    }
  }
  return [...byTile].map(([at, bits]) => {
    const [tx, ty] = at.split(",").map(Number) as [number, number];
    return { tx, ty, bits: encodeTile(bits) };
  });
}

/** The whole cells a stored layer reveals, every sub-cell of each checked. */
function cellsOfLayer(tiles: readonly FogTile[]): Set<string> {
  const out = new Set<string>();
  for (const t of tiles) {
    const bits = decodeTile(t.bits)!;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        let all = true;
        let any = false;
        for (let s = 0; s < 16; s++) {
          const on = getBit(bits, x * 4 + (s % 4), y * 4 + Math.floor(s / 4));
          all &&= on;
          any ||= on;
        }
        assert.equal(any, all, `tile ${t.tx},${t.ty} cell ${x},${y} is part revealed`);
        if (all) out.add(`${t.tx * 16 + x},${t.ty * 16 + y}`);
      }
    }
  }
  return out;
}

/** Every element of a state's memory of s1, by layer. */
function memoryOfState(state: RoomState): Map<string, Map<Element, unknown>> {
  const out = new Map<string, Map<Element, unknown>>();
  for (const c of [...Object.values(state.memory ?? {}), ...Object.values(state.memoryBy ?? {})] as MemoryChunk[]) {
    const name = layerName(c.memberId ?? null);
    let m = out.get(name);
    if (!m) out.set(name, (m = new Map()));
    for (const field of ["cells", "edges", "walls", "heights", "up", "upDir", "rough", "labels", "stamps"] as const) {
      for (const [key, value] of Object.entries(c[field] ?? {})) m.set(element(c.cx, c.cy, field, key), value);
    }
  }
  return out;
}

function layersOf(state: RoomState): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const party = Object.values(state.exploredTiles).filter((t) => t.sceneId === "s1");
  if (party.length > 0) out.set("party", cellsOfLayer(party));
  for (const p of PLAYERS) {
    const own = Object.values(state.exploredBy ?? {}).filter((t) => t.sceneId === "s1" && t.memberId === p);
    if (own.length > 0) out.set(p, cellsOfLayer(own));
  }
  return out;
}

const fieldOf = (e: Element) => e.split("|")[1]!;
const keyOf = (e: Element) => e.split("|")[2]!;

/** The model's own prune: an entry goes once its element touches no cell its layer holds, a free wall's versions keep only held cells. */
function prune(model: Model, name: string): void {
  const held = model.held.get(name) ?? new Set();
  const m = model.memory.get(name);
  if (!m) return;
  for (const [e, value] of [...m]) {
    if (fieldOf(e) === "walls") {
      const versions = (value as RememberedWall[]).map((v) => ({ ...v, cells: v.cells.filter((c) => held.has(c)) })).filter((v) => v.cells.length > 0);
      if (versions.length === 0) m.delete(e);
      else m.set(e, versions);
    } else if (!touches(fieldOf(e), keyOf(e), value).some((c) => held.has(c))) m.delete(e);
  }
}

const byRow = (a: string, b: string) => {
  const [ax, ay] = a.split(",").map(Number) as [number, number];
  const [bx, by] = b.split(",").map(Number) as [number, number];
  return ay - by || ax - bx;
};

/** The fold, plainly: the party's entry where it held the element, else the first holder's in list order that held it. */
function fold(model: Model, order: readonly string[]): void {
  const party = model.memory.get("party") ?? new Map<Element, unknown>();
  const holders = order.filter((p) => model.held.has(p) || model.memory.has(p));
  const reads = (name: string, cells: readonly string[]) => cells.some((c) => model.held.get(name)?.has(c));
  const out = new Map<Element, unknown>();
  const all = new Set<Element>([...party.keys(), ...holders.flatMap((h) => [...(model.memory.get(h)?.keys() ?? [])])]);
  // Labels and stamps go by id across chunks, so they are pooled by id.
  const byId = new Map<string, Element[]>();
  for (const e of all) {
    const field = fieldOf(e);
    if (field === "labels" || field === "stamps") {
      const id = `${field}|${keyOf(e)}`;
      byId.set(id, [...(byId.get(id) ?? []), e]);
      continue;
    }
    if (field === "walls") continue;
    const cells = touches(field, keyOf(e), null);
    const from = reads("party", cells) ? "party" : holders.find((h) => reads(h, cells));
    const value = from === undefined ? undefined : model.memory.get(from)?.get(e);
    if (value !== undefined) out.set(e, value);
  }
  for (const e of [...all].filter((x) => fieldOf(x) === "walls")) {
    if (out.has(e)) continue;
    const layers = ["party", ...holders];
    const cells = new Set(layers.flatMap((l) => ((model.memory.get(l)?.get(e) as RememberedWall[] | undefined) ?? []).flatMap((v) => v.cells)));
    const versions = new Map<string, RememberedWall>();
    for (const cell of [...cells].sort(byRow)) {
      const from = reads("party", [cell]) ? "party" : holders.find((h) => reads(h, [cell]));
      const version = from === undefined ? undefined : ((model.memory.get(from)?.get(e) as RememberedWall[] | undefined) ?? []).find((v) => v.cells.includes(cell));
      if (!version) continue;
      const same = stableStringify(version.wall);
      const kept = versions.get(same);
      if (kept) kept.cells.push(cell);
      else versions.set(same, { wall: version.wall, cells: [cell] });
    }
    if (versions.size > 0) out.set(e, [...versions.values()]);
  }
  for (const entries of byId.values()) {
    const entry = (name: string) => entries.find((e) => model.memory.get(name)?.has(e));
    const holds = (name: string) => {
      const e = entry(name);
      return e !== undefined && reads(name, touches(fieldOf(e), keyOf(e), model.memory.get(name)!.get(e)));
    };
    const from = holds("party") ? "party" : holders.find(holds);
    const e = from === undefined ? undefined : entry(from);
    if (e !== undefined) out.set(e, model.memory.get(from!)!.get(e));
  }
  model.memory = new Map([...model.memory].filter(([name]) => !PLAYERS.includes(name as never)));
  if (out.size > 0) model.memory.set("party", out);
  else model.memory.delete("party");
  const pooled = new Set([...(model.held.get("party") ?? []), ...holders.flatMap((h) => [...(model.held.get(h) ?? [])])]);
  for (const p of PLAYERS) model.held.delete(p);
  if (pooled.size > 0) model.held.set("party", pooled);
}

function forgetLayer(model: Model, name: string): void {
  model.held.delete(name);
  model.memory.delete(name);
}

const keeps = (state: RoomState) => state.scenes.s1!.fogEnabled && state.scenes.s1!.vision?.on === true;
const perPlayer = (state: RoomState) => state.scenes.s1!.vision?.perPlayer === true;
const onHolders = (state: RoomState) => (state.holders.s1?.entries ?? []).filter((e) => e.on && state.members[e.memberId]?.kind === "player").map((e) => e.memberId);

/** A side's tiles: a per-player scene keeps none of a layer's past them. */
const tilesOn = (cells: number) => Math.max(1, Math.ceil(cells / 16));

/**
 * What changes when an op moved the scene's settings, the holder list or
 * the roster: the fold, the holders who stopped, the tiles past the bounds
 * of a scene that shrank or turned per player, and vision or fog off.
 */
function settle(model: Model, before: RoomState, after: RoomState): void {
  if (perPlayer(before) && !perPlayer(after)) fold(model, (before.holders.s1?.entries ?? []).map((e) => e.memberId));
  const on = new Set(perPlayer(after) ? onHolders(after) : []);
  for (const p of PLAYERS) if (!on.has(p)) forgetLayer(model, p);
  const was = before.scenes.s1!.bounds;
  const now = after.scenes.s1!.bounds;
  if (perPlayer(after) && (!perPlayer(before) || tilesOn(now.w) < tilesOn(was.w) || tilesOn(now.h) < tilesOn(was.h))) {
    for (const [name, held] of [...model.held]) {
      for (const cell of [...held]) {
        const [x, y] = cell.split(",").map(Number) as [number, number];
        if (Math.floor(x / 16) >= tilesOn(now.w) || Math.floor(y / 16) >= tilesOn(now.h)) held.delete(cell);
      }
      if (held.size === 0) model.held.delete(name);
      prune(model, name);
    }
  }
  if (!keeps(after)) for (const name of [...model.memory.keys()]) model.memory.delete(name);
}

/** A random set and drop for one chunk of one layer, valid as the map step would write it. */
function stepChunk(r: () => number, model: Model, name: string, cx: number, cy: number, labelsAt: Map<string, string>): { cx: number; cy: number; drop?: MemoryKeysInput; set?: MemoryEntriesInput } {
  // Mostly ground the layer holds, as the map step's entries are, and now and then ground it does not, which is never kept.
  const held = [...(model.held.get(name) ?? [])].filter((c) => {
    const [x, y] = c.split(",").map(Number) as [number, number];
    return Math.floor(x / 16) === cx && Math.floor(y / 16) === cy;
  });
  const cellIn = () => (held.length > 0 && chance(r, 0.85) ? pick(r, held) : `${cx * 16 + int(r, 0, 15)},${cy * 16 + int(r, 0, 15)}`);
  const set: Record<string, Record<string, unknown>> = {};
  const add = (field: string, key: string, value: unknown) => ((set[field] ??= {})[key] = value);
  for (let i = int(r, 1, 4); i > 0; i--) {
    const kind = int(r, 0, 5);
    if (kind === 0) add("cells", cellIn(), pick(r, ["stone", "wood", null]));
    else if (kind === 1) add("edges", `${cellIn()},${pick(r, ["n", "w"])}`, pick(r, [{ kind: "wall" }, "auto", null]));
    else if (kind === 2) add("heights", cellIn(), pick(r, [5, 10]));
    else if (kind === 3) {
      const cells = wallCells(cx, cy).filter(() => chance(r, 0.5));
      const split = int(r, 0, cells.length);
      const versions: RememberedWall[] = [];
      if (split > 0) versions.push({ wall: wallOf(cx, cy, pick(r, ["wall", "window"])), cells: cells.slice(0, split) });
      if (cells.length > split) versions.push({ wall: null, cells: cells.slice(split) });
      if (versions.length > 0) add("walls", wallId(cx, cy), versions);
    } else {
      const field = kind === 4 ? "labels" : "stamps";
      const id = pick(r, field === "labels" ? ["la", "lb", "lc"] : ["sa", "sb"]);
      // Each lies in one chunk of a layer: where it is already, or here.
      const at = labelsAt.get(`${name}|${field}|${id}`);
      if (at !== undefined && at !== `${cx},${cy}`) continue;
      const [x, y] = cellIn().split(",").map(Number) as [number, number];
      // A label keeps a cell either side of its anchor inside the chunk, so its box stays where the chunk can say.
      add(field, id, field === "labels" ? label(id, Math.min(Math.max(x, cx * 16 + 1), cx * 16 + 14), y) : stamp(id, x, y));
      labelsAt.set(`${name}|${field}|${id}`, `${cx},${cy}`);
    }
  }
  const drop: Record<string, string[]> = {};
  for (const e of model.memory.get(name)?.keys() ?? []) {
    if (!e.startsWith(`${cx},${cy}|`) || !chance(r, 0.3)) continue;
    const field = fieldOf(e);
    // A key set here too is set after its drop, so dropping it would change nothing.
    if (set[field] && keyOf(e) in set[field]!) continue;
    (drop[field] ??= []).push(keyOf(e));
    if (field === "labels" || field === "stamps") labelsAt.delete(`${name}|${field}|${keyOf(e)}`);
  }
  return { cx, cy, ...(Object.keys(drop).length > 0 ? { drop: drop as MemoryKeysInput } : {}), ...(Object.keys(set).length > 0 ? { set: set as MemoryEntriesInput } : {}) };
}

/** The model's own sys.remember: per chunk, drops then sets, then each forgotten tile, then the prune of that layer. */
function rememberInModel(model: Model, op: Extract<Op, { t: "sys.remember" }>): void {
  for (const layer of op.layers) {
    const name = layerName(layer.memberId ?? null);
    let m = model.memory.get(name);
    if (!m) model.memory.set(name, (m = new Map()));
    for (const c of layer.chunks) {
      for (const [field, keys] of Object.entries(c.drop ?? {})) for (const key of keys as string[]) m.delete(element(c.cx, c.cy, field, key));
      for (const [field, values] of Object.entries(c.set ?? {})) for (const [key, value] of Object.entries(values as object)) m.set(element(c.cx, c.cy, field, key), value);
    }
    // What lies on no ground the layer holds is never kept.
    prune(model, name);
    if (m.size === 0) model.memory.delete(name);
  }
  for (const f of op.forget ?? []) {
    const name = layerName(f.memberId ?? null);
    const held = model.held.get(name) ?? new Set<string>();
    for (const t of f.tiles) {
      const keep = t.keep === undefined ? new Set<string>() : cellsOfLayer([{ sceneId: "s1", tx: t.tx, ty: t.ty, rev: 0, bits: t.keep }]);
      for (const cell of [...held]) {
        const [x, y] = cell.split(",").map(Number) as [number, number];
        if (Math.floor(x / 16) === t.tx && Math.floor(y / 16) === t.ty && !keep.has(cell)) held.delete(cell);
      }
    }
    if (held.size === 0) model.held.delete(name);
    prune(model, name);
  }
}

function checkInvariants(state: RoomState, model: Model, where: string): void {
  const stored = memoryOfState(state);
  const want = new Map([...model.memory].filter(([, m]) => m.size > 0));
  // M1
  assert.deepEqual(
    [...stored].map(([n, m]) => [n, [...m].sort()]).sort(),
    [...want].map(([n, m]) => [n, [...m].sort()]).sort(),
    `${where}: M1 memory`,
  );
  // M4
  const layers = layersOf(state);
  assert.deepEqual([...layers].map(([n, s]) => [n, [...s].sort()]).sort(), [...model.held].filter(([, s]) => s.size > 0).map(([n, s]) => [n, [...s].sort()]).sort(), `${where}: M4 layers`);
  // M2
  for (const [name, m] of stored) {
    const held = layers.get(name) ?? new Set();
    for (const [e, value] of m) {
      if (fieldOf(e) === "walls") for (const v of value as RememberedWall[]) assert.ok(v.cells.every((c) => held.has(c)), `${where}: M2 ${name} ${e}`);
      else assert.ok(touches(fieldOf(e), keyOf(e), value).some((c) => held.has(c)), `${where}: M2 ${name} ${e}`);
    }
  }
  // M3
  if (!keeps(state)) assert.equal(stored.size, 0, `${where}: M3 memory with vision or fog off`);
  for (const name of stored.keys()) if (name !== "party") assert.ok(perPlayer(state) && onHolders(state).includes(name), `${where}: M3 ${name} keeps memory without seeing for themselves`);
  // M5
  for (const viewer of [DM, { memberId: "p1", role: "player" as const }]) {
    const view = projectState(state, viewer, { sceneId: "s1" }) as Record<string, unknown>;
    for (const field of ["memory", "memoryBy", "playedScenes", "memoryShared"]) assert.equal(view[field], undefined, `${where}: M5 ${field}`);
  }
}

function run(seed: number, steps: number): void {
  const r = rng(seed);
  // Half the runs start per player, with every player seeing for themselves, so holders' memory and the fold get as many steps as the party's.
  const split = seed % 2 === 1;
  let state = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") },
    scenes: { s1: scene("s1", { bounds: { w: SIZE, h: SIZE }, fogEnabled: true, vision: { on: true, light: "dark", ...(split ? { perPlayer: true as const } : {}) } }), s2: scene("s2", { order: 1 }) },
    // In an order of their own, so the list's order, which the fold reads, is not the members' ids.
    holders: split ? { s1: { sceneId: "s1", rev: 0, entries: shuffled(r, PLAYERS).map((memberId) => ({ memberId, on: true })) } } : {},
  });
  const model: Model = { held: new Map(), memory: new Map() };
  const undos: RestoreEntry[][] = [];
  // Inside the scene's bounds now, which an explore must keep to and a hide only reaches.
  const rect = (most = 12) => {
    const { w, h } = state.scenes.s1!.bounds;
    const x = int(r, 0, w - 1);
    const y = int(r, 0, h - 1);
    return { x, y, w: Math.min(int(r, 1, most), w - x), h: Math.min(int(r, 1, most), h - y) };
  };
  for (let i = 0; i < steps; i++) {
    const before = state;
    const roll = int(r, 0, 99);
    const holders = perPlayer(state) ? onHolders(state) : [];
    const layer = (): Layer => (holders.length > 0 && chance(r, 0.7) ? pick(r, holders) : null);
    let op: Op;
    let what: string;
    if (roll < 24 && state.scenes.s1!.vision?.on === true) {
      // The map step's explore, of the party's layer or a holder's own.
      const who = layer();
      const box = rect();
      const add = tilesOf(cellsOfRect(box.x, box.y, box.w, box.h)).map((t) => ({ ...t, bits: encodeTile(orBits(state, who, t)) }));
      op = who === null ? { t: "sys.explore", sceneId: "s1", tiles: add } : { t: "sys.explore", sceneId: "s1", tiles: [], members: [{ memberId: who, tiles: add }] };
      const held = model.held.get(layerName(who)) ?? new Set<string>();
      for (const c of cellsOfRect(box.x, box.y, box.w, box.h)) held.add(c);
      model.held.set(layerName(who), held);
      what = `explore ${layerName(who)} ${JSON.stringify(box)}`;
    } else if (roll < 56 && keeps(state)) {
      // The map step's memory, and now and then its forgetting.
      const who = layer();
      const name = layerName(who);
      // Where the layer files each label and stamp now, which this step's chunks keep up to date as they drop and set.
      const labelsAt = new Map<string, string>();
      for (const e of model.memory.get(name)?.keys() ?? []) if (fieldOf(e) === "labels" || fieldOf(e) === "stamps") labelsAt.set(`${name}|${fieldOf(e)}|${keyOf(e)}`, e.split("|")[0]!);
      const chunks = [[0, 0], [1, 0], [0, 1], [1, 1]].filter(() => chance(r, 0.5)).map(([cx, cy]) => stepChunk(r, model, name, cx!, cy!, labelsAt)).filter((c) => c.set || c.drop);
      const forget = chance(r, 0.2)
        ? [{ ...(who === null ? {} : { memberId: who }), tiles: [{ tx: int(r, 0, 1), ty: int(r, 0, 1), ...(chance(r, 0.5) ? { keep: tilesOf(cellsOfRect(int(r, 0, 20), int(r, 0, 20), 8, 8))[0]!.bits } : {}) }] }]
        : undefined;
      if (chunks.length === 0 && !forget) continue;
      op = { t: "sys.remember", sceneId: "s1", layers: chunks.length > 0 ? [{ ...(who === null ? {} : { memberId: who }), chunks }] : [], ...(forget ? { forget } : {}) };
      what = `remember ${name}`;
    } else if (roll < 70) {
      // Mostly small, so a hide often takes part of an element and leaves the rest.
      const box = rect(chance(r, 0.7) ? 3 : 12);
      op = { t: "fog.live", sceneId: "s1", ops: [{ id: `h${i}`, mode: "hide", shape: { kind: "rect", ...box } }] };
      what = `hide ${JSON.stringify(box)}`;
    } else if (roll < 71) {
      op = { t: "fog.reset", sceneId: "s1", to: "hidden" };
      what = "fog all";
    } else if (roll < 76) {
      const vision = state.scenes.s1!.vision ?? { on: false, light: "dark" as const };
      const patch = pick(r, [
        { vision: { on: !vision.on, light: vision.light } },
        { fogEnabled: !state.scenes.s1!.fogEnabled },
        { vision: { on: true, light: vision.light, perPlayer: true } },
        { vision: { on: vision.on, light: vision.light, perPlayer: false } },
      ]);
      op = { t: "scene.update", sceneId: "s1", patch };
      what = `scene ${JSON.stringify(patch)}`;
    } else if (roll < 78 && perPlayer(state) && PLAYERS.some((p) => model.memory.has(p))) {
      // The fold back to Whole party, while holders remember something, so pooling meets real memory.
      op = { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } };
      what = "fold";
    } else if (roll < 80 && perPlayer(state)) {
      const on = shuffled(r, PLAYERS).filter((p) => state.members[p] && chance(r, 0.6));
      op = { t: "vision.holders", sceneId: "s1", on };
      what = `holders ${on.join(",")}`;
    } else if (roll < 84) {
      // Shrinking or growing, across the line between tiles 0 and 1 or not, so a per-player scene forgets what lies past it.
      const bounds = { w: pick(r, [SIZE, 24, 16, 12]), h: pick(r, [SIZE, 20, 16]) };
      op = { t: "scene.update", sceneId: "s1", patch: { bounds } };
      what = `bounds ${bounds.w}x${bounds.h}`;
    } else if (roll < 85 && state.members.p3) {
      op = { t: "sys.memberRemove", memberId: "p3" };
      what = "remove p3";
    } else if (undos.length > 0) {
      op = { t: "sys.restore", entries: undos.pop()!, from: "undo", deps: true };
      what = "undo";
    } else continue;
    const result = applyOp(state, op, DM, env(100 + i));
    if (!result.ok) {
      // Only an undo whose guard no longer matches may be refused here.
      assert.equal(op.t, "sys.restore", `seed ${seed} step ${i} ${what}: ${result.message}`);
      continue;
    }
    state = result.state;
    if (op.t === "sys.remember") rememberInModel(model, op);
    else if (op.t === "fog.live") {
      const box = op.ops[0]!.shape as { x: number; y: number; w: number; h: number };
      const hidden = new Set(cellsOfRect(box.x, box.y, box.w, box.h));
      for (const [name, held] of [...model.held]) {
        for (const c of hidden) held.delete(c);
        if (held.size === 0) model.held.delete(name);
      }
      for (const name of [...model.memory.keys()]) prune(model, name);
    } else if (op.t === "fog.reset") {
      model.held.clear();
      model.memory.clear();
    }
    if (op.t !== "sys.explore" && op.t !== "sys.remember") settle(model, before, state);
    for (const [name, m] of [...model.memory]) if (m.size === 0) model.memory.delete(name);
    // Only the DM's own steps go on an undo stack: the server's ops never do.
    if (result.inverse && (op.t === "scene.update" || op.t === "vision.holders" || op.t === "fog.live" || op.t === "fog.reset")) undos.push(result.inverse);
    checkInvariants(state, model, `seed ${seed} step ${i} ${what}`);
  }
}

function shuffled<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A layer's tile with these bits joined, so an explore only ever adds, as the step's do. */
function orBits(state: RoomState, who: Layer, t: { tx: number; ty: number; bits: string }): Uint8Array {
  const held = who === null ? state.exploredTiles[tileKey("s1", t.tx, t.ty)] : state.exploredBy[holderTileKey("s1", who, t.tx, t.ty)];
  const next = decodeTile(t.bits)!;
  const was = held ? decodeTile(held.bits)! : null;
  if (was) for (let i = 0; i < next.length; i++) next[i] = next[i]! | was[i]!;
  return next;
}

describe("players' memory as a state machine against a plain model (lane MD1)", () => {
  test("random runs keep M1 to M5 after every step", () => {
    for (let seed = 1; seed <= 120; seed++) run(seed, 80);
  });
});
