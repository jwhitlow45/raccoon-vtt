import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "../limits.ts";
import type { TrapRig } from "../model.ts";
import { opSchema } from "../protocol.ts";
import { LEVEL_BANDS, TRAP_PRESET_IDS, trapPreset, trapPresetFacts, type TrapPreset } from "./traps.ts";

/** A preset placed as the Trap tool places it: its zone at the map's corner, its hits drawn or aimed there. */
function placed(p: TrapPreset): unknown {
  const zone = p.zone.kind === "squares" ? { cells: [{ x: 2, y: 2, w: p.zone.w, h: p.zone.h }] } : p.zone.kind === "wire" ? { wire: { a: [2, 2], b: [4, 2] } } : { door: { edge: "3,3,n" } };
  const hits: TrapRig["hits"] =
    p.hits === "trigger" ? "trigger" : p.hits === "draw" ? { cells: [{ x: 2, y: 3, w: 3, h: 2 }] } : { area: { shape: "cone", size: p.hits.cone, origin: { x: 2.5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: false } };
  return { t: "trap.create", trap: { id: `t-${p.id}`, sceneId: "s1", name: p.name, zone, rig: { ...p.rig, hits, ...(p.pitDepth !== undefined ? { pit: { floor: Math.max(-100, -p.pitDepth) } } : {}) } } };
}

describe("the SRD's example traps as presets (docs/design-v1-traps.md Appendix A)", () => {
  test("every preset at every party level is a trap the protocol takes", () => {
    for (const id of TRAP_PRESET_IDS) {
      for (const band of LEVEL_BANDS) {
        const p = trapPreset(id, band)!;
        const parsed = opSchema.safeParse(placed(p));
        assert.ok(parsed.success, `${id} at ${band}: ${parsed.success ? "" : parsed.error.message}`);
        assert.ok((p.rig.message ?? "").length <= LIMITS.trapMessageChars && (p.rig.note ?? "").length <= LIMITS.trapNoteChars, id);
      }
    }
    assert.equal(trapPreset("nothing", "1-4"), null);
  });

  test("every preset is for party creatures on the floor, with the hint exactly where it has a Perception check", () => {
    for (const id of TRAP_PRESET_IDS) {
      const { rig } = trapPreset(id, "1-4")!;
      assert.equal(rig.who, "party", id);
      assert.equal(rig.floor, true, id);
      assert.equal(rig.preset, id);
      assert.equal(rig.notice, rig.find.some((c) => c.skill === "perception"), id);
    }
  });

  test("the SRD's numbers at each level: Collapsing Roof, Hidden Pit, the darts and the needle", () => {
    const roof = (band: (typeof LEVEL_BANDS)[number]) => trapPreset("collapsing-roof", band)!.rig;
    assert.deepEqual(LEVEL_BANDS.map((b) => [roof(b).save?.dc, roof(b).damage?.[0]?.formula]), [[13, "2d10"], [15, "4d10"], [17, "10d10"], [19, "18d10"]]);
    assert.deepEqual(LEVEL_BANDS.map((b) => trapPreset("hidden-pit", b)!.pitDepth), [10, 30, 60, 120]);
    assert.equal(trapPreset("hidden-pit", "1-4")!.rig.save, undefined, "no save: everyone it hits takes it");
    const darts = trapPreset("poisoned-darts", "17-20")!.rig;
    assert.deepEqual([darts.damage?.[0]?.formula, darts.usesLeft, darts.resets, darts.save?.onPass], ["14d6", 3, "nextTurn", "none"]);
    const needle = trapPreset("poisoned-needle", "11-16")!;
    assert.deepEqual([needle.zone, needle.rig.stops, needle.rig.save, needle.rig.conditions, needle.rig.disarm?.check?.skill], [{ kind: "door" }, false, { ability: "con", dc: 15, onPass: "half" }, ["poisoned"], "sleight-of-hand"]);
    assert.deepEqual(trapPreset("fire-casting-statue", "11-16")!.hits, { cone: 60 });
    assert.deepEqual(trapPreset("fire-casting-statue", "1-4")!.rig.on, ["enter", "turnStart"]);
    assert.equal(trapPreset("rolling-stone", "1-4")!.shows, true);
  });

  test("what the SRD check reads names every preset, and its text never has an em dash", () => {
    assert.deepEqual(trapPresetFacts().map((f) => f.name), TRAP_PRESET_IDS.map((id) => trapPreset(id, "1-4")!.name));
    for (const id of TRAP_PRESET_IDS) for (const band of LEVEL_BANDS) assert.ok(!JSON.stringify(trapPreset(id, band)).includes(String.fromCharCode(0x2014)), id);
  });
});
