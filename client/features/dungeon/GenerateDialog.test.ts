import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { previewSide } = await import("./GenerateDialog.tsx");

/*
 * The wide card's preview side: half the room is the floor, and the choices
 * keep 360 px (a side panel's width) once the body is 736 px wide.
 */

const TALL = 10_000;
const GAP = 16;

test("the choices get 360 px from a body width of 736, and the columns split evenly below it", () => {
  for (const [width, side] of [
    [735, 359],
    [736, 360],
    [737, 361],
    [700, 342],
  ] as const) {
    assert.equal(previewSide(width, TALL), side, `body ${width}`);
  }
  for (const width of [736, 737, 900, 1006]) assert.ok(width - GAP - previewSide(width, TALL) >= 360 - 1, `choices at ${width}`);
  assert.equal(736 - GAP - previewSide(736, TALL), 360);
});

test("a short body caps the side at its height", () => {
  assert.equal(previewSide(1006, 601), 601);
  assert.equal(previewSide(1006, 529), 529);
  assert.equal(previewSide(1006, TALL), 630);
});

test("a body narrower than the gap gives 0", () => {
  assert.equal(previewSide(10, TALL), 0);
});

/*
 * DG-R2-02: the preview box stands in one place of the tree whatever the
 * card's width, or crossing 640 px remounts it empty while Make is still on.
 * DGFIX-FU-1: the error lines are pinned above the foot, not at the top of
 * the choices that scroll away.
 */
const { readFileSync } = await import("node:fs");
const source = readFileSync(new URL("./GenerateDialog.tsx", import.meta.url), "utf8");

test("DG-R2-02: the preview box is rendered once, in a wrapper whose style changes with the width", () => {
  assert.equal(source.match(/\{previewBox\}/g)?.length, 1);
});

test("DGFIX-FU-1: the errors share the pinned foot with the fog warning, and the choices column holds none", () => {
  const choices = source.slice(source.indexOf("const choicesBox"), source.indexOf("return (\n    <Dialog"));
  assert.doesNotMatch(choices, /<ErrorText>/);
  const pinned = source.slice(source.indexOf("...PINNED_FOOT") - 200, source.indexOf("</Dialog>"));
  assert.match(pinned, /errorLine/);
});

/*
 * Phase 2 (design-phase2 4.1, 15): Theme offers all five, Secret doors is
 * held at None on Cave without touching the DM's pick, Look closer sits in
 * the preview's bottom left corner, and the light line stays in the tree
 * through a Lit rooms change.
 */
test("DG2C: Theme offers every theme, and a theme change touches no other choice", () => {
  assert.match(source, /options=\{THEMES\.map\(/);
  assert.match(source, /onChange=\{\(theme\) => set\(\{ theme \}\)\}/);
});

test("DG2C: Cave holds Secret doors at None for display and keeps the DM's pick in the choices", () => {
  assert.match(source, /<Held held=\{cave\}/);
  assert.match(source, /value=\{cave \? 0 : choices\.secrets\}/);
  assert.match(source, /words=\{secretsWords\(cave \? 0 : choices\.secrets, rooms\)\}/);
  assert.doesNotMatch(source, /set\(\{ secrets: 0 \}\)/);
});

test("DG2C: the light line shows while Lit rooms is above None, and its tap lives in the dialog", () => {
  assert.match(source, /choices\.lit > 0 \? <LightLine kept=\{keptLit\}/);
  assert.match(source, /const \[keptLit, setKeptLit\] = useState\(false\)/);
  assert.match(source, /const startsDark = choices\.lit > 0 && !keptLit/);
});

test("DG2C: Look closer stands in the preview's left corner and Reroll keeps the right one", () => {
  assert.match(source, /leftCorner=\{<LookCloser /);
  assert.equal(source.match(/<LookCloser /g)?.length, 1);
});

test("DG2C: the preview is asked for with the key only when DM key is on and not held", () => {
  assert.match(source, /choices\.key && !keyHeld && myColor \? \{ name: sceneName, color: myColor, feetPerCell \} : null/);
});
