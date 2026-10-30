import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { proficiencyHeightLines } from "../e2e/helpers/alignment.ts";

/** Run the browser callback against controlled geometry, including a CSSOM write that has no effect. */
function fixture(options: { blocked?: number[]; count?: number; wraps?: boolean; throws?: boolean; inline?: string; priority?: string } = {}) {
  class Style {
    value = options.inline ?? "";
    priority = options.priority ?? "";
    blocked = false;
    getPropertyValue() { return this.value; }
    getPropertyPriority() { return this.priority; }
    setProperty(_name: string, value: string, priority: string) {
      if (this.blocked && value === "none") return;
      this.value = value;
      this.priority = priority;
    }
    removeProperty() { this.value = ""; this.priority = ""; }
  }
  const markers: Element[] = [];
  const labels: Element[] = [];
  const doc = {
    querySelectorAll: () => markers,
    defaultView: { getComputedStyle: (node: Element) => ({ visibility: "visible", display: node.style.value || "inline-flex" }) },
    // The old style-element path models the app's CSP: it changes no computed styles.
    head: { appendChild() {} },
    createElement: () => ({ textContent: "", remove() {} }),
  };
  class Element {
    style = new Style();
    tagName = "SPAN";
    textContent = "Perception +7";
    parentElement: Element | null = null;
    ownerDocument = doc;
    kind: string;
    constructor(kind: string) { this.kind = kind; }
    matches(selector: string) { return this.kind === "label" && selector === "[data-proficiency-label]"; }
    querySelectorAll(selector: string) { return selector === "[data-proficiency-label]" ? this.kind === "root" ? labels : [] : markers; }
    getAttribute() { return null; }
    getBoundingClientRect() {
      if (this.kind === "marker") return this.style.value === "none" ? { width: 0, height: 0 } : { width: 14, height: 14 };
      const hidden = markers.length > 0 && markers.every((marker) => marker.style.value === "none");
      if (options.throws && hidden) throw new Error("measurement failed");
      return { width: 180, height: options.wraps && !hidden ? 40 : 20 };
    }
  }
  const root = new Element("root");
  const label = new Element("label");
  label.parentElement = root;
  labels.push(label);
  for (let i = 0; i < (options.count ?? 2); i++) {
    const marker = new Element("marker");
    marker.style.blocked = options.blocked?.includes(i) ?? false;
    markers.push(marker);
  }
  const locator = { evaluateAll: async (read: (roots: Element[]) => unknown) => read([root]) } as unknown as Locator;
  return { locator, markers };
}

test("proficiency heights: CSSOM hiding works without a style element and restores inline priorities", async () => {
  const { locator, markers } = fixture({ inline: "inline-flex", priority: "important" });
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture"), []);
  for (const marker of markers) assert.deepEqual([marker.style.value, marker.style.priority], ["inline-flex", "important"]);
});

test("proficiency heights: hiding that does nothing cannot pass with unchanged heights", async () => {
  const { locator } = fixture({ blocked: [0, 1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /no visible proficiency markers were hidden/);
});

test("proficiency heights: every visible marker must hide, even when one succeeds", async () => {
  const { locator } = fixture({ blocked: [1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /1.*marker.*did not compute display: none/);
});

test("proficiency heights: added rows fail and temporary display properties are removed", async () => {
  const { locator, markers } = fixture({ wraps: true });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /change container height by 20.00 px/);
  for (const marker of markers) assert.equal(marker.style.value, "");
});

test("proficiency heights: a required check cannot measure only labels without markers", async () => {
  const { locator } = fixture({ count: 0 });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /no visible proficiency markers were hidden/);
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture", false), [], "ordinary sweep roots without markers are optional");
});

test("proficiency heights: a measurement exception still restores every marker", async () => {
  const { locator, markers } = fixture({ throws: true });
  await assert.rejects(proficiencyHeightLines(locator, "fixture"), /measurement failed/);
  for (const marker of markers) assert.equal(marker.style.value, "");
});
