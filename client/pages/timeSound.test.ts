import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { panelsFor } from "../features/panels.ts";
import { panelIsOpen } from "../lib/folds.ts";
import { clockLinesShown, playerWaits } from "./timeSound.ts";

/*
 * Room's rules for the Time and Sound panels
 * (docs/design/design-v1-sound-layout.md 3.2 and 3.3): what keeps each
 * listed for a player, and when clock lines toast. Room.tsx cannot load
 * under node (Konva wants a window), so its wiring is read from its source.
 */

type Local = { panel: string | null; tab: string; below: string | null };

/** The titles a player's list shows for the room as it is and the panels this device has open, through Room's own reading of them. */
function listed(now: { clock: boolean; sound: boolean }, local: Local, wide: boolean): string[] {
  return panelsFor("player", wide, playerWaits(now, (id) => panelIsOpen(local, id, wide)))
    .map((p) => p.title)
    .filter((t) => t === "Time" || t === "Sound");
}

const NONE_OPEN: Local = { panel: null, tab: "token", below: null };
const NOTHING = { clock: false, sound: false };

describe("a player's Time and Sound in the list", () => {
  for (const wide of [false, true]) {
    const where = wide ? "from 900 px" : "on a phone";
    const opened = (id: string): Local => (wide ? { panel: null, tab: id, below: null } : { panel: id, tab: "token", below: null });

    test(`${where}: the clock shared and nothing playing lists Time, not Sound`, () => {
      assert.deepEqual(listed({ clock: true, sound: false }, NONE_OPEN, wide), ["Time"]);
      assert.deepEqual(listed({ clock: false, sound: true }, NONE_OPEN, wide), ["Sound"]);
      assert.deepEqual(listed({ clock: true, sound: true }, NONE_OPEN, wide), ["Sound", "Time"]);
      assert.deepEqual(listed(NOTHING, NONE_OPEN, wide), []);
    });

    test(`${where}: an open Sound stays listed once the music stops, and goes once closed`, () => {
      assert.deepEqual(listed(NOTHING, opened("sound"), wide), ["Sound"], "it says Nothing is playing. itself");
      assert.deepEqual(listed(NOTHING, NONE_OPEN, wide), []);
    });

    test(`${where}: an open Time stays listed once the DM stops sharing, and goes once closed`, () => {
      assert.deepEqual(listed(NOTHING, opened("time"), wide), ["Time"], "it says the DM isn't sharing itself");
      assert.deepEqual(listed({ clock: false, sound: true }, opened("time"), wide), ["Sound", "Time"]);
    });

    test(`${where}: each panel's own open state keeps only itself, and another panel open keeps neither`, () => {
      assert.equal(listed(NOTHING, opened("time"), wide).includes("Sound"), false);
      assert.equal(listed(NOTHING, opened("sound"), wide).includes("Time"), false);
      assert.deepEqual(listed(NOTHING, opened("log"), wide), []);
    });
  }

  test("from 900 px the pane below counts as open, as a hidden side panel's tab does", () => {
    assert.deepEqual(listed(NOTHING, { panel: null, tab: "log", below: "time" }, true), ["Time"]);
    assert.deepEqual(listed(NOTHING, { panel: "sound", tab: "log", below: null }, true), [], "a phone's sheet left from before the turn counts only on a phone");
    assert.deepEqual(listed(NOTHING, { panel: null, tab: "sound", below: null }, false), [], "a side panel's tab left from before the turn counts only from 900 px");
  });

  test("the DM has both whatever the room holds", () => {
    const titles = panelsFor("dm", true, playerWaits(NOTHING, () => false)).map((p) => p.title);
    assert.ok(titles.includes("Sound") && titles.includes("Time"));
  });
});

describe("clock lines as toasts (docs/design/design-v1-calendar.md 4.7)", () => {
  test("none while the Log or Time is on screen, else a toast", () => {
    const shown = (ids: string[]) => clockLinesShown((id) => ids.includes(id));
    assert.equal(shown(["log"]), true);
    assert.equal(shown(["time"]), true);
    assert.equal(shown(["token", "time"]), true, "Time in the pane below");
    assert.equal(shown(["sound"]), false, "Sound holds no clock");
    assert.equal(shown(["dice"]), false);
    assert.equal(shown([]), false);
  });
});

test("Room reads both rules, with its own wide and its own open panels", () => {
  const source = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function RoomPage() {"));
  assert.ok(body.includes("const panels = panelsFor(role, wide, playerWaits({ clock: hasClock, sound: hasSound }, (id) => panelIsOpen({ panel, tab, below }, id, wide)));"));
  assert.ok(body.includes("useClockToasts(clockLinesShown(wide ? sideShows : (id) => sheet?.id === id));"));
});
