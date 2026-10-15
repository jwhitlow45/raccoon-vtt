import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapPhase, Scene } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, room } from "#shared/testutil.ts";
import {
  activePhaseId,
  addPhase,
  canAddPhase,
  cleanPhaseName,
  FIRST_PHASE_NAME,
  movePhase,
  NOT_SAME_SHAPE,
  phaseProblem,
  phasesOf,
  referenceGrid,
  removeConfirmText,
  removePhase,
  renamePhase,
  TOO_SMALL,
} from "./rules.ts";

const MAP = { assetId: "day", widthPx: 3000, heightPx: 2000, cellPx: 100, originPx: { x: 50, y: 25 } };

function scene(extra: Partial<Scene> = {}): Scene {
  return {
    id: "s1",
    rev: 1,
    name: "Crypt",
    order: 0,
    bounds: { w: 30, h: 20 },
    map: MAP,
    grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
    background: "#000000",
    fogEnabled: true,
    wallsVersion: 0,
    ...extra,
  };
}

function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const DAY: MapPhase = { id: "p-day", name: "Day", assetId: "day", widthPx: 3000, heightPx: 2000 };
const NIGHT: MapPhase = { id: "p-night", name: "Night", assetId: "night", widthPx: 1500, heightPx: 1000 };
const FIRE: MapPhase = { id: "p-fire", name: "On fire", assetId: "fire", widthPx: 6000, heightPx: 4000 };
const GRID = { refWidthPx: 3000, refHeightPx: 2000, cellPx: 100, originPx: { x: 50, y: 25 } };
const phased = (phases: MapPhase[], phaseId = phases[0]!.id) => scene({ phases, phaseId, phaseGrid: GRID });

function sendable(phases: MapPhase[]) {
  const parsed = clientOpSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { phases } });
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
}

describe("the phase list a scene shows", () => {
  test("a map with no phases shows its current image as the one phase, called Day, with no id yet", () => {
    assert.deepEqual(phasesOf(scene()), [{ id: "", name: FIRST_PHASE_NAME, assetId: "day", widthPx: 3000, heightPx: 2000 }]);
    assert.equal(activePhaseId(scene(), phasesOf(scene())), "");
  });

  test("a scene with no map has no phases, and a stored list is shown as stored", () => {
    assert.deepEqual(phasesOf(scene({ map: undefined })), []);
    const s = phased([DAY, NIGHT], NIGHT.id);
    assert.deepEqual(phasesOf(s), [DAY, NIGHT]);
    assert.equal(activePhaseId(s, phasesOf(s)), NIGHT.id);
  });

  test("the grid reference is the stored one, or the current map's own", () => {
    assert.deepEqual(referenceGrid(scene()), GRID);
    const stored = { refWidthPx: 1000, refHeightPx: 500, cellPx: 10, originPx: { x: 0, y: 0 } };
    assert.deepEqual(referenceGrid(scene({ phaseGrid: stored })), stored);
    assert.equal(referenceGrid(scene({ map: undefined })), null);
  });
});

describe("which images can be a phase", () => {
  test("the same shape at any size fits, within a pixel of rounding", () => {
    assert.equal(phaseProblem(GRID, { widthPx: 1500, heightPx: 1000 }), null);
    assert.equal(phaseProblem(GRID, { widthPx: 8192, heightPx: 5461 }), null);
    assert.equal(phaseProblem(GRID, { widthPx: 1501, heightPx: 1001 }), null);
  });

  test("another shape is refused, in the design's words", () => {
    assert.equal(phaseProblem(GRID, { widthPx: 1500, heightPx: 1002 }), NOT_SAME_SHAPE);
    assert.equal(phaseProblem(GRID, { widthPx: 2000, heightPx: 2000 }), NOT_SAME_SHAPE);
    assert.equal(NOT_SAME_SHAPE, "This image is not the same shape as the map, so the grid would not line up.");
  });

  test("an image whose squares would be under a pixel is refused", () => {
    // 100 px squares on 3000 px are under 1 px on a 29 px copy.
    assert.equal(phaseProblem(GRID, { widthPx: 29, heightPx: 19 }), TOO_SMALL);
    assert.equal(phaseProblem(GRID, { widthPx: 30, heightPx: 20 }), null);
    assert.equal(TOO_SMALL, "This image is too small for the map's grid.");
  });
});

describe("editing the list", () => {
  test("a scene's first new phase keeps the current image first, so the map does not change", () => {
    const edit = addPhase(scene(), { assetId: "night", widthPx: 1500, heightPx: 1000, name: "crypt night" }, ids("new-"));
    assert.ok("phases" in edit);
    assert.deepEqual(edit.phases, [
      { id: "new-1", name: "Day", assetId: "day", widthPx: 3000, heightPx: 2000 },
      { id: "new-2", name: "crypt night", assetId: "night", widthPx: 1500, heightPx: 1000 },
    ]);
    sendable(edit.phases);
  });

  test("later phases go at the end, and a list at the limit takes no more", () => {
    const edit = addPhase(phased([DAY, NIGHT]), { assetId: "fire", widthPx: 6000, heightPx: 4000, name: "On fire" }, ids("n"));
    assert.ok("phases" in edit);
    assert.deepEqual(
      edit.phases.map((p) => p.name),
      ["Day", "Night", "On fire"],
    );
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...DAY, id: `p${i}`, name: `P${i}` }));
    assert.equal(canAddPhase(eight), false);
    assert.equal(canAddPhase(eight.slice(1)), true);
    assert.deepEqual(addPhase(phased(eight), { assetId: "x", widthPx: 3000, heightPx: 2000, name: "x" }, ids("n")), { problem: "A map can have at most 8 phases." });
  });

  test("an image of another shape, or too small, is refused before anything is sent", () => {
    assert.deepEqual(addPhase(phased([DAY]), { assetId: "sq", widthPx: 2000, heightPx: 2000, name: "sq" }, ids("n")), { problem: NOT_SAME_SHAPE });
    assert.deepEqual(addPhase(scene(), { assetId: "tiny", widthPx: 15, heightPx: 10, name: "tiny" }, ids("n")), { problem: TOO_SMALL });
    assert.deepEqual(addPhase(scene({ map: undefined }), { assetId: "x", widthPx: 15, heightPx: 10, name: "x" }, ids("n")), { problem: "Add a map image first." });
  });

  test("the reference stays the stored one, not the image showing now", () => {
    // Showing a half-size phase, a full-size image still fits the stored reference.
    const s = scene({ map: { ...MAP, assetId: "night", widthPx: 1500, heightPx: 1000, cellPx: 50 }, phases: [DAY, NIGHT], phaseId: NIGHT.id, phaseGrid: GRID });
    assert.ok("phases" in addPhase(s, { assetId: "fire", widthPx: 6000, heightPx: 4000, name: "fire" }, ids("n")));
  });

  test("renaming the implicit first phase stores the list, and a name that does not change sends nothing", () => {
    assert.deepEqual(renamePhase(scene(), "", "Dawn", ids("n")), [{ id: "n1", name: "Dawn", assetId: "day", widthPx: 3000, heightPx: 2000 }]);
    assert.equal(renamePhase(scene(), "", "  Day ", ids("n")), null);
    assert.deepEqual(renamePhase(phased([DAY, NIGHT]), NIGHT.id, "Midnight", ids("n")), [DAY, { ...NIGHT, name: "Midnight" }]);
    assert.equal(renamePhase(phased([DAY, NIGHT]), "gone", "x", ids("n")), null);
  });

  test("names lose control and text direction characters, are cut to the protocol's length, and are never empty", () => {
    assert.equal(cleanPhaseName("  On\u0007 fire\u202e ", "x"), "On  fire");
    assert.equal(cleanPhaseName("   ", "Phase 2"), "Phase 2");
    assert.equal(cleanPhaseName("a".repeat(100), "x").length, 80);
    const renamed = renamePhase(phased([DAY, NIGHT]), NIGHT.id, "Night\u2028two", ids("n"));
    assert.ok(renamed);
    sendable(renamed);
  });

  test("moving a phase swaps it with its neighbor and does nothing past either end", () => {
    const s = phased([DAY, NIGHT, FIRE]);
    assert.deepEqual(movePhase(s, FIRE.id, -1), [DAY, FIRE, NIGHT]);
    assert.deepEqual(movePhase(s, DAY.id, 1), [NIGHT, DAY, FIRE]);
    assert.equal(movePhase(s, DAY.id, -1), null);
    assert.equal(movePhase(s, FIRE.id, 1), null);
  });

  test("removing takes one phase out, but never the last one, which is the map itself", () => {
    assert.deepEqual(removePhase(phased([DAY, NIGHT, FIRE], NIGHT.id), NIGHT.id), [DAY, FIRE]);
    assert.equal(removePhase(phased([DAY]), DAY.id), null);
    assert.equal(removePhase(scene(), ""), null);
    assert.equal(removePhase(phased([DAY, NIGHT]), "gone"), null);
  });

  test("removing the phase showing says, once armed, which phase the map switches to", () => {
    const list = [DAY, NIGHT, FIRE];
    assert.equal(removeConfirmText(list, DAY.id, true), `Tap again: the map switches to ${NIGHT.name}`);
    assert.equal(removeConfirmText(list, NIGHT.id, true), `Tap again: the map switches to ${DAY.name}`);
    // A phase not showing changes nothing anyone sees.
    assert.equal(removeConfirmText(list, FIRE.id, false), "Tap again to remove");
  });
});

describe("the client's verdict matches the reducer's", () => {
  test("for every size around the reference, the list the panel would send applies exactly when the panel allows it", () => {
    const base = { ...room(), scenes: { ...room().scenes, s1: scene() } };
    const sizes: [number, number][] = [];
    for (const w of [20, 29, 30, 31, 1500, 1501, 2999, 3000, 6000, 16_384]) {
      const h = (w * 2000) / 3000;
      for (const dh of [-2, -1, -0.5, 0, 0.5, 1, 2]) sizes.push([w, Math.max(1, Math.round(h + dh))]);
    }
    for (const [widthPx, heightPx] of sizes) {
      const edit = addPhase(scene(), { assetId: "next", widthPx, heightPx, name: "Next" }, ids("n"));
      const list = "phases" in edit ? edit.phases : [...phasesOf(scene()).map((p) => ({ ...p, id: "n1" })), { id: "n2", name: "Next", assetId: "next", widthPx, heightPx }];
      const result = applyOp(base, { t: "scene.update", sceneId: "s1", patch: { phases: list } }, DM, env(1));
      assert.equal(result.ok, "phases" in edit, `${widthPx} x ${heightPx}: the panel said ${"problem" in edit ? edit.problem : "yes"}`);
      if (!result.ok && "problem" in edit) assert.equal(result.message, edit.problem);
    }
  });
});
