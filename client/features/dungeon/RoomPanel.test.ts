import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORTS, SECRET_OFF, type RoomEdit, type RoomFacts } from "./edits.ts";
import { doorName, EDIT_OVER_WALLS, ENTRANCE_FLAT, HEIGHT_HELP, NO_TRAP_FITS, reportRow, ROOM_GONE, WING_FLAT } from "./words.ts";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomPanel } = await import("./RoomPanel.tsx");

/*
 * The room panel (phase 3, 4.1): one room's rows from its facts and pins,
 * each off with its reason where the generator would not take it, and the
 * reports under the rows they speak of.
 */

const nothing = () => {};
const ROOM: RoomFacts = {
  n: 3,
  room: 5,
  at: 4,
  ground: 0,
  doors: [
    { key: "2", side: "w", to: 1, state: "closed", secretOk: "Only a door on an extra way around, or a room's only door, can be secret." },
    { key: "4", side: "s", to: 4, state: "locked", secretOk: null },
  ],
  traps: ["hidden-pit", "spiked-pit"],
  trap: null,
  dressing: "some",
  lit: false,
  reports: [],
};

function draw(facts: RoomFacts | null, edit?: RoomEdit, more: { cave?: boolean; flat?: boolean; extra?: string[]; wing?: boolean } = {}): string {
  return renderToStaticMarkup(h(RoomPanel, { facts, edit, onEdit: nothing, onStep: nothing, onDone: nothing, cave: more.cave ?? false, ...(more.flat ? { flat: true } : {}), ...(more.extra ? { more: more.extra } : {}), ...(more.wing ? { wing: true } : {}) }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");
/** The radio for an option label, and whether it is off and checked. */
function radio(html: string, label: string): { off: boolean; checked: boolean } {
  const at = html.indexOf(`>${label}<`);
  assert.ok(at > 0, `no ${label}`);
  const input = html.slice(html.lastIndexOf("<input", at), at);
  return { off: /\sdisabled=""/.test(input), checked: /\schecked=""/.test(input) };
}

test("a region named for its room, with ‹, › and Done, its height and doors from the facts", () => {
  const html = draw(ROOM);
  assert.match(html, /<section role="region" aria-labelledby="([^"]+)"[^>]*>.*<h3[^>]*id="\1"[^>]*>Room 3<\/h3>/s);
  assert.match(html, /aria-label="Previous room"/);
  assert.match(html, /aria-label="Next room"/);
  assert.ok(text(html).includes(HEIGHT_HELP));
  assert.equal(radio(html, "Flat").checked, true);
  assert.ok(text(html).includes(doorName("w", 1)));
  assert.equal(doorName("s", "edge"), "South, to the way in");
  assert.equal(doorName("e", "join"), "East, to the way in");
});

test("a wing's room and the rooms its doors lead to go by the ghost's W numbers", () => {
  // LP37 polish: the ghost said W3 over a panel that said Room 3.
  const html = draw(ROOM, undefined, { wing: true });
  assert.match(html, /<h3[^>]*>Room W3<\/h3>/);
  assert.ok(text(html).includes("West, to room W1"));
  assert.ok(text(html).includes("South, to room W4"));
  assert.equal(doorName("e", "join", true), "East, to the way in");
});

test("Secret is off with its reason where the door may not be secret, and on where it may", () => {
  const html = draw(ROOM);
  const west = html.slice(html.indexOf("West, to room 1"), html.indexOf("South, to room 4"));
  assert.equal(radio(west, "Secret").off, true);
  assert.ok(text(west).includes("Only a door on an extra way around"));
  const south = html.slice(html.indexOf("South, to room 4"));
  assert.equal(radio(south, "Secret").off, false);
  assert.equal(radio(south, "Locked").checked, true);
});

test("pins show over the plan's values", () => {
  const html = draw(ROOM, { ground: -10, doors: { "4": "secret" }, trap: "spiked-pit", lit: true, dressing: "full" });
  assert.equal(radio(html, "Sunk 10 ft").checked, true);
  assert.equal(radio(html.slice(html.indexOf("South, to room 4")), "Secret").checked, true);
  assert.equal(radio(html, "Spiked Pit").checked, true);
  assert.equal(radio(html, "On").checked, true);
  assert.equal(radio(html, "Full").checked, true);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Reset room/);
  assert.match(draw(ROOM), /<button[^>]*disabled=""[^>]*>Reset room/);
});

test("the entrance and a flat wing hold Height at Flat with their lines", () => {
  const entrance = draw({ ...ROOM, n: 1 }, { ground: 5 });
  assert.ok(text(entrance).includes(ENTRANCE_FLAT));
  assert.equal(radio(entrance, "Raised 5 ft").off, true);
  assert.equal(radio(entrance, "Flat").checked, true);
  const flat = draw({ ...ROOM, ground: 5 }, undefined, { flat: true });
  assert.ok(text(flat).includes(WING_FLAT));
  assert.equal(radio(flat, "Flat").checked, true);
});

test("a cave has no doors, a room with no trap spot says so, and a gone room offers only Reset room", () => {
  assert.ok(text(draw(ROOM, undefined, { cave: true })).includes(SECRET_OFF.cave));
  assert.ok(text(draw({ ...ROOM, traps: [] })).includes(NO_TRAP_FITS));
  const gone = draw(null, { lit: true });
  assert.ok(text(gone).includes(ROOM_GONE.line));
  assert.doesNotMatch(gone, /<button[^>]*disabled=""[^>]*>Reset room/);
});

test("each report stands under its row and is spoken once in the status region", () => {
  const reports = [
    "No room for its stairs, so it stays flat.",
    "That door cannot be secret here: every room must still be reached without it.",
    "No room for another secret door in this dungeon, so that change was not made.",
    "No spot for that trap here, so it has none.",
    "No room for another stamp in this dungeon, so that change was not made.",
    "No room for another light in this dungeon, so that change was not made.",
  ];
  assert.deepEqual(
    reports.map(reportRow),
    ["height", "doors", "doors", "trap", "dressing", "lit"],
  );
  assert.equal(reportRow(EDIT_OVER_WALLS), "other");
  // The generator's own report lines, each under the row it speaks of.
  assert.deepEqual(
    [REPORTS.flat, REPORTS.noTrapSpot, REPORTS.doorGone, REPORTS.secretOnStairs, REPORTS.secretBreaksReach, REPORTS.roomGone, REPORTS.noRoom("trap"), REPORTS.noRoom("secret door"), REPORTS.noRoom("stamp"), REPORTS.noRoom("light")].map(reportRow),
    ["height", "trap", "doors", "doors", "doors", "other", "trap", "doors", "dressing", "lit"],
  );
  const html = draw({ ...ROOM, reports }, undefined, { extra: [EDIT_OVER_WALLS] });
  assert.match(html, new RegExp(`role="status" aria-live="polite"[^>]*>${reports.join(" ").replace(/[.?*+()]/g, "\\$&")} ${EDIT_OVER_WALLS.replace(/[.]/g, "\\.")}<`));
  const height = html.slice(html.indexOf(">Height<"), html.indexOf("West, to room 1"));
  assert.ok(height.includes("No room for its stairs"));
});
