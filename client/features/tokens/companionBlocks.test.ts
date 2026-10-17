import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CHUNK_CELLS, type Actor, type BuildChunk, type EdgeFeature, type RoomState, type Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { P1, actor, character, companionBlock, customMonster, env, room, token } from "#shared/testutil.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import {
  afterLinkAnswer,
  attachActorPatch,
  blockDetail,
  blockNumbers,
  blockRow,
  fromTheBlock,
  lateAttachText,
  pickerLists,
  sizePlan,
  speedText,
  startAttach,
  type AttachDeps,
  type AttachPhase,
  type HpChoice,
} from "./companionBlocks.ts";

const SRD = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const srd = (id: string) => SRD.find((m) => m.srdId === id)!;
const OWL = srd("owl");
const WOLF = srd("wolf");

/** Hoot, Bree's companion, added with typed numbers: AC 10, 6 HP, Small, a 30 ft walk, no senses (section 6.9.3). */
function hoot(over: Partial<Actor> = {}): Actor {
  return actor({ hp: { cur: 6, max: 6, temp: 0 }, ac: 10, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", dmNotes: "", ...over });
}

function room_(over: Partial<Actor> = {}): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.hoot = token("hoot", { kind: "npc", name: "Hoot", size: "small", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: hoot(over) } });
  state.companionBlocks.moth = companionBlock("moth", "bree");
  return state;
}

const HOOT = { name: "Hoot" } satisfies Pick<Token, "name">;
const average: HpChoice = { kind: "average" };

/** The patch applied as the player sends it, through the permissions and the reducer. */
function attached(state: RoomState, patch: Record<string, unknown>): Actor {
  const op = { t: "token.update", tokenId: "hoot", patch: { actor: patch } } as Op;
  assert.ok(clientOpSchema.safeParse(op).success, JSON.stringify(patch));
  const allowed = canApply(op, P1, state, { canUseAsset: () => true });
  assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
  const r = applyOp(state, op, P1, env(1));
  assert.ok(r.ok, r.ok ? "" : r.message);
  const a = r.state.tokens.hoot!.actor;
  assert.ok("inline" in a);
  return a.inline;
}

describe("the numbers a block sets (docs/design-v1-companion-stat-blocks.md 5.1)", () => {
  test("an SRD owl on Hoot: each number that changes, with the one it has now, and the HP it keeps at full", () => {
    const n = blockNumbers(OWL, HOOT, hoot(), average);
    assert.deepEqual(n.lines, ["AC 11, now 10", "Speed 5 ft, fly 60 ft, now 30 ft", "Darkvision 120 ft, now none", "Passive Perception 15, now 10", "Initiative +1, now +0"]);
    assert.deepEqual(n.patch, { ac: 11, speeds: { walk: 5, fly: 60 }, senses: "Darkvision 120 ft.", passivePerception: 15, initBonus: 1, hp: { max: 1, cur: 1 } });
    assert.equal(n.hpLine, "Hoot is unhurt, so it stays at full HP: 1 of 1.");
    assert.equal(n.average, 1);
    assert.equal(n.size, "tiny");
    assert.equal("size" in n.patch, false, "the size never rides with the numbers");
  });

  test("a stored block reads through monsterView, so every kind of block goes one path", () => {
    const stored = companionBlock("moth", "bree", { speed: "10 ft., Fly 40 ft. (hover)" });
    const n = blockNumbers(monsterView(stored), HOOT, hoot(), average);
    assert.deepEqual(n.patch.speeds, { walk: 10, fly: 40, hover: true });
    assert.ok(n.lines.includes("Speed 10 ft, fly 40 ft (hover), now 30 ft"));
    assert.deepEqual(n.patch.hp, { max: 9, cur: 9 });
  });

  test("a value that would not change shows no line and sends nothing", () => {
    const same = hoot({ ac: 11, speeds: { walk: 5, fly: 60 }, senses: "Darkvision 120 ft.", passivePerception: 15, initBonus: 1, hp: { cur: 1, max: 1, temp: 0 } });
    const n = blockNumbers(OWL, HOOT, same, average);
    assert.deepEqual(n.lines, []);
    assert.deepEqual(n.patch, {});
  });

  test("max HP: the average, a typed number or the maximum it has, and nothing until a number is typed", () => {
    assert.deepEqual(blockNumbers(WOLF, HOOT, hoot(), average).patch.hp, { max: 11, cur: 11 });
    assert.deepEqual(blockNumbers(WOLF, HOOT, hoot(), { kind: "typed", value: 25 }).patch.hp, { max: 25, cur: 25 });
    const kept = blockNumbers(WOLF, HOOT, hoot(), { kind: "keep" });
    assert.equal(kept.patch.hp, undefined);
    assert.equal(kept.hpLine, "Hoot is unhurt, so it stays at full HP: 6 of 6.");
    const untyped = blockNumbers(WOLF, HOOT, hoot(), { kind: "typed", value: null });
    assert.deepEqual([untyped.patch.hp, untyped.max, untyped.hpLine], [undefined, null, ""]);
  });

  test("an average under 1 is not offered", () => {
    const zero = { ...monsterView(customMonster("x", { hp: { average: 0, formula: "" } })) };
    assert.equal(blockNumbers(zero, HOOT, hoot(), average).average, null);
    assert.equal(blockNumbers(zero, HOOT, hoot(), average).patch.hp, undefined);
  });

  test("senses longer than an actor holds are cut with an ellipsis", () => {
    const long = monsterView(customMonster("x", { senses: `Blindsight 30 ft., ${"Tremorsense 60 ft., ".repeat(6)}Truesight 10 ft.` }));
    const senses = blockNumbers(long, HOOT, hoot(), average).patch.senses!;
    assert.ok(senses.length <= 80, `${senses.length}`);
    assert.ok(senses.endsWith("…"));
  });

  test("never the initiative score, type, CR, XP, legendary uses or the DM's notes, and every patch is one its player may send", () => {
    const dragon = monsterView(customMonster("x", { traits: [{ name: "Legendary Resistance (3/Day)", text: "" }], legendaryActions: [{ name: "Legendary Action Uses: 3", text: "" }] }));
    for (const view of [OWL, WOLF, dragon]) {
      for (const hp of [average, { kind: "typed", value: 30 } as const, { kind: "keep" } as const]) {
        const n = blockNumbers(view, HOOT, hoot(), hp);
        for (const field of ["initScore", "creatureType", "cr", "xp", "legendary", "dmNotes", "size"]) assert.equal(field in n.patch, false, field);
        const state = room_();
        attached(state, attachActorPatch({ srdId: "owl" }, true, n));
        attached(state, attachActorPatch({ blockId: "moth" }, true, n));
      }
    }
  });

  test("Keep sends the link alone, and Use the link with the numbers", () => {
    const n = blockNumbers(OWL, HOOT, hoot(), average);
    assert.deepEqual(attachActorPatch({ srdId: "owl" }, false, n), { srdId: "owl" });
    assert.deepEqual(attachActorPatch({ blockId: "moth" }, true, n), { blockId: "moth", ...n.patch });
    const kept = attached(room_(), attachActorPatch({ srdId: "owl" }, false, n));
    assert.deepEqual([kept.srdId, kept.ac, kept.hp.max], ["owl", 10, 6]);
  });
});

describe("current HP when a block is attached (docs/design-v1-companion-stat-blocks.md 5.2)", () => {
  const hpOf = (a: Actor) => [a.life, a.hp.cur, a.hp.max, a.hp.temp];
  const apply = (over: Partial<Actor>, hp: HpChoice = average) => {
    const state = room_(over);
    const before = (state.tokens.hoot!.actor as { inline: Actor }).inline;
    const n = blockNumbers(WOLF, HOOT, before, hp);
    return { n, after: attached(state, attachActorPatch({ srdId: "wolf" }, true, n)) };
  };

  test("an unhurt creature stays at full HP at the new maximum, 0 of 0 counted as unhurt, and its temporary HP stays", () => {
    assert.deepEqual(hpOf(apply({ hp: { cur: 6, max: 6, temp: 3 } }).after), ["alive", 11, 11, 3]);
    const zero = apply({ hp: { cur: 0, max: 0, temp: 0 } });
    assert.deepEqual(hpOf(zero.after), ["alive", 11, 11, 0]);
    assert.equal(zero.n.hpLine, "Hoot is unhurt, so it stays at full HP: 11 of 11.");
  });

  test("a hurt creature gets the maximum alone, keeping its HP, or cut to a lower maximum", () => {
    const hurt = apply({ hp: { cur: 4, max: 6, temp: 0 } });
    assert.deepEqual(hpOf(hurt.after), ["alive", 4, 11, 0]);
    assert.equal(hurt.n.hpLine, "Hoot keeps its 4 HP, now of 11.");
    const cut = apply({ hp: { cur: 5, max: 30, temp: 0 } });
    assert.deepEqual(hpOf(cut.after), ["alive", 5, 11, 0]);
    const lower = apply({ hp: { cur: 20, max: 30, temp: 0 } }, { kind: "typed", value: 8 });
    assert.deepEqual(hpOf(lower.after), ["alive", 8, 8, 0]);
    assert.equal(lower.n.hpLine, "Hoot’s HP is cut to its new maximum: 8 of 8.");
  });

  test("the dying, the stable and the dead get the maximum alone and stay so, whatever healing brings back", () => {
    for (const life of ["dying", "stable", "dead"] as const) {
      const r = apply({ life, hp: { cur: 0, max: 6, temp: 0 } });
      assert.deepEqual(hpOf(r.after), [life, 0, 11, 0], life);
      assert.equal(r.n.patch.hp?.cur, undefined, life);
      assert.equal(r.n.hpLine, `Hoot is ${life} and stays so: 0 of 11.`);
    }
  });
});

describe("the attach's answer and its words", () => {
  test("taken closes, a refusal keeps the step with the server's words, and unknown says to check the panel", () => {
    assert.deepEqual(afterLinkAnswer("taken", "Hoot"), { phase: "done" });
    assert.deepEqual(afterLinkAnswer("refused", "Hoot", { message: "that is not here" }), { phase: "refused", line: "That is not here." });
    assert.deepEqual(afterLinkAnswer("unknown", "Hoot"), { phase: "unknown", line: "The connection dropped before the server answered. Check Hoot’s panel before attaching again." });
  });

  test("an answer after the dialog closed: nothing once taken, a toast for a refusal or a lost answer", () => {
    assert.equal(lateAttachText("Owl", "Hoot", "taken"), null);
    assert.equal(lateAttachText("Owl", "Hoot", "refused", { message: "that is not yours" }), "Owl was not attached to Hoot. That is not yours.");
    assert.match(lateAttachText("Owl", "Hoot", "unknown")!, /may not be attached to Hoot/);
  });

});

describe("the attach's size, through the token window's resize (docs/design-v1-companion-stat-blocks.md 5.1)", () => {
  /** Hoot, Bree's Small owl, at (4, 4) on a scene that blocks moves, with walls as given, and a Large block for it. */
  function scene(edges: Record<string, EdgeFeature> = {}, over: Partial<Token> = {}): RoomState {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
    state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", blockMovement: true };
    for (const [key, f] of Object.entries(edges)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const cx = Math.floor(x / CHUNK_CELLS);
      const cy = Math.floor(y / CHUNK_CELLS);
      const chunk: BuildChunk = (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
      chunk.edges[key] = f;
    }
    state.tokens.hoot = token("hoot", { kind: "npc", name: "Hoot", size: "small", x: 4, y: 4, ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: hoot() }, ...over });
    return state;
  }
  /** A wall along Hoot's right side, open floor to its left: a growth shifts left to clear it. */
  const RIGHT = { "5,4,w": { kind: "wall" }, "5,5,w": { kind: "wall" }, "5,3,w": { kind: "wall" } } as const;
  /** A 5 ft corridor, walls above and below Hoot's row. */
  const corridor = (): Record<string, EdgeFeature> => {
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 0; x < 20; x++) {
      edges[`${x},4,n`] = { kind: "wall" };
      edges[`${x},5,n`] = { kind: "wall" };
    }
    return edges;
  };
  const plan = (state: RoomState, over: Partial<Parameters<typeof sizePlan>[0]> = {}) =>
    sizePlan({ view: state, token: state.tokens.hoot!, size: "large", use: true, role: "player", owner: true, growths: [], ...over });

  test("the preview: no line with Keep or the same size, a growth, one that moves to clear a wall, and no room to grow, which sends nothing", () => {
    assert.deepEqual(plan(scene(), { use: false }), { kind: "none" });
    assert.deepEqual(plan(scene(), { size: "small" }), { kind: "none" });
    const open = plan(scene());
    assert.equal(open.kind, "resize");
    assert.equal(open.kind === "resize" && open.line, "Size Large, now Small.");
    const walled = plan(scene(RIGHT));
    assert.ok(walled.kind === "resize");
    assert.equal(walled.line, "Size Large, now Small. It moves a little to clear the wall.");
    assert.deepEqual(walled.patch, { size: "large", x: 3, y: 4 }, "grown to the left, over the square it stood on");
    assert.deepEqual(Object.keys(walled.patch).sort(), ["size", "x", "y"], "a resize patch carries nothing else");
    const resize = { t: "token.update", tokenId: "hoot", patch: walled.patch } as const;
    assert.ok(canApply(resize, P1, scene(RIGHT), { canUseAsset: () => true }).ok, "the server's resizeCheck takes it from Hoot's player");
    assert.deepEqual(plan(scene(corridor())), { kind: "kept", line: "Size Large, now Small. No room to grow here: Hoot keeps its size." });
  });

  test("the DM's line shows no check, and a locked companion keeps its size for its players with the lock's line", () => {
    const dm = plan(scene(corridor()), { role: "dm", owner: false });
    assert.ok(dm.kind === "resize");
    assert.equal(dm.line, "Size Large, now Small.");
    assert.deepEqual(plan(scene({}, { locked: true })), { kind: "kept", line: "Size Large: Hoot is locked, so its size stays. Ask the DM." });
    assert.equal(plan(scene({}, { locked: true }), { role: "dm", owner: false }).kind, "resize", "the DM's lock never stops the DM");
  });

  /** A fake room: the dispatched ops in order, each answered when the test says. */
  function harness(state: RoomState, role: "dm" | "player" = "player") {
    let view: RoomState = state;
    const sent: { op: ClientOp; answer(a: OpAnswer, r?: OpRefusal): void }[] = [];
    const phases: AttachPhase[] = [];
    const toasts: string[] = [];
    let open = true;
    let growths: readonly unknown[] = [];
    const deps: AttachDeps = {
      dispatch: (op, opts) => {
        sent.push({ op, answer: opts.onAnswer });
        return sent.length;
      },
      view: () => view,
      role,
      owner: role === "player",
      growths: () => growths as never,
      setGrowths: (g) => (growths = g),
      open: () => open,
      phase: (p) => phases.push(p),
      notify: (t) => toasts.push(t),
    };
    const go = (previewed?: string) =>
      startAttach(deps, { tokenId: "hoot", patch: { blockId: "wolf", ac: 13 }, size: "large", use: true, block: "Wolf", companion: "Hoot", ...(previewed ? { previewed } : {}) });
    return { sent, phases, toasts, go, close: () => (open = false), setView: (v: RoomState) => (view = v), growths: () => growths };
  }
  const refusal = (message: string): OpRefusal => ({ code: "invalid", message, text: `${message[0]!.toUpperCase()}${message.slice(1)}.` });

  test("the link and numbers go first, and the resize only after the link's taken, from the view as it then stands", () => {
    const h = harness(scene());
    assert.equal(h.go(), true);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]!.op, { t: "token.update", tokenId: "hoot", patch: { actor: { blockId: "wolf", ac: 13 } } });
    assert.deepEqual(h.phases, [{ phase: "linking" }]);
    // A wall drawn meanwhile: the resize is built again on the view as it now stands.
    h.setView(scene(RIGHT));
    h.sent[0]!.answer("taken");
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.sent[1]!.op, { t: "token.update", tokenId: "hoot", patch: { size: "large", x: 3, y: 4 } });
    assert.deepEqual(h.phases.at(-1), { phase: "resizing" });
    assert.equal(h.growths().length, 1, "the page remembers the growth, so a shrink returns to where it stood");
    h.sent[1]!.answer("taken");
    assert.deepEqual(h.phases.at(-1), { phase: "done" });
  });

  test("no resize after the link is refused or its answer is lost, and none when the fresh check refuses after the link's answer", () => {
    const refused = harness(scene());
    refused.go();
    refused.sent[0]!.answer("refused", refusal("that is not yours"));
    assert.equal(refused.sent.length, 1);
    assert.deepEqual(refused.phases.at(-1), { phase: "refused", line: "That is not yours." });
    const lost = harness(scene());
    lost.go();
    lost.sent[0]!.answer("unknown");
    assert.equal(lost.sent.length, 1);
    assert.deepEqual(lost.phases.at(-1), { phase: "unknown", line: "The connection dropped before the server answered. Check Hoot’s panel before attaching again." });
    const fresh = harness(scene());
    fresh.go();
    fresh.setView(scene(corridor()));
    fresh.sent[0]!.answer("taken");
    assert.equal(fresh.sent.length, 1, "nothing more is sent");
    assert.deepEqual(fresh.phases.at(-1), { phase: "sizeStopped", line: "Size Large, now Small. No room to grow here: Hoot keeps its size." });
    const locked = harness(scene({}, { locked: true }));
    locked.go();
    locked.sent[0]!.answer("taken");
    assert.equal(locked.sent.length, 1, "a locked companion's link and numbers apply, and no resize is sent");
    assert.deepEqual(locked.phases.at(-1), { phase: "sizeStopped", line: "Size Large: Hoot is locked, so its size stays. Ask the DM." });
    // Kept for the reason the step showed before Attach, the dialog has nothing new to say and closes.
    const shown = harness(scene(corridor()));
    shown.go("Size Large, now Small. No room to grow here: Hoot keeps its size.");
    shown.sent[0]!.answer("taken");
    assert.equal(shown.sent.length, 1);
    assert.deepEqual(shown.phases.at(-1), { phase: "done" });
  });

  test("a refused resize stays on the Size line in the server's words, with the link and numbers applied and Done in the footer", () => {
    const h = harness(scene());
    h.go();
    h.sent[0]!.answer("taken");
    h.sent[1]!.answer("refused", refusal("No room to grow here."));
    assert.deepEqual(h.phases.at(-1), { phase: "sizeStopped", line: "No room to grow here." });
    const lost = harness(scene());
    lost.go();
    lost.sent[0]!.answer("taken");
    lost.sent[1]!.answer("unknown");
    assert.deepEqual(lost.phases.at(-1), { phase: "sizeStopped", line: "The connection dropped before the server answered. Check Hoot’s size in its panel." });
  });

  test("closed before the link's answer, a late taken sends no resize and says the size stayed, and a late refusal is a toast", () => {
    const h = harness(scene());
    h.go();
    h.close();
    h.sent[0]!.answer("taken");
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.toasts, ["Wolf is attached to Hoot. Its size stayed Small."]);
    const r = harness(scene());
    r.go();
    r.close();
    r.sent[0]!.answer("refused", refusal("that is not yours"));
    assert.deepEqual(r.toasts, ["Wolf was not attached to Hoot. That is not yours."]);
    // With nothing to resize, a late taken says nothing.
    const same = harness(scene({}, { size: "large" }));
    same.go();
    same.close();
    same.sent[0]!.answer("taken");
    assert.deepEqual(same.toasts, []);
  });

  test("closed while the resize waits, it lands, and a late refusal is the room's toast in its words", () => {
    const h = harness(scene());
    h.go();
    h.sent[0]!.answer("taken");
    const phases = h.phases.length;
    h.close();
    h.sent[1]!.answer("refused", refusal("that token is locked"));
    assert.equal(h.phases.length, phases, "the closed dialog moves no more");
    assert.deepEqual(h.toasts, ["That token is locked."]);
  });

  test("the DM's attach grows at the base spot, unchecked", () => {
    const h = harness(scene(corridor()), "dm");
    h.go();
    h.sent[0]!.answer("taken");
    assert.deepEqual(h.sent[1]!.op, { t: "token.update", tokenId: "hoot", patch: { size: "large" } } satisfies ClientOp);
  });
});

describe("the companion picker's lists (docs/design-v1-companion-stat-blocks.md 6.1)", () => {
  const blocks = [companionBlock("moth", "bree"), companionBlock("owl2", "bree", { name: "Owl", size: "tiny", type: "Beast", cr: "0" })];

  test("the character's blocks and the SRD's, the same name from both, and never a room monster, for a player or the DM", () => {
    const lists = pickerLists({ name: "owl", query: "", blocks, characterName: "Bree", srd: SRD });
    assert.deepEqual(lists.own.map((r) => r.link), [{ blockId: "moth" }, { blockId: "owl2" }]);
    assert.deepEqual(lists.own.map((r) => r.tag), ["Bree’s", "Bree’s"]);
    assert.deepEqual(lists.sameName.map((r) => r.link), [{ blockId: "owl2" }, { srdId: "owl" }]);
    assert.equal(lists.srd.length, SRD.length);
    for (const row of [...lists.own, ...lists.sameName, ...lists.srd]) assert.equal("monsterId" in row.link, false);
  });

  test("search narrows every list as the Monsters panel's does", () => {
    const owl = pickerLists({ name: "Owl", query: "owl", blocks, characterName: "Bree", srd: SRD });
    assert.deepEqual(owl.own.map((r) => r.view.name), ["Owl"]);
    assert.equal(owl.ownCount, 2);
    assert.ok(owl.srd.every((r) => r.view.name.toLowerCase().includes("owl")));
    const cr = pickerLists({ name: "Owl", query: "cr 1-2", blocks, characterName: "Bree", srd: SRD });
    assert.deepEqual(cr.own, [], "a CR 1/4 block and a CR 0 one are out of range");
    assert.deepEqual(cr.sameName, []);
    assert.ok(cr.srd.length > 0 && cr.srd.length < SRD.length);
  });

  test("a block's row carries its own picture, so a picker that takes it never looks it up in an older collection", () => {
    const pictured = companionBlock("lamp", "bree", { defaultImage: { icon: "lorc/wolf-head", color: "#336699" } });
    assert.deepEqual(blockRow(pictured, "Bree").picture, { icon: "lorc/wolf-head", color: "#336699" });
    assert.equal("picture" in blockRow(companionBlock("plain", "bree"), "Bree"), false);
  });

  test("before the SRD loads, the character's blocks list at once", () => {
    const lists = pickerLists({ name: "", query: "", blocks, characterName: "Bree", srd: null });
    assert.equal(lists.own.length, 2);
    assert.deepEqual(lists.srd, []);
  });
});

describe("words", () => {
  test("a block's line in a character's list leaves out a creature type it does not have", () => {
    assert.equal(blockDetail({ size: "small", type: "Fey", cr: "1/4" }), "Small Fey, CR 1/4");
    assert.equal(blockDetail({ size: "medium", type: "", cr: "0" }), "Medium, CR 0");
  });

  test("speeds read walk first, then each mode, with hover", () => {
    assert.equal(speedText({ walk: 30 }), "30 ft");
    assert.equal(speedText({ walk: 5, fly: 60, hover: true, swim: 10 }), "5 ft, fly 60 ft (hover), swim 10 ft");
  });

  test("what a new companion takes from its block beside the form's fields", () => {
    assert.equal(fromTheBlock(OWL), "From the block: speed 5 ft, fly 60 ft. Darkvision 120 ft. Passive Perception 15. Initiative +1.");
    assert.equal(fromTheBlock(monsterView(customMonster("x", { senses: "", initiative: -1, speed: "30 ft." }))), "From the block: speed 30 ft. Passive Perception 11. Initiative −1.");
  });
});

