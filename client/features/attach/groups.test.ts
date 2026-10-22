import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { groupFollowers } from "../../lib/group.ts";
import { boxesAround, boxesLess, carriesText, coversHolder, dragLead, dragNamed, drawOrder, drawsInset, dragWalkers, groupLine, groupMembers, holderMiddle, holderMiddles, pressBoxes, pressLead, reseatText, tethers, type CellBox } from "./groups.ts";

const byId = (...list: Token[]) => Object.fromEntries(list.map((t) => [t.id, t]));
const everyone = () => true;

describe("a press in a holder's middle (docs/design-v1-attach.md 4.4, review LP12-AT-3)", () => {
  /** Whether a press at a point in cells falls on the carried token's part that takes it, as its node's hit area draws. */
  const takes = (carried: Token, hole: CellBox | null, at: { x: number; y: number }) => {
    const x = at.x - carried.x;
    const y = at.y - carried.y;
    const w = carried.size === "tiny" ? 0.5 : carried.size === "large" ? 2 : 1;
    if (x < 0 || y < 0 || x > w || y > w) return false;
    return (hole ? boxesAround(w, w, hole) : [{ x: 0, y: 0, w, h: w }]).some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h);
  };

  test("a Medium holder's Tiny load leaves it the middle half square, so its quarters are grabbed only near its edges", () => {
    const thorn = token("thorn", { name: "Thorn", x: 2, y: 2 });
    const lamp = token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 2.5, y: 2, attached: { to: "thorn", kind: "carry" } });
    const owl = token("owl", { name: "Owl", size: "tiny", x: 2, y: 2, attached: { to: "thorn", kind: "perch" } });
    const tokens = byId(thorn, lamp, owl);
    assert.deepEqual(holderMiddle(tokens, lamp), { x: 0, y: 0.25, w: 0.25, h: 0.25 });
    assert.deepEqual(holderMiddle(tokens, owl), { x: 0.25, y: 0.25, w: 0.25, h: 0.25 });
    for (const t of [lamp, owl]) {
      const hole = holderMiddle(tokens, t);
      assert.equal(takes(t, hole, { x: 2.5, y: 2.5 }), false, `${t.id}: the middle is the holder's`);
      assert.equal(takes(t, hole, { x: 2.45, y: 2.4 }) || takes(t, hole, { x: 2.55, y: 2.4 }), false, `${t.id}: so is a little off it`);
    }
    assert.equal(takes(lamp, holderMiddle(tokens, lamp), { x: 2.9, y: 2.1 }), true, "near the edge the lamp is on top");
    assert.equal(takes(owl, holderMiddle(tokens, owl), { x: 2.1, y: 2.1 }), true, "and so is the owl");
  });

  test("a large holder keeps a half square at its center, and a token on no holder, dragged beside one or covering its holder keeps all of itself", () => {
    const horse = token("horse", { name: "Warhorse", size: "large", x: 4, y: 4 });
    const knight = token("knight", { name: "Knight", x: 4, y: 4, attached: { to: "horse", kind: "ride" } });
    const mastiff = token("mastiff", { name: "Mastiff", x: 8, y: 8 });
    const halfling = token("halfling", { name: "Pip", size: "small", x: 8, y: 8, attached: { to: "mastiff", kind: "ride" } });
    const goblin = token("goblin", { name: "Goblin", x: 6, y: 4, attached: { to: "horse", kind: "drag" } });
    const tokens = byId(horse, knight, mastiff, halfling, goblin);
    assert.deepEqual(holderMiddle(tokens, knight), { x: 0.75, y: 0.75, w: 0.25, h: 0.25 }, "the knight's corner nearest the horse's center");
    for (const t of [horse, halfling, goblin]) assert.equal(holderMiddle(tokens, t), null, t.id);
    const far = token("far", { name: "Far", size: "tiny", x: 4, y: 4, attached: { to: "horse", kind: "carry" } });
    assert.equal(holderMiddle(byId(horse, far), far), null, "the middle misses a seat in the horse's corner");
  });

  test("a press in a holder's middle reaches it through what it carries carrying more, an inset gem in a lamp too, and a knight's lamp over a horse's middle (review FU20A-ASTRA-5)", () => {
    /** The token a press at a point drags: the topmost one whose hit area takes it, as TokenNode draws them, led as dragLead leads. */
    const pressAt = (tokens: Record<string, Token>, at: { x: number; y: number }) => {
      const order = drawOrder(Object.values(tokens), tokens);
      for (const t of [...order].reverse()) {
        const w = t.size === "tiny" ? 0.5 : t.size === "large" ? 2 : 1;
        const x = at.x - t.x;
        const y = at.y - t.y;
        if (pressBoxes(w, w, drawsInset(tokens, t), holderMiddles(tokens, t)).some((b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h)) return dragLead(tokens, t).id;
      }
      return null;
    };
    const thorn = token("thorn", { name: "Thorn", x: 2, y: 2 });
    const lamp = token("lamp", { name: "Lamp", kind: "object", size: "tiny", x: 2.5, y: 2, attached: { to: "thorn", kind: "carry" } });
    const gem = token("gem", { name: "Gem", kind: "object", size: "tiny", x: 2.5, y: 2, attached: { to: "lamp", kind: "carry" } });
    const tokens = byId(thorn, lamp, gem);
    assert.equal(drawsInset(tokens, gem), true);
    assert.deepEqual(holderMiddles(tokens, gem), [{ x: 0, y: 0.25, w: 0.25, h: 0.25 }], "Thorn's middle, the lamp it covers leaving none");
    assert.equal(pressAt(tokens, { x: 2.65, y: 2.35 }), "thorn", "through the gem and the lamp");
    assert.equal(pressAt(tokens, { x: 2.85, y: 2.1 }), "lamp", "off the middle the gem moves the lamp it covers");
    const horse = token("horse", { name: "Warhorse", size: "large", x: 4, y: 4 });
    const knight = token("knight", { name: "Knight", x: 4, y: 4, attached: { to: "horse", kind: "ride" } });
    // The knight's torch in the knight's corner by the horse's center, where the knight's middle and the horse's each take a quarter of it.
    const torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4.5, y: 4.5, attached: { to: "knight", kind: "carry" } });
    const mounted = byId(horse, knight, torch);
    assert.deepEqual(holderMiddles(mounted, torch), [
      { x: 0, y: 0, w: 0.25, h: 0.25 },
      { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
    ]);
    assert.equal(pressAt(mounted, { x: 4.9, y: 4.9 }), "horse", "through the torch and the knight");
    assert.equal(pressAt(mounted, { x: 4.6, y: 4.6 }), "knight", "the knight's own middle");
    assert.equal(pressAt(mounted, { x: 4.6, y: 4.9 }), "torch", "off both middles the torch is on top");
    assert.equal(pressBoxes(0.5, 0.5, false, holderMiddles(mounted, torch)).reduce((sum, b) => sum + b.w * b.h, 0), 0.125, "half the torch takes a press");
    assert.deepEqual(boxesLess({ x: 0, y: 0, w: 1, h: 1 }, [{ x: 2, y: 2, w: 1, h: 1 }]), [{ x: 0, y: 0, w: 1, h: 1 }], "a hole that misses cuts nothing");
  });

  test("the part that takes a press is the footprint less the hole, in at most four boxes", () => {
    const boxes = boxesAround(1, 1, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    assert.deepEqual(boxes, [
      { x: 0, y: 0, w: 1, h: 0.25 },
      { x: 0, y: 0.75, w: 1, h: 0.25 },
      { x: 0, y: 0.25, w: 0.25, h: 0.5 },
      { x: 0.75, y: 0.25, w: 0.25, h: 0.5 },
    ]);
    assert.equal(boxes.reduce((sum, b) => sum + b.w * b.h, 0), 0.75);
    assert.deepEqual(boxesAround(0.5, 0.5, { x: 0, y: 0.25, w: 0.25, h: 0.25 }), [
      { x: 0, y: 0, w: 0.5, h: 0.25 },
      { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
    ]);
  });
});

describe("the draw order", () => {
  test("a carried token draws right after its holder, whatever its layer, and what it carries after it", () => {
    const thorn = token("b-thorn", { name: "Thorn", x: 2, y: 2 });
    const torch = token("a-torch", { name: "Torch", kind: "object", layer: "object", size: "tiny", x: 2, y: 2, attached: { to: "c-horse", kind: "carry" } });
    const horse = token("c-horse", { name: "Warhorse", size: "large", x: 2, y: 2 });
    const rider = token("d-rider", { name: "Bree", x: 2, y: 2, attached: { to: "c-horse", kind: "ride" } });
    const lamp = token("e-lamp", { name: "Lamp", kind: "object", size: "tiny", x: 2, y: 2, attached: { to: "d-rider", kind: "carry" } });
    const tokens = byId(thorn, torch, horse, rider, lamp);
    // As the canvas sorts them: objects first, then by id.
    const sorted = [torch, thorn, horse, rider, lamp];
    assert.deepEqual(drawOrder(sorted, tokens).map((t) => t.id), ["b-thorn", "c-horse", "a-torch", "d-rider", "e-lamp"]);
  });

  test("without a link the order is the canvas's own, and a holder on another scene leaves its token in place", () => {
    const a = token("a");
    const b = token("b", { attached: { to: "far", kind: "carry" } });
    const far = token("far", { sceneId: "s2" });
    assert.deepEqual(drawOrder([b, a], byId(a, b, far)).map((t) => t.id), ["b", "a"]);
  });

  test("a loop the rules let stand is drawn whole, once each", () => {
    const a = token("a", { attached: { to: "b", kind: "carry" } });
    const b = token("b", { attached: { to: "a", kind: "carry" } });
    assert.deepEqual(drawOrder([a, b], byId(a, b)).map((t) => t.id), ["a", "b"]);
  });
});

describe("covering riders", () => {
  test("a Small rider covers a Medium mastiff, and a Medium rider leaves a Large horse's edge", () => {
    const mastiff = token("m", { x: 1, y: 1 });
    const halfling = token("h", { size: "small", x: 1, y: 1, attached: { to: "m", kind: "ride" } });
    assert.equal(coversHolder(halfling, mastiff), true);
    assert.equal(drawsInset(byId(mastiff, halfling), halfling), true);
    const horse = token("horse", { size: "large", x: 1, y: 1 });
    const knight = token("k", { x: 1, y: 1, attached: { to: "horse", kind: "ride" } });
    assert.equal(drawsInset(byId(horse, knight), knight), false);
    // A dragged creature never sits on its holder, so it never draws inset.
    const dragged = token("d", { x: 1, y: 1, attached: { to: "m", kind: "drag" } });
    assert.equal(drawsInset(byId(mastiff, dragged), dragged), false);
  });
});

describe("what a drag moves", () => {
  const horse = token("horse", { name: "Warhorse", size: "large", x: 4, y: 4 });
  const steered = token("bree", { name: "Bree", x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
  const free = token("vex", { name: "Vex", x: 5, y: 5, attached: { to: "horse", kind: "ride" } });

  test("a rider of a controlled mount drags the mount, and any other rider drags itself", () => {
    const tokens = byId(horse, steered, free);
    assert.equal(dragLead(tokens, steered).id, "horse");
    assert.equal(dragLead(tokens, free).id, "vex");
    assert.equal(dragLead(tokens, horse).id, "horse");
    assert.equal(carriesText(horse, steered), "Warhorse carries Bree. Tap Get off to step down.");
  });

  test("a carried token that covers its holder drags the holder, up the chain while that holds", () => {
    const cart = token("cart", { kind: "object", size: "large", x: 0, y: 0 });
    const mastiff = token("m", { x: 0, y: 0, attached: { to: "cart", kind: "carry" } });
    const pup = token("p", { size: "small", x: 0, y: 0, attached: { to: "m", kind: "ride" } });
    assert.equal(dragLead(byId(cart, mastiff, pup), pup).id, "m", "the mastiff only sits on the cart, so it drags itself");
  });

  test("a selection names each token once: a rider with its mount moves as the mount's group, and a steered rider as its mount", () => {
    const thorn = token("thorn", { x: 10, y: 10 });
    const torch = token("torch", { kind: "object", size: "tiny", x: 4, y: 4, attached: { to: "horse", kind: "carry" } });
    const tokens = byId(horse, steered, free, thorn, torch);
    const map = new Map(Object.values(tokens).map((t) => [t.id, t]));
    assert.deepEqual(dragNamed(tokens, thorn, [steered, torch, free], map, () => true).map((t) => t.id), ["thorn", "horse"]);
    // A mount the viewer may not move keeps its rider where it is.
    assert.deepEqual(dragNamed(tokens, thorn, [steered], map, () => false).map((t) => t.id), ["thorn"]);
  });

  test("a press on a token whose holder is selected too drags the holder, so a free rider goes with its horse and is never walked off it", () => {
    const tokens = byId(horse, steered, free);
    const map = new Map(Object.values(tokens).map((t) => [t.id, t]));
    const parts = (selected: string[], canDrag: (t: Token) => boolean = () => true, movesLead = canDrag) => {
      const lead = pressLead(tokens, free, map, new Set(selected), canDrag, movesLead);
      const followers = groupFollowers(selected, free.id, map, canDrag, (t) => map.get(t.attached?.to ?? ""), lead.id === free.id ? [] : [lead.id]);
      return { lead: lead.id, named: dragNamed(tokens, lead, followers, map, movesLead).map((t) => t.id) };
    };
    assert.deepEqual(parts(["vex", "horse"]), { lead: "horse", named: ["horse"] });
    // Unselected, or a horse the viewer may not drag, and the press drags the rider alone, off its horse.
    assert.deepEqual(parts(["vex"]), { lead: "vex", named: ["vex"] });
    assert.deepEqual(parts(["vex", "horse"], (t) => t.id !== "horse"), { lead: "vex", named: ["vex"] });
    // A horse a player may only give a new seat still leads, and the drag is that re-seat (canvas/Stage.tsx).
    assert.deepEqual(parts(["vex", "horse"], () => true, (t) => t.id !== "horse"), { lead: "horse", named: ["horse"] });
    // Up the chain: a pup on a mastiff on a selected cart moves the cart.
    const cart = token("cart", { kind: "object", size: "large", x: 0, y: 0 });
    const mastiff = token("m", { x: 0, y: 0, attached: { to: "cart", kind: "carry" } });
    const pup = token("p", { size: "small", x: 0, y: 0, attached: { to: "m", kind: "ride" } });
    const chain = byId(cart, mastiff, pup);
    assert.equal(pressLead(chain, pup, new Map(Object.values(chain).map((t) => [t.id, t])), new Set(["p", "cart"]), () => true, () => true).id, "cart");
  });

  test("a group moves at most a group's limit of tokens beside its lead", () => {
    const list = [token("lead", { size: "gargantuan", x: 0, y: 0 })];
    for (let i = 0; i < 25; i++) list.push(token(`c${String(i).padStart(2, "0")}`, { kind: "object", size: "tiny", x: 0, y: 0, attached: { to: "lead", kind: "carry" } }));
    assert.equal(groupMembers(byId(...list), "lead").length, 20);
  });

  test("the walkers beside a holder are the creatures it drags that every player sees", () => {
    const thorn = token("thorn", { x: 2, y: 2 });
    const goblin = token("g", { x: 3, y: 2, attached: { to: "thorn", kind: "drag" } });
    const hidden = token("h", { x: 1, y: 2, visibility: "dm", attached: { to: "thorn", kind: "drag" } });
    const torch = token("t", { kind: "object", size: "tiny", x: 2, y: 2, attached: { to: "thorn", kind: "carry" } });
    const tokens = byId(thorn, goblin, hidden, torch);
    assert.deepEqual(dragWalkers(tokens, "thorn", (t) => tokens[t.id]?.visibility !== "dm").map((t) => t.id), ["g"]);
    assert.deepEqual(dragWalkers(tokens, "thorn", everyone).map((t) => t.id), ["g", "h"]);
  });
});

describe("tethers and the group line", () => {
  const thorn = token("thorn", { name: "Thorn", x: 2, y: 2, disposition: "ally" });
  const goblin = token("g", { name: "Goblin", number: 2, x: 3, y: 2, attached: { to: "thorn", kind: "drag" } });
  const torch = token("t", { name: "Torch", kind: "object", size: "tiny", x: 2, y: 2, attached: { to: "thorn", kind: "carry" } });
  const tokens = byId(thorn, goblin, torch);

  test("a drag link draws from the dragged creature's center to its holder's, and only a drag", () => {
    assert.deepEqual(tethers(tokens, "s1"), [{ id: "g", holderId: "thorn", from: { x: 3.5, y: 2.5 }, to: { x: 2.5, y: 2.5 } }]);
    assert.deepEqual(tethers(tokens, "s2"), []);
    // A drag in progress on this device draws the line where the tokens are being dragged.
    assert.deepEqual(tethers(tokens, "s1", (t) => (t.id === "thorn" ? { x: 5, y: 5 } : t))[0]?.to, { x: 5.5, y: 5.5 });
  });

  test("a carried token names its holder, and a holder each token it carries", () => {
    assert.deepEqual(groupLine(tokens, goblin).holder, { id: "thorn", text: "Dragged by Thorn" });
    assert.deepEqual(groupLine(tokens, torch).holder, { id: "thorn", text: "On Thorn" });
    const line = groupLine(tokens, thorn);
    assert.equal(line.holder, null);
    assert.deepEqual(line.carried.map((c) => c.name), ["Goblin 2", "Torch"]);
    assert.equal(reseatText(goblin, thorn), "You can only move Goblin 2 within 5 ft of Thorn.");
    assert.equal(reseatText(torch, thorn), "You can only move Torch on Thorn.");
  });
});
