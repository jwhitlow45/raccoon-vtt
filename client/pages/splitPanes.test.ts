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
  test("from exactly 336 own px: two pane minimums and the bar", () => {
    assert.equal(PANE_MIN, 145, "a subpage header and the very short sheet's 88 px body");
    assert.equal(BAR_PX, 46);
    assert.equal(SPLIT_ROOM, 336);
    assert.equal(roomForTwo(336), true);
    assert.equal(roomForTwo(335), false);
    assert.equal(roomForTwo(264), false, "a large phone sideways, the DM");
  });
});

describe("the panes' sizes", () => {
  const sizes = (room: number, share: number | null = null, initiative: "top" | "below" | null = null) => {
    const s = splitPanes({ room, share, initiative });
    return [s.top, s.below];
  };

  test("with no share stored, even", () => {
    assert.deepEqual(sizes(574), [264, 264], "1280 x 800, the DM");
    assert.deepEqual(sizes(739), [346, 347], "1280 x 800, a player");
    assert.deepEqual(sizes(390), [172, 172], "1280 x 800 at 130%, the DM");
    assert.deepEqual(sizes(366), [160, 160], "1366 x 768 at 130%");
    assert.deepEqual(sizes(369), [161, 162], "932 x 430, a player");
  });

  test("a pane holding Initiative takes what keeps its round header stuck, as far as the other keeps its minimum", () => {
    assert.equal(INITIATIVE_STUCK, 193);
    assert.deepEqual(sizes(390, null, "top"), [193, 151], "1280 x 800 at 130%");
    assert.deepEqual(sizes(390, null, "below"), [151, 193], "in either pane");
    assert.deepEqual(sizes(366, null, "top"), [175, 145], "1366 x 768 at 130%: too little room for 193");
    assert.deepEqual(sizes(366, null, "below"), [145, 175]);
    assert.deepEqual(sizes(406, null, "top"), [193, 167], "a tablet at 130%");
    assert.deepEqual(sizes(369, null, "top"), [178, 145], "932 x 430, a player");
    assert.deepEqual(sizes(574, null, "top"), [264, 264], "an even split already holds it");
  });

  test("a stored share always wins, clamped where it is drawn at both minimums", () => {
    assert.deepEqual(sizes(574, 620, "below"), [327, 201]);
    assert.deepEqual(sizes(574, 100), [145, 383], "clamped at the top's minimum");
    assert.deepEqual(sizes(574, 950), [383, 145], "clamped at the bottom's minimum");
    assert.deepEqual(sizes(390, 500, "top"), [172, 172], "a share below 193 lets Initiative's header scroll");
  });

  test("a stored share stays as it was while clamped, so a taller room draws it again", () => {
    const share = shareOf(500, 800);
    assert.equal(splitPanes({ room: 390, share, initiative: null }).top, 199, "clamped in a short room");
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
    assert.deepEqual(separatorValue(splitPanes({ room: 574, share: null, initiative: null })), { now: 50, min: 27, max: 73 });
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
    assert.equal(stepped(-640), 145);
    assert.equal(stepped(640), 383);
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
