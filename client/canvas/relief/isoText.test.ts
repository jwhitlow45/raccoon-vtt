import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { actor, token, trap as makeTrap } from "#shared/testutil.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { labelShape } from "../../features/builder/labelShape.ts";
import { overlaps, type Box } from "../../lib/boardText.ts";
import type { ViewToken } from "../../lib/scene.ts";
import type { TokenText } from "../useBoardText.ts";
import { isometric, toView, toWorld, type Turn } from "../../lib/view.ts";
import { pillInkReach, pillPlace, pillReach } from "../../features/measure/pillPlace.ts";
import { tokenBoxes as topDownBoxes } from "../../features/areas/labelSpot.ts";
import { standeeShape } from "./standee.ts";

const { layoutBoardText } = await import("../useBoardText.ts");
const { areaNamePill } = await import("../../features/areas/TemplateLayer.tsx");
const { trapNamePill, isoTrapNamePill } = await import("../../features/traps/TrapLayer.tsx");
const { decorPlace, isoTokenBoxes, isoNamePill, tokenLayoutPills, mapLabelInk, viewPill } = await import("./isoText.ts");
const { measureLabel } = await import("../../features/builder/draw.ts");

before(() => {
  // Inter widths at 12 px. Raised and Wire trap come from the browser's
  // measured boxes after removing padding and strokes. Other widths were
  // measured from the shipped font. Estimates pick different candidates.
  const widths: Record<string, number> = { Raised: 38.979736328125, Bree: 26.16, Grum: 31.08, Front: 29.26, Behind: 39.29, "30/30": 34.29, "Area name": 61.16, "Wire trap": 53.93608093261719 };
  const context = {
    font: "",
    measureText(text: string) {
      const px = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 12);
      return { width: widths[text] === undefined ? text.length * px * (this.font.startsWith("bold") ? 0.62 : 0.58) : widths[text]! * px / 12 };
    },
  };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => context }) };
});

const SCALE = 80;
const px = (b: Box): Box => ({ x0: b.x0 * SCALE, y0: b.y0 * SCALE, x1: b.x1 * SCALE, y1: b.y1 * SCALE });

/** A crowd of goblins packed a cell apart, each with a name, on flat ground. */
function crowd(): ViewToken[] {
  const out: ViewToken[] = [];
  for (const [x, y] of [[5, 5], [6, 6], [7, 7], [5, 7], [7, 5], [6, 8], [8, 6], [4, 6], [6, 4]] as const) out.push(token(`g${x}${y}`, { x, y, name: `Goblin ${x}${y}` }) as ViewToken);
  return out;
}

function standeesOf(tokens: readonly ViewToken[], turn: Turn) {
  return new Map(tokens.map((t) => [t.id, standeeShape(turn, { x: t.x, y: t.y, w: 1, h: 1 }, 0, 0, SCALE, 900)]));
}

function layout(tokens: readonly ViewToken[], place?: (t: ViewToken) => { x: number; y: number; ring?: Box }) {
  return layoutBoardText(
    { tokens, scale: SCALE, characters: undefined, role: "dm", ownsToken: () => true, activeTokenId: null, selectedId: null, pills: [], mapLabels: [], lockShown: () => false, fontEpoch: 0, ...(place ? { place } : {}) },
    undefined,
  ).out;
}

describe("token labels in Isometric lay out in view space (docs/design-v1-isometric-view.md 5.4)", () => {
  test("no goblin's name lands on another's standee or ring, at every turn", () => {
    const tokens = crowd();
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const standees = standeesOf(tokens, turn);
      const place = (t: ViewToken) => decorPlace(isometric(turn), t, standees.get(t.id));
      const text = layout(tokens, place);
      let named = 0;
      for (const t of tokens) {
        const label = text.get(t.id)?.label;
        if (!label) continue;
        named++;
        const at = place(t);
        const box = { x0: at.x * SCALE + label.x, y0: at.y * SCALE + label.y, x1: at.x * SCALE + label.x + label.width, y1: at.y * SCALE + label.y + label.height };
        for (const o of tokens) {
          if (o.id === t.id) continue;
          const s = standees.get(o.id)!;
          assert.ok(!overlaps(box, px(s.frame)) && !overlaps(box, px(s.ring)), `turn ${turn}: ${t.name}'s name ${JSON.stringify(box)} lies on ${o.name}`);
        }
      }
      assert.ok(named >= 3, `turn ${turn}: some names still show (${named})`);
    }
  });

  test("a name below its standee hangs below the ring, not over it", () => {
    const [goblin] = crowd();
    const s = standeeShape(0, { x: goblin!.x, y: goblin!.y, w: 1, h: 1 }, 0, 0, SCALE, 900);
    const place = () => decorPlace(isometric(0), goblin!, s);
    const text = layout([goblin!], place).get(goblin!.id)!;
    assert.ok(text.label && text.label.y >= text.heightPx, "the lone goblin's name shows below it");
    const top = s.frame.y0 * SCALE + text.label.y;
    assert.ok(top >= s.ring.y1 * SCALE, `the name's top ${top} is under the ring's bottom ${s.ring.y1 * SCALE}`);
    assert.equal(text.footPx, (s.ring.y1 - s.frame.y0) * SCALE, "the chrome under it hangs from the ring's bottom");
  });

  test("a name keeps off the ring another standee stands on, where it hangs below that standee's frame", () => {
    const [a] = crowd();
    // No HP to show, so no bar under its frame: only its ring lies in the way (useBoardText.ts hpLess).
    const b = token("b", { x: 9, y: 9, name: "", actor: { inline: { ...actor(), hp: { cur: 0, max: 0, temp: 0 } } } }) as ViewToken;
    const sa = standeeShape(0, { x: a!.x, y: a!.y, w: 1, h: 1 }, 0, 0, SCALE, 900);
    // Where a's name would hang alone: below its ring.
    const alone = layout([a!], () => decorPlace(isometric(0), a!, sa)).get(a!.id)!.label!;
    const top = sa.frame.y0 + alone.y / SCALE;
    // b stands above that, its frame 20 px clear of the name, more than the gap a name keeps, and the lower half of a wide ring across it.
    const at = { x: sa.base.x, y: top - 20 / SCALE };
    const sb = { frame: { x0: at.x - 0.5, x1: at.x + 0.5, y0: at.y - 1, y1: at.y }, ring: { x0: at.x - 1, x1: at.x + 1, y0: at.y - 0.5, y1: at.y + 0.5 } };
    const place = (t: ViewToken) => decorPlace(isometric(0), t, t.id === b.id ? sb : sa);
    const label = layout([a!, b], place).get(a!.id)!.label;
    assert.ok(label, "a's name still shows");
    const box = { x0: sa.frame.x0 * SCALE + label.x, y0: sa.frame.y0 * SCALE + label.y, x1: sa.frame.x0 * SCALE + label.x + label.width, y1: sa.frame.y0 * SCALE + label.y + label.height };
    assert.ok(!overlaps(box, px(sb.ring)), `the name ${JSON.stringify(box)} lies on b's ring ${JSON.stringify(px(sb.ring))}`);
  });

  test("a creature lying flat lays its decor out on a box its size on its footprint's middle, at the drawn ground under it", () => {
    const t = token("flat", { x: 3, y: 2, size: "large" }) as ViewToken;
    const c = toView(isometric(1), { x: 4, y: 3 });
    assert.deepEqual(decorPlace(isometric(1), t, undefined), { x: c.x - 1, y: c.y - 1 });
    const up = toView(isometric(1), { x: 4, y: 3 }, 2);
    assert.deepEqual(decorPlace(isometric(1), t, undefined, 2), { x: up.x - 1, y: up.y - 1 }, "up a seen 10 ft column, with its picture");
  });

  test("a map label that stands keeps its ink round the block on its anchor, one lying flat its ink box seen through the view", () => {
    const label = { x: 6.5, y: 4.5, text: "Crypt", size: 1 };
    const view = isometric(0);
    const up = mapLabelInk(label, view, true, () => 2, measureLabel);
    const { box } = labelShape(label, view, { measure: measureLabel, upright: true, ground: 2 });
    assert.ok(up.x0 < box.x && up.x1 > box.x + box.width && up.y0 < box.y && up.y1 > box.y + box.height - 1e-9, "the ink reaches past the block");
    const flat = mapLabelInk(label, view, false, () => 0, measureLabel);
    const anchor = toView(view, label);
    assert.ok(flat.y0 <= anchor.y && flat.y1 >= anchor.y, "the flat ink lies round its anchor on flat ground");
    assert.ok(up.y1 < anchor.y, "the standing one stands raised on its 10 ft ground");
  });

  test("a flat label across a ledge is bounded on both heights its parts are drawn at (ISO34-FV-4)", () => {
    const label = { x: 6, y: 4.5, text: "Long hallway", size: 1 };
    const view = isometric(0);
    // East of x = 6 a 10 ft top, which lifts that part of the label.
    const ground = (x: number) => (x >= 6 ? 2 : 0);
    const box = mapLabelInk(label, view, false, ground, measureLabel);
    for (const z of [0, 2]) {
      const part = mapLabelInk(label, view, false, () => z, measureLabel);
      assert.ok(box.x0 <= part.x0 + 1e-9 && box.y0 <= part.y0 + 1e-9 && box.x1 >= part.x1 - 1e-9 && box.y1 >= part.y1 - 1e-9, `holds the label seen at ${z}`);
    }
  });

  test("a pill stands on its point at the drawn ground there", () => {
    const pill = { x: 3, y: 4, value: "15 ft", size: "screen" as const, small: true, above: true };
    const moved = viewPill(pill, isometric(2), (x, y) => (x === 3 && y === 4 ? 2 : 0));
    const v = toView(isometric(2), { x: 3, y: 4 }, 2);
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: v.x, y: v.y });
    assert.equal(moved.value, "15 ft");
  });
});


test("FU40B-OPUS-3: only isometric name obstacles include the drawn halo", () => {
  const t = token("named", { x: 8, y: 9 }) as ViewToken;
  const label = { x: -10, y: 50, width: 60, height: 20, lines: [{ text: "Raised", px: 12, kind: "name" as const }] };
  const before = structuredClone(label);
  const text = new Map([[t.id, { label, plate: null, marks: null } as unknown as TokenText]]);
  const boxes = isoTokenBoxes([t], text, 40, () => ({ x: 2, y: 3 }));
  assert.deepEqual(boxes[1], { x0: 68.5 / 40, y0: 168.5 / 40, x1: 131.5 / 40, y1: 191.5 / 40 });
  assert.deepEqual(text.get(t.id)?.label, before, "isometric padding cannot alter the shared placement");
  const plate = new Map([[t.id, { label, plate: label, marks: null } as unknown as TokenText]]);
  const plated = isoTokenBoxes([t], plate, 40, () => ({ x: 2, y: 3 }));
  assert.deepEqual(plated[1], { x0: 69.5 / 40, y0: 166.5 / 40, x1: 130.5 / 40, y1: 193.5 / 40 }, "a plate keeps only its own padding and stroke");
});

test("ISO34-LABELS: area and trap names avoid the raised token's actual label at every turn and viewport edge", () => {
  for (const turn of [0, 1, 2, 3] as Turn[]) {
    const view = isometric(turn);
    const t = token("raised", { x: 6, y: 6, name: "Raised goblin" }) as ViewToken;
    const shape = standeeShape(turn, { x: t.x, y: t.y, w: 1, h: 1 }, 4, 0, SCALE, 900);
    const place = () => decorPlace(view, t, shape);
    const text = layout([t], place);
    const label = text.get(t.id)!.label!;
    const at = place();
    const ink = { x0: at.x + label.x / SCALE, y0: at.y + label.y / SCALE, x1: at.x + (label.x + label.width) / SCALE, y1: at.y + (label.y + label.height) / SCALE };
    const boxes = isoTokenBoxes([t], text, SCALE, place);
    assert.ok(boxes.some((b) => b.x0 < ink.x0 && b.y1 > ink.y1));
    const point = toWorld(view, toView({ kind: "topDown" }, { x: (ink.x0 + ink.x1) / 2, y: ink.y1 }));
    for (const name of ["Fireball", "Poison trap"]) {
      const original = { ...point, name, size: "map" as const, small: true, above: true };
      const clearPoint = toWorld(view, toView({ kind: "topDown" }, { x: (ink.x0 + ink.x1) / 2, y: ink.y1 + 2 }));
      const clear = { ...original, ...clearPoint };
      assert.ok(topDownBoxes([t], SCALE, measureLabel).every((b) => !overlaps(b, pillReach({ ...original, scale: SCALE }))), "Top-down's token boxes miss the raised name collision");
      assert.ok(overlaps(pillReach({ ...viewPill(original, view, () => 0), scale: SCALE }), ink));
      const chosen = isoNamePill([original, clear], { view, ground: () => 0, boxes }, SCALE);
      for (const viewport of [null, { x0: ink.x0, x1: ink.x0 + 5, y0: ink.y0 - 4, y1: ink.y1 + 4 }, { x0: ink.x1 - 5, x1: ink.x1, y0: ink.y0 - 4, y1: ink.y1 + 4 }]) {
        const box = pillPlace({ ...viewPill(chosen, view, () => 0), scale: SCALE }, viewport).box;
        assert.ok(boxes.every((b) => !overlaps(box, b)), `turn ${turn} ${name}: the placed pill overlaps actual token text`);
      }
      assert.equal(isoNamePill([original, clear], { view, ground: () => 0, boxes }, SCALE, () => false), original, "with no allowed standing candidate, retain the original flat pill");
    }
  }
});

test("ISO34-LABELS: token layout ignores area and trap publications so moving names cannot move token labels", () => {
  const pill = { x: 1, y: 2, name: "Name", size: "map" as const };
  assert.deepEqual(tokenLayoutPills({ "area:a": [pill], "trap:t": [pill], "move:t": [pill] }), [pill]);
});

test("ISO34-LABELS: a centered pill must also clear the token label after sliding at the viewport edge", () => {
  const view = isometric(0);
  const anchor = toWorld(view, toView({ kind: "topDown" }, { x: 0, y: 0 }));
  const original = { ...anchor, name: "Long name", size: "map" as const, above: true, small: true };
  const projected = viewPill(original, view, () => 0);
  const centered = pillPlace({ ...projected, scale: SCALE }, null).box;
  const reach = pillReach({ ...projected, scale: SCALE });
  const obstacle = { x0: centered.x1 + 0.02, x1: reach.x1, y0: centered.y0, y1: centered.y1 };
  const edge = { x0: 0, x1: 5, y0: -5, y1: 5 };
  assert.ok(!overlaps(centered, obstacle));
  assert.ok(overlaps(pillPlace({ ...projected, scale: SCALE }, edge).box, obstacle));
  const far = toWorld(view, toView({ kind: "topDown" }, { x: 0, y: 2 }));
  const chosen = isoNamePill([original, { ...original, ...far }], { view, ground: () => 0, boxes: [obstacle] }, SCALE);
  assert.ok(!overlaps(pillPlace({ ...viewPill(chosen, view, () => 0), scale: SCALE }, edge).box, obstacle));
});


test("ISO34-LABELS: real area and trap candidates clear the raised name's halo beside Bree and a wire trap", () => {
  const scale = 40;
  const raised = token("raised", { x: 10, y: 10, elevation: 20, name: "Raised", actor: { inline: { ...actor(), hp: { cur: 30, max: 30, temp: 0 }, ac: 12 } } }) as ViewToken;
  const tokens = [raised, token("bree", { kind: "npc", x: 6, y: 9, name: "Bree", disposition: "ally" }), token("grum", { kind: "npc", x: 2, y: 2, size: "large", name: "Grum", disposition: "ally" }), token("front", { x: 13, y: 9, name: "Front" }), token("behind", { x: 12, y: 8, name: "Behind" })].map((t) => ({ ...t, actor: raised.actor })) as ViewToken[];
  let kept: ReturnType<typeof layoutBoardText>["placed"] | undefined;
  for (const turn of [0, 1, 2, 3] as Turn[]) {
    const view = isometric(turn);
    const ground = (x: number, y: number) => x >= 8 && x < 12 && y >= 4 && y < 8 ? 2 : 0;
    const place = (t: ViewToken) => decorPlace(view, t, standeeShape(turn, { x: t.x, y: t.y, w: t.size === "large" ? 2 : 1, h: t.size === "large" ? 2 : 1 }, t.elevation / 5, ground(t.x, t.y), scale, 900));
    const laid = layoutBoardText({ tokens, scale, characters: undefined, role: "dm", ownsToken: () => true, activeTokenId: null, selectedId: null, pills: [], mapLabels: [], lockShown: () => false, fontEpoch: 0, place }, kept);
    kept = laid.placed;
    const text = laid.out;
    const label = text.get(raised.id)!.label!;
    const at = place(raised);
    // The browser reads the first Text's getClientRect, including its px/4 stroke.
    const font = label.lines[0]!.px;
    const halo = font / 8;
    const ink = { x0: at.x + (label.x - halo) / scale, y0: at.y + (label.y - halo) / scale, x1: at.x + (label.x + label.width + halo) / scale, y1: at.y + (label.y + font + halo) / scale };
    const point = toWorld(view, toView({ kind: "topDown" }, { x: (ink.x0 + ink.x1) / 2, y: ink.y1 }));
    const names = { view, ground, boxes: isoTokenBoxes(tokens, text, scale, place) };
    const original = { ...point, name: "Area name", size: "map" as const, small: true, maxLines: 2 as const, above: true, below: false };
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    const trap = makeTrap("wire", { name: "Wire trap", zone: { wire: { a: [x - 1, y], b: [x + 1, y] } } });
    const originalTrap = trapNamePill(SQUARES, trap, {}, scale, true)!;
    const chosenTrap = isoTrapNamePill(originalTrap, SQUARES, trap, {}, names, scale, () => true);
    if (turn === 3) {
      // Match the captured browser rectangles before checking the new placement.
      const captured = { x: 780.5640951736806, y: 297.72020664195173, width: 45.979736328125, height: 15 };
      assert.ok(Math.abs((ink.x1 - ink.x0) * scale - captured.width) < 1e-9);
      assert.ok(Math.abs((ink.y1 - ink.y0) * scale - captured.height) < 1e-9);
      const camera = { x: captured.x - ink.x0 * scale, y: captured.y - ink.y0 * scale };
      const old = pillPlace({ ...viewPill({ ...originalTrap, x: x - 1, above: true, below: false }, view, ground), scale }, null).box;
      const drawn = { x: old.x0 * scale + camera.x - 0.75, y: old.y0 * scale + camera.y - 0.75, width: (old.x1 - old.x0) * scale + 1.5, height: (old.y1 - old.y0) * scale + 1.5 };
      const wanted = { x: 743.5516516239726, y: 299.3814575050762, width: 63.43608093261719, height: 29.3 };
      for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(drawn[key] - wanted[key]) < 1e-9, `captured trap ${key}: ${drawn[key]}`);
    }
    const chosen = areaNamePill(original, { kind: "circle", x: point.x, y: point.y + 1, r: 1 }, names, scale, () => true, [chosenTrap]);
    for (const placed of [chosen, chosenTrap]) {
      const box = pillPlace({ ...viewPill(placed, view, ground), scale }, null).box;
      const gap = Math.max(box.x0 - ink.x1, ink.x0 - box.x1, box.y0 - ink.y1, ink.y0 - box.y1) * scale - 0.75;
      // Match the browser assertion's 1 px antialiasing allowance at every turn.
      assert.ok(gap >= -1, `turn ${turn}: ${placed.name} overlaps the raised name by ${-gap} px: ${JSON.stringify({ box, ink, chosen: placed })}`);
    }
  }
});


test("ISO34-LABELS: the area candidate's outline counts even when its fill clears token text", () => {
  const view = isometric(0);
  const point = toWorld(view, toView({ kind: "topDown" }, { x: 0, y: 0 }));
  const original = { ...point, name: "Area name", size: "map" as const, small: true, above: true };
  const reach = pillReach({ ...viewPill(original, view, () => 0), scale: SCALE });
  const ink = { x0: reach.x1 + 0.25 / SCALE, x1: reach.x1 + 1 / SCALE, y0: reach.y0, y1: reach.y1 };
  const far = { ...original, ...toWorld(view, toView({ kind: "topDown" }, { x: 0, y: 2 })) };
  assert.ok(!overlaps(reach, ink), "the unstroked box misses the collision");
  assert.equal(isoNamePill([original, far], { view, ground: () => 0, boxes: [ink] }, SCALE), far);
});


test("ISO34-LABELS: crowded names move past successive token boxes only where the fog permits", () => {
  const view = isometric(0);
  const scale = 40;
  const point = toWorld(view, toView({ kind: "topDown" }, { x: 0, y: 0 }));
  for (const above of [false, true]) {
    const original = { ...point, name: "Wire trap", size: "map" as const, small: true, above, below: !above, offsetPx: 12 };
    const first = pillInkReach({ ...viewPill(original, view, () => 0), scale });
    const near = above ? { ...first, y0: first.y1 - 0.25, y1: first.y1 - 0.1 } : { ...first, y0: first.y0 + 0.1, y1: first.y0 + 0.25 };
    // Clear initially, this box blocks the first move. It comes first in
    // the input to catch a search that never revisits a passed obstacle.
    const next = above ? { ...first, y0: first.y0 - 0.2, y1: first.y0 - 0.1 } : { ...first, y0: first.y1 + 0.1, y1: first.y1 + 0.2 };
    const names = { view, ground: () => 0, boxes: [next, near] };
    const pushed = isoNamePill([original], names, scale);
    assert.ok(pushed.offsetPx! > original.offsetPx);
    assert.deepEqual({ x: pushed.x, y: pushed.y }, point, "the pointer keeps its shape anchor");
    const box = pillInkReach({ ...viewPill(pushed, view, () => 0), scale });
    assert.ok(names.boxes.every((b) => !overlaps(box, b)), "the whole outlined pill clears both obstacles");
    assert.equal(isoNamePill([original], names, scale, (p) => p.offsetPx === original.offsetPx), original, "no pushing the name onto fogged ground");
    const far = above ? { ...first, y0: first.y0 - 3 } : { ...first, y1: first.y1 + 3 };
    assert.equal(isoNamePill([original], { ...names, boxes: [far] }, scale), original, "a name cannot move more than two extra view units from its shape");
  }
});
