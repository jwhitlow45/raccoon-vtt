import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { RoomScope } from "../../state/scope.ts";
import type { DropPlan } from "./drop.ts";
import type { FreeDrop } from "./free.ts";
import { leadNode, moveFrame } from "./free.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { frameSpots } from "../areas/liveTokens.ts";
import { dragAim, footprint, frameAim, snapPosition } from "../../lib/scene.ts";
import { applyEph } from "../../state/ephemeral.ts";
import { EMPTY_EPHEMERAL } from "../../state/types.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps, type Release } from "./stageHooks.ts";
import { routeSlot } from "./store.ts";
import { line, thorn, world } from "./testing.ts";

/*
 * The drag boundary of snap off (docs/design/design-v1-snap-off.md 6.3,
 * section 10): a dragged node sits where its token is drawn, so the drag's
 * stops read it back to rules coordinates, except a free drag's aim, which
 * reads the box under the drawn token (SNAP-OPUS3-01).
 */

class Hand implements Frames {
  queue: (() => void)[] = [];
  now(): number {
    return 0;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

type Node = { x(): number; y(): number; position(p: { x: number; y: number }): void; at: { x: number; y: number }; written: { x: number; y: number }[] };

/** A node held at `at`, which keeps what the stops write to it. */
function nodeAt(x: number, y: number): Node {
  const node: Node = {
    at: { x, y },
    written: [],
    x: () => node.at.x,
    y: () => node.at.y,
    position: (p) => node.written.push({ x: p.x, y: p.y }),
  };
  return node;
}

/** A node that `position` moves, as Konva's does: a held preview leaves it at the wall until the next pointer move. */
function movingNodeAt(x: number, y: number): Node {
  const node = nodeAt(x, y);
  node.position = (p) => {
    node.written.push({ x: p.x, y: p.y });
    node.at = { x: p.x, y: p.y };
  };
  return node;
}

function board(view: RoomState) {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: 1e9 }));
  const sent: ClientOp[] = [];
  const scope = new RoomScope();
  const stops = dragStops({
    store: { getState: () => ({ view, floorView: view }) } as unknown as DragDeps["store"],
    actions: { dispatch: (op: ClientOp) => sent.push(op), newId: () => `id${sent.length}` } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope,
    role: "player",
    work,
  });
  /** Frames until the drag's preview settles. */
  const settle = (node: Node, lead: Token, free = false) => {
    for (let k = 0; k < 200; k++) {
      stops.frame(node, lead, free);
      frames.frame();
      const route = scope.get(routeSlot).getState().route;
      if (route && !route.searching && !work.waiting) return route;
    }
    throw new Error("the drag never settled");
  };
  /** The drop and what it lands. */
  const drop = (node: Node, lead: Token, group: readonly Token[], release: Release) => {
    let landed: { plan: DropPlan; free: Omit<FreeDrop, "plan"> } | null = null;
    stops.drop(node, lead, group, (plan, free) => (landed = { plan, free }), release);
    for (let k = 0; k < 200 && !landed; k++) frames.frame();
    if (!landed) throw new Error("the drop never landed");
    return landed as { plan: DropPlan; free: Omit<FreeDrop, "plan"> };
  };
  return { stops, scope, settle, drop };
}

const placed = (over: Partial<Token>, nudge: { x: number; y: number }): Token => ({ ...thorn(over), nudge });

describe("the drag boundary", () => {
  test("Alt-drag a token placed 3/8 right of x=3 by a quarter: the ghost shows box 4, and it lands there drawn 3/8 left", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const b = board(world({ tokens: [hero] }));
    const node = nodeAt(3.375 + 0.25, 3);
    b.stops.start(hero.id);
    assert.deepEqual(b.settle(node, hero, true).to, { x: 4, y: 3 });
    const { plan, free } = b.drop(node, hero, [hero], { free: true, inPlace: true });
    assert.deepEqual(plan.moves.map((m) => [m.x, m.y, m.drawnAt]), [[4, 3, { x: 3.625, y: 3 }]]);
    assert.equal(free.placed, true);
  });

  test("Alt pressed after the last frame: the drop aims again from that frame's node as a free drop (SNAP-OPUS4-02)", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const b = board(world({ tokens: [hero] }));
    const node = nodeAt(3.625, 3);
    b.stops.start(hero.id);
    assert.deepEqual(b.settle(node, hero, false).to, { x: 3, y: 3 }, "not free, it reads its rules spot, 3.25, in its own box");
    const { plan } = b.drop(node, hero, [hero], { free: true, inPlace: true });
    assert.deepEqual(plan.moves.map((m) => [m.x, m.y, m.drawnAt]), [[4, 3, { x: 3.625, y: 3 }]]);
  });

  test("a jitter of 1/8 on a token placed 3/8 off its box moves nothing", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const b = board(world({ tokens: [hero] }));
    const node = nodeAt(3.5, 3);
    b.stops.start(hero.id);
    b.settle(node, hero);
    const { plan } = b.drop(node, hero, [hero], { free: false, inPlace: false });
    assert.deepEqual(plan.moves, []);
  });

  test("a placed lead's group drag of 0.2 square moves nothing", () => {
    const lead = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const other = thorn({ id: "bree", x: 6, y: 3 });
    const b = board(world({ tokens: [lead, other] }));
    b.stops.start(lead.id);
    const { plan } = b.drop(nodeAt(3.375 + 0.2, 3), lead, [lead, other], { free: false, inPlace: true });
    assert.deepEqual(plan.moves, []);
  });

  test("a drag pressed on a token drawn forward of the lead moves the lead by the pointer's delta", () => {
    const mount = thorn({ id: "mount", size: "large", x: 2, y: 2 });
    const rider = placed({ id: "rider", x: 3, y: 2 }, { x: 3, y: 0 });
    const b = board(world({ tokens: [mount, rider] }));
    const finger = nodeAt(3.375 + 1.2, 2);
    b.stops.start(mount.id, rider);
    const lead = leadNode(finger, rider, mount);
    const { plan } = b.drop({ ...finger, x: lead.x, y: lead.y, position: lead.position }, mount, [mount], { free: false, inPlace: true });
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y]), [["mount", 3, 2]]);
  });

  /*
   * SNAPBUILD-ASTRA-01, SB-OPUS-01: a held preview moves the node back to the
   * wall, and Konva leaves it there at the drop, so the release is where the
   * finger was, never the node.
   */
  for (const [what, nudge] of [
    ["unplaced", undefined],
    ["already placed", { x: 0, y: 2 }],
  ] as const) {
    test(`a player's Alt-drop past a wall of a token ${what}: the move to the wall carries no drawnAt, and Teleport here's note keeps the finger's rounding`, () => {
      const hero = nudge ? placed({ x: 2, y: 2 }, nudge) : thorn({ x: 2, y: 2 });
      const b = board(world({ tokens: [hero], edges: line("w", 5, 0, 30) }));
      const node = movingNodeAt(8.25, 2.25);
      b.stops.start(hero.id);
      b.settle(node, hero, true);
      assert.deepEqual({ x: node.x(), y: node.y() }, { x: 4, y: 2 + (nudge?.y ?? 0) / 8 }, "the preview holds at the wall, where the token is drawn there");
      const { plan, free } = b.drop(node, hero, [hero], { free: true, inPlace: true });
      assert.deepEqual(plan.moves.map((m) => [m.x, m.y, m.drawnAt]), [[4, 2, undefined]], "no placement at the hold");
      assert.equal(free.placed, false);
      assert.deepEqual(plan.stop?.drawnAt, { x: 8.25, y: 2.25 }, "the note's spot is the finger's, rounded to eighths");
    });
  }

  test("a walk held at a wall puts the node where the token is drawn at the hold", () => {
    const hero = placed({ x: 2, y: 2 }, { x: 0, y: 2 });
    const b = board(world({ tokens: [hero], edges: line("w", 5, 0, 30) }));
    const node = nodeAt(8, 2.25);
    b.stops.start(hero.id);
    b.settle(node, hero);
    assert.deepEqual(node.written.at(-1), { x: 4, y: 2.25 });
  });

  /*
   * SNAPBUILD-ASTRA-02, SB-OPUS-02: the frame this device sends aims, on every
   * other device, where this device's own drag aims: its route, the spot
   * what follows it reads (Stage.tsx setSpot) and another device's aura and
   * ruler (frameSpots, frameAim), ordinary and free, at fractional points.
   */
  test("a nudged token's drag aims at the same box here and on every other device, ordinary and free", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const tokens = { [hero.id]: hero };
    const box = (at: { x: number; y: number }) => snapPosition(SQUARES, at.x, at.y, footprint(hero));
    let checked = 0;
    for (const free of [false, true]) {
      for (const [x, y] of [
        [3.625, 3],
        [3.4, 3.1],
        [3.875, 2.6],
        [4.3, 3.45],
        [5.13, 3.55],
        [2.9, 2.4],
      ] as const) {
        const b = board(world({ tokens: [hero] }));
        b.stops.start(hero.id);
        const local = b.settle(nodeAt(x, y), hero, free).to;
        const spot = box(dragAim(hero, { x, y }, free));
        const frame = moveFrame(hero.id, { x, y }, free, {});
        const remote = applyEph(EMPTY_EPHEMERAL, "p2", frame, 0, { local: false, role: "dm" });
        const preview = Object.values(remote.drags)[0]!;
        const aura = frameSpots(tokens, [preview], () => SQUARES).get(hero.id) ?? { x: hero.x, y: hero.y };
        const ruler = box(frameAim(hero, preview));
        const what = `${free ? "free" : "ordinary"} at (${x}, ${y})`;
        assert.deepEqual(spot, local, `${what}: what follows it`);
        assert.deepEqual(aura, local, `${what}: another device's aura`);
        assert.deepEqual(ruler, local, `${what}: another device's ruler`);
        checked += 1;
      }
    }
    assert.equal(checked, 12);
  });

  test("the reviewers' case: stored at x=3 nudged 3/8 right, dragged a quarter right, aims at box 3, and at box 4 with Alt", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    for (const [free, want] of [
      [false, 3],
      [true, 4],
    ] as const) {
      const preview = Object.values(applyEph(EMPTY_EPHEMERAL, "p2", moveFrame(hero.id, { x: 3.625, y: 3 }, free, {}), 0, { local: false, role: "dm" }).drags)[0]!;
      assert.equal(preview.free, free ? true : undefined);
      assert.deepEqual(frameSpots({ [hero.id]: hero }, [preview], () => SQUARES).get(hero.id) ?? { x: 3, y: 3 }, { x: want, y: 3 });
    }
  });

  test("a drop's end frame carries the landing as drawn with its new placement, and aims at the landing whatever the old nudge", () => {
    const hero = placed({ x: 3, y: 3 }, { x: 3, y: 0 });
    const end = applyEph(EMPTY_EPHEMERAL, "p2", { k: "dragEnd", tokenId: hero.id, x: 5.625, y: 3 }, 0, { local: false, role: "dm" });
    assert.deepEqual(frameSpots({ [hero.id]: hero }, Object.values(end.drags), () => SQUARES).get(hero.id), { x: 6, y: 3 }, "placed 3/8 left of box 6");
  });
});
