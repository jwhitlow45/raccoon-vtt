import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { CellRect, Token, Trap, TrapRig } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { canApply } from "#shared/permissions.ts";
import { occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexKey, hexLine, sceneHexSpan, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { hexStandPlace } from "#shared/rules/movement.ts";
import { planTrapMove, type TrapRoom } from "#shared/rules/traps.ts";
import { DM, P1, env, int, rng, room, scene, token } from "#shared/testutil.ts";
import { crossedTraps, newTrapInput, rectBetween, START_BLANK, tapRect, tokensOn, trapAt, wireBetween, wireEnd, zoneBox, hitsSummary } from "./rules.ts";
import { zoneKinds } from "./store.ts";

const { pickLine, trapTool, zoneHint } = await import("./TrapTool.tsx");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { useTrapCrossing } = await import("./Crossing.tsx");

/**
 * The Trap tool on a hex scene (docs/design-v1-hex-grids.md phase H2): it
 * draws rectangles of hex keys, snaps a wire's ends to hex corners, finds a
 * trap by the hex under a tap, warns of the traps a drag crosses as the
 * server sets them off, and speaks of hexes.
 */
const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const GRIDS = [ROWS, COLUMNS];
const BOUNDS = { w: 30, h: 20 };

describe("drawing a zone of hexes", () => {
  test("a drag's rectangle runs between the hexes under its ends, kept to the scene's keys and 20 a side", () => {
    for (const g of GRIDS) {
      const a = { x: 3.2, y: 2.9 };
      const b = { x: 7.7, y: 6.1 };
      const ha = hexAt(g, a);
      const hb = hexAt(g, b);
      assert.deepEqual(rectBetween(g, a, b, BOUNDS), { x: Math.min(ha.col, hb.col), y: Math.min(ha.row, hb.row), w: Math.abs(hb.col - ha.col) + 1, h: Math.abs(hb.row - ha.row) + 1 }, g.orient);
      const span = sceneHexSpan(g, BOUNDS);
      const far = rectBetween(g, { x: 0, y: 0 }, { x: 99, y: 99 }, BOUNDS);
      assert.ok(far.x + far.w <= span.cols && far.y + far.h <= span.rows && far.w <= LIMITS.trapRectSide && far.h <= LIMITS.trapRectSide, `${g.orient}: ${JSON.stringify(far)}`);
    }
    // A 30 by 20 scene on hex rows has 22 rows: a tap below the last row's center draws on row 21, past where its cells stop.
    assert.equal(rectBetween(ROWS, { x: 5, y: 19.9 }, { x: 5, y: 19.9 }, BOUNDS).y, 21);
  });

  test("a drag or a tap at the scene's edge keeps every hex of its rectangle on the scene, as the server asks", () => {
    const r = rng(17);
    const offScene = (g: HexGrid, rect: CellRect) => {
      for (let row = rect.y; row < rect.y + rect.h; row++) for (let col = rect.x; col < rect.x + rect.w; col++) if (!hexInScene(g, BOUNDS, { col, row })) return `${col},${row}`;
      return null;
    };
    for (let i = 0; i < 300; i++) {
      const g = GRIDS[i % 2]!;
      const a = { x: r() * 32 - 1, y: r() * 22 - 1 };
      const b = { x: r() * 32 - 1, y: r() * 22 - 1 };
      for (const rect of [rectBetween(g, a, b, BOUNDS), tapRect(g, a, START_BLANK, "1-4", BOUNDS), tapRect(g, a, "hidden-pit", "1-4", BOUNDS)]) {
        assert.equal(offScene(g, rect), null, `${g.orient}: ${JSON.stringify(rect)}`);
        assert.ok(rect.w >= 1 && rect.h >= 1);
      }
    }
  });

  test("on a scene too narrow for a preset's size, a tap gives up the keys off the scene instead", () => {
    // A 2 by 4 scene on hex rows: row 1 holds one hex, so a Hidden Pit's 2 by 2 cannot fit by moving back. Turned on hex columns.
    const cases: [HexGrid, { w: number; h: number }][] = [
      [ROWS, { w: 2, h: 4 }],
      [COLUMNS, { w: 4, h: 2 }],
    ];
    for (const [g, bounds] of cases) {
      for (const at of [{ x: 0.5, y: 0.5 }, { x: 1.5, y: 1.5 }, { x: 0.2, y: 3.8 }, { x: 3.8, y: 0.2 }]) {
        const rect = tapRect(g, at, "hidden-pit", "1-4", bounds);
        const keys: Hex[] = [];
        for (let row = rect.y; row < rect.y + rect.h; row++) for (let col = rect.x; col < rect.x + rect.w; col++) keys.push({ col, row });
        assert.ok(keys.length > 0 && keys.every((h) => hexInScene(g, bounds, h)), `${g.orient} at ${JSON.stringify(at)}: ${JSON.stringify(rect)}`);
      }
    }
    assert.deepEqual(tapRect(ROWS, { x: 0.5, y: 0.5 }, "hidden-pit", "1-4", { w: 2, h: 4 }), { x: 0, y: 0, w: 1, h: 2 });
  });

  for (const g of GRIDS) {
    const key = (along: number, across: number) => g.orient === "rows" ? { col: along, row: across } : { col: across, row: along };
    const boundsOf = (w: number, h: number) => g.orient === "rows" ? { w, h } : { w: h, h: w };
    const rectOf = (x: number, y: number, w: number, h: number) => g.orient === "rows" ? { x, y, w, h } : { x: y, y: x, w: h, h: w };
    const between = (a: Hex, b: Hex, bounds: { w: number; h: number }) => rectBetween(g, hexCenter(g, a), hexCenter(g, b), bounds);
    const accepted = (rect: CellRect, bounds: { w: number; h: number }) => {
      const s = room({ scenes: { s1: scene("s1", { gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", bounds }) } });
      const trap = newTrapInput({ grid: g, id: "edge", sceneId: "s1", start: START_BLANK, band: "1-4", zone: { cells: [rect] }, chunks: {} });
      assert.ok(canApply({ t: "trap.create", trap }, DM, s, { canUseAsset: () => true }).ok);
      assert.ok(applyOp(s, { t: "trap.create", trap }, DM, env(1)).ok);
    };

    for (const [bounds, a, b, expected] of [
      [boundsOf(20, 10), key(10, 2), key(19, 8), rectOf(10, 2, 9, 7)],
      [boundsOf(4, 4), key(3, 0), key(1, 2), rectOf(1, 0, 2, 3)],
    ] as const) {
      test(`${g.orient}: an edge drag keeps ${expected.w * expected.h} hexes instead of collapsing to one line (FU38-OPUS-1)`, () => {
        for (const [start, end] of [[a, b], [b, a]] as const) {
          const rect = between(start, end, bounds);
          assert.deepEqual(rect, expected);
          accepted(rect, bounds);
        }
      });
    }

    test(`${g.orient}: a tall edge drag keeps every line up to the 20-cell cap (FU38-OPUS-1)`, () => {
      const bounds = boundsOf(8, 40);
      const a = key(6, 0);
      const b = key(7, 36);
      assert.deepEqual(between(a, b, bounds), rectOf(6, 0, 1, LIMITS.trapRectSide));
      assert.deepEqual(between(b, a, bounds), rectOf(6, 17, 1, LIMITS.trapRectSide));
      accepted(between(a, b, bounds), bounds);
      accepted(between(b, a, bounds), bounds);
    });

    test(`${g.orient}: equal areas favor the line containing the dragged edge hex (FU38-OPUS-1)`, () => {
      const bounds = boundsOf(4, 4);
      for (const [a, b, expected] of [
        [key(2, 1), key(3, 2), rectOf(2, 2, 2, 1)],
        [key(3, 2), key(2, 1), rectOf(2, 2, 2, 1)],
        [key(3, 0), key(2, 1), rectOf(2, 0, 2, 1)],
        // The pointer can lie beyond a short line. An equal area must not prefer its missing edge hex.
        [key(2, 2), key(3, 1), rectOf(2, 1, 1, 2)],
      ] as const) {
        const rect = between(a, b, bounds);
        assert.deepEqual(rect, expected);
        accepted(rect, bounds);
      }
      const narrow = boundsOf(1, 4);
      assert.deepEqual(between(key(0, 0), key(0, 2), narrow), rectOf(0, 2, 1, 1), "when both endpoints are on the edge, prefer the pointer's line");
      assert.deepEqual(between(key(0, 2), key(0, 0), narrow), rectOf(0, 0, 1, 1));
    });
  }

  test("a preset on a one-hex-wide scene shrinks across empty staggered rows (H2-ASTRA-07)", () => {
    for (const g of GRIDS) {
      const bounds = g.orient === "rows" ? { w: 1, h: 4 } : { w: 4, h: 1 };
      for (const across of [0, 1, 2, 3]) {
        const at = hexCenter(g, g.orient === "rows" ? { col: 0, row: across } : { col: across, row: 0 });
        for (const start of [START_BLANK, "hidden-pit"]) {
          const rect = tapRect(g, at, start, "1-4", bounds);
          assert.equal(rect.w * rect.h, 1);
          assert.ok(hexInScene(g, bounds, { col: rect.x, row: rect.y }));
          const s = room({ scenes: { s1: scene("s1", { gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", bounds }) } });
          const trap = newTrapInput({ grid: g, id: "narrow", sceneId: "s1", start, band: "1-4", zone: { cells: [rect] }, chunks: {} });
          assert.ok(canApply({ t: "trap.create", trap }, DM, s, { canUseAsset: () => true }).ok);
          assert.ok(applyOp(s, { t: "trap.create", trap }, DM, env(1)).ok);
        }
      }
    }
  });

  test("a tap places one hex, or a preset's own size, on the hex tapped", () => {
    const at = { x: 5.4, y: 5.4 };
    const h = hexAt(ROWS, at);
    assert.deepEqual(tapRect(ROWS, at, START_BLANK, "1-4", BOUNDS), { x: h.col, y: h.row, w: 1, h: 1 });
    assert.deepEqual(tapRect(ROWS, at, "hidden-pit", "1-4", BOUNDS), { x: h.col, y: h.row, w: 2, h: 2 });
  });

  test("a wire's end snaps to the nearest hex corner, on the 1/64 lattice, and a long drag stops on a corner within 20 cells", () => {
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      const g = GRIDS[i % 2]!;
      const p = { x: int(r, 100, 2900) / 100, y: int(r, 100, 1900) / 100 };
      const [x, y] = wireEnd(g, p, BOUNDS);
      assert.ok(Number.isInteger(x * 64) && Number.isInteger(y * 64), `${x}, ${y}`);
      // A corner of the hex holding the point: no other corner is nearer.
      const corners = hexCorners(g, hexAt(g, p)).map((c) => cornerAt(g, c));
      assert.ok(corners.some((c) => c.x === x && c.y === y), `${g.orient}: ${p.x}, ${p.y} to ${x}, ${y}`);
      for (const c of corners) assert.ok(Math.hypot(x - p.x, y - p.y) <= Math.hypot(c.x - p.x, c.y - p.y) + 1e-9);
    }
    const a = wireEnd(ROWS, { x: 1, y: 1 }, BOUNDS);
    const long = wireBetween(ROWS, a, { x: 29, y: 19 }, BOUNDS)!;
    assert.ok(Math.hypot(long.b[0] - a[0], long.b[1] - a[1]) <= LIMITS.trapWireMax);
    assert.ok(Number.isInteger(long.b[0] * 64) && Number.isInteger(long.b[1] * 64));
    assert.equal(wireBetween(ROWS, a, { x: a[0] + 0.1, y: a[1] }, BOUNDS), null, "shorter than half a cell");
  });
});

describe("finding and reading a zone of hexes", () => {
  const plate = { id: "plate", sceneId: "s1", zone: { cells: [{ x: 4, y: 4, w: 2, h: 1 }] } };

  test("a tap finds a trap by the hex under it, not the cell", () => {
    const inside = placedOnHex(ROWS, { size: "medium", x: 0, y: 0 }, { col: 5, row: 4 });
    assert.equal(trapAt(ROWS, [plate], {}, { x: inside.x + 0.5, y: inside.y + 0.5 }, 0.1)?.id, "plate");
    // Cell 4,4 holds part of row 4 and of row 5: its point inside a row 5 hex finds nothing.
    const below = placedOnHex(ROWS, { size: "medium", x: 0, y: 0 }, { col: 4, row: 5 });
    assert.equal(trapAt(ROWS, [plate], {}, { x: below.x + 0.5, y: below.y + 0.5 }, 0.1), null);
  });

  test("its box holds its hexes, and the creatures on it are those with a hex on it", () => {
    const box = zoneBox(ROWS, plate, {})!;
    assert.ok(box.x0 >= 4 && box.x1 <= 7 && box.y0 > 3 && box.y1 < 5, JSON.stringify(box));
    const on = token("on", { ...placedOnHex(ROWS, { size: "medium", x: 0, y: 0 }, { col: 5, row: 4 }) });
    const off = token("off", { ...placedOnHex(ROWS, { size: "medium", x: 0, y: 0 }, { col: 4, row: 5 }) });
    assert.deepEqual(tokensOn(ROWS, plate, { tokens: { on, off }, characters: {} }), ["on"]);
  });
});

describe("the drag label on hexes", () => {
  function rig(over: Partial<TrapRig> = {}): TrapRig {
    return { on: ["enter"], who: "any", floor: false, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, ...over };
  }
  const trap = (id: string, zone: Trap["zone"], grid: "hexRows" | "hexColumns"): Trap => ({ id, rev: 0, sceneId: "s1", name: id, zone, state: "armed", found: true, rig: rig("wire" in zone ? { on: [] } : {}), grid });

  test("it warns of exactly the traps the server sets off on random walks, plates and wires alike", () => {
    const r = rng(17);
    let compared = 0;
    for (let i = 0; i < 300; i++) {
      const g = GRIDS[i % 2]!;
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      const from = { col: int(r, 1, 6), row: int(r, 1, 6) };
      const to = { col: int(r, 8, 16), row: int(r, 8, 14) };
      const size = (["medium", "large", "huge"] as const)[i % 3]!;
      const mover: Token = { ...token("m", { size, x: 0, y: 0 }), ...placedOnHex(g, { size, x: 0, y: 0 }, from) };
      const line = hexLine(g, from, to);
      const near: Hex = line[int(r, 0, line.length - 1)]!;
      const c0 = cornerAt(g, hexCorners(g, { col: near.col + int(r, -2, 2), row: near.row - 2 })[0]!);
      const c1 = cornerAt(g, hexCorners(g, { col: near.col + int(r, -2, 2), row: near.row + 2 })[3]!);
      const traps = [trap("plate", { cells: [{ x: near.col + int(r, -1, 1), y: near.row + int(r, -1, 1), w: int(r, 1, 2), h: int(r, 1, 2) }] }, shape), trap("wire", { wire: { a: [c0.x, c0.y], b: [c1.x, c1.y] } }, shape)];
      // A walk that starts on a plate is warned of it, as on squares, where the server sets off only what it steps onto.
      const plate = (traps[0]!.zone as { cells: CellRect[] }).cells[0]!;
      if (occupiedHexes(g, mover).some((h) => h.col >= plate.x && h.col < plate.x + plate.w && h.row >= plate.y && h.row < plate.y + plate.h)) continue;
      compared++;
      const state: TrapRoom = { ...room({ scenes: { s1: scene("s1", { gridShape: shape }) }, tokens: { m: mover } }), traps: Object.fromEntries(traps.map((t) => [t.id, t])) };
      const end = placedOnHex(g, mover, to);
      const server = planTrapMove({ t: "token.move", tokenId: "m", ...end }, state, DM, {}).springings.map((s) => s.trap.id).sort();
      const label = crossedTraps(g, traps, { w: size === "medium" ? 1 : size === "large" ? 2 : 3, h: size === "medium" ? 1 : size === "large" ? 2 : 3 }, [{ x: mover.x, y: mover.y }, end]).map((t) => t.id).sort();
      assert.deepEqual(label, server, `${g.orient} ${size} ${hexKey(from)} to ${hexKey(to)}`);
    }
    assert.ok(compared > 150, `${compared} walks compared`);
  });

  test("a walk that starts or ends squeezed is warned of only what its squeezed hexes meet, as the server sets it off (HX7-CROSSES-SQUEEZE)", () => {
    const r = rng(29);
    let compared = 0;
    for (let i = 0; i < 300; i++) {
      const g = GRIDS[i % 2]!;
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      const size = (["large", "huge"] as const)[Math.floor(i / 2) % 2]!;
      const small = size === "large" ? "medium" : "large";
      // Squeezed where it ends, where it starts, or both, as a walk into, out of or along a corridor stands.
      // A fourth way: full size, though it stands on a squeeze's anchors where it starts (review FU37-ASTRA-01).
      const how = Math.floor(i / 4) % 4;
      const startSqueezed = how === 1 || how === 2;
      const onSqueezedAnchors = how !== 0;
      const endSqueezed = how === 0 || how === 2;
      const from: Hex = { col: int(r, 2, 6), row: int(r, 2, 6) };
      const to: Hex = { col: int(r, 8, 16), row: int(r, 8, 14) };
      const base = token("m", { size, x: 0, y: 0 });
      const start = hexStandPlace(g, base, { size: onSqueezedAnchors ? small : size, ref: from, squeezed: onSqueezedAnchors });
      const mover: Token = { ...base, ...start, ...(startSqueezed ? { squeeze: true as const } : {}) };
      const end = hexStandPlace(g, base, { size: endSqueezed ? small : size, ref: to, squeezed: endSqueezed });
      const line = hexLine(g, from, to);
      const near: Hex = line[int(r, 1, line.length - 1)]!;
      const c0 = cornerAt(g, hexCorners(g, { col: near.col + int(r, -2, 2), row: near.row - 2 })[0]!);
      const c1 = cornerAt(g, hexCorners(g, { col: near.col + int(r, -2, 2), row: near.row + 2 })[3]!);
      const traps = [trap("plate", { cells: [{ x: near.col + int(r, -2, 2), y: near.row + int(r, -2, 2), w: 1, h: 1 }] }, shape), trap("wire", { wire: { a: [c0.x, c0.y], b: [c1.x, c1.y] } }, shape)];
      const plate = (traps[0]!.zone as { cells: CellRect[] }).cells[0]!;
      if (occupiedHexes(g, mover).some((h) => h.col === plate.x && h.row === plate.y)) continue;
      compared++;
      const state: TrapRoom = { ...room({ scenes: { s1: scene("s1", { gridShape: shape }) }, tokens: { m: mover } }), traps: Object.fromEntries(traps.map((t) => [t.id, t])) };
      const op = { t: "token.move" as const, tokenId: "m", ...end, ...(endSqueezed ? { squeeze: true as const } : {}) };
      const server = planTrapMove(op, state, DM, {}).springings.map((s) => s.trap.id).sort();
      const side = size === "large" ? 2 : 3;
      const label = crossedTraps(g, traps, { w: side, h: side, squeeze: startSqueezed }, [{ x: mover.x, y: mover.y }, end]).map((t) => t.id).sort();
      assert.deepEqual(label, server, `${g.orient} ${size} ${startSqueezed ? "squeezed" : "full"} ${hexKey(from)} to ${endSqueezed ? "squeezed" : "full"} ${hexKey(to)}`);
    }
    assert.ok(compared > 150, `${compared} walks compared`);
  });

  for (const g of GRIDS) {
    test(`${g.orient}: a full token on squeezed anchors warns of the plate the server springs (review FU37-ASTRA-01)`, () => {
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      const base = token("m", { size: "large", x: 0, y: 0, ownerIds: [P1.memberId] });
      // Left on the Medium anchor of hex (3,4) by a drag or a placement off the grid, unsqueezed.
      const mover: Token = { ...base, ...hexStandPlace(g, base, { size: "medium", ref: { col: 3, row: 4 }, squeezed: true }) };
      const end = hexStandPlace(g, base, { size: "large", ref: { col: 10, row: 4 }, squeezed: false });
      const traps = [trap("plate", { cells: [{ x: 6, y: 5, w: 1, h: 1 }] }, shape)];
      const state: TrapRoom = { ...room({ scenes: { s1: scene("s1", { gridShape: shape }) }, tokens: { m: mover } }), traps: { plate: traps[0]! } };
      const op = { t: "token.move" as const, tokenId: "m", ...end };
      assert.ok(canApply(op, P1, state, { canUseAsset: () => true }).ok, "the player can make this move");
      const server = planTrapMove(op, state, P1, {}).springings.map((x) => x.trap.id);
      assert.deepEqual(server, ["plate"], `${g.orient}: the server sets the plate off`);
      assert.deepEqual(crossedTraps(g, traps, { w: 2, h: 2, squeeze: mover.squeeze }, [{ x: mover.x, y: mover.y }, end]).map((t) => t.id), ["plate"], `${g.orient}: the warning names it`);
      // Exercise the label's caller too: the same coordinates mean different walks with and without the token's flag.
      const store = createStore(() => ({ view: state, you: P1 }));
      for (const squeeze of [undefined, true] as const) {
        function Warning() {
          return useTrapCrossing({ ...mover, squeeze }, [mover, end])?.value ?? "";
        }
        const text = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(Warning) }));
        assert.equal(text, squeeze ? "" : "Crosses plate", `${g.orient}: the label reads the starting flag ${squeeze}`);
      }
    });
  }
});

describe("a new trap on hexes", () => {
  test("from H3 a Hidden Pit starts with its pit on hexes as on squares, and a wire's hexes to draw start round its hexes", () => {
    const pit = newTrapInput({ grid: ROWS, id: "t", sceneId: "s1", start: "hidden-pit", band: "1-4", zone: { cells: [{ x: 3, y: 3, w: 2, h: 2 }] }, chunks: {} });
    assert.ok(pit.rig.pit, "a pit on hexes");
    const squares = newTrapInput({ grid: { shape: "squares" }, id: "t", sceneId: "s1", start: "hidden-pit", band: "1-4", zone: { cells: [{ x: 3, y: 3, w: 2, h: 2 }] }, chunks: {} });
    assert.ok(squares.rig.pit, "a pit on squares");
  });
});

describe("the tool's words and gestures on hexes", () => {
  test("it speaks of hexes", () => {
    assert.equal(zoneHint(ROWS, "squares"), "Drag across the hexes of a new trap, or tap to place it at its own size.");
    assert.equal(pickLine(ROWS, "hits", "Spikes"), "Drag across the hexes Spikes hits, or tap one hex.");
    assert.equal(zoneKinds(ROWS)[0]!.label, "Hexes");
    assert.equal(zoneKinds({ shape: "squares" })[0]!.label, "Squares");
    assert.equal(hitsSummary(ROWS, { ...newTrapInput({ grid: ROWS, id: "t", sceneId: "s1", start: START_BLANK, band: "1-4", zone: { cells: [{ x: 1, y: 1, w: 1, h: 1 }] }, chunks: {} }).rig, hits: { cells: [{ x: 1, y: 1, w: 2, h: 1 }] } }), "Everyone in 2 drawn hexes");
  });

  test("a hex scene's gestures reach the tool's state, as a square scene's do", () => {
    const boom = () => {
      throw new Error("reached the tool's state");
    };
    const ctx = { scene: { id: "s", gridShape: "hexRows", bounds: { w: 10, h: 10 } }, scope: { get: boom }, actions: { dispatch: boom, newId: boom }, ui: { notify: boom }, getState: boom, camera: boom } as never;
    assert.throws(() => trapTool.pointer!.down!({ screen: { x: 1, y: 1 }, world: { x: 1, y: 1 } } as never, ctx), /reached the tool's state/);
  });
});
