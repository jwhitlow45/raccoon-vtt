import type { Board, Doorway, Link } from "./layout.ts";
import type { Stream } from "./random.ts";

/*
 * Secret doors and secret rooms (phase 2, 5.3, D-261107-204 and 261). A
 * secret door goes on a loop link's doorway, a secret way round, or on the
 * only doorway of a leaf room, which becomes a secret room. Never the
 * stub's, a locked door, or a doorway with a stair run, whose stairs would
 * climb to a blank wall. A candidate is kept only if the dungeon is still
 * whole without it: corridors join, so a flood over the painted squares
 * decides, not the link graph.
 */

export type SecretKind = "loop" | "leaf";
export type Candidate = { doorway: Doorway; kind: SecretKind };

/** Every doorway that may turn secret, by kind, in doorway order. */
export function secretCandidates(input: { doorways: readonly Doorway[]; links: readonly Link[]; entrance: number; stub: Doorway | null; locked: (d: Doorway) => boolean }): Candidate[] {
  const { doorways, links } = input;
  const byRoom = new Map<number, Doorway[]>();
  for (const d of doorways) byRoom.set(d.room, [...(byRoom.get(d.room) ?? []), d]);
  const eligible = (d: Doorway) => d !== input.stub && d.link >= 0 && d.run === null && !input.locked(d);
  const out: Candidate[] = [];
  for (const d of doorways) {
    if (!eligible(d)) continue;
    if (links[d.link]!.kind === "loop") out.push({ doorway: d, kind: "loop" });
    else if (d.room !== input.entrance && byRoom.get(d.room)!.length === 1) out.push({ doorway: d, kind: "leaf" });
  }
  return out;
}

/**
 * A flood over the painted squares from the entrance room, through every
 * doorway but those in `walls`, which it treats as wall. Room squares and
 * corridors meet only across doorways, so a doorway's edges are the only
 * ones it can be stopped at.
 */
export function floodFrom(board: Board, painted: (k: number) => boolean, entrance: number, walls: readonly Doorway[]): Uint8Array {
  const W = board.W;
  const blocked = new Set<string>();
  for (const d of walls) d.inside.forEach((k, j) => blocked.add(`${Math.min(k, d.outside[j]!)},${Math.max(k, d.outside[j]!)}`));
  const seen = new Uint8Array(W * board.H);
  const r = board.rooms[entrance]!;
  const queue: number[] = [];
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const k = board.cell(x, y);
      if (painted(k)) {
        seen[k] = 1;
        queue.push(k);
      }
    }
  }
  while (queue.length > 0) {
    const k = queue.pop()!;
    const x = k % W;
    for (const n of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W, k + W]) {
      if (n < 0 || n >= seen.length || seen[n] === 1 || !painted(n)) continue;
      if (blocked.has(`${Math.min(k, n)},${Math.max(k, n)}`)) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return seen;
}

/** Whether a flood reaches any square of a room. */
function reaches(board: Board, seen: Uint8Array, room: number, painted: (k: number) => boolean): boolean {
  const r = board.rooms[room]!;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (seen[board.cell(x, y)] === 1 && painted(board.cell(x, y))) return true;
  return false;
}

/**
 * Whether a set of secret doors keeps the dungeon whole: a flood with
 * every one a wall reaches every kept room but the secret rooms, and each
 * secret room is reached once its own secret door opens.
 */
export function stillWhole(board: Board, painted: (k: number) => boolean, entrance: number, kept: readonly number[], secret: readonly Candidate[]): boolean {
  const walls = secret.map((c) => c.doorway);
  const all = floodFrom(board, painted, entrance, walls);
  const rooms = new Set(secret.filter((c) => c.kind === "leaf").map((c) => c.doorway.room));
  for (const i of kept) if (!rooms.has(i) && !reaches(board, all, i, painted)) return false;
  for (const c of secret) {
    if (c.kind !== "leaf") continue;
    const open = floodFrom(board, painted, entrance, walls.filter((d) => d !== c.doorway));
    if (!reaches(board, open, c.doorway.room, painted)) return false;
  }
  return true;
}

/**
 * The secret doors (5.3): up to `count`, drawn in turn from the secrets
 * lane, each time a kind with a candidate left at even odds and then one of
 * its candidates, kept only while the dungeon stays whole.
 */
export function chooseSecrets(rng: Stream, candidates: readonly Candidate[], count: number, whole: (secret: readonly Candidate[]) => boolean): Candidate[] {
  const out: Candidate[] = [];
  let left = [...candidates];
  while (out.length < count && left.length > 0) {
    const kinds = (["loop", "leaf"] as const).filter((k) => left.some((c) => c.kind === k));
    const kind = rng.pick(kinds);
    const pick = rng.pick(left.filter((c) => c.kind === kind));
    left = left.filter((c) => c !== pick);
    if (whole([...out, pick])) out.push(pick);
  }
  return out;
}
