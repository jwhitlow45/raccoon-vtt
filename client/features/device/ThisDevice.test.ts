import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * This device's help names the keys for Full screen and Next turn as the
 * device has them. A shortcut can have no key (state/keyBindings.ts
 * keysInEffect), and its help read "With a keyboard,  turns it on and off."
 * with a gap for the key (ISO5P2-OPUS-1).
 */

const { fullscreenHelp, shortcutsHelp } = await import("./ThisDevice.tsx");
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

/*
 * Sounds (docs/design/design-v1-volume.md 4): this device's volume
 * controls as This device draws them, with its search anchors and their
 * status line, no Room sound switch, and a player's line while Only DM
 * devices play, which the DM's device never shows. The whole page needs a
 * browser, so this renders the controls with This device's props, and
 * the e2e sweep (search-sweep) opens each anchor on the page.
 */
describe("This device's Sounds", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createStore } = await import("zustand/vanilla");
  const { room } = await import("#shared/testutil.ts");
  const { RoomProvider } = await import("../../state/view.ts");
  const { DeviceSound } = await import("../sound/device/DeviceSound.tsx");
  const noop = () => {};

  const sounds = (role: "dm" | "player", dmOnly: boolean) => {
    const view = room();
    if (dmOnly) view.meta.settings = { ...view.meta.settings, soundDmOnly: true };
    const store = createStore(() => ({ view, you: { memberId: role === "dm" ? "dm1" : "p1", role }, roomId: "r1", sceneId: "s1", serverOffset: 0, connection: "open", pending: [], online: [], displays: 0, local: { selectedIds: [], multi: false } }));
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1, newId: () => "x", sendEph: noop } as never, ui: { notify: noop, openPanel: noop } as never, display: false, children: createElement(DeviceSound, { line: true, anchored: true }) }));
  };

  test("the volume controls with their anchors, and no Room sound", () => {
    const html = sounds("player", false);
    for (const id of ["volume", "music", "loops", "effects", "turn", "ping"]) assert.ok(html.includes(`data-search="menu.this-device.sounds.${id}"`), id);
    assert.ok(!html.includes("Room sound") && !html.includes("menu.this-device.sounds.room"));
  });

  test("a player's device says the DM plays it while Only DM devices play, once, and a DM's never", () => {
    const line = "The DM plays the sound on their own device.";
    assert.equal(sounds("player", true).split(line).length, 2, "once");
    assert.ok(!sounds("player", false).includes(line));
    assert.ok(!sounds("dm", true).includes(line), "a DM's device plays it");
    assert.ok(sounds("player", true).includes("At one table, the DM can turn on Only DM devices play in Sound."), "the player's help keeps its pointer");
  });
});
