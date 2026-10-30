import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { transformWithOxc } from "vite";
import { inToastLayer, nextToastPlaces, NO_TOAST_PLACES, toastLayerPlace } from "../canvas/barDock.ts";
import { theme } from "../lib/theme.ts";
import { putToastHosts } from "./toastPlacement.ts";

const room = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
const listsStart = room.indexOf("  const overMap =", room.indexOf("function Toasts("));
const listsEnd = room.indexOf("  // The toasts drawn now", listsStart);
const jsxStart = room.indexOf("\n", room.indexOf("<ToastVoice toasts=", listsEnd));
const jsxEnd = room.indexOf("\n    </>", jsxStart);
assert.ok(listsStart > 0 && listsEnd > listsStart && jsxEnd > jsxStart);
const { code } = await transformWithOxc(`function render() { ${room.slice(listsStart, listsEnd)} return { drawn, node: <>${room.slice(jsxStart, jsxEnd)}</> }; }`, "toast-forms.tsx", { jsx: { runtime: "classic" } });

type Node = React.ReactElement<Record<string, unknown>>;
function children(node: Node): Node[] {
  const found: Node[] = [];
  React.Children.forEach(node.props.children as React.ReactNode, (child) => {
    if (React.isValidElement(child)) found.push(child as Node);
  });
  return found;
}
function all(node: Node): Node[] { return [node, ...children(node).flatMap(all)]; }

// Render the real portal expressions with inert containers. The same toast must
// keep the same portal key and host in every form, or React remounts its buttons.
function render(overBars: boolean, toast: object, host: object, rowStack: object) {
  const placed = { current: nextToastPlaces(NO_TOAST_PLACES, { ids: [1], layer: true, pane: null, paneStands: false, low: null, slot: false }) };
  const bindings = {
    React, createPortal: (node: React.ReactNode, container: object, key?: string) => React.createElement("portal", { container, key }, node),
    ToastStack: "toast-stack", ToastNote: "toast-note", theme, inToastLayer, toastLayerPlace,
    overBars, showing: [toast], places: placed.current.places, placed, ids: [1], slot: null,
    props: { layer: {}, safeTop: 0, edges: { left: 0, right: 0 } }, stacks: {}, rowBox: {}, rowStack,
    rowToast: overBars ? toast : undefined, wholeToast: undefined, hostOf: () => host,
    ui: {}, setWhole: () => {}, shrink: () => {},
  };
  return new Function(...Object.keys(bindings), `${code}\nreturn render();`)(...Object.values(bindings)) as { drawn: object[]; node: Node };
}

test("FU39 confer: a row toast keeps its portal host when the layout gives it a normal stack", () => {
  const toast = { id: 1 };
  const host = {};
  const rowStack = {};
  const row = render(true, toast, host, rowStack);
  const stack = render(false, toast, host, rowStack);
  for (const output of [row, stack]) {
    assert.deepEqual(output.drawn, [toast], "the host must survive the placement effect's cleanup");
    const portal = all(output.node).find((node) => node.type === "portal" && children(node).some((child) => child.type === "toast-note"));
    assert.ok(portal, "the toast needs its own portal in both forms");
    assert.equal(portal.props.container, host);
    assert.equal(portal.key, "toast-1");
    assert.ok(all(output.node).some((node) => node.props.ref === rowStack), "the empty row stack must stay mounted until its focused host moves");
  }
});

for (const toRow of [true, false]) test(`FU39 confer: the placement effect moves the focused host ${toRow ? "into" : "out of"} the row`, () => {
  const toast = { id: 1 };
  const doc: { activeElement: object | null } = { activeElement: null };
  const action = { focus(options: FocusOptions) { assert.equal(options.preventScroll, true); doc.activeElement = action; } };
  doc.activeElement = action;
  const host = { nextSibling: null, contains: (node: object) => node === action, remove() { assert.fail("the surviving row host must not be removed"); } };
  const calls: string[] = [];
  const stack = (name: string) => ({ current: { ownerDocument: doc, firstChild: null, insertBefore(node: object) { assert.equal(node, host); calls.push(name); doc.activeElement = null; } } });
  const start = room.indexOf("    const kept = new Set(drawn.map");
  const end = room.indexOf("    const height =", start);
  assert.ok(start > 0 && end > start);
  const bindings = {
    drawn: [toast], hosts: { current: new Map([[1, host]]) }, putToastHosts,
    stacks: { notices: { stack: stack("notices") }, layer: { stack: stack("layer") } },
    overMap: toRow ? [] : [toast], low: [], rowStack: stack("row"), rowToast: toRow ? toast : undefined,
    rowBox: { current: null }, dockStore: { getState: () => ({ toastRow: null }) },
  };
  new Function(...Object.keys(bindings), stripTypeScriptTypes(room.slice(start, end)))(...Object.values(bindings));
  assert.deepEqual(calls, [toRow ? "row" : "notices"]);
  assert.equal(doc.activeElement, action);
});

const noteStart = room.indexOf("function ToastNote(");
const noteEnd = room.indexOf("\n/** The toast die's size", noteStart);
assert.ok(noteStart > 0 && noteEnd > noteStart);
const noteCode = await transformWithOxc(room.slice(noteStart, noteEnd), "toast-note.tsx", { jsx: { runtime: "classic" } });
const note = new Function("React", "Button", "IconButton", "ToastD20", "theme", "NOTICE_TONES", "TOAST_MAX_PX", `${noteCode.code}\nreturn ToastNote;`)(React, "button", "close", "die", theme, { info: {}, danger: {} }, 440) as (props: object) => Node;

function buttonPath(node: Node, label: string, path: string[] = []): string[] | null {
  const here = [...path, `${typeof node.type === "function" ? node.type.name : String(node.type)}:${node.key ?? ""}`];
  if (node.type === "button" && (node.props.children === label || node.props["aria-label"] === label)) return here;
  if (typeof node.type === "function") return buttonPath((node.type as (props: object) => Node)(node.props), label, here);
  for (const [index, child] of children(node).entries()) {
    const found = buttonPath(child, label, [...here, String(index)]);
    if (found) return found;
  }
  return null;
}

for (const action of [undefined, { label: "Save and damage", run() {} }]) test(`FU39 confer: ${action ? "action" : "text"} focus has the same element through row, whole and stack forms`, () => {
  const toast = { id: 1, text: "A toast.", tone: "info", action };
  const label = action?.label ?? toast.text;
  const paths = ["stack", "row", "whole"].map((form) => buttonPath(note({ toast, form, onDismiss() {} }), label));
  assert.ok(paths[0], "the normal toast must expose its button");
  assert.deepEqual(paths[1], paths[0], "changing to the row must preserve the button's React position");
  assert.deepEqual(paths[2], paths[0], "showing the whole toast must preserve the button's React position");
  for (const form of ["stack", "row", "whole"]) {
    const style = note({ toast, form, onDismiss() {} }).props.style as React.CSSProperties;
    assert.notEqual(style.display, "contents", "the portal host's first element must have a box for toast fitting");
    assert.equal(style.width, "100%");
  }
});

test("FU39 confer: sheet toasts stay assigned to the sheet and are dismissed when its slot closes", () => {
  const input = { ids: [1], layer: true, pane: null, paneStands: false, low: null, slot: true };
  const sheet = nextToastPlaces(NO_TOAST_PLACES, input);
  const closed = nextToastPlaces(sheet, { ...input, slot: false });
  assert.equal(closed.places.get(1), "sheet", "closing a sheet never relocates its toast to the map");
  const start = room.indexOf("  useEffect(() => {\n    if (slot) return;", room.indexOf("function Toasts("));
  const end = room.indexOf("\n  // Each toast's time", start);
  assert.ok(start > 0 && end > start);
  const dismissed: number[] = [];
  const run = new Function("useEffect", "slot", "placed", "ui", stripTypeScriptTypes(room.slice(start, end)));
  run((effect: () => void) => effect(), null, { current: closed }, { dismissToast: (id: number) => dismissed.push(id) });
  assert.deepEqual(dismissed, [1]);
});
