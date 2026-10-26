import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { actor, token } from "#shared/testutil.ts";
import { labelShape } from "../../features/builder/labelShape.ts";
import { overlaps, type Box } from "../../lib/boardText.ts";
import type { ViewToken } from "../../lib/scene.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";
import { standeeShape } from "./standee.ts";

const { layoutBoardText } = await import("../useBoardText.ts");
const { decorPlace, mapLabelInk, viewPill } = await import("./isoText.ts");
const { measureLabel } = await import("../../features/builder/draw.ts");

before(() => {
  // Map labels measure in a canvas, which node has none of: the estimate stands in.
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ getContext: () => null }) };
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

  test("a creature lying flat lays its decor out on a box its size on its footprint's middle", () => {
    const t = token("flat", { x: 3, y: 2, size: "large" }) as ViewToken;
    const c = toView(isometric(1), { x: 4, y: 3 });
    assert.deepEqual(decorPlace(isometric(1), t, undefined), { x: c.x - 1, y: c.y - 1 });
  });

  test("a map label that stands keeps its ink round the block on its anchor, one lying flat its ink box seen through the view", () => {
    const label = { x: 6.5, y: 4.5, text: "Crypt", size: 1 };
    const view = isometric(0);
    const up = mapLabelInk(label, view, true, 2, measureLabel);
    const { box } = labelShape(label, view, { measure: measureLabel, upright: true, ground: 2 });
    assert.ok(up.x0 < box.x && up.x1 > box.x + box.width && up.y0 < box.y && up.y1 > box.y + box.height - 1e-9, "the ink reaches past the block");
    const flat = mapLabelInk(label, view, false, 2, measureLabel);
    const anchor = toView(view, label);
    assert.ok(flat.y0 <= anchor.y && flat.y1 >= anchor.y, "the flat ink lies round its anchor at 0, not raised");
    assert.ok(up.y1 < anchor.y, "the standing one stands raised on its 10 ft ground");
  });

  test("a pill stands on its point at the drawn ground there", () => {
    const pill = { x: 3, y: 4, value: "15 ft", size: "screen" as const, small: true, above: true };
    const moved = viewPill(pill, isometric(2), (x, y) => (x === 3 && y === 4 ? 2 : 0));
    const v = toView(isometric(2), { x: 3, y: 4 }, 2);
    assert.deepEqual({ x: moved.x, y: moved.y }, { x: v.x, y: v.y });
    assert.equal(moved.value, "15 ft");
  });
});
