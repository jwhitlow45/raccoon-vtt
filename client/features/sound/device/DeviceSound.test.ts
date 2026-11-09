import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * This device's sound controls (docs/design/design-v1-volume.md 4 and 5):
 * the icon a level shows, what a move of the master slider stores, the
 * one status line and where it shows, and which rows show.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createStore } = await import("zustand/vanilla");
const { room } = await import("#shared/testutil.ts");
const { RoomProvider } = await import("../../../state/view.ts");
const { DeviceSound, deviceSoundLine, mixShown, volumeIcon, volumeStep } = await import("./DeviceSound.tsx");
const { setSoundHere } = await import("../engine/store.ts");
const { setRoomSoundChoice, setSoundMix, soundMix } = await import("../../device/settings.ts");
const words = await import("../panel/words.ts");
const noop = () => {};

function render(role: "dm" | "player", opts: { line: boolean; dmOnly?: boolean; display?: boolean }): string {
  const view = room();
  if (opts.dmOnly) view.meta.settings = { ...view.meta.settings, soundDmOnly: true };
  const store = createStore(() => ({ view, you: { memberId: role === "dm" ? "dm1" : "p1", role }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, display: opts.display ?? false, children: createElement(DeviceSound, { line: opts.line }) }),
  );
}

const LINES = [words.DM_PLAYS_IT, words.TAP_TO_START, words.ANOTHER_WINDOW, words.CANNOT_PLAY];
const linesIn = (html: string) => LINES.filter((l) => html.includes(l.replaceAll("'", "&#x27;")));

describe("this device's volume", () => {
  test("the icon: muted, low under 50%, loud from 50%", () => {
    assert.equal(volumeIcon({ muted: true, volume: 80 }), "muted");
    assert.equal(volumeIcon({ muted: false, volume: 45 }), "volumeLow");
    assert.equal(volumeIcon({ muted: false, volume: 50 }), "volume");
    assert.equal(volumeIcon({ muted: false, volume: 5 }), "volumeLow");
  });

  test("the master slider: a level unmutes, and 0 mutes keeping the level it was taken at, never 0", () => {
    assert.deepEqual(volumeStep(70, 0), { muted: true, volume: 70 }, "70 dragged to 0, so unmuting gives 70");
    // Muted with 70 kept, one drag up to 30 then back to 0: the 30 on the way is stored, the 0 gives the 70 back.
    assert.deepEqual(volumeStep(70, 30), { muted: false, volume: 30 });
    assert.deepEqual(volumeStep(70, 0), { muted: true, volume: 70 });
    assert.deepEqual(volumeStep(10, 0), { muted: true, volume: 10 }, "Left from 10 to 0 keeps 10");
    assert.deepEqual(volumeStep(0, 0), { muted: true, volume: 100 }, "a kept 0, which storage never gives, is never stored");
    assert.deepEqual(volumeStep(70, 100), { muted: false, volume: 100 });
  });

  test("one status line: a player's Only DM devices play wins, then a tap, another window, a browser that can't, and nothing for muted or playing", () => {
    assert.equal(deviceSoundLine({ player: true, dmOnly: true, here: "other" }), words.DM_PLAYS_IT);
    assert.equal(deviceSoundLine({ player: false, dmOnly: true, here: "plays" }), null, "a DM device plays under Only DM devices play");
    assert.equal(deviceSoundLine({ player: true, dmOnly: false, here: "tap" }), words.TAP_TO_START);
    assert.equal(deviceSoundLine({ player: false, dmOnly: false, here: "other" }), words.ANOTHER_WINDOW);
    assert.equal(deviceSoundLine({ player: false, dmOnly: false, here: "cannot" }), words.CANNOT_PLAY);
    assert.equal(deviceSoundLine({ player: false, dmOnly: false, here: "cannot" }), "This browser can't play the room's sound.");
    assert.equal(deviceSoundLine({ player: true, dmOnly: false, here: "off" }), null, "muted: the toggle and the 0% say it");
    assert.equal(deviceSoundLine({ player: true, dmOnly: false, here: "plays" }), null);
  });

  test("Music and Background hide only while the server's switch is off, never while it is asked or failed", () => {
    assert.deepEqual(mixShown("off"), ["effects"]);
    for (const s of ["unknown", "on", "failed"] as const) assert.deepEqual(mixShown(s), ["music", "loops", "effects"], s);
  });

  test("the line shows once where `line` asks for it and never where it does not, for every state it has", () => {
    try {
      for (const here of ["tap", "other", "cannot"] as const) {
        setSoundHere({ here, music: "none" });
        for (const role of ["dm", "player"] as const) {
          assert.equal(linesIn(render(role, { line: true })).length, 1, `${role} ${here}`);
          assert.deepEqual(linesIn(render(role, { line: false })), [], `${role} ${here}, in the Sound panel`);
        }
      }
      setSoundHere({ here: "other", music: "none" });
      assert.deepEqual(linesIn(render("player", { line: true, dmOnly: true })), [words.DM_PLAYS_IT], "one line, the DM's, over another window's");
      assert.deepEqual(linesIn(render("dm", { line: true, dmOnly: true })), [words.ANOTHER_WINDOW]);
      for (const here of ["plays", "off"] as const) {
        setSoundHere({ here, music: "none" });
        assert.deepEqual(linesIn(render("player", { line: true })), [], here);
      }
    } finally {
      setSoundHere({ here: "off", music: "none" });
    }
  });

  test("muted: the toggle is pressed and the master reads 0%, Muted to a reader, the three keeping their values", () => {
    const before = soundMix();
    try {
      setSoundMix({ volume: 70, music: 35, loops: 60, effects: 90 });
      setRoomSoundChoice("off");
      const muted = render("dm", { line: true });
      assert.match(muted, /aria-label="Mute" aria-pressed="true"/);
      assert.match(muted, /aria-label="Volume"[^>]*aria-valuetext="Muted"[^>]*value="0"/);
      for (const v of ["35", "60", "90"]) assert.match(muted, new RegExp(`aria-valuetext="${v}%"[^>]*value="${v}"`), v);
      setRoomSoundChoice("on");
      const playing = render("dm", { line: true });
      assert.match(playing, /aria-label="Mute" aria-pressed="false"/);
      assert.match(playing, /aria-valuetext="70%"/);
    } finally {
      setSoundMix(before);
      setRoomSoundChoice(null);
    }
  });

  test("the help points a player at Only DM devices play and a DM at Table sound, and Turn and Ping sound say they play while muted", () => {
    const player = render("player", { line: false });
    const dm = render("dm", { line: false });
    assert.ok(player.includes("At one table, the DM can turn on Only DM devices play in Sound.") && !player.includes("Table sound, in Sound"));
    assert.ok(dm.includes("Table sound, in Sound, sets the volumes for everyone.") && !dm.includes("At one table"));
    for (const html of [player, dm]) {
      assert.ok(html.includes(words.TURN_SOUND_HELP.replaceAll("'", "&#x27;")) && html.includes(words.PING_SOUND_HELP));
      assert.ok(html.includes(">Music<") && html.includes(">Background<") && html.includes(">Effects<"), "the server's switch not answered yet");
      assert.ok(!html.includes("Room sound"), "no Room sound switch");
    }
  });
});
