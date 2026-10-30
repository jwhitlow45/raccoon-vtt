import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { forgetRoom, readKnownRooms, type KnownRoom, type RoomStanding } from "../lib/knownRooms.ts";

const { Children, createElement, isValidElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { KnownRoomRow } = await import("./Home.tsx");
const { Button } = await import("../components/Button.tsx");
const { Dialog } = await import("../components/Dialog.tsx");

type Element = ReactElement<{ children?: ReactNode; style?: CSSProperties; onClick?(): void }>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const el = child as Element;
    return [el, ...elements(el.props.children)];
  });
}

const room: KnownRoom = { roomId: "K7QH2MXA", name: "Tuesday", role: "dm", memberName: "Dana", openedAt: 1 };
const other: KnownRoom = { ...room, roomId: "ABCD2345", name: "One-shot", openedAt: 2 };

describe("forgetting a saved room from Home", () => {
  for (const standing of [null, { kind: "in", role: "dm", memberName: "Dana", roomName: "Tuesday night" }, { kind: "out", roomName: null }, { kind: "unknown" }] satisfies (RoomStanding | null)[]) {
    test(`asks before changing storage when the room is ${standing?.kind ?? "being checked"}`, () => {
      let value = JSON.stringify([room, other]);
      let writes = 0;
      const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; writes++; } };
      let step = 0;
      // Render-phase updates exercise the real callbacks and React state without mounting the portal in a DOM.
      function Probe() {
        const tree = KnownRoomRow({ room, standing, onForget: () => forgetRoom(room.roomId, storage) });
        const nodes = elements(tree);
        const question = nodes.find((el) => el.type === Dialog) as ReactElement<Parameters<typeof Dialog>[0]> | undefined;
        const open = nodes.find((el) => el.type === Button && el.props.children === "Forget");
        assert.ok(open);
        const current = step++;
        if (current === 0 || current === 2 || current === 4) {
          assert.equal(question, undefined, "closed before a new tap");
          open.props.onClick!();
          assert.equal(writes, 0, "the first tap cannot forget the room");
        } else if (current === 1 || current === 3 || current === 5) {
          assert.ok(question, "the first tap opens the app's confirmation dialog");
          assert.equal(question.props.title, "Forget this room?");
          const words = renderToStaticMarkup(createElement("div", null, question.props.children));
          assert.match(words, /Tuesday/);
          assert.match(words, /only removes.*this device(?:'|&#x27;)s list/);
          assert.match(words, /room itself stays/);
          assert.equal(writes, 0);
          const buttons = elements(question.props.footer);
          if (current === 1) buttons.find((el) => el.props.children === "Cancel")!.props.onClick!();
          else if (current === 3) question.props.onClose();
          else {
            buttons.find((el) => el.props.children === "Forget room")!.props.onClick!();
            assert.equal(writes, 1);
            assert.deepEqual(readKnownRooms(storage), [other], "only the confirmed room leaves this device's list");
          }
        } else {
          assert.equal(question, undefined, "confirmation closes after Forget");
          assert.equal(writes, 1);
        }
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      assert.equal(step, 7, "open, cancel, reopen, dismiss, reopen, confirm, closed");
    });
  }
});

test("dialog bodies reserve classic scrollbar space before their content needs to scroll", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const elementBefore = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { nodeType: 1 } } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  try {
    for (const children of ["Short list", Array.from({ length: 100 }, (_, i) => createElement("p", { key: i }, `Creature ${i}`))]) {
      let bodies = 0;
      function Probe() {
        const portal = Dialog({ title: "Take a shape", onClose() {}, children });
        const body = elements(portal.children).find((el) => el.props.style?.overflowY === "auto");
        assert.ok(body, "the shared scrolling body draws");
        assert.equal(body.props.style?.scrollbarGutter, "stable");
        bodies++;
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      assert.equal(bodies, 1);
    }
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
    if (elementBefore) Object.defineProperty(globalThis, "HTMLElement", elementBefore);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
