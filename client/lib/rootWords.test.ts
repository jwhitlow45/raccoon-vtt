import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

/*
 * The shared components that word "Tap" for the device's main pointer
 * (client/lib/pointerWords.ts): a mouse reads "Click", a touch screen keeps
 * "Tap", and a name from the room is never reworded, whatever it is called.
 * Server rendering never presses a button, so the three ConfirmButtons are
 * loaded already armed, as the display hold's test runs its effects.
 */

registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!/\/(scenes\/controls|tokens\/ui|measure\/controls)\.tsx$/.test(url)) return result;
    const source = String(result.source);
    const armed = source.replaceAll("const [armed, setArmed] = useState(false);", "const [armed, setArmed] = useState(true);");
    assert.notEqual(source, armed, "each ConfirmButton file has its armed state to start on");
    return { ...result, source: armed };
  },
});

let coarse = false;
(globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: coarse && query === "(pointer: coarse)" });

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ConfirmButton: SceneConfirm } = await import("../features/scenes/controls.tsx");
const { ConfirmButton: TokenConfirm } = await import("../features/tokens/ui.tsx");
const { ConfirmButton: OptionsConfirm } = await import("../features/measure/controls.tsx");
const { Help, Note } = await import("../components/Panel.tsx");
const { Note: TokenNote } = await import("../features/tokens/ui.tsx");
const { pointerWords } = await import("./pointerWords.ts");

function html(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element);
}

function onDevice<T>(touch: boolean, run: () => T): T {
  coarse = touch;
  try {
    return run();
  } finally {
    coarse = false;
  }
}

const NOOP = () => {};

/** What JSX gives a line: the string alone, or the parts of it. */
function kids(parts: string[]): string | string[] {
  return parts.length === 1 ? parts[0]! : parts;
}

describe("the three ConfirmButtons word their second press for the pointer", () => {
  const buttons = {
    "the scenes one": (confirm: string, worded?: true) => createElement(SceneConfirm, { label: "Remove", confirm, ...(worded ? { worded } : null), onConfirm: NOOP }),
    "the token panel's": (confirm: string, worded?: true) => createElement(TokenConfirm, { confirm, ...(worded ? { worded } : null), onConfirm: NOOP, children: "Delete" }),
    "the options kit's": (confirm: string, worded?: true) => createElement(OptionsConfirm, { label: "Remove", confirm, ...(worded ? { worded } : null), onConfirm: NOOP }),
  };
  for (const [name, button] of Object.entries(buttons)) {
    test(`${name} reads Click on a mouse and Tap on a touch screen`, () => {
      assert.match(onDevice(false, () => html(button("Tap again to delete"))), />Click again to delete</);
      assert.match(onDevice(true, () => html(button("Tap again to delete"))), />Tap again to delete</);
    });
    test(`${name} keeps words a caller already chose for a name, on both devices`, () => {
      const said = (touch: boolean) => onDevice(touch, () => pointerWords("Tap again: the map switches to {name}", { name: "Tap" }));
      assert.match(onDevice(false, () => html(button(said(false), true))), />Click again: the map switches to Tap</);
      assert.match(onDevice(true, () => html(button(said(true), true))), />Tap again: the map switches to Tap</);
    });
  }
});

describe("Help and both Notes word fixed text for the pointer", () => {
  const lines = {
    Help: (props: { tapWords?: true }, ...children: string[]) => createElement(Help, { ...props, children: kids(children) }),
    "the warning Note": (props: { tapWords?: true }, ...children: string[]) => createElement(Note, { ...props, children: kids(children) }),
    "the token panel's Note": (props: { tapWords?: true }, ...children: string[]) => createElement(TokenNote, { ...props, children: kids(children) }),
  };
  for (const [name, line] of Object.entries(lines)) {
    test(`${name} reads Click on a mouse and Tap on a touch screen, in text and in parts`, () => {
      assert.match(onDevice(false, () => html(line({ tapWords: true }, "Tap rows to pick creatures."))), />Click rows to pick creatures\.</);
      assert.match(onDevice(true, () => html(line({ tapWords: true }, "Tap rows to pick creatures."))), />Tap rows to pick creatures\.</);
      assert.match(onDevice(false, () => html(line({ tapWords: true }, "Then tap the map where ", "it goes", "."))), />Then click the map where it goes\.</);
    });
    test(`${name} leaves a line alone that holds a name, as a thing named Tap reads as named`, () => {
      const named = (touch: boolean) => pointerWords("{name} is picked. Tap more rows.", { name: "Tap" }, touch);
      assert.match(onDevice(false, () => html(line({}, named(false)))), />Tap is picked\. Click more rows\.</);
      assert.match(onDevice(true, () => html(line({}, named(true)))), />Tap is picked\. Tap more rows\.</);
      assert.match(onDevice(false, () => html(line({}, "Tap Room is the scene"))), />Tap Room is the scene</, "no tapWords, no rewording");
    });
  }
});
