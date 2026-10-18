import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { DM, actor, apply, character, customMonster, imageRef, room, srdImage, token } from "#shared/testutil.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { monsterToken } from "../tokens/factory.ts";
import { applyOps, isTokenOf, monsterImage, optInCount, optInLabel, planApply, refOf, shippedImage } from "./images.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const goblin = MONSTERS.find((m) => m.srdId === "goblin-warrior")!;

function setup() {
  const state = room();
  state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "goblin-pic");
  state.monsters.lurker = customMonster("lurker", { defaultImage: imageRef("lurker-pic", 1.4) });
  state.monsters.plain = customMonster("plain", { name: "Bog Hag" });
  return state;
}

const drop = { hp: null, hidden: false, inLair: false };

describe("a monster's default image", () => {
  test("is found by SRD id for an SRD monster and by id for the room's own", () => {
    const state = setup();
    assert.deepEqual(refOf(goblin), { srdId: "goblin-warrior" });
    assert.deepEqual(refOf(monsterView(state.monsters.lurker!), "lurker"), { monsterId: "lurker" });
    assert.equal(refOf(monsterView(state.monsters.lurker!)), undefined);
    assert.deepEqual(monsterImage(state, { srdId: "goblin-warrior" }), imageRef("goblin-pic"));
    assert.deepEqual(monsterImage(state, { monsterId: "lurker" }), imageRef("lurker-pic", 1.4));
    assert.equal(monsterImage(state, { monsterId: "plain" }), undefined);
    assert.equal(monsterImage(state, { monsterId: "gone" }), undefined);
  });

  test("an SRD monster falls back to its shipped icon, and the room's own choice wins over it", () => {
    const state = setup();
    const icon = { icon: "delapouite/goblin-head", color: "#e93d82" };
    assert.deepEqual(shippedImage({ srdId: "goblin-warrior" }), icon);
    assert.deepEqual(monsterImage(state, { srdId: "goblin-warrior" }), imageRef("goblin-pic"), "the DM's choice");
    assert.deepEqual(monsterImage({ ...state, srdImages: {} }, { srdId: "goblin-warrior" }), icon, "no choice in this room");
    assert.deepEqual(monsterImage({}, { srdId: "goblin-warrior" }), icon, "a view from before images");
    assert.deepEqual(monsterImage(state, { srdId: "owlbear" }), { icon: "lorc/owl", color: "#12a594" });
    assert.deepEqual(monsterImage(state, { srdId: "dragon-turtle" }), { icon: "lorc/turtle", color: "#ff6b4a" });
  });

  test("an id the SRD lacks has no image, nor has a room monster without one, even one sharing an SRD id's spelling", () => {
    const state = setup();
    for (const srdId of ["not-a-monster", "", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(monsterImage(state, { srdId }), undefined, srdId);
      assert.equal(shippedImage({ srdId }), undefined, srdId);
    }
    state.monsters["goblin-warrior"] = customMonster("goblin-warrior", { name: "Goblin Warrior" });
    assert.equal(monsterImage(state, { monsterId: "goblin-warrior" }), undefined);
    assert.equal(shippedImage({ monsterId: "goblin-warrior" }), undefined);
  });

  test("hands out a copy, so a token that changes its image never changes the table", () => {
    const first = shippedImage({ srdId: "wolf" })!;
    first.color = "#000000";
    assert.deepEqual(shippedImage({ srdId: "wolf" }), { icon: "lorc/wolf-head", color: "#ad7f58" });
    assert.notEqual(monsterImage({}, { srdId: "wolf" }), monsterImage({}, { srdId: "wolf" }));
  });

  test("goes on every token placed from the monster, SRD or the room's own, as a copy", () => {
    const state = setup();
    const image = monsterImage(state, refOf(goblin)!);
    const t = monsterToken(goblin, drop, { id: "g1", sceneId: "s1", at: { x: 1, y: 1 }, ...(image ? { image } : {}) });
    assert.deepEqual(t.image, imageRef("goblin-pic"));
    assert.notEqual(t.image, state.srdImages["goblin-warrior"]!.image);
    assert.notEqual((t.image as { crop: unknown }).crop, (state.srdImages["goblin-warrior"]!.image as { crop: unknown }).crop);
    const placed = apply(state, { t: "token.create", token: t }, DM);
    assert.deepEqual(placed.tokens.g1!.image, imageRef("goblin-pic"));

    const lurker = monsterView(state.monsters.lurker!);
    const own = monsterImage(state, refOf(lurker, "lurker")!);
    const l = monsterToken(lurker, drop, { id: "l1", sceneId: "s1", at: { x: 3, y: 3 }, ...(own ? { image: own } : {}) });
    assert.deepEqual(apply(state, { t: "token.create", token: l }, DM).tokens.l1!.image, imageRef("lurker-pic", 1.4));
  });

  test("an SRD monster with no image set in the room places its shipped icon, the DM's choice once there is one", () => {
    const state = room();
    const place = (id: string) => {
      const image = monsterImage(state, refOf(goblin)!);
      return apply(state, { t: "token.create", token: monsterToken(goblin, drop, { id, sceneId: "s1", at: { x: 1, y: 1 }, ...(image ? { image } : {}) }) }, DM).tokens[id]!;
    };
    assert.deepEqual(place("g1").image, { icon: "delapouite/goblin-head", color: "#e93d82" });
    assert.deepEqual(state.srdImages, {}, "placing stores nothing for the monster");
    state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "goblin-pic");
    assert.deepEqual(place("g2").image, imageRef("goblin-pic"));
  });

  test("a room monster without one places tokens without an image, as before", () => {
    const state = setup();
    const hag = monsterView(state.monsters.plain!);
    const image = monsterImage(state, refOf(hag, "plain")!);
    const t = monsterToken(hag, drop, { id: "h1", sceneId: "s1", at: { x: 1, y: 1 }, ...(image ? { image } : {}) });
    assert.equal("image" in t, false);
  });
});

/** A goblin from the SRD browser: its actor carries the SRD id. */
function goblinToken(id: string, overrides: Partial<Token> = {}): Token {
  return token(id, { name: "Goblin Warrior", actor: { inline: actor({ srdId: "goblin-warrior" }) }, ...overrides });
}

describe("which tokens are a monster's", () => {
  test("an SRD monster's are those with its SRD id, whatever they are called now", () => {
    const state = setup();
    const ref = { srdId: "goblin-warrior" };
    assert.ok(isTokenOf(goblinToken("g1"), ref, state.monsters));
    assert.ok(isTokenOf(goblinToken("g2", { name: "Snik", kind: "npc" }), ref, state.monsters));
    assert.ok(!isTokenOf(token("g3", { name: "Goblin Warrior" }), ref, state.monsters), "a homebrew token with the same name");
    assert.ok(!isTokenOf(token("b1", { actor: { inline: actor({ srdId: "bandit" }) } }), ref, state.monsters));
  });

  test("the room's own are found by name, without an SRD id, among monsters and NPCs", () => {
    const state = setup();
    const ref = { monsterId: "lurker" };
    assert.ok(isTokenOf(token("l1", { name: "Cave Lurker" }), ref, state.monsters));
    assert.ok(isTokenOf(token("l2", { name: "Cave Lurker", kind: "npc" }), ref, state.monsters));
    assert.ok(!isTokenOf(token("l3", { name: "Cave Lurker", kind: "object" }), ref, state.monsters));
    assert.ok(!isTokenOf(token("l4", { name: "Lurker" }), ref, state.monsters), "renamed by hand");
    assert.ok(!isTokenOf(token("l5", { name: "Cave Lurker", actor: { inline: actor({ srdId: "cave-lurker" }) } }), ref, state.monsters));
    state.characters.c1 = character("c1", { name: "Cave Lurker" });
    assert.ok(!isTokenOf(token("l6", { name: "Cave Lurker", kind: "pc", actor: { ref: "c1" } }), ref, state.monsters), "a character's token");
    assert.ok(!isTokenOf(token("l7", { name: "Cave Lurker" }), { monsterId: "deleted" }, state.monsters));
  });

  test("a token linked to one of the room's monsters is that monster's alone, whatever it is called", () => {
    const state = setup();
    const linked = (monsterId: string, overrides: Partial<Token> = {}) => token("l1", { name: "Snik", actor: { inline: actor({ monsterId }) }, ...overrides });
    assert.ok(isTokenOf(linked("lurker"), { monsterId: "lurker" }, state.monsters), "renamed, and still linked");
    assert.ok(isTokenOf(linked("lurker", { name: "Cave Lurker" }), { monsterId: "lurker" }, state.monsters));
    assert.ok(!isTokenOf(linked("other", { name: "Cave Lurker" }), { monsterId: "lurker" }, state.monsters), "the name no longer decides once linked");
  });
});

describe("applying a new image to a monster's tokens", () => {
  function scene() {
    const state = setup();
    state.tokens = {
      bare: goblinToken("bare"),
      old: goblinToken("old", { image: imageRef("old-goblin") }),
      recrop: goblinToken("recrop", { image: imageRef("goblin-pic", 3) }),
      done: goblinToken("done", { image: imageRef("goblin-pic") }),
      disguise: goblinToken("disguise", { image: imageRef("hooded-figure") }),
      elsewhere: goblinToken("elsewhere", { sceneId: "s2" }),
      orc: token("orc", { name: "Orc" }),
    };
    return state;
  }
  const plan = (previous: ReturnType<typeof imageRef>[] = []) =>
    planApply({ tokens: Object.values(scene().tokens), sceneId: "s1", ref: { srdId: "goblin-warrior" }, monsters: {}, image: imageRef("goblin-pic"), previous });

  test("tokens with no image or the monster's own take it, one set by hand waits for the DM, and other scenes are left alone", () => {
    assert.deepEqual(plan([imageRef("old-goblin")]), { plain: ["bare", "old", "recrop"], own: ["disguise"], played: [], done: 1 });
    // Without the earlier image known, a token still wearing it reads as set by hand.
    assert.deepEqual(plan(), { plain: ["bare", "recrop"], own: ["disguise", "old"], played: [], done: 1 });
  });

  test("a token a player plays waits for the DM whatever it wears, even placed from the SRD", () => {
    const state = scene();
    state.tokens.wildShape = goblinToken("wildShape", { ownerIds: ["p1"] });
    state.tokens.familiar = goblinToken("familiar", { ownerIds: ["p2"], image: imageRef("old-goblin") });
    state.tokens.pc = goblinToken("pc", { kind: "pc" });
    state.tokens.playedDone = goblinToken("playedDone", { ownerIds: ["p1"], image: imageRef("goblin-pic") });
    const input = { sceneId: "s1", ref: { srdId: "goblin-warrior" }, monsters: {}, image: imageRef("goblin-pic"), previous: [imageRef("old-goblin")] };
    const p = planApply({ ...input, tokens: Object.values(state.tokens) });
    assert.deepEqual(p, { plain: ["bare", "old", "recrop"], own: ["disguise"], played: ["familiar", "pc", "wildShape"], done: 2 });
    assert.deepEqual(applyOps(p, input.image, false).map((op) => (op.t === "token.update" ? op.tokenId : "")), ["bare", "old", "recrop"]);
    assert.equal(applyOps(p, input.image, true).length, 7);
    assert.equal(optInCount(p), 4);
    assert.equal(optInLabel(p), "Include the 4 set by hand or played by players");
    assert.equal(optInLabel({ ...p, own: [] }), "Include the 3 tokens players play");
    assert.equal(optInLabel({ ...p, own: [], played: ["pc"] }), "Include the 1 token a player plays");
    assert.equal(optInLabel({ ...p, played: [] }), "Include the 1 with an image set by hand");
    assert.equal(optInLabel({ ...p, own: ["a", "b"], played: [] }), "Include the 2 with images set by hand");
  });

  test("every earlier image seen while the page was open counts as the monster's, not only the last", () => {
    // The DM tried a hooded figure, then settled on the goblin picture: tokens in the first try and the oldest image are the monster's.
    assert.deepEqual(plan([imageRef("old-goblin"), imageRef("hooded-figure")]), { plain: ["bare", "disguise", "old", "recrop"], own: [], played: [], done: 1 });
    assert.deepEqual(plan([imageRef("hooded-figure")]), { plain: ["bare", "disguise", "recrop"], own: ["old"], played: [], done: 1 });
  });

  test("sends one image-only token.update per token, as one undo group, and they apply", () => {
    const state = scene();
    const p = plan([imageRef("old-goblin")]);
    const image = imageRef("goblin-pic");
    const ops = applyOps(p, image, false);
    assert.deepEqual(ops.map((op) => (op.t === "token.update" ? op.tokenId : "")), ["bare", "old", "recrop"]);
    for (const op of ops) {
      assert.ok(clientOpSchema.safeParse(op).success);
      assert.deepEqual(op.t === "token.update" ? Object.keys(op.patch) : [], ["image"]);
    }
    assert.deepEqual(applyOps(p, image, true).length, 4);

    const sent: { op: ClientOp; group?: string }[] = [];
    let ids = 0;
    dispatchGesture({ dispatch: (op, opts) => (sent.push({ op, ...(opts?.group ? { group: opts.group } : {}) }), sent.length), newId: () => `g${++ids}` }, ops);
    assert.equal(sent.length, 3);
    assert.deepEqual(new Set(sent.map((s) => s.group)), new Set(["g1"]));

    let after = state;
    for (const [i, { op }] of sent.entries()) after = apply(after, op, DM, i + 1);
    for (const id of ["bare", "old", "recrop", "done"]) assert.deepEqual(after.tokens[id]!.image, image, id);
    assert.deepEqual(after.tokens.disguise!.image, imageRef("hooded-figure"));
    assert.equal(after.tokens.elsewhere!.image, undefined);
    // Nothing but the image changed.
    const { image: _a, rev: _ra, ...was } = state.tokens.old!;
    const { image: _b, rev: _rb, ...now } = after.tokens.old!;
    assert.deepEqual(now, was);
  });

  test("a token wearing the SRD monster's shipped icon on its shipped color is the monster's, whatever the DM picked since", () => {
    const state = setup();
    const shipped = shippedImage({ srdId: "goblin-warrior" })!;
    state.tokens = {
      bare: goblinToken("bare"),
      shipped: goblinToken("shipped", { image: shipped }),
      recolored: goblinToken("recolored", { image: { ...shipped, color: "#30a46c" } }),
      disguise: goblinToken("disguise", { image: imageRef("hooded-figure") }),
      wildShape: goblinToken("wildShape", { ownerIds: ["p1"], image: shipped }),
      // Another monster's tokens wear the same icon and are never this one's.
      wolf: token("wolf", { name: "Wolf", actor: { inline: actor({ srdId: "wolf" }) }, image: shipped }),
    };
    const input = { tokens: Object.values(state.tokens), sceneId: "s1", ref: { srdId: "goblin-warrior" }, monsters: {} };
    // The DM's new picture replaces the shipped icon with no opt-in, as it replaces an earlier picture of the monster's.
    // The same icon on another color was set by hand, so it waits for the DM's say.
    assert.deepEqual(planApply({ ...input, image: imageRef("goblin-pic") }), { plain: ["bare", "shipped"], own: ["disguise", "recolored"], played: ["wildShape"], done: 0 });
    // With no choice made, the page offers the shipped icon to tokens placed before it existed, and still not over a recolored one.
    assert.deepEqual(planApply({ ...input, image: shipped }), { plain: ["bare"], own: ["disguise", "recolored"], played: [], done: 2 });
    assert.deepEqual(planApply({ ...input, image: imageRef("goblin-pic"), previous: [shipped] }).own, ["disguise", "recolored"], "a shipped icon seen before is matched by its color too");
    // A room monster has no shipped icon, so a token wearing one is set by hand.
    const lurker = { ...input, ref: { monsterId: "lurker" }, monsters: state.monsters, tokens: [token("l1", { name: "Cave Lurker", image: shipped })] };
    assert.deepEqual(planApply({ ...lurker, image: imageRef("lurker-pic", 1.4) }), { plain: [], own: ["l1"], played: [], done: 0 });
  });

  test("the room's own monster's tokens are planned by name, and nothing is left once applied", () => {
    const state = setup();
    state.tokens = { a: token("a", { name: "Cave Lurker" }), b: token("b", { name: "Cave Lurker", image: imageRef("hooded-figure") }), c: token("c", { name: "Goblin" }) };
    const input = { sceneId: "s1", ref: { monsterId: "lurker" }, monsters: state.monsters, image: state.monsters.lurker!.defaultImage! };
    const before = planApply({ ...input, tokens: Object.values(state.tokens) });
    assert.deepEqual(before, { plain: ["a"], own: ["b"], played: [], done: 0 });
    let after = state;
    for (const op of applyOps(before, input.image, true)) after = apply(after, op, DM);
    assert.deepEqual(planApply({ ...input, tokens: Object.values(after.tokens) }), { plain: [], own: [], played: [], done: 2 });
  });
});
