import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS, checkLimits } from "./limits.ts";
import type { RoomState, Viewer } from "./model.ts";
import { AREA_ASKED, AREA_ASKED_DM, ASKS_WAITING, ASK_CLOSED, DM_RUNS_GROUP_SAVE, ONLY_ITS_PLAYER_WITHDRAWS, ROLL_ASKED_ALREADY, canApply, waitingAsks } from "./permissions.ts";
import type { CastInput, Op } from "./protocol.ts";
import { DM, P1, P2, castAsk, castTable, token } from "./testutil.ts";

/** Who may ask for saves, close an ask and change an asked area (docs/design-v1-player-save-spell.md 5.4). */

const deps = { canUseAsset: () => true };
const decide = (state: RoomState, op: Op, who: Viewer = P1) => {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
};
const ask = (overrides: Partial<CastInput> = {}): Op => ({ t: "cast.ask", cast: { id: "k9", caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1", ...overrides } });
const targets = (ids: string[], overrides: Partial<CastInput> = {}) => ask({ area: undefined, targets: ids, ...overrides });
const GONE = "gone: that is not here";
const NOT_YOURS = "forbidden: that is not yours";

describe("asking for saves", () => {
  test("its player and a co-owner may ask for their creature, over their own area or targets they see", () => {
    const state = castTable();
    assert.equal(decide(state, ask()), "ok");
    assert.equal(decide(state, targets(["g1", "bree"])), "ok");
    state.characters["thorn-c"]!.ownerIds = ["p1", "p2"];
    assert.equal(decide(state, targets(["g1"]), P2), "ok", "a co-owner");
  });

  test("another player's creature is not theirs, and the DM runs a group save directly", () => {
    const state = castTable();
    assert.equal(decide(state, targets(["g1"]), P2), NOT_YOURS);
    assert.equal(decide(state, ask(), DM), `forbidden: ${DM_RUNS_GROUP_SAVE}`);
  });

  test("a hidden caster and a hidden target answer as missing ones, in the same words", () => {
    const state = castTable();
    assert.equal(decide(state, targets(["g2"])), GONE, "a hidden goblin");
    assert.equal(decide(state, targets(["nobody"])), GONE, "a missing one");
    state.tokens.thorn!.visibility = "dm";
    state.characters["thorn-c"]!.ownerIds = ["p2"];
    assert.equal(decide(state, targets(["g1"])), GONE, "a hidden caster of someone else's");
  });

  test("an area must be the player's own, seen, on the players' scene", () => {
    const state = castTable();
    assert.equal(decide(state, ask({ area: "a2" })), NOT_YOURS);
    assert.equal(decide(state, ask({ area: "gone" })), GONE);
    state.templates.a1!.visibility = "dm";
    assert.equal(decide(state, ask()), GONE, "an area hidden from players");
  });

  test("everything is on the players' scene, which the ask names, and nothing goes during a pause", () => {
    const state = castTable();
    assert.equal(decide(state, ask({ sceneId: "s2" })), GONE, "the ask names another scene");
    state.tokens.g1!.sceneId = "s2";
    assert.equal(decide(state, targets(["g1"])), GONE, "a target on another scene");
    state.tokens.thorn!.sceneId = "s2";
    assert.equal(decide(state, targets(["bree"])), GONE, "a caster on another scene");
    const paused = castTable();
    paused.meta.view.blackout = true;
    assert.equal(decide(paused, ask()), GONE);
  });

  test("a target named twice, a taken id and a roll another open ask holds are refused", () => {
    const state = castTable({ casts: { k9: castAsk("k9", { by: "p2" }), k2: castAsk("k2", { by: "p2", damage: { tag: "dmg", parts: 1 } }) } });
    assert.equal(decide(state, targets(["g1", "g1"], { id: "k3" })), "invalid: a target is named twice");
    assert.equal(decide(state, ask()), GONE, "the id an open ask holds");
    assert.equal(decide(state, ask({ id: "k3", damage: { tag: "dmg", parts: 1 } })), `invalid: ${ROLL_ASKED_ALREADY}`);
    assert.equal(decide(state, ask({ id: "k3", damage: { tag: "other", parts: 1 } })), "ok");
  });

  test("the cap of 3 counts only the member's asks whose caster exists and they own now", () => {
    const three = { k1: castAsk("k1"), k2: castAsk("k2"), k3: castAsk("k3") };
    const state = castTable({ casts: three });
    assert.equal(LIMITS.castsPerMember, 3);
    assert.equal(decide(state, ask()), `quota: ${ASKS_WAITING}`);
    assert.equal(ASKS_WAITING, "You have 3 asks waiting. Withdraw one first.");
    // Another's ask for a creature the member plays does not count, nor one whose caster is gone or passed to another player.
    const mixed = castTable({ casts: { k1: castAsk("k1"), k2: castAsk("k2", { by: "p2" }), k3: castAsk("k3", { caster: "gone" }), k4: castAsk("k4", { caster: "lent" }) } });
    mixed.tokens.lent = token("lent", { ownerIds: ["p2"] });
    assert.deepEqual(waitingAsks(mixed, P1).map((a) => a.id), ["k1"]);
    assert.equal(decide(mixed, ask()), "ok");
  });
});

test("a room holds at most 20 waiting asks, beside its open roll requests", () => {
  const casts = Object.fromEntries(Array.from({ length: LIMITS.openCastsPerRoom }, (_, i) => [`k${i}`, castAsk(`k${i}`, { by: i % 2 === 0 ? "p1" : "p2" })]));
  assert.deepEqual(checkLimits(castTable({ casts })), { ok: true });
  const over = checkLimits(castTable({ casts: { ...casts, k99: castAsk("k99") } }));
  assert.ok(!over.ok);
  assert.equal(over.code, "quota");
  assert.match(over.message, /at most 20 asks for saves/);
});

describe("closing an ask", () => {
  const open = () => castTable({ casts: { k1: castAsk("k1") } });

  test("a player of its caster withdraws, and only withdraws", () => {
    const state = open();
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "withdrawn" }), "ok");
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "dismissed" }), "forbidden: only the DM can do that");
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "withdrawn" }, P2), `gone: ${ASK_CLOSED}`, "another player");
    state.characters["thorn-c"]!.ownerIds = ["p2"];
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "withdrawn" }), `gone: ${ASK_CLOSED}`, "the asker after the caster passed on");
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "withdrawn" }, P2), "ok", "whoever owns the caster now");
    const paused = open();
    paused.meta.view.blackout = true;
    assert.equal(decide(paused, { t: "cast.close", castId: "k1", end: "withdrawn" }), `gone: ${ASK_CLOSED}`, "behind a pause, where they hold none");
  });

  test("the DM resolves or dismisses, and never withdraws", () => {
    const state = open();
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "done" }, DM), "ok");
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "dismissed" }, DM), "ok");
    assert.equal(decide(state, { t: "cast.close", castId: "k1", end: "withdrawn" }, DM), `forbidden: ${ONLY_ITS_PLAYER_WITHDRAWS}`);
    assert.equal(decide(castTable(), { t: "cast.close", castId: "k1", end: "dismissed" }, DM), `gone: ${ASK_CLOSED}`);
  });

  test("an outcome naming a closed ask is refused, so two DM devices apply one ask once", () => {
    const outcome: Op = { t: "actor.outcome", plan: "pl1", cast: "k1", targets: [{ target: { tokenId: "g1" }, amount: 5 }] };
    assert.equal(decide(open(), outcome, DM), "ok");
    assert.equal(decide(castTable(), outcome, DM), `gone: ${ASK_CLOSED}`);
  });
});

describe("an asked area", () => {
  const open = () => castTable({ casts: { k1: castAsk("k1") } });

  test("is locked for its player while an ask names it", () => {
    const state = open();
    assert.equal(decide(state, { t: "template.update", templateId: "a1", patch: { origin: { x: 8, y: 8, z: 0 } } }), `forbidden: ${AREA_ASKED}`);
    assert.equal(decide(state, { t: "template.update", templateId: "a1", patch: { size: 30 } }), `forbidden: ${AREA_ASKED}`);
    assert.equal(decide(state, { t: "template.delete", templateId: "a1" }), `forbidden: ${AREA_ASKED}`);
    assert.equal(decide(castTable(), { t: "template.delete", templateId: "a1" }), "ok", "with no ask open");
  });

  test("stays fixed when its owner can no longer withdraw the ask, and says the DM can dismiss it (SSB-O-3)", () => {
    const gone = open();
    delete gone.tokens.thorn;
    assert.equal(decide(gone, { t: "cast.close", castId: "k1", end: "withdrawn" }), `gone: ${ASK_CLOSED}`, "its caster is gone, so no withdraw");
    assert.equal(decide(gone, { t: "template.update", templateId: "a1", patch: { size: 30 } }), `forbidden: ${AREA_ASKED_DM}`);
    assert.equal(decide(gone, { t: "template.delete", templateId: "a1" }), `forbidden: ${AREA_ASKED_DM}`);
    const passed = open();
    passed.characters["thorn-c"]!.ownerIds = ["p2"];
    assert.equal(decide(passed, { t: "cast.close", castId: "k1", end: "withdrawn" }), `gone: ${ASK_CLOSED}`, "Thorn passed to another player");
    assert.equal(decide(passed, { t: "template.delete", templateId: "a1" }), `forbidden: ${AREA_ASKED_DM}`);
    assert.equal(decide(passed, { t: "cast.close", castId: "k1", end: "dismissed" }, DM), "ok", "the DM's Dismiss frees it");
  });

  test("is not locked for the DM, and a hidden area still answers as missing", () => {
    const state = open();
    assert.equal(decide(state, { t: "template.update", templateId: "a1", patch: { origin: { x: 8, y: 8, z: 0 } } }, DM), "ok");
    assert.equal(decide(state, { t: "template.delete", templateId: "a1" }, DM), "ok");
    state.templates.a1!.visibility = "dm";
    assert.equal(decide(state, { t: "template.delete", templateId: "a1" }), GONE);
  });
});
