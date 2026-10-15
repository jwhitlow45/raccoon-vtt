import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Member, RoomState, Scene } from "#shared/model.ts";
import { createInitialState } from "#shared/initial.ts";
import { dotColor } from "./connection.ts";
import { preferredMapVariant } from "./device.ts";
import {
  displayName,
  drawsAboveFog,
  footprint,
  mapWorldRect,
  sceneGate,
  selectionScene,
  snapPosition,
  type ViewToken,
} from "./scene.ts";
import {
  BADGE_RESERVE_PX,
  chipRow,
  cropSourceRect,
  effectChip,
  elevationBadge,
  hpDisplay,
  hpLabel,
} from "./tokenView.ts";

const dm: Member = { id: "m-dm", rev: 1, name: "DM", color: "#f38400", kind: "dm", createdAt: "2026-10-12T00:00:00Z" };

function stateWithScene(patch: Partial<Scene> = {}): { state: RoomState; sceneId: string } {
  const state = createInitialState({ roomName: "Test", dm });
  const sceneId = state.meta.playerSceneId!;
  state.scenes[sceneId] = { ...state.scenes[sceneId]!, ...patch };
  return { state, sceneId };
}

describe("fail-closed scene gate", () => {
  test("nothing is drawn before the snapshot is applied", () => {
    assert.deepEqual(sceneGate({ view: null, sceneId: "x", role: "player" }), { kind: "wait" });
    assert.deepEqual(sceneGate({ view: null, sceneId: "x", role: "dm" }), { kind: "wait" });
  });

  test("blackout shows black to players before anything else", () => {
    const { state, sceneId } = stateWithScene();
    state.meta.view.blackout = true;
    assert.deepEqual(sceneGate({ view: state, sceneId, role: "player" }), { kind: "blackout" });
    assert.equal(sceneGate({ view: state, sceneId, role: "dm" }).kind, "ready");
  });

  test("fog is on unless the scene says false in so many words", () => {
    const off = stateWithScene({ fogEnabled: false });
    const gate = sceneGate({ view: off.state, sceneId: off.sceneId, role: "player" });
    assert.equal(gate.kind === "ready" && gate.fog, false);

    for (const fogEnabled of [true, undefined, "false", 0, null]) {
      const s = stateWithScene({ fogEnabled: fogEnabled as boolean });
      const g = sceneGate({ view: s.state, sceneId: s.sceneId, role: "player" });
      assert.equal(g.kind === "ready" && g.fog, true, `fogEnabled ${String(fogEnabled)}`);
    }
  });

  test("a missing scene or unreadable bounds draws nothing", () => {
    const { state, sceneId } = stateWithScene();
    assert.deepEqual(sceneGate({ view: state, sceneId: "other", role: "player" }), { kind: "noScene" });
    assert.deepEqual(sceneGate({ view: state, sceneId: null, role: "player" }), { kind: "noScene" });
    const bad = stateWithScene({ bounds: { w: 0, h: 10 } });
    assert.deepEqual(sceneGate({ view: bad.state, sceneId: bad.sceneId, role: "player" }), { kind: "wait" });
    const huge = stateWithScene({ bounds: { w: 201, h: 10 } });
    assert.deepEqual(sceneGate({ view: huge.state, sceneId: huge.sceneId, role: "dm" }), { kind: "wait" });
  });
});

describe("selectionScene (LPD-PLAYER-7)", () => {
  const { state, sceneId } = stateWithScene();
  const ready = sceneGate({ view: state, sceneId, role: "player" });

  test("a blackout keeps the selection: the same scene comes back after it", () => {
    const first = selectionScene(null, ready);
    assert.deepEqual(first, { scene: sceneId, letGo: true }, "the first scene starts with nothing selected");
    const paused = selectionScene(first.scene, { kind: "blackout" });
    assert.deepEqual(paused, { scene: sceneId, letGo: false });
    assert.deepEqual(selectionScene(paused.scene, ready), { scene: sceneId, letGo: false }, "the pause lifting lets go of nothing");
  });

  test("a new scene, or losing the scene, still lets go", () => {
    const other = stateWithScene();
    other.state.scenes.next = { ...other.state.scenes[other.sceneId]!, id: "next" };
    const next = sceneGate({ view: other.state, sceneId: "next", role: "player" });
    assert.deepEqual(selectionScene(sceneId, next), { scene: "next", letGo: true });
    assert.deepEqual(selectionScene(sceneId, { kind: "noScene" }), { scene: null, letGo: true });
    assert.deepEqual(selectionScene(sceneId, { kind: "wait" }), { scene: null, letGo: true });
    assert.deepEqual(selectionScene(null, { kind: "wait" }), { scene: null, letGo: false });
  });
});

describe("geometry", () => {
  test("footprints per size, and custom sizes bounded", () => {
    assert.deepEqual(footprint({ size: "tiny" }), { w: 0.5, h: 0.5 });
    assert.deepEqual(footprint({ size: "medium" }), { w: 1, h: 1 });
    assert.deepEqual(footprint({ size: "gargantuan" }), { w: 4, h: 4 });
    assert.deepEqual(footprint({ size: "custom", w: 3, h: 50 }), { w: 3, h: 20 });
    assert.deepEqual(footprint({ size: "custom" }), { w: 1, h: 1 });
  });

  test("snapping: half cells for Tiny, whole cells otherwise", () => {
    assert.deepEqual(snapPosition(2.3, 4.8, { w: 0.5, h: 0.5 }), { x: 2.5, y: 5 });
    assert.deepEqual(snapPosition(2.3, 4.8, { w: 2, h: 2 }), { x: 2, y: 5 });
  });

  test("the map covers its calibrated world rectangle", () => {
    const rect = mapWorldRect({ assetId: "a", widthPx: 3000, heightPx: 2000, cellPx: 100, originPx: { x: 50, y: 25 } });
    assert.deepEqual(rect, { x: -0.5, y: -0.25, width: 30, height: 20 });
    assert.equal(mapWorldRect({ assetId: "a", widthPx: 3000, heightPx: 2000, cellPx: 0, originPx: { x: 0, y: 0 } }), null);
  });
});

describe("tokens", () => {
  const base = {
    fogExempt: false,
    fogExemptAuto: false,
    ownerIds: [] as string[],
  } as unknown as ViewToken;
  const player: Member = { ...dm, id: "m-p", kind: "player" };

  test("players use the projection's aboveFog and default to below", () => {
    assert.equal(drawsAboveFog({ ...base, aboveFog: true }, "player", {}), true);
    assert.equal(drawsAboveFog({ ...base, ownerIds: ["m-p"] }, "player", { "m-p": player }), false);
  });

  test("a DM's view applies the same rule to the raw fields", () => {
    assert.equal(drawsAboveFog(base, "dm", {}), false);
    assert.equal(drawsAboveFog({ ...base, fogExempt: true }, "dm", {}), true);
    assert.equal(drawsAboveFog({ ...base, fogExemptAuto: true }, "dm", {}), false, "a creature revealed on its turn follows the fog");
    // A creature the DM marked to lend the party its sight is a party member, shown to players above everything.
    assert.equal(drawsAboveFog({ ...base, partyVision: true }, "dm", {}), true);
    assert.equal(drawsAboveFog({ ...base, partyVision: false }, "dm", {}), false);
    assert.equal(drawsAboveFog({ ...base, ownerIds: ["m-p"] }, "dm", { "m-p": player }), true);
    assert.equal(drawsAboveFog({ ...base, ownerIds: ["m-dm"] }, "dm", { "m-dm": dm }), false);
  });

  test("a DM's view counts a player character's owners, as players' projections do", () => {
    const pc = { ...base, actor: { ref: "c-thorn" } } as ViewToken;
    const members = { "m-p": player, "m-dm": dm };
    assert.equal(drawsAboveFog(pc, "dm", members, { "c-thorn": { ownerIds: ["m-p"] } }), true);
    assert.equal(drawsAboveFog(pc, "dm", members, { "c-thorn": { ownerIds: [] } }), false);
    assert.equal(drawsAboveFog(pc, "dm", members, { "c-thorn": { ownerIds: ["m-dm"] } }), false);
    assert.equal(drawsAboveFog(pc, "dm", members, {}), false);
    assert.equal(drawsAboveFog(pc, "dm", members), false);
  });

  test("numbered names", () => {
    assert.equal(displayName({ name: "Goblin", number: 3 }), "Goblin 3");
    assert.equal(displayName({ name: "Thorn" }), "Thorn");
  });

  test("HP labels", () => {
    assert.equal(hpLabel({ hp: { cur: 7, max: 7, temp: 0 }, life: "alive" }), "Healthy");
    assert.equal(hpLabel({ hp: { cur: 3, max: 7, temp: 0 }, life: "alive" }), "Bloodied");
    assert.equal(hpLabel({ hp: { cur: 0, max: 7, temp: 0 }, life: "dying" }), "Dying");
    assert.equal(hpLabel({ hp: { cur: 0, max: 7, temp: 0 }, life: "dead" }), "Dead");
  });

  test("HP display follows the viewer's access and the token's setting", () => {
    const actor = { hp: { cur: 5, max: 20, temp: 3 }, life: "alive" as const };
    assert.deepEqual(hpDisplay({ actor, hpVisibility: "hidden", fullAccess: true }), {
      kind: "bar",
      fraction: 0.25,
      text: "5/20 +3",
    });
    assert.deepEqual(hpDisplay({ actor, hpVisibility: "hidden", fullAccess: false }), { kind: "none" });
    assert.deepEqual(hpDisplay({ actor, hpVisibility: "label", fullAccess: false }), { kind: "label", label: "Bloodied" });
    assert.deepEqual(hpDisplay({ actor, hpVisibility: "bar", fullAccess: false }), { kind: "bar", fraction: 0.25 });
    assert.deepEqual(hpDisplay({ actor: undefined, hpVisibility: "exact", fullAccess: false }), { kind: "none" });
    assert.deepEqual(hpDisplay({ actor: { life: "dead" }, hpVisibility: "label", fullAccess: false }), {
      kind: "label",
      label: "Dead",
    });
  });

  test("effect chips carry a glyph as well as a color", () => {
    assert.equal(effectChip({ key: "poisoned" }).glyph, "Po");
    assert.deepEqual(effectChip({ key: "exhaustion", level: 3 }), {
      glyph: "E3",
      color: "#a16207",
      label: "Exhaustion 3",
    });
    assert.equal(effectChip({ key: "concentrating", spell: "Bless" }).label, "Concentrating: Bless");
    assert.deepEqual(effectChip({ key: "custom", label: "Marked by Vex", color: "#123456" }), {
      glyph: "Ma",
      color: "#123456",
      label: "Marked by Vex",
    });
  });

  test("chips overflow into a +N chip and leave room for the elevation badge", () => {
    assert.deepEqual(chipRow(100, 3, false), { shown: 3, overflow: 0, xs: [0, 20, 40] });
    const tight = chipRow(60, 5, false);
    assert.deepEqual(tight, { shown: 2, overflow: 3, xs: [0, 20, 40] });
    const withBadge = chipRow(60 + BADGE_RESERVE_PX, 5, true);
    assert.deepEqual(withBadge, tight);
    assert.deepEqual(chipRow(10, 2, false), { shown: 2, overflow: 0, xs: [0, 20] });
    assert.deepEqual(chipRow(10, 3, false), { shown: 1, overflow: 2, xs: [0, 20] });
    assert.deepEqual(chipRow(10, 0, false), { shown: 0, overflow: 0, xs: [] });
  });

  test("elevation badge", () => {
    assert.equal(elevationBadge(30), "↑30");
    assert.equal(elevationBadge(-10), "↓10");
    assert.equal(elevationBadge(0), null);
  });

  test("crop picks a square around the center and stays inside the image", () => {
    assert.deepEqual(cropSourceRect({ width: 400, height: 200 }, { cx: 0.5, cy: 0.5, zoom: 1 }), {
      x: 100,
      y: 0,
      width: 200,
      height: 200,
    });
    assert.deepEqual(cropSourceRect({ width: 400, height: 200 }, { cx: 0, cy: 0, zoom: 2 }), {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    assert.deepEqual(cropSourceRect({ width: 400, height: 200 }, undefined), { x: 100, y: 0, width: 200, height: 200 });
    assert.deepEqual(cropSourceRect({ width: 400, height: 400 }, { cx: 0.5, cy: 0.5, zoom: 1 }, 2), {
      x: 0,
      y: 100,
      width: 400,
      height: 200,
    });
  });
});

describe("device and connection", () => {
  test("phones get the mobile map, everything else the full one, unless the setting says otherwise", () => {
    assert.equal(preferredMapVariant({ coarsePointer: true, shortSidePx: 390, setting: "auto" }), "mobile");
    assert.equal(preferredMapVariant({ coarsePointer: false, shortSidePx: 390, setting: "auto" }), "full");
    assert.equal(preferredMapVariant({ coarsePointer: true, shortSidePx: 1024, setting: "auto" }), "full");
    assert.equal(preferredMapVariant({ coarsePointer: true, shortSidePx: 390, setting: "full" }), "full");
  });

  test("the connection dot has three colors", () => {
    assert.equal(dotColor("open"), "green");
    assert.equal(dotColor("reconnecting"), "amber");
    assert.equal(dotColor("connecting"), "amber");
    assert.equal(dotColor("offline"), "red");
  });
});
