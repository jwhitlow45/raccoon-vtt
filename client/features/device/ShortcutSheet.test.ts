import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * What the shortcut sheet asks once the key pressed for a row is taken.
 * From a row with a key, Swap gives the other row that key. From a row
 * with no key, the other row is left with none, or with its own default
 * back where the change that took this row's key goes with the swap, and
 * "Swap the two keys" told neither (ISO5P2-OPUS-5).
 */

const { takenWords } = await import("./ShortcutSheet.tsx");

const names: Record<string, string> = { "tool:fog": "Fog", "tool:ruler": "Ruler", turnLeft: "Turn left" };
const nameOf = (id: string) => names[id] ?? id;

describe("the sheet's question for a taken key", () => {
  test("from a row with a key, the two swap", () => {
    assert.deepEqual(takenWords({}, { id: "tool:fog", key: "r", by: "tool:ruler" }, nameOf), {
      line: "Already Ruler.",
      say: "R is already used by Ruler. Swap the two keys, or cancel.",
      button: "Swap",
    });
  });

  test("from a row with no key, a key another row has by default leaves that row with no key", () => {
    // Fog moved onto Q, Turn left's default, so Turn left has no key, and R is Ruler's own.
    assert.deepEqual(takenWords({ "tool:fog": "q" }, { id: "turnLeft", key: "r", by: "tool:ruler" }, nameOf), {
      line: "Already Ruler. Ruler will have no key.",
      say: "R is already used by Ruler. Ruler will have no key. Take it, or cancel.",
      button: "Take",
    });
  });

  test("from a row with no key, taking back its own default gives the other row its default again", () => {
    assert.deepEqual(takenWords({ "tool:fog": "q" }, { id: "turnLeft", key: "q", by: "tool:fog" }, nameOf), {
      line: "Already Fog. Fog goes back to F.",
      say: "Q is already used by Fog. Fog goes back to F. Take it, or cancel.",
      button: "Take",
    });
  });
});

describe("a part hidden on this device in the sheet (docs/design/design-v1-features.md 7)", () => {
  test("a hidden row keeps its key, and the question names it hidden", async () => {
    const { rowName } = await import("./ShortcutSheet.tsx");
    const { NO_CHOICES, withChoice } = await import("../modules/store.ts");
    const hidden = withChoice(NO_CHOICES, "dm", "ruler", false);
    assert.equal(rowName("tool:ruler", "dm", NO_CHOICES), "Ruler");
    assert.equal(rowName("tool:ruler", "dm", hidden), "Ruler, hidden on this device");
    assert.equal(takenWords({}, { id: "tool:fog", key: "r", by: "tool:ruler" }, (id) => rowName(id, "dm", hidden)).line, "Already Ruler, hidden on this device.");
    // Another role's row is hidden by that role's choices.
    assert.equal(rowName("tool:fog", "player", withChoice(NO_CHOICES, "player", "ruler", false)), "Fog, a DM key");
  });

  test("its rows leave the Keys section, which then ends with the muted line", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createStore } = await import("zustand/vanilla");
    const { RoomProvider } = await import("../../state/view.ts");
    const { ShortcutList, KEYS_LEFT_OUT } = await import("./ShortcutSheet.tsx");
    const { resetAllFeatures, setModuleShown } = await import("../modules/store.ts");
    const draw = () => {
      const store = createStore(() => ({ roomId: "K7QH2MXA", you: { memberId: "m1", role: "dm" }, view: null, local: {} }));
      return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(ShortcutList, { role: "dm" }) }));
    };
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: 1440, innerHeight: 900 } });
    try {
      resetAllFeatures();
      assert.ok(draw().includes(">Ruler<"));
      assert.ok(!draw().includes(KEYS_LEFT_OUT));
      setModuleShown("ruler", "dm", false);
      assert.ok(!draw().includes(">Ruler<"));
      assert.ok(draw().includes(KEYS_LEFT_OUT));
      assert.equal(KEYS_LEFT_OUT, "Keys of parts hidden on this device are left out.");
    } finally {
      resetAllFeatures();
      if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});

test("FU40-B: narrow rebinding rows give their controls both table columns and retain their key header", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ShortcutList } = await import("./ShortcutSheet.tsx");
  const { keyChanges, setKeyChanges } = await import("./settings.ts");
  const priorKeys = keyChanges();
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    setKeyChanges({ "tool:draw": "k", "tool:fog": "q" });
    for (const width of [320 / 1.3, 390 / 1.3, 320, 390, 1440]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { innerWidth: width, innerHeight: 568 } });
      const html = renderToStaticMarkup(createElement(ShortcutList, { role: "dm", rebind: true }));
      const rows = Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g), (m) => m[1]!);
      const controlled = rows.filter((row) => row.includes('aria-label="Change the key for '));
      assert.ok(controlled.length >= 20);
      assert.ok(controlled.some((row) => row.includes('aria-label="Reset the key for Draw"')));
      for (const row of controlled) {
        if (width < 320) {
          assert.match(row, /<td colSpan="2" headers="([^"]+)"/, "at 320 px and 390 px at 130%, Change and Reset need the whole row");
          assert.equal(row.includes("<th"), false, "the key and its description stay in the preceding row");
          const key = /headers="([^"]+)"/.exec(row)![1]!;
          const before = rows[rows.indexOf(row) - 1]!;
          assert.ok(before.includes(`id="${key}"`), "the controls name the preceding key header for table readers");
          assert.equal((before.match(/<(?:th|td) /g) ?? []).length, 2);
          assert.match(row, /display:flex;flex-wrap:wrap/);
        } else {
          assert.ok(row.includes("<th"), "wider lists keep Change beside its key and words");
          assert.equal((row.match(/<(?:th|td) /g) ?? []).length, 3);
        }
      }
    }
  } finally {
    setKeyChanges(priorKeys);
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
