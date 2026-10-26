import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyEph, approach, keepLocal, LASER_FADE_MS, nextExpiry, PING_MS, PREVIEW_IDLE_MS, sweepEph } from "./ephemeral.ts";
import { EMPTY_EPHEMERAL } from "./types.ts";

const remote = { local: false, role: "player" as const };

describe("ephemeral lifecycle", () => {
  test("pings fade on their own", () => {
    const eph = applyEph(EMPTY_EPHEMERAL, "p2", { k: "ping", x: 1, y: 2 }, 100, remote);
    assert.equal(nextExpiry(eph), 100 + PING_MS);
    assert.equal(sweepEph(eph, 100 + PING_MS - 1), eph);
    assert.deepEqual(sweepEph(eph, 100 + PING_MS).pings, []);
  });

  test("a laser keeps a fading tail, and goes once it is off and faded", () => {
    let eph = applyEph(EMPTY_EPHEMERAL, "p2", { k: "laser", x: 1, y: 1, on: true }, 0, remote);
    eph = applyEph(eph, "p2", { k: "laser", x: 2, y: 1, on: true }, 500, remote);
    eph = sweepEph(eph, LASER_FADE_MS);
    assert.deepEqual(eph.lasers.p2?.points.map((p) => p.x), [2], "the first point faded");
    eph = applyEph(eph, "p2", { k: "laser", x: 2, y: 1, on: false }, 600, remote);
    eph = sweepEph(eph, 500 + LASER_FADE_MS);
    assert.equal(eph.lasers.p2, undefined);
    assert.equal(nextExpiry(eph), null);
  });

  test("a remote laser held on with no new point goes after the idle time", () => {
    let eph = applyEph(EMPTY_EPHEMERAL, "p2", { k: "laser", x: 1, y: 1, on: true }, 0, remote);
    eph = sweepEph(eph, LASER_FADE_MS);
    assert.ok(eph.lasers.p2, "faded points, still on");
    eph = sweepEph(eph, PREVIEW_IDLE_MS);
    assert.equal(eph.lasers.p2, undefined);
  });

  test("an AoE preview carries geometry only, and the sharing flag", () => {
    const eph = applyEph(
      EMPTY_EPHEMERAL,
      "p2",
      { k: "aoe", id: "a1", shape: "cone", origin: { x: 1, y: 1, z: 0 }, yaw: 45, size: 15, shared: true },
      0,
      remote,
    );
    assert.deepEqual(eph.aoes["p2|a1"], { id: "a1", shape: "cone", origin: { x: 1, y: 1, z: 0 }, yaw: 45, size: 15, from: "p2", shared: true, local: false, at: 0 });
    assert.deepEqual(applyEph(eph, "p2", { k: "aoeEnd", id: "a1" }, 1, remote).aoes, {});
  });

  test("a DM's camera for table displays is kept only on a player-class view, each one new", () => {
    const view = { k: "view" as const, x: 10, y: 8, w: 20, h: 12 };
    const shown = applyEph(EMPTY_EPHEMERAL, "dm1", view, 5, remote);
    assert.deepEqual({ ...shown.view, id: 0 }, { id: 0, from: "dm1", x: 10, y: 8, w: 20, h: 12, at: 5 });
    const again = applyEph(shown, "dm1", view, 6, remote);
    assert.notEqual(again.view?.id, shown.view?.id, "the same rectangle sent again is followed again");
    assert.equal(applyEph(EMPTY_EPHEMERAL, "dm1", view, 5, { local: false, role: "dm" }), EMPTY_EPHEMERAL, "a DM's view never follows one");
    assert.equal(applyEph(EMPTY_EPHEMERAL, "dm1", view, 5, { local: true, role: "player" }), EMPTY_EPHEMERAL, "nor its own echo");
    assert.equal(nextExpiry(shown), null, "a camera never times out");
    // An Isometric DM's turn and size come along, for the display's fit (docs/design-v1-isometric-view.md ISO-D17).
    const iso = applyEph(EMPTY_EPHEMERAL, "dm1", { ...view, iso: { turn: 2, vw: 10, vh: 20 } }, 7, remote);
    assert.deepEqual(iso.view?.iso, { turn: 2, vw: 10, vh: 20 });
    assert.equal(shown.view && "iso" in shown.view, false);
  });

  test("a reconnect keeps only this device's own previews", () => {
    let eph = applyEph(EMPTY_EPHEMERAL, "me", { k: "ruler", id: "r1", points: [{ x: 0, y: 0 }] }, 0, { local: true, role: "dm" });
    eph = applyEph(eph, "p2", { k: "ruler", id: "r2", points: [{ x: 0, y: 0 }] }, 0, remote);
    eph = applyEph(eph, "p2", { k: "dragMove", tokenId: "t1", x: 0, y: 0 }, 0, remote);
    const kept = keepLocal(eph);
    assert.deepEqual(Object.keys(kept.rulers), ["me|r1"]);
    assert.deepEqual(kept.drags, {});
    assert.equal(keepLocal(EMPTY_EPHEMERAL), EMPTY_EPHEMERAL);
  });
});

describe("drag smoothing", () => {
  test("closes most of the gap within two frame intervals and lands exactly", () => {
    const target = { x: 10, y: 0 };
    const a = approach({ x: 0, y: 0 }, target, 66);
    assert.ok(a.x > 7 && a.x < 10, `${a.x}`);
    let pos = { x: 0, y: 0 };
    let steps = 0;
    for (;;) {
      const next = approach(pos, target, 16);
      pos = next;
      steps++;
      if (next.done) break;
      assert.ok(steps < 60, "settles within a second at 60 fps");
    }
    assert.deepEqual(pos, { x: 10, y: 0, done: true });
  });
});
