import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import type { ViewToken } from "../lib/scene.ts";
import { reveal, rng, token } from "#shared/testutil.ts";
import { dropLanding, dropView } from "../features/movement/drop.ts";
import { raised, world } from "../features/movement/testing.ts";
import { screenToView, viewToScreen, type Camera } from "../lib/camera.ts";
import { footprint, snapPosition } from "../lib/scene.ts";
import { flatHeights, isometric, toView, type Turn, type ViewPoint } from "../lib/view.ts";
import { boardPickFor, DrawnHeightsMemo, drawnRing, ringCenter, standsFor, type BoardPick } from "./boardPick.ts";
import { cappedBase, standeeShape } from "./relief/standee.ts";
import { dragBound, dragGround, dragLanding, dragPlan, levelsOf, type DragGround, type DragPlan } from "./isoDrag.ts";

const CAM: Camera = { x: 600, y: 80, scale: 40 };

function pickFor(state: RoomState, role: "dm" | "player", turn: Turn = 0): BoardPick {
  return boardPickFor({ room: state, scene: state.scenes.s1!, role, fog: true, view: isometric(turn), camera: CAM, lowPower: false }, new DrawnHeightsMemo());
}

/** Where a drag of `id` lands with the ring's center at the screen point of world `p` at height `z` cells, as Stage.tsx's adapter takes it. */
function landAt(state: RoomState, role: "dm" | "player", id: string, p: { x: number; y: number }, z: number, turn: Turn = 0) {
  const pick = pickFor(state, role, turn);
  const t = state.tokens[id]! as Token;
  const plan = dragPlan({ room: state, role, src: pick.src!, feetPerCell: pick.feetPerCell, token: t });
  const v = toView(pick.view, p, z);
  return dragLanding(pick.view, dragGround(pick.heights, t), plan, v);
}

/** The cell a landing's footprint center stands in, and its height in feet. */
function landed(at: { x: number; y: number; z: number }, t: Token) {
  const fp = footprint(t);
  return { cell: `${Math.floor(at.x + fp.w / 2)},${Math.floor(at.y + fp.h / 2)}`, feet: at.z * 5 };
}

describe("the isometric drag adapter (docs/design-v1-isometric-view.md 6.3)", () => {
  test("the grab offset: the first move, before the finger goes anywhere, leaves the token where it stood, at every turn", () => {
    const state = world({ blockMovement: false, heights: raised(6, 6, 9, 9, 10), tokens: [token("walker", { x: 7, y: 7, elevation: 10 })] });
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = pickFor(state, "dm", turn);
      const t = state.tokens.walker! as Token;
      const node = viewToScreen(CAM, toView(pick.view, { x: t.x, y: t.y }));
      const ring = ringCenter(pick, t);
      assert.notDeepEqual(ring, node, "the ring stands apart from the corner");
      const input = { camera: CAM, view: pick.view, ground: dragGround(pick.heights, t), plan: dragPlan({ room: state, role: "dm", src: pick.src!, feetPerCell: 5, token: t }), start: { node, ring }, rel: { x: 0, y: 0 } };
      const at = dragBound(input, node);
      assert.ok(Math.abs(at.x - node.x) < 1e-6 && Math.abs(at.y - node.y) < 1e-6, `turn ${turn}: ${JSON.stringify([at, node])}`);
    }
  });

  test("a 100 ft flier whose lift is capped on screen: the first move leaves it where its ring draws, and a move keeps it at 100 ft under the finger, at every turn", () => {
    const state = world({ blockMovement: false, tokens: [token("roc", { x: 7, y: 7, elevation: 100 })] });
    const cam: Camera = { x: 600, y: 80, scale: 80 };
    const t = state.tokens.roc! as Token;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: true, view: isometric(turn), camera: cam, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
      // The ring where the standee draws it, its lift capped at one canvas height.
      const shape = standeeShape(turn, { x: 7, y: 7, w: 1, h: 1 }, 20, 0, cam.scale, 600);
      assert.ok(shape.capped, "the lift is capped");
      const ring = ringCenter(pick, t);
      const drawn = viewToScreen(cam, { x: (shape.ring.x0 + shape.ring.x1) / 2, y: (shape.ring.y0 + shape.ring.y1) / 2 } as ViewPoint);
      assert.ok(Math.hypot(ring.x - drawn.x, ring.y - drawn.y) < 1e-6, `turn ${turn}: the ring as it draws`);
      const node = viewToScreen(cam, toView(pick.view, { x: t.x, y: t.y }));
      const plan = dragPlan({ room: state, role: "dm", src: pick.src!, feetPerCell: 5, token: t, drawn: (base, ground) => cappedBase(base, ground, cam.scale, 600) });
      const input = { camera: cam, view: pick.view, ground: dragGround(pick.heights, t), plan, start: { node, ring }, rel: { x: 0, y: 0 } };
      const still = dragBound(input, node);
      assert.ok(Math.abs(still.x - node.x) < 1e-6 && Math.abs(still.y - node.y) < 1e-6, `turn ${turn}: no jump at the first move`);
      // A finger moved two cells' width along the screen carries the ring with it, the roc at 100 ft.
      const moved = { x: node.x + 2 * cam.scale, y: node.y };
      const at = dragLanding(pick.view, input.ground, plan, screenToView(cam, { x: ring.x + 2 * cam.scale, y: ring.y }));
      assert.equal(at.z, 20, `turn ${turn}: the roc keeps its height`);
      const ringThen = viewToScreen(cam, toView(pick.view, { x: at.x + 0.5, y: at.y + 0.5 }, cappedBase(20, 0, cam.scale, 600)));
      assert.ok(Math.hypot(ringThen.x - (ring.x + 2 * cam.scale), ringThen.y - ring.y) < 1e-6, `turn ${turn}: its ring under the finger`);
      const bound = dragBound(input, moved);
      assert.ok(Math.abs(bound.x - moved.x) < 1e-6 && Math.abs(bound.y - moved.y) < 1e-6, `turn ${turn}: the node follows the finger`);
    }
  });

  test("a player drags a 20 ft flier half under the fog, lying flat: no jump at the first move, and the drop under the finger, at every turn (ISO34-OPUS-11)", () => {
    const state = world({ blockMovement: false, tokens: [token("bat", { x: 6, y: 6, elevation: 20 })] });
    reveal(state, "s1", { x: 0, y: 0, w: 6.5, h: 16 });
    const t = state.tokens.bat! as Token;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "player", fog: true, view: isometric(turn), camera: CAM, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
      // As Stage.tsx grips it: one stand rule read for the grab and for the ray. Another member's bat is not above the fog.
      const stands = standsFor(pick, () => false)(t as ViewToken);
      assert.equal(stands, false, "it lies flat");
      const plan = dragPlan({ room: state, role: "player", src: pick.src!, feetPerCell: 5, token: t, drawn: drawnRing(pick, stands) });
      const node = viewToScreen(CAM, toView(pick.view, { x: t.x, y: t.y }));
      const ring = ringCenter(pick, t, stands);
      const input = { camera: CAM, view: pick.view, ground: dragGround(pick.heights, t), plan, start: { node, ring }, rel: { x: 0, y: 0 } };
      const still = dragBound(input, node);
      assert.ok(Math.abs(still.x - node.x) < 1e-6 && Math.abs(still.y - node.y) < 1e-6, `turn ${turn}: no jump at the first move`);
      const finger = { x: ring.x + 2 * CAM.scale, y: ring.y - CAM.scale };
      const at = dragLanding(pick.view, input.ground, plan, screenToView(CAM, finger));
      assert.equal(at.z, 4, `turn ${turn}: the bat keeps its 20 ft`);
      const under = viewToScreen(CAM, toView(pick.view, { x: at.x + 0.5, y: at.y + 0.5 }, 0));
      assert.ok(Math.hypot(under.x - finger.x, under.y - finger.y) < 1e-6, `turn ${turn}: the drop's ring on the ground under the finger`);
    }
  });

  test("a 100 ft flier over a 30 ft platform, its lift capped at 80 px a cell: the first move leaves it where it stands, at every turn (ISO34-ASTRA-11)", () => {
    const state = world({ blockMovement: false, heights: raised(6, 6, 10, 10, 30), tokens: [token("roc", { x: 7, y: 7, elevation: 100 })] });
    const cam: Camera = { x: 600, y: 80, scale: 80 };
    const t = state.tokens.roc! as Token;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: true, view: isometric(turn), camera: cam, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
      const plan = dragPlan({ room: state, role: "dm", src: pick.src!, feetPerCell: 5, token: t, drawn: drawnRing(pick, true) });
      const node = viewToScreen(cam, toView(pick.view, { x: t.x, y: t.y }));
      const ring = ringCenter(pick, t);
      const input = { camera: cam, view: pick.view, ground: dragGround(pick.heights, t), plan, start: { node, ring }, rel: { x: 0, y: 0 } };
      const still = dragBound(input, node);
      assert.ok(Math.hypot(still.x - node.x, still.y - node.y) < 1e-6, `turn ${turn}: ${JSON.stringify([still, node])}`);
      const at = dragLanding(pick.view, input.ground, plan, screenToView(cam, ring));
      assert.ok(Math.abs(at.x - 7) < 1e-9 && Math.abs(at.y - 7) < 1e-9 && at.z === 20, `turn ${turn}: it stays at 7, 7 at 100 ft`);
    }
  });

  test("Stage.tsx grips with one stand rule for the grab and the ray", () => {
    const stage = readFileSync(new URL("./Stage.tsx", import.meta.url), "utf8");
    assert.match(stage, /const stands = standsFor\(pick, aboveFogRef\.current\)\(lead\);\n\s*const plan = dragPlan\(\{[^\n]*drawn: drawnRing\(pick, stands\) \}\);\n\s*const start = \{ node: node\.getAbsolutePosition\(\), ring: ringCenter\(pick, lead, stands\) \};/);
  });

  test("a capped flier over uneven ground: the ray height is the drawn ground whose spot has that ground under it, so its ring draws under the finger (ISO34-OPUS-12)", () => {
    const view = isometric(0);
    // The ring draws 3 cells over the ground wherever it goes, its lift capped.
    const plan: DragPlan = { w: 1, h: 1, own: { kind: "fixed", base: 20 }, seat: null, drawn: (_base, g) => g + 3 };
    const steps: Record<string, number> = { "11,11": 1, "12,12": 0.5 };
    const ground: DragGround = { levels: [1, 0.5, 0], footGround: (at) => steps[`${at.x},${at.y}`] ?? 0, snap: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }) };
    // The ray at 4, over ground 1, finds 12, 12, whose ground is 0.5. The ray at 3.5 finds 12, 12 again: there it stands.
    const v = toView(view, { x: 8, y: 8 }, 0);
    const at = dragLanding(view, ground, plan, v);
    assert.deepEqual(ground.snap(at), { x: 12, y: 12 });
    assert.equal(at.z, 20);
    const ring = toView(view, { x: at.x + 0.5, y: at.y + 0.5 }, plan.drawn(20, ground.footGround(ground.snap(at))));
    assert.ok(Math.hypot(ring.x - v.x, ring.y - v.y) < 1e-9, JSON.stringify([ring, v]));
    // Two spots that send the ray to each other, so no height holds: it still lands, by the scan's fallback.
    const turns: Record<string, number> = { "11,11": 1, "12,12": 0 };
    const swap: DragGround = { ...ground, levels: [1, 0], footGround: (p) => turns[`${p.x},${p.y}`] ?? 0 };
    const settled = dragLanding(view, swap, plan, v);
    assert.ok(["11,11", "12,12"].includes(`${swap.snap(settled).x},${swap.snap(settled).y}`) && settled.z === 20);
  });

  test("a finger on a 10 ft platform's top lands the walker on that cell, at 10 ft, and on the ground beside it at 0", () => {
    const state = world({ blockMovement: false, heights: raised(6, 6, 9, 9, 10), tokens: [token("walker", { x: 2, y: 2 })] });
    const t = state.tokens.walker! as Token;
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      assert.deepEqual(landed(landAt(state, "dm", "walker", { x: 7.5, y: 7.5 }, 2, turn), t), { cell: "7,7", feet: 10 }, `turn ${turn}`);
      assert.deepEqual(landed(landAt(state, "dm", "walker", { x: 3.5, y: 3.5 }, 0, turn), t), { cell: "3,3", feet: 0 }, `turn ${turn}, the ground`);
    }
  });

  test("a Large and a Huge dragged across a ledge stay under the finger, judged by the whole footprint", () => {
    // A ledge along x = 10: east of it 10 ft.
    const state = world({ blockMovement: false, heights: raised(10, 0, 30, 30, 10), tokens: [token("ogre", { size: "large", x: 2, y: 2 }), token("giant", { size: "huge", x: 2, y: 8 })] });
    for (const id of ["ogre", "giant"]) {
      const t = state.tokens[id]! as Token;
      const fp = footprint(t);
      // The ring's center just short of the ledge, over a low cell, its footprint reaching onto the 10 ft side.
      const at = landAt(state, "dm", id, { x: 9.9, y: 12 + fp.h / 2 }, 2);
      assert.equal(at.z, 2, `${id} stands at the top it straddles`);
      assert.ok(Math.abs(at.x + fp.w / 2 - 9.9) < 1e-9, `${id} centered under the finger`);
      // The same footprint judged by the cell under its center alone would stand where that cell is.
      const ground = dragGround(pickFor(state, "dm").heights, t);
      const corner = snapPosition(at.x, at.y, fp);
      assert.equal(ground.footGround(corner), 2);
    }
  });

  test("a flier keeps its height over lower ground, and a walker's scan takes over where the ground is higher", () => {
    const state = world({
      blockMovement: false,
      heights: { ...raised(6, 6, 9, 9, 10), ...raised(12, 6, 15, 9, 40) },
      tokens: [token("owl", { size: "small", x: 2, y: 2, elevation: 20 })],
    });
    const t = state.tokens.owl! as Token;
    assert.deepEqual(landed(landAt(state, "dm", "owl", { x: 7.5, y: 7.5 }, 4), t), { cell: "7,7", feet: 20 }, "over the 10 ft platform at 20 ft");
    // Over the tower's top on screen, the owl at its own 20 ft is farther off, behind the tower, over open ground, and keeps its height there.
    assert.deepEqual(landed(landAt(state, "dm", "owl", { x: 13.5, y: 7.5 }, 8), t), { cell: "8,2", feet: 20 }, "behind the tower at 20 ft");
    // Where its own height meets the tower, it lands on the top, as the drop would.
    const onto = landAt(state, "dm", "owl", { x: 13.5, y: 7.5 }, 4);
    assert.deepEqual(landed(onto, t).cell, "13,7");
    assert.equal(dropLanding(dropView(state, "dm"), t, snapPosition(onto.x, onto.y, footprint(t))), 40, "the drop there lands on the tower");
  });

  test("a flier over a tower wide enough to meet its own height lands on the top under the finger", () => {
    const state = world({ blockMovement: false, heights: raised(12, 6, 20, 14, 40), tokens: [token("owl", { size: "small", x: 2, y: 2, elevation: 20 })] });
    assert.deepEqual(landed(landAt(state, "dm", "owl", { x: 17.5, y: 11.5 }, 8), state.tokens.owl! as Token), { cell: "17,11", feet: 40 });
  });

  test("a token inside seen ground keeps its base and never rises", () => {
    const state = world({ blockMovement: false, heights: raised(0, 0, 30, 30, 10), tokens: [token("mole", { x: 2, y: 2, elevation: 0 })] });
    const t = state.tokens.mole! as Token;
    const plan = dragPlan({ room: state, role: "dm", src: pickFor(state, "dm").src!, feetPerCell: 5, token: t });
    assert.deepEqual(plan.own, { kind: "fixed", base: 0 });
    assert.equal(landAt(state, "dm", "mole", { x: 5.5, y: 5.5 }, 0).z, 0);
  });

  test("riders: off a holder on the ground, off one flying at 20 ft, off one inside seen ground, and moved within a mount that straddles a ledge, each as dropLanding lands it", () => {
    const heights = raised(10, 0, 30, 30, 10);
    const cases: { name: string; holder: Partial<Token>; rider: Partial<Token>; to: { x: number; y: number }; feet: number; kept: boolean }[] = [
      { name: "off a horse on the ground", holder: { x: 4, y: 4, elevation: 0 }, rider: { x: 4, y: 4, elevation: 0 }, to: { x: 6.5, y: 8.5 }, feet: 0, kept: false },
      { name: "off a griffon at 20 ft", holder: { x: 4, y: 4, elevation: 20 }, rider: { x: 4, y: 4, elevation: 20 }, to: { x: 6.5, y: 8.5 }, feet: 20, kept: false },
      { name: "off a holder inside the ground", holder: { x: 12, y: 4, elevation: 0 }, rider: { x: 12, y: 4, elevation: 0 }, to: { x: 16.5, y: 8.5 }, feet: 0, kept: false },
      // The horse straddles the ledge at x = 10, standing at its high side's 10 ft: the rider moved within it keeps its seat at the horse's height.
      { name: "within a mount straddling a ledge", holder: { x: 9, y: 4, elevation: 10 }, rider: { x: 9, y: 4, elevation: 10 }, to: { x: 9.5, y: 5.5 }, feet: 10, kept: true },
      // Seated over the ledge's low half the rider is 10 ft over its own ground, yet off the seat it goes by the horse, which stands on the ground.
      { name: "off a mount straddling a ledge, from over its low half", holder: { x: 9, y: 4, elevation: 10 }, rider: { x: 9, y: 4, elevation: 10 }, to: { x: 5.5, y: 12.5 }, feet: 0, kept: false },
    ];
    for (const c of cases) {
      const state = world({
        blockMovement: false,
        heights,
        tokens: [
          token("horse", { name: "Horse", kind: "npc", size: "large", ...c.holder }),
          token("bree", { name: "Bree", kind: "pc", size: "small", ownerIds: ["p1"], disposition: "ally", attached: { to: "horse", kind: "ride" }, ...c.rider }),
        ],
      });
      const t = state.tokens.bree! as Token;
      const fp = footprint(t);
      const z = c.feet / 5;
      const at = landAt(state, "dm", "bree", c.to, z);
      assert.equal(at.z * 5, c.feet, c.name);
      // What the drop lands it at from there agrees with the preview.
      const spot = snapPosition(at.x, at.y, fp);
      assert.equal(dropLanding(dropView(state, "dm"), t, spot), c.feet, `${c.name}: the drop`);
      const plan = dragPlan({ room: state, role: "dm", src: pickFor(state, "dm").src!, feetPerCell: 5, token: t }) as DragPlan;
      assert.equal(plan.seat?.keptAt(spot), c.kept, `${c.name}: the seat`);
    }
  });

  test("the drawn heights a scan reads, highest first with 0 among them", () => {
    const state = world({ blockMovement: false, heights: { ...raised(1, 1, 2, 2, 15), ...raised(3, 3, 4, 4, -10), ...raised(5, 5, 6, 6, 15) } });
    assert.deepEqual(levelsOf(pickFor(state, "dm").heights), [3, 0, -2]);
    assert.deepEqual(levelsOf(flatHeights({ w: 9, h: 9 })), [0]);
  });

  test("security: a player's previews over two scenes that differ only in hidden heights are the same", () => {
    const random = rng(7);
    for (let round = 0; round < 12; round++) {
      const shown: Record<string, number> = {};
      const a: Record<string, number> = {};
      const b: Record<string, number> = {};
      for (let y = 0; y < 30; y++) {
        for (let x = 0; x < 30; x++) {
          if (x < 15) shown[`${x},${y}`] = Math.round(random() * 3) * 5;
          else {
            a[`${x},${y}`] = Math.round(random() * 6) * 5;
            b[`${x},${y}`] = Math.round(random() * 6) * 5 - 10;
          }
        }
      }
      // Half the rounds start on seen ground, half on the hidden side, where the footing must read only what is seen.
      const start = round % 3 === 0 ? { x: 20, y: 3, elevation: 0 } : { x: 3, y: 3, elevation: shown["3,3"] ?? 0 };
      const tokens = [token("bree", { name: "Bree", kind: "pc", size: round % 2 ? "large" : "medium", ownerIds: ["p1"], disposition: "ally", ...start })];
      const sa = world({ blockMovement: false, heights: { ...shown, ...a }, tokens });
      const sb = world({ blockMovement: false, heights: { ...shown, ...b }, tokens });
      for (const s of [sa, sb]) {
        s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
        reveal(s, "s1", { x: 0, y: 0, w: 15, h: 30 });
      }
      const turn = (round % 4) as Turn;
      for (let i = 0; i < 40; i++) {
        const p = { x: random() * 30, y: random() * 30 };
        const z = random() * 6;
        assert.deepEqual(landAt(sa, "player", "bree", p, z, turn), landAt(sb, "player", "bree", p, z, turn), `round ${round}, move ${i}`);
      }
    }
  });

  test("a press that moves a mount through its rider keeps the rider's offset from the mount", () => {
    const state = world({ blockMovement: false, tokens: [token("horse", { kind: "npc", size: "large", x: 4, y: 4 })] });
    const pick = pickFor(state, "dm");
    const horse = state.tokens.horse! as Token;
    const node = viewToScreen(CAM, toView(pick.view, { x: 4.5, y: 4.5 }));
    const ring = ringCenter(pick, horse);
    const input = { camera: CAM, view: pick.view, ground: dragGround(pick.heights, horse), plan: dragPlan({ room: state, role: "dm", src: pick.src!, feetPerCell: 5, token: horse }), start: { node, ring }, rel: { x: 0.5, y: 0.5 } };
    const moved = dragBound(input, { x: node.x + 40, y: node.y });
    const world2 = screenToView(CAM, moved) as ViewPoint;
    assert.ok(Number.isFinite(world2.x));
    // The rider's corner stays half a cell in from the horse's, wherever the horse lands.
    const lead = dragLanding(pick.view, input.ground, input.plan, screenToView(CAM, { x: ring.x + 40, y: ring.y }));
    const expected = viewToScreen(CAM, toView(pick.view, { x: lead.x + 0.5, y: lead.y + 0.5 }));
    assert.ok(Math.abs(moved.x - expected.x) < 1e-6 && Math.abs(moved.y - expected.y) < 1e-6);
  });
});
