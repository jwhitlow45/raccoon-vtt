import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardSizes, PIN_CELL_PX, TEXT_FLOOR_PX } from "./boardScale.ts";
import {
  cutName,
  focusLines,
  focusStyle,
  labelStyle,
  MIN_CUT_LETTERS,
  overlaps,
  placeLabels,
  showsNumberBadge,
  templates,
  wrapWhole,
  type Box,
  type LabelInput,
  type LabelStyle,
  type Measure,
  type Obstacle,
  type PlacedLabel,
  type Room,
  type Side,
} from "./boardText.ts";

/** Every character is half an em wide, so 12 px text is 6 px a character. */
const measure = (text: string, px: number) => [...text].length * px * 0.5;

function style(cell: number): LabelStyle {
  const namePx = Math.max(11, Math.min(16, (12 * cell) / 40));
  return labelStyle({ namePx, hpPx: Math.max(11, Math.min(15, (11 * cell) / 40)), gapPx: 3, unrounded: { namePx, gapPx: 3 } }, cell, cell);
}

type Spec = { id: string; x: number; y: number; size?: number; name: string; number?: number; hp?: string | null; alert?: boolean; rank?: number; label?: boolean };

/** Tokens on a grid of `cell` px, as useBoardText.ts hands them over: bodies for every token, a label input for those with `label` not false. */
function board(cell: number, specs: Spec[]): { inputs: LabelInput[]; obstacles: Obstacle[] } {
  const obstacles: Obstacle[] = [];
  const inputs: LabelInput[] = [];
  for (const s of specs) {
    const size = (s.size ?? 1) * cell;
    const box: Box = { x0: s.x * cell, y0: s.y * cell, x1: s.x * cell + size, y1: s.y * cell + size };
    obstacles.push({ box, owner: s.id, kind: "body" });
    if (s.label === false) continue;
    const st = style(cell);
    inputs.push({
      id: s.id,
      box,
      belowY: box.y1 + st.gapPx,
      aboveY: box.y0 - st.gapPx,
      name: s.name,
      number: s.number,
      hp: s.hp ?? null,
      alert: s.alert ?? false,
      rank: s.rank ?? 0,
      sides: (s.rank ?? 0) >= 2,
      nameOnly: false,
      style: st,
    });
  }
  return { inputs, obstacles };
}

function place(cell: number, specs: Spec[], previous?: Map<string, "below" | "above" | "right" | "left">) {
  const { inputs, obstacles } = board(cell, specs);
  return { placed: placeLabels(inputs, obstacles, measure, previous), obstacles };
}

const texts = (p: PlacedLabel | undefined) => (p?.lines ?? []).map((l) => l.text);

/** No label covers a body but its own, and no two labels overlap. */
function assertClear(placed: Map<string, PlacedLabel>, obstacles: readonly Obstacle[]) {
  const shown = [...placed].filter(([, p]) => p.lines.length > 0);
  for (const [id, p] of shown) {
    for (const o of obstacles) {
      if (o.owner === id) continue;
      assert.ok(!overlaps(p.box, o.box), `${id}'s label covers ${o.owner}'s body`);
    }
    for (const [other, q] of shown) if (other !== id) assert.ok(!overlaps(p.box, q.box), `${id}'s label overlaps ${other}'s`);
  }
}

/** A shown name is whole, or cut keeping at least four letters and its number. */
function assertNoFragments(placed: Map<string, PlacedLabel>) {
  for (const [, p] of placed) {
    for (const line of p.lines) {
      if (line.kind !== "name" || !line.text.includes("…")) continue;
      const kept = line.text.split("…")[0]!.replace(/\s/g, "");
      assert.ok([...kept].length >= MIN_CUT_LETTERS, `"${line.text}" keeps fewer than four letters`);
    }
  }
}

describe("names", () => {
  test("wrap whole onto two balanced lines, the number glued to the last word", () => {
    assert.deepEqual(wrapWhole("Owlbear Matriarch of the Thornwood", undefined, 120, 2, 12, measure), ["Owlbear Matriarch", "of the Thornwood"]);
    assert.deepEqual(wrapWhole("Kobold Scale Sorcerer", 4, 80, 2, 12, measure), ["Kobold Scale", "Sorcerer 4"]);
  });

  test("two lines only when the whole name fits them", () => {
    assert.equal(wrapWhole("Kobold Scale Sorcerer", 4, 50, 2, 12, measure), null);
    assert.equal(wrapWhole("Grand Inquisitor Malachar the Unrelenting", undefined, 120, 2, 12, measure), null);
  });

  test("a word wider than a line breaks with a hyphen, only when the whole name then fits", () => {
    const lines = wrapWhole("Bartholomewsworth", undefined, 60, 2, 12, measure)!;
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.endsWith("-"));
    assert.equal(lines.join("").replace("-", ""), "Bartholomewsworth");
    assert.equal(wrapWhole("Bartholomewsworthingtonshire", undefined, 60, 2, 12, measure), null);
  });

  test("a duplicate's number stays whole, and no line strands a hyphen or starts with a space, at any width", () => {
    const sweep = (name: string, number: number, from: number, to: number) => {
      for (let width = from; width <= to; width++) {
        const lines = wrapWhole(name, number, width, 2, 12, measure);
        if (!lines) continue;
        for (const line of lines) {
          assert.doesNotMatch(line, / -$|^ |\d-$/, `"${line}" at ${width} px`);
          assert.ok(measure(line, 12) <= width, `"${line}" fits ${width} px`);
        }
        assert.ok(lines.some((line) => new RegExp(`(^| )${number}$`).test(line)), `${JSON.stringify(lines)} keeps ${number} whole at ${width} px`);
        assert.equal(lines.join(" ").replace(/- /g, ""), `${name} ${number}`, `${JSON.stringify(lines)} at ${width} px`);
      }
    };
    sweep("Bartholomewsworth", 12, 60, 140);
    sweep("Bartholomewsworth", 1, 60, 140);
    sweep("Kobold Scale Sorcerer", 14, 50, 75);
    sweep("Sorcerer", 14, 30, 75);
  });

  test("balancing never widens a wrap past a fractional width the lines fit", () => {
    // Each word fits 40.5 px, but neither fits the 40 px a floored width would give.
    const narrow = (text: string) => text.length * 8.05;
    assert.deepEqual(wrapWhole("Alpha Bravo", undefined, 40.5, 2, 12, narrow), ["Alpha", "Bravo"]);
    for (const width of [40.25, 40.5, 40.75, 48.3, 60.9]) {
      const lines = wrapWhole("Alpha Bravo Charlie", undefined, width, 3, 12, narrow);
      if (!lines) continue;
      for (const line of lines) assert.ok(narrow(line) <= width, `"${line}" fits ${width} px`);
    }
  });

  test("a cut keeps the number and at least four letters, or does not happen", () => {
    assert.equal(cutName("Kobold Scale Sorcerer", 4, 60, 12, measure), "Kobold… 4");
    assert.equal(cutName("Bartholomewsworthingtonshire", undefined, 60, 12, measure), "Bartholom…");
    assert.equal(cutName("Kobold Scale Sorcerer", 4, 40, 12, measure), null, "Kob… 4 would keep three letters");
  });
});

describe("label placement", () => {
  test("a short neighbor leaves a long name whole", () => {
    // The owner's phone shot: "Goblin W…" two cells from "Thorn".
    const { placed } = place(34, [
      { id: "thorn", x: 0, y: 0, name: "Thorn", rank: 1 },
      { id: "goblin", x: 2, y: 0, name: "Goblin Warrior" },
    ]);
    assert.deepEqual(texts(placed.get("goblin")), ["Goblin Warrior"]);
  });

  test("a label never covers another creature's body, so the upper row of a pack hangs its labels above it", () => {
    const { placed, obstacles } = place(40, [
      { id: "a", x: 0, y: 0, name: "Ann" },
      { id: "b", x: 0, y: 1, name: "Bob" },
    ]);
    assert.equal(placed.get("a")!.side, "above");
    assert.equal(placed.get("b")!.side, "below");
    assertClear(placed, obstacles);
  });

  test("tokens too small for a label of their own still keep labels off their bodies", () => {
    const { placed } = place(40, [
      { id: "orc", x: 0, y: 0, name: "Orc" },
      { id: "rat", x: 0.25, y: 1.1, size: 0.3, name: "Rat", label: false },
    ]);
    assert.equal(placed.get("orc")!.side, "above");
  });

  test("a label written on the map keeps its place: a token's label moves off it, or gives way", () => {
    const { inputs, obstacles } = board(40, [{ id: "chest", x: 2, y: 2, name: "Treasure chest", hp: "10/10" }]);
    // The DM's "The Drowned Chapel…" runs across the row under the chest.
    const chapel: Obstacle = { box: { x0: 0, y0: 125, x1: 400, y1: 145 }, kind: "map" };
    const moved = placeLabels(inputs, [...obstacles, chapel], measure);
    assert.equal(moved.get("chest")!.side, "above");
    assert.ok(!overlaps(moved.get("chest")!.box, chapel.box));
    // With map text above too, the label has nowhere to go and shows nothing rather than cover it.
    const banner: Obstacle = { box: { x0: 0, y0: 40, x1: 400, y1: 77 }, kind: "map" };
    const dropped = placeLabels(inputs, [...obstacles, chapel, banner], measure);
    assert.deepEqual(texts(dropped.get("chest")), []);
  });

  test("the acting creature places first, and moves to its side rather than cover a body", () => {
    const { placed, obstacles } = place(40, [
      { id: "hero", x: 1, y: 1, name: "Thorn Ironfoot", rank: 2 },
      { id: "n", x: 1, y: 0, name: "Up", label: false },
      { id: "s", x: 1, y: 2, name: "Down", label: false },
    ]);
    assert.ok(["right", "left"].includes(placed.get("hero")!.side));
    assert.deepEqual(texts(placed.get("hero")), ["Thorn Ironfoot"]);
    assertClear(placed, obstacles);
  });

  test("the acting creature's side label drops below its own chips when they run past its edge", () => {
    const { inputs, obstacles } = board(22, [
      { id: "hero", x: 5, y: 5, name: "Thorn", rank: 2 },
      { id: "n", x: 5, y: 4, name: "Up", label: false },
      { id: "s", x: 5, y: 6, name: "Down", label: false },
      { id: "w", x: 3.5, y: 5, size: 1.4, name: "Marker", label: false },
    ]);
    // Two chips on a 22 px token reach 6 px past its right edge, down to 7 px under its top.
    const chips: Obstacle = { box: { x0: 110, y0: 103, x1: 138, y1: 117 }, owner: "hero", kind: "mark" };
    const hero = { ...inputs[0]!, sideTopY: 117 + 3 };
    const placed = placeLabels([hero], [...obstacles, chips], measure);
    assert.equal(placed.get("hero")!.side, "right");
    assert.deepEqual(texts(placed.get("hero")), ["Thorn"]);
    assertClear(placed, [...obstacles, chips]);
  });

  test("rank decides who keeps a contested spot", () => {
    const specs: Spec[] = [
      { id: "goblin", x: 0, y: 0, name: "Goblin Warrior Captain" },
      { id: "hero", x: 1, y: 0, name: "Thorn Ironfoot", rank: 2 },
    ];
    const { placed } = place(40, specs);
    assert.deepEqual(texts(placed.get("hero")), ["Thorn Ironfoot"]);
    assert.equal(placed.get("hero")!.side, "below");
  });

  test("a Bloodied or Dying creature places before a healthy one of its rank, the DM's numbers included", () => {
    const specs: Spec[] = [
      { id: "a", x: 0, y: 0, name: "Goblin Warrior", number: 1, hp: "7/7" },
      { id: "b", x: 1, y: 0, name: "Goblin Warrior", number: 2, hp: "3/9", alert: true },
    ];
    const { placed } = place(40, specs);
    assert.deepEqual(texts(placed.get("b")), ["Goblin Warrior 2", "3/9"]);
  });

  // A spot under the token with room for one short line only: bodies below and to each side, and one above.
  const tight = (hp: string, alert: boolean): Spec[] => [
    { id: "rat", x: 0, y: 0, name: "Rat", hp, alert },
    { id: "below", x: 0, y: 1.5, name: "x", label: false },
    { id: "left", x: -1.25, y: 1, name: "x", label: false },
    { id: "right", x: 1.25, y: 1, name: "x", label: false },
    { id: "above", x: 0, y: -1, name: "x", label: false },
  ];

  test("ordinary HP gives way before the name", () => {
    const { placed, obstacles } = place(40, tight("Healthy", false));
    assert.deepEqual(texts(placed.get("rat")), ["Rat"]);
    assertClear(placed, obstacles);
  });

  test("Bloodied alone outlasts the name alone, and never sits on a neighbor", () => {
    const { placed, obstacles } = place(40, tight("Bloodied", true));
    assert.deepEqual(texts(placed.get("rat")), ["Bloodied"]);
    assertClear(placed, obstacles);
    const order = templates(board(40, tight("Bloodied", true)).inputs[0]!, measure);
    const wordAlone = order.findIndex((level) => level.some((t) => t.kind === "lines" && t.content.hpShown && !t.content.nameShown));
    const nameAlone = order.findIndex((level) => level.some((t) => t.kind === "lines" && t.content.nameShown && !t.content.hpShown));
    assert.ok(wordAlone >= 0 && wordAlone < nameAlone);
  });

  test("the owner's 34 px pack: no label on another body, none overlapping, no fragments", () => {
    const kobold = (n: number, x: number, y: number, extra: Partial<Spec> = {}): Spec => ({ id: `k${n}`, x, y, name: "Kobold Scale Sorcerer", number: n, hp: "Healthy", ...extra });
    const { placed, obstacles } = place(34, [
      kobold(1, 2, 8),
      kobold(2, 3, 8, { hp: "Bloodied", alert: true }),
      kobold(3, 4, 8),
      kobold(4, 2, 9),
      kobold(5, 3, 9),
      kobold(6, 4, 9),
      { id: "thorn", x: 5, y: 5, name: "Thorn Ironfoot", hp: "18/24 +5", rank: 2 },
    ]);
    assertClear(placed, obstacles);
    assertNoFragments(placed);
    assert.ok([...placed.values()].some((p) => p.lines.length > 0 && p.side === "above"), "the upper row hangs its labels above the pack");
    assert.ok(texts(placed.get("thorn")).length > 0, "the acting creature keeps its label");
    assert.ok(texts(placed.get("k2")).includes("Bloodied"), "the Bloodied kobold keeps its word");
  });

  test("a packed party of four keeps its bodies clear, the upper pair labelled above and the lower below", () => {
    const pc = (id: string, x: number, y: number): Spec => ({ id, x, y, name: id, hp: "20/20", rank: 1 });
    const party = [pc("Thorn", 0, 0), pc("Vex", 1, 0), pc("Pip", 0, 1), pc("Lia", 1, 1)];
    const { placed, obstacles } = place(40, party);
    assertClear(placed, obstacles);
    for (const id of ["Thorn", "Vex", "Pip", "Lia"]) assert.ok(texts(placed.get(id)).includes(id), `${id} keeps its name`);
    assert.equal(placed.get("Thorn")!.side, "above");
    assert.equal(placed.get("Lia")!.side, "below");
    // Closer together, what gives way gives way whole: bodies stay clear and no name is cut to a fragment.
    const tight = place(30, party);
    assertClear(tight.placed, tight.obstacles);
    assertNoFragments(tight.placed);
  });

  test("a picture duplicate whose name gave way shows its number on the token", () => {
    const named: PlacedLabel = { lines: [{ text: "Goblin… 3", px: 12, kind: "name" }], box: { x0: 0, y0: 0, x1: 1, y1: 1 }, side: "below", nameShown: true, hpShown: false, cut: true };
    const dropped: PlacedLabel = { ...named, lines: [], nameShown: false };
    assert.equal(showsNumberBadge({ image: true, number: 3, widthPx: 34 }, dropped), true);
    assert.equal(showsNumberBadge({ image: true, number: 3, widthPx: 34 }, named), false);
    assert.equal(showsNumberBadge({ image: false, number: 3, widthPx: 34 }, dropped), false, "a body without a picture shows its initials, number included");
    assert.equal(showsNumberBadge({ image: true, number: undefined, widthPx: 34 }, dropped), false);
  });

  test("a label holds its side across a zoom step while that side stays free", () => {
    const specs: Spec[] = [{ id: "orc", x: 0, y: 0, name: "Orc" }];
    assert.equal(place(40, specs).placed.get("orc")!.side, "below");
    assert.equal(place(41, specs, new Map([["orc", "above"]])).placed.get("orc")!.side, "above");
    const blocked: Spec[] = [...specs, { id: "n", x: 0, y: -1, name: "x", label: false }];
    assert.equal(place(41, blocked, new Map([["orc", "above"]])).placed.get("orc")!.side, "below");
  });

  test("placement does not depend on the order tokens arrive in", () => {
    const specs: Spec[] = [
      { id: "a", x: 0, y: 0, name: "Goblin Warrior", number: 1 },
      { id: "b", x: 1, y: 0, name: "Goblin Warrior", number: 2 },
      { id: "c", x: 2, y: 0, name: "Goblin Warrior", number: 3 },
    ];
    const forward = place(40, specs).placed;
    const backward = place(40, [...specs].reverse()).placed;
    for (const id of ["a", "b", "c"]) assert.deepEqual(texts(forward.get(id)), texts(backward.get(id)));
  });
});

describe("a smooth zoom", () => {
  // A name's size scales with the map between these zooms, held at its floor below and its 16 px ceiling above (boardScale.ts).
  const floorCell = (TEXT_FLOOR_PX / 12) * PIN_CELL_PX;
  const ceilingCell = (16 / 12) * PIN_CELL_PX;
  const step = (ceilingCell - floorCell) / 200;
  // 200 steps between them, and 60 more past each, where the room keeps growing with the token while the text holds still.
  const cells = Array.from({ length: 321 }, (_, i) => floorCell + (i - 60) * step);

  /** A font `em` wide a character, and one whose advances snap to quarter pixels, as hinting does, so its widths do not scale exactly with the size. */
  const fonts = (em: number): Measure[] => [(t, px) => [...t].length * px * em, (t, px) => [...t].length * (Math.ceil(px * em * 4) / 4)];

  type Case = { what: string; cells: number; name: string; hp: string | null; edge: { text: string; room: (r: Room) => number } };

  /** Font widths that put `edge.text` from 6% inside the room it is measured against at the pin to 6% past it. */
  function emsAround(c: Case): number[] {
    const room = c.edge.room(labelStyle(boardSizes(PIN_CELL_PX, 1), c.cells * PIN_CELL_PX, PIN_CELL_PX).room);
    return Array.from({ length: 13 }, (_, i) => (room / [...c.edge.text].length) * (0.94 + i * 0.01));
  }

  function labelAt(cell: number, ui: number, c: Case, measure: Measure, previous: Map<string, Side>): string[] {
    const sizes = boardSizes(cell, ui);
    const w = c.cells * cell;
    const box: Box = { x0: 0, y0: 0, x1: w, y1: w };
    const input: LabelInput = { id: "t", box, belowY: w + sizes.gapPx, aboveY: -sizes.gapPx, name: c.name, hp: c.hp, alert: false, rank: 0, sides: false, nameOnly: false, style: labelStyle(sizes, w, cell) };
    const p = placeLabels([input], [{ box, owner: "t", kind: "body" }], measure, previous).get("t")!;
    previous.set("t", p.side);
    return texts(p);
  }

  /**
   * The shapes a sweep showed, zoom by zoom. Its line count changes once at
   * most, and a shape it left never comes back: a label that flips back
   * and forth fails both.
   */
  function assertSettles(shapes: readonly string[][], what: string) {
    const changes = shapes.filter((s, i) => i > 0 && s.length !== shapes[i - 1]!.length).length;
    const order = shapes.map((s) => s.join(" / ")).filter((s, i, all) => i === 0 || s !== all[i - 1]);
    assert.ok(changes <= 1, `${what}: the line count changes ${changes} times: ${order.join(" | ")}`);
    assert.equal(new Set(order).size, order.length, `${what}: a shape comes back: ${order.join(" | ")}`);
  }

  const cases: Case[] = [
    { what: "a two-cell token's name at its wrap", cells: 2, name: "Kobold Scale Sorcerer", hp: null, edge: { text: "Kobold Scale Sorcerer", room: (r) => r.wrapEm } },
    { what: "a one-cell token's name at its wrap", cells: 1, name: "Owlbear Matriarch", hp: null, edge: { text: "Owlbear Matriarch", room: (r) => r.wrapEm } },
    { what: "a three-cell token's name and HP at the edge of one line", cells: 3, name: "Goblin Warrior", hp: "18/24", edge: { text: "Goblin Warrior · 18/24", room: (r) => r.ownEm } },
  ];

  for (const c of cases) {
    test(`${c.what} wraps once at most, zooming in or out, and not at all while its size scales`, () => {
      for (const ui of [1, 1.3]) {
        for (const em of emsAround(c)) {
          for (const [f, measure] of fonts(em).entries()) {
            const what = `${c.what}, ${em.toFixed(4)} em a letter${f ? " snapped" : ""}, at ${ui * 100}%`;
            const previous = new Map<string, Side>();
            const zoomIn = cells.map((cell) => labelAt(cell, ui, c, measure, previous));
            const zoomOut = [...cells].reverse().map((cell) => labelAt(cell, ui, c, measure, previous));
            assertSettles(zoomIn, `${what}, zooming in`);
            assertSettles(zoomOut, `${what}, zooming out`);
            const scaling = zoomIn.filter((_, i) => cells[i]! >= floorCell && cells[i]! <= ceilingCell).map((s) => s.join(" / "));
            assert.equal(new Set(scaling).size, 1, `${what}: the shape changes while the size scales: ${[...new Set(scaling)].join(" | ")}`);
          }
        }
      }
    });
  }

  test("a pack alike in size and name places in one order at every zoom, so the same goblin keeps its whole name", () => {
    // Boxes of one size differ by float error with where they stand, which once reordered the pack at every frame of a zoom.
    const pack = [7, 8, 9].map((x, i) => ({ id: `g${i + 1}`, x, y: 3 }));
    const previous = new Map<string, Side>();
    const whole = new Map<string, boolean[]>(pack.map((g) => [g.id, []]));
    for (const cell of cells) {
      const sizes = boardSizes(cell, 1);
      const obstacles: Obstacle[] = [];
      const inputs: LabelInput[] = [];
      for (const g of pack) {
        const box: Box = { x0: g.x * cell, y0: g.y * cell, x1: g.x * cell + cell, y1: g.y * cell + cell };
        obstacles.push({ box, owner: g.id, kind: "body" });
        inputs.push({ id: g.id, box, belowY: box.y1 + sizes.gapPx, aboveY: box.y0 - sizes.gapPx, name: "Goblin Warrior", hp: "7/7", alert: false, rank: 0, sides: false, nameOnly: false, style: labelStyle(sizes, cell, cell) });
      }
      const placed = placeLabels(inputs, obstacles, measure, previous);
      previous.clear();
      for (const [id, p] of placed) {
        if (p.lines.length > 0) previous.set(id, p.side);
        whole.get(id)!.push(p.nameShown && !p.cut);
      }
    }
    for (const [id, seen] of whole) {
      const changes = seen.filter((w, i) => i > 0 && w !== seen[i - 1]).length;
      assert.ok(changes <= 1, `${id}'s name turns whole and cut ${changes} times`);
    }
    assert.ok(whole.get("g1")!.every(Boolean), "the first of the pack by id keeps its name whole");
  });

  test("the focus plate's name wraps once at most, zooming in or out", () => {
    const name = "Owlbear Matriarch of the Thornwood";
    const c: Case = { what: "the plate", cells: 1, name, hp: "18/24", edge: { text: name, room: () => focusStyle(boardSizes(PIN_CELL_PX, 1)).room.maxEm } };
    for (const ui of [1, 1.3]) {
      for (const em of emsAround(c)) {
        for (const [f, measure] of fonts(em).entries()) {
          const plate = (cell: number) => focusLines({ name, number: undefined, hp: "18/24", style: focusStyle(boardSizes(cell, ui)) }, measure).map((l) => l.text);
          const what = `the plate, ${em.toFixed(4)} em a letter${f ? " snapped" : ""}, at ${ui * 100}%`;
          assertSettles(cells.map(plate), `${what}, zooming in`);
          assertSettles([...cells].reverse().map(plate), `${what}, zooming out`);
        }
      }
    }
  });
});
