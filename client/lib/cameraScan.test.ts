import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The camera scan (docs/design-v1-isometric-view.md 4.1). Camera math
 * written by hand reads the world as the view, which holds only in
 * Top-down, so every conversion between the screen and the map goes through
 * lib/camera.ts and lib/view.ts, where the view is a parameter. This fails
 * on the hand-written forms anywhere else in client/. Tests may still work
 * out the numbers they expect by hand.
 */

const CLIENT = fileURLToPath(new URL("..", import.meta.url));
const API = new Set(["lib/camera.ts", "lib/view.ts"]);

const BANNED: readonly { what: string; pattern: RegExp }[] = [
  { what: "a Konva stage's position or scale read by hand", pattern: /\b\w*stage\w*(?:\(\))?\??\.(?:x|y|scaleX|scaleY)\(\)/i },
  { what: "a node's scale read by hand", pattern: /\.scale[XY]\(\)/ },
  { what: "the canvas's middle taken through the camera by hand", pattern: /\/\s*2\s*-\s*[\w$.]+\.[xy]\s*\)\s*\/\s*[\w$.]*\bscale\b/ },
  { what: "a screen point turned into a map point by hand", pattern: /-\s*[\w$.]*\b(?:cam|camera|stage|c)\.[xy](?:\(\))?\s*\)\s*\/\s*[\w$.]*\bscale\b/ },
  { what: "a map point turned into a screen point by hand", pattern: /\*\s*[\w$.]*\b(?:cam|camera|c)\.scale\s*\+\s*[\w$.]*\b(?:cam|camera|c)\.[xy]\b/ },
  { what: "a camera that puts a map point on screen, by hand", pattern: /\b[xy]:\s*[^,;{}()]*-\s*(?:\([^()]*\)|[\w$.]+\.[xy])\s*\*\s*[\w$.]*\bscale\b/ },
];

function offenders(text: string): string[] {
  return BANNED.filter((b) => b.pattern.test(text)).map((b) => b.what);
}

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

describe("the camera scan (section 4.1)", () => {
  test("no file outside lib/camera.ts and lib/view.ts does camera math by hand", () => {
    const found: string[] = [];
    let scanned = 0;
    for (const path of sources(CLIENT)) {
      const rel = relative(CLIENT, path).split("\\").join("/");
      if (API.has(rel)) continue;
      scanned++;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const what of offenders(line)) found.push(`client/${rel}:${i + 1}: ${what}: ${line.trim()}`);
        });
    }
    assert.deepEqual(found, []);
    assert.ok(scanned > 300, `only ${scanned} files scanned`);
  });

  test("each pattern catches the hand-written forms the rename replaced", () => {
    // The lines as they stood before the rename (lane ISO-1), one or more for each pattern.
    const before = [
      "const hit = pinUnder(view, sceneRef.current, { x: stage.x(), y: stage.y(), scale: stage.scaleX() || 1 }, p);",
      "const e = viewEvent({ x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() });",
      "const scale = stage.scaleX() || 1;",
      "pingRef.current((p.x - stage.x()) / scale, (p.y - stage.y()) / scale, pointerId);",
      "x: round(clamp((viewport.width / 2 - camera.x) / camera.scale, -VIEW_COORD, VIEW_COORD)),",
      "? { x: (live.viewport.width / 2 - live.camera.x) / live.camera.scale, y: (live.viewport.height / 2 - live.camera.y) / live.camera.scale }",
      "? { x: (live.viewport.width / 2 - cam.x) / cam.scale, y: (live.viewport.height / 2 - cam.y) / cam.scale }",
      "return { x: (stage.width / 2 - stage.x) / scale, y: (stage.height / 2 - stage.y) / scale, zoom: scale };",
      "x0: (insets.left - cam.x) / cam.scale,",
      "x1: (size.width - insets.right - cam.x) / cam.scale,",
      "return { x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale };",
      "return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };",
      "setCam({ ...c, x: at.x - p.x * c.scale, y: at.y - p.y * c.scale });",
      "return { x: cx - (target.x + target.width / 2) * scale, y: cy - (target.y + target.height / 2) * scale, scale };",
      "return { x: viewport.width / 2 - view.x * scale, y: viewport.height / 2 - view.y * scale, scale };",
    ];
    for (const line of before) assert.notDeepEqual(offenders(line), [], line);
    for (const b of BANNED) assert.ok(before.some((line) => b.pattern.test(line)), `${b.what} is tried on a line`);
  });

  test("the view API's own calls pass", () => {
    for (const line of [
      "const tip = viewToScreen(camera, toView(TOP_DOWN, pin));",
      "world: toWorld(TOP_DOWN, screenToView(c, p)),",
      "setCam(cameraAt(at, toView(TOP_DOWN, p), c.scale));",
      "? groundAtMiddle({ ...live, camera: cam })",
      "const hit = pinUnder(view, sceneRef.current, cameraOfStage(stage), p);",
      "const e = viewEvent(liveOfStage(stage, TOP_DOWN));",
      "const b = screenToView(cam, { x: size.width - insets.right, y: size.height - insets.bottom });",
      "w: clamp(live.viewport.width / scale, 0.01, 2_000),",
      "scaleX={cam.scale}",
    ]) {
      assert.deepEqual(offenders(line), [], line);
    }
  });
});
