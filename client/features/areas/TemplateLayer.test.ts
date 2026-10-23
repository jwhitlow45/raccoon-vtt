import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";

const { areaNameRoom } = await import("./TemplateLayer.tsx");
const { pillGeometry } = await import("../measure/Pill.tsx");

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
