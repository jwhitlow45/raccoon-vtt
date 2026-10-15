/**
 * Part 4E's row for the wave 4 gate (docs/design-v1-maps-vision.md 4.3.6):
 * "Applying changed sight tiles and redrawing the overlay", phone, 4 ms.
 * This times the applying half in Node: decoding the changed tiles and
 * writing their levels into the scene's pixels
 * (client/features/vision/sightRaster.ts), on the largest scene, for the
 * handful of tiles a move changes, for a door every source sees, and for
 * every tile at once (a snapshot, or vision turned on). The overlay writes
 * at most 48 tiles a frame (SightOverlay.tsx TILES_PER_FRAME), so a change
 * of every tile is also timed as its first frame.
 *
 * Node decodes base64 with the overlay's lookup table, where a browser
 * uses its own faster decoder, so these rows err high. The drawing half
 * (copying the changed tiles into the offscreen canvas with putImageData,
 * and the one image draw) runs in a browser, so it is measured there, with
 * Chrome's CPU throttled to stand in for a phone.
 * Run this alone on the machine being gated:
 *
 *   node scripts/bench-sight-overlay.ts
 */
import type { SightTile } from "../shared/model.ts";
import { PARTY_PALETTE, SIGHT_TILE_BYTES, SightRaster } from "../client/features/vision/sightRaster.ts";

const SIZE = 200;
const TILES = Math.ceil(SIZE / 16);
const SCENE = "0193b7a5-2c4e-7c3a-9f3e-0a1b2c3d4e5f";

/** A tile of mixed levels, as the edge of a torch's reach makes, different for each seed. */
function mixedTile(seed: number): SightTile {
  const bytes = new Uint8Array(SIGHT_TILE_BYTES);
  let x = seed * 2654435761;
  for (let i = 0; i < bytes.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return { b: Buffer.from(bytes).toString("base64") };
}

/** Every tile of the scene, from a seed. `changed` tiles of the second set differ from the first. */
function sightSet(seed: number, base?: Record<string, SightTile>, changed = Infinity): Record<string, SightTile> {
  const out: Record<string, SightTile> = {};
  let n = 0;
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const key = `${SCENE}:${tx},${ty}`;
      out[key] = base && n >= changed ? base[key]! : mixedTile(seed * 1000 + ty * TILES + tx);
      n++;
    }
  }
  return out;
}

type Ms = { median: number; max: number };

function time(runs: number, work: (run: number) => void): Ms {
  const times: number[] = [];
  for (let r = 0; r < runs + 2; r++) {
    const t = performance.now();
    work(r);
    // The first two runs warm the engine up.
    if (r >= 2) times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)]!, max: times[times.length - 1]! };
}

export type BenchRow = { row: string; ms: Ms };

export function runBench(runs = 31): BenchRow[] {
  const rows: BenchRow[] = [];
  const first = sightSet(1);
  for (const changed of [4, 30, TILES * TILES]) {
    const second = sightSet(2, first, changed);
    const raster = new SightRaster({ w: SIZE, h: SIZE }, PARTY_PALETTE);
    raster.update(first, SCENE);
    rows.push({
      row: `${changed} changed sight tiles written into a ${SIZE} x ${SIZE} scene's pixels`,
      ms: time(runs, (r) => {
        const dirty = raster.update(r % 2 === 0 ? second : first, SCENE);
        if (dirty.length !== changed) throw new Error(`wrote ${dirty.length} tiles, not ${changed}`);
      }),
    });
  }
  {
    const second = sightSet(2, first);
    const raster = new SightRaster({ w: SIZE, h: SIZE }, PARTY_PALETTE);
    raster.update(first, SCENE);
    // Timed by hand: the later frames run after the clock stops, so the next run starts from a finished raster.
    const times: number[] = [];
    for (let r = 0; r < runs + 2; r++) {
      const next = r % 2 === 0 ? second : first;
      const t = performance.now();
      const dirty = raster.update(next, SCENE, 48);
      const spent = performance.now() - t;
      if (dirty.length !== 48) throw new Error(`wrote ${dirty.length} tiles, not 48`);
      while (raster.behind) raster.update(next, SCENE, 48);
      if (r >= 2) times.push(spent);
    }
    times.sort((x, y) => x - y);
    rows.push({ row: `the first frame of a change to all ${TILES * TILES} tiles: 48 written`, ms: { median: times[Math.floor(times.length / 2)]!, max: times[times.length - 1]! } });
  }
  rows.push({
    row: `a scene's first draw: its pixels made and all ${TILES * TILES} tiles written`,
    ms: time(runs, () => void new SightRaster({ w: SIZE, h: SIZE }, PARTY_PALETTE).update(first, SCENE)),
  });
  return rows;
}

export function formatBench(rows: readonly BenchRow[]): string {
  const lines = ["row | ms (median / max)", "--- | ---"];
  for (const r of rows) lines.push(`${r.row} | ${r.ms.median.toFixed(3)} / ${r.ms.max.toFixed(3)}`);
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  console.log(formatBench(runBench()));
}
