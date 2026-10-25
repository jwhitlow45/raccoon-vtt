import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createStore } = await import("zustand/vanilla");
const { room } = await import("#shared/testutil.ts");
const { RoomProvider } = await import("../../state/view.ts");
const { ImageField } = await import("./ImageField.tsx");

const store = createStore(() => ({ roomId: "image-room", view: room(), you: { memberId: "dm1", role: "dm" }, connection: "open", accessVersion: 1 }));
const assets = { url: (id: string, variant: string) => `/a/${id}/${variant}` };

/** The token panel's Image field, a 48 px wide preview in a footprint `aspect` wide for each unit tall: the least heights of its first line's two parts. */
function firstLine(aspect: number): { preview: number; pair: number } {
  const field = createElement(ImageField, { value: undefined, onChange() {}, shape: "square", aspect, canEdit: true, previewSize: 48, extra: { beside: null } });
  const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => null } as never, ui: {} as never, assets, children: field }));
  const pair = /data-image-pair="" style="[^"]*min-height:([\d.]+)px/.exec(markup);
  const preview = /<span style="display:flex;align-items:center;min-height:([\d.]+)px;flex:none">/.exec(markup);
  assert.ok(pair && preview, `the pair and the preview's line in ${markup}`);
  return { preview: Number(preview[1]), pair: Number(pair[1]) };
}

describe("the Image field's first line", () => {
  /*
   * The preview and the pair center on a first line as tall as the taller,
   * up to 64 px (LP22-ALIGN-1). A custom footprint's taller preview would
   * push the pair, and Crop, Remove and the other images under it, down by
   * half its height, so beyond 64 px the pair sits at the top, as it did
   * before (FU31 review F5, D-261025-1).
   */
  test("centers the pair on a preview up to 64 px tall, and sets it at the top of a taller one", () => {
    assert.deepEqual(firstLine(1), { preview: 48, pair: 48 }, "a square token");
    assert.deepEqual(firstLine(2), { preview: theme.touch, pair: theme.touch }, "a wide one, under the pair's 44 px");
    assert.deepEqual(firstLine(0.75), { preview: 64, pair: 64 }, "64 px tall");
    assert.deepEqual(firstLine(0.5), { preview: theme.touch, pair: theme.touch }, "96 px tall");
  });
});
