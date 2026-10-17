import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { createPreview } from "../features/dm/preview.ts";
import { panelsFor } from "../features/panels.ts";
import { createRoomStore } from "./store.ts";
import {
  crossWide,
  EMPTY_EPHEMERAL,
  INITIAL_LOCAL,
  startBelow,
  twoShow,
  withoutBelow,
  withPanel,
  withSplit,
  withSplitFits,
  withSwap,
  type LocalUi,
  type PanelHow,
  type RoomView,
} from "./types.ts";

/*
 * Two panels in the room's state (docs/design-v1-split-panel.md 5): one
 * rule for which pane a panel opens in, the split's start pair, rule 0 for
 * a phone-only panel, a request that waits for the room's measure, and
 * the preview taking the same results.
 */

const local = (patch: Partial<LocalUi>): LocalUi => ({ ...INITIAL_LOCAL, ...patch });
/** Initiative on top and Log below, the side panel holding both. */
const pair = local({ tab: "tracker", below: "log", splitFits: true, panel: "log" });
const sides = (l: LocalUi) => [l.tab, l.below];

describe("where a panel opens with two showing (5.2)", () => {
  test("a tab, More's pick and a phone's list name the top pane", () => {
    assert.deepEqual(sides(withPanel(pair, "journal", { pane: "top" })), ["journal", "log"], "Journal replaces Initiative");
    assert.deepEqual(sides(withPanel(pair, "log", { pane: "top" })), ["log", "tracker"], "the Log tab swaps the two");
    assert.equal(withPanel(pair, "tracker", { pane: "top" }).tab, "tracker", "the open one stays");
  });

  test("the bar's name names the bottom pane", () => {
    assert.deepEqual(sides(withPanel(pair, "journal", { pane: "below" })), ["tracker", "journal"], "Journal replaces Log");
    assert.deepEqual(sides(withPanel(pair, "tracker", { pane: "below" })), ["log", "tracker"], "Initiative's item swaps the two");
    assert.deepEqual(sides(withPanel(pair, "log", { pane: "below" })), ["tracker", "log"]);
  });

  test("a link from the top pane or from outside the panels opens below, and from the bottom pane on top", () => {
    assert.deepEqual(sides(withPanel(pair, "token", { from: "tracker" })), ["tracker", "token"], "Stat block in a tracker row: Token replaces Log");
    assert.deepEqual(sides(withPanel(pair, "token")), ["tracker", "token"], "Details in the token window");
    assert.deepEqual(sides(withPanel(pair, "outliner")), ["tracker", "outliner"], "/");
    assert.deepEqual(sides(withPanel(pair, "journal")), ["tracker", "journal"], "a pin's page");
    assert.deepEqual(sides(withPanel(pair, "monsters")), ["tracker", "monsters"], "Add token's Monster…");
    assert.deepEqual(sides(withPanel(pair, "areas")), ["tracker", "areas"], "an area's damage page from the map");
    const tokenBelow = local({ tab: "tracker", below: "token", splitFits: true });
    assert.deepEqual(sides(withPanel(tokenBelow, "journal", { from: "token" })), ["journal", "token"], "a link in the bottom pane opens on top");
    assert.deepEqual(sides(withPanel(pair, "journal", { from: "monsters" })), ["tracker", "journal"], "a panel not shown counts as outside");
  });

  test("a link to a panel already open moves nothing", () => {
    assert.deepEqual(sides(withPanel(pair, "tracker")), ["tracker", "log"], "the turn strip with Initiative on top");
    assert.deepEqual(sides(withPanel(pair, "log", { from: "tracker" })), ["tracker", "log"]);
    const areasBelow = local({ tab: "tracker", below: "areas", splitFits: true, panel: "areas" });
    assert.equal(withPanel(areasBelow, "areas", { from: "areas" }), areasBelow, "the Areas panel's damage button: its subpage opens where it is");
  });

  test("every path shows the side panel and names the phone's sheet", () => {
    const hidden = { ...pair, sidePanelHidden: true, sheetHidden: true, panelList: true };
    const next = withPanel(hidden, "journal", { pane: "below" });
    assert.deepEqual([next.sidePanelHidden, next.sheetHidden, next.panelList, next.panel], [false, false, false, "journal"]);
    assert.equal(withPanel(pair, "tracker").panel, "tracker", "a rotation shows the panel opened last");
  });

  test("the same object back when nothing changes", () => {
    const settled = local({ tab: "tracker", below: "log", splitFits: true, panel: "tracker" });
    assert.equal(withPanel(settled, "tracker", { pane: "top" }), settled);
    assert.equal(withPanel(settled, "tracker"), settled);
    assert.equal(withSwap(INITIAL_LOCAL), INITIAL_LOCAL);
    assert.equal(withoutBelow(INITIAL_LOCAL), INITIAL_LOCAL);
    assert.equal(withSplitFits(settled, true), settled);
  });
});

describe("where a panel opens with one showing", () => {
  const short = { ...pair, splitFits: false };
  test("every path puts it on top, as without a split", () => {
    for (const how of [undefined, { pane: "top" }, { pane: "below" }, { from: "tracker" }] as (PanelHow | undefined)[]) {
      assert.deepEqual(sides(withPanel(short, "journal", how)), ["journal", "log"], JSON.stringify(how));
      assert.deepEqual(sides(withPanel(local({ tab: "tracker" }), "journal", how)), ["journal", null], `no split ${JSON.stringify(how)}`);
    }
  });

  test("the kept bottom panel swaps up, so a kept split never holds one panel twice", () => {
    assert.deepEqual(sides(withPanel(short, "log")), ["log", "tracker"]);
    assert.deepEqual(sides(withPanel({ ...pair, splitFits: false }, "log", { pane: "below" })), ["log", "tracker"]);
  });

  test("with one panel, a tracker row's Stat block replaces Initiative, as today", () => {
    assert.deepEqual(sides(withPanel(local({ tab: "tracker", splitFits: true }), "token", { from: "tracker" })), ["token", null]);
  });

  test("on a phone the sheet's panel becomes the top one", () => {
    const phone = { ...pair, splitFits: false };
    const next = withPanel(phone, "journal", { pane: "top" });
    assert.deepEqual([next.panel, next.tab, next.below], ["journal", "journal", "log"]);
  });
});

describe("rule 0: a phone-only panel", () => {
  test("becomes the sheet and leaves the pair alone", () => {
    const next = withPanel({ ...pair, splitFits: false, tab: "journal" }, "party", { pane: "top" }, true);
    assert.deepEqual([next.panel, next.tab, next.below], ["party", "journal", "log"]);
    const one = withPanel(local({ tab: "journal", splitFits: false }), "party", { pane: "top" }, true);
    assert.deepEqual([one.panel, one.tab, one.below], ["party", "journal", null], "with one panel the side panel keeps its tab");
  });

  test("crossing wide draws the pair as it was, and back the sheet shows Party", () => {
    let l = withPanel({ ...pair, splitFits: false, tab: "journal", below: "token" }, "party", { pane: "top" }, true);
    l = withSplitFits(crossWide(l, true), true);
    assert.deepEqual(sides(l), ["journal", "token"], "two different panels, no Party");
    l = withSplitFits(crossWide(l, false), false);
    assert.equal(l.panel, "party");
  });
});

describe("the split opens, closes and swaps", () => {
  test("the start pair: Token below for the DM, Characters for a player, Initiative when that panel is on top", () => {
    assert.deepEqual(sides(withSplit(local({ tab: "tracker" }), "dm")), ["tracker", "token"]);
    assert.deepEqual(sides(withSplit(local({ tab: "tracker" }), "player")), ["tracker", "characters"]);
    assert.deepEqual(sides(withSplit(local({ tab: "token" }), "dm")), ["token", "tracker"]);
    assert.deepEqual(sides(withSplit(local({ tab: "characters" }), "player")), ["characters", "tracker"]);
    assert.deepEqual(sides(withSplit(local({ tab: "journal" }), "dm")), ["journal", "token"]);
    assert.equal(startBelow("token", "player"), "characters", "a player's Token on top starts Characters below");
    const open = local({ tab: "tracker", below: "log" });
    assert.equal(withSplit(open, "dm"), open, "an open split stays as it is");
  });

  test("a stored pair sets both, and one naming a panel twice changes nothing", () => {
    assert.deepEqual(sides(withSplit(INITIAL_LOCAL, "dm", { top: "log", below: "journal" })), ["log", "journal"]);
    assert.equal(withSplit(INITIAL_LOCAL, "dm", { top: "log", below: "log" }), INITIAL_LOCAL);
  });

  test("closing the bottom panel moves the phone's sheet to the top one when it named the bottom", () => {
    assert.deepEqual([withoutBelow(pair).below, withoutBelow(pair).panel], [null, "tracker"]);
    const named = { ...pair, panel: "journal" };
    assert.equal(withoutBelow(named).panel, "journal");
  });

  test("a swap changes places and keeps the phone's sheet", () => {
    const next = withSwap(pair);
    assert.deepEqual([next.tab, next.below, next.panel], ["log", "tracker", "log"]);
  });

  test("two show only with a split kept and room for both", () => {
    assert.equal(twoShow(pair), true);
    assert.equal(twoShow({ ...pair, splitFits: false }), false);
    assert.equal(twoShow({ ...pair, splitFits: null }), false);
    assert.equal(twoShow(local({ splitFits: true })), false);
  });
});

describe("a request while the room is unknown (5.1)", () => {
  const hidden = { ...pair, splitFits: null, sidePanelHidden: true };
  test("shows the side panel and waits, and a later request replaces it", () => {
    const waiting = withPanel(hidden, "token");
    assert.deepEqual([waiting.sidePanelHidden, waiting.pendingOpen, waiting.tab, waiting.below], [false, { id: "token" }, "tracker", "log"]);
    assert.deepEqual(withPanel(waiting, "journal", { pane: "top" }).pendingOpen, { id: "journal", how: { pane: "top" } });
  });

  test("the measure places it by the rules, in the same change", () => {
    const waiting = withPanel(hidden, "token");
    const tall = withSplitFits(waiting, true);
    assert.deepEqual([tall.tab, tall.below, tall.pendingOpen, tall.panel, tall.splitFits], ["tracker", "token", null, "token", true], "two fit: below");
    const short = withSplitFits(waiting, false);
    assert.deepEqual([short.tab, short.below, short.pendingOpen], ["token", "log", null], "too short for two: on top, in sight");
    assert.equal(withSplitFits(waiting, null), waiting, "still unknown: it keeps waiting");
  });

  test("closing the split places a waiting request at once, since the room no longer decides", () => {
    const closed = withoutBelow(withPanel(hidden, "token"));
    assert.deepEqual([closed.tab, closed.below, closed.pendingOpen, closed.panel], ["token", null, null, "token"]);
  });

  test("with no split kept the room does not matter, and the panel opens at once", () => {
    const next = withPanel(local({ tab: "tracker", splitFits: null, sidePanelHidden: true }), "token");
    assert.deepEqual([next.tab, next.pendingOpen, next.sidePanelHidden], ["token", null, false]);
  });
});

describe("the store and the preview", () => {
  test("the store's actions take the same results", () => {
    const room = createRoomStore({ roomId: "R", you: { memberId: "dm1", role: "dm" } });
    const state = () => room.store.getState().local;
    room.ui.fitSplit(true);
    room.ui.splitPanels(true);
    assert.deepEqual(sides(state()), ["tracker", "token"]);
    room.ui.openPanel("journal");
    assert.deepEqual(sides(state()), ["tracker", "journal"]);
    room.ui.swapPanels();
    assert.deepEqual(sides(state()), ["journal", "tracker"]);
    room.ui.openPanel("party", { pane: "top" });
    assert.deepEqual([state().panel, ...sides(state())], ["party", "journal", "tracker"], "the registry's phone-only Party keeps out of the pair");
    room.ui.splitPanels(false);
    assert.deepEqual(sides(state()), ["journal", null]);
    room.dispose();
  });

  test("the preview's copy takes the same results, starting on a player's panels", () => {
    const src = createStore<RoomView>()(() => ({
      roomId: "R",
      you: { memberId: "dm1", role: "dm" },
      view: null,
      sceneId: null,
      connection: "open",
      online: [],
      accessVersion: 0,
      ephemeral: EMPTY_EPHEMERAL,
      busy: {},
      toasts: [],
      ended: null,
      local: INITIAL_LOCAL,
      pending: [],
    }));
    const preview = createPreview(src, "p1");
    const state = () => preview.store.getState().local;
    preview.ui.fitSplit(true);
    preview.ui.splitPanels(true);
    assert.deepEqual(sides(state()), ["tracker", "characters"]);
    preview.ui.openPanel("token", { from: "tracker" });
    assert.deepEqual(sides(state()), ["tracker", "token"]);
    preview.ui.swapPanels();
    assert.deepEqual(sides(state()), ["token", "tracker"]);
    assert.equal(src.getState().local, INITIAL_LOCAL, "the DM's own room never changes");
    preview.dispose();
  });
});

/*
 * Many random sequences of every change the panels take, checking what
 * must always hold:
 * - never one panel in both panes,
 * - the phone's sheet names the top panel, the bottom one, a phone-only
 *   panel or none,
 * - the pair never holds a phone-only panel,
 * - a request waits only while a split is kept and the room is unknown,
 *   and the measure always places it,
 * - with two showing, the panel last opened is on screen in one of them.
 */
describe("the panels' state under random sequences", () => {
  test("its invariants hold after every step", () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    for (const role of ["dm", "player"] as const) {
      const wide = panelsFor(role, true).map((p) => p.id);
      const phoneOnly = panelsFor(role, false).filter((p) => p.narrowOnly).map((p) => p.id);
      const ids = [...wide, ...phoneOnly];
      const hows: (PanelHow | undefined)[] = [undefined, { pane: "top" }, { pane: "below" }, ...wide.map((from) => ({ from }))];
      for (let run = 0; run < 400; run++) {
        let l: LocalUi = INITIAL_LOCAL;
        const steps: string[] = [];
        for (let step = 0; step < 40; step++) {
          const kind = pick(["open", "open", "open", "split", "close", "swap", "fits", "hide", "cross"] as const);
          let opened: string | null = null;
          if (kind === "open") {
            const id = pick(ids);
            const how = pick(hows);
            l = withPanel(l, id, how, phoneOnly.includes(id));
            opened = id;
            steps.push(`open ${id} ${JSON.stringify(how)}`);
          } else if (kind === "split") {
            l = withSplit(l, role);
            steps.push("split");
          } else if (kind === "close") {
            l = withoutBelow(l);
            steps.push("close");
          } else if (kind === "swap") {
            l = withSwap(l);
            steps.push("swap");
          } else if (kind === "fits") {
            const fits = pick([true, false, null] as const);
            l = withSplitFits(l, fits);
            steps.push(`fits ${fits}`);
          } else if (kind === "hide") {
            l = { ...l, sidePanelHidden: !l.sidePanelHidden };
            steps.push("hide");
          } else {
            const toWide = random() < 0.5;
            l = crossWide(l, toWide);
            steps.push(`cross ${toWide}`);
          }
          const at = `${role}: ${steps.join(", ")}`;
          assert.notEqual(l.tab, l.below, `one panel twice after ${at}`);
          assert.ok(l.panel === null || l.panel === l.tab || l.panel === l.below || phoneOnly.includes(l.panel), `the sheet names ${l.panel} after ${at}`);
          assert.ok(!phoneOnly.includes(l.tab) && (l.below === null || !phoneOnly.includes(l.below)), `a phone-only panel in the pair after ${at}`);
          if (l.pendingOpen !== null) assert.ok(l.below !== null && l.splitFits === null, `a request waits with the room known after ${at}`);
          if (opened !== null && !phoneOnly.includes(opened) && twoShow(l)) assert.ok(l.tab === opened || l.below === opened, `${opened} is not on screen after ${at}`);
          for (const fits of [true, false] as const) assert.equal(withSplitFits(l, fits).pendingOpen, null, `the measure places a waiting request after ${at}`);
        }
      }
    }
  });
});
