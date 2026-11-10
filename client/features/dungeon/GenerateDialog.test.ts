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
// The rows are the shared Choices (phase 3, D-261110-239).
const rows = readFileSync(new URL("./Choices.tsx", import.meta.url), "utf8");

test("DG2C: Theme offers every theme, and a theme change touches no other choice", () => {
  assert.match(rows, /options=\{THEMES\.map\(/);
  assert.match(rows, /onChange=\{\(theme\) => set\(\{ theme \}\)\}/);
  assert.match(source, /onChange=\{\(next\) => set\(changed\(settings, next\)\)\}/);
});

test("DG2C: Cave holds Secret doors at None for display and keeps the DM's pick in the choices", () => {
  assert.match(rows, /<Held held=\{cave\}/);
  assert.match(rows, /value=\{cave \? 0 : value\.secrets\}/);
  assert.match(rows, /words=\{secretsWords\(cave \? 0 : value\.secrets, rooms\)\}/);
  assert.doesNotMatch(rows, /set\(\{ secrets: 0 \}\)/);
});

// The lanes meet here (phase 2 section 6): a send compares references through withIds' map.
test("DG2M: Make sends withIds' map with the ops", () => {
  assert.match(source, /sendDungeon\(\s*\{ ops, sceneId: made\.sceneId, room: current\.room, ids: made\.ids \}/);
});

test("DG2C: the light line shows while Lit rooms is above None, and its tap lives in the dialog", () => {
  assert.match(rows, /\{value\.lit > 0 \? props\.light : null\}/);
  assert.match(source, /light=\{<LightLine kept=\{keptLit\}/);
  assert.match(source, /const \[keptLit, setKeptLit\] = useState\(false\)/);
  assert.match(source, /const startsDark = choices\.lit > 0 && !keptLit/);
});

test("DG2C: Look closer stands in the preview's left corner and Reroll keeps the right one", () => {
  assert.match(source, /leftCorner=\{<LookCloser /);
  assert.equal(source.match(/<LookCloser /g)?.length, 1);
});

test("DG2C: the preview is asked for with the key only when DM key is on and not held", () => {
  assert.match(source, /choices\.key && !keyHeld && myColor \? \{ name: keyName, color: myColor, feetPerCell \} : null/);
  assert.match(source, /const keyName = props\.floor \? floorKeyName\(sceneName, floorName\) : sceneName/);
});

/*
 * Aimed at a floor (docs/design/design-v1-floors.md phase 3, 3.7): the size
 * a floor opens at is never remembered, every close waits for the create's
 * answer, the browser's own close included, the add's refusals are asked
 * before anything is sent, and the floor's light and walls are sent whole.
 */
test("FL3S: a floor's autosave writes every choice but the size, which keeps what was remembered as it opened", () => {
  assert.match(source, /startChoices\(saved, props\.form, props\.floor \? props\.form : undefined\)/);
  assert.match(source, /kept: props\.floor \? keptSize\(saved, choices\.rooms\) : undefined/);
  assert.match(source, /saveChoices\(props\.roomId, choices, undefined, start\.kept\)/);
});

test("FL3S: while a floor's create waits, Hide is busy, every close does nothing and a native close opens the dialog again on Hide", () => {
  const close = source.slice(source.indexOf("const close = () =>"), source.indexOf("const set = (patch"));
  assert.match(close, /if \(holding\) return;/);
  assert.match(source, /\{\.\.\.\(holding \? \{ keepOpen: hideRef \} : null\)\}/);
  assert.match(source, /<Button ref=\{hideRef\} busy=\{holding\} onClick=\{close\}/);
  assert.match(source, /\{holding \? MAKING_FLOOR : busy \? "Hide"/);
  assert.match(source, /if \(floor\) setHolding\(true\);/);
  assert.match(source, /onCreated: \(\) => \{\s*if \(mounted\.current\) setHolding\(false\);/);
  // At most CHECK_MS, so a create whose answer never comes never traps the DM.
  assert.match(source, /setTimeout\(\(\) => setHolding\(false\), CHECK_MS\)/);
});

test("FL3S: Make asks the add's refusals on the latest view before any op, and makes the floor with its theme's name and its light sent whole", () => {
  const make = source.slice(source.indexOf("const make = async"), source.indexOf("// The foot counts"));
  const refusal = make.indexOf("floorAddRefusal(view, floor)");
  assert.ok(refusal > 0 && refusal < make.indexOf("withIds("), "the refusal comes first");
  assert.match(make, /if \(refused\) \{\s*setFailed\(\{ text: refused, retry: true \}\);\s*return;/);
  assert.match(make, /floorCreateOf\(startScene\(op\.scene, pick, startsDark\), floor, floorName, "own"\)/);
  assert.match(source, /const floorName = CHOICE_NAMES\.theme\[choices\.theme\]/);
  assert.match(make, /keyName: \(stored\) => floorKeyName\(sceneName, stored\)/);
  assert.match(make, /floorOutcomeText\(outcome, named, sceneName, opened\)/);
});
