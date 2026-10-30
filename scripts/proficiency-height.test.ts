import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { proficiencyHeightLines } from "../e2e/helpers/alignment.ts";

/** Runs the browser callback against controlled geometry, including a CSSOM write that has no effect, as a page that refused it would. */
function fixture(options: { blocked?: number[]; count?: number; grows?: boolean; cuts?: boolean; throws?: boolean } = {}) {
  const MARK = "text-box: trim-both cap alphabetic; padding: 0.05em 0px 0.214em; box-shadow: currentcolor 0px 0px 0px 1px;";
  class Style {
    css = MARK;
    blocked = false;
    taken = new Map<string, string>();
    get cssText() { return this.css; }
    set cssText(value: string) {
      if (this.blocked) return;
      this.css = value;
      this.taken.clear();
    }
    setProperty(name: string, value: string) { if (!this.blocked) this.taken.set(name, value); }
  }
  const labels: Element[] = [];
  const marks: Element[] = [];
  const pictures: Element[] = [];
  const off = (mark: Element) => mark.style.taken.get("box-shadow") === "none" && mark.style.taken.get("padding") === "0" && mark.style.taken.get("text-box") === "normal";
  const bare = () => marks.length > 0 && marks.every(off);
  const doc = {
    defaultView: {
      getComputedStyle: (node: Element) => ({
        visibility: "visible",
        textOverflow: options.cuts && node.kind === "root" ? "ellipsis" : "clip",
        boxShadow: node.kind === "mark" && !off(node) ? "rgb(241, 239, 233) 0px 0px 0px 1px" : "none",
        outlineStyle: "none",
        backgroundColor: "rgba(0, 0, 0, 0)",
        getPropertyValue: (name: string) => (name === "text-box-trim" ? (node.kind === "mark" && !off(node) ? "trim-both" : "none") : ""),
      }),
    },
  };
  class Element {
    style = new Style();
    tagName = "SPAN";
    textContent = "Perception";
    parentElement: Element | null = null;
    ownerDocument = doc;
    clientWidth = 180;
    kind: string;
    mark: Element | null = null;
    constructor(kind: string) { this.kind = kind; }
    get scrollWidth() { return options.cuts && !bare() ? 200 : 180; }
    matches() { return this.kind === "label"; }
    closest() { return this.mark; }
    querySelectorAll(selector: string) {
      if (this.kind === "root") return labels;
      return this.kind === "label" && selector === "[data-proficiency-marker]" ? pictures.filter((p) => p.parentElement === this) : [];
    }
    getAttribute(name: string) { return name === "data-proficiency-form" ? "unit" : null; }
    getBoundingClientRect() {
      if (options.throws && bare()) throw new Error("measurement failed");
      return { width: 180, height: options.grows && !bare() ? 40 : 20 };
    }
  }
  const root = new Element("root");
  for (let i = 0; i < (options.count ?? 2); i++) {
    const mark = new Element("mark");
    mark.parentElement = root;
    mark.style.blocked = options.blocked?.includes(i) ?? false;
    marks.push(mark);
    const label = new Element("label");
    label.parentElement = mark;
    label.mark = mark;
    label.style.css = "";
    labels.push(label);
    const picture = new Element("picture");
    picture.parentElement = label;
    picture.style.css = "position: absolute;";
    pictures.push(picture);
  }
  const locator = { evaluateAll: async (read: (roots: Element[]) => unknown) => read([root]) } as unknown as Locator;
  return { locator, marks, pictures, MARK };
}

test("proficiency heights: the CSSOM takes marks off without a style element and puts them back as they were", async () => {
  const { locator, marks, pictures, MARK } = fixture();
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture"), []);
  for (const mark of marks) {
    assert.equal(mark.style.cssText, MARK);
    assert.equal(mark.style.taken.size, 0, "every property taken off is back");
  }
  for (const picture of pictures) assert.equal(picture.style.cssText, "position: absolute;");
});

test("proficiency heights: taking marks off that does nothing cannot pass with unchanged heights", async () => {
  const { locator } = fixture({ blocked: [0, 1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /2 of 2 marks kept their lines when taken off/);
});

test("proficiency heights: every mark must come off, even when one does", async () => {
  const { locator } = fixture({ blocked: [1] });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /1 of 2 marks kept their lines when taken off/);
});

test("proficiency heights: a mark that adds height fails and every mark is put back", async () => {
  const { locator, marks, MARK } = fixture({ grows: true });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /change its height by 20.00 px/);
  for (const mark of marks) assert.equal(mark.style.cssText, MARK);
});

test("proficiency heights: marks that push words past a box's ellipsis fail", async () => {
  const { locator } = fixture({ cuts: true });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /marks cut its words with "…"/);
});

test("proficiency heights: a required check cannot pass with no mark", async () => {
  const { locator } = fixture({ count: 0 });
  assert.match((await proficiencyHeightLines(locator, "fixture")).join("\n"), /no visible proficiency marks were measured/);
  assert.deepEqual(await proficiencyHeightLines(locator, "fixture", false), [], "ordinary sweep roots without marks are optional");
});

test("proficiency heights: a measurement exception still puts every mark back", async () => {
  const { locator, marks, MARK } = fixture({ throws: true });
  await assert.rejects(proficiencyHeightLines(locator, "fixture"), /measurement failed/);
  for (const mark of marks) assert.equal(mark.style.cssText, MARK);
});
