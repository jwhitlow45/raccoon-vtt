import { footprint, type ViewToken } from "../../lib/scene.ts";
import type { Turn } from "../../lib/view.ts";
import { pressCells } from "../isoPlace.ts";
import type { IsoToken } from "../TokenNode.tsx";

const NO_RINGS: readonly string[] = [];

/** A flat creature's press area on the drawn ground, kept while its geometry stays the same. */
export function flatPressTokens(previous: ReadonlyMap<string, IsoToken>, tokens: readonly ViewToken[], turn: Turn, ground: (token: ViewToken) => number, groundAt: (x: number, y: number) => number): Map<string, IsoToken> {
  const next = new Map<string, IsoToken>();
  for (const t of tokens) {
    const base = ground(t);
    const fresh: IsoToken = { turn, base, ground: base, drawn: base, capped: false, rise: 0, inset: 1, pits: [], dim: false, pressOnly: true, press: pressCells({ x: t.x, y: t.y }, footprint(t), groundAt) };
    const old = previous.get(t.id);
    next.set(t.id, old && sameIso(old, fresh) ? old : fresh);
  }
  return next;
}

/** The areas context reads membership only, so a new layout with the same pairs need not redraw every placed area. */
export function keepRingPairs(previous: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  return previous.size === next.size && [...next].every((pair) => previous.has(pair)) ? previous : next;
}

export function sameIso(a: IsoToken, b: IsoToken): boolean {
  return (
    a.turn === b.turn &&
    a.base === b.base &&
    a.drawn === b.drawn &&
    a.ground === b.ground &&
    a.capped === b.capped &&
    a.rise === b.rise &&
    a.inset === b.inset &&
    a.dim === b.dim &&
    a.pressOnly === b.pressOnly &&
    a.press.length === b.press.length &&
    a.press.every((c, i) => { const d = b.press[i]!; return c.x === d.x && c.y === d.y && c.w === d.w && c.h === d.h && c.z === d.z; }) &&
    a.pits.length === b.pits.length &&
    a.pits.every((p, i) => p.x === b.pits[i]!.x && p.y === b.pits[i]!.y) &&
    (a.rings ?? NO_RINGS).length === (b.rings ?? NO_RINGS).length &&
    (a.rings ?? NO_RINGS).every((c, i) => c === b.rings![i])
  );
}
