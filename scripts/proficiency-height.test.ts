import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { proficiencyHeightLines } from "../e2e/helpers/alignment.ts";

/** Runs the browser callback against controlled geometry, including a CSSOM write that has no effect, as a page that refused it would. */
function fixture(options: { blocked?: number[]; count?: number; grows?: boolean; throws?: boolean } = {}) {
  const MARK = "text-decoration: underline dotted 2px;";
  class Style {
    css = MARK;
    blocked = false;
    get cssText() { return this.css; }
    set cssText(value: string) { if (!this.blocked) this.css = value; }
  }
  const labels: Element[] = [];
  const pictures: Element[] = [];
  const doc = { defaultView: { getComputedStyle: (node: Element) => ({ visibility: "visible", textDecorationLine: node.style.cssText.includes("underline") ? "underline" : "none" }) } };
  class Element {
    style = new Style();
    tagName = "SPAN";
    textContent = "Perception";
    parentElement: Element | null = null;
    ownerDocument = doc;
    kind: string;
    constructor(kind: string) { this.kind = kind; }
    matches() { return this.kind === "label"; }
    querySelectorAll(selector: string) {
      if (this.kind === "root") return labels;
      return this.kind === "label" && selector === "[data-proficiency-marker]" ? pictures.filter((p) => p.parentElement === this) : [];
    }
    getAttribute() { return null; }
    getBoundingClientRect() {
      const bare = labels.length > 0 && labels.every((label) => !label.style.cssText.includes("underline"));
      if (options.throws && bare) throw new Error("measurement failed");
      return { width: 180, height: options.grows && !bare ? 40 : 20 };
    }
  }
  const root = new Element("root");
  for (let i = 0; i < (options.count ?? 2); i++) {
    const label = new Element("label");
    label.parentElement = root;
    label.style.blocked = options.blocked?.includes(i) ?? false;
    labels.push(label);
    const picture = new Element("picture");
    picture.parentElement = label;
    picture.style.css = "position: absolute;";
    pictures.push(picture);
  }
  const locator = { evaluateAll: async (read: (roots: Element[]) => unknown) => read([root]) } as unknown as Locator;
  return { locator, labels, pictures, MARK };
}

test("proficiency heights: the CSSOM takes marks off without a style element and puts them back as they were", async () => {
  const { locator, labels, pictures, MARK } = fixture();
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture"), []);
  for (const label of labels) assert.equal(label.style.cssText, MARK);
  for (const picture of pictures) assert.equal(picture.style.cssText, "position: absolute;");
});

test("proficiency heights: taking marks off that does nothing cannot pass with unchanged heights", async () => {
  const { locator } = fixture({ blocked: [0, 1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /2 of 2 marks kept their underline/);
});

test("proficiency heights: every mark must come off, even when one does", async () => {
  const { locator } = fixture({ blocked: [1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /1 of 2 marks kept their underline/);
});

test("proficiency heights: a mark that adds height fails and every mark is put back", async () => {
  const { locator, labels, MARK } = fixture({ grows: true });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /change its height by 20.00 px/);
  for (const label of labels) assert.equal(label.style.cssText, MARK);
});

test("proficiency heights: a required check cannot pass with no mark", async () => {
  const { locator } = fixture({ count: 0 });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /no visible proficiency marks were measured/);
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture", false), [], "ordinary sweep roots without marks are optional");
});

test("proficiency heights: a measurement exception still puts every mark back", async () => {
  const { locator, labels, MARK } = fixture({ throws: true });
  await assert.rejects(proficiencyHeightLines(locator, "fixture"), /measurement failed/);
  for (const label of labels) assert.equal(label.style.cssText, MARK);
});
