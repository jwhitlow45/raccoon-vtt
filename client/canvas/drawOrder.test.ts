import assert from "node:assert/strict";
import { test } from "node:test";
import type { Drawing, Token } from "#shared/model.ts";
import { drawing, room, token } from "#shared/testutil.ts";
import { tokenDrawOrder } from "../features/attach/groups.ts";
import { drawingOrder } from "../features/drawings/geometry.ts";
import { keptRulerOrder } from "../features/measure/ruler.ts";
import { characterTokensOn } from "../features/tokens/companions.ts";

/** Ids whose order is the reverse of the order the rule should give, so only the rule can put them right. */
const ID = (n: number) => `${String(9 - n).repeat(8)}-0000-8000-8000-000000000000`;

test("a fill draws first, then strokes and unfilled shapes, then text, each by id", () => {
  const style = { stroke: "#ffffff", width: 2, opacity: 1 };
  // The text holds the lowest id and the fills the highest, so id order alone would draw them the other way up.
  const list: Drawing[] = [
    drawing(ID(4), { kind: "text", text: "Here", style }),
    drawing(ID(3), { kind: "rect", style }),
    drawing(ID(2), { kind: "free", style }),
    drawing(ID(1), { kind: "ellipse", style: { ...style, fill: "#ff000055" } }),
    drawing(ID(0), { kind: "rect", style: { ...style, fill: "#ff000055" } }),
  ];
  assert.deepEqual([...list].sort(drawingOrder).map((d) => d.id), [ID(1), ID(0), ID(3), ID(2), ID(4)]);
});

test("objects draw under creatures, a larger one under a smaller one, then by id", () => {
  const list: Token[] = [
    token(ID(0), { size: "medium" }),
    token(ID(1), { size: "large" }),
    token(ID(2), { size: "custom", w: 3, h: 3 }),
    token(ID(3), { size: "medium" }),
    token(ID(4), { kind: "object", layer: "object", size: "tiny" }),
  ];
  assert.deepEqual([...list].sort(tokenDrawOrder).map((t) => t.id), [ID(4), ID(2), ID(1), ID(3), ID(0)], "the chest, then 3 by 3, Large, and the two Medium by id");
});

test("kept rulers list by their first stop, top to bottom, then left to right, then by id", () => {
  const ruler = (n: number, x: number, y: number) => drawing(ID(n), { kind: "ruler", points: [x, y, x + 3, y] });
  const list = [ruler(0, 9, 1), ruler(1, 2, 5), ruler(2, 1, 1), ruler(3, 1, 1)];
  assert.deepEqual([...list].sort(keptRulerOrder).map((d) => d.id), [ID(3), ID(2), ID(0), ID(1)]);
});

test("a companion goes beside the character's selected token, else the topmost, then the leftmost", () => {
  const state = room();
  for (const [n, x, y] of [[0, 9, 9], [1, 5, 2], [2, 1, 2], [3, 4, 1]] as const) state.tokens[ID(n)] = token(ID(n), { kind: "pc", x, y, actor: { ref: "c1" } });
  assert.deepEqual(characterTokensOn(state, "c1", "s1").map((t) => t.id), [ID(3), ID(2), ID(1), ID(0)]);
  assert.equal(characterTokensOn(state, "c1", "s1", [ID(0)])[0]!.id, ID(0), "the selected one first");
});
