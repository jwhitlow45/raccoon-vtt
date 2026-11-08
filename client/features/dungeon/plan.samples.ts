import { planDungeon, type Planned } from "./plan.ts";
import { Stream } from "./random.ts";
import { newSeed, type Seed } from "./seed.ts";
import { clampSettings, type DungeonSettings } from "./settings.ts";

/*
 * Fixed samples of plans for the phase 2 tests: seeds from a stream keyed
 * by a label, so a test that looks for a case finds the same one every
 * run. Not a test file itself: node --test runs only `*.test.ts`.
 */

export function seeds(label: number, n: number): Seed[] {
  const key = new Uint8Array(32);
  key[0] = label;
  key[1] = 0xd2;
  const stream = new Stream(key, new Uint8Array(12));
  return Array.from({ length: n }, () => newSeed((b) => b.forEach((_, i) => (b[i] = stream.below(256)))));
}

/** `n` plans of the choices over fixed seeds. */
export function samples(label: number, n: number, settings: Partial<DungeonSettings>): { s: DungeonSettings; seed: Seed; p: Planned }[] {
  const s = clampSettings(settings);
  return seeds(label, n).map((seed) => ({ s, seed, p: planDungeon(s, seed) }));
}

/** A square's x and y. */
export const xyOf = (k: number, W: number): [number, number] => [k % W, Math.floor(k / W)];

/** A square's four neighbors in the map. */
export function around(k: number, W: number, H: number): number[] {
  const [x, y] = xyOf(k, W);
  const out: number[] = [];
  if (x > 0) out.push(k - 1);
  if (x < W - 1) out.push(k + 1);
  if (y > 0) out.push(k - W);
  if (y < H - 1) out.push(k + W);
  return out;
}

/** Every painted square of a plan, by index. */
export function paintedOf(p: Planned): Map<number, string> {
  const W = p.plan.w;
  const out = new Map<number, string>();
  for (const [t, cells] of Object.entries(p.plan.paint)) {
    for (const c of cells ?? []) {
      const [x, y] = c.split(",").map(Number) as [number, number];
      out.set(y * W + x, t);
    }
  }
  return out;
}
