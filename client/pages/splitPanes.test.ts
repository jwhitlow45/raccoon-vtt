import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BAR_PX,
  dragTop,
  gripStep,
  INITIATIVE_STUCK,
  NO_SPLIT,
  PANE_MIN,
  parseSplit,
  readSplit,
  roomForTwo,
  sameSplit,
  ScrollKeep,
  separatorValue,
  shareOf,
  SPLIT_KEY,
  SPLIT_ROOM,
  splitPanes,
  swapFocus,
  writeSplit,
  type FocusNode,
} from "./splitPanes.ts";

/* The side panel's two panes (docs/design-v1-split-panel.md 3.2, 3.4, 4.3 and 8). */

describe("room for two", () => {
  test("from exactly 311 own px: two pane minimums and the bar, each counting a 45 px header row", () => {
    assert.equal(PANE_MIN, 133, "a compact subpage header with its rule and the very short sheet's 88 px body");
    assert.equal(BAR_PX, 45, "a header row, as the tab row is (docs/design-v1-side-headers.md 5)");
    assert.equal(SPLIT_ROOM, 311);
    assert.equal(roomForTwo(311), true);
    assert.equal(roomForTwo(310), false);
    assert.equal(roomForTwo(319), true, "a large phone sideways with a home bar inset, the DM");
    assert.equal(roomForTwo(264), false, "the same before the compact headers");
  });
});

describe("the panes' sizes", () => {
  const sizes = (room: number, share: number | null = null, initiative: "top" | "below" | null = null) => {
    const s = splitPanes({ room, share, initiative });
    return [s.top, s.below];
  };

  test("with no share stored, even", () => {
    assert.deepEqual(sizes(710), [332, 333], "1280 x 800, the DM");
    assert.deepEqual(sizes(755), [355, 355], "1280 x 800, a player");
    assert.deepEqual(sizes(525), [240, 240], "1280 x 800 at 130%, the DM");
    assert.deepEqual(sizes(442), [198, 199], "1366 x 768 at 130%");
    assert.deepEqual(sizes(385), [170, 170], "932 x 430, a player");
  });

  test("a pane holding Initiative takes what keeps its round header stuck, as far as the other keeps its minimum", () => {
    assert.equal(INITIATIVE_STUCK, 193);
    assert.deepEqual(sizes(400, null, "top"), [193, 162], "a room of 400");
    assert.deepEqual(sizes(400, null, "below"), [162, 193], "in either pane");
    assert.deepEqual(sizes(360, null, "top"), [182, 133], "a room of 360: too little for 193");
    assert.deepEqual(sizes(360, null, "below"), [133, 182]);
    assert.deepEqual(sizes(385, null, "top"), [193, 147], "932 x 430, a player");
    assert.deepEqual(sizes(710, null, "top"), [332, 333], "an even split already holds it");
  });

  test("a stored share always wins, clamped where it is drawn at both minimums", () => {
    assert.deepEqual(sizes(710, 620, "below"), [412, 253]);
    assert.deepEqual(sizes(710, 100), [133, 532], "clamped at the top's minimum");
    assert.deepEqual(sizes(710, 950), [532, 133], "clamped at the bottom's minimum");
    assert.deepEqual(sizes(390, 500, "top"), [173, 172], "a share below 193 lets Initiative's header scroll");
  });

  test("a stored share stays as it was while clamped, so a taller room draws it again", () => {
    const share = shareOf(500, 800);
    assert.equal(splitPanes({ room: 390, share, initiative: null }).top, 212, "clamped in a short room");
    assert.equal(splitPanes({ room: 800, share, initiative: null }).top, 500, "back where it was");
  });

  test("a share round-trips to the same top pane, kept from 1 to 999", () => {
    for (const room of [574, 739, 854, 1019]) {
      for (const top of [145, 200, 263, 300]) assert.equal(splitPanes({ room, share: shareOf(top, room), initiative: null }).top, top, `${room} ${top}`);
    }
    assert.equal(shareOf(0, 574), 1);
    assert.equal(shareOf(9999, 574), 999);
  });

  test("the separator's percent of the room less the bar, with the clamps as its limits", () => {
    assert.deepEqual(separatorValue(splitPanes({ room: 710, share: null, initiative: null })), { now: 50, min: 20, max: 80 });
  });
});

describe("moving the bar", () => {
  test("Up and Down step 8 px, or 64 with Shift, and no other key", () => {
    assert.equal(gripStep("ArrowUp", false), -8);
    assert.equal(gripStep("ArrowDown", false), 8);
    assert.equal(gripStep("ArrowUp", true), -64);
    assert.equal(gripStep("ArrowDown", true), 64);
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp"]) assert.equal(gripStep(key, false), null, key);
  });

  test("a key step is clamped as it is stored", () => {
    const s = splitPanes({ room: 574, share: null, initiative: null });
    const stepped = (dy: number) => splitPanes({ room: 574, share: shareOf(Math.min(s.max, Math.max(s.min, s.top + dy)), 574), initiative: null }).top;
    assert.equal(stepped(-8), 256);
    assert.equal(stepped(-64), 200);
    assert.equal(stepped(-640), 133);
    assert.equal(stepped(640), 396);
  });

  test("a drag under the slop changes nothing, and past it follows the pointer, clamped", () => {
    const limits = { min: 145, max: 383 };
    assert.equal(dragTop(limits, 264, 6, false), null, "a 6 px wobble");
    assert.equal(dragTop(limits, 264, -8, false), null, "exactly the slop");
    assert.equal(dragTop(limits, 264, 100, false), 364);
    assert.equal(dragTop(limits, 264, 4, true), 268, "once moving, small steps follow");
    assert.equal(dragTop(limits, 264, 400, true), 383);
    assert.equal(dragTop(limits, 264, -400, true), 145);
  });
});

describe("focus after a swap", () => {
  const node = (connected = true): FocusNode => ({ isConnected: connected });
  const page = node();
  const swapButton = node();
  const composer = node();
  const outside = node();
  const room = { contains: (n: FocusNode | null) => n === swapButton || n === composer };

  test("gives back the element read before the swap only when it was in the room and lost focus", () => {
    assert.equal(swapFocus(swapButton, page, room, page), swapButton, "Enter on Swap: focus is back on Swap");
    assert.equal(swapFocus(swapButton, swapButton, room, page), null, "the move left it alone");
  });

  test("nothing when focus was on the page or outside the room, so a press in Safari leaves it on the page", () => {
    assert.equal(swapFocus(page, page, room, page), null, "on the page before: stays there");
    assert.equal(swapFocus(null, page, room, page), null);
    assert.equal(swapFocus(outside, page, room, page), null, "a tab outside the room");
    assert.equal(swapFocus(node(false), page, { contains: () => true }, page), null, "an element gone from the page");
  });
});

describe("what this device remembers", () => {
  const has = (id: string) => ["token", "tracker", "log", "journal"].includes(id);
  const raw = (value: unknown) => JSON.stringify(value);

  test("an entry per role: the share and the split", () => {
    const stored = raw({ dm: { share: 620, top: "tracker", below: "token" }, player: { share: 500 } });
    assert.deepEqual(parseSplit(stored, "dm", has), { share: 620, pair: { top: "tracker", below: "token" } });
    assert.deepEqual(parseSplit(stored, "player", has), { share: 500, pair: null });
  });

  test("each bad value of section 8", () => {
    assert.deepEqual(parseSplit(null, "dm", has), NO_SPLIT, "no key");
    assert.deepEqual(parseSplit("{not json", "dm", has), NO_SPLIT, "not JSON");
    assert.deepEqual(parseSplit(raw([1, 2]), "dm", has), NO_SPLIT, "not an object");
    assert.deepEqual(parseSplit(raw({ dm: "tracker" }), "dm", has), NO_SPLIT, "an entry that is no object");
    for (const share of [0, 1000, 12.5, "500", -3, null]) assert.equal(parseSplit(raw({ dm: { share } }), "dm", has).share, null, `share ${String(share)}`);
    assert.equal(parseSplit(raw({ dm: { share: 1 } }), "dm", has).share, 1);
    assert.equal(parseSplit(raw({ dm: { share: 999 } }), "dm", has).share, 999);
    const pairOf = (entry: unknown) => parseSplit(raw({ dm: entry }), "dm", has);
    assert.deepEqual(pairOf({ share: 300, top: "tracker" }), { share: 300, pair: null }, "top without below: no split, the share kept");
    assert.deepEqual(pairOf({ share: 300, top: "log", below: "log" }), { share: 300, pair: null }, "a top equal to its bottom");
    assert.deepEqual(pairOf({ share: 300, top: "tracker", below: "party" }), { share: 300, pair: null }, "a panel the role does not have from 900 px up");
    assert.deepEqual(pairOf({ top: 3, below: "log" }), NO_SPLIT);
  });

  test("written per role, keeping the other role's entry, and never by the preview", () => {
    let value: string | null = raw({ player: { share: 400, top: "log", below: "journal" } });
    const storage = { getItem: () => value, setItem: (_k: string, v: string) => void (value = v) };
    writeSplit("dm", { share: 620, pair: { top: "tracker", below: "token" } }, { preview: false, storage });
    assert.deepEqual(JSON.parse(value!), { player: { share: 400, top: "log", below: "journal" }, dm: { share: 620, top: "tracker", below: "token" } });
    writeSplit("dm", { share: 620, pair: null }, { preview: false, storage });
    assert.deepEqual(JSON.parse(value!).dm, { share: 620 }, "closed: the share stays for the next split");
    const before = value;
    writeSplit("player", { share: 1, pair: null }, { preview: true, storage });
    assert.equal(value, before, "the preview writes nothing");
    value = "garbage";
    writeSplit("player", { share: 500, pair: null }, { preview: false, storage });
    assert.deepEqual(JSON.parse(value!), { player: { share: 500 } }, "a bad key is written afresh");
    assert.equal(readSplit("player", has, storage).share, 500);
    assert.equal(SPLIT_KEY, "rvtt.sidePanelSplit");
  });

  test("storage that throws reads as none and drops the write", () => {
    const throwing = {
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readSplit("dm", has, throwing), NO_SPLIT);
    assert.doesNotThrow(() => writeSplit("dm", { share: 3, pair: null }, { preview: false, storage: throwing }));
  });

  test("entries compare by what they say", () => {
    assert.equal(sameSplit({ share: 3, pair: { top: "a", below: "b" } }, { share: 3, pair: { top: "a", below: "b" } }), true);
    assert.equal(sameSplit({ share: 3, pair: null }, { share: 3, pair: { top: "a", below: "b" } }), false);
    assert.equal(sameSplit({ share: 3, pair: null }, { share: 4, pair: null }), false);
  });
});

describe("the room's scroll offsets", () => {
  const scroller = (top = 0, left = 0) => ({ scrollTop: top, scrollLeft: left });

  test("a swap puts back the offsets of the scrollers still in the room, and only those", () => {
    const keep = new ScrollKeep();
    const pane = scroller(120);
    const table = scroller(0, 150);
    keep.record(pane);
    keep.record(table);
    pane.scrollTop = 0;
    table.scrollLeft = 0;
    assert.equal(keep.restore([pane, table, scroller()]), 2);
    assert.deepEqual([pane.scrollTop, table.scrollLeft], [120, 150]);
  });

  // W6B-ASTRA-04: tab changes without a swap replace panes, and the keep never lists or touches the ones that left.
  test("repeated tab changes leave nothing to put back but the panes the room holds now", () => {
    const keep = new ScrollKeep();
    const gone: { scrollTop: number; scrollLeft: number }[] = [];
    for (let i = 0; i < 50; i++) {
      const pane = scroller(10 * i);
      keep.record(pane);
      gone.push(pane);
    }
    const now = scroller(42);
    keep.record(now);
    now.scrollTop = 0;
    for (const pane of gone) pane.scrollTop = -1;
    assert.equal(keep.restore([now]), 1, "only the pane in the room");
    assert.equal(now.scrollTop, 42);
    assert.ok(gone.every((pane) => pane.scrollTop === -1), "a pane that left is never written");
  });
});
