import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sceneGrid } from "#shared/rules/grid.ts";
import { mulberry32 } from "../../features/areas/volumeTesting.ts";
import type { Turn } from "../../lib/view.ts";
import { installPath2D, KeptRig, type RigScene } from "./keptTesting.ts";

/*
 * The kept picture against a whole redraw, pixel by pixel
 * (docs/design-v1-relief-pan.md 10.2): seeded sequences of camera moves and
 * edits on hex rows, hex columns and squares at pixel ratios 1.5 and 2,
 * through the board's real layout, drawRun and frame scheduler, on a canvas
 * that holds each pixel's paints in order (keptTesting.ts). Invariants after
 * every frame:
 *
 * - the kept canvas equals a whole draw of the same state at every pixel;
 * - a camera-only move paints at most |dx|·H + |dy|·W pixels plus the area
 *   of the ground-edge boxes it repairs;
 * - any other mark repaints whole.
 */

installPath2D();

const SEQUENCES = 400;
const EVENTS = 40;

type Kind = "small" | "large" | "canvas" | "zoom" | "turn" | "height" | "fog" | "area" | "select" | "move" | "texture" | "konvaGround";
const KINDS: readonly Kind[] = ["small", "small", "small", "small", "small", "large", "large", "canvas", "zoom", "turn", "height", "fog", "area", "select", "move", "texture", "konvaGround"];

function scene(shape: "squares" | "hexRows" | "hexColumns", rand: () => number): RigScene {
  const ground = new Map<string, number>();
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const r = rand();
    ground.set(`${x},${y}`, r < 0.25 ? 0 : r < 0.45 ? -1 - Math.floor(rand() * 2) : 1 + Math.floor(rand() * 3));
  }
  return { grid: sceneGrid(shape === "squares" ? {} : { gridShape: shape }), w: 8, h: 8, ground };
}

/** The whole draw's paints at the traced pixel. */
function TestCanvasFor(rig: KeptRig): string[] {
  const at = Number(process.env.KEPT_TRACE);
  const c = rig.wholeTraced(at);
  return c;
}

function run(shape: "squares" | "hexRows" | "hexColumns", ratio: number, seed: number): void {
  const rand = mulberry32(seed);
  const width = 66;
  const height = 48;
  const s = scene(shape, rand);
  // Scales that put no edge on a pixel's center by accident, so a move by whole pixels moves every edge by exactly that.
  const scale = 7.37 + rand() * 3.1;
  const marginChoice = rand();
  const rig = new KeptRig(s, {
    width,
    height,
    ratio,
    camera: { x: width / ratio / 2 - 4 * scale, y: height / ratio / 2 - 1.5 * scale, scale },
    margin: marginChoice < 0.3 ? 0 : marginChoice < 0.6 ? 6 : height / ratio,
  });
  for (let i = 0; i < 3; i++) rig.standees.push({ id: `t${i}`, x: Math.floor(rand() * 8), y: Math.floor(rand() * 8), size: 1, look: 0 });
  rig.commit();
  const first = process.env.KEPT_TRACE_FIRST ? Number(process.env.KEPT_TRACE_FIRST) : null;
  if (first !== null) rig.canvas.trace = { at: first, log: [] };
  rig.frame();
  const log: string[] = first !== null ? [`first frame at ${first}: ${rig.canvas.trace!.log.join("; ")}`] : [];
  const fail = (what: string) => assert.fail(`${shape} at ${ratio}, seed ${seed}: ${what}\n${log.join("\n")}`);
  for (let e = 0; e < EVENTS; e++) {
    const kind = KINDS[Math.floor(rand() * KINDS.length)]!;
    const before = { ...rig.camera };
    const stats = { ...rig.scheduler.kept!.stats };
    let camera = false;
    let content = false;
    const pan = (dx: number, dy: number) => {
      camera = true;
      const fit = rig.pan(dx, dy);
      // Leaving the layout renders at once, before the frame (flushSync). A step renders a task later, before or after the next frame.
      if (fit === "out") {
        rig.commit();
        content = true;
      } else if (fit === "step") rig.pendingLayout = true;
    };
    switch (kind) {
      case "small":
        pan((rand() - 0.5) * 12, (rand() - 0.5) * 12);
        break;
      case "large":
        pan((rand() - 0.5) * rig.size.width * 1.2, (rand() - 0.5) * rig.size.height * 1.2);
        break;
      case "canvas":
        pan((rand() < 0.5 ? -1 : 1) * rig.size.width * (1 + rand()), 0);
        break;
      case "zoom": {
        const k = 0.85 + rand() * 0.3;
        rig.scheduler.moveCamera(() => {
          rig.camera = { ...rig.camera, scale: rig.camera.scale * k };
          rig.scheduler.mark("ground");
          rig.scheduler.mark("relief");
        });
        rig.commit();
        content = true;
        break;
      }
      case "turn":
        rig.turn = ((rig.turn + 1 + Math.floor(rand() * 3)) % 4) as Turn;
        rig.commit();
        content = true;
        break;
      case "height": {
        const x = Math.floor(rand() * 8);
        const y = Math.floor(rand() * 8);
        s.ground.set(`${x},${y}`, Math.floor(rand() * 6) - 2);
        rig.resync();
        rig.commit();
        content = true;
        break;
      }
      case "fog":
        rig.groundLook++;
        rig.mark("ground");
        content = true;
        break;
      case "area":
        rig.areas = [{ id: `a${e}`, x: Math.floor(rand() * 8), y: Math.floor(rand() * 8), z0: 0, z1: 1 + Math.floor(rand() * 2), selected: rand() < 0.5 }];
        rig.commit();
        content = true;
        break;
      case "select": {
        const t = rig.standees[Math.floor(rand() * rig.standees.length)]!;
        t.look++;
        rig.mark("relief");
        content = true;
        break;
      }
      case "move": {
        const t = rig.standees[Math.floor(rand() * rig.standees.length)]!;
        t.x = Math.floor(rand() * 8);
        t.y = Math.floor(rand() * 8);
        rig.commit();
        content = true;
        break;
      }
      case "texture":
        rig.look++;
        rig.mark("relief");
        content = true;
        break;
      case "konvaGround":
        // Konva draws the ground on its own (a resize): the scheduler never asked, and the next pan must not scroll over it.
        rig.groundLook++;
        rig.scheduler.moveCamera(() => {});
        (rig as unknown as { groundDraws: number }).groundDraws++;
        pan(1.3, 0.7);
        content = true;
        break;
    }
    // The board's render after a cull step lands before this frame or after it.
    if (rig.pendingLayout && rand() < 0.5) {
      rig.commit();
      content = true;
    }
    log.push(`${e}: ${kind} cam ${rig.camera.x.toFixed(3)},${rig.camera.y.toFixed(3)} x${rig.camera.scale.toFixed(3)} turn ${rig.turn}, moved ${Math.round((rig.camera.x - before.x) * ratio)},${Math.round((rig.camera.y - before.y) * ratio)} px${content ? ", content" : ""}`);
    rig.canvas.touched.clear();
    const traced = process.env.KEPT_TRACE ? Number(process.env.KEPT_TRACE) : null;
    if (traced !== null) rig.canvas.trace = { at: traced, log: [] };
    rig.frame();
    const after = rig.scheduler.kept!.stats;
    const whole = rig.whole();
    const diff = rig.canvas.diff(whole);
    if (diff.length > 0) {
      if (traced !== null) {
        const w = TestCanvasFor(rig);
        log.push(`kept trace at ${traced}: ${rig.canvas.trace!.log.join("; ")}`, `whole trace: ${w.join("; ")}`);
      }
      fail(`after event ${e} (${kind}), the kept canvas differs from a whole draw at ${diff.join(" ")} (index ${diff.map((d) => { const [x, y] = d.split(",").map(Number); return y! * width + x!; }).join(" ")})`);
    }
    if (content && after.whole === stats.whole) fail(`after event ${e} (${kind}), a content mark scrolled`);
    if (camera && !content && after.scrolls > stats.scrolls) {
      const dx = Math.abs(Math.round((rig.camera.x - before.x) * ratio));
      const dy = Math.abs(Math.round((rig.camera.y - before.y) * ratio));
      const repaired = (after.repair - stats.repair) * width * height;
      const bound = dx * height + dy * width + repaired;
      if (rig.canvas.touched.size > bound + 1e-6) fail(`after event ${e} (${kind}), a scroll by ${dx},${dy} painted ${rig.canvas.touched.size} pixels, past ${bound}`);
    }
    // The board's late render lands after the frame now.
    if (rig.pendingLayout) {
      rig.commit();
      rig.canvas.touched.clear();
      rig.frame();
      const late = rig.canvas.diff(rig.whole());
      if (late.length > 0) fail(`after the late render of event ${e}, the kept canvas differs from a whole draw at ${late.join(" ")}`);
    }
  }
  assert.ok(rig.scheduler.kept!.stats.scrolls > 0, "some frames scrolled");
}

describe("the kept relief picture against a whole redraw (docs/design-v1-relief-pan.md 10.2)", () => {
  for (const shape of ["hexRows", "hexColumns", "squares"] as const) {
    for (const ratio of [1.5, 2]) {
      test(`${SEQUENCES / 6} seeded sequences of ${EVENTS} pans and edits on ${shape} at a pixel ratio of ${ratio}: every frame equals a whole draw, a scroll paints only its strips and repairs, anything else repaints whole`, () => {
        const base = (shape === "hexRows" ? 1 : shape === "hexColumns" ? 2 : 3) * 100_000 + ratio * 1000;
        const only = process.env.KEPT_SEED ? Number(process.env.KEPT_SEED) : null;
        for (let i = 0; i < SEQUENCES / 6; i++) if (only === null || only === base + i) run(shape, ratio, base + i);
      });
    }
  }
});
