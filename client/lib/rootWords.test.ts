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
const { outcomeWords } = await import("../features/builder/WingPane.tsx");
const { pointerWords } = await import("./pointerWords.ts");
const { refusalText } = await import("../state/store.ts");
const { NO_TYPED_TOTALS } = await import("#shared/permissions.ts");
const { JOIN_CHANGED } = await import("#shared/rules/wingClear.ts");

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

describe("a refusal toast words the server's touch sentences for the pointer", () => {
  test("a mouse reads Click in the two sentences the server words with Tap, and a touch screen keeps Tap", () => {
    assert.equal(onDevice(false, () => refusalText("forbidden", NO_TYPED_TOTALS)), "The DM has turned off typed totals in this room. Click Roll instead.");
    assert.equal(onDevice(true, () => refusalText("forbidden", NO_TYPED_TOTALS)), "The DM has turned off typed totals in this room. Tap Roll instead.");
    assert.equal(onDevice(false, () => refusalText("invalid", JOIN_CHANGED)), "Not saved. The wall the wing joins has changed. Click it again.");
  });

  test("the wing pane's own toast and note for a changed join word it the same way", () => {
    assert.equal(onDevice(false, () => outcomeWords({ k: "join" } as never)), "The wall the wing joins has changed. Click it again.");
    assert.equal(onDevice(true, () => outcomeWords({ k: "join" } as never)), "The wall the wing joins has changed. Tap it again.");
  });

  test("a refusal that holds a name is never reworded, so a creature named Tap keeps its name", () => {
    assert.equal(onDevice(false, () => refusalText("forbidden", "Tap is not yours")), "Tap is not yours.");
    assert.equal(onDevice(false, () => refusalText("invalid", "Tap Room is full. Tap Roll instead")), "Not saved. Tap Room is full. Tap Roll instead.");
  });
});
