import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sceneGrid } from "#shared/rules/grid.ts";
import { boardTheme, PALETTES } from "../lib/theme.ts";

/*
 * The board keeps its dark look in both themes, and a canvas cannot read a
 * CSS variable (docs/design/design-v1-light-theme.md 6.4 and 13): every
 * `theme.color` scheme token is one, so a Konva layer that read it would
 * draw nothing, or black, in either theme. What draws on the board reads
 * `boardTheme`, plain dark hex. The rules hold every file that imports
 * Konva, found afresh each run, so a new layer is held to them at once,
 * and one with no colors of its own passes with no listing.
 */

const CLIENT = fileURLToPath(new URL("../", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

const FILES = sources(CLIENT).map((path) => ({ file: relative(CLIENT, path).split("\\").join("/"), text: readFileSync(path, "utf8") }));
const KONVA = FILES.filter((f) => /from\s+"(react-konva|konva)(\/[^"]*)?"/.test(f.text));

/** Every `theme.color` read, with its line. Comments are left out, which may name a token. */
function colorReads(text: string): { line: string; token: string }[] {
  const reads: { line: string; token: string }[] = [];
  for (const line of text.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const m of code.matchAll(/(?<![\w.])theme\.color\.(\w+)/g)) reads.push({ line: line.trim(), token: m[1]! });
  }
  return reads;
}

/**
 * DOM styles inside files that also draw on Konva, which follow the scheme
 * like any other chrome. Each names a piece of its line, so a new read
 * beside one is caught, and each must still be there, so the list never
 * outlives its site.
 */
const DOM_SITES: Record<string, readonly string[]> = {
  // The marquee a drag across empty map draws: a DOM box over the canvas, in the viewer's accent.
  "canvas/Stage.tsx": ["border: `2px dashed ${theme.color.accent}`", "background: theme.color.accentTint"],
  // "Building area shapes…", a notice at the top of the isometric canvas.
  "canvas/relief/IsoBoard.tsx": ["background: theme.color.overlay", "color: theme.color.text,"],
};

/** Canvas helpers that import no Konva but draw on a 2D context for a layer. */
const HELPERS = ["features/builder/draw.ts", "features/builder/heights/boardText.ts", "features/traps/Crossing.tsx"];

describe("what draws on the board", () => {
  test("finds the Konva files, the ones that draw and one that draws nothing of its own", () => {
    assert.ok(KONVA.length >= 37, `${KONVA.length} files import Konva`);
    const names = KONVA.map((f) => f.file);
    for (const file of ["canvas/TokenNode.tsx", "features/measure/RulerLayer.tsx", "features/traps/TrapLayer.tsx", "canvas/IsoParts.tsx", "features/weather/WeatherLayer.tsx"]) assert.ok(names.includes(file), file);
    assert.equal(colorReads(KONVA.find((f) => f.file === "canvas/IsoParts.tsx")!.text).length, 0, "IsoParts has no color reads, and needs no listing");
  });

  test("no Konva file reads a scheme token, apart from its named DOM styles", () => {
    const found: string[] = [];
    for (const { file, text } of KONVA) {
      const allowed = DOM_SITES[file] ?? [];
      for (const read of colorReads(text)) if (!allowed.some((piece) => read.line.includes(piece))) found.push(`${file}: theme.color.${read.token} in "${read.line}"`);
    }
    assert.deepEqual(found, [], "a canvas reads boardTheme.color, or useAccent() for the accent");
  });

  test("each named DOM style is still where it was named", () => {
    for (const [file, pieces] of Object.entries(DOM_SITES)) {
      const source = FILES.find((f) => f.file === file);
      assert.ok(source, file);
      for (const piece of pieces) assert.equal(source.text.split(piece).length - 1, 1, `${file}: "${piece}"`);
    }
  });

  test("no Konva file takes the scheme's disposition rings, only the board's", () => {
    const found = KONVA.filter((f) => /\bDISPOSITION_RING\b/.test(f.text)).map((f) => f.file);
    assert.deepEqual(found, [], "BOARD_DISPOSITION_RING (lib/tokenView.ts)");
  });

  test("the canvas helpers read no scheme token", () => {
    for (const file of HELPERS) {
      const source = FILES.find((f) => f.file === file);
      assert.ok(source, file);
      assert.deepEqual(colorReads(source.text), [], file);
      assert.match(source.text, /boardTheme\.color\./, `${file} draws from the board palette`);
    }
  });

  test("the dungeon preview's marks over its picture are plain hex, as SVG attributes, and its ground is the board's", () => {
    const source = FILES.find((f) => f.file === "features/dungeon/Preview.tsx")!;
    const attrs = [...source.text.matchAll(/\b(?:fill|stroke)=\{([^}]+)\}/g)].map((m) => m[1]!);
    assert.ok(attrs.length >= 6);
    for (const attr of attrs) assert.doesNotMatch(attr, /(?<![\w.])theme\.color\./, attr);
    assert.match(source.text, /background: boardTheme\.color\.bg/);
  });
});

const { trapAreaDraft, trapDraftColor } = await import("../features/traps/TrapPane.tsx");

describe("a trap's area while the area tool aims it", () => {
  const base = { grid: sceneGrid({}), trapId: "t1", sceneId: "s1", point: { x: 3, y: 4, z: 0 }, tokens: {}, feetPerCell: 5 };

  test("is the board's trap red, plain hex, from a preset and from the trap's own area", () => {
    assert.equal(trapDraftColor, boardTheme.color.danger);
    assert.equal(trapDraftColor, PALETTES.dark.danger);
    const preset = trapAreaDraft({ ...base, area: null });
    assert.equal(preset.shape, "cone");
    assert.deepEqual(preset.point, base.point);
    const own = trapAreaDraft({ ...base, area: { shape: "sphere", size: 10, origin: { x: 2, y: 2, z: 0 }, yaw: 0, includeOrigin: true } });
    assert.equal(own.shape, "sphere");
    for (const draft of [preset, own]) {
      assert.match(draft.color, /^#[0-9a-f]{6}$/, draft.color);
      assert.equal(draft.color, boardTheme.color.danger);
    }
  });
});
