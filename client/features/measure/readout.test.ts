import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pillLines } from "./readout.ts";

/** Every character is half an em wide, so 12 px text is 6 px a character. */
const measure = (text: string, px: number) => [...text].length * px * 0.5;

describe("pill text", () => {
  test("a distance is never cut, however long the name in front of it", () => {
    const lines = pillLines({ name: "Bartholomew the Bold of the Seven Shattered Kingdoms", value: "125 ft", px: 12, maxWidth: 120 }, measure);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.endsWith(" · 125 ft"), lines[0]);
    assert.match(lines[0]!, /^Bart\S*…/u);
  });

  test("a name with no room for four letters is left out, never the distance", () => {
    assert.deepEqual(pillLines({ name: "Bartholomew", value: "1,250 ft", px: 12, maxWidth: 60 }, measure), ["1,250 ft"]);
  });

  test("a movement keeps both its lines whole", () => {
    const value = "Moved 20 ft\nFly: 5 ft left with Dash · Swim 10 ft";
    assert.deepEqual(pillLines({ value, px: 12, maxWidth: 60 }, measure), value.split("\n"));
  });

  test("a name alone wraps onto two lines, then is cut on the second", () => {
    assert.deepEqual(pillLines({ name: "Spirit Guardians", px: 12, maxWidth: 240 }, measure), ["Spirit Guardians"]);
    const two = pillLines({ name: "Spirit Guardians of the Morninglord, radiant, half on a save", px: 12, maxWidth: 240 }, measure);
    assert.equal(two.length, 2);
    const cut = pillLines({ name: "Spirit Guardians of the Morninglord, radiant, half damage on a successful save, ends at dawn", px: 12, maxWidth: 240 }, measure);
    assert.equal(cut.length, 2);
    assert.ok(cut[1]!.endsWith("…"));
  });

  test("a name held to one line is cut on it, for a smaller pill in a crowd", () => {
    const one = pillLines({ name: "Spirit Guardians of the Morninglord, radiant, half on a save", px: 12, maxWidth: 240, maxLines: 1 }, measure);
    assert.equal(one.length, 1);
    assert.ok(one[0]!.endsWith("…"));
    assert.ok(measure(one[0]!, 12) <= 240);
  });

  test("a name that fits whole keeps its line when the pill asks to stack, and its value goes under it (FL2-POLISH)", () => {
    // "Up to Upper floor · Not reached yet" is 35 characters, 210 px: too wide for 200, so the plain pill cuts the name to fit.
    const input = { name: "Up to Upper floor", value: "Not reached yet", px: 12, maxWidth: 200 };
    assert.deepEqual(pillLines(input, measure), ["Up to Upper fl… · Not reached yet"]);
    assert.deepEqual(pillLines({ ...input, stack: true }, measure), ["Up to Upper floor", "Not reached yet"]);
    assert.deepEqual(pillLines({ ...input, stack: true, maxWidth: 240 }, measure), ["Up to Upper floor · Not reached yet"]);
    // A name too long for a line of its own is still cut beside the value.
    assert.equal(pillLines({ ...input, name: "Up to the Very Long Floor Name Of The Keep", stack: true }, measure).length, 1);
  });
});
