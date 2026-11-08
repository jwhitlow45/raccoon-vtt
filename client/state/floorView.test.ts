import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { drawing, randomState, rng, room, template, token, trap } from "#shared/testutil.ts";
import { ATTIC, TOWER, tower, UPPER } from "../features/floors/testing.ts";
import { CUT_COLLECTIONS, floorViewOf } from "./floorView.ts";
import { shareState } from "./share.ts";

/*
 * The board's cut of the view (docs/design/design-v1-floors.md 10,
 * D-261107-224): the floor-scoped collections cut to the floor shown, the
 * rest whole, and each collection, and the cut itself, keeping its
 * identity while what it holds does not change, so a layer renders only
 * when its floor does.
 */

type View = NonNullable<Parameters<typeof floorViewOf>[0]>;
const asView = (state: RoomState) => ({ ...state, sight: {} }) as unknown as View;

/** A tower with something of each kind on each floor. */
function filled(): View {
  const state = tower();
  for (const [floor, n] of [[TOWER, 0], [UPPER, 1], [ATTIC, 2]] as const) {
    state.tokens[`t${n}`] = token(`t${n}`, { sceneId: floor });
    state.templates[`a${n}`] = template(`a${n}`, { sceneId: floor });
    state.drawings[`d${n}`] = drawing(`d${n}`, { sceneId: floor });
    state.traps[`x${n}`] = trap(`x${n}`, { sceneId: floor });
    state.labels[`l${n}`] = { id: `l${n}`, rev: 0, sceneId: floor, x: 1, y: 1, text: "Door" } as never;
    state.buildChunks[`${floor}:0,0`] = { sceneId: floor, cx: 0, cy: 0 } as never;
    state.fogTiles[`${floor}:0,0`] = { sceneId: floor, tx: 0, ty: 0 } as never;
    state.exploredTiles[`${floor}:1,0`] = { sceneId: floor, tx: 1, ty: 0 } as never;
    state.fogDrafts[floor] = { sceneId: floor } as never;
  }
  const view = asView(state) as unknown as Record<string, unknown>;
  view.sight = { [`${TOWER}:0,0`]: {}, [`${UPPER}:0,0`]: {} };
  return view as unknown as View;
}

describe("the board's cut (floorView)", () => {
  test("a scene of one floor is its own cut: the view itself", () => {
    const view = asView(room({ tokens: { g1: token("g1") } }));
    assert.equal(floorViewOf(view, "s1"), view);
    assert.equal(floorViewOf(view, null), view);
    assert.equal(floorViewOf(null, "s1"), null);
  });

  test("every floor-scoped collection holds the floor shown's alone, and the rest of the view is whole", () => {
    const view = filled();
    const cut = floorViewOf(view, UPPER)! as unknown as Record<string, Record<string, { sceneId?: string }>>;
    for (const kind of CUT_COLLECTIONS) {
      const all = (view as unknown as Record<string, Record<string, unknown> | undefined>)[kind];
      if (!all) continue;
      for (const [key, value] of Object.entries(cut[kind] ?? {})) {
        const floor = kind === "fogDrafts" || kind === "holders" ? key : key.includes(":") ? key.slice(0, key.indexOf(":")) : value.sceneId;
        assert.equal(floor, UPPER, `${kind} ${key}`);
      }
    }
    assert.deepEqual(Object.keys(cut.tokens!), ["t1"]);
    assert.deepEqual(Object.keys(cut.buildChunks!), [`${UPPER}:0,0`]);
    assert.deepEqual(Object.keys(cut.fogDrafts!), [UPPER]);
    assert.deepEqual(Object.keys(cut.sight!), [`${UPPER}:0,0`]);
    for (const whole of ["scenes", "characters", "members", "meta", "encounter", "log", "handouts"]) {
      assert.equal(cut[whole], (view as unknown as Record<string, unknown>)[whole], `${whole} stays whole`);
    }
  });

  test("every collection whose entries stand on a scene is one the cut makes", () => {
    // Any record of the state whose entries carry a scene, as a random room's do, or that is keyed by scene tiles.
    for (let seed = 1; seed <= 20; seed++) {
      const state = randomState(rng(seed)) as unknown as Record<string, unknown>;
      for (const [kind, value] of Object.entries(state)) {
        // Records of entries by id, not the room's single objects (meta, the fight, the clock, what plays).
        if (!value || typeof value !== "object" || Array.isArray(value) || ["meta", "encounter", "clock", "playing", "reminded", "saveOutcomes"].includes(kind)) continue;
        const entries = Object.values(value as Record<string, unknown>);
        const scoped = entries.some((e) => e !== null && typeof e === "object" && typeof (e as { sceneId?: unknown }).sceneId === "string");
        // DM-only bookkeeping no projection holds (memory, the holders' own layers, the marks), and a player's open asks for saves, which reach every floor (10's every-floor folders).
        if (!scoped || ["memory", "memoryBy", "exploredBy", "playedScenes", "memoryShared", "openFloors", "casts"].includes(kind)) continue;
        assert.ok(CUT_COLLECTIONS.includes(kind), `${kind} is cut to the floor shown`);
      }
    }
  });

  test("the cut keeps its identity while the floor shown's records do not change, and makes a new one when they do", () => {
    const first = filled();
    const cut = floorViewOf(first, TOWER);
    // A change on Upper only: the view is new, the board's cut is the same object.
    const moved = shareState(first as unknown as RoomState, { ...(first as unknown as RoomState), tokens: { ...first.tokens, t1: { ...first.tokens.t1!, x: 9 } } }) as unknown as View;
    assert.notEqual(moved, first);
    assert.equal(floorViewOf(moved, TOWER, cut), cut);
    // A change on Ground: a new cut, sharing every collection but the one changed.
    const here = shareState(moved as unknown as RoomState, { ...(moved as unknown as RoomState), tokens: { ...moved.tokens, t0: { ...moved.tokens.t0!, x: 9 } } }) as unknown as View;
    const next = floorViewOf(here, TOWER, cut)!;
    assert.notEqual(next, cut);
    assert.notEqual(next.tokens, cut!.tokens);
    assert.equal(next.drawings, cut!.drawings);
    assert.equal(next.tokens.t1, undefined);
  });
});
