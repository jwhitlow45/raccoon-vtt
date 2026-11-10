import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { GROUND, UPPER, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import type { RoomState, SceneId } from "#shared/model.ts";
import { MAX_RULER_ENDS, MAX_RULER_STOPS, type EphEvent } from "#shared/protocol.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { reveal } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import type { ToolContext } from "../tools.ts";
import { frameFits, priorOut, publicEnd, stairsPlan, stillCarried } from "./carry.ts";
import { allStops, tokenStop, type RulerState, type RulerStop } from "./ruler.ts";
import { pickMeasure, publish, rulerActivated, rulerDeactivated, rulerSlot, takeStairs, toggleShare } from "./rulerStore.ts";
import { measureWalk, type WalkInput } from "./walkRuler.ts";

/*
 * Random runs of the walking ruler over stairs (docs/design/design-v1-floors.md
 * phase 3, 4.2 and 10): stops, presses of the stairs button, Clear, `[` and
 * `]`, Share, Measure, the DM fogging and revealing the stairs, and walks
 * that answer late, on stairs from Ground floor up to Upper floor and back,
 * so a ruler may cross them past MAX_RULER_ENDS times. After every step:
 * - one live id: every ruler frame names the ruler the tool shows,
 * - `prior` exactly while carried,
 * - a ruler carried private is never sent,
 * - every frame fits the server's schema and cap, with at most 8 ends and 50 creatures,
 * - a shared carry never crosses an end the public world hides,
 * and at the end every id sent to the server got its end.
 */

const STAIRS = { x: 8, y: 3, w: 1, h: 1 };

function room(fogged: boolean): RoomState {
  const s = withStairs(tower(), { rect: STAIRS });
  if (!fogged) return s;
  for (const id of [GROUND, UPPER]) s.scenes[id] = { ...s.scenes[id]!, fogEnabled: true };
  // Everything but the stairs' column is revealed on both floors.
  for (const id of [GROUND, UPPER]) {
    reveal(s, id, { x: 0, y: 0, w: 8, h: 20 });
    reveal(s, id, { x: 9, y: 0, w: 11, h: 20 });
  }
  return s;
}

function revealStairs(s: RoomState): RoomState {
  const out = structuredClone(s);
  for (const id of [GROUND, UPPER]) reveal(out, id, STAIRS);
  return out;
}

type Step =
  | { t: "stop"; at: "stairs" | "thorn" | "near" | "far"; dx: number }
  | { t: "stairs"; late: boolean }
  | { t: "clear" }
  | { t: "switch" }
  | { t: "share" }
  | { t: "measure"; walk: boolean }
  | { t: "fog"; reveal: boolean };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant("stop" as const), at: fc.constantFrom("stairs" as const, "stairs" as const, "stairs" as const, "thorn" as const, "near" as const, "far" as const), dx: fc.integer({ min: -2, max: 2 }) }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("stairs" as const), late: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ t: "clear" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "switch" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "share" as const }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("measure" as const), walk: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("fog" as const), reveal: fc.boolean() }) },
);

type Sent = { e: EphEvent; localOnly: boolean };

test("random carries, clears, switches, shares, measures, fog and late walks keep the carry's invariants", () => {
  let carries = 0;
  let mostEnds = 0;
  fc.assert(
    fc.property(fc.constantFrom("dm" as const, "player" as const), fc.boolean(), fc.array(stepArb, { minLength: 1, maxLength: 30 }), (role, fogged, steps) => {
      let view = room(fogged);
      const scope = new RoomScope();
      const sent: Sent[] = [];
      const state = { sceneId: GROUND as SceneId, get floorView() {
        return view;
      }, get view() {
        return view;
      } };
      const ctx = {
        scope,
        role,
        get scene() {
          return view.scenes[state.sceneId]!;
        },
        getState: () => state,
        ui: { notify: () => {} },
        actions: {
          sendEph: (e: EphEvent, opts?: { localOnly?: boolean }) => void sent.push({ e, localOnly: opts?.localOnly === true }),
          showFloor: (id: SceneId | null) => {
            if (id) state.sceneId = id;
          },
          newId: () => `r${sent.length}`,
        },
      } as unknown as ToolContext;
      const tool = scope.get(rulerSlot);
      tool.activeCtx = ctx;
      rulerActivated(ctx);
      tool.store.setState({ walk: true });
      const switchFloor = (to: SceneId) => {
        state.sceneId = to;
        rulerDeactivated(ctx);
        rulerActivated(ctx);
      };

      for (const step of steps) {
        const before = sent.length;
        const { ruler, share, walk, carry } = tool.store.getState();
        const shared = role === "player" || share;
        switch (step.t) {
          case "stop": {
            const g = SQUARES;
            const on = view.tokens.thorn!;
            const stop: RulerStop =
              step.at === "thorn" && on.sceneId === state.sceneId
                ? tokenStop(g, on)
                : step.at === "stairs"
                  ? { x: STAIRS.x + 0.5, y: STAIRS.y + 0.5 }
                  : step.at === "near"
                    ? { x: STAIRS.x + step.dx + 0.5, y: STAIRS.y + 0.5 }
                    : { x: 14.5 + step.dx, y: 12.5 };
            const next: RulerState = ruler ? { ...ruler, stops: [...ruler.stops, stop].slice(0, MAX_RULER_STOPS) } : { id: `r${sent.length}`, stops: [stop], live: null, shared: false };
            publish(ctx, next);
            break;
          }
          case "stairs": {
            if (!ruler || !walk) break;
            const carried = stillCarried(carry, ruler.stops);
            const stops = allStops(ruler);
            const walkInput: WalkInput = { view, sceneId: state.sceneId, stops, viewer: { role }, everything: role === "dm" && !share, ...(carried ? { prior: priorOut(carried.prior) } : {}) };
            const measured = stops.length > 1 || carried ? measureWalk(walkInput) : null;
            // A late walk is still searching: the button waits for it.
            const walked = measured && step.late ? { ...measured, searching: true } : measured;
            const held = [GROUND, UPPER];
            const plan = stairsPlan({ role, share, rulerId: ruler.id, walkInput, walked, carried, held, whole: view });
            if (step.late) assert.equal(plan === null || stops.length === 1, true, "no button while the walk searches");
            if (!plan) break;
            if (shared) assert.ok(publicEnd(view, plan.offer.link), "a shared ruler offers only stairs players see");
            if (takeStairs(ctx, plan.plan)) {
              rulerDeactivated(ctx);
              rulerActivated(ctx);
              carries++;
              mostEnds = Math.max(mostEnds, plan.plan.carry.prior.ends.length);
            }
            break;
          }
          case "clear":
            publish(ctx, null);
            break;
          case "switch":
            switchFloor(state.sceneId === GROUND ? UPPER : GROUND);
            break;
          case "share":
            if (role === "dm") toggleShare(ctx);
            break;
          case "measure":
            pickMeasure(scope, step.walk ? "walking" : "straight");
            break;
          case "fog":
            if (fogged) view = step.reveal ? revealStairs(view) : room(true);
            break;
        }

        const now = tool.store.getState();
        const carriedNow = now.ruler ? stillCarried(now.carry, now.ruler.stops) : null;
        assert.equal(now.carry !== null && now.ruler === null, false, "no carry without a ruler");
        if (carriedNow) assert.equal(now.walk, true, "a carried ruler walks");
        for (const { e, localOnly } of sent.slice(before)) {
          if (e.k !== "ruler") continue;
          assert.equal(e.id, now.ruler?.id ?? e.id, "one live id");
          assert.ok(frameFits(e), "every frame fits the schema and the cap");
          if (e.prior) {
            assert.ok(e.prior.ends.length <= MAX_RULER_ENDS && e.prior.anchors.length <= MAX_RULER_STOPS);
            if (!localOnly) {
              assert.ok(now.carry?.shared, "a ruler carried private is never sent");
              // Each end was public when crossed: the fog step may hide it since, which the server judges (4.4).
            }
          }
        }
        const last = [...sent].reverse().find((s) => s.e.k === "ruler" || s.e.k === "rulerEnd");
        if (last?.e.k === "ruler" && now.ruler && last.e.id === now.ruler.id) {
          assert.equal(last.e.prior !== undefined, carriedNow !== null, "prior exactly while carried");
          if (last.e.prior && carriedNow) assert.deepEqual(last.e.prior, carriedNow.prior);
        }
      }

      publish(ctx, null);
      // Every id a frame went to the server under got its end there, after its last frame.
      const ids = new Set(sent.filter((s) => s.e.k === "ruler" && !s.localOnly).map((s) => (s.e as { id: string }).id));
      for (const id of ids) {
        const lastFrame = sent.findLastIndex((s) => s.e.k === "ruler" && s.e.id === id && !s.localOnly);
        const ended = sent.findLastIndex((s) => s.e.k === "rulerEnd" && s.e.id === id && !s.localOnly);
        assert.ok(ended > lastFrame, `ruler ${id} ended on the server`);
      }
    }),
    { numRuns: 200 },
  );
  // The runs exercise the carry, again and again across one ruler (eight crossings in a row is carry.test.ts's).
  assert.ok(carries > 15, `the runs carried rulers (${carries})`);
  assert.ok(mostEnds >= 2, `and over stairs again (${mostEnds})`);
});
