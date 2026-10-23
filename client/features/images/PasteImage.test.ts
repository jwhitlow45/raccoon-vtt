import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * What a paste leaves under its entry (docs/design-v1-look-pass-2.md 2.2
 * and 2.9, D21 and D38). Its errors had three looks across the entries, so
 * the note's error is the one ErrorText and its other words Help. The paste
 * box's words stood inside the empty box, where they read as a placeholder
 * to type over, so they now stand over it and name it. Paste an image
 * names its wait while the browser answers.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PasteButton, PasteStatus } = await import("./PasteImage.tsx");
const { PasteControl } = await import("./pasteRouter.ts");
const { ErrorText } = await import("../../components/Field.tsx");

type Handle = Parameters<typeof PasteStatus>[0]["paste"];

function handle(view: { reading?: boolean; note?: { tone: "error" | "info"; text: string } | null; box?: boolean }): Handle {
  const control = new PasteControl({ spec: () => ({ accepts: "image", takes: "none", onFile() {} }) as never, read: null, now: () => new Date(), ios: false, boxHint: "", onChange() {} });
  return { reading: view.reading ?? false, note: (view.note ?? null) as never, box: view.box ?? false, press() {}, closeBox() {}, disabled: false, control };
}

const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

describe("a paste's note and box", () => {
  test("an error is the shared ErrorText, an alert at 14 px, and other words a Help line in a status", () => {
    const error = html(createElement(PasteStatus, { paste: handle({ note: { tone: "error", text: "The clipboard has no image in it." } }) }));
    assert.equal(error, html(createElement(ErrorText, { children: "The clipboard has no image in it." })));
    const info = html(createElement(PasteStatus, { paste: handle({ note: { tone: "info", text: "Pasted image.png." } }) }));
    assert.match(info, /^<div role="status"><p[^>]*>Pasted image.png.<\/p><\/div>$/);
  });

  test("the box's words stand over it and name it, never drawn inside it", () => {
    const box = html(createElement(PasteStatus, { paste: handle({ box: true }) }));
    const id = /<p id="([^"]+)"[^>]*>Press [^<]*<\/p>/.exec(box)?.[1];
    assert.ok(id, "the words are a line of their own");
    assert.match(box, new RegExp(`role="textbox" aria-labelledby="${id}"`));
    assert.doesNotMatch(box, /aria-hidden/, "no words laid over the box");
    assert.ok(box.indexOf(`id="${id}"`) < box.indexOf('role="textbox"'), "the words come before the box");
  });

  test("Paste an image names its wait while the browser answers", () => {
    assert.match(html(createElement(PasteButton, { paste: handle({ reading: true }) })), /aria-busy="true"[^>]*>.*Pasting…<\/button>$/);
    assert.match(html(createElement(PasteButton, { paste: handle({}) })), />Paste an image<\/button>$/);
    assert.match(html(createElement(PasteButton, { paste: handle({ reading: true }), label: "Paste from the clipboard" })), />.*Pasting…<\/button>$/);
  });
});
