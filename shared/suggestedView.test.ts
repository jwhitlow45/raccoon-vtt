import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { keys } from "./keys.ts";
import type { RoomState } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectState } from "./project.ts";
import { clientMessageSchema, clientOpSchema, ephEventSchema, type Op } from "./protocol.ts";
import { guardHash } from "./reducer/tx.ts";
import { apply, DM, P1, room, scene } from "./testutil.ts";

/**
 * A scene's suggested view and the table display's `iso`
 * (docs/design-v1-isometric-view.md 4.2 and 7, lane ISO-1).
 */

const suggest = (suggestedView: "topDown" | "isometric", sceneId = "s1"): Op => ({ t: "scene.update", sceneId, patch: { suggestedView } });

function crypt(): RoomState {
  return room({ scenes: { s1: scene("s1", { name: "Crypt" }), s2: scene("s2", { name: "Road" }) } });
}

describe("a scene's suggested view", () => {
  test("Isometric is stored, Top-down removes it, and a scene set back hashes as it did", () => {
    const state = crypt();
    const hash = guardHash(keys.scene("s1"), state.scenes.s1);
    const iso = apply(state, suggest("isometric"));
    assert.equal(iso.scenes.s1!.suggestedView, "isometric");
    assert.equal(iso.scenes.s2!.suggestedView, undefined, "only its own scene");
    const back = apply(iso, suggest("topDown"));
    assert.ok(!("suggestedView" in back.scenes.s1!));
    assert.equal(guardHash(keys.scene("s1"), back.scenes.s1), hash);
    assert.ok(!("suggestedView" in apply(state, suggest("topDown")).scenes.s1!), "Top-down on a scene that never had one stores nothing");
    assert.equal(apply(iso, { t: "scene.update", sceneId: "s1", patch: { name: "Tomb" } }).scenes.s1!.suggestedView, "isometric", "a patch without it keeps it");
  });

  test("the DM's alone: a player's patch is refused, as every scene.update of theirs is", () => {
    const state = crypt();
    assert.ok(canApply(suggest("isometric"), DM, state, { canUseAsset: () => true }).ok);
    const refused = canApply(suggest("isometric"), P1, state, { canUseAsset: () => true });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.code, "forbidden");
  });

  test("players and table displays receive it in their copy of the scene, since a following device shows it", () => {
    const state = apply(crypt(), suggest("isometric"));
    state.meta = { ...state.meta, playerSceneId: "s1" };
    for (const viewer of [P1, { memberId: "display:abcdefghijkl", role: "player" as const }]) {
      assert.equal(projectState(state, viewer, { sceneId: "s1" }).scenes.s1!.suggestedView, "isometric");
    }
    assert.ok(!("suggestedView" in projectState(crypt(), P1, { sceneId: "s1" }).scenes.s1!), "absent stays absent");
  });

  test("a duplicate copies it", () => {
    const state = apply(crypt(), suggest("isometric"));
    const copy = apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Crypt (copy)", include: { creatures: false, characters: false, fog: false, drawings: false } });
    assert.equal(copy.scenes.s3!.suggestedView, "isometric");
  });

  test("the patch takes the two views only, and a new scene takes none", () => {
    for (const v of ["topDown", "isometric"]) assert.ok(clientOpSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { suggestedView: v } }).success, v);
    for (const v of ["iso", "TopDown", null, true]) assert.equal(clientOpSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { suggestedView: v } }).success, false, String(v));
    assert.equal(clientOpSchema.safeParse({ t: "scene.create", scene: { id: "s9", name: "Mat", bounds: { w: 10, h: 10 }, suggestedView: "isometric" } }).success, false);
  });
});

describe("the view event's iso (ISO-D17)", () => {
  const event = (iso: unknown) => ({ k: "view", x: 10, y: 8, w: 24, h: 13.5, iso });

  test("takes a turn of 0 to 3 and a size like w and h, and nothing else", () => {
    for (const turn of [0, 1, 2, 3]) assert.ok(ephEventSchema.safeParse(event({ turn, vw: 0.01, vh: 2_000 })).success, `turn ${turn}`);
    assert.ok(ephEventSchema.safeParse({ k: "view", x: 10, y: 8, w: 24, h: 13.5 }).success, "a Top-down DM's event as before");
    for (const bad of [
      { turn: 4, vw: 10, vh: 10 },
      { turn: -1, vw: 10, vh: 10 },
      { turn: 1.5, vw: 10, vh: 10 },
      { turn: 0, vw: 0, vh: 10 },
      { turn: 0, vw: 10, vh: 2_000.5 },
      { turn: 0, vw: 10 },
      { turn: 0, vw: 10, vh: 10, x: 3 },
      null,
    ]) {
      assert.equal(ephEventSchema.safeParse(event(bad)).success, false, JSON.stringify(bad));
    }
    assert.ok(clientMessageSchema.safeParse({ t: "eph", sceneId: "s1", e: event({ turn: 2, vw: 30, vh: 60 }) }).success);
  });

  test("a page from before it drops an Isometric DM's event, so it stops following until it is reloaded", () => {
    // The `view` event's schema as it shipped before the isometric view.
    const coord = z.number().min(-1_000).max(1_000);
    const before = z.strictObject({ k: z.literal("view"), x: coord, y: coord, w: z.number().min(0.01).max(2_000), h: z.number().min(0.01).max(2_000) });
    assert.ok(before.safeParse({ k: "view", x: 10, y: 8, w: 24, h: 13.5 }).success, "a Top-down DM's event still reaches it");
    assert.equal(before.safeParse(event({ turn: 1, vw: 30, vh: 60 })).success, false);
  });
});
