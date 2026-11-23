import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { token } from "#shared/testutil.ts";
import { areaLabelSpot, tokenBoxes } from "../features/areas/labelSpot.ts";
import { pillReach } from "../features/measure/pillPlace.ts";
import { LiveCamera } from "../state/liveCamera.ts";
import { RoomScope } from "../state/scope.ts";
import { boardPillsSlot, boardViewOf, boardViewsOf, jumpCamera, pillsExcept, pillsOnly, publishPillsEffect, REST_MS, restViewSlot, RestViewWatch, retractPillsEffect, type PillSpec } from "./boardView.ts";

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

/** Drive the real publication effects with React's dependency and cleanup order. */
function publicationRoom() {
  const store = new RoomScope().get(boardPillsSlot);
  const owners: Parameters<typeof publishPillsEffect>[0]["owners"] = new Map();
  type Effect = { deps: readonly unknown[]; cleanup?: (() => void) | void };
  const tree = (key: string) => {
    const effects: Effect[] = [];
    const owner = Symbol();
    let shown = false;
    let cursor = 0;
    let pending: { before?: (() => void) | void; after: () => void }[] = [];
    const layoutEffect = (run: () => (() => void) | void, deps: readonly unknown[]) => {
      const i = cursor++;
      const before = effects[i];
      if (before && before.deps.length === deps.length && deps.every((value, j) => Object.is(value, before.deps[j]))) return;
      pending.push({ before: before?.cleanup, after: () => { effects[i] = { deps, cleanup: run() }; } });
    };
    return {
      render(visible: boolean, pills: readonly PillSpec[]) {
        shown = visible;
        cursor = 0;
        pending = [];
        const claim = { store, owners, key, owner, shown };
        layoutEffect(() => publishPillsEffect(claim, pills), [store, owners, key, pills, shown]);
        layoutEffect(() => retractPillsEffect(claim), [store, owners, key, shown]);
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
  const boxes = tokenBoxes([token("goblin", { x: 4, y: 0, name: "Goblin" })], 30, (text, px) => text.length * px * 0.58, new Map());
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

test("FU40B-OPUS-1: the tree that published last is the one a remaining publication falls back to", () => {
  const p = publicationRoom();
  const [a, b, c] = [p.tree("area:a1"), p.tree("area:a1"), p.tree("area:a1")] as const;
  const first = [areaPill([])];
  const second = [{ ...first[0]!, x: 6 }];
  const third = [{ ...first[0]!, x: 7 }];
  const again = [{ ...first[0]!, x: 8 }];
  a.render(true, first); b.render(true, second); c.render(true, third);
  p.commit(a, b, c);
  a.render(true, again);
  p.commit(a);
  assert.deepEqual(p.store.getState().pills["area:a1"], again);
  c.unmount();
  assert.deepEqual(p.store.getState().pills["area:a1"], again, "a republish moves its tree to the back of the line");
});

/** A phone's canvas and bars, and the rest view's store and camera, with setTimeout and Date mocked. */
function restRoom() {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const size = { width: 390, height: 844 };
  const insets = { top: 52, right: 0, bottom: 113, left: 0 };
  return { size, insets, live: new LiveCamera(), store: new RoomScope().get(restViewSlot), clear: (c: { x: number; y: number; scale: number }) => boardViewOf(c, size, insets) };
}

test("the rest view is the clear view at once, then follows the camera only once it has held still REST_MS, never on a drawn camera's notice or after it stops (ISO-1-PHONE-EDGE)", () => {
  const { size, insets, live, store, clear } = restRoom();
  try {
    const first = { x: 0, y: 100, scale: 20 };
    live.write(first);
    const watch = new RestViewWatch(live, store);
    watch.set(size, insets, "s1");
    const stop = () => watch.stop();
    assert.deepEqual(store.getState().rest, clear(first), "at once");
    // A pan's frames, each under REST_MS after the last.
    for (let i = 1; i <= 5; i++) {
      live.write({ ...first, x: i * 30 });
      mock.timers.tick(REST_MS - 1);
      assert.deepEqual(store.getState().rest, clear(first), `frame ${i}`);
    }
    mock.timers.tick(1);
    assert.deepEqual(store.getState().rest, clear({ ...first, x: 150 }), "at rest");
    // A pinch the same way.
    live.write({ x: 150, y: 100, scale: 24 });
    mock.timers.tick(REST_MS - 1);
    assert.deepEqual(store.getState().rest, clear({ ...first, x: 150 }));
    mock.timers.tick(1);
    assert.deepEqual(store.getState().rest, clear({ x: 150, y: 100, scale: 24 }));
    // The canvas drawing a camera moves nothing.
    const held = store.getState().rest;
    live.setDrawn({ x: 999, y: 0, scale: 2 });
    mock.timers.tick(REST_MS * 2);
    assert.equal(store.getState().rest, held);
    // A move just before the board stops, and one after: neither lands.
    live.write({ x: 5, y: 0, scale: 10 });
    stop();
    live.write({ x: 0, y: 0, scale: 10 });
    mock.timers.tick(REST_MS * 2);
    assert.equal(store.getState().rest, held, "stopped");
  } finally {
    mock.timers.reset();
  }
});

test("random runs of pans, pinches, drawn notices and waits: the rest view changes only REST_MS after the last move, then holds that move's clear view, and never writes the box it holds (ISO-1-PHONE-EDGE)", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let runNo = 0; runNo < 200; runNo++) {
    const { size, insets, live, store, clear } = restRoom();
    try {
      let cam = { x: 0, y: 0, scale: 20 };
      live.write(cam);
      let lastMove = Date.now();
      const changes: { quiet: boolean; same: boolean }[] = [];
      let before = store.getState().rest;
      let started = false;
      const unsub = store.subscribe((st) => {
        const b = before;
        if (started) changes.push({ quiet: Date.now() - lastMove >= REST_MS, same: b !== null && st.rest !== null && JSON.stringify(b) === JSON.stringify(st.rest) });
        before = st.rest;
      });
      const watch = new RestViewWatch(live, store);
      watch.set(size, insets, "s1");
      const stop = () => watch.stop();
      started = true;
      assert.deepEqual(store.getState().rest, clear(cam), `run ${runNo}: at once`);
      for (let step = 0; step < 40; step++) {
        const r = rand();
        if (r < 0.45) {
          // A pan or a pinch frame, now and then back to a camera seen before.
          cam = r < 0.3 ? { ...cam, x: cam.x + Math.round(rand() * 60 - 30) } : r < 0.4 ? { ...cam, scale: Math.max(5, cam.scale + Math.round(rand() * 6 - 3)) } : { x: 0, y: 0, scale: 20 };
          const wrote = live.camera;
          live.write(cam);
          if (live.camera !== wrote) lastMove = Date.now();
        } else if (r < 0.55) {
          live.setDrawn({ x: rand() * 100, y: 0, scale: 20 });
        } else {
          mock.timers.tick(Math.floor(rand() * REST_MS * 1.5));
        }
        // Quiet for REST_MS: the view is the camera's.
        if (Date.now() - lastMove >= REST_MS) assert.deepEqual(store.getState().rest, clear(live.camera!), `run ${runNo} step ${step}: at rest`);
      }
      // The first write is the start's, at once. Every later one comes REST_MS after a move, and none repeats the box held.
      for (const c of changes) {
        assert.equal(c.quiet, true, `run ${runNo}: a write mid-gesture`);
        assert.equal(c.same, false, `run ${runNo}: a write of the box held`);
      }
      unsub();
      stop();
    } finally {
      mock.timers.reset();
    }
  }
});

test("the rest view settles at once on a camera jump that is no gesture, and when the scene, the canvas or the bars change, and not when nothing did (D-261122-220)", () => {
  const { size, insets, live, store, clear } = restRoom();
  try {
    const first = { x: 0, y: 100, scale: 20 };
    live.write(first);
    const watch = new RestViewWatch(live, store);
    watch.set(size, insets, "s1");
    // Fit map or a token brought into view: the board writes the camera and settles.
    const fit = { x: -300, y: 40, scale: 8 };
    live.write(fit);
    watch.settle();
    assert.deepEqual(store.getState().rest, clear(fit), "a jump");
    // Mid-pan, the same scene, canvas and bars: nothing.
    const panned = { ...fit, x: -250 };
    live.write(panned);
    watch.set(size, insets, "s1");
    assert.deepEqual(store.getState().rest, clear(fit), "the same scene");
    // Another scene shows, its camera already written: at once.
    watch.set(size, insets, "s2");
    assert.deepEqual(store.getState().rest, clear(panned), "a scene switch");
    const more = { ...fit, x: -200 };
    live.write(more);
    watch.set(size, { ...insets, bottom: 200 }, "s2");
    assert.deepEqual(store.getState().rest, boardViewOf(more, size, { ...insets, bottom: 200 }), "the bars");
    live.write({ ...more, x: -150 });
    watch.set({ width: 400, height: 844 }, { ...insets, bottom: 200 }, "s2");
    assert.deepEqual(store.getState().rest, boardViewOf({ ...more, x: -150 }, { width: 400, height: 844 }, { ...insets, bottom: 200 }), "the canvas");
    // After a restart the pan's rest still follows.
    live.write({ ...more, x: -100 });
    mock.timers.tick(REST_MS);
    assert.deepEqual(store.getState().rest, boardViewOf({ ...more, x: -100 }, { width: 400, height: 844 }, { ...insets, bottom: 200 }), "at rest");
    watch.stop();
  } finally {
    mock.timers.reset();
  }
});

test("restarting the rest watch for a new scene, canvas or bars, or after a stop, keeps exactly one camera listener, so no restart adds pan work (FU10PILLS-SOL-R2-1)", () => {
  const { size, insets, live, store } = restRoom();
  try {
    let listeners = 0;
    const subscribe = live.subscribe;
    // The slot's own count: each subscription adds one until its unsubscribe runs once.
    (live as { subscribe: typeof subscribe }).subscribe = (listener) => {
      listeners++;
      const off = subscribe(listener);
      let gone = false;
      return () => {
        if (!gone) listeners--;
        gone = true;
        off();
      };
    };
    live.write({ x: 0, y: 0, scale: 20 });
    const watch = new RestViewWatch(live, store);
    watch.set(size, insets, "s1");
    assert.equal(listeners, 1, "started");
    watch.set(size, insets, "s1");
    assert.equal(listeners, 1, "the same place changes nothing");
    for (const [i, sceneId] of ["s2", "s3", "s4", "s1"].entries()) {
      watch.set(i % 2 === 0 ? size : { ...size, width: size.width + 10 }, i % 2 === 0 ? { ...insets, top: insets.top + 8 } : insets, sceneId);
      assert.equal(listeners, 1, `restart ${i + 1}`);
    }
    watch.stop();
    assert.equal(listeners, 0, "stopped");
    watch.stop();
    assert.equal(listeners, 0, "a second stop");
    watch.set(size, insets, "s1");
    assert.equal(listeners, 1, "started again after a stop");
    watch.stop();
  } finally {
    mock.timers.reset();
  }
});

test("a camera jump settles the rest view at once, in Stage's setCam, and a pan's frame does not (FU10PILLS-R2)", () => {
  const { size, insets, live, store, clear } = restRoom();
  try {
    const first = { x: 0, y: 100, scale: 20 };
    live.write(first);
    const watch = new RestViewWatch(live, store);
    watch.set(size, insets, "s1");
    const shown: unknown[] = [];
    const fit = { x: -300, y: 40, scale: 8 };
    jumpCamera(live, watch.settle, (c) => shown.push(c), fit);
    assert.deepEqual(store.getState().rest, clear(fit), "settled with no wait");
    assert.deepEqual(shown, [fit]);
    live.write({ ...fit, x: -250 });
    assert.deepEqual(store.getState().rest, clear(fit), "a pan's frame waits");
    // Stage's setCam is that call, so a Fit map or a scene's camera never lays pills out against the old view.
    const stage = readFileSync(new URL("./Stage.tsx", import.meta.url), "utf8");
    assert.match(stage, /\(c: Camera\) => jumpCamera\(liveCam, settleRestView, setCamState, c\)/);
  } finally {
    mock.timers.reset();
  }
});

test("pillsOnly keeps the pills under a prefix, the complement of pillsExcept (LP49-PILLS-1)", () => {
  const pill = (name: string): PillSpec => ({ name, x: 0, y: 0, size: "map" });
  const all = { "trap:a": [pill("Pit")], "trap:b": [pill("Needle"), pill("DC 15")], turnStart: [pill("Moved")], "area:c": [pill("Cone")] };
  assert.deepEqual(pillsOnly(all, "trap:").map((p) => p.name), ["Pit", "Needle", "DC 15"]);
  assert.deepEqual(pillsExcept(all, "trap:").map((p) => p.name), ["Moved", "Cone"]);
  assert.deepEqual(pillsOnly({}, "trap:"), []);
});
