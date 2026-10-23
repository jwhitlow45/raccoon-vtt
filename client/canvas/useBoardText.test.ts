import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boardSizes } from "../lib/boardScale.ts";
import { labelStyle, overlaps, placeLabels, type Box, type LabelInput } from "../lib/boardText.ts";

const { pillObstacles } = await import("./useBoardText.ts");
const { pillPlace } = await import("../features/measure/Pill.tsx");
const { measureLabel } = await import("./measureText.ts");

/*
 * The label pass keeps token labels off other layers' pills by zoom alone,
 * never by pan, while a pointed pill slides along the view's edge as it is
 * drawn (docs/design-v1-polish.md R4). So what it keeps off is every place
 * the pill can slide to: a label never lands on a trap's name slid in from
 * the screen's edge.
 */

const scale = 40;
const trap = { x: 10, y: 5, name: "Poisoned Needle Gauntlet", size: "map" as const, small: true, maxLines: 1 as const, above: true };
const px = (b: Box): Box => ({ x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale });

/** The name drawn as far as the view can slide it each way: the view's edge just past its point on the other side. */
function slid(way: "left" | "right"): Box {
  const view = way === "left" ? { x0: -100, y0: -100, x1: trap.x + 0.1, y1: 100 } : { x0: trap.x - 0.1, y0: -100, x1: 100, y1: 100 };
  return px(pillPlace({ ...trap, scale }, view).box);
}

/** A token one cell wide at `cell`, its name below it, as useBoardText.ts hands it to the label pass. */
function token(id: string, cell: { x: number; y: number }): LabelInput {
  const sizes = boardSizes(scale);
  const box = { x0: cell.x * scale, y0: cell.y * scale, x1: (cell.x + 1) * scale, y1: (cell.y + 1) * scale };
  return { id, box, belowY: box.y1 + sizes.gapPx, aboveY: box.y0 - sizes.gapPx, name: "Goblin", hp: null, alert: false, rank: 0, sides: false, nameOnly: false, style: labelStyle(sizes, scale, scale) };
}

describe("a pointed pill in the label pass (docs/design-v1-polish.md R4)", () => {
  test("keeps the room of every place the view can slide it to, the drawn pill inside it at either end", () => {
    const [reach] = pillObstacles([trap], scale);
    assert.ok(reach);
    const centered = px(pillPlace({ ...trap, scale }, null).box);
    for (const box of [centered, slid("left"), slid("right")]) {
      assert.ok(box.x0 >= reach.box.x0 - 1e-9 && box.x1 <= reach.box.x1 + 1e-9 && box.y0 >= reach.box.y0 - 1e-9 && box.y1 <= reach.box.y1 + 1e-9, `${JSON.stringify(box)} leaves ${JSON.stringify(reach.box)}`);
    }
    assert.ok(slid("left").x0 < centered.x0 - 20 && slid("right").x1 > centered.x1 + 20, "the name slides well past its centered place each way");
  });

  for (const way of ["left", "right"] as const) {
    test(`a label that would land on the name slid ${way} keeps off it`, () => {
      const pill = slid(way);
      // A goblin just over the slid name's far end, clear of the name where it stands centered, whose name below would cover the slid one.
      const cell = { x: Math.floor((way === "left" ? pill.x0 : pill.x1 - scale) / scale), y: Math.floor(pill.y0 / scale) - 1 };
      const goblin = token("goblin", cell);
      const below = placeLabels([goblin], [{ box: goblin.box, owner: "goblin", kind: "body" }], measureLabel).get("goblin");
      assert.ok(below && overlaps(below.box, pill), `with nothing to keep off, the label (${JSON.stringify(below?.box)}) does not reach the slid name, so this case tests nothing`);
      const placed = placeLabels([goblin], [{ box: goblin.box, owner: "goblin", kind: "body" }, ...pillObstacles([trap], scale)], measureLabel).get("goblin");
      assert.ok(placed && placed.lines.length > 0, "the goblin's name still shows");
      assert.ok(!overlaps(placed.box, pill), `the label ${JSON.stringify(placed.box)} lands on the name slid ${way}, ${JSON.stringify(pill)}`);
    });
  }
});
