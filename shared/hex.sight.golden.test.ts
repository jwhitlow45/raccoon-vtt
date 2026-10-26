import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { GridShape, RoomState, SightTile, Viewer } from "./model.ts";
import { hash128, projectState, stableStringify } from "./project.ts";
import { visionRules } from "./ruleHooks.ts";
import { clearVisionCache } from "./rules/vision.ts";
import { actor, int, pick, reveal, rng, room, scene, token } from "./testutil.ts";

/**
 * A golden record of hex scenes' sight and withheld creatures
 * (docs/design-v1-hex-grids.md section 10, determinism): on a fixed hex
 * rows and hex columns scene, whole party and per player with a holder,
 * the hash of every sight tile and the creatures each player is kept from.
 * Sight and the footprint test must agree bit for bit on every device and
 * every replay, so any change shows here. Write the fixture again with
 * HEX_SIGHT_GOLDEN=write only for a change meant to move them.
 */

const FIXTURE = new URL("./hex.sight.golden.fixture.json", import.meta.url);
const P1: Viewer = { memberId: "p1", role: "player" };
const P2: Viewer = { memberId: "p2", role: "player" };
const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;

function hexScene(shape: GridShape, perPlayer: boolean): RoomState {
  const r = rng(2026);
  const s = room({
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w: 36, h: 28 }, fogEnabled: true, vision: { on: true, light: "dark", ...(perPlayer ? { perPlayer: true } : {}) } }), s2: scene("s2", { order: 1 }) },
  });
  s.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 6.3, y: 8.1, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
  s.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], x: 22.6, y: 14.4, actor: { inline: actor({ senses: "darkvision 20 ft" }) } });
  // An ally lends its sight to every player, the shared sight on a per-player scene.
  s.tokens.ally = token("ally", { kind: "npc", partyVision: true, x: 28.4, y: 20.6, actor: { inline: actor({ senses: "darkvision 25 ft" }) } });
  s.lights.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 18.2, y: 6.7, bright: 10, dim: 20, on: true, walls: true };
  for (let i = 0; i < 60; i++) {
    const size = pick(r, SIZES);
    const custom = size === "custom" ? { w: 0.5 + int(r, 0, 28) / 8, h: 0.5 + int(r, 0, 28) / 8 } : {};
    s.tokens[`g${i}`] = token(`g${i}`, { size, ...custom, x: r() * 35, y: r() * 27 });
  }
  reveal(s, "s1", { x: 0, y: 0, w: 12, h: 10 });
  if (perPlayer) s.holders = { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } };
  return s;
}

function tilesHash(tiles: ReadonlyMap<string, SightTile>): string {
  return hash128(stableStringify([...tiles].sort(([a], [b]) => (a < b ? -1 : 1))));
}

function withheld(state: RoomState, viewer: Viewer): string[] {
  const shown = projectState(state, viewer, { sceneId: "s1" }).tokens;
  return Object.keys(state.tokens)
    .filter((id) => !(id in shown))
    .sort();
}

function record(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const shape of ["hexRows", "hexColumns"] as const) {
    clearVisionCache();
    const party = hexScene(shape, false);
    const each = hexScene(shape, true);
    out[shape] = {
      party: { sight: tilesHash(visionRules.partySight(party, "s1").tiles), withheld: withheld(party, P1) },
      perPlayer: {
        holder: tilesHash(visionRules.holderSight(each, "s1", "p1").tiles),
        shared: tilesHash(visionRules.holderSight(each, "s1", null).tiles),
        withheldHolder: withheld(each, P1),
        withheldOther: withheld(each, P2),
      },
    };
  }
  return out;
}

describe("hex scenes' sight and withheld creatures, pinned", () => {
  test("whole party and per player with a holder, on hex rows and hex columns", () => {
    const now = record();
    if (process.env.HEX_SIGHT_GOLDEN === "write") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    assert.deepEqual(now, pinned);
    // The record is not empty: each player is kept from some creatures and sees others.
    for (const shape of ["hexRows", "hexColumns"]) {
      const r = now[shape] as { party: { withheld: string[] }; perPlayer: { withheldHolder: string[]; withheldOther: string[] } };
      for (const list of [r.party.withheld, r.perPlayer.withheldHolder, r.perPlayer.withheldOther]) assert.ok(list.length > 5 && list.length < 55, `${shape}: ${list.length} withheld`);
    }
  });
});
