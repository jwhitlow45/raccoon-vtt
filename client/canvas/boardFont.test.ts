import assert from "node:assert/strict";
import { test } from "node:test";

/** A stand-in for document.fonts: what boardFont.ts listens to and asks for. */
class FakeFonts extends EventTarget {
  asked: string[] = [];
  load(font: string): Promise<unknown[]> {
    this.asked.push(font);
    return Promise.resolve([]);
  }
  done(faces: { family: string; style: string }[]): void {
    this.dispatchEvent(Object.assign(new Event("loadingdone"), { fontfaces: faces }));
  }
}

test("the board's text is measured again only when Inter's roman face loads, and Inter is asked for at once", async () => {
  const fonts = new FakeFonts();
  Object.assign(globalThis, { document: { fonts } });
  try {
    const { boardFontEpoch } = await import("./boardFont.ts");
    assert.deepEqual(fonts.asked, ["16px Inter"]);
    const start = boardFontEpoch();

    fonts.done([{ family: "Inter", style: "italic" }]);
    fonts.done([{ family: "Roboto", style: "normal" }]);
    assert.equal(boardFontEpoch(), start, "the italic and other fonts draw nothing on the board");

    fonts.done([{ family: '"Inter"', style: "normal" }]);
    assert.equal(boardFontEpoch(), start + 1);
    fonts.done([{ family: "Inter", style: "normal" }, { family: "Inter", style: "italic" }]);
    assert.equal(boardFontEpoch(), start + 2);
  } finally {
    Reflect.deleteProperty(globalThis, "document");
  }
});
