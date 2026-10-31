import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { toastEscape } = await import("./toastEscape.ts");
const { popoverTakesEscape } = await import("../components/Popover.tsx");

function popoverFixture(run: (fixture: ReturnType<typeof elements>) => void, modal: "none" | "over" | "around" = "none") {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const fixture = elements();
  Object.assign(globalThis, {
    Node: fixture.Element,
    document: {
      querySelectorAll: (selector: string) => selector === "[data-rvtt-popover]" ? fixture.open ? [fixture.box] : []
        : selector === "[aria-controls]" ? [fixture.anchor, fixture.fieldAnchor]
        : selector === '[aria-modal="true"]' && modal !== "none" ? [{ contains: () => modal === "around" }] : [],
      getElementById: (id: string) => id === "menu" ? fixture.menu : id === "dialog" ? fixture.box : null,
    },
  });
  try { run(fixture); } finally { Object.assign(globalThis, saved); }
}

function elements() {
  class Element {
    tagName: string;
    type = "text";
    controls = "";
    popover: Element | null = null;
    closest(selector: string) { return selector === "[data-rvtt-popover]" ? this.popover : null; }
    children: Element[] = [];
    constructor(tagName = "BUTTON") { this.tagName = tagName; }
    contains(node: unknown): boolean { return node === this || this.children.some((c) => c.contains(node)); }
    getAttribute(name: string) { return name === "aria-controls" ? this.controls : null; }
  }
  const inside = new Element("INPUT");
  const menu = new Element("DIV");
  const box = new Element("DIV"); box.children = [menu, inside]; inside.popover = box;
  const anchor = new Element(); anchor.controls = "menu";
  const fieldAnchor = new Element("INPUT"); fieldAnchor.controls = "dialog";
  return { Element, box, menu, inside, anchor, fieldAnchor, outside: new Element(), field: new Element("TEXTAREA"), open: true };
}

for (const where of ["inside", "anchor", "fieldAnchor", "outside"] as const) for (const order of ["toast first", "popover first"]) {
  test(`Escape closes the popover and leaves the toast expanded from ${where}: ${order}`, () => popoverFixture((f) => {
    const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    let expanded = true;
    const target = f[where];
    const toast = () => toastEscape(event, target, () => { expanded = false; });
    const popover = () => {
      if (event.defaultPrevented || !f.open || !popoverTakesEscape(target, { box: f.box as unknown as Element, anchor: (where === "fieldAnchor" ? f.fieldAnchor : f.anchor) as unknown as Element })) return;
      event.preventDefault();
      f.open = false;
    };
    assert.equal(popoverTakesEscape(target), true, "the toast sees the same ownership as the popover handler");
    for (const handler of order === "toast first" ? [toast, popover] : [popover, toast]) handler();
    assert.equal(f.open, false);
    assert.equal(expanded, true);
    assert.equal(event.defaultPrevented, true);
    const second = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    toastEscape(second, target, () => { expanded = false; });
    assert.equal(expanded, false, "a second Escape shrinks the toast");
  }));
}

test("a popover under another modal does not reserve Escape", () => popoverFixture((f) => {
  assert.equal(popoverTakesEscape(f.inside), false);
  let shrinks = 0;
  toastEscape({ key: "Escape", defaultPrevented: false, preventDefault() {} }, f.inside, () => shrinks++);
  assert.equal(shrinks, 1);
}, "over"));

test("a popover inside its modal still owns Escape", () => popoverFixture((f) => {
  assert.equal(popoverTakesEscape(f.anchor), true);
}, "around"));

test("an outside text field keeps its own Escape instead of reserving it for the popover", () => popoverFixture((f) => {
  assert.equal(popoverTakesEscape(f.field), false);
  assert.equal(popoverTakesEscape(f.field, { box: f.box as unknown as Element, anchor: f.anchor as unknown as Element }), false);
}));

test("Escape without an open popover shrinks the toast and consumes the key", () => popoverFixture((f) => {
  f.open = false;
  for (const target of [null, f.outside]) {
    const event = { key: "Escape", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    let shrinks = 0;
    toastEscape(event, target, () => shrinks++);
    assert.equal(shrinks, 1);
    assert.equal(event.defaultPrevented, true);
  }
}));

test("other keys and a consumed Escape leave the toast alone", () => {
  for (const event of [{ key: "Enter", defaultPrevented: false }, { key: "Escape", defaultPrevented: true }]) {
    toastEscape({ ...event, preventDefault() { assert.fail("unused key consumed"); } }, null, () => assert.fail("toast shrank"));
  }
});
