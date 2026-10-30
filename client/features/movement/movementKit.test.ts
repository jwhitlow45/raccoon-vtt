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
const { COMPACT_NOTE_ROOM, FULL_NOTE_ROOM, StopNoteHost } = await import("./StopNote.tsx");
const { GroundNotice } = await import("./GroundNotice.tsx");
const { flatPick } = await import("../../canvas/boardPick.ts");

/** The chrome's camera in Top-down at one camera, as the board passes it (state/liveCamera.ts ChromeCamera). */
function flatChrome(camera: { x: number; y: number; scale: number }) {
  return { iso: false, rendered: camera, zoom: 1, pickOf: (c: typeof camera) => flatPick(c) };
}

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
  function render(width: number, height = 800, bottom = 60): string {
    const scope = new RoomScope();
    const slot = scope.get(stopNoteSlot);
    slot.setState({ note });
    // A static render reads a store's first state (useSyncExternalStore's server snapshot), so the note is made the first.
    Object.assign(slot, { getInitialState: slot.getState });
    const scene = view.scenes.s1!;
    return inRoom(view, createElement(StopNoteHost, { scene, chrome: flatChrome({ x: 0, y: 0, scale: 40 }), viewport: { width, height }, insets: { top: 52, right: 0, bottom, left: 0 } }), scope);
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

describe("the stopped walk's note on a short screen (review LP2L2-ASTRA-2)", () => {
  const view = world({ tokens: [thorn({ x: 4, y: 4 })] });
  // The capped search's note, the longest sentence there is.
  const note = { tokenId: "thorn", sceneId: "s1", blocker: "wall" as const, door: null, ghost: { x: 7, y: 4 }, aim: { x: 7.5, y: 4.5 }, at: { x: 4, y: 4 }, searched: true as const, capped: true as const, n: null };
  // 844 x 390 at 130%, in the chrome's own px: 649 x 300, the top bar 52 and the toolbar 60 over the map.
  function render(height = 300, width = 649): string {
    const scope = new RoomScope();
    const slot = scope.get(stopNoteSlot);
    slot.setState({ note });
    Object.assign(slot, { getInitialState: slot.getState });
    return inRoom(view, createElement(StopNoteHost, { scene: view.scenes.s1!, chrome: flatChrome({ x: 0, y: 0, scale: 12 }), viewport: { width, height }, insets: { top: 52, right: 0, bottom: 60, left: 0 } }), scope);
  }
  const topOf = (markup: string) => Number(/top:(\d+(?:\.\d+)?)px/.exec(markup)?.[1]);

  test("is no taller than the map between the bars, inside its margins", () => {
    const markup = render();
    assert.match(markup, /max-height:172px/);
    const top = topOf(markup);
    // Placed by its first frame's guess, 156 px, under the 172 px the bars leave.
    assert.ok(top >= 52 + 8 && top + 156 <= 300 - 60 - 8, `the note's top ${top} keeps it between the bars`);
  });

  test("on a screen shorter than its first guess, the guess is capped too, so its first frame keeps between the bars", () => {
    const markup = render(260);
    assert.match(markup, /max-height:132px/);
    assert.equal(topOf(markup), 52 + 8, "its top at the top bar's margin, its foot at the toolbar's");
  });

  test("where its usual rows fit, the help under Teleport here is the part that scrolls, so the sentence, Close and the action stay in view", () => {
    // 272 px between the bars.
    const markup = render(400);
    assert.match(markup, /grid-template-rows:auto auto minmax\(0, 1fr\)/);
    assert.match(markup, /-webkit-line-clamp:6/, "the sentence in the header");
    assert.match(markup, /<div style="min-height:0;overflow-y:auto;overscroll-behavior:contain"><p id="[^"]+"[^>]*>For Misty Step/);
    assert.doesNotMatch(markup, /data-stop-note-body/);
  });

  test("its usual rows need FULL_NOTE_ROOM: a six-line sentence, Teleport here, a line of help, the padding, borders and gaps", () => {
    assert.equal(FULL_NOTE_ROOM, 212);
    assert.doesNotMatch(render(FULL_NOTE_ROOM + 52 + 60 + 16), /data-stop-note-body/, "at the room it needs, the usual look");
    assert.match(render(FULL_NOTE_ROOM + 52 + 60 + 15), /data-stop-note-body/, "a pixel less, compact");
  });

  // 480 x 320 at 130% in the chrome's px: 369 x 246, which leaves 118 px between the bars (review LP2L2-ASTRA-2).
  test("compact where they cannot fit: the capped search's long sentence and the help scroll together as its body, Close beside them and Teleport here under them", () => {
    const markup = render(246, 369);
    assert.match(markup, /max-height:118px/);
    assert.match(markup, /grid-template-rows:minmax\(0, 1fr\) auto/);
    const body = /<div data-stop-note-body=""[^>]*overflow-y:auto[^>]*>([\s\S]*?)<\/div><button/.exec(markup);
    assert.ok(body, "a scrolling body, then Close");
    assert.match(body[1]!, /<span role="status" aria-live="polite">Too far to work out a way around\. Stopped at a wall\. There is no way around it that you have seen\.<\/span>/);
    assert.match(body[1]!, />For Misty Step and anything else that passes walls\./);
    assert.doesNotMatch(body[1]!, /<button/, "Close and Teleport here stand outside the body");
    assert.match(markup, /<\/div><button[^>]*aria-label="Close"/);
    assert.match(markup, /aria-describedby="[^"]+"[^>]*>(?:<[^>]+>)*Teleport here/);
    assert.doesNotMatch(markup, /data-stop-note-actions/, "118 px keeps Close beside the body");
  });

  // 480 x 320 at 130% over a phone's 21 px home bar leaves 97 px (review LP2L2-ASTRA-3).
  test("under COMPACT_NOTE_ROOM, Teleport here and Close share one row under the body, so neither runs over the other", () => {
    assert.equal(COMPACT_NOTE_ROOM, 114, "Close's 44 px over the action's 44, the padding, borders and gap");
    const markup = render(97 + 52 + 60 + 16, 369);
    assert.match(markup, /max-height:97px/);
    const row = /<div data-stop-note-actions=""[^>]*display:flex[^>]*>([\s\S]*)<\/div><\/div>$/.exec(markup);
    assert.ok(row, `one row of actions at the foot: ${markup}`);
    assert.match(row[1]!, /^<button[^>]*aria-describedby="[^"]+"[^>]*>(?:<[^>]+>)*Teleport here[\s\S]*<button[^>]*aria-label="Close"/, "Teleport here, then Close beside it");
    const body = /<div data-stop-note-body=""[^>]*overflow-y:auto[^>]*>([\s\S]*?)<\/div><div data-stop-note-actions/.exec(markup);
    assert.ok(body, "the body scrolls over the row");
    assert.doesNotMatch(body[1]!, /<button/);
    assert.doesNotMatch(render(COMPACT_NOTE_ROOM + 52 + 60 + 16, 369), /data-stop-note-actions/, "at COMPACT_NOTE_ROOM, Close stays beside the body");
    assert.match(render(COMPACT_NOTE_ROOM + 52 + 60 + 15, 369), /data-stop-note-actions/, "a pixel less, one row");
  });
});

describe("what the stopped walk's note says aloud (review P3-7)", () => {
  const view = world({ tokens: [thorn({ x: 4, y: 4 })] });
  const note = { tokenId: "thorn", sceneId: "s1", blocker: "wall" as const, door: null, ghost: { x: 7, y: 4 }, aim: { x: 7.5, y: 4.5 }, at: { x: 4, y: 4 }, searched: true as const, n: null };

  test("only its sentence is the status, and the help stays on the page as the button's description", () => {
    const scope = new RoomScope();
    const slot = scope.get(stopNoteSlot);
    slot.setState({ note });
    Object.assign(slot, { getInitialState: slot.getState });
    const markup = inRoom(view, createElement(StopNoteHost, { scene: view.scenes.s1!, chrome: flatChrome({ x: 0, y: 0, scale: 40 }), viewport: { width: 1280, height: 800 }, insets: { top: 52, right: 0, bottom: 60, left: 0 } }), scope);
    const statuses = markup.match(/role="status"/g) ?? [];
    assert.equal(statuses.length, 1, "one status");
    assert.match(markup, /<span role="status" aria-live="polite">Stopped at a wall\. There is no way around it that you have seen\.<\/span>/);
    assert.doesNotMatch(markup, /aria-hidden="true"[^>]*>For Misty Step/, "the help is never hidden");
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
