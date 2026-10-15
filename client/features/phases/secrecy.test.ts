import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectEntity, projectState, visibleAssetIds } from "#shared/project.ts";
import { apply, DM, P1, room } from "#shared/testutil.ts";
import { addPhase, movePhase, renamePhase } from "./rules.ts";

/*
 * Players receive the active phase's image and nothing about the others
 * (docs/design-v1-maps-vision.md section 3.4), so "On fire" never spoils
 * ahead. The projection is the boundary. These run the DM's real edits from
 * this folder through the reducer and look at everything a player is sent:
 * the whole projection, the scene entity the fan-out compares, and the
 * assets the player may fetch.
 */

const DAY = { assetId: "asset-day-1111", widthPx: 3000, heightPx: 2000 };
const NIGHT = { assetId: "asset-night-2222", widthPx: 1500, heightPx: 1000, name: "Moonlit night" };
const FIRE = { assetId: "asset-fire-3333", widthPx: 6000, heightPx: 4000, name: "On fire" };

function ids(): () => string {
  let n = 0;
  return () => `phase-id-${++n}`;
}

/** A room whose player scene s1 has Day showing and Night and On fire prepared. */
function prepared(): RoomState {
  let state = apply(room(), { t: "scene.setMap", sceneId: "s1", map: { ...DAY, cellPx: 100, originPx: { x: 0, y: 0 } } });
  const newId = ids();
  for (const image of [NIGHT, FIRE]) {
    const edit = addPhase(state.scenes.s1!, image, newId);
    assert.ok("phases" in edit, "the phase fits");
    state = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: edit.phases } });
  }
  return state;
}

function phaseIdOf(state: RoomState, name: string): string {
  const id = state.scenes.s1!.phases?.find((p) => p.name === name)?.id;
  assert.ok(id, `phase ${name}`);
  return id;
}

/** Everything about the scene's phases a player must never receive, by their own values. */
function secretsOf(state: RoomState): string[] {
  const scene = state.scenes.s1!;
  const shown = scene.map?.assetId;
  const others = (scene.phases ?? []).filter((p) => p.assetId !== shown);
  return [...others.flatMap((p) => [p.assetId, p.name]), ...(scene.phases ?? []).map((p) => p.id), '"phases"', '"phaseId"', '"phaseGrid"'];
}

function assertNothingLeaks(state: RoomState, viewer: Viewer = P1): void {
  const sent = JSON.stringify(projectState(state, viewer, { sceneId: null }));
  for (const secret of secretsOf(state)) assert.ok(!sent.includes(secret), `a player received ${secret}`);
  const assets = visibleAssetIds(state, viewer, { sceneId: null });
  for (const phase of state.scenes.s1!.phases ?? []) {
    assert.equal(assets.has(phase.assetId), phase.assetId === state.scenes.s1!.map?.assetId, `a player may fetch ${phase.name} only while it shows`);
  }
}

const playerScene = (state: RoomState) => projectEntity(keys.scene("s1"), state, P1, { sceneId: null });

describe("what a player receives of a scene's phases", () => {
  test("preparing phases sends a player nothing: the scene they hold is the same value as before", () => {
    const before = apply(room(), { t: "scene.setMap", sceneId: "s1", map: { ...DAY, cellPx: 100, originPx: { x: 0, y: 0 } } });
    const state = prepared();
    assert.deepEqual(playerScene(state), playerScene(before));
    assertNothingLeaks(state);
  });

  test("a switch shows the new image and only it, with nothing of the phase's name or the others", () => {
    let state = prepared();
    state = apply(state, { t: "scene.setPhase", sceneId: "s1", phaseId: phaseIdOf(state, "On fire") });
    const scene = playerScene(state) as { map?: { assetId: string } };
    assert.equal(scene.map?.assetId, FIRE.assetId);
    assertNothingLeaks(state);
    const sent = JSON.stringify(projectState(state, P1, { sceneId: null }));
    assert.ok(!sent.includes("On fire"), "the showing phase's name is the DM's too");
  });

  test("renaming and reordering phases while one shows changes nothing a player holds", () => {
    let state = prepared();
    state = apply(state, { t: "scene.setPhase", sceneId: "s1", phaseId: phaseIdOf(state, "Moonlit night") });
    const held = playerScene(state);
    const renamed = renamePhase(state.scenes.s1!, phaseIdOf(state, "On fire"), "Burning", ids());
    assert.ok(renamed);
    state = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: renamed } });
    const reordered = movePhase(state.scenes.s1!, phaseIdOf(state, "Burning"), -1);
    assert.ok(reordered);
    state = apply(state, { t: "scene.update", sceneId: "s1", patch: { phases: reordered } });
    assert.deepEqual(playerScene(state), held);
    assertNothingLeaks(state);
  });

  test("a scene the players are not on sends them nothing at all, phases or not", () => {
    let state = prepared();
    state = apply(state, { t: "room.setPlayerScene", sceneId: "s2" });
    assert.equal(playerScene(state), null);
    const sent = JSON.stringify(projectState(state, P1, { sceneId: null }));
    for (const secret of [DAY.assetId, NIGHT.assetId, FIRE.assetId, NIGHT.name, FIRE.name]) assert.ok(!sent.includes(secret));
  });

  test("the DM receives every phase, so the DM's device can switch and preload", () => {
    const state = prepared();
    const scene = projectEntity(keys.scene("s1"), state, DM, { sceneId: "s1" }) as { phases?: unknown[] };
    assert.equal(scene.phases?.length, 3);
    const assets = visibleAssetIds(state, DM, { sceneId: "s1" });
    for (const asset of [DAY, NIGHT, FIRE]) assert.ok(assets.has(asset.assetId));
  });
});
