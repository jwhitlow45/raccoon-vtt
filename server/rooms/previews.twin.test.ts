import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { PREVIEW_STALE_MS } from "./ephemeral.ts";
import { previewRoom, previewTwin, VAULT, type PreviewFixture } from "./previewsTesting.ts";

/*
 * Held previews are judged again after every batch while a screen holds
 * one, and a frame past PREVIEW_STALE_MS is dead by the clock alone
 * (docs/design/design-v1-per-player-vision.md 7.2). Bree is sent the same
 * frames of P1's drag in twins apart only in the DM's work on a scene no
 * player holds.
 */

/** The DM's changes to the vault that re-project every screen, each from the vault as `setup` leaves it. */
const VAULT_CHANGES: { field: string; setup: (f: PreviewFixture) => void; op: Op }[] = [
  { field: "fog", setup: () => undefined, op: { t: "scene.update", sceneId: VAULT, patch: { fogEnabled: true } } as Op },
  { field: "vision", setup: () => undefined, op: { t: "scene.update", sceneId: VAULT, patch: { vision: { on: true, light: "bright" }, fogEnabled: false } } as Op },
  { field: "light", setup: (f) => void (f.state.scenes[VAULT]!.vision = { on: true, light: "bright" }), op: { t: "scene.update", sceneId: VAULT, patch: { vision: { on: true, light: "dark" } } } as Op },
  { field: "per-player sight", setup: (f) => void (f.state.scenes[VAULT]!.vision = { on: true, light: "bright" }), op: { t: "scene.update", sceneId: VAULT, patch: { vision: { on: true, light: "bright", perPlayer: true } } } as Op },
];

describe("a held preview is judged again after every batch (D-261121-068)", () => {
  for (const change of VAULT_CHANGES) {
    test(`P1 drags, the DM locks the creature, and in one twin changes the vault's ${change.field}: Bree's cancel comes in the lock's batch in both`, async (t) => {
      const f = previewRoom();
      change.setup(f);
      const got: unknown[][][] = [];
      for (const hidden of [true, false]) {
        const twin = await previewTwin(t, f);
        twin.frame({ k: "dragStart", tokenId: f.pc, x: 8, y: 3 });
        const marks = [twin.seen().bree];
        await twin.dmOp({ t: "token.update", tokenId: f.pc, patch: { locked: true } } as Op);
        marks.push(twin.seen().bree);
        if (hidden) await twin.dmOp(change.op);
        marks.push(twin.seen().bree);
        got.push(marks);
      }
      assert.deepEqual(got[0], got[1]);
      assert.deepEqual(got[0]![1], [{ k: "dragStart", tokenId: f.pc, x: 8, y: 3 }, { k: "dragCancel", tokenId: f.pc }], "the lock's batch ends the drag");
    });
  }

  test("a drag gone stale, a batch on the vault in one twin, then the drag's next frame: dragCancel, dragMove in both, and nothing at the batch", async (t) => {
    const f = previewRoom();
    const got: unknown[][][] = [];
    for (const hidden of [true, false]) {
      const twin = await previewTwin(t, f);
      twin.frame({ k: "dragStart", tokenId: f.pc, x: 8, y: 3 });
      twin.clock.now += PREVIEW_STALE_MS + 1;
      if (hidden) await twin.dmOp(VAULT_CHANGES[0]!.op);
      const marks = [twin.seen().bree];
      twin.frame({ k: "dragMove", tokenId: f.pc, x: 9, y: 3 });
      marks.push(twin.seen().bree);
      got.push(marks);
    }
    assert.deepEqual(got[0], got[1]);
    assert.deepEqual(got[0]![1]!.slice(1), [{ k: "dragCancel", tokenId: f.pc }, { k: "dragMove", tokenId: f.pc, x: 9, y: 3 }]);
  });

  for (const [what, op] of [
    ["locks", { t: "token.update", tokenId: "", patch: { locked: true } }],
    ["hides", { t: "token.update", tokenId: "", patch: { visibility: "dm" } }],
  ] as const) {
    test(`a stale drag is neither judged nor forgotten at a batch: the DM ${what} the creature, and Bree's cancel waits for P1's next frame`, async (t) => {
      const f = previewRoom();
      const twin = await previewTwin(t, f);
      twin.frame({ k: "dragStart", tokenId: f.pc, x: 8, y: 3 });
      twin.clock.now += PREVIEW_STALE_MS;
      await twin.dmOp({ ...op, tokenId: f.pc } as Op);
      assert.deepEqual(twin.seen().bree.filter((e) => (e as { k: string }).k === "dragCancel"), [], "nothing at the batch");
      assert.ok(twin.bree.conn.previewsHeld.size > 0 && twin.p1.conn.previewsSent.size > 0, "both sides still hold it");
      twin.frame({ k: "ruler", id: "next", points: [{ x: 2.5, y: 2.5 }] });
      assert.deepEqual(twin.seen().bree.filter((e) => (e as { k: string }).k === "dragCancel"), [{ k: "dragCancel", tokenId: f.pc }]);
    });
  }
});
