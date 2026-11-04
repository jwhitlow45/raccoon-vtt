import type { TrapZone } from "#shared/model.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import type { Board } from "./layout.ts";
import type { Stream } from "./random.ts";

/*
 * Where the SRD's example traps go (docs/design/design-v1-dungeon-generator.md
 * 5.3 step 10). Phase 1 places four presets: a Hidden Pit or a Spiked Pit
 * on a room's doorway line or in a Wide corridor, a Falling Net's wire
 * across a Narrow corridor, and a Poisoned Needle on a locked door. Never
 * in the entrance room, never on a run, a dais or its stair, and 6 squares
 * apart. The landing lane turns each into a `trap.create` at the chosen
 * band, its pit floor read from the built ground.
 */

export const HIDDEN_PIT = "hidden-pit";
export const SPIKED_PIT = "spiked-pit";
export const FALLING_NET = "falling-net";
export const POISONED_NEEDLE = "poisoned-needle";

/** Traps keep this many squares apart, between their middles. */
export const TRAP_SPACING = 6;

/** A pit preset's squares, as the Trap tool's preset has them (2 by 2). */
function pitSize(): { w: number; h: number } {
  const zone = trapPreset(HIDDEN_PIT, "1-4")!.zone;
  return zone.kind === "squares" ? { w: zone.w, h: zone.h } : { w: 2, h: 2 };
}

export type Spot = { kind: "pit" | "net" | "needle"; zone: TrapZone; /** Its middle, doubled. */ mid: [number, number] };

export type SpotInput = {
  board: Board;
  /** Kept rooms but the entrance. */
  rooms: readonly number[];
  /** Squares on a room's doorway lines. */
  onLine: (k: number) => boolean;
  /** Plain floor a pit may cover: a room's or a corridor's, no overlay, run, dais or doorway square. */
  floorFree: (k: number) => boolean;
  /** Corridor squares, in path order, a trap may lie on. */
  corridor: readonly number[];
  painted: (k: number) => boolean;
  wide: boolean;
  /** Locked doors off the entrance room: one edge each. */
  locked: readonly string[];
};

/** Every spot each kind of trap may take, in a fixed order. */
export function trapSpots(input: SpotInput): Spot[] {
  const { board, wide } = input;
  const W = board.W;
  const out: Spot[] = [];
  const { w: pw, h: ph } = pitSize();
  const pitAt = (x: number, y: number, needLine: boolean): Spot | null => {
    let line = false;
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const k = board.cell(x + i, y + j);
        if (!input.floorFree(k)) return null;
        if (input.onLine(k)) line = true;
      }
    }
    if (needLine && !line) return null;
    return { kind: "pit", zone: { cells: [{ x, y, w: pw, h: ph }] }, mid: [2 * x + pw, 2 * y + ph] };
  };
  for (const i of input.rooms) {
    const r = board.rooms[i]!;
    for (let y = r.y; y + ph <= r.y + r.h; y++) {
      for (let x = r.x; x + pw <= r.x + r.w; x++) {
        const spot = pitAt(x, y, true);
        if (spot) out.push(spot);
      }
    }
  }
  const corridor = new Set(input.corridor);
  if (wide) {
    const seen = new Set<number>();
    for (const k of input.corridor) {
      const x = k % W;
      const y = (k - x) / W;
      if (seen.has(k) || x + pw > W || y + ph > board.H) continue;
      seen.add(k);
      let all = true;
      for (let j = 0; j < ph && all; j++) for (let i = 0; i < pw; i++) if (!corridor.has(k + j * W + i)) all = false;
      if (!all) continue;
      const spot = pitAt(x, y, false);
      if (spot) out.push(spot);
    }
  } else {
    for (const k of input.corridor) {
      if (!input.floorFree(k)) continue;
      const x = k % W;
      const y = (k - x) / W;
      const at = (dx: number, dy: number) => board.inMap(x + dx, y + dy) && input.painted(k + dy * W + dx);
      // A straight stretch with rock on both sides: the wire runs between its walls' edge midpoints.
      if (!at(-1, 0) && !at(1, 0) && at(0, -1) && at(0, 1)) out.push({ kind: "net", zone: { wire: { a: [x, y + 0.5], b: [x + 1, y + 0.5] } }, mid: [2 * x + 1, 2 * y + 1] });
      else if (!at(0, -1) && !at(0, 1) && at(-1, 0) && at(1, 0)) out.push({ kind: "net", zone: { wire: { a: [x + 0.5, y], b: [x + 0.5, y + 1] } }, mid: [2 * x + 1, 2 * y + 1] });
    }
  }
  for (const edge of input.locked) {
    const [xs, ys, side] = edge.split(",");
    const x = Number(xs);
    const y = Number(ys);
    out.push({ kind: "needle", zone: { door: { edge } }, mid: side === "n" ? [2 * x + 1, 2 * y] : [2 * x, 2 * y + 1] });
  }
  return out;
}

const apart = (a: Spot, b: Spot) => Math.max(Math.abs(a.mid[0] - b.mid[0]), Math.abs(a.mid[1] - b.mid[1])) >= 2 * TRAP_SPACING;

/**
 * Picks up to `count` traps: each time a kind among those with a spot left
 * 6 squares from every trap so far, then one of its spots. A pit is a
 * Hidden Pit or a Spiked Pit, even odds.
 */
export function pickTraps(rng: Stream, spots: readonly Spot[], count: number): { preset: string; zone: TrapZone }[] {
  const out: { preset: string; zone: TrapZone }[] = [];
  let left = [...spots];
  for (let t = 0; t < count; t++) {
    const kinds = (["pit", "net", "needle"] as const).filter((k) => left.some((s) => s.kind === k));
    if (kinds.length === 0) break;
    const kind = rng.pick(kinds);
    const spot = rng.pick(left.filter((s) => s.kind === kind));
    left = left.filter((s) => apart(s, spot));
    const preset = kind === "pit" ? (rng.chance(1, 2) ? HIDDEN_PIT : SPIKED_PIT) : kind === "net" ? FALLING_NET : POISONED_NEEDLE;
    out.push({ preset, zone: spot.zone });
  }
  return out;
}
