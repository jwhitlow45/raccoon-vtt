import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sceneGrid } from "#shared/rules/grid.ts";
import { bandsOf, drawChildrenMeeting, KeptRelief, onDeviceGrid, planDraw, probeSelfCopy, type KeptAt } from "./kept.ts";
import { installPath2D, KeptRig, TestCanvas, type RigScene } from "./keptTesting.ts";

/*
 * The kept relief picture's rules (docs/design-v1-relief-pan.md 5 and 10.2):
 * what scrolls, what repaints whole, the regions a scroll paints, the
 * device grid, the path for another canvas and the self-copy probe.
 */

installPath2D();

const AT: KeptAt = { x: 10, y: 20, scale: 12, turn: 0, width: 200, height: 100, ratio: 2, key: "k" };

describe("whether a draw scrolls", () => {
  test("a camera-only move at the same view scrolls by its whole device pixels", () => {
    const plan = planDraw(AT, { ...AT, x: 13, y: 18.5 }, true, true);
    assert.deepEqual(plan.kind === "scroll" && [plan.dx, plan.dy], [6, -3]);
  });

  test("each cause repaints whole: no probe, no picture yet, a content mark, a new scale, turn, size, ratio or stage key, a move off the grid, a move as large as the canvas", () => {
    const why = (kept: KeptAt | null, now: KeptAt, clean = true, scrolling = true) => {
      const plan = planDraw(kept, now, clean, scrolling);
      return plan.kind === "whole" ? plan.why : "scroll";
    };
    assert.equal(why(AT, AT, true, false), "probe");
    assert.equal(why(null, AT), "first");
    assert.equal(why(AT, { ...AT, x: 11 }, false), "content");
    assert.equal(why(AT, { ...AT, scale: 12.5 }), "view");
    assert.equal(why(AT, { ...AT, turn: 1 }), "view");
    assert.equal(why(AT, { ...AT, width: 202 }), "view");
    assert.equal(why(AT, { ...AT, height: 98 }), "view");
    assert.equal(why(AT, { ...AT, ratio: 1.5 }), "view");
    assert.equal(why(AT, { ...AT, key: "low power" }), "view");
    assert.equal(why(AT, { ...AT, x: 10.3 }), "off-grid");
    assert.equal(why(AT, { ...AT, x: 10 + 100 }), "jump", "200 device px across");
    assert.equal(why(AT, { ...AT, y: 20 - 50 }), "jump", "100 device px down");
    assert.equal(why(AT, { ...AT, x: 10 + 99.5 }), "scroll", "a pixel short of the canvas still scrolls");
  });
});

describe("what a move uncovers", () => {
  test("a band at the side it moved from, on each axis it moved on, for each sign and both", () => {
    assert.deepEqual(bandsOf(3, 0, 20, 10), [{ x0: 0, y0: 0, x1: 3, y1: 10 }]);
    assert.deepEqual(bandsOf(-3, 0, 20, 10), [{ x0: 17, y0: 0, x1: 20, y1: 10 }]);
    assert.deepEqual(bandsOf(0, 2, 20, 10), [{ x0: 0, y0: 0, x1: 20, y1: 2 }]);
    assert.deepEqual(bandsOf(0, -2, 20, 10), [{ x0: 0, y0: 8, x1: 20, y1: 10 }]);
    assert.deepEqual(bandsOf(-3, 2, 20, 10), [
      { x0: 17, y0: 0, x1: 20, y1: 10 },
      { x0: 0, y0: 0, x1: 20, y1: 2 },
    ]);
    assert.deepEqual(bandsOf(0, 0, 20, 10), []);
  });

  test("the regions are tested one by one: a piece in the corner the two bands leave, inside their box together, never draws", () => {
    const drawn: string[] = [];
    const bands = bandsOf(-3, 2, 20, 10);
    const corner = { x0: 4, y0: 4, x1: 8, y1: 8 };
    const inBand = { x0: 18, y0: 5, x1: 19, y1: 6 };
    drawChildrenMeeting(["corner", "band", "unbounded"], (c) => (c === "corner" ? corner : c === "band" ? inBand : null), bands, (c) => drawn.push(c));
    assert.deepEqual(drawn, ["band", "unbounded"], "a child that meets no region is skipped, and one with no bounds always draws");
  });
});

describe("the device grid (D-261030-542)", () => {
  for (const r of [1, 1.25, 1.5, 2]) {
    test(`at a pixel ratio of ${r}, every move between cameras on the grid is whole device pixels, back and forth`, () => {
      let kept: KeptAt = { ...AT, ratio: r, x: 0, y: 0 };
      let x = 0;
      const moves = [0.37, -0.81, 1.13, -1.13, 0.5, -0.5, 2.71, -2.71, 0.66, -0.66];
      for (let round = 0; round < 5; round++) {
        for (const m of moves) {
          x += m;
          const c = onDeviceGrid({ x, y: -x / 2, scale: 12 }, r);
          const now = { ...kept, x: c.x, y: c.y };
          const plan = planDraw(kept, now, true, true);
          assert.notEqual(plan.kind === "whole" && plan.why, "off-grid", `a move to ${x} at ${r}`);
          kept = now;
        }
      }
    });
  }
});

describe("the self-copy probe (D-261030-537)", () => {
  test("a canvas that copies onto itself as it should reads red then blue a pixel over", () => {
    assert.equal(probeSelfCopy(new TestCanvas(4, 4).g), "ok");
  });

  test("one that copies forward through its own pixels reads wrong, and one whose readback throws says to probe again", () => {
    const broken = new TestCanvas(4, 4);
    broken.brokenCopy = true;
    assert.equal(probeSelfCopy(broken.g), "off");
    const tainted = new TestCanvas(4, 4);
    tainted.throwOnRead = true;
    assert.equal(probeSelfCopy(tainted.g), "again");
  });

  test("it runs at the first draw with a size, before anything paints; a 0 by 0 draw or a thrown readback means probe again, and only a wrong read turns scrolling off for good", () => {
    const kept = new KeptRelief();
    const order: string[] = [];
    const draw = (c: TestCanvas, at: KeptAt) =>
      kept.draw({ g: c.g, width: c.width, height: c.height, ratio: 2 }, {
        at,
        clean: true,
        whole: () => order.push("whole"),
        tonedNow: () => [],
        regions: () => order.push("regions"),
      });
    draw(new TestCanvas(0, 0), { ...AT, width: 0, height: 0 });
    assert.equal(kept.probe, "pending", "a stage mounted at 0 by 0 waits");
    draw(new TestCanvas(2, 1), { ...AT, width: 2, height: 1 });
    assert.equal(kept.probe, "pending", "so does one too small to hold the probe's three columns");
    const tainted = new TestCanvas(20, 10);
    tainted.throwOnRead = true;
    draw(tainted, { ...AT, width: 20, height: 10 });
    assert.equal(kept.probe, "pending", "a thrown readback waits");
    const c = new TestCanvas(20, 10);
    const g = c.g;
    // The probe's own paint comes before the whole draw.
    const fillRect = g.fillRect.bind(g);
    let probed = -1;
    g.fillRect = (...a: [number, number, number, number]) => {
      if (probed < 0) probed = order.length;
      fillRect(...a);
    };
    const before = order.length;
    draw(c, { ...AT, width: 20, height: 10 });
    assert.equal(kept.probe, "ok");
    assert.equal(probed, before, "the probe painted before this draw's whole repaint");
    assert.equal(order[before], "whole", "and the draw it ran in repaints whole, since the probe's corner is spoilt");
    assert.equal(draw(c, { ...AT, width: 20, height: 10, x: AT.x + 1 }).kind, "scroll");

    const off = new KeptRelief();
    const wrong = new TestCanvas(20, 10);
    wrong.brokenCopy = true;
    const plans: string[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = off.draw({ g: wrong.g, width: 20, height: 10, ratio: 2 }, { at: { ...AT, width: 20, height: 10, x: AT.x + i }, clean: true, whole: () => {}, tonedNow: () => [], regions: () => {} });
      plans.push(plan.kind === "whole" ? plan.why : plan.kind);
    }
    assert.equal(off.probe, "off");
    assert.deepEqual(plans, ["probe", "probe", "probe"], "every draw after a wrong read repaints whole, today's behavior");
  });
});

function flatScene(): RigScene {
  const ground = new Map<string, number>();
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) ground.set(`${x},${y}`, (x + y) % 3 === 0 ? 2 : 0);
  return { grid: sceneGrid({}), w: 6, h: 6, ground };
}

function rig(): KeptRig {
  const r = new KeptRig(flatScene(), { width: 60, height: 40, ratio: 2, camera: { x: 4, y: 2, scale: 8.37 }, margin: 0 });
  r.frame();
  return r;
}

function whyLast(r: KeptRig, before: { whole: number; scrolls: number }): "whole" | "scroll" | "none" {
  const s = r.scheduler.kept!.stats;
  return s.whole > before.whole ? "whole" : s.scrolls > before.scrolls ? "scroll" : "none";
}

describe("camera marks and content marks (5.2, 5.4)", () => {
  test("a mark made inside the scheduler's camera move scrolls, and the same mark outside it repaints whole", () => {
    const r = rig();
    let s = { ...r.scheduler.kept!.stats };
    r.pan(1.5, 0.5);
    r.frame();
    assert.equal(whyLast(r, s), "scroll");
    s = { ...r.scheduler.kept!.stats };
    r.mark("relief");
    r.frame();
    assert.equal(whyLast(r, s), "whole");
    assert.deepEqual(r.canvas.diff(r.whole()), []);
  });

  test("a ground draw the scheduler makes for the camera keeps the scroll; one it makes for content, and one Konva makes on its own, repaint whole", () => {
    const r = rig();
    let s = { ...r.scheduler.kept!.stats };
    r.pan(-2, 1);
    r.frame();
    assert.equal(whyLast(r, s), "scroll", "for the camera");
    s = { ...r.scheduler.kept!.stats };
    r.groundLook++;
    r.mark("ground");
    r.frame();
    assert.equal(whyLast(r, s), "whole", "for content");
    s = { ...r.scheduler.kept!.stats };
    // Konva's resize draws the layer itself: the counter moves, the scheduler never asked.
    r.groundDraws++;
    r.pan(1, 0);
    r.frame();
    assert.equal(whyLast(r, s), "whole", "by Konva directly");
    assert.deepEqual(r.canvas.diff(r.whole()), []);
  });

  test("a move as large as the canvas repaints whole", () => {
    const r = rig();
    const s = { ...r.scheduler.kept!.stats };
    r.pan(r.size.width, 0);
    r.frame();
    assert.equal(whyLast(r, s), "whole");
    assert.equal(r.scheduler.kept!.stats.why.jump, 1);
  });

  test("a draw into another canvas takes Konva's own path there and leaves the kept picture as it was", () => {
    const r = rig();
    const s = { ...r.scheduler.kept!.stats };
    const other = new TestCanvas(60, 40);
    // The relief layer's drawScene, called with another canvas: the bench's parity images, the guide's pictures.
    r.drawInto(other);
    assert.deepEqual(other.diff(r.whole()), [], "the whole view in that canvas");
    assert.deepEqual({ ...r.scheduler.kept!.stats }, s, "no kept draw counted");
    r.pan(1, 1);
    r.frame();
    assert.equal(whyLast(r, s), "scroll", "the picture on screen still scrolls");
  });
});

describe("ground copies near the ground canvas's edges (5.3)", () => {
  /** Pits along the top rows and tall columns below, so floors near the screen's top copy ground from above it and tops under a capped margin from below it. */
  function edgeScene(): RigScene {
    const ground = new Map<string, number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ground.set(`${x},${y}`, y < 3 ? -2 : y > 5 ? 3 : 0);
    return { grid: sceneGrid({}), w: 8, h: 8, ground };
  }

  for (const margin of [0, 20]) {
    test(`a connected pit by the screen's top and tops under a ${margin === 0 ? "capped" : "small"} margin, panned down and up, repaint the cells that gain and lose ground`, () => {
      const r = new KeptRig(edgeScene(), { width: 60, height: 44, ratio: 2, camera: { x: -8, y: -6, scale: 7.83 }, margin });
      r.frame();
      let repaired = 0;
      for (const [dx, dy] of [[0, 3.5], [0, 3.5], [0, -2], [0, -4.5], [1.5, 2.5], [0, -3]] as const) {
        const before = r.scheduler.kept!.stats.repair;
        const fit = r.pan(dx, dy);
        if (fit !== "inside") r.commit();
        r.frame();
        repaired += r.scheduler.kept!.stats.repair - before;
        assert.deepEqual(r.canvas.diff(r.whole()), [], `after a pan by ${dx},${dy}`);
      }
      assert.ok(repaired > 0, "some scroll repaired a toned cell");
    });
  }

  test("a batch of tops straddling the ground canvas's bottom tones only its own cells past it", () => {
    const ground = new Map<string, number>();
    for (let x = 0; x < 8; x++) ground.set(`${x},5`, 2);
    const r = new KeptRig({ grid: sceneGrid({}), w: 8, h: 8, ground }, { width: 60, height: 44, ratio: 2, camera: { x: 4, y: -6, scale: 7.83 }, margin: 0 });
    r.frame();
    const toned = r.tonedNow();
    const tops = r.items.flatMap((i) => (i.kind === "run" ? i.pieces : [])).filter((p) => p.kind === "column");
    assert.ok(toned.length > 0 && toned.length < tops.length, `${toned.length} of ${tops.length} tops toned`);
  });
});

describe("the scroll path and the frame's background work", () => {
  test("a scroll draws only the children whose painted bounds meet its strips", () => {
    const ground = new Map<string, number>();
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) ground.set(`${x},${y}`, (x * 3 + y) % 4 === 0 ? 1 : 0);
    const r = new KeptRig({ grid: sceneGrid({}), w: 30, h: 30, ground }, { width: 200, height: 150, ratio: 2, camera: { x: 50, y: -40, scale: 9.13 }, margin: 0 });
    for (let i = 0; i < 12; i++) r.standees.push({ id: `t${i}`, x: (i * 7) % 30, y: (i * 11) % 30, size: 1, look: 0 });
    r.commit();
    r.frame();
    r.childDraws = 0;
    r.pan(1, 0);
    r.frame();
    assert.ok(r.childDraws > 0 && r.childDraws < r.items.length, `${r.childDraws} of ${r.items.length} children`);
  });

  test("a frame that repaints whole for the camera alone, at a new zoom, runs no background slice", () => {
    const r = rig();
    let ran = 0;
    r.scheduler.background(() => {
      ran++;
      return true;
    });
    r.frame();
    assert.equal(ran, 1);
    r.scheduler.moveCamera(() => {
      r.camera = { ...r.camera, scale: r.camera.scale * 1.1 };
      r.scheduler.mark("ground");
      r.scheduler.mark("relief");
    });
    r.frame();
    assert.equal(r.scheduler.kept!.stats.why.view, 1);
    assert.equal(ran, 1, "the zoom's whole repaint sliced nothing");
    r.frame();
    assert.equal(ran, 2);
  });
});

describe("a scroll's regions, each tested on its own (5.2)", () => {
  test("a column in the middle meets neither of two bands at the canvas's edges, though it lies inside their box together: it draws nothing", () => {
    const ground = new Map<string, number>([["3,3", 2]]);
    const r = new KeptRig({ grid: sceneGrid({}), w: 8, h: 8, ground }, { width: 120, height: 90, ratio: 2, camera: { x: 30, y: 10, scale: 9.13 }, margin: 0 });
    r.frame();
    const fillsWith = (regions: { x0: number; y0: number; x1: number; y1: number }[]) => {
      const c = new TestCanvas(120, 90);
      let fills = 0;
      const fill = c.fill.bind(c);
      c.fill = (...a: unknown[]) => {
        fills++;
        fill(...(a as []));
      };
      r.drawRuns(c, regions);
      return fills;
    };
    assert.equal(fillsWith([{ x0: 0, y0: 0, x1: 2, y1: 90 }, { x0: 0, y0: 0, x1: 120, y1: 2 }]), 0);
    assert.ok(fillsWith([{ x0: 0, y0: 0, x1: 120, y1: 90 }]) > 0, "the whole canvas draws it");
  });
});
