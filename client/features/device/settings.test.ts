import assert from "node:assert/strict";
import { test } from "node:test";

/*
 * Going back to the device's interface size after a table display took its
 * own (features/display) when storage does not keep things: a private
 * window, a full disk or a browser that blocks site data. Each case loads
 * the settings afresh, since they read storage once as the page starts.
 */

const stored = new Map<string, string>();
const storage = { writes: true, reads: true };
Object.assign(globalThis, {
  localStorage: {
    getItem(k: string) {
      if (!storage.reads) throw new DOMException("blocked", "SecurityError");
      return stored.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (!storage.writes) throw new DOMException("full", "QuotaExceededError");
      stored.set(k, String(v));
    },
    removeItem(k: string) {
      stored.delete(k);
    },
  },
});

let page = 0;
/** The settings as a new page loads them, with storage as it is now. */
async function loadPage(): Promise<typeof import("./settings.ts")> {
  return (await import(`./settings.ts?page=${++page}`)) as typeof import("./settings.ts");
}

function reset(input: { uiScale?: string; writes: boolean; reads: boolean }): void {
  stored.clear();
  if (input.uiScale !== undefined) stored.set("rvtt.uiScale", input.uiScale);
  storage.writes = input.writes;
  storage.reads = input.reads;
}

test("with writes failing, closing a display gives back the size chosen on this page, not the older stored one", async () => {
  reset({ uiScale: "0.85", writes: false, reads: true });
  const s = await loadPage();
  assert.equal(s.uiScale(), 0.85);
  s.setUiScale(1.15);
  assert.equal(stored.get("rvtt.uiScale"), "0.85", "the write failed");
  s.applyUiScale(1.3);
  assert.equal(s.uiScale(), 1.3);
  s.restoreUiScale();
  assert.equal(s.uiScale(), 1.15);
});

test("with reads blocked, closing a display gives back the size chosen on this page, not 100%", async () => {
  reset({ uiScale: "0.85", writes: false, reads: false });
  const s = await loadPage();
  assert.equal(s.uiScale(), 1, "nothing could be read");
  s.setUiScale(1.15);
  s.applyUiScale(1.3);
  s.restoreUiScale();
  assert.equal(s.uiScale(), 1.15);
});

test("with storage working, closing a display gives back the stored size, a choice from another window included", async () => {
  reset({ uiScale: "0.85", writes: true, reads: true });
  const s = await loadPage();
  s.applyUiScale(1.3);
  s.restoreUiScale();
  assert.equal(s.uiScale(), 0.85);

  s.setUiScale(1.15);
  s.applyUiScale(1.3);
  // The room's This device page in another window of the same browser.
  stored.set("rvtt.uiScale", "1");
  s.restoreUiScale();
  assert.equal(s.uiScale(), 1);
});

/*
 * The shortcut sheet's moved keys (state/keyBindings.ts), kept beside the
 * other settings: only the changes, with the stored form's version.
 */

test("moved keys are kept with their version, and a new page reads them back", async () => {
  reset({ writes: true, reads: true });
  const first = await loadPage();
  assert.deepEqual(first.keyChanges(), {}, "nothing moved yet");
  first.setKeyChanges({ "tool:fog": "x" });
  assert.equal(stored.get("rvtt.keys"), '{"v":1,"keys":{"tool:fog":"x"}}');
  const second = await loadPage();
  assert.deepEqual(second.keyChanges(), { "tool:fog": "x" });
  second.setKeyChanges({});
  assert.deepEqual((await loadPage()).keyChanges(), {}, "Reset all keys");
});

test("moved keys of another version, or a store that is not JSON, read as none", async () => {
  for (const raw of ['{"v":2,"keys":{"tool:fog":"x"}}', "{", '"x"', '{"v":1,"keys":{"tool:fog":"ArrowUp"}}']) {
    reset({ writes: true, reads: true });
    stored.set("rvtt.keys", raw);
    assert.deepEqual((await loadPage()).keyChanges(), {}, raw);
  }
});

test("with storage blocked, moved keys last until the page closes", async () => {
  reset({ writes: false, reads: false });
  const s = await loadPage();
  s.setKeyChanges({ "tool:fog": "x" });
  assert.deepEqual(s.keyChanges(), { "tool:fog": "x" });
  assert.equal(stored.has("rvtt.keys"), false);
});

/*
 * The Sheet handle (docs/design/design-v1-sheet-swipe.md 4.8), kept on this
 * device as its other choices are: the ringed tail until one is chosen, and
 * again for a stored id this version does not know.
 */

test("the sheet handle is the ringed tail until chosen, a choice is kept, and an unknown stored one reads as the tail", async () => {
  reset({ writes: true, reads: true });
  const first = await loadPage();
  assert.equal(first.sheetHandle(), "tail");
  first.setSheetHandle("mask");
  assert.equal(stored.get("rvtt.sheetHandle"), "mask");
  assert.equal((await loadPage()).sheetHandle(), "mask");
  for (const raw of ["blob", "", "Mask", "tail;"]) {
    reset({ writes: true, reads: true });
    stored.set("rvtt.sheetHandle", raw);
    assert.equal((await loadPage()).sheetHandle(), "tail", raw);
  }
});

test("with storage blocked, the sheet handle reads as the tail and a choice lasts until the page closes", async () => {
  reset({ writes: false, reads: false });
  const s = await loadPage();
  assert.equal(s.sheetHandle(), "tail");
  s.setSheetHandle("rune");
  assert.equal(s.sheetHandle(), "rune");
  assert.equal(stored.has("rvtt.sheetHandle"), false);
});

/*
 * Weather on the map (docs/design/design-v1-weather.md 4.3): Moving until
 * chosen, and anything this version does not know reads as Moving. A table
 * display's own choice is for its page only, as its text size is.
 */

test("weather reads moving, still or off, and anything else as moving", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.equal(s.weatherMode(), "moving");
  for (const raw of ["still", "off", "moving"]) assert.equal(s.parseWeatherMode(raw), raw);
  for (const raw of [null, "", "Still", "OFF", "none", "moving;"]) assert.equal(s.parseWeatherMode(raw), "moving", String(raw));
  s.setWeatherMode("off");
  assert.equal(stored.get("rvtt.weather"), "off");
  assert.equal((await loadPage()).weatherMode(), "off");
});

test("a table display's weather lasts for its page and gives the device's own back", async () => {
  reset({ writes: true, reads: true });
  stored.set("rvtt.weather", "still");
  const s = await loadPage();
  s.applyWeatherMode("off");
  assert.equal(s.weatherMode(), "off");
  assert.equal(stored.get("rvtt.weather"), "still", "the member's choice is not touched");
  s.restoreWeatherMode();
  assert.equal(s.weatherMode(), "still");
});

/*
 * The theme (docs/design/design-v1-light-theme.md 4.1): Dark until chosen,
 * and a choice another window stores reaches this one through its
 * `storage` event (lib/scheme.ts passes it to `adopt`).
 */
test("the theme is dark until chosen, a choice is kept, and an unknown stored one reads as dark", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.equal(s.themeChoice(), "dark");
  s.setThemeChoice("auto");
  assert.equal(stored.get("rvtt.theme"), "auto");
  assert.equal((await loadPage()).themeChoice(), "auto");
  stored.set("rvtt.theme", "sepia");
  assert.equal((await loadPage()).themeChoice(), "dark");
});

test("a choice another window stored is taken as this device's, unless the page holds one of its own until it lets go", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  let heard = 0;
  s.subscribeThemeChoice(() => heard++);
  s.themeChoiceSetting.adopt("light");
  assert.equal(s.themeChoice(), "light");
  assert.equal(heard, 1);
  s.themeChoiceSetting.apply("dark");
  s.themeChoiceSetting.adopt("auto");
  assert.equal(s.themeChoice(), "dark", "the page's own value stays");
  s.themeChoiceSetting.restore();
  assert.equal(s.themeChoice(), "auto");
  s.themeChoiceSetting.adopt("light");
  assert.equal(s.themeChoice(), "light", "after restore, another window's choice shows again");
});

test("with writes failing, a choice another window stored still comes back when the page lets go", async () => {
  reset({ writes: false, reads: true });
  const s = await loadPage();
  s.setThemeChoice("light");
  s.themeChoiceSetting.apply("dark");
  s.themeChoiceSetting.adopt("auto");
  s.themeChoiceSetting.restore();
  assert.equal(s.themeChoice(), "auto");
});

/*
 * Animated maps (docs/design/design-v1-animated-maps.md 4.4): Moving until
 * chosen, and anything else reads as Moving. A table display's own choice
 * is for its page only, as its weather is.
 */

test("animated maps read moving or still, and anything else as moving", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.equal(s.animatedMaps(), "moving");
  for (const raw of ["still", "moving"]) assert.equal(s.parseAnimatedMaps(raw), raw);
  for (const raw of [null, "", "Still", "off", "STILL", "still;"]) assert.equal(s.parseAnimatedMaps(raw), "moving", String(raw));
  s.setAnimatedMaps("still");
  assert.equal(stored.get("rvtt.animatedMaps"), "still");
  assert.equal((await loadPage()).animatedMaps(), "still");
});

test("a table display's animated maps last for its page and give the device's own back", async () => {
  reset({ writes: true, reads: true });
  stored.set("rvtt.animatedMaps", "still");
  const s = await loadPage();
  s.applyAnimatedMaps("moving");
  assert.equal(s.animatedMaps(), "moving");
  assert.equal(stored.get("rvtt.animatedMaps"), "still", "the member's choice is not touched");
  s.restoreAnimatedMaps();
  assert.equal(s.animatedMaps(), "still");
});

/*
 * Mute, stored as Room sound was (docs/design/design-v1-volume.md 5): "on",
 * "off", or no choice, which is unmuted for a DM device and asks on a
 * player's. The mix is this device's Volume, 100% at first and never 0,
 * then Music, Background and Effects, 80% at first, each 0 to 100, and a
 * broken stored mix reads as the default.
 */

test("the mute is on, off or not chosen, and no choice is unmuted for a DM only", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.equal(s.roomSoundChoice(), null);
  for (const raw of [null, "", "On", "yes", "true"]) assert.equal(s.parseRoomSound(raw), null, String(raw));
  assert.equal(s.parseRoomSound("on"), "on");
  assert.equal(s.parseRoomSound("off"), "off");
  assert.equal(s.roomSoundOnFor(null, "dm"), true);
  assert.equal(s.roomSoundOnFor(null, "player"), false);
  assert.equal(s.roomSoundOnFor("off", "dm"), false);
  assert.equal(s.roomSoundOnFor("on", "player"), true);
  s.setRoomSoundChoice("off");
  assert.equal(stored.get("rvtt.roomSound"), "off");
  assert.equal((await loadPage()).roomSoundChoice(), "off");
});

test("the sound mix is Volume 100% and the rest 80% at first, kept 0 to 100, and a broken one reads as the default", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  const first = { volume: 100, music: 80, loops: 80, effects: 80 };
  assert.deepEqual(s.soundMix(), first);
  assert.deepEqual(s.parseSoundMix('{"volume":45,"music":10,"loops":250,"effects":-4}'), { volume: 45, music: 10, loops: 100, effects: 0 });
  assert.deepEqual(s.parseSoundMix('{"music":"loud"}'), first);
  for (const raw of ["", "{", "null", "[]", "7"]) assert.deepEqual(s.parseSoundMix(raw), first, raw);
  s.setSoundMix({ volume: 70, music: 35, loops: 60, effects: 100 });
  assert.equal(stored.get("rvtt.soundMix"), '{"volume":70,"music":35,"loops":60,"effects":100}');
  assert.deepEqual((await loadPage()).soundMix(), { volume: 70, music: 35, loops: 60, effects: 100 });
});

test("a mix an older build wrote, without Volume, plays at 100%, and so does a stored 0, which unmuting could not return to", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.deepEqual(s.parseSoundMix('{"music":35,"loops":60,"effects":100}'), { volume: 100, music: 35, loops: 60, effects: 100 });
  for (const v of ["0", "0.4", "-20", '"70"', "null"]) assert.equal(s.parseSoundMix(`{"volume":${v},"music":35}`).volume, 100, v);
  assert.equal(s.parseSoundMix('{"volume":5}').volume, 5, "the slider's lowest level");
  assert.equal(s.parseSoundMix('{"volume":180}').volume, 100);
});

test("the mute and the mix follow another window's change, and a cleared storage gives the defaults back", async () => {
  reset({ writes: true, reads: true });
  const events = new EventTarget();
  Object.assign(globalThis, { window: events });
  try {
    const s = await loadPage();
    const storageEvent = (key: string | null, newValue: string | null) => Object.assign(new Event("storage"), { key, newValue });
    // The page follows other windows from its first read.
    assert.equal(s.roomSoundChoice(), null);
    events.dispatchEvent(storageEvent("rvtt.roomSound", "on"));
    assert.equal(s.roomSoundChoice(), "on");
    events.dispatchEvent(storageEvent("rvtt.soundMix", '{"volume":30,"music":5,"loops":5,"effects":5}'));
    assert.deepEqual(s.soundMix(), { volume: 30, music: 5, loops: 5, effects: 5 });
    events.dispatchEvent(storageEvent(null, null));
    assert.equal(s.roomSoundChoice(), null);
    assert.deepEqual(s.soundMix(), { volume: 100, music: 80, loops: 80, effects: 80 });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("the side panel's width parses a missing key, an empty or non-number value and any width at or under the default as null, and floors the rest", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  for (const raw of [null, "", "  ", "abc", "NaN", "Infinity", "-5", "0", "300", "360", "360.0", "360.5"]) assert.equal(s.parsePanelWidth(raw), null, String(raw));
  assert.equal(s.parsePanelWidth("361"), 361);
  assert.equal(s.parsePanelWidth("500"), 500);
  assert.equal(s.parsePanelWidth("640.9"), 640);
  assert.equal(s.parsePanelWidth("900"), 900, "the clamp to the layout is the drawing's, not the parse's");
  assert.equal(s.panelWidth(), null, "the default with nothing stored");
  s.setPanelWidth(500);
  assert.equal(stored.get("rvtt.sidePanelWidth"), "500");
  s.setPanelWidth(null);
  assert.equal(stored.get("rvtt.sidePanelWidth"), "", "the default stores no number");
  assert.equal((await loadPage()).panelWidth(), null);
});

test("the side panel's width follows another window's change, and a cleared storage gives the default back", async () => {
  reset({ writes: true, reads: true });
  const events = new EventTarget();
  Object.assign(globalThis, { window: events });
  try {
    const s = await loadPage();
    const storageEvent = (key: string | null, newValue: string | null) => Object.assign(new Event("storage"), { key, newValue });
    assert.equal(s.panelWidth(), null);
    events.dispatchEvent(storageEvent("rvtt.sidePanelWidth", "520"));
    assert.equal(s.panelWidth(), 520);
    // A drag here shows its own width until it ends, then the other window's.
    s.applyPanelWidth(600);
    events.dispatchEvent(storageEvent("rvtt.sidePanelWidth", "480"));
    assert.equal(s.panelWidth(), 600);
    stored.set("rvtt.sidePanelWidth", "480");
    s.restorePanelWidth();
    assert.equal(s.panelWidth(), 480);
    events.dispatchEvent(storageEvent(null, null));
    assert.equal(s.panelWidth(), null);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("the tab row keeps every panel at first, stores only the ones left out, by role, and a broken value reads as none left out", async () => {
  reset({ writes: true, reads: true });
  const s = await loadPage();
  assert.deepEqual(s.tabRow(), { dm: [], player: [] });
  let row = s.withTabKept(s.tabRow(), "dm", "log", false);
  row = s.withTabKept(row, "dm", "journal", false);
  row = s.withTabKept(row, "dm", "log", false);
  assert.deepEqual(row.dm, ["journal", "log"], "a panel left out twice is stored once");
  assert.deepEqual(s.withTabKept(row, "dm", "log", true).dm, ["journal"], "ticked back into the row");
  assert.deepEqual(row.player, [], "a DM's ticks leave a player's row alone");
  s.setTabRow(row);
  assert.equal(stored.get("rvtt.tabRow"), '{"dm":["journal","log"],"player":[]}');
  assert.deepEqual((await loadPage()).tabRow(), row);
  assert.deepEqual(s.parseTabRow('{"dm":["log",7,"Log","log","dice"],"player":"menu"}'), { dm: ["log", "dice"], player: [] }, "only panel ids, once each");
  for (const raw of ["", "{", "null", "[]", "7", '"log"']) assert.deepEqual(s.parseTabRow(raw), { dm: [], player: [] }, raw);
});
