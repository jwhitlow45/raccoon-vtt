import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { declarationSpans, findings, stripComments, type SourceFile } from "../../scripts/style-drift.ts";

/**
 * The scan behind scripts/style-drift.ts, which the drift test
 * (styleDrift.test.ts) runs over the whole client: here on small made-up
 * files, so each rule and each exception is checked on its own.
 */

function file(path: string, text: string): SourceFile {
  return { path, text: stripComments(text) };
}

function colors(f: SourceFile): string[] {
  return findings([f])
    .filter((x) => x.rule === "color")
    .map((x) => `${x.line} ${x.text}`);
}

const BUTTON = 'export function Pick() {\n  return <button style={{ color: "#123456", background: "rgba(0, 0, 0, 0.3)" }} />;\n}\n';

describe("the drift scan's exceptions", () => {
  test("a mixed file's palette is exempt, and a color in its interface code is still a finding", () => {
    const effects = file("client/features/tokens/EffectsSection.tsx", `const CUSTOM_COLORS = ["#0f766e", "#1d4ed8"];\n${BUTTON}`);
    assert.deepEqual(colors(effects), ["3 #123456", "3 rgba(0, 0, 0, 0.3)"]);
    const names = file("client/features/images/IconsTab.tsx", `const COLOR_NAMES: Record<string, string> = {\n  "#8b8a93": "Gray",\n  "#0b0b0e": "Black",\n};\n${BUTTON}`);
    assert.deepEqual(colors(names), ["6 #123456", "6 rgba(0, 0, 0, 0.3)"]);
  });

  test("stored defaults are exempt by name only, so an unnamed one is a finding", () => {
    const create = file(
      "client/features/scenes/create.ts",
      'export const DEFAULT_GRID: Scene["grid"] = { show: true, color: "#ffffff", opacity: 0.25 };\nexport const MAP_BACKGROUND = "#1b1b20";\nexport function mapScene() {\n  return { background: "#2b2b31" };\n}\n',
    );
    assert.deepEqual(colors(create), ["4 #2b2b31"]);
  });

  test("a file that is all tokens, art or TV is exempt as a whole, for what it is exempt from", () => {
    assert.deepEqual(colors(file("client/lib/accent.ts", 'const DARK_INK = "#1a1206";\n')), []);
    assert.deepEqual(colors(file("client/features/drawings/DrawingLayer.tsx", BUTTON)), []);
    assert.deepEqual(colors(file("client/canvas/TokenActionBar.tsx", BUTTON)).length, 2, "chrome inside canvas/ is checked");
    const tv = file("client/features/display/DisplayRoom.tsx", '<div style={{ fontSize: 36, zIndex: 30, borderRadius: 4, color: "#000" }} />\n');
    assert.deepEqual(
      findings([tv]).map((x) => x.rule),
      ["borderRadius"],
      "the TV keeps its sizes, stacking and colors, never a raw radius",
    );
  });

  test("ordinary files are checked for every rule", () => {
    const f = file(
      "client/features/x/Thing.tsx",
      '<div style={{ fontSize: 15, borderRadius: 8, boxShadow: "0 1px 2px #000", zIndex: 12, opacity: disabled ? 0.5 : 1 }} />\n<div style={{ fontSize: theme.font.body14, zIndex: 1, boxShadow: lifted ? theme.shadow.pane : "none" }} />\n',
    );
    assert.deepEqual(findings([f]).map((x) => `${x.line} ${x.rule}`).sort(), ["1 borderRadius", "1 boxShadow", "1 color", "1 fontSize", "1 opacity", "1 zIndex"]);
  });

  test("a declaration's span runs to the end of its statement or body, past brackets and strings", () => {
    const text = 'const A = { x: "};", y: [1, 2] };\nconst B = 1;\nfunction C(a: string) {\n  return a;\n}\nconst D = 2;\n';
    const spans = declarationSpans(text, ["A", "C"]);
    assert.deepEqual(spans.map((s) => text.slice(s.from, s.to).trim()), ['const A = { x: "};", y: [1, 2] }', "function C(a: string) {\n  return a;\n}"]);
  });

  test("comments are stripped, but a URL or a pattern inside a string survives", () => {
    assert.equal(stripComments('const u = "https://x.test"; // "#123456"\n'), 'const u = "https://x.test"; \n');
    assert.equal(stripComments("const r = /a\\/\\/b/g; /* #abc */ x"), `const r = /a\\/\\/b/g; ${" ".repeat("/* #abc */".length)} x`);
  });
});
