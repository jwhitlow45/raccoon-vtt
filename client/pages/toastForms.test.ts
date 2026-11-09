import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { nextToastPlaces, NO_TOAST_PLACES } from "../canvas/barDock.ts";
import type { Toast } from "../state/types.ts";
import { sheetToastsToDismiss, settleToastHosts, toastHostOf, toastLists } from "./toastPlacement.ts";

const { Button } = await import("../components/Button.tsx");
const { ToastNote, toastForm, toastPortals, toastRow, toastStacks } = await import("./ToastParts.tsx");

type Node = React.ReactElement<Record<string, unknown>>;
type Portal = { key: string | null; containerInfo: object; children: React.ReactNode };

function children(node: Node): Node[] {
  const found: Node[] = [];
  React.Children.forEach(node.props.children as React.ReactNode, (child) => {
    if (React.isValidElement(child)) found.push(child as Node);
  });
  return found;
}
/** A portal is not an element: React gives it its children and the container directly. */
function isPortal(node: unknown): node is Portal {
  return typeof node === "object" && node !== null && "containerInfo" in node;
}
function note(id: number): Toast {
  return { id, text: "A toast.", tone: "info" } as Toast;
}
// React only checks that a portal's container looks like a DOM element.
const container = () => ({ nodeType: 1 });

// The same toast must keep the same portal key and host in every form, or React remounts its buttons.
test("FU39 confer: a row toast keeps its portal host when the layout gives it a normal stack", () => {
  const toast = note(1);
  const host = container() as unknown as HTMLElement;
  const places = nextToastPlaces(NO_TOAST_PLACES, { ids: [1], layer: true, pane: null, paneStands: false, low: null, slot: false }).places;
  const portals = (overBars: boolean) => {
    const rowToast = overBars ? toast : undefined;
    const lists = toastLists({ overBars, showing: [toast], places, inSlot: false, rowToast });
    assert.deepEqual(lists.drawn, [toast], "the host must survive the placement effect's cleanup");
    return toastPortals({ drawn: lists.drawn, rowToast, wholeToast: undefined, hostOf: () => host, dismiss() {}, showWhole() {}, shrink() {} });
  };
  for (const [overBars, form] of [[true, "row"], [false, "stack"]] as const) {
    const [portal, ...rest] = portals(overBars);
    assert.equal(rest.length, 0);
    assert.ok(isPortal(portal), "the toast needs its own portal in both forms");
    assert.equal(portal.containerInfo, host);
    assert.equal(portal.key, "toast-1");
    assert.equal((portal.children as Node).props.form, form);
  }
});

test("FU39 confer: the row's empty stack and both toast stacks stay mounted until a focused host moves", () => {
  const rowStack = { current: null };
  const row = toastRow({ layer: container() as unknown as HTMLElement, rowBox: { current: null }, rowStack, safeTop: 0, right: 0, whole: false });
  assert.ok(isPortal(row));
  // LP29-A-TOAST-1: beside a sideways sheet risen over the bars the row's right end keeps left of it.
  const beside = toastRow({ layer: container() as unknown as HTMLElement, rowBox: { current: null }, rowStack, safeTop: 0, right: 340, whole: false });
  assert.ok(isPortal(beside));
  assert.equal(((beside.children as Node).props.style as { right: number }).right, 340);
  assert.ok(React.Children.toArray((row.children as Node).props.children as React.ReactNode).some((node) => (node as Node).props.ref === rowStack), "the empty row stack must stay mounted until its focused host moves");
  assert.equal(toastRow({ layer: null, rowBox: { current: null }, rowStack, safeTop: 0, right: 0, whole: false }), null);
  const stacks = { notices: { name: "notices" }, layer: { name: "layer" } } as never;
  const withLayer = toastStacks({ layer: container() as unknown as HTMLElement, lowAt: null, stacks }) as Node;
  const drawn = React.Children.toArray(withLayer.props.children as React.ReactNode);
  assert.equal(drawn.length, 2, "the notices' stack and the layer's both draw while empty");
  const noLayer = toastStacks({ layer: null, lowAt: null, stacks }) as Node;
  assert.equal(React.Children.toArray(noLayer.props.children as React.ReactNode).length, 1, "with no layer only the notices' stack draws");
});

test("FU39 confer: one host per toast, made once", () => {
  const hosts = new Map<number, HTMLElement>();
  let made = 0;
  const create = () => (made++, container() as unknown as HTMLElement);
  const first = toastHostOf(hosts, 1, create);
  assert.equal(toastHostOf(hosts, 1, create), first);
  assert.notEqual(toastHostOf(hosts, 2, create), first);
  assert.equal(made, 2);
});

for (const toRow of [true, false]) test(`FU39 confer: the placement effect moves the focused host ${toRow ? "into" : "out of"} the row`, () => {
  const toast = { id: 1 };
  const doc: { activeElement: object | null } = { activeElement: null };
  const action = { focus(options: FocusOptions) { assert.equal(options.preventScroll, true); doc.activeElement = action; } };
  doc.activeElement = action;
  const host = { nextSibling: null, contains: (node: object) => node === action, remove() { assert.fail("the surviving row host must not be removed"); } };
  const calls: string[] = [];
  const stack = (name: string) => ({ ownerDocument: doc, firstChild: null, insertBefore(node: object) { assert.equal(node, host); calls.push(name); doc.activeElement = null; } }) as unknown as HTMLElement;
  const hosts = new Map([[1, host as unknown as HTMLElement]]);
  const overMap = toRow ? [] : [toast];
  settleToastHosts(hosts, [toast], [[stack("notices"), overMap], [stack("layer"), []], [stack("row"), toRow ? [toast] : []]]);
  assert.deepEqual(calls, [toRow ? "row" : "notices"]);
  assert.equal(doc.activeElement, action);
  assert.equal(hosts.size, 1);
});

test("FU39 confer: a toast that went has its host removed before the others are placed", () => {
  const order: string[] = [];
  const gone = { remove: () => order.push("remove gone") } as unknown as HTMLElement;
  const kept = { nextSibling: null, contains: () => false } as unknown as HTMLElement;
  const stack = { ownerDocument: { activeElement: null }, firstChild: null, insertBefore: () => order.push("place kept") } as unknown as HTMLElement;
  const hosts = new Map([[1, gone], [2, kept]]);
  settleToastHosts(hosts, [{ id: 2 }], [[stack, [{ id: 2 }]]]);
  assert.deepEqual(order, ["remove gone", "place kept"]);
  assert.deepEqual([...hosts.keys()], [2]);
});

// Walk the real tree for the toast's own button. Function components other
// than ToastNote's Button stand as one step each, so a focused button keeps
// the same path through every form.
function buttonPath(node: Node, label: string, path: string[] = []): string[] | null {
  const name = typeof node.type === "function" ? node.type.name : String(node.type);
  const here = [...path, `${name}:${node.key ?? ""}`];
  if ((node.type === "button" || node.type === Button) && (node.props.children === label || node.props["aria-label"] === label)) return here;
  if (typeof node.type === "function") return null;
  for (const [index, child] of children(node).entries()) {
    const found = buttonPath(child, label, [...here, String(index)]);
    if (found) return found;
  }
  return null;
}

for (const action of [undefined, { label: "Save and damage", run() {} }]) test(`FU39 confer: ${action ? "action" : "text"} focus has the same element through row, whole and stack forms`, () => {
  const toast = { id: 1, text: "A toast.", tone: "info", action } as Toast;
  const label = action?.label ?? toast.text;
  const forms = ["stack", "row", "whole"] as const;
  const noteOf = (form: (typeof forms)[number]) => ToastNote({ toast, form, onDismiss() {} }) as Node;
  const paths = forms.map((form) => buttonPath(noteOf(form), label));
  assert.ok(paths[0], "the normal toast must expose its button");
  assert.deepEqual(paths[1], paths[0], "changing to the row must preserve the button's React position");
  assert.deepEqual(paths[2], paths[0], "showing the whole toast must preserve the button's React position");
  for (const form of forms) {
    const style = noteOf(form).props.style as React.CSSProperties;
    assert.notEqual(style.display, "contents", "the portal host's first element must have a box for toast fitting");
    assert.equal(style.width, "100%");
  }
});

test("FU39 confer: a toast takes the row or whole form only when it is the row's toast", () => {
  const row = note(1);
  assert.equal(toastForm(1, row, undefined), "row");
  assert.equal(toastForm(1, row, row), "whole");
  assert.equal(toastForm(2, row, row), "stack", "an older toast waits in the stack form");
  assert.equal(toastForm(1, undefined, undefined), "stack");
});

test("FU39 confer: sheet toasts stay assigned to the sheet and are dismissed when its slot closes", () => {
  const input = { ids: [1], layer: true, pane: null, paneStands: false, low: null, slot: true };
  const sheet = nextToastPlaces(NO_TOAST_PLACES, input);
  const closed = nextToastPlaces(sheet, { ...input, slot: false });
  assert.equal(closed.places.get(1), "sheet", "closing a sheet never relocates its toast to the map");
  assert.deepEqual(sheetToastsToDismiss(true, closed.places, new Set([1])), [], "an open slot dismisses nothing");
  assert.deepEqual(sheetToastsToDismiss(false, closed.places, new Set([1])), [1]);
});

test("LP32-POLISH d: the first of a toast's chips is the primary one, as the first chip under a roll is", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const send = (label: string) => ({ label, name: `Apply to ${label}`, send: async () => null });
  const toast: Toast = { id: 4, text: "Bree rolled 9.", tone: "info", actions: [send("Goblin 1"), send("Goblin 2"), send("Goblin 3")], actionsLabel: "Apply to" };
  const markup = renderToStaticMarkup(React.createElement(ToastNote, { toast, onDismiss() {} }));
  const background = (name: string) => /style="([^"]*)"/.exec(new RegExp(`<button[^>]*aria-label="Apply to ${name}"[^>]*>`).exec(markup)![0])![1]!.match(/background(?:-color)?:[^;]*/)![0];
  assert.notEqual(background("Goblin 1"), background("Goblin 2"), "the first stands apart from the rest");
  assert.equal(background("Goblin 2"), background("Goblin 3"), "and the rest read alike");
});

test("QOL L1: a toast's buttons that wait on the server follow their label, the busy one says so, and the one row keeps them mounted and hidden", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const send = (label: string) => ({ label, name: `Apply 9 Slashing damage to ${label}`, send: async () => null });
  const toast: Toast = { id: 3, text: "Bree rolled 9 for Longsword damage.", tone: "info", actions: [send("Goblin 1"), send("Goblin 2")], actionsLabel: "Apply to", busy: 1, said: "Goblin 1 is already dead." };
  const stack = renderToStaticMarkup(React.createElement(ToastNote, { toast, onDismiss() {} }));
  assert.match(stack, /<div role="group" aria-label="Apply to" data-toast-sends=""/, "the buttons are one group, named by its label");
  assert.match(stack, /<span aria-hidden="true"[^>]*>Apply to<\/span>/, "whose words show, said once");
  assert.match(stack, /aria-label="Apply 9 Slashing damage to Goblin 1"/);
  assert.match(stack, /aria-busy="true"[^>]*aria-label="Apply 9 Slashing damage to Goblin 2"|aria-label="Apply 9 Slashing damage to Goblin 2"[^>]*aria-busy="true"/, "the pressed one is busy");
  assert.match(stack, /<p role="alert"[^>]*>Goblin 1 is already dead\.<\/p>/);
  const row = renderToStaticMarkup(React.createElement(ToastNote, { toast, onDismiss() {}, form: "row" }));
  assert.match(row, /data-toast-sends="" hidden=""/, "mounted in the one row, and hidden");
  assert.doesNotMatch(row, /role="alert"/);
});
