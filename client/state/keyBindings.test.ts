import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bindable,
  bindingOf,
  captureKey,
  changeKey,
  formatKeyChanges,
  holder,
  keysInEffect,
  NOT_A_KEY,
  parseKeyChanges,
  pressKeys,
  resetKey,
  sameKey,
  swapKey,
  WITH_MODIFIER,
  type KeyChanges,
  type KeyEvent,
  type KeyMap,
} from "./keyBindings.ts";
import { DEFAULT_KEYS } from "./shortcuts.ts";

/** A small table's defaults, so each case reads on its own. */
const DEFAULTS: KeyMap = { "tool:select": "v", "tool:fog": "f", "tool:ruler": "r", zoomIn: "+", fit: "0", sheet: "?" };

function press(overrides: Partial<KeyEvent>): KeyEvent {
  return { key: "f", code: "KeyF", ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...overrides };
}

describe("what a key press binds", () => {
  test("a letter binds lowercase, with Shift too, and a non-Latin layout's letter binds the Latin letter of its place", () => {
    assert.deepEqual(captureKey(press({ key: "x", code: "KeyX" })), { t: "key", key: "x" });
    assert.deepEqual(captureKey(press({ key: "X", code: "KeyX" })), { t: "key", key: "x" }, "Shift or Caps Lock");
    // AZERTY: the A key sits where QWERTY has Q, and binds the letter it prints.
    assert.deepEqual(captureKey(press({ key: "a", code: "KeyQ" })), { t: "key", key: "a" });
    // Russian: the key at X types ч.
    assert.deepEqual(captureKey(press({ key: "ч", code: "KeyX" })), { t: "key", key: "x" });
    assert.deepEqual(captureKey(press({ key: "Ч", code: "KeyX" })), { t: "key", key: "x" });
    // Greek: the key at Q types ;, a symbol, which binds as it is printed.
    assert.deepEqual(captureKey(press({ key: ";", code: "KeyQ" })), { t: "key", key: ";" });
    // Russian: ё has no Latin letter's place.
    assert.deepEqual(captureKey(press({ key: "ё", code: "Backquote" })), { t: "key", key: "ё" });
  });

  test("a digit or a symbol binds the character it types, Shift and all", () => {
    assert.deepEqual(captureKey(press({ key: "?", code: "Slash" })), { t: "key", key: "?" });
    assert.deepEqual(captureKey(press({ key: "=", code: "Equal" })), { t: "key", key: "=" });
    // AZERTY: 1 is Shift and the & key, and each binds what it types.
    assert.deepEqual(captureKey(press({ key: "1", code: "Digit1" })), { t: "key", key: "1" });
    assert.deepEqual(captureKey(press({ key: "&", code: "Digit1" })), { t: "key", key: "&" });
  });

  test("Escape cancels, and Shift alone or a held key's repeat waits for the key", () => {
    assert.deepEqual(captureKey(press({ key: "Escape", code: "Escape" })), { t: "cancel" });
    assert.deepEqual(captureKey(press({ key: "Escape", code: "Escape", ctrlKey: true })), { t: "cancel" });
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]) assert.deepEqual(captureKey(press({ key, code: key })), { t: "wait" }, key);
    assert.deepEqual(captureKey(press({ key: "x", code: "KeyX", repeat: true })), { t: "wait" });
  });

  test("a key that stays as it is is refused, with the reason", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.deepEqual(captureKey(press({ key: "x", code: "KeyX", ...mod })), { t: "refused", reason: WITH_MODIFIER });
    const reason = (key: string) => {
      const got = captureKey(press({ key, code: key }));
      return got.t === "refused" ? got.reason : null;
    };
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]) assert.match(reason(key) ?? "", /arrow and Page keys/, key);
    for (const key of ["Delete", "Backspace"]) assert.match(reason(key) ?? "", /deleting tokens/, key);
    for (const key of ["Enter", "Tab"]) assert.match(reason(key) ?? "", /Enter and Tab/, key);
    assert.match(reason(" ") ?? "", /^Space stays/);
    for (const key of ["F5", "Home", "End", "Insert", "Dead", "Unidentified", "Process", "ContextMenu"]) assert.equal(reason(key), NOT_A_KEY, key);
  });

  test("a binding is one printable character in lowercase", () => {
    for (const key of ["a", "z", "0", "?", "/", "+", ",", "ё"]) assert.equal(bindable(key), true, key);
    for (const key of ["", "A", "ab", " ", "\n", "​", "\u0007", "Escape"]) assert.equal(bindable(key), false, JSON.stringify(key));
    assert.equal(bindingOf({ key: "Enter", code: "Enter" }), null);
  });
});

describe("which bindings a press reaches", () => {
  test("the character it types first, then the Latin letter of its place", () => {
    assert.deepEqual(pressKeys({ key: "f", code: "KeyF" }), ["f"]);
    assert.deepEqual(pressKeys({ key: "F", code: "KeyF" }), ["f"]);
    assert.deepEqual(pressKeys({ key: "а", code: "KeyF" }), ["а", "f"]);
    // AZERTY: the key where QWERTY has M types a comma.
    assert.deepEqual(pressKeys({ key: ",", code: "KeyM" }), [",", "m"]);
    assert.deepEqual(pressKeys({ key: "?", code: "Slash" }), ["?"]);
    assert.deepEqual(pressKeys({ key: "ArrowUp", code: "ArrowUp" }), []);
  });

  test("+ and = are one key", () => {
    assert.equal(sameKey("+", "="), true);
    assert.equal(sameKey("=", "+"), true);
    assert.equal(sameKey("+", "+"), true);
    assert.equal(sameKey("+", "-"), false);
    assert.equal(holder(DEFAULTS, "tool:fog", "="), "zoomIn");
  });
});

describe("the stored changes", () => {
  test("they keep a version, and read back what was written", () => {
    const changes = { "tool:fog": "x", sheet: "/" };
    assert.equal(formatKeyChanges(changes), '{"v":1,"keys":{"tool:fog":"x","sheet":"/"}}');
    assert.deepEqual(parseKeyChanges(formatKeyChanges(changes)), changes);
  });

  test("anything unreadable is no changes, and an entry that is no binding is left out", () => {
    assert.deepEqual(parseKeyChanges(null), {});
    assert.deepEqual(parseKeyChanges("not json"), {});
    assert.deepEqual(parseKeyChanges("[]"), {});
    assert.deepEqual(parseKeyChanges('{"v":2,"keys":{"tool:fog":"x"}}'), {}, "a later version");
    assert.deepEqual(parseKeyChanges('{"keys":{"tool:fog":"x"}}'), {}, "no version");
    assert.deepEqual(parseKeyChanges('{"v":1,"keys":["x"]}'), {});
    assert.deepEqual(parseKeyChanges('{"v":1,"keys":{"tool:fog":"x","tool:ruler":3,"fit":"ArrowUp","sheet":" ","grid":"G"}}'), { "tool:fog": "x" });
  });
});

describe("the keys in effect", () => {
  test("the defaults, with each change that still makes sense", () => {
    assert.deepEqual(keysInEffect(DEFAULTS, {}), DEFAULTS);
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "x" }), { ...DEFAULTS, "tool:fog": "x" });
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "x", "tool:select": "f" }), { ...DEFAULTS, "tool:fog": "x", "tool:select": "f" }, "a key another change set free");
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "v", "tool:select": "f" }), { ...DEFAULTS, "tool:fog": "v", "tool:select": "f" }, "a swap");
  });

  test("a change for a shortcut the table no longer has, or to a key that stays as it is, is ignored", () => {
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:gone": "x", toString: "y", __proto__: "z" } as KeyChanges), DEFAULTS);
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": " " }), DEFAULTS);
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "ArrowUp" }), DEFAULTS);
  });

  test("a change that shares a key is ignored for its row, which takes its default", () => {
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "v" }), DEFAULTS, "with a default");
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "=" }), DEFAULTS, "= is Zoom in's");
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "x", "tool:ruler": "x" }), DEFAULTS, "with each other");
    // Fog and Ruler clash on v, and once Fog has F back, Select's F clashes too.
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "v", "tool:ruler": "v", "tool:select": "f" }), DEFAULTS);
    assert.deepEqual(keysInEffect(DEFAULTS, { "tool:fog": "v", "tool:ruler": "v", "tool:select": "q" }), { ...DEFAULTS, "tool:select": "q" });
  });
});

describe("changing, swapping and resetting a key", () => {
  test("a free key is the row's, and only changes from the defaults are kept", () => {
    assert.deepEqual(changeKey(DEFAULTS, {}, "tool:fog", "x"), { t: "done", changes: { "tool:fog": "x" } });
    assert.deepEqual(changeKey(DEFAULTS, { "tool:fog": "x" }, "tool:fog", "f"), { t: "done", changes: {} }, "back to the default");
    assert.deepEqual(changeKey(DEFAULTS, { "tool:fog": "x" }, "tool:fog", "x"), { t: "done", changes: { "tool:fog": "x" } }, "its own key");
    assert.deepEqual(changeKey(DEFAULTS, { "tool:fog": "x" }, "tool:select", "f"), { t: "done", changes: { "tool:fog": "x", "tool:select": "f" } });
  });

  test("a key another row has says which, and changes nothing", () => {
    assert.deepEqual(changeKey(DEFAULTS, {}, "tool:fog", "r"), { t: "taken", by: "tool:ruler" });
    assert.deepEqual(changeKey(DEFAULTS, {}, "tool:fog", "="), { t: "taken", by: "zoomIn" });
    assert.deepEqual(changeKey(DEFAULTS, { "tool:ruler": "x" }, "tool:fog", "x"), { t: "taken", by: "tool:ruler" });
  });

  test("a swap gives the other row this one's key", () => {
    assert.deepEqual(swapKey(DEFAULTS, {}, "tool:fog", "r"), { "tool:fog": "r", "tool:ruler": "f" });
    assert.deepEqual(swapKey(DEFAULTS, { "tool:fog": "r", "tool:ruler": "f" }, "tool:fog", "f"), {}, "swapped back, nothing is kept");
    assert.deepEqual(swapKey(DEFAULTS, { "tool:fog": "x" }, "tool:select", "x"), { "tool:select": "x", "tool:fog": "v" });
    assert.deepEqual(swapKey(DEFAULTS, {}, "tool:fog", "q"), { "tool:fog": "q" }, "a free key needs no swap");
  });

  test("reset gives the default back, swapping with a row that took it since", () => {
    assert.deepEqual(resetKey(DEFAULTS, { "tool:fog": "x", fit: "9" }, "tool:fog"), { fit: "9" });
    assert.deepEqual(resetKey(DEFAULTS, { "tool:fog": "x", "tool:ruler": "f" }, "tool:fog"), { "tool:ruler": "x" });
    assert.deepEqual(resetKey(DEFAULTS, {}, "tool:fog"), {});
    assert.deepEqual(resetKey(DEFAULTS, { "tool:fog": "x" }, "tool:gone"), { "tool:fog": "x" });
  });

  /*
   * Many random runs of what the sheet does (change, a refused key, swap,
   * reset, reset all, and a store edited by hand) on the room's real
   * table. Invariants, after every step:
   * 1. no two shortcuts share a key in effect,
   * 2. what is kept holds only changes from the defaults, each of them in effect,
   * 3. it reads back from storage as it was written,
   * 4. a change that went through gives the row its key, and a taken key changes nothing.
   */
  test("random runs of changes, swaps and resets never leave two shortcuts on one key", () => {
    const ids = Object.keys(DEFAULT_KEYS);
    const pool = [...new Set([...Object.values(DEFAULT_KEYS), ..."abcdefghijklmnopqrstuvwxyz0123456789,.;'[]=-/?", " ", "ArrowUp"])];
    let seed = 20261018;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const pick = <T>(list: readonly T[]): T => list[random(list.length)]!;
    for (let run = 0; run < 300; run++) {
      let changes: KeyChanges = {};
      // Edited by hand since the sheet last wrote it, so it may hold changes that do not hold.
      let byHand = false;
      for (let step = 0; step < 40; step++) {
        const id = pick(ids);
        const key = pick(pool);
        const before = keysInEffect(DEFAULT_KEYS, changes);
        const roll = random(20);
        const wrote = (next: KeyChanges) => {
          changes = next;
          byHand = false;
        };
        if (roll < 7) {
          const got = changeKey(DEFAULT_KEYS, changes, id, key);
          if (got.t === "done") {
            if (bindable(key)) assert.equal(keysInEffect(DEFAULT_KEYS, got.changes)[id], key, `${id} takes ${key}`);
            wrote(got.changes);
          } else {
            assert.ok(got.by !== id && sameKey(before[got.by]!, key), `${key} is ${got.by}'s`);
            assert.deepEqual(keysInEffect(DEFAULT_KEYS, changes), before, "a taken key changes nothing");
          }
        } else if (roll < 11) {
          wrote(swapKey(DEFAULT_KEYS, changes, id, key));
          if (bindable(key)) assert.equal(keysInEffect(DEFAULT_KEYS, changes)[id], key);
        } else if (roll < 14) {
          wrote(resetKey(DEFAULT_KEYS, changes, id));
          assert.equal(keysInEffect(DEFAULT_KEYS, changes)[id], DEFAULT_KEYS[id]);
        } else if (roll === 14) {
          wrote({});
        } else {
          // A store edited by hand, or written by a table with other defaults, which every read must survive.
          changes = { ...changes, [id]: key };
          byHand = true;
        }
        const keys = keysInEffect(DEFAULT_KEYS, changes);
        const inUse = Object.values(keys);
        for (const [i, k] of inUse.entries()) assert.ok(!inUse.some((other, j) => j !== i && sameKey(other, k)), `two rows on ${k}: ${JSON.stringify(changes)}`);
        assert.deepEqual(parseKeyChanges(formatKeyChanges(changes)), Object.fromEntries(Object.entries(changes).filter(([, k]) => bindable(k))));
        if (byHand) continue;
        for (const [cid, k] of Object.entries(changes)) {
          assert.notEqual(k, DEFAULT_KEYS[cid], `${cid} kept at its default`);
          assert.equal(keys[cid], k, `${cid}'s kept change is in effect`);
        }
      }
    }
  });
});
