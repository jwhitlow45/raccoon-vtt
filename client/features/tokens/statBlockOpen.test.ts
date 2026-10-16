import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barDockSlot } from "../../canvas/barDock.ts";
import { dockSlot } from "../../pages/fold.ts";
import { RoomScope } from "../../state/scope.ts";
import { openStatBlock, statBlockHidesBar, statBlockRequest } from "./statBlockOpen.ts";

/** What openStatBlock asks of the room's UI, recorded in order. */
function recorder() {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      select: (id: string | null) => calls.push(`select ${id}`),
      showActions: (open: boolean) => calls.push(`showActions ${open}`),
      openPanel: (id: string) => calls.push(`openPanel ${id}`),
    },
  };
}

describe("openStatBlock", () => {
  test("selects the token, asks for its block with focus, and opens the token panel", () => {
    const scope = new RoomScope();
    const { calls, ui } = recorder();
    openStatBlock(scope, ui, "g1", { width: 1280, height: 800 });
    assert.deepEqual(calls, ["select g1", "openPanel token"]);
    const request = scope.get(statBlockRequest).getState();
    assert.equal(request.tokenId, "g1");
    assert.equal(request.focus, true);
  });

  test("each press is a new request, so a second press scrolls and focuses the block again", () => {
    const scope = new RoomScope();
    const { ui } = recorder();
    openStatBlock(scope, ui, "g1", { width: 1280, height: 800 });
    const first = scope.get(statBlockRequest).getState().seq;
    openStatBlock(scope, ui, "g1", { width: 1280, height: 800 });
    assert.ok(scope.get(statBlockRequest).getState().seq > first);
  });

  test("hides the bar where it folds under the sheet, and leaves it where it stands beside the panel", () => {
    const at = (width: number, height: number, safeLeft = 0) => {
      const scope = new RoomScope();
      const dock = scope.get(barDockSlot);
      dock.setState({ chrome: { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: { top: 0, right: safeLeft, bottom: 0, left: safeLeft }, sheet: 0, rail: 0 } });
      const { calls, ui } = recorder();
      openStatBlock(scope, ui, "g1", { width, height });
      return calls.includes("showActions false");
    };
    assert.equal(at(390, 844), true, "a phone held upright");
    assert.equal(at(820, 1180), true, "a tablet held upright");
    assert.equal(at(513, 288), true, "667 x 375 at 130%: 189 px beside the sheet");
    assert.equal(at(844, 390, 47), false, "a phone held sideways: 441 px beside the sheet");
    assert.equal(at(649, 300, 47), false, "844 x 390 at 130% without the band: 246 px");
    assert.equal(at(1280, 800), false, "the side panel");
  });

  test("hides the bar where Room says a sheet would open over the whole screen, and only there", () => {
    const at = (sheetFullMode: boolean) => {
      const scope = new RoomScope();
      scope.get(barDockSlot).setState({ chrome: { top: 100, bottom: 81, controls: 81, toolbar: 81, safe: { top: 0, right: 47, bottom: 21, left: 47 }, sheet: 0, rail: 0 } });
      scope.get(dockSlot).setState({ sheetFullMode });
      const { calls, ui } = recorder();
      openStatBlock(scope, ui, "g1", { width: 649, height: 300 });
      return calls.includes("showActions false");
    };
    assert.equal(at(true), true, "844 x 390 at 130% with the turn band: the very short mode");
    assert.equal(at(false), false, "the same size without the band keeps the bar beside the right sheet");
  });
});

describe("statBlockHidesBar", () => {
  test("the portrait layouts and the very short mode fold the bar", () => {
    assert.equal(statBlockHidesBar({ width: 390, height: 844, safeLeft: 0 }), true);
    assert.equal(statBlockHidesBar({ width: 820, height: 1180, safeLeft: 0 }), true);
    assert.equal(statBlockHidesBar({ width: 369, height: 246, safeLeft: 47, veryShort: true }), true, "480 x 320 at 130%");
    assert.equal(statBlockHidesBar({ width: 649, height: 300, safeLeft: 47, veryShort: true }), true, "844 x 390 at 130% with the turn band");
  });

  test("a side sheet that leaves under 230 px beside it hides the bar, 230 and more keeps it", () => {
    assert.equal(statBlockHidesBar({ width: 513, height: 288, safeLeft: 0 }), true);
    assert.equal(statBlockHidesBar({ width: 369, height: 246, safeLeft: 47 }), true);
    assert.equal(statBlockHidesBar({ width: 649, height: 300, safeLeft: 47 }), false);
    assert.equal(statBlockHidesBar({ width: 844, height: 390, safeLeft: 47 }), false);
    // 340 + 230 + 16 = 586: the narrowest sideways layout that keeps the bar with no inset.
    assert.equal(statBlockHidesBar({ width: 586, height: 300, safeLeft: 0 }), false);
    assert.equal(statBlockHidesBar({ width: 585, height: 300, safeLeft: 0 }), true);
  });

  test("from 900 px up the bar always stays", () => {
    for (const [width, height] of [[1280, 800], [932, 430], [985, 615], [1180, 820]] as const) {
      assert.equal(statBlockHidesBar({ width, height, safeLeft: 59 }), false, `${width} x ${height}`);
    }
  });
});
