import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "#shared/limits.ts";
import { withPitsCounted } from "#shared/rules/pitCount.ts";
import { sightPieces } from "#shared/visionLimits.ts";
import { builderScene } from "../scenes/create.ts";
import { serializedBytes } from "#shared/limits.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { MAX_OPS, MAX_PLAN_OPS, SCENE_PLACEHOLDER } from "./ops.ts";
import { planFitted } from "./plan.ts";
import { previewOf } from "./scratch.ts";
import { stockPlan } from "./stock.ts";
import { stockPool } from "./stockPools.ts";
import type { StockRequest } from "./worker.ts";
import { newSeed } from "./seed.ts";
import { DEFAULT_CONTEXT, HEIGHTS_MAX, MAX_MONSTERS, LIT_MAX, MAX_DOOR_EDGES, roomCap, SECRETS_MAX, THEMES, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * The caps at the largest choices (docs/design/design-v1-dungeon-generator.md
 * section 8, D-261102-384): over 20 seeds of 100 by 100 squares with Rooms
 * at its cap, Dense and Sparse, Winding, Wide and Narrow, heights and the
 * most traps, in both themes, every dungeon keeps its sight pieces, with
 * vision on and pits counted, at or under 80% of the scene's cap, its ops
 * within Make's 140 with the key on and every room stocked at High for 8
 * characters at level 20 (docs/design/design-v1-dungeon-stock.md 5), the
 * plan's own within 100, stocking under 50 ms, the key's page
 * within a page's 32 KiB, its door edges under 200 in one op, and its
 * pillars under the scene's cap, in every theme. The seeds are fixed, so a
 * run is the same dungeons every time.
 */

const MARGIN = Math.floor(LIMITS.sightPiecesPerScene * 0.8);
const SRD = await loadMonsters();
/** The most a stock asks: All, at High, for 8 characters at level 20, on a new scene. */
const stockFor = (theme: DungeonSettings["theme"]): StockRequest => ({ choices: { monsters: 100, difficulty: "high" }, party: [{ count: 8, level: 20 }], pool: stockPool(SRD, theme, { srdImages: {} }), tokensLeft: LIMITS.tokensPerScene });

function seedOf(i: number): string {
  return newSeed((b) => {
    for (let k = 0; k < b.length; k++) b[k] = (i * 131 + k * 29 + 7) & 0xff;
  });
}

test("DG-B: the largest choices in every theme with the key stay at or under 80% of the sight cap with pits counted, within Make's 140 ops, a page's bytes and the door and pillar caps", () => {
  let most = 0;
  let slowest = 0;
  const report: string[] = [];
  for (let i = 0; i < 20; i++) {
    const s: DungeonSettings = {
      w: 100,
      h: 100,
      rooms: roomCap(100, 100),
      density: i % 2 === 0 ? "dense" : "sparse",
      corridors: "winding",
      wide: i % 4 < 2,
      loops: true,
      theme: THEMES[i % THEMES.length]!,
      heights: HEIGHTS_MAX,
      traps: TRAPS_MAX,
      band: "17-20",
      deadEnds: true,
      secrets: SECRETS_MAX,
      lit: LIT_MAX,
      dressing: "full",
      key: true,
    };
    const stock = stockFor(s.theme);
    const made = previewOf(s, seedOf(i), builderScene({ id: "x", name: "Dungeon", w: 100, h: 100 }), DEFAULT_CONTEXT, { name: "x".repeat(80), color: "#30a46c", feetPerCell: 5 }, undefined, null, stock);
    const planned = planFitted(s, seedOf(i), DEFAULT_CONTEXT);
    // The fastest of three runs, so a test run beside other work measures the stocking, not the machine's load.
    let ms = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      stockPlan(planned, seedOf(i), s.theme, stock, null);
      ms = Math.min(ms, performance.now() - t0);
    }
    slowest = Math.max(slowest, ms);
    assert.ok(made.ok, `seed ${i} lands (${JSON.stringify(s)})`);
    const counted = withPitsCounted(made.room, SCENE_PLACEHOLDER);
    const scene = counted.scenes[SCENE_PLACEHOLDER]!;
    const pieces = sightPieces({ ...counted, scenes: { [SCENE_PLACEHOLDER]: { ...scene, vision: { on: true, light: "dark" } } } }, SCENE_PLACEHOLDER);
    most = Math.max(most, pieces);
    report.push(`${s.density} ${s.wide ? "wide" : "narrow"} ${s.theme}: ${pieces} pieces, ${made.ops.length} ops, ${made.plan.monsters?.length ?? 0} creatures, stocked in ${ms.toFixed(1)} ms`);
    assert.ok(pieces <= MARGIN, `seed ${i}: ${pieces} sight pieces, past ${MARGIN}`);
    assert.ok(made.ops.length <= MAX_OPS, `seed ${i}: ${made.ops.length} ops`);
    assert.ok(made.ops.filter((op) => !(op.t === "token.create" && op.token.kind === "monster")).length <= MAX_PLAN_OPS, `seed ${i}: the plan's own ops`);
    assert.ok((made.plan.monsters?.length ?? 0) <= MAX_MONSTERS && (made.plan.monsters?.length ?? 0) > 0, `seed ${i}: ${made.plan.monsters?.length} creatures`);
    const page = made.ops.find((op) => op.t === "journal.create");
    if (page) assert.ok(serializedBytes(page) <= LIMITS.journalPageBytes, `seed ${i}: a ${serializedBytes(page)}-byte key page`);
    const doorOps = made.ops.filter((op) => op.t === "build.edge");
    assert.ok(doorOps.length <= 1);
    assert.ok(made.plan.doors.length <= MAX_DOOR_EDGES);
    const pillars = (made.plan.paint.pillar ?? []).length;
    assert.ok(pillars <= LIMITS.pillarsPerScene, `seed ${i}: ${pillars} pillars`);
  }
  if (process.env.DG_CAPS_REPORT === "1") console.log(`most sight pieces ${most} of ${MARGIN}, slowest stocking ${slowest.toFixed(1)} ms\n${report.join("\n")}`);
  assert.ok(slowest < 50, `stocking took ${slowest.toFixed(1)} ms`);
});
