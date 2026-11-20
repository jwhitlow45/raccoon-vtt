import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene } from "#shared/model.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { scene } from "#shared/testutil.ts";
import { ATTIC, tower, TOWER, UPPER } from "../floors/testing.ts";
import { everyFloorFits, everyFloorHelp, everyFloorZip, EVERY_FLOOR_PIXELS, exportedFloors, floorEntries, makingText, reachedText, sharedBounds, tooMuchText } from "./everyFloor.ts";
import { everyFloorFileName, floorEntryName } from "./fileName.ts";
import { MAX_EXPORT_PIXELS } from "./size.ts";

/*
 * Export every floor (docs/design/design-v1-floors.md phase 4, 9.3): the
 * floors the zip holds for each version, their pictures' names, the file's
 * name, the limits, and the run that makes them one floor at a time.
 */

/** Tower with Ground floor, Upper floor and Attic renamed, bottom first. */
function named(...names: string[]): RoomState {
  const state = tower();
  [TOWER, UPPER, ATTIC].forEach((id, i) => {
    const s = state.scenes[id]!;
    state.scenes[id] = { ...s, floor: { ...s.floor!, name: names[i]! } };
  });
  return state;
}

function entryNames(state: RoomState, version: "player" | "dm"): string[] {
  return floorEntries(exportedFloors(state, TOWER, version).floors).map((e) => e.name);
}

/** The names a zip holds, read from its central directory. */
async function zipNames(zip: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.byteLength - 22;
  const names: string[] = [];
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const length = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)));
    at += 46 + length;
  }
  return names;
}

describe("Export every floor's pictures", () => {
  test("are numbered lowest first and named by their slugs, so names that share a slug never collide", () => {
    assert.deepEqual(entryNames(named("Café", "Cafe", "A/B"), "dm"), ["01-cafe.png", "02-cafe.png", "03-a-b.png"]);
    assert.deepEqual(entryNames(named("A-B", "A/B", "Ground"), "dm"), ["01-a-b.png", "02-a-b.png", "03-ground.png"]);
    // Two names in another script leave no slug, so each is a floor by its number.
    assert.deepEqual(entryNames(named("地下室", "屋根裏", "Roof 3x3"), "dm"), ["01-floor.png", "02-floor.png", "03-roof-3-x-3.png"]);
    for (const names of [entryNames(named("Café", "Cafe", "A/B"), "dm"), entryNames(named("地下室", "屋根裏", "Тайник"), "dm")]) assert.equal(new Set(names).size, names.length, names.join(" "));
    assert.equal(floorEntryName(8, ""), "08-floor.png");
  });

  test("hold every floor in the DM view, and in the player view only the floors players reached, numbered among themselves", () => {
    const state = tower();
    assert.deepEqual(entryNames(state, "dm"), ["01-ground-floor.png", "02-upper-floor.png", "03-attic.png"]);
    // The players start on Ground floor and have reached the Attic, not Upper floor between them.
    state.openFloors = { [ATTIC]: { sceneId: ATTIC, rev: 0 } };
    assert.deepEqual(entryNames(state, "player"), ["01-ground-floor.png", "02-attic.png"]);
    assert.deepEqual(exportedFloors(state, TOWER, "player").total, 3);
    // The same from the floor the DM shows, whichever it is.
    assert.deepEqual(floorEntries(exportedFloors(state, UPPER, "player").floors).map((e) => e.name), ["01-ground-floor.png", "02-attic.png"]);
    // A party member standing on Upper floor reaches it.
    state.tokens.thorn = { ...state.tokens.thorn!, sceneId: UPPER };
    assert.deepEqual(entryNames(state, "player"), ["01-ground-floor.png", "02-upper-floor.png", "03-attic.png"]);
  });

  test("hold nothing for players on a scene they never reached, and the words say so", () => {
    const state = tower();
    state.meta = { ...state.meta, playerSceneId: "cave" };
    assert.deepEqual(entryNames(state, "player"), []);
    assert.equal(reachedText("Tower", 0, 3), "Players have not reached any of Tower's 3 floors yet, so their view has nothing to export.");
    assert.equal(reachedText("Tower", 1, 3), "Players have reached 1 of Tower's 3 floors, so the file holds it.");
    assert.equal(reachedText("Tower", 2, 3), "Players have reached 2 of Tower's 3 floors, so the file holds those.");
    assert.equal(reachedText("Tower", 3, 3), null);
  });

  test("go in a file named for the scene, its shared size and the scale", () => {
    assert.equal(everyFloorFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "player"), "tower-30x20-70px.zip");
    assert.equal(everyFloorFileName(SQUARES, "Tower", { w: 30, h: 20 }, 70, "dm"), "tower-30x20-70px-dm.zip");
    assert.equal(everyFloorFileName(SQUARES, "Tower", null, 50, "player"), "tower-50px.zip");
    assert.equal(everyFloorFileName({ shape: "hex", orient: "rows" }, "Tower", { w: 30, h: 20 }, 70, "player"), "tower-hex-70px.zip");
    assert.equal(everyFloorFileName(SQUARES, "🐉", { w: 3, h: 3 }, 70, "player"), "map-3x3-70px.zip");
    const floors = (sizes: [number, number][]) => sizes.map(([w, h], i) => scene(`f${i}`, { bounds: { w, h } }));
    assert.deepEqual(sharedBounds(floors([[30, 20], [30, 20]])), { w: 30, h: 20 });
    assert.equal(sharedBounds(floors([[30, 20], [12, 9]])), null);
  });

  test("fit only at the scale chosen, each within one picture's limit and all within four of them", () => {
    const floor = (w: number, h: number): Pick<Scene, "bounds"> => ({ bounds: { w, h } });
    // 58 by 58 squares fit one picture at 70 px, 59 by 59 do not, where one floor's export would lower its scale.
    assert.equal(everyFloorFits([floor(58, 58)], 70), true);
    assert.equal(everyFloorFits([floor(59, 59)], 70), false);
    assert.equal(everyFloorFits([floor(59, 59)], 50), true);
    // Four floors at the most a picture holds fit, a fifth does not.
    const full = floor(4096, 4096);
    assert.equal(4096 * 4096, MAX_EXPORT_PIXELS);
    assert.equal(everyFloorFits([full, full, full, full], 1), true);
    assert.equal(everyFloorFits([full, full, full, full, floor(1, 1)], 1), false);
    assert.equal(EVERY_FLOOR_PIXELS, 4 * MAX_EXPORT_PIXELS);
    assert.equal(tooMuchText("square"), "Every floor at this size is too much for one file. Pick fewer pixels a square.");
    assert.equal(everyFloorHelp("Tower", 3), "One .zip file with a picture of each of Tower's 3 floors.");
  });

  test("are made one floor at a time, each step named, into one zip, and an overtaken run keeps nothing", async () => {
    const state = tower();
    const entries = floorEntries(exportedFloors(state, TOWER, "dm").floors);
    const steps: string[] = [];
    let drawing = 0;
    const made = await everyFloorZip({
      entries,
      picture: async (floor) => {
        drawing++;
        assert.equal(drawing, 1, "one canvas at a time");
        await new Promise((r) => setTimeout(r, 1));
        drawing--;
        return { blob: new Blob([floor.id]) };
      },
      onFloor: (at, entry) => steps.push(makingText(entry.floor.floor!.name, at, entries.length)),
      stale: () => false,
    });
    assert.ok(made);
    assert.deepEqual(steps, ["Making Ground floor (1 of 3)…", "Making Upper floor (2 of 3)…", "Making Attic (3 of 3)…"]);
    assert.deepEqual(await zipNames(made.zip), ["01-ground-floor.png", "02-upper-floor.png", "03-attic.png"]);

    let stale = false;
    const asked: string[] = [];
    const overtaken = await everyFloorZip({
      entries,
      picture: async (floor) => {
        asked.push(floor.id);
        stale = true;
        return { blob: new Blob([]) };
      },
      onFloor: () => {},
      stale: () => stale,
    });
    assert.equal(overtaken, null);
    assert.deepEqual(asked, [TOWER], "no floor after the run was overtaken");

    await assert.rejects(
      everyFloorZip({
        entries,
        picture: async () => {
          throw new Error("Could not get the players' view of this scene from the server.");
        },
        onFloor: () => {},
        stale: () => false,
      }),
      /players' view/,
    );
  });
});
