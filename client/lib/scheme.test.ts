import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The page's scheme (lib/scheme.ts): the stored Theme choice resolved to
 * dark or light, written on the document's root, followed across windows
 * and held dark for a page that keeps one look. A stand-in document,
 * storage, media query and window, set before the module loads, since the
 * choice is read once as the page starts. The cases run in order on one
 * page, each starting from what the last left.
 */

const stored = new Map<string, string>();
const storage = { writes: true };
const media = { light: false, listeners: new Set<() => void>() };
const storageListeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
const root = { props: new Map<string, string>(), colorScheme: "", dataset: {} as Record<string, string> };
const meta = { content: "#16161a" };

Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem(k: string, v: string) {
      if (!storage.writes) throw new DOMException("full", "QuotaExceededError");
      stored.set(k, String(v));
    },
    removeItem: (k: string) => stored.delete(k),
  },
  matchMedia: (query: string) => {
    assert.equal(query, "(prefers-color-scheme: light)");
    return {
      get matches() {
        return media.light;
      },
      addEventListener: (_: "change", listener: () => void) => media.listeners.add(listener),
    };
  },
  window: { addEventListener: (_: "storage", listener: (event: { key: string | null; newValue: string | null }) => void) => storageListeners.add(listener) },
  document: {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => root.props.set(name, value),
        set colorScheme(value: string) {
          root.colorScheme = value;
        },
      },
      dataset: root.dataset,
    },
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? { setAttribute: (_: "content", value: string) => (meta.content = value) } : null),
  },
});

function systemTurns(light: boolean): void {
  media.light = light;
  for (const listener of media.listeners) listener();
}

/** Another window of the app writing the choice, as the browser tells this one. */
function otherWindowStores(value: string | null, key: string | null = "rvtt.theme"): void {
  if (key !== null && value !== null) stored.set(key, value);
  if (key === null) stored.clear();
  for (const listener of storageListeners) listener({ key, newValue: value });
}

stored.set("rvtt.theme", "light");
const { holdScheme, resolveScheme, rootLook, scheme, startScheme, subscribeScheme, useScheme } = await import("./scheme.ts");
const { parseThemeChoice, setThemeChoice, themeChoice } = await import("../features/device/settings.ts");
const { accentFor } = await import("./accent.ts");
const { paletteVars, PALETTES } = await import("./theme.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

/** Whether the root carries exactly the scheme's look. */
function assertRoot(expected: "dark" | "light"): void {
  for (const [name, value] of Object.entries(paletteVars(expected))) assert.equal(root.props.get(name), value, name);
  assert.equal(root.props.get("--rvtt-base-accent"), accentFor(null, expected).accent);
  assert.equal(root.colorScheme, expected);
  assert.equal(root.dataset.rvttScheme, expected);
  assert.equal(meta.content, PALETTES[expected].bg);
  assert.equal(scheme(), expected);
}

describe("the theme choice", () => {
  test("is Dark at first, and anything stored but light or auto reads as dark", () => {
    assert.equal(parseThemeChoice(null), "dark");
    for (const raw of ["", "Dark", "LIGHT", "system", "1", "dark"]) assert.equal(parseThemeChoice(raw), "dark", raw);
    assert.equal(parseThemeChoice("light"), "light");
    assert.equal(parseThemeChoice("auto"), "auto");
  });

  test("Auto takes the device's own setting, and Dark and Light ignore it", () => {
    for (const system of [true, false]) {
      assert.equal(resolveScheme("dark", system), "dark");
      assert.equal(resolveScheme("light", system), "light");
      assert.equal(resolveScheme("auto", system), system ? "light" : "dark");
    }
  });

  test("the root's look: every palette color and shadow, the scheme's crest accent, and a black status strip only in a light home-screen app", () => {
    const light = rootLook("light", true);
    assert.deepEqual(light.vars, { ...paletteVars("light"), "--rvtt-base-accent": "#675c00", "--rvtt-base-on-accent": "#ffffff", "--rvtt-base-accent-tint": "rgba(103, 92, 0, 0.14)", "--rvtt-base-selection": "rgba(103, 92, 0, 0.4)", "--rvtt-status-band": "#000000" });
    assert.equal(light.themeColor, "#f3f1ec");
    assert.equal(rootLook("light", false).vars["--rvtt-status-band"], "transparent");
    assert.equal(rootLook("dark", true).vars["--rvtt-status-band"], "transparent");
    assert.equal(rootLook("dark", false).vars["--rvtt-base-accent"], "#f7df00");
  });
});

describe("the page's scheme", () => {
  let heard = 0;
  subscribeScheme(() => heard++);

  test("is dark before it starts, as the tokens' fallbacks are, and a render outside the browser reads dark", () => {
    assert.equal(scheme(), "dark");
    assert.equal(root.props.size, 0, "nothing written yet");
    const Probe = () => createElement("i", null, useScheme());
    assert.equal(renderToStaticMarkup(createElement(Probe)), "<i>dark</i>");
  });

  test("starts from the stored choice, writing the scheme on the root, and a second start does nothing", () => {
    startScheme();
    assertRoot("light");
    assert.equal(heard, 1);
    startScheme();
    assert.equal(media.listeners.size, 1);
    assert.equal(storageListeners.size, 1);
  });

  test("a choice changes the page at once and is stored", () => {
    setThemeChoice("dark");
    assertRoot("dark");
    assert.equal(stored.get("rvtt.theme"), "dark");
    assert.equal(heard, 2);
    setThemeChoice("dark");
    assert.equal(heard, 2, "the same choice again tells no one");
  });

  test("Auto follows the device's own setting and its change, with no reload", () => {
    setThemeChoice("auto");
    assertRoot("dark");
    systemTurns(true);
    assertRoot("light");
    systemTurns(false);
    assertRoot("dark");
    setThemeChoice("light");
    systemTurns(true);
    systemTurns(false);
    assertRoot("light");
  });

  test("a choice made in another window is taken as the device's own, and another key is not", () => {
    otherWindowStores("dark");
    assertRoot("dark");
    assert.equal(themeChoice(), "dark");
    otherWindowStores("light", "rvtt.uiScale");
    assertRoot("dark");
    otherWindowStores("light");
    assertRoot("light");
    // Another window cleared all storage, which leaves the default.
    otherWindowStores(null, null);
    assertRoot("dark");
    assert.equal(themeChoice(), "dark");
  });

  test("a held page stays dark, and its release gives back the device's latest choice, one made meanwhile in another window included", () => {
    setThemeChoice("light");
    const release = holdScheme("dark");
    assertRoot("dark");
    otherWindowStores("auto");
    systemTurns(true);
    assertRoot("dark");
    assert.equal(themeChoice(), "auto");
    release();
    assertRoot("light");
    systemTurns(false);
    assertRoot("dark");
  });

  test("holds nest, and a second release does nothing", () => {
    setThemeChoice("light");
    const outer = holdScheme("dark");
    const inner = holdScheme("dark");
    inner();
    inner();
    assertRoot("dark");
    outer();
    assertRoot("light");
  });

  test("with storage full, a choice lasts for the page", () => {
    storage.writes = false;
    try {
      setThemeChoice("dark");
      assertRoot("dark");
      assert.equal(stored.get("rvtt.theme"), "light", "the write failed");
      setThemeChoice("light");
      assertRoot("light");
    } finally {
      storage.writes = true;
    }
  });
});
