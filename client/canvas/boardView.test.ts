import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { token } from "#shared/testutil.ts";
import { areaLabelSpot, tokenBoxes } from "../features/areas/labelSpot.ts";
import { pillReach } from "../features/measure/pillPlace.ts";
import { RoomScope } from "../state/scope.ts";
import { boardPillsSlot, boardViewsOf, pillsExcept, type PillSpec } from "./boardView.ts";

test("an area's name keeps off every other layer's pill, never off another area's, so the two never chase each other", () => {
  const marker = { x: 2, y: 3, value: "Moved 20 ft\n10 ft left", size: "screen" as const, small: true, below: true };
  const other = { x: 9, y: 1, name: "Fireball", size: "map" as const, small: true, above: true };
  const pills = { turnStart: [marker], "area:a1": [other] };
  assert.deepEqual(pillsExcept(pills, "area:"), [marker]);
  assert.deepEqual(pillsExcept({}, "area:"), []);
});

test("the board's two views: the clear part leaves out the bars, the canvas holds them, both in cells", () => {
  // A 390 x 844 phone at 20 px a cell, the top bar 52 px and the toolbar with the tool's options and its line 113 px.
  const views = boardViewsOf({ x: 0, y: 100, scale: 20 }, { width: 390, height: 844 }, { top: 52, right: 0, bottom: 113, left: 0 });
  assert.deepEqual(views.canvas, { x0: 0, y0: -5, x1: 19.5, y1: 37.2 });
  assert.deepEqual(views.clear, { x0: 0, y0: (52 - 100) / 20, x1: 19.5, y1: (844 - 113 - 100) / 20 });
});

/** Run the real publication hook with React's dependency and cleanup order. */
function publicationRoom() {
  const store = new RoomScope().get(boardPillsSlot);
  const owners = new Map<string, Map<symbol, readonly PillSpec[]>>();
  const source = readFileSync(new URL("./boardView.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function usePublishPills(");
  const end = source.indexOf("/** Every published pill. */", start);
  assert.ok(start >= 0 && end > start);
  const body = stripTypeScriptTypes(source.slice(start, end)).replace("export function", "function");
  type Effect = { deps: readonly unknown[]; cleanup?: (() => void) | void };
  const tree = (key: string) => {
    const effects: Effect[] = [];
    const refs: { current: unknown }[] = [];
    let shown = false;
    let cursor = 0;
    let refCursor = 0;
    let pending: { before?: (() => void) | void; after: () => void }[] = [];
    const hook = new Function("useScoped", "boardPillsSlot", "pillOwnersSlot", "useTreeShown", "useRef", "useLayoutEffect", "NONE", `${body}\nreturn usePublishPills;`)(
      (slot: unknown) => slot === boardPillsSlot ? store : owners, boardPillsSlot, {}, () => shown,
      (value: unknown) => refs[refCursor++] ?? (refs[refCursor - 1] = { current: value }),
      (run: () => (() => void) | void, deps: readonly unknown[]) => {
        const i = cursor++;
        const before = effects[i];
        if (before && before.deps.length === deps.length && deps.every((value, j) => Object.is(value, before.deps[j]))) return;
        pending.push({ before: before?.cleanup, after: () => { effects[i] = { deps, cleanup: run() }; } });
      }, [],
    ) as (key: string, pills: readonly PillSpec[]) => void;
    return {
      render(visible: boolean, pills: readonly PillSpec[]) {
        shown = visible;
        cursor = 0;
        refCursor = 0;
        pending = [];
        hook(key, pills);
      },
      cleanup() { for (const effect of pending) effect.before?.(); },
      publish() { for (const effect of pending) effect.after(); },
      unmount() { for (const effect of effects) effect.cleanup?.(); },
    };
  };
  const commit = (...trees: ReturnType<typeof tree>[]) => {
    for (const t of trees) t.cleanup();
    for (const t of trees) t.publish();
  };
  return { store, tree, commit };
}

function areaPill(avoid: ReturnType<typeof tokenBoxes>): PillSpec {
  const spot = areaLabelSpot({ top: { x: 5, y: 2 }, bottom: { x: 5, y: 8 }, reach: 3, edge: (dx, side) => ({ x: 5 + dx, y: side === "top" ? 2 : 8 }), size: { width: 108, height: 44 }, scale: 30, avoid });
  return { x: spot.x, y: spot.y, name: "Fireball", size: "map", small: true, maxLines: spot.oneLine ? 1 : 2, above: spot.place === "above", below: spot.place === "below" };
}

for (const key of ["area:a1", "trap:t1"]) for (const order of ["top-first", "iso-first"]) test(`FU40B-OPUS-1: only the shown tree publishes ${key}, ${order}, through a view switch and move-pill updates`, () => {
  const p = publicationRoom();
  const top = p.tree(key);
  const iso = p.tree(key);
  const move = p.tree("turnStart");
  const commitTrees = () => order === "top-first" ? p.commit(top, iso) : p.commit(iso, top);
  const boxes = tokenBoxes([token("goblin", { x: 4, y: 0, name: "Goblin" })], 30, (text, px) => text.length * px * 0.58);
  const topPills = [areaPill(boxes)];
  const isoPills = [areaPill([])];
  assert.notDeepEqual(topPills, isoPills, "a token over the area's default name spot distinguishes the two placements");
  top.render(true, topPills);
  p.commit(top);
  top.render(false, topPills);
  iso.render(true, isoPills);
  commitTrees();
  assert.deepEqual(p.store.getState().pills[key], isoPills);

  // Top-down keeps its memoized spec. The hidden isometric tree gets a
  // new spec when its token boxes empty, and commits after Top-down.
  top.render(true, topPills);
  iso.render(false, [{ ...isoPills[0]! }]);
  commitTrees();
  assert.deepEqual(p.store.getState().pills[key], topPills, "switching back must republish the unchanged Top-down spec");

  const moving: PillSpec[] = [{ x: 5, y: 8, value: "Moved 20 ft\n10 ft left", size: "screen", small: true, below: true }];
  move.render(true, moving);
  p.commit(move);
  const others = pillsExcept(p.store.getState().pills, key.split(":")[0]! + ":").map((pill) => pillReach({ ...pill, scale: 30 }));
  const topMoving = [areaPill([...boxes, ...others])];
  const isoMoving = [areaPill(others)];
  assert.notDeepEqual(topMoving, topPills, "the drag's move pill must exercise a new placement");
  top.render(true, topMoving);
  iso.render(false, isoMoving);
  commitTrees();
  assert.deepEqual(p.store.getState().pills[key], topMoving, "a hidden tree must not overwrite the shown tree when the move pill changes");
  iso.unmount();
  assert.deepEqual(p.store.getState().pills[key], topMoving, "unmounting the hidden tree cannot delete the shown publication");
  top.unmount();
  assert.equal(p.store.getState().pills[key], undefined, "the owning tree cleans up its own pill");
  assert.deepEqual(p.store.getState().pills.turnStart, moving);
});

test("FU40B-OPUS-1: a late cleanup cannot remove the newly shown tree's matching publication", () => {
  const p = publicationRoom();
  const old = p.tree("area:a1");
  const shown = p.tree("area:a1");
  const pills = [areaPill([])];
  old.render(true, pills);
  p.commit(old);
  shown.render(true, pills);
  p.commit(shown);
  old.unmount();
  assert.deepEqual(p.store.getState().pills["area:a1"], pills, "equal geometry still transfers publication ownership");
  shown.unmount();
  assert.equal(p.store.getState().pills["area:a1"], undefined);
});


test("FU40B-OPUS-1: an isometric sibling keeps publishing after the latest owner unmounts", () => {
  const p = publicationRoom();
  const ground = p.tree("area:a1");
  const upright = p.tree("area:a1");
  const groundPills = [areaPill([])];
  const uprightPills = [{ ...groundPills[0]!, x: 6 }];
  ground.render(true, groundPills);
  upright.render(true, uprightPills);
  p.commit(ground, upright);
  assert.deepEqual(p.store.getState().pills["area:a1"], uprightPills);
  upright.unmount();
  assert.deepEqual(p.store.getState().pills["area:a1"], groundPills, "removing one visible publisher must preserve its still-mounted sibling");
  ground.unmount();
  assert.equal(p.store.getState().pills["area:a1"], undefined);
});
