import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * This device's help names the keys for Full screen and Next turn as the
 * device has them. A shortcut can have no key (state/keyBindings.ts
 * keysInEffect), and its help read "With a keyboard,  turns it on and off."
 * with a gap for the key (ISO5P2-OPUS-1).
 */

const { fullscreenHelp, shortcutsHelp, ROOM_SOUND_HELP } = await import("./ThisDevice.tsx");
const { THIS_DEVICE_ONLY } = await import("../sound/panel/words.ts");
const { DEFAULT_KEYS } = await import("../../state/shortcuts.ts");
const { UNBOUND } = await import("../../state/keyBindings.ts");

describe("This device's help for a shortcut's key", () => {
  test("names the key a row has", () => {
    assert.equal(fullscreenHelp(DEFAULT_KEYS), "The room fills the whole screen, without the browser's bars. With a keyboard, W turns it on and off.");
    assert.match(shortcutsHelp(DEFAULT_KEYS), /^With a keyboard, letters pick tools, arrow keys move the selected tokens, and N moves the turn on\. /);
  });

  test("says a row with no key has none, and leaves no gap where a key would be", () => {
    const keys = { ...DEFAULT_KEYS, fullscreen: UNBOUND, turn: UNBOUND };
    const full = fullscreenHelp(keys);
    const turn = shortcutsHelp(keys);
    assert.equal(full, "The room fills the whole screen, without the browser's bars. Its shortcut has no key on this device.");
    assert.match(turn, /^With a keyboard, letters pick tools and arrow keys move the selected tokens\. Next turn has no key on this device\. /);
    for (const text of [full, turn]) assert.doesNotMatch(text, / {2}| \.|, \./, text);
  });
});

/*
 * Theme (docs/design/design-v1-light-theme.md 4.1): Dark, Light and Auto
 * in that order, Dark the device's first choice, in one radio group named
 * "Theme" whose description is the section's help.
 */
describe("This device's Theme section", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ThemeSection, THEME_HELP } = await import("./ThisDevice.tsx");
  const { themeChoice } = await import("./settings.ts");

  const draw = (value: "dark" | "light" | "auto") => renderToStaticMarkup(createElement(ThemeSection, { value, helpId: "theme-help" }));

  test("is one radio group named Theme, described by its help", () => {
    const markup = draw("dark");
    assert.match(markup, /<div role="radiogroup" aria-label="Theme" aria-describedby="theme-help"/);
    assert.match(markup, /<p id="theme-help"[^>]*>Auto follows this device&#x27;s own light or dark setting\. The map, the fog, the dice tray and the table display stay dark in Light too\.<\/p>/);
    assert.equal(THEME_HELP, "Auto follows this device's own light or dark setting. The map, the fog, the dice tray and the table display stay dark in Light too.");
  });

  test("offers Dark, Light and Auto in that order, with the given one chosen", () => {
    for (const value of ["dark", "light", "auto"] as const) {
      const markup = draw(value);
      const options = [...markup.matchAll(/<input type="radio"[^>]*?(checked="" )?value="([a-z]+)"\/>([A-Za-z]+)<\/label>/g)].map((m) => ({ value: m[2], word: m[3], checked: m[1] !== undefined }));
      assert.deepEqual(options.map((o) => [o.value, o.word]), [["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]], markup);
      assert.deepEqual(options.filter((o) => o.checked).map((o) => o.value), [value]);
    }
  });

  test("a new device shows Dark", () => {
    assert.equal(themeChoice(), "dark");
  });
});

/*
 * The Menu's This device row names Theme early (docs/design/design-v1-light-theme.md
 * 4.1), so the no-break space that holds "sheet handle" together still
 * ends the line, which grab-e checks at 390 px and 130%.
 */
test("the Menu's This device row names theme after the interface size, with or without full screen", async () => {
  const { deviceDetail } = await import("./ThisDevice.tsx");
  assert.equal(deviceDetail(true), "Interface size, theme, full screen, low power, map detail, weather, sounds, roll animation, shortcuts and sheet handle.");
  assert.equal(deviceDetail(false), "Interface size, theme, low power, map detail, weather, sounds, roll animation, shortcuts and sheet handle.");
});

test("Room sound's help starts with the scope, so it reads apart from Table sound's", () => {
  assert.ok(ROOM_SOUND_HELP.startsWith(`${THIS_DEVICE_ONLY} `));
  assert.ok(!ROOM_SOUND_HELP.includes('"'));
});

/*
 * Only DM devices play (docs/design/design-v1-sound-dm-only.md 5): Room
 * sound's help points a table at the DM's switch, not at one device, and a
 * player's Sounds says above Room sound that the DM plays it.
 */
describe("This device's Sounds while Only DM devices play", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createStore } = await import("zustand/vanilla");
  const { room } = await import("#shared/testutil.ts");
  const { RoomProvider } = await import("../../state/view.ts");
  const { DmPlaysNote } = await import("./ThisDevice.tsx");
  const noop = () => {};

  const note = (role: "dm" | "player", dmOnly: boolean, display = false) => {
    const view = room();
    if (dmOnly) view.meta.settings = { ...view.meta.settings, soundDmOnly: true };
    const store = createStore(() => ({ view, you: { memberId: role === "dm" ? "dm1" : "p1", role }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, display, children: createElement(DmPlaysNote) }));
  };

  test("Room sound's help, word for word, names the switch and no longer sends the sound to one device", () => {
    assert.equal(
      ROOM_SOUND_HELP,
      "This device only: Music, background sounds and effects the DM plays. If everyone sits at one table, the DM can turn on Only DM devices play in Sound. Music uses about 60 MB of data an hour. On an iPhone it pauses music from other apps and plays even with the ringer off.",
    );
    assert.doesNotMatch(ROOM_SOUND_HELP, /one device only|table display/);
  });

  test("the DM plays it, on a player's device while it is on, and nowhere else", () => {
    assert.match(note("player", true), /^<p[^>]*>The DM plays the sound on their own device\.<\/p>$/);
    assert.equal(note("player", false), "", "off");
    assert.equal(note("dm", true), "", "a DM's device plays it");
    assert.equal(note("player", true, true), "", "a table display's menu has its own Sound row");
    assert.equal(renderToStaticMarkup(createElement(DmPlaysNote)), "", "outside a room");
  });
});
