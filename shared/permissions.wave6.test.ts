import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import type { RoomState } from "./model.ts";
import { LEDGE_IN_THE_WAY, WALL_IN_THE_WAY, canApply, type PermissionDeps } from "./permissions.ts";
import type { Op, TokenInput } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, env, room, token } from "./testutil.ts";

/**
 * The combat flow's permissions (docs/design-v1-combat-flow.md 4.4): a
 * player's companion beside their character, with no setting needed, and
 * what its owners may change on it and delete. The DM may do all of it.
 */
const deps: PermissionDeps = { canUseAsset: () => true };

/** Bree, Ana's (p1) druid, with her token at 5,5 on the players' scene, and Cy's (p2) character with none. */
function setup(): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), cy: character("cy", { name: "Cy", ownerIds: ["p2"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 5, y: 5, disposition: "ally" });
  return state;
}

function spirit(over: Partial<TokenInput> = {}): TokenInput {
  return {
    id: "ws",
    sceneId: "s1",
    kind: "npc",
    name: "Wildfire Spirit",
    size: "small",
    x: 4,
    y: 5,
    layer: "token",
    disposition: "ally",
    actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, ac: 13, dmNotes: "" }) },
    companion: { of: "bree", turn: "shared" },
    ...over,
  };
}

const weapon = (over: Partial<TokenInput> = {}): TokenInput =>
  spirit({ id: "sw", kind: "object", name: "Spiritual Weapon", actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0, dmNotes: "" }) }, companion: { of: "bree", turn: "none" }, ...over });

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const make = (input: TokenInput): Op => ({ t: "token.create", token: input });

describe("a player's companion (section 3.6.3)", () => {
  test("for their own character, next to its token, without Players can create their own characters", () => {
    const state = setup();
    state.meta.settings.playersCreateCharacters = false;
    assert.equal(decide(make(spirit()), P1, state), "ok");
    assert.equal(decide(make(weapon({ x: 6 })), P1, state), "ok");
    assert.equal(decide(make(spirit({ x: 6, y: 6 })), P1, state), "ok", "a diagonal neighbor is 5 ft under the 2024 rule");
    const r = applyOp(state, make(spirit()), P1, env(1));
    assert.ok(r.ok && r.state.tokens.ws?.companion);
  });

  test("refused for another's character, off their scene, outside the map, with no token of the character there, and more than 5 ft away", () => {
    assert.equal(decide(make(spirit({ companion: { of: "cy", turn: "shared" } }))), "forbidden: that is not yours");
    assert.equal(decide(make(spirit({ companion: { of: "nobody", turn: "shared" } }))), "gone: that is not here");
    assert.equal(decide(make(spirit({ sceneId: "s2" }))), "gone: that is not here");
    assert.equal(decide(make(spirit({ x: -1 }))), "forbidden: place it inside the map");
    const away = setup();
    away.tokens.bt = { ...away.tokens.bt!, sceneId: "s2" };
    assert.equal(decide(make(spirit()), P1, away), "forbidden: Bree has no token here.");
    assert.equal(decide(make(spirit({ x: 2 }))), "forbidden: Put it next to Bree.");
    assert.equal(decide(make(spirit({ x: 4, elevation: 30 }))), "forbidden: Put it next to Bree.", "reach counts height too");
  });

  test("through a wall on a scene that blocks moves it is refused, and on one that does not it passes", () => {
    const state = setup();
    // A wall along x = 6 beside Bree's east side.
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls: [{ id: "wallwallwall", a: [6, 1], b: [6, 9], f: { kind: "wall" } }] };
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true };
    assert.equal(decide(make(spirit({ x: 6 })), P1, state), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(decide(make(spirit({ x: 4 })), P1, state), "ok", "the open side");
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: false };
    assert.equal(decide(make(spirit({ x: 6 })), P1, state), "ok");
    assert.notEqual(WALL_IN_THE_WAY, LEDGE_IN_THE_WAY);
  });

  test("refused when any plain or bare rule is broken, with other owners, or for an effect with HP or its own turn", () => {
    const hurt = actor({ hp: { cur: 5, max: 15, temp: 0 }, dmNotes: "" });
    const broken: [string, Partial<TokenInput>][] = [
      ["hidden", { visibility: "dm" }],
      ["fog exempt", { fogExempt: true }],
      ["locked", { locked: true }],
      ["hidden name", { nameHidden: true }],
      ["public name", { publicName: "Bird" }],
      ["numbered", { number: 2 }],
      ["no layer", { layer: undefined }],
      ["object layer", { layer: "object" }],
      ["a light", { light: { bright: 10, dim: 10 } }],
      ["party mark", { partyVision: true }],
      ["HP visibility", { hpVisibility: "exact" }],
      ["hurt", { actor: { inline: hurt } }],
      ["temporary HP", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 3 }, dmNotes: "" }) } }],
      ["dead", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, life: "dead", dmNotes: "" }) } }],
      ["death saves", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, deathSaves: { ok: 1, fail: 0 }, dmNotes: "" }) } }],
      ["an effect", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, effects: [{ id: "e", key: "blessed" }], dmNotes: "" }) } }],
      ["DM notes", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 } }) } }],
      ["legendary", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, dmNotes: "", legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) } }],
      ["room monster", { actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, dmNotes: "", monsterId: "m1" }) } }],
      ["a creature at 0 HP", { actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, dmNotes: "" }) } }],
      ["a monster", { kind: "monster" }],
      ["a PC", { kind: "pc" }],
      ["a character's actor", { actor: { ref: "bree" } }],
      ["other owners", { ownerIds: ["p2"] }],
    ];
    for (const [what, over] of broken) assert.match(decide(make(spirit(over))), /^forbidden/, what);
    assert.equal(decide(make(spirit({ ownerIds: ["p1"] }))), "ok", "its character's owners may be named");
    assert.match(decide(make(weapon({ actor: { inline: actor({ hp: { cur: 5, max: 5, temp: 0 }, ac: 0, dmNotes: "" }) } }))), /^forbidden/);
    assert.match(decide(make(weapon({ actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 12, dmNotes: "" }) } }))), /^forbidden/);
    assert.equal(decide(make(weapon({ companion: { of: "bree", turn: "own" } }))), "forbidden: an effect takes no turn of its own");
  });

  test("refused at 10 companions of the character on that scene, while those on another scene do not count", () => {
    const state = setup();
    for (let i = 0; i < LIMITS.companionsPerCharacter; i++) {
      state.tokens[`c${i}`] = token(`c${i}`, { kind: "npc", sceneId: i === 0 ? "s2" : "s1", ownerIds: ["p1"], companion: { of: "bree", turn: "none" } });
    }
    assert.equal(decide(make(spirit()), P1, state), "ok", "nine here and one on another scene");
    state.tokens.c0 = { ...state.tokens.c0!, sceneId: "s1" };
    assert.equal(decide(make(spirit()), P1, state), `forbidden: Bree has ${LIMITS.companionsPerCharacter} companions here. Ask the DM for more.`);
    assert.equal(decide(make(spirit()), DM, state), "ok", "the DM's are unlimited");
  });
});

describe("what a companion's owners may change (section 3.6.4)", () => {
  function owned(): RoomState {
    const state = setup();
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" } });
    return state;
  }
  const update = (patch: Extract<Op, { t: "token.update" }>["patch"]): Op => ({ t: "token.update", tokenId: "ws", patch });

  test("they may rename it, edit its AC, speeds and HP maximum, change its turn and kind, and mark its Reaction", () => {
    for (const patch of [
      { name: "Ember" },
      { actor: { ac: 15 } },
      { actor: { speeds: { walk: 30, fly: 30 } } },
      { actor: { hp: { max: 20 } } },
      { companion: { of: "bree", turn: "none" as const } },
      { kind: "object" as const },
      { kind: "npc" as const },
      { companionReaction: true },
      { notes: "Glows" },
    ]) {
      assert.equal(decide(update(patch), P1, owned()), "ok", JSON.stringify(patch));
    }
  });

  test("they may not change whose it is, its visibility, lock, number or owners, the DM's actor fields, or make it a monster or a PC", () => {
    for (const patch of [
      { companion: { of: "cy", turn: "shared" as const } },
      { companion: null },
      { visibility: "dm" as const },
      { locked: true },
      { number: 2 },
      { ownerIds: ["p1", "p2"] },
      { kind: "monster" as const },
      { kind: "pc" as const },
      { publicName: "Bird" },
      { actor: { dmNotes: "x" } },
      { actor: { monsterId: "m1" } },
      { hpVisibility: "exact" as const },
    ]) {
      assert.match(decide(update(patch), P1, owned()), /^forbidden/, JSON.stringify(patch));
    }
  });

  test("a player who owns Bree's token but not Bree may not mark Bree's companion's Reaction", () => {
    const state = owned();
    state.tokens.bt = { ...state.tokens.bt!, ownerIds: ["p2"] };
    assert.equal(decide(update({ companionReaction: true }), P2, state), "forbidden: that is not yours");
  });

  test("an owner may delete it, another player may not, and every other token stays the DM's to delete", () => {
    const state = owned();
    assert.equal(decide({ t: "token.delete", tokenId: "ws" }, P1, state), "ok");
    assert.equal(decide({ t: "token.delete", tokenId: "ws" }, P2, state), "forbidden: that is not yours");
    assert.equal(decide({ t: "token.delete", tokenId: "bt" }, P1, state), "forbidden: only the DM can do that");
    assert.equal(decide({ t: "token.delete", tokenId: "missing" }, P1, state), "gone: that is not here");
  });

  test("the DM may do all of it", () => {
    const state = owned();
    for (const op of [
      update({ companion: { of: "cy", turn: "own" } }),
      update({ companion: null }),
      update({ visibility: "dm" }),
      update({ kind: "monster" }),
      { t: "token.delete" as const, tokenId: "ws" },
      make(spirit({ id: "x", x: 30 })),
    ]) {
      assert.equal(decide(op, DM, state), "ok", op.t);
    }
  });
});
