import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { DM, character } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Dialog } = await import("../../components/Dialog.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { ShapePicker } = await import("./ShapePicker.tsx");

test("the shape picker reserves scrollbar space on its dialog's scrolling body", () => {
  let checked = false;
  function Probe() {
    const picker = ShapePicker({ character: character("thorn"), onClose() {} });
    assert.equal(picker.type, Dialog);
    assert.equal(picker.props.bodyStyle?.scrollbarGutter, "stable");
    checked = true;
    return null;
  }
  renderToStaticMarkup(createElement(RoomProvider, {
    store: createStore(() => ({ roomId: "r1", you: DM })) as never,
    actions: {} as never,
    ui: {} as never,
    children: createElement(Probe),
  }));
  assert.ok(checked, "the picker rendered");
});
