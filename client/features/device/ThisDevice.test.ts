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
