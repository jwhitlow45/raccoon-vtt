import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { migrateOp } from "../migrate.ts";
import type { MapPhase, MapVideo, RoomState, Scene, SceneMap } from "../model.ts";
import { clientOpSchema, type MapPhaseInput, type Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, env, room, scene } from "../testutil.ts";

/**
 * Animated maps in the reducer (docs/design/design-v1-animated-maps.md 9.1):
 * every way a map or a phase is written carries its video, and the map's
 * video is always the showing phase's, the only one players receive.
 */

function video(assetId: string, widthPx = 1920, heightPx = 1080): MapVideo {
  return { assetId, widthPx, heightPx, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 6_000 };
}

const DAY = video("v-day");
const NIGHT = video("v-night", 1280, 720);
const STILL: SceneMap = { assetId: "a-day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };

function run(state: RoomState, op: Op, seq = 1): Applied {
  const result = applyOp(state, op, DM, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result;
}

function after(state: RoomState, op: Op, seq = 1): RoomState {
  return run(state, op, seq).state;
}

function undo(state: RoomState, applied: Applied, seq = 50): RoomState {
  assert.ok(applied.inverse, "the op has an inverse");
  return after(state, { t: "sys.restore", entries: applied.inverse, from: "undo", deps: true }, seq);
}

function phase(id: string, assetId: string, v?: MapVideo, size: Pick<MapPhase, "widthPx" | "heightPx"> = { widthPx: 1920, heightPx: 1080 }): MapPhaseInput {
  return { id, name: `Phase ${id}`, assetId, ...size, ...(v ? { video: v } : {}) };
}

function activeOf(s: Scene): MapPhase | undefined {
  return s.phases?.find((p) => p.id === s.phaseId);
}

function withMap(map: SceneMap = { ...STILL, video: DAY }): RoomState {
  return room({ scenes: { s1: scene("s1", { map }) } });
}

/** Two video phases and a still one, the first showing. */
function phased(): RoomState {
  return after(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "a-day", DAY), phase("p2", "a-night", NIGHT, { widthPx: 1280, heightPx: 720 }), phase("p3", "a-fire")] } });
}

describe("a map's video in the reducer (docs/design/design-v1-animated-maps.md 9.1)", () => {
  test("scene.create and scene.setMap keep the video, and a new grid leaves it on the map", () => {
    const created = after(room(), { t: "scene.create", scene: { id: "s7", name: "Crypt", bounds: { w: 30, h: 17 }, map: { ...STILL, video: DAY } } });
    assert.deepEqual(created.scenes.s7?.map?.video, DAY);
    const set = after(room({ scenes: { s1: scene("s1", { map: STILL }) } }), { t: "scene.setMap", sceneId: "s1", map: { ...STILL, video: NIGHT } });
    assert.deepEqual(set.scenes.s1?.map?.video, NIGHT);
    const aligned = after(set, { t: "scene.setGrid", sceneId: "s1", cellPx: 70, originPx: { x: 3, y: 4 } });
    assert.deepEqual(aligned.scenes.s1?.map, { ...STILL, cellPx: 70, originPx: { x: 3, y: 4 }, video: NIGHT });
  });

  test("Use the still only drops the video in one step, and its undo puts it back", () => {
    const state = withMap();
    const still = run(state, { t: "scene.setMap", sceneId: "s1", map: STILL });
    assert.equal(still.state.scenes.s1?.map?.video, undefined);
    assert.deepEqual(still.state.scenes.s1?.map, STILL);
    assert.deepEqual(undo(still.state, still).scenes.s1?.map, { ...STILL, video: DAY });
  });

  test("a first phase list from an animated map keeps its video on the first phase and on the map", () => {
    const state = after(withMap(), { t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "a-day", DAY), phase("p2", "a-fire")] } });
    const s1 = state.scenes.s1!;
    assert.deepEqual(s1.phases?.map((p) => p.video), [DAY, undefined]);
    assert.equal("video" in s1.phases![1]!, false, "a still phase holds no video field at all");
    assert.deepEqual(s1.map?.video, DAY);
  });

  test("switching phases shows each phase's own video, and a still phase shows none", () => {
    let state = after(phased(), { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    assert.deepEqual(state.scenes.s1?.map?.video, NIGHT);
    assert.equal(state.scenes.s1?.map?.assetId, "a-night");
    state = after(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p3" });
    assert.equal(state.scenes.s1?.map?.video, undefined);
    assert.equal("video" in state.scenes.s1!.map!, false);
    state = after(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p1" });
    assert.deepEqual(state.scenes.s1?.map?.video, DAY);
  });

  test("adding, renaming, moving and removing phases keeps every video where it was", () => {
    const state = phased();
    const list = state.scenes.s1!.phases!;
    const renamed = list.map((p) => (p.id === "p1" ? { ...p, name: "Dawn" } : p));
    const added = [...renamed, phase("p4", "a-flood")];
    let next = after(state, { t: "scene.update", sceneId: "s1", patch: { phases: added } });
    assert.deepEqual(next.scenes.s1?.phases?.map((p) => [p.id, p.video?.assetId]), [["p1", "v-day"], ["p2", "v-night"], ["p3", undefined], ["p4", undefined]]);
    const moved = [added[2]!, added[0]!, added[3]!, added[1]!];
    next = after(next, { t: "scene.update", sceneId: "s1", patch: { phases: moved } });
    assert.deepEqual(next.scenes.s1?.phases?.map((p) => [p.id, p.video?.assetId]), [["p3", undefined], ["p1", "v-day"], ["p4", undefined], ["p2", "v-night"]]);
    assert.deepEqual(next.scenes.s1?.map?.video, DAY, "the showing phase is still p1");
    // Removing the showing phase switches to the first one left, a still here, so the map shows no video.
    next = after(next, { t: "scene.update", sceneId: "s1", patch: { phases: [moved[0]!, moved[3]!] } });
    assert.equal(next.scenes.s1?.phaseId, "p3");
    assert.equal(next.scenes.s1?.map?.video, undefined);
    assert.deepEqual(next.scenes.s1?.phases?.map((p) => p.video?.assetId), [undefined, "v-night"]);
  });

  test("a new map on a scene with phases replaces the showing phase's video, or leaves it a still, and nothing else", () => {
    const state = after(phased(), { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    const other = video("v-storm", 1280, 720);
    const replaced = after(state, { t: "scene.setMap", sceneId: "s1", map: { assetId: "a-storm", widthPx: 1280, heightPx: 720, cellPx: 1, originPx: { x: 0, y: 0 }, video: other } });
    assert.deepEqual(replaced.scenes.s1?.phases?.map((p) => p.video?.assetId), ["v-day", "v-storm", undefined]);
    assert.deepEqual(replaced.scenes.s1?.map?.video, other);
    const still = after(replaced, { t: "scene.setMap", sceneId: "s1", map: { assetId: "a-storm", widthPx: 1280, heightPx: 720, cellPx: 1, originPx: { x: 0, y: 0 } } });
    assert.deepEqual(still.scenes.s1?.phases?.map((p) => p.video?.assetId), ["v-day", undefined, undefined]);
    assert.equal("video" in activeOf(still.scenes.s1!)!, false);
    assert.equal(still.scenes.s1?.map?.video, undefined);
    const gone = after(still, { t: "scene.setMap", sceneId: "s1", map: null });
    assert.equal(gone.scenes.s1?.phases, undefined);
    assert.equal(gone.scenes.s1?.map, undefined);
  });

  test("a new grid on a scene with phases keeps the showing phase's video on the map", () => {
    const state = after(after(phased(), { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" }), { t: "scene.setGrid", sceneId: "s1", cellPx: 48, originPx: { x: 2, y: 2 } });
    assert.deepEqual(state.scenes.s1?.map?.video, NIGHT);
    assert.equal(state.scenes.s1?.map?.cellPx, 48);
  });

  test("a copy of a scene keeps its map's and its phases' videos", () => {
    const state = after(phased(), { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Crypt copy", include: { creatures: false, characters: false, fog: false, drawings: false } });
    const copy = state.scenes.s9!;
    assert.deepEqual(copy.map?.video, DAY);
    assert.deepEqual(copy.phases?.map((p) => p.video?.assetId), ["v-day", "v-night", undefined]);
  });

  test("a stored op replays the same at op version 44 and 45, with and without a video", () => {
    const old = migrateOp({ t: "scene.setMap", sceneId: "s1", map: STILL }, 44);
    assert.deepEqual(after(withMap(), old).scenes.s1?.map, STILL);
    const moving = migrateOp({ t: "scene.setMap", sceneId: "s1", map: { ...STILL, video: NIGHT } }, 45);
    assert.deepEqual(after(withMap(STILL), moving).scenes.s1?.map?.video, NIGHT);
  });
});

/*
 * The state machine rule: random sequences of every op that writes a map or
 * its phases, undos included, never leave the map showing a video other
 * than the showing phase's, and never invent or lose one.
 */
describe("the map's video over random phase edits", () => {
  const videos = [DAY, video("v-dusk"), video("v-rain"), NIGHT];
  const stills = ["a-day", "a-dusk", "a-rain", "a-fire", "a-flood", "a-snow"];
  const pool = fc.record({ still: fc.constantFrom(...stills), video: fc.option(fc.constantFrom(...videos.slice(0, 3)), { nil: undefined }) });
  const step = fc.oneof(
    fc.record({ kind: fc.constant("phases" as const), list: fc.uniqueArray(fc.record({ id: fc.constantFrom("p1", "p2", "p3", "p4", "p5"), place: pool }), { minLength: 1, maxLength: 5, selector: (p) => p.id }) }),
    fc.record({ kind: fc.constant("switch" as const), pick: fc.nat() }),
    fc.record({ kind: fc.constant("setMap" as const), place: pool }),
    fc.record({ kind: fc.constant("clear" as const) }),
    fc.record({ kind: fc.constant("grid" as const), cellPx: fc.integer({ min: 20, max: 120 }) }),
    fc.record({ kind: fc.constant("undo" as const) }),
  );

  function toOp(s: Scene, st: { kind: string; list?: { id: string; place: { still: string; video?: MapVideo | undefined } }[]; pick?: number; place?: { still: string; video?: MapVideo | undefined }; cellPx?: number }): Op | null {
    switch (st.kind) {
      case "phases":
        return s.map ? { t: "scene.update", sceneId: "s1", patch: { phases: st.list!.map(({ id, place }) => phase(id, place.still, place.video)) } } : null;
      case "switch": {
        const list = s.phases ?? [];
        return list.length > 0 ? { t: "scene.setPhase", sceneId: "s1", phaseId: list[st.pick! % list.length]!.id } : null;
      }
      case "setMap":
        return { t: "scene.setMap", sceneId: "s1", map: { ...STILL, assetId: st.place!.still, ...(st.place!.video ? { video: st.place!.video } : {}) } };
      case "clear":
        return { t: "scene.setMap", sceneId: "s1", map: null };
      case "grid":
        return s.map ? { t: "scene.setGrid", sceneId: "s1", cellPx: st.cellPx!, originPx: { x: 0, y: 0 } } : null;
      default:
        return null;
    }
  }

  test("2,000 sequences keep the map's video the showing phase's, from the videos put", () => {
    // What the runs reached, so a generator that stopped reaching phases with videos fails here rather than passing idle.
    const reached = { videoShowing: 0, stillShowingBesideVideo: 0, undone: 0 };
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 25 }), (steps) => {
        let state = withMap();
        const done: Applied[] = [];
        const known = new Set(videos.map((v) => v.assetId));
        let seq = 1;
        for (const st of steps) {
          const s1 = state.scenes.s1!;
          let next: RoomState | null = null;
          if (st.kind === "undo") {
            const last = done.pop();
            if (last?.inverse) {
              const result = applyOp(state, { t: "sys.restore", entries: last.inverse, from: "undo", deps: true }, DM, env(seq++));
              if (result.ok) {
                next = result.state;
                reached.undone++;
              }
            }
          } else {
            const op = toOp(s1, st);
            if (op === null) continue;
            assert.ok(clientOpSchema.safeParse(op).success, `the client could send ${op.t}`);
            const result = applyOp(state, op, DM, env(seq++));
            if (result.ok) {
              done.push(result);
              next = result.state;
            }
          }
          if (next === null) continue;
          state = next;
          const s = state.scenes.s1!;
          const active = activeOf(s);
          if (s.phases) assert.deepEqual(s.map?.video, active?.video, "the map shows the showing phase's video");
          if (s.phases && active?.video) reached.videoShowing++;
          if (s.phases && !active?.video && s.phases.some((p) => p.video)) reached.stillShowingBesideVideo++;
          for (const v of [s.map?.video, ...(s.phases ?? []).map((p) => p.video)]) if (v) assert.ok(known.has(v.assetId), `an unknown video ${v.assetId}`);
          if (s.map === undefined) assert.equal(s.phases, undefined);
        }
      }),
      { numRuns: 2_000 },
    );
    assert.ok(reached.videoShowing > 1_000 && reached.stillShowingBesideVideo > 100 && reached.undone > 500, JSON.stringify(reached));
  });
});
