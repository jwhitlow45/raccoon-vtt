import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { paintedOf, samples } from "./plan.samples.ts";
import { THEMES } from "./settings.ts";

/*
 * The themes (phase 2, 5.1): each paints its own floors, locks its share
 * of doors and lays its own overlays, from one table (themes.ts).
 */

describe("themes", () => {
  test("floors: Cave's cave, Mine's dirt, Sewer's and Crypt's stone, Dungeon's stone with some wood, in rooms and corridors alike", () => {
    const want = { dungeon: ["stone", "wood"], crypt: ["stone"], cave: ["cave"], mine: ["dirt"], sewer: ["stone"] } as const;
    for (const theme of THEMES) {
      const floors = new Set<string>();
      for (const { p } of samples(220, 10, { theme, w: 60, h: 60, rooms: 16 })) for (const t of paintedOf(p).values()) if (["stone", "wood", "cave", "dirt"].includes(t)) floors.add(t);
      assert.deepEqual([...floors].sort(), [...want[theme]].sort(), theme);
    }
  });

  test("doors lock about 10 in 100 in a Mine and 20 in a Sewer, and a Cave has none", () => {
    for (const [theme, rate] of [["mine", 0.1], ["sewer", 0.2]] as const) {
      let doors = 0;
      let locked = 0;
      for (const { p } of samples(221, 40, { theme, w: 80, h: 80, rooms: 30, secrets: 0 })) {
        doors += p.plan.doors.length;
        locked += p.plan.doors.filter((d) => d.state === "locked").length;
      }
      assert.ok(Math.abs(locked / doors - rate) < 0.04, `${theme} locks ${locked / doors}`);
    }
    for (const { p } of samples(222, 10, { theme: "cave" })) assert.deepEqual(p.plan.doors, []);
  });

  test("overlays by theme: rubble in a Dungeon's, a Cave's and a Mine's tunnels, Mine's shafts a square each, pillars only in a Crypt, water only in a Sewer", () => {
    const seen = (theme: (typeof THEMES)[number]) => {
      const out = new Map<string, number>();
      for (const { p } of samples(223, 20, { theme, w: 70, h: 70, rooms: 20 })) for (const [t, cells] of Object.entries(p.plan.paint)) out.set(t, (out.get(t) ?? 0) + (cells?.length ?? 0));
      return out;
    };
    const dungeon = seen("dungeon");
    const crypt = seen("crypt");
    const cave = seen("cave");
    const mine = seen("mine");
    const sewer = seen("sewer");
    assert.ok(dungeon.get("rubble")! > 0 && dungeon.get("pit")! > 0 && !dungeon.has("pillar") && !dungeon.has("water"));
    assert.ok(crypt.get("pillar")! > 0 && !crypt.has("rubble") && !crypt.has("pit") && !crypt.has("water"));
    assert.ok(cave.get("rubble")! > 0 && !cave.has("pit") && !cave.has("pillar") && !cave.has("water"));
    assert.ok(mine.get("rubble")! > 0 && mine.get("pit")! > 0 && !mine.has("pillar") && !mine.has("water"));
    assert.ok(sewer.get("water")! > 0 && !sewer.has("rubble") && !sewer.has("pit") && !sewer.has("pillar"));
    // A Mine's shafts stand alone: no shaft square beside another.
    for (const { p } of samples(224, 20, { theme: "mine", w: 70, h: 70, rooms: 20 })) {
      const pits = new Set(p.plan.paint.pit ?? []);
      for (const c of pits) {
        const [x, y] = c.split(",").map(Number) as [number, number];
        assert.ok(![`${x + 1},${y}`, `${x},${y + 1}`].some((n) => pits.has(n)), `a shaft of two at ${c}`);
      }
    }
    // Rubble in about 1 of 2 Mine tunnels, more than a Dungeon's or a Cave's 1 in 3.
    assert.ok(mine.get("rubble")! > dungeon.get("rubble")!, `mine rubble ${mine.get("rubble")}, dungeon ${dungeon.get("rubble")}`);
  });
});
