import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as React from "react";
import { transformWithOxc } from "vite";
import { keptMapFoot, putToastHosts } from "./toastPlacement.ts";
import { nextToastPlaces, NO_TOAST_PLACES } from "../canvas/barDock.ts";

/** A portal host move blurs its descendant, as insertBefore does in the browser. */
function page() {
  const doc = { activeElement: null as Host | null };
  class Host {
    children: Host[] = [];
    parent: Host | null = null;
    focusCalls = 0;
    options: FocusOptions | undefined;
    ownerDocument = doc;
    get firstChild(): Host | null { return this.children[0] ?? null; }
    get nextSibling(): Host | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
    contains(node: Host | null): boolean { return node === this || this.children.some((c) => c.contains(node)); }
    insertBefore(node: Host, before: Host | null) {
      if (node.parent) {
        node.parent.children.splice(node.parent.children.indexOf(node), 1);
        if (node.contains(doc.activeElement)) doc.activeElement = null;
      }
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
      node.parent = this;
    }
    remove() {
      if (this.contains(doc.activeElement)) doc.activeElement = null;
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    focus(options?: FocusOptions) { doc.activeElement = this; this.options = options; this.focusCalls++; }
  }
  const stack = new Host();
  const other = new Host();
  const first = new Host();
  const moved = new Host();
  const action = new Host();
  const root = new Host();
  root.insertBefore(stack, null);
  root.insertBefore(other, null);
  stack.insertBefore(first, null);
  other.insertBefore(moved, null);
  moved.insertBefore(action, null);
  return { doc, stack, other, first, moved, action, place: (hosts: Host[]) => putToastHosts(stack as unknown as HTMLElement, hosts as unknown as HTMLElement[]) };
}

// Run the stack portion of Toasts' JSX. The fake commit removes omitted stacks
// before the real placement helper runs, matching React's mutation/layout order.
const room = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");
const start = room.indexOf("\n", room.indexOf("<ToastVoice toasts=", room.indexOf("function Toasts(")));
const end = room.indexOf("\n      {drawn.map", start);
assert.ok(start > 0 && end > start, "Toasts must expose its stack rendering for the lifecycle check");
const { code } = await transformWithOxc(`function renderStacks(props, overMap, lowAt, stacks) { return <>${room.slice(start, end)}</>; }`, "toast-stacks.tsx", { jsx: { runtime: "classic" } });
const renderStacks = new Function("React", "createPortal", "ToastStack", "theme", `${code}\nreturn renderStacks;`)(React, (node: unknown) => node, "toast-stack", { space: (n: number) => 4 * n }) as (props: object, overMap: unknown[], lowAt: object | null, stacks: object) => React.ReactElement<{ children: React.ReactNode }>;

for (const direction of ["notices to layer", "layer to notices"] as const) test(`FU39-ASTRA-01: a focused sole toast survives ${direction} through the commit`, () => {
  const p = page();
  p.first.remove();
  const toLayer = direction === "notices to layer";
  const source = toLayer ? p.stack : p.other;
  const target = toLayer ? p.other : p.stack;
  source.insertBefore(p.moved, null);
  p.action.focus();
  const rendered = renderStacks({ layer: {} }, toLayer ? [] : [{}], toLayer ? { top: 100, edges: null } : null, { notices: p.stack, layer: p.other });
  const kept = React.Children.toArray(rendered.props.children).map((node) => (node as React.ReactElement<{ stack: typeof p.stack }>).props.stack);
  for (const stack of [p.stack, p.other]) if (!kept.includes(stack)) stack.remove();
  putToastHosts(target as unknown as HTMLElement, [p.moved as unknown as HTMLElement]);
  assert.equal(p.doc.activeElement, p.action, "the source stack must stay connected until its focused toast moves");
  assert.equal(source.children.length, 0);
  assert.deepEqual(target.children, [p.moved]);
});

test("FU39-B: a focused toast action keeps focus when its host moves between stacks", () => {
  const p = page();
  p.action.focus();
  p.place([p.first, p.moved]);
  assert.equal(p.doc.activeElement, p.action);
  assert.deepEqual(p.action.options, { preventScroll: true });
  assert.deepEqual(p.stack.children, [p.first, p.moved]);
});

test("FU39-B: reorder restores only the focus that moved, and a stable stack never refocuses", () => {
  const p = page();
  p.place([p.first, p.moved]);
  p.action.focus();
  p.place([p.moved, p.first]);
  assert.equal(p.doc.activeElement, p.action);
  const calls = p.action.focusCalls;
  p.place([p.moved, p.first]);
  assert.equal(p.action.focusCalls, calls);
  p.other.focus();
  p.place([p.first, p.moved]);
  assert.equal(p.doc.activeElement, p.other);
  assert.equal(p.other.focusCalls, 1);
});

test("FU39-B: the toast awaiting its own card cannot make a shorter kept map toast block it", () => {
  const input = { ids: [1, 2], pane: null, paneStands: false, low: null, layer: true, slot: false, recent: new Set([2]) };
  const before = nextToastPlaces(NO_TOAST_PLACES, input);
  const boxes = [{ id: 1, bottom: 112 * 1.3 }, { id: 2, bottom: 226 * 1.3 }];
  const foot = keptMapFoot(boxes, before.awaitCard, 1.3);
  assert.ok(foot !== null && Math.abs(foot - 112) < 1e-9);
  const after = nextToastPlaces(before, { ...input, low: 131, mapFoot: foot });
  assert.equal(after.places.get(1), "map");
  assert.deepEqual(after.places.get(2), { low: 131, column: true });
  assert.equal(keptMapFoot([boxes[1]!], new Set([2]), 1.3), null);
  assert.equal(keptMapFoot([], new Set(), 1), null);
  assert.equal(keptMapFoot(boxes, new Set(), 1.3), 226);
  const blocked = nextToastPlaces(before, { ...input, low: 100, mapFoot: foot });
  assert.equal(blocked.places.get(2), "map", "a kept toast that really overlaps still keeps the new one below it");
});
