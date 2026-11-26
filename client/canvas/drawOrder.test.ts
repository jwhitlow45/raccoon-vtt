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

test("drawings of one kind draw in board order, by the top, then the left, of their boxes, then by id", () => {
  const style = { stroke: "#ffffff", width: 2, opacity: 1, fill: "#ff000055" };
  const box = (n: number, x: number, y: number) => drawing(ID(n), { kind: "rect", points: [x + 2, y + 2, x, y], style });
  // A box drawn from its bottom right corner is placed by its top left all the same.
  const list = [box(0, 9, 1), box(1, 2, 5), box(2, 1, 1), box(3, 1, 1), drawing(ID(4), { kind: "free", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 2, opacity: 1 } })];
  assert.deepEqual([...list].sort(drawingOrder).map((d) => d.id), [ID(3), ID(2), ID(0), ID(1), ID(4)]);
});

test("a drawing's points are scanned once however many drawings it is compared with", () => {
  const style = { stroke: "#ffffff", width: 2, opacity: 1 };
  let reads = 0;
  const counted = (n: number, points: number[]) => {
    const proxied = new Proxy(points, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    return drawing(ID(n), { kind: "free", points: proxied, style });
  };
  const list = Array.from({ length: 50 }, (_, n) => counted(n % 10, [(n * 7) % 5, (n * 3) % 4, 9 + n, 9]));
  const sorted = [...list].sort(drawingOrder);
  assert.equal(reads, 50 * 4 * 2, "one scan each (bounds reads a value for its low and its high), not one per comparison");
  const reference = [...list].sort((a, b) => (a.points[1]! - b.points[1]! || a.points[0]! - b.points[0]! || b.points[2]! - a.points[2]! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  assert.deepEqual(sorted.map((d) => d.id), reference.map((d) => d.id));
});

test("drawings that share a corner never order by id: the taller, then the wider box draws first, then the points, and the id only for twins", () => {
  const style = { stroke: "#ffffff", width: 2, opacity: 1, fill: "#ff000055" };
  const box = (n: number, w: number, h: number, x = 1) => drawing(ID(n), { kind: "rect", points: [x, 1, x + w, 1 + h], style });
  const list = [box(0, 2, 2), box(1, 4, 4), box(2, 3, 3), box(3, 4, 2), box(4, 2, 2)];
  const expected = [box(1, 4, 4), box(2, 3, 3), box(3, 4, 2), box(4, 2, 2), box(0, 2, 2)].map((d) => d.id);
  // Each order of the same list lays the boxes in one order, whatever their ids say.
  for (const rotated of [list, [...list].reverse(), [list[2]!, list[4]!, list[0]!, list[3]!, list[1]!]]) {
    assert.deepEqual([...rotated].sort(drawingOrder).map((d) => d.id), expected);
  }
  const differ = [drawing(ID(0), { kind: "free", points: [1, 1, 5, 2, 3, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 } }), drawing(ID(1), { kind: "free", points: [1, 1, 5, 2, 4, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 } })];
  const lone = (n: number, stroke: string) => drawing(ID(n), { kind: "rect", points: [1, 1, 2, 2], style: { stroke, width: 2, opacity: 1 } });
  assert.deepEqual([...differ].sort(drawingOrder).map((d) => d.id), [ID(0), ID(1)]);
  assert.deepEqual([lone(0, "#00ff00"), lone(1, "#ff0000")].sort(drawingOrder).map((d) => d.id), [ID(0), ID(1)], "the same box in two colors orders by color, here 00ff00 before ff0000");
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
