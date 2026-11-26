import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import type { BuildChunk, Trap } from "#shared/model.ts";
import { trap as makeTrap } from "#shared/testutil.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import type { IsoGround } from "../../canvas/relief/context.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import type { Box } from "../../lib/boardText.ts";
import { isometric, type Turn } from "../../lib/view.ts";
import { boxCoversOutline, cornersOf, drawnBox, outlineOf, type Outline } from "../floors/linkMarks.ts";

const { isoTrapBadges, isoTrapNameMarkers, isoTrapNamePill, isoTrapNames, linkFrames, trapNamePill } = await import("./TrapLayer.tsx");

before(() => {
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 7 }) };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => context }) };
});

/*
 * Isometric's trap names placed together (LP52-ISO-NAMES-PHONE): on a small
 * map a trap's name keeps off the names placed before it, the other traps'
 * squares and badges, the floor links' frames and pills, and the creatures
 * and their text, cut short where it has no room whole, and hidden behind its
 * badge where it has none cut either.
 */

const SCENE = "s1";
const ground = () => 0;
const isoAt = (turn: Turn): IsoGround => ({ turn, fog: new FogView(null, SCENE, { w: 16, h: 12 }), heights: false, uprightLabels: new Set(), place: "upright", ground });
const meet = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

const rig = makeTrap("x").rig;
const trapOf = (id: string, name: string, cells: { x: number; y: number; w: number; h: number }[]): Trap => makeTrap(id, { name, zone: { cells }, rig });

/** What a shown name covers as it draws, by kind: another name, another trap's squares or badge, a frame, a link's pill, or a creature's box. */
function coversOf(traps: Record<string, Trap>, names: Map<string, PillSpec | null>, frames: readonly Outline[], iso: IsoGround, scale: number, view: Box | null, boxes: readonly Box[], pills: readonly PillSpec[], grid: Grid = SQUARES, chunks: Readonly<Record<string, BuildChunk>> = {}): string[] {
  const out: string[] = [];
  const shown = [...names].flatMap(([id, p]) => (p ? [{ id, box: drawnBox(p, scale, iso, true, true, view) }] : []));
  shown.forEach((a, i) => {
    for (const b of shown.slice(i + 1)) if (meet(a.box, b.box)) out.push(`${a.id} on ${b.id}'s name`);
    for (const t of Object.values(traps)) {
      if (t.id === a.id) continue;
      if ("cells" in t.zone && t.zone.cells.some((r) => boxCoversOutline(a.box, cornersOf(outlineOf(grid, r)), iso))) out.push(`${a.id} on ${t.id}'s squares`);
      if (isoTrapBadges(grid, SCENE, { [t.id]: t }, chunks, scale, true, iso).some((b) => meet(a.box, b))) out.push(`${a.id} on ${t.id}'s badge`);
    }
    if (frames.some((o) => boxCoversOutline(a.box, cornersOf(o), iso))) out.push(`${a.id} on a frame`);
    if (pills.some((p) => meet(a.box, drawnBox(p, scale, iso, true, true, view)))) out.push(`${a.id} on a link's pill`);
    if (boxes.some((b) => meet(a.box, b))) out.push(`${a.id} on a creature`);
  });
  return out;
}

/** A seeded crowd on an 8 by 6 floor: four to six traps of one square or two, a hole and stairs, a creature's box or two, and a link pill. */
function crowds(count: number) {
  let s = 52;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (n: number) => Math.floor(rand() * n);
  const names = ["Hidden Pit", "Corner Dart Trap Of Long Name", "Edge snare", "Tripwire", "Falling Net", "Poison Needle"];
  return Array.from({ length: count }, (_, k) => {
    const traps: Record<string, Trap> = {};
    for (let i = 0; i < 4 + pick(3); i++) {
      const id = `t${i}`;
      traps[id] = trapOf(id, names[i]!, [{ x: pick(8), y: pick(6), w: 1 + pick(2), h: 1 }]);
    }
    const links = { h: { id: "h", sceneId: SCENE, rect: { x: pick(7), y: pick(6), w: 2, h: 1 } }, s: { id: "s", sceneId: SCENE, rect: { x: pick(7), y: pick(5), w: 2, h: 2 } } };
    const creatures = Array.from({ length: 1 + pick(2) }, () => ({ x: pick(8), y: pick(6) }));
    return { k, traps, frames: linkFrames(SQUARES, SCENE, links), creatures, pill: { name: "Up to Belfry", value: "Not reached yet", x: links.s.rect.x + 1, y: links.s.rect.y, above: true, size: "map" as const, small: true, maxLines: 1 as const } };
  });
}

test("in a crowd on a small floor no trap name covers another name, another trap's squares or badge, a floor link's frame or pill, or a creature, at every turn, on a phone and a desk (LP52-ISO-NAMES-PHONE)", () => {
  let cut = 0;
  let hidden = 0;
  let shownTotal = 0;
  for (const c of crowds(60)) {
    for (const scale of [20, 26, 60]) {
      for (const turn of [0, 1, 2, 3] as const) {
        const iso = isoAt(turn);
        const view = isometric(turn);
        // Each creature as the board's boxes hold it: a box a cell across standing from its middle.
        const boxes = c.creatures.map((p) => {
          const v = drawnBox({ x: p.x + 0.5, y: p.y + 0.5, size: "map" }, scale, iso, true, true);
          return { x0: v.x0 - 0.5, y0: v.y0 - 1, x1: v.x0 + 0.5, y1: v.y0 + 0.2 };
        });
        const rest: Box = { x0: -12, y0: -2, x1: 12, y1: 12 };
        const names = isoTrapNames(SQUARES, SCENE, c.traps, {}, scale, true, c.frames, iso, rest, { view, ground, boxes }, [c.pill]);
        const at = `crowd ${c.k} at ${scale} px, turn ${turn}`;
        assert.deepEqual(coversOf(c.traps, names, c.frames, iso, scale, rest, boxes, [c.pill]), [], at);
        assert.equal(names.size, Object.keys(c.traps).length, `${at}: every trap is placed or hidden`);
        for (const [id, p] of names) {
          if (p === null) hidden++;
          else {
            shownTotal++;
            if (p.name !== c.traps[id]!.name) {
              cut++;
              assert.match(p.name!, /^\S.{2,}…$/, `${at}: a cut name keeps its first letters and an ellipsis`);
              assert.ok(c.traps[id]!.name.startsWith(p.name!.slice(0, -1).trimEnd()), `${at}: ${p.name} is a cut of ${c.traps[id]!.name}`);
            }
          }
        }
      }
    }
  }
  assert.ok(cut > 0 && hidden > 0 && shownTotal > hidden, `the crowds exercise every step: ${shownTotal} shown, ${cut} of them cut, ${hidden} hidden`);
});

test("a trap name with room keeps isoTrapNamePill's pick, and the link layer's markers are the names placed with no creature or link pill", () => {
  for (const turn of [0, 1, 2, 3] as const) {
    const iso = isoAt(turn);
    const view = isometric(turn);
    const traps = { a: trapOf("a", "Hidden Pit", [{ x: 2, y: 2, w: 2, h: 1 }]), b: trapOf("b", "Tripwire", [{ x: 10, y: 9, w: 1, h: 1 }]) };
    const frames = linkFrames(SQUARES, SCENE, { h: { id: "h", sceneId: SCENE, rect: { x: 4, y: 2, w: 2, h: 1 } } });
    const names = isoTrapNames(SQUARES, SCENE, traps, {}, 40, true, frames, iso, null);
    for (const t of Object.values(traps)) {
      const alone = isoTrapNamePill(trapNamePill(SQUARES, t, {}, 40, true, frames)!, SQUARES, t, {}, { view, ground, boxes: [] }, 40, () => true, frames, iso, null);
      assert.deepEqual(names.get(t.id), alone, `turn ${turn}: ${t.name}`);
    }
    assert.deepEqual(isoTrapNameMarkers(SQUARES, SCENE, traps, {}, 40, true, frames, iso, null), [...names.values()]);
  }
});

test("two traps side by side whose names would meet: the first keeps its spot and the second keeps off it, cut to its least between two creatures and hidden behind its badge where nothing fits", () => {
  const iso = isoAt(0);
  const view = isometric(0);
  const first = trapOf("a", "Corner Dart Trap Of Long Name", [{ x: 4, y: 4, w: 1, h: 1 }]);
  const second = trapOf("b", "Falling Net Of Great Size", [{ x: 5, y: 5, w: 1, h: 1 }]);
  const traps = { a: first, b: second };
  const alone = isoTrapNames(SQUARES, SCENE, { a: first }, {}, 26, true, [], iso, null).get("a");
  const names = isoTrapNames(SQUARES, SCENE, traps, {}, 26, true, [], iso, null);
  assert.deepEqual(names.get("a"), alone, "the first placed keeps its spot");
  assert.deepEqual(coversOf(traps, names, [], iso, 26, null, [], []), []);
  assert.ok(names.get("b"), "the second finds a spot");
  // Two creatures either side of the second leave room only for its least cut, and a crowd over it none at all.
  const mid = drawnBox({ x: 5.5, y: 5.5, size: "map" }, 26, iso, true, true).x0;
  const sides: Box[] = [{ x0: mid - 9, y0: -4, x1: mid - 1.1, y1: 12 }, { x0: mid + 1.1, y0: -4, x1: mid + 9, y1: 12 }];
  const squeezed = isoTrapNames(SQUARES, SCENE, { b: second }, {}, 26, true, [], iso, null, { view, ground, boxes: sides }).get("b");
  assert.equal(squeezed?.name, "Fall…", "between two creatures the name is cut to its least");
  assert.deepEqual(coversOf({ b: second }, new Map([["b", squeezed!]]), [], iso, 26, null, sides, []), []);
  const shut = isoTrapNames(SQUARES, SCENE, { b: second }, {}, 26, true, [], iso, null, { view, ground, boxes: [{ x0: -20, y0: -20, x1: 20, y1: 20 }] }).get("b");
  assert.equal(shut, null, "with no room at all the name hides");
});

test("a wire, a door and squares crowded round two creatures keep off each other and the creatures at every turn, each wire and door name pointing at its own line (ISOLAB F3)", () => {
  const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: SCENE, cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls: [{ id: "door", a: [3, 2], b: [3, 4], f: { kind: "door", state: "closed", secret: false, discovered: false } }] } };
  const traps: Record<string, Trap> = {
    a: trapOf("a", "Hidden Pit", [{ x: 1, y: 2, w: 2, h: 1 }]),
    b: makeTrap("b", { name: "Tripwire Across The Hall", zone: { wire: { a: [1, 3], b: [5, 3] } }, rig }),
    c: makeTrap("c", { name: "Poison Needle Door", zone: { door: { cx: 0, cy: 0, id: "door" } }, rig }),
  };
  let lines = 0;
  for (const scale of [20, 40]) for (const turn of [0, 1, 2, 3] as const) {
    const iso = isoAt(turn);
    const view = isometric(turn);
    const boxes = [{ x: 2, y: 3 }, { x: 4, y: 2 }].map((p) => {
      const v = drawnBox({ x: p.x + 0.5, y: p.y + 0.5, size: "map" }, scale, iso, true, true);
      return { x0: v.x0 - 0.5, y0: v.y0 - 1, x1: v.x0 + 0.5, y1: v.y0 + 0.2 };
    });
    const names = isoTrapNames(SQUARES, SCENE, traps, chunks, scale, true, [], iso, null, { view, ground, boxes });
    assert.deepEqual(coversOf(traps, names, [], iso, scale, null, boxes, [], SQUARES, chunks), [], `turn ${turn} at ${scale} px`);
    const onLine = (p: PillSpec, a: [number, number], b: [number, number]) => Math.abs((b[0] - a[0]) * (p.y - a[1]) - (b[1] - a[1]) * (p.x - a[0])) < 1e-9 && p.x >= Math.min(a[0], b[0]) - 1e-9 && p.x <= Math.max(a[0], b[0]) + 1e-9;
    const wire = names.get("b");
    const door = names.get("c");
    if (wire) assert.ok(onLine(wire, [1, 3], [5, 3]), `turn ${turn}: the wire's name points at the wire`);
    if (door) assert.ok(onLine({ ...door, x: door.y, y: door.x }, [2, 3], [4, 3]), `turn ${turn}: the door's name points at the door`);
    lines += (wire ? 1 : 0) + (door ? 1 : 0);
  }
  assert.ok(lines > 0, "some wire or door name shows");
});

for (const orient of ["rows", "columns"] as const) test(`on hex ${orient} a crowd's names keep off each other, the other traps' hexes and badges and the frames at every turn (ISOLAB F3)`, () => {
  const grid = { shape: "hex", orient } as Grid;
  const traps: Record<string, Trap> = {
    a: trapOf("a", "Hidden Pit", [{ x: 2, y: 2, w: 2, h: 1 }]),
    b: trapOf("b", "Corner Dart Trap Of Long Name", [{ x: 4, y: 3, w: 1, h: 1 }]),
    c: trapOf("c", "Edge snare", [{ x: 2, y: 4, w: 1, h: 1 }]),
    d: trapOf("d", "Tripwire", [{ x: 5, y: 2, w: 1, h: 1 }]),
  };
  const frames = linkFrames(grid, SCENE, { h: { id: "h", sceneId: SCENE, rect: { x: 3, y: 4, w: 2, h: 1 } } });
  for (const scale of [20, 40]) for (const turn of [0, 1, 2, 3] as const) {
    const iso = isoAt(turn);
    const names = isoTrapNames(grid, SCENE, traps, {}, scale, true, frames, iso, null);
    assert.deepEqual(coversOf(traps, names, frames, iso, scale, null, [], [], grid), [], `turn ${turn} at ${scale} px`);
    assert.equal(names.size, 4);
  }
});

test("under the fog a name the stand rule lays flat keeps Top-down's spot and is never a marker for the link layer (ISOLAB F3)", () => {
  const traps: Record<string, Trap> = { a: trapOf("a", "Hidden Pit", [{ x: 2, y: 2, w: 2, h: 1 }]), b: trapOf("b", "Tripwire", [{ x: 3, y: 3, w: 1, h: 1 }]) };
  const frames = linkFrames(SQUARES, SCENE, { h: { id: "h", sceneId: SCENE, rect: { x: 4, y: 2, w: 2, h: 1 } } });
  for (const turn of [0, 1, 2, 3] as const) {
    // A viewer who has revealed nothing: no pill stands anywhere.
    const fogged: IsoGround = { ...isoAt(turn), fog: new FogView({}, SCENE, { w: 16, h: 12 }) };
    const names = isoTrapNames(SQUARES, SCENE, traps, {}, 40, false, frames, fogged, null);
    for (const t of Object.values(traps)) assert.deepEqual(names.get(t.id), trapNamePill(SQUARES, t, {}, 40, false, frames), `turn ${turn}: ${t.name} lies flat where Top-down puts it`);
    assert.deepEqual(isoTrapNameMarkers(SQUARES, SCENE, traps, {}, 40, false, frames, fogged, null), [], `turn ${turn}: no marker`);
  }
});
