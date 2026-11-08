import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";

const { areaNameRoom, placedOutline } = await import("./TemplateLayer.tsx");
const { pillGeometry } = await import("../measure/Pill.tsx");
const { draftTemplate, newDraft } = await import("./placement.ts");
const { SQUARES } = await import("#shared/rules/grid.ts");

describe("the room an area's name takes", () => {
  test("counts the pill's pointer as drawn, which grows with the interface size (review LP2L2-AREA-PTR)", () => {
    const name = "Web of the spider queen's lair under the old mill by the river";
    for (const [ui, pointer] of [
      [1, 6],
      [1.3, 8],
    ] as const) {
      setBoardInterfaceScale(ui);
      try {
        const pill = pillGeometry({ scale: 40, name, size: "map", small: true });
        const short = pillGeometry({ scale: 40, name, size: "map", small: true, maxLines: 1 });
        const room = areaNameRoom(40, name);
        assert.deepEqual(room.size, { width: pill.width, height: pill.height + pointer }, `two lines at ${ui}`);
        assert.ok(short.height < pill.height, "the name wraps, so a one-line pill is smaller");
        assert.deepEqual(room.oneLineSize, { width: short.width, height: short.height + pointer }, `one line at ${ui}`);
      } finally {
        setBoardInterfaceScale(1);
      }
    }
  });
});

describe("a placed area's outline (CUBE-PUBLISH-FRAME)", () => {
  test("stays the same object while its template and the layer's context do, so its name's pill keeps its memo", () => {
    const ctx = { settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell" }, bounds: { w: 40, h: 40 }, grid: SQUARES, tokens: {} } as const;
    const drafted = draftTemplate(SQUARES, { ...newDraft("a1", "cube", "#f38400"), point: { x: 5, y: 5, z: 0 } }, {}, 5);
    assert.ok(drafted, "the cube has somewhere to be");
    const cube = { ...drafted, sceneId: "s" };
    const first = placedOutline(cube, ctx);
    assert.ok(first, "a cube has an outline");
    assert.equal(placedOutline(cube, ctx), first, "a render with nothing new keeps the outline");
    // A moved cube, or a context made anew (a token moved, the room's rules changed), draws its outline again.
    const moved = { ...cube, origin: { x: 6, y: 5, z: 0 } };
    assert.notEqual(placedOutline(moved, ctx), first);
    assert.notDeepEqual(placedOutline(moved, ctx), first);
    const again = { ...ctx, tokens: {} };
    assert.notEqual(placedOutline(cube, again), first);
    assert.deepEqual(placedOutline(cube, again), first);
    // A placed area reads it there, not from areaOutline, which makes a new one each call.
    const source = readFileSync(new URL("./TemplateLayer.tsx", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export const PlacedArea = memo("), source.indexOf("/** Children shown only inside"));
    assert.match(body, /const outline = placedOutline\(t, ctx\);/);
    assert.doesNotMatch(body, /areaOutline\(/);
  });
});
