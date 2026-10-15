import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buttonNote, colorBadge, colorUsers, freeColor, memberSwatches } from "./memberColor.ts";
import { MEMBER_COLORS } from "./theme.ts";

const [YELLOW, GREEN, BLUE, PURPLE, , TEAL] = MEMBER_COLORS;

describe("a new player's color", () => {
  test("never starts as a DM's color", () => {
    assert.equal(freeColor([], [YELLOW]), GREEN);
  });

  test("starts as the first color no other member uses", () => {
    assert.equal(freeColor([GREEN, BLUE.toUpperCase()], [YELLOW]), PURPLE);
  });

  test("with every color taken, starts as the one used least", () => {
    const all = MEMBER_COLORS.slice(1).concat(MEMBER_COLORS.slice(1, 4));
    assert.equal(freeColor(all, [YELLOW]), MEMBER_COLORS[4]);
  });

  test("a DM who changed color frees the yellow and takes the new color", () => {
    assert.equal(freeColor([], [BLUE]), YELLOW);
    assert.equal(freeColor([YELLOW, GREEN], [BLUE]), PURPLE);
  });

  test("counts two DMs, and on a tie a DM's color goes last", () => {
    // Every color used once, the two DMs' included: the first color no DM uses wins the tie.
    const players = MEMBER_COLORS.filter((c) => c !== YELLOW && c !== TEAL);
    assert.equal(freeColor(players, [TEAL, YELLOW]), GREEN);
    // Every color used once by players, and two DMs share one: that one is now used most.
    assert.equal(freeColor([...MEMBER_COLORS], [GREEN, GREEN]), YELLOW);
  });

  test("in a room with no players and no DM colors known, starts as the first color", () => {
    assert.equal(freeColor([]), YELLOW);
  });
});

describe("who uses a color", () => {
  const players = [
    { name: "Pat", color: GREEN },
    { name: "Dana", color: BLUE },
    { name: "Lee", color: BLUE.toUpperCase() },
  ];

  test("names the players, then the DMs it knows only by color", () => {
    assert.equal(colorUsers(GREEN, players), "Pat");
    assert.equal(colorUsers(BLUE, players), "Dana and Lee");
    assert.equal(colorUsers(GREEN, players, [GREEN]), "Pat and a DM");
    assert.equal(colorUsers(YELLOW, players, [YELLOW, YELLOW]), "2 DMs");
    assert.equal(colorUsers(BLUE, players, [BLUE]), "Dana, Lee and a DM");
    assert.equal(colorUsers(TEAL, players, [YELLOW]), null);
  });

  test("a DM who changed color leaves the yellow unmarked", () => {
    assert.equal(colorUsers(YELLOW, [], [PURPLE]), null);
    assert.equal(colorUsers(PURPLE, [], [PURPLE]), "a DM");
  });

  test("the badge is one player's initial, DM for DMs alone, or how many share it", () => {
    assert.equal(colorBadge(GREEN, players), "P");
    assert.equal(colorBadge(BLUE, players), "2");
    assert.equal(colorBadge(YELLOW, players, [YELLOW]), "DM");
    assert.equal(colorBadge(YELLOW, players, [YELLOW, YELLOW]), "DM");
    assert.equal(colorBadge(GREEN, players, [GREEN]), "2");
    assert.equal(colorBadge(TEAL, players), undefined);
    assert.equal(colorBadge(GREEN, [{ name: "  émile", color: GREEN }]), "É");
  });
});

describe("the member palette as swatches", () => {
  test("names each color and who uses it, with no hex codes", () => {
    const options = memberSwatches({ players: [{ name: "Pat", color: GREEN }], dmColors: [YELLOW] });
    assert.equal(options.length, MEMBER_COLORS.length);
    assert.deepEqual(options[0], { color: YELLOW, name: "Yellow, used by a DM", badge: "DM" });
    assert.deepEqual(options[1], { color: GREEN, name: "Green, used by Pat", badge: "P" });
    assert.deepEqual(options[2], { color: BLUE, name: "Blue", badge: undefined });
    assert.ok(options.every((o) => !/#/.test(o.name)));
  });

  test("a current color outside the palette comes first as Current color, and goes once a palette color is current", () => {
    const odd = memberSwatches({ players: [], current: "#5A4636" });
    assert.deepEqual(odd[0], { color: "#5A4636", name: "Current color" });
    assert.equal(odd.length, MEMBER_COLORS.length + 1);
    assert.equal(memberSwatches({ players: [], current: GREEN.toUpperCase() }).length, MEMBER_COLORS.length);
  });
});

describe("the picker's note on button colors", () => {
  test("says nothing when buttons wear the color as it is", () => {
    assert.equal(buttonNote(YELLOW), null);
    assert.equal(buttonNote("#E5E5E5"), null);
  });

  test("says buttons stay yellow for the crest orange and for a color the accent cannot use", () => {
    assert.equal(buttonNote("#f38400"), "Buttons stay yellow.");
    assert.equal(buttonNote("#5a463680"), "Buttons stay yellow.");
  });

  test("says which way a moved color went", () => {
    assert.equal(buttonNote(PURPLE), "Buttons use a lighter shade so they stay readable.");
    assert.equal(buttonNote("#1b1f3a"), "Buttons use a lighter shade so they stay readable.");
  });
});
