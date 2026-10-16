import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitTabs, MORE_CAP, moreReserve, nameCut, rowWidth, type TabWidths } from "./tabFit.ts";

/*
 * The side panel's one row of tabs (docs/design-v1-panel-tabs.md 3.2).
 * The fixtures are the widths measured in Chrome, 14 px at weight 600 in
 * the tab look with 6 px side padding, and in More's look with its caret,
 * for macOS's system font, Segoe UI (through Selawik, built to its
 * metrics) and DejaVu Sans, as section 3.2 quotes them.
 */

type Font = { tab: Record<string, number>; more: Record<string, number> };

const MACOS: Font = {
  tab: { Token: 54.2, Initiative: 71.9, Log: 44, Journal: 64.6, Areas: 53, DM: 44, Scenes: 63.3, Monsters: 77.3, Encounters: 90.6, Characters: 88.7, Outliner: 68.3, Library: 61.8, Menu: 51.4 },
  more: { Token: 72.2, Initiative: 89.9, Log: 56.8, Journal: 82.6, Areas: 71, DM: 54.6, Scenes: 81.3, Monsters: 95.3, Encounters: 108.6, Characters: 106.7, Outliner: 86.3, Library: 79.8, Menu: 69.4, More: 66.4 },
};
const SEGOE: Font = {
  tab: { Token: 53.7, Initiative: 70.4, Log: 44, Journal: 61.4, Areas: 49.9, DM: 44, Scenes: 57.7, Monsters: 74.1, Encounters: 85.4, Characters: 81.9, Outliner: 66.8, Library: 58.6, Menu: 51.2 },
  more: { Token: 71.7, Initiative: 88.4, Log: 55.9, Journal: 79.4, Areas: 67.9, DM: 55.3, Scenes: 75.7, Monsters: 92.1, Encounters: 103.4, Characters: 99.9, Outliner: 84.8, Library: 76.6, Menu: 69.2, More: 66.4 },
};
const DEJAVU: Font = {
  tab: { Token: 59.7, Initiative: 85, Log: 44, Journal: 69.9, Areas: 59, DM: 44, Scenes: 69.7, Monsters: 87.3, Encounters: 102.8, Characters: 99.8, Outliner: 78.5, Library: 70.1, Menu: 57.4 },
  more: { Token: 77.7, Initiative: 103, Log: 60.6, Journal: 87.9, Areas: 77, DM: 57.6, Scenes: 87.7, Monsters: 105.3, Encounters: 120.8, Characters: 117.8, Outliner: 96.5, Library: 88.1, Menu: 75.4, More: 72 },
};
/** DejaVu Sans with today's 8 px padding, which 3.4 replaces. */
const DEJAVU_8: Font = {
  tab: { Token: 63.7, Initiative: 89, Log: 46.6, Journal: 73.9, Areas: 63, DM: 44, Scenes: 73.7, Monsters: 91.3, Encounters: 106.8, Characters: 103.8, Outliner: 82.5, Library: 74.1, Menu: 61.4 },
  more: { Token: 81.7, Initiative: 107, Log: 64.6, Journal: 91.9, Areas: 81, DM: 61.6, Scenes: 91.7, Monsters: 109.3, Encounters: 124.8, Characters: 121.8, Outliner: 100.5, Library: 92.1, Menu: 79.4, More: 76 },
};

const DM = [
  ["Token", "play"],
  ["Initiative", "play"],
  ["Log", "play"],
  ["Journal", "play"],
  ["Areas", "play"],
  ["DM", "play"],
  ["Scenes", "play"],
  ["Monsters", "prepare"],
  ["Encounters", "prepare"],
  ["Characters", "prepare"],
  ["Outliner", "prepare"],
  ["Library", "prepare"],
  ["Menu", "room"],
] as const;
const PLAYER = DM.filter(([t]) => !["DM", "Scenes", "Monsters", "Encounters", "Outliner"].includes(t));

function widths(font: Font, panels: readonly (readonly [string, string])[], room: number): TabWidths {
  return { tabs: panels.map(([t, group]) => ({ rest: font.tab[t]!, more: font.more[t]!, group })), moreRest: font.more.More!, room };
}

const round = (n: number) => Math.round(n * 10) / 10;

describe("which tabs stand in the row", () => {
  test("all of them when they fit with their gaps, and no More", () => {
    const fit = fitTabs(widths(MACOS, PLAYER, 600));
    assert.deepEqual(fit, { count: PLAYER.length, moreRoom: 0 });
  });

  test("otherwise a prefix with More after it", () => {
    assert.deepEqual(fitTabs(widths(MACOS, DM, 300))?.count, 3);
  });

  test("More's reserve is its widest name among the panels it would hold, up to the cap, so a name past the cap never costs a tab", () => {
    const short = { tabs: [{ rest: 50, more: 60, group: "a" }, { rest: 50, more: 70, group: "a" }, { rest: 50, more: 75, group: "a" }], moreRest: 66, room: 0 };
    assert.equal(moreReserve(short, 1), 75);
    assert.equal(moreReserve(short, 2), 75);
    assert.equal(moreReserve({ ...short, tabs: [short.tabs[0]!, { rest: 50, more: 64, group: "a" }] }, 1), 66, "never under More's own label");
    const long = { ...short, tabs: [...short.tabs, { rest: 50, more: 300, group: "a" }] };
    assert.equal(moreReserve(long, 1), MORE_CAP);
    // 50 + 2 + 92 fits 144, while the long name's own width would have cost the tab.
    assert.deepEqual(fitTabs({ ...long, room: 144 }), { count: 1, moreRoom: 92 });
  });

  test("a group's 8 px gap counts only between tabs in the row, and More follows at the row's 2 px", () => {
    const tabs = [
      { rest: 50, more: 60, group: "a" },
      { rest: 50, more: 60, group: "b" },
      { rest: 50, more: 60, group: "b" },
    ];
    assert.equal(rowWidth(tabs, 2), 50 + 8 + 50);
    assert.equal(rowWidth(tabs, 3), 50 + 8 + 50 + 2 + 50);
    // One tab and More: 50 + 2 + 66, with no group gap though the next tab opens a group.
    assert.deepEqual(fitTabs({ tabs, moreRest: 66, room: 118 }), { count: 1, moreRoom: 66 });
  });

  test("More stands alone when no tab leaves it room, and a room of 0 gives no fit", () => {
    assert.deepEqual(fitTabs(widths(MACOS, DM, 100)), { count: 0, moreRoom: 100 });
    assert.equal(fitTabs(widths(MACOS, DM, 0)), null, "a hidden side panel");
  });

  test("More's room is never under its reserve, and a wider room never fits fewer tabs", () => {
    for (const font of [MACOS, SEGOE, DEJAVU]) {
      for (const panels of [DM, PLAYER]) {
        let last = 0;
        for (let room = 1; room <= 600; room++) {
          const w = widths(font, panels, room);
          const fit = fitTabs(w)!;
          assert.ok(fit.count >= last, `fewer tabs at ${room}`);
          last = fit.count;
          if (fit.count < panels.length) assert.ok(fit.moreRoom >= moreReserve(w, fit.count) - 1e-9, `More's room at ${room}`);
        }
      }
    }
  });

  test("with today's registry, More never holds exactly one panel: Menu, last, is narrower than More's label", () => {
    for (const font of [MACOS, SEGOE, DEJAVU, DEJAVU_8]) {
      for (const panels of [DM, PLAYER]) {
        for (let room = 1; room <= 600; room++) assert.notEqual(fitTabs(widths(font, panels, room))!.count, panels.length - 1, `at ${room}`);
      }
    }
  });
});

describe("the measured fonts (3.2)", () => {
  const cutAt = (font: Font, panels: readonly (readonly [string, string])[], room: number) => {
    const w = widths(font, panels, room);
    const fit = fitTabs(w)!;
    return panels.flatMap(([t], i) => (nameCut(fit, w, i) ? [t] : []));
  };

  test("at 295 every font holds Token, Initiative and Log, for the DM and for players", () => {
    for (const [font, room] of [
      [MACOS, 118.9],
      [SEGOE, 120.9],
      [DEJAVU, 100.3],
    ] as const) {
      for (const panels of [DM, PLAYER]) {
        const fit = fitTabs(widths(font, panels, 295))!;
        assert.equal(fit.count, 3);
        assert.equal(round(fit.moreRoom), room);
      }
    }
  });

  test("DejaVu Sans cuts exactly Monsters, Encounters and Characters, and the other two cut none", () => {
    assert.deepEqual(cutAt(DEJAVU, DM, 295), ["Monsters", "Encounters", "Characters"]);
    assert.deepEqual(cutAt(DEJAVU, PLAYER, 295), ["Characters"], "a player's More holds only Characters of these");
    assert.deepEqual(cutAt(MACOS, DM, 295), []);
    assert.deepEqual(cutAt(SEGOE, DM, 295), []);
  });

  test("with macOS's widths, 248 and 236 give two tabs, and at 236 exactly Encounters and Characters are cut", () => {
    assert.equal(fitTabs(widths(MACOS, DM, 248))!.count, 2);
    assert.equal(fitTabs(widths(MACOS, DM, 236))!.count, 2);
    assert.deepEqual(cutAt(MACOS, DM, 248), []);
    assert.deepEqual(cutAt(MACOS, DM, 236), ["Encounters", "Characters"]);
  });

  test("with 8 px padding, DejaVu Sans gives two tabs at 295: why the tabs take 6 (3.4)", () => {
    assert.equal(fitTabs(widths(DEJAVU_8, DM, 295))!.count, 2);
  });

  test("a name is cut only for a panel in More", () => {
    const w = widths(DEJAVU, DM, 295);
    const fit = fitTabs(w)!;
    assert.equal(nameCut(fit, w, 1), false, "Initiative, in the row, wider than More's room");
    assert.equal(nameCut(fit, w, 7), true, "Monsters");
    assert.equal(nameCut(fit, w, 99), false);
  });
});
