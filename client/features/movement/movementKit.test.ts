import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";
import { theme } from "../../lib/theme.ts";
import { raised, thorn, world } from "./testing.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createStore } = await import("zustand/vanilla");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RoomProvider } = await import("../../state/view.ts");
const { stopNoteSlot } = await import("./store.ts");
const { holdMarkSizes } = await import("./MoveLayer.tsx");
const { StopNoteHost } = await import("./StopNote.tsx");
const { GroundNotice } = await import("./GroundNotice.tsx");

/*
 * The movement feature's notes and marks on the kit (docs/design-v1-look-pass-2.md
 * D30 and D31): the hold mark scales as every other outline does, the
 * stopped walk's note takes the kit's sizes and says what Teleport here
 * does in words on the page, and the inside-the-ground line is a Note.
 */

function inRoom(view: RoomState, child: ReturnType<typeof createElement>, scope = new RoomScope()): string {
  const store = createStore(() => ({ view, you: { memberId: "dm", role: "dm" }, local: { actionBar: false, selectedId: null } }));
  const room = createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: child });
  return renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: room }));
}

describe("the hold mark (D30)", () => {
  test("its ring is the old 3 px at the pin and grows with the token's own ring", () => {
    assert.deepEqual(holdMarkSizes(40), { ringPx: 3, gapPx: 3, liftPx: 12 });
    const close = holdMarkSizes(80);
    assert.ok(close.ringPx > 3 && close.gapPx > 3, `closer in: ${JSON.stringify(close)}`);
    assert.equal(holdMarkSizes(11).ringPx, 3, "never thinner than 3 px");
  });

  test("its label stands over the chips, which grow with the zoom and the interface size", () => {
    assert.ok(holdMarkSizes(80).liftPx > holdMarkSizes(40).liftPx);
    setBoardInterfaceScale(1.3);
    try {
      assert.ok(holdMarkSizes(40).liftPx > 12, "at 130%");
    } finally {
      setBoardInterfaceScale(1);
    }
  });
});

describe("the stopped walk's note (D31)", () => {
  const view = world({ tokens: [thorn({ x: 4, y: 4 })] });
  const note = { tokenId: "thorn", sceneId: "s1", blocker: "wall" as const, door: null, ghost: { x: 7, y: 4 }, aim: { x: 7.5, y: 4.5 }, at: { x: 4, y: 4 }, searched: true as const, capped: true as const, n: null };
  function render(width: number): string {
    const scope = new RoomScope();
    const slot = scope.get(stopNoteSlot);
    slot.setState({ note });
    // A static render reads a store's first state (useSyncExternalStore's server snapshot), so the note is made the first.
    Object.assign(slot, { getInitialState: slot.getState });
    const scene = view.scenes.s1!;
    return inRoom(view, createElement(StopNoteHost, { scene, camera: { x: 0, y: 0, scale: 40 }, viewport: { width, height: 800 }, insets: { top: 52, right: 0, bottom: 60, left: 0 } }), scope);
  }

  test("is a map pane's width inside the canvas's margins", () => {
    assert.match(render(1280), /width:296px/);
    assert.match(render(300), /width:284px/);
  });

  test("wraps its whole sentence through the header's own wrap, not a span of its own", () => {
    const markup = render(1280);
    assert.match(markup, /-webkit-line-clamp:6/);
    assert.match(markup, /Too far to work out a way around\. Stopped at a wall\. There is no way around it that you have seen\./);
    assert.doesNotMatch(markup, /<span style="display:block;white-space:normal">/);
  });

  test("Teleport here says what it does in a line on the page, which describes it, not in a native title", () => {
    const markup = render(1280);
    const button = /<button[^>]*>[^<]*(?:<[^>]+>[^<]*)*?Teleport here/.exec(markup)?.[0] ?? "";
    const described = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    assert.ok(described, `the button is described: ${button}`);
    assert.doesNotMatch(button, /title="For Misty Step/);
    assert.match(markup, new RegExp(`<p id="${described.replace(/[:]/g, "\\$&")}"[^>]*>For Misty Step and anything else that passes walls\\. The walk to the wall is taken back, and the teleport does not count against Speed\\.</p>`));
  });
});

describe("inside the ground (D31)", () => {
  test("its line is the kit's warning Note, at the help size", () => {
    const view = world({ heights: raised(6, 0, 12, 12, 10), tokens: [thorn({ x: 7, y: 2, elevation: 0 })] });
    const markup = inRoom(view, createElement(GroundNotice, { token: view.tokens.thorn! }));
    assert.match(markup, new RegExp(`<p style="margin:0;font-size:${theme.font.small}px;[^"]*color:${theme.color.warning.replace(/[()]/g, "\\$&")}[^"]*">Inside the ground \\(10 ft below\\)\\.</p>`));
    assert.match(markup, /Stand on it/);
  });
});
