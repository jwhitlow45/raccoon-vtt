import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { MapVideo, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, room } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Animated maps in the stored-state schema (docs/design/design-v1-animated-maps.md
 * 9.1): a map and each phase take a video within the protocol's bounds, and
 * the map's video must be the showing phase's in presence, id and every fact.
 */

function video(assetId: string, overrides: Partial<MapVideo> = {}): MapVideo {
  return { assetId, widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", audio: "opus", fps: 30, durationMs: 42_000, kbps: 6_000, audioChannels: 2, audioHz: 48_000, ...overrides };
}

const MAP = { assetId: "day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };
const GRID = { refWidthPx: 1920, refHeightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };
const DAY = video("v-day");
const NIGHT = video("v-night", { widthPx: 1280, heightPx: 720, container: "mp4", video: "avc1.640028", audio: "mp4a.40.2" });

function at(patch: Record<string, unknown>): { ok: boolean; message?: string } {
  const state = JSON.parse(JSON.stringify(room()));
  const parsed = parseRoomState({ ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1, ...patch } } });
  return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
}

describe("a map's video in a backup (docs/design/design-v1-animated-maps.md 9.1)", () => {
  const phases = [
    { id: "p1", name: "Day", assetId: "day", widthPx: 1920, heightPx: 1080, video: DAY },
    { id: "p2", name: "Night", assetId: "night", widthPx: 1280, heightPx: 720, video: NIGHT },
    { id: "p3", name: "Fire", assetId: "fire", widthPx: 1920, heightPx: 1080 },
  ];
  const showing = { phases, phaseId: "p1", phaseGrid: GRID, map: { ...MAP, video: DAY } };

  test("a map with a video and phases with videos parse, and a backup from before animated maps still does", () => {
    assert.ok(at({ map: { ...MAP, video: DAY } }).ok);
    assert.ok(at({ map: MAP }).ok);
    assert.ok(at(showing).ok);
    assert.ok(at({ ...showing, phaseId: "p3", map: { ...MAP, assetId: "fire" } }).ok, "a still phase showing");
    assert.ok(at({ ...showing, phaseId: "p2", map: { assetId: "night", widthPx: 1280, heightPx: 720, cellPx: 64 * (1280 / 1920), originPx: { x: 0, y: 0 }, video: NIGHT } }).ok);
  });

  test("a video out of the protocol's bounds is refused, on a map and on a phase", () => {
    for (const bad of [{ fps: 120 }, { widthPx: 8192 }, { container: "mov" }, { video: 'vp9"' }, { extra: true }] as Partial<MapVideo>[]) {
      assert.equal(at({ map: { ...MAP, video: { ...DAY, ...bad } } }).ok, false, JSON.stringify(bad));
      const listed = [{ ...phases[0]!, video: { ...DAY, ...bad } }, phases[2]!];
      assert.equal(at({ phases: listed, phaseId: "p3", phaseGrid: GRID, map: MAP }).ok, false, `phase ${JSON.stringify(bad)}`);
    }
  });

  test("the map's video is the showing phase's in presence, id and every fact", () => {
    const message = "scenes.s1: a scene's phases fit its grid, and its map is the showing phase's image";
    assert.equal(at({ ...showing, map: MAP }).message, message, "the showing phase's video missing from the map");
    assert.equal(at({ ...showing, phaseId: "p3", map: { ...MAP, assetId: "fire", video: DAY } }).message, message, "a still phase showing with a video on the map");
    assert.equal(at({ ...showing, map: { ...MAP, video: { ...NIGHT, widthPx: 1920, heightPx: 1080 } } }).message, message, "another phase's video on the map");
    assert.equal(at({ ...showing, map: { ...MAP, video: { ...DAY, kbps: 6_001 } } }).message, message, "a fact that differs");
    const { audio: _a, audioChannels: _c, audioHz: _h, ...silent } = DAY;
    assert.equal(at({ ...showing, map: { ...MAP, video: silent } }).message, message, "a fact the phase has and the map does not");
  });
});

/*
 * The state machine rule: no sequence of the ops that write maps and phases,
 * undos included, leaves a scene the stored-state schema refuses, so every
 * room with videos exports and imports again.
 */
describe("the reducer and the stored-state schema agree on videos", () => {
  const stills = ["day", "dusk", "rain", "fire"];
  const videos = [DAY, video("v-dusk"), video("v-rain", { fps: 61, audio: undefined, audioChannels: undefined, audioHz: undefined })];
  const place = fc.record({ still: fc.constantFrom(...stills), video: fc.option(fc.constantFrom(...videos), { nil: undefined }) });
  const step = fc.oneof(
    fc.record({ kind: fc.constant("phases" as const), list: fc.uniqueArray(fc.record({ id: fc.constantFrom("p1", "p2", "p3", "p4"), place }), { minLength: 1, maxLength: 4, selector: (p) => p.id }) }),
    fc.record({ kind: fc.constant("switch" as const), pick: fc.nat() }),
    fc.record({ kind: fc.constant("setMap" as const), place }),
    fc.record({ kind: fc.constant("grid" as const), cellPx: fc.integer({ min: 30, max: 90 }) }),
    fc.record({ kind: fc.constant("undo" as const) }),
  );
  const strip = (v: MapVideo | undefined): MapVideo | undefined => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as MapVideo));

  test("1,000 sequences leave every scene parseable", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 20 }), (steps) => {
        let state: RoomState = room({});
        state.scenes.s1 = { ...state.scenes.s1!, map: { ...MAP, video: DAY } };
        const inverses: NonNullable<Extract<ReturnType<typeof applyOp>, { ok: true }>["inverse"]>[] = [];
        let seq = 1;
        for (const st of steps) {
          const s1 = state.scenes.s1!;
          let op: Op | null = null;
          if (st.kind === "phases" && s1.map) op = { t: "scene.update", sceneId: "s1", patch: { phases: st.list.map(({ id, place: p }) => ({ id, name: id, assetId: p.still, widthPx: 1920, heightPx: 1080, ...(p.video ? { video: strip(p.video)! } : {}) })) } };
          else if (st.kind === "switch" && s1.phases) op = { t: "scene.setPhase", sceneId: "s1", phaseId: s1.phases[st.pick % s1.phases.length]!.id };
          else if (st.kind === "setMap") op = { t: "scene.setMap", sceneId: "s1", map: { ...MAP, assetId: st.place.still, ...(st.place.video ? { video: strip(st.place.video)! } : {}) } };
          else if (st.kind === "grid" && s1.map) op = { t: "scene.setGrid", sceneId: "s1", cellPx: st.cellPx, originPx: { x: 0, y: 0 } };
          else if (st.kind === "undo") {
            const last = inverses.pop();
            if (last) op = { t: "sys.restore", entries: last, from: "undo", deps: true };
          }
          if (op === null) continue;
          const result = applyOp(state, op, DM, env(seq++));
          if (!result.ok) continue;
          if (op.t !== "sys.restore" && result.inverse) inverses.push(result.inverse);
          state = result.state;
          const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
          assert.ok(parsed.ok, `${op.t}: ${parsed.ok ? "" : parsed.message}`);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
