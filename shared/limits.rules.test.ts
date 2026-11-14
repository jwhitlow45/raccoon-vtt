import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HIDDEN_ROW_REFUSED, HISTORY_BYTES } from "./limits.ts";
import type { Drawing, EncounterSnapshot, RoomState } from "./model.ts";
import { AREA_ASKED, MOVE_PLAYERS_FIRST, ROLL_ASKED_ALREADY, canApply, type PermissionDeps } from "./permissions.ts";
import { guardHash } from "./reducer/tx.ts";
import { applyOp } from "./reducer.ts";
import { derivedId } from "./reducer/duplicate.ts";
import { keptHistory } from "./reducer/encounter.ts";
import { CHANGED_SINCE } from "./reducer/misc.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "./rules/hp.ts";
import type { Op } from "./protocol.ts";
import { actor, AT, castAsk, castTable, character, DM, drawing, effect, entry, P1, room, scene, token } from "./testutil.ts";

const deps: PermissionDeps = { canUseAsset: () => true };

function run(state: RoomState, op: Op, who = DM, opVersion?: number) {
  return applyOp(state, op, who, { seq: 9, at: AT, ...(opVersion !== undefined ? { opVersion } : {}) });
}

/** Twins that differ only in what P1 cannot see: their drawing `mine` hidden by the DM in A, deleted in B. */
function twins(base: RoomState): [RoomState, RoomState] {
  const a = structuredClone(base);
  a.drawings.mine = { ...a.drawings.mine!, visibility: "dm" };
  const b = structuredClone(base);
  delete b.drawings.mine;
  return [a, b];
}

describe("a player's clear and restore read their own copy", () => {
  const base = room({ drawings: { mine: drawing("mine"), other: drawing("other", { sceneId: "s1" }) } });

  /** What P1 gets for a restore: the permission check's refusal, the reducer's, or taken. */
  function answer(state: RoomState, op: Op): unknown {
    const allowed = canApply(op, P1, state, deps);
    if (!allowed.ok) return [allowed.code, allowed.message];
    const r = run(state, op, P1);
    return r.ok ? "taken" : [r.code, r.message];
  }

  test("a clear takes only the drawings the copy holds, and an older op took them all", () => {
    const [a] = twins(base);
    const cleared = run(a, { t: "drawing.clear", sceneId: "s1", scope: "own" }, P1);
    assert.ok(cleared.ok);
    assert.ok(cleared.state.drawings.mine, "the hidden drawing stays");
    assert.equal(cleared.state.drawings.other, undefined);
    const old = run(a, { t: "drawing.clear", sceneId: "s1", scope: "own" }, P1, 60);
    assert.ok(old.ok && old.state.drawings.mine === undefined);
  });

  test("a kept ruler on a creature out of sight stays through a clear", () => {
    const state = room({ tokens: { orc: token("orc", { visibility: "dm" }) }, drawings: { r: drawing("r", { kind: "ruler", anchors: ["orc", null], points: [0, 0, 2, 2] }) } });
    const cleared = run(state, { t: "drawing.clear", sceneId: "s1", scope: "own" }, P1);
    assert.ok(cleared.ok && cleared.state.drawings.r);
  });

  test("undoing their drawing's create answers that it was changed since, hidden or deleted alike", () => {
    const made = drawing("mine");
    const undo: Op = { t: "sys.restore", entries: [{ key: "drawing:mine", value: null, expectHash: guardHash("drawing:mine", made) }], from: "undo" };
    for (const twin of twins(base)) assert.deepEqual(answer(twin, undo), ["invalid", CHANGED_SINCE]);
  });

  test("undoing a kept ruler's create answers that it was changed since, its creature hidden or the ruler deleted alike", () => {
    const ruler = drawing("r", { kind: "ruler", anchors: ["orc", null], points: [0, 0, 2, 2] });
    const undo: Op = { t: "sys.restore", entries: [{ key: "drawing:r", value: null, expectHash: guardHash("drawing:r", ruler) }], from: "undo" };
    const hidden = room({ tokens: { orc: token("orc", { visibility: "dm" }) }, drawings: { r: ruler } });
    const deleted = room({ tokens: { orc: token("orc", { visibility: "dm" }) } });
    for (const twin of [hidden, deleted]) assert.deepEqual(answer(twin, undo), ["invalid", CHANGED_SINCE]);
    assert.equal(answer(room({ tokens: { orc: token("orc") }, drawings: { r: ruler } }), undo), "taken");
  });

  test("undoing a create on a map the players left answers the same whether the drawing is still there or deleted", () => {
    const made = drawing("mine");
    const undo: Op = { t: "sys.restore", entries: [{ key: "drawing:mine", value: null, expectHash: guardHash("drawing:mine", made) }], from: "undo" };
    const left = (drawings: RoomState["drawings"]) => {
      const state = room({ drawings });
      state.meta.playerSceneId = "s2";
      return state;
    };
    assert.deepEqual(answer(left({ mine: made }), undo), ["invalid", CHANGED_SINCE]);
    assert.deepEqual(answer(left({}), undo), ["invalid", CHANGED_SINCE]);
  });

  test("a restore's other refusals come first, the drawing hidden or deleted alike", () => {
    const made = drawing("mine");
    const undo: Op = { t: "sys.restore", entries: [{ key: "drawing:mine", value: null, expectHash: guardHash("drawing:mine", made) }, { key: "drawing:theirs", value: drawing("theirs", { ownerId: "p2" }) }], from: "undo" };
    for (const twin of twins(base)) assert.deepEqual(answer(twin, undo), ["forbidden", "only the DM can do that"]);
  });

  test("a kept ruler put back stands only on creatures its player sees", () => {
    const ruler: Drawing = drawing("r", { kind: "ruler", anchors: ["orc", null], points: [0, 0, 2, 2] });
    const back: Op = { t: "sys.restore", entries: [{ key: "drawing:r", value: ruler }], from: "undo" };
    const hidden = room({ tokens: { orc: token("orc", { visibility: "dm" }) } });
    const gone = room();
    for (const twin of [hidden, gone]) assert.equal(canApply(back, P1, twin, deps).ok ? "ok" : (canApply(back, P1, twin, deps) as { code: string }).code, "gone");
    assert.deepEqual(canApply(back, P1, room({ tokens: { orc: token("orc") } }), deps), { ok: true });
  });
});

describe("rows a player adds", () => {
  const fight = (visibility: "all" | "dm") =>
    room({
      characters: { c1: character("c1") },
      tokens: { hero: token("hero", { kind: "pc", actor: { ref: "c1" }, visibility }), orc: token("orc", { visibility: "dm" }) },
      encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e0", { label: "Lair" })] },
    });

  test("a row for their own creature the DM hid is refused in words, and taken while it is shown", () => {
    const op: Op = { t: "encounter.add", entries: [{ id: "e1", tokenId: "hero" }] };
    assert.deepEqual(canApply(op, P1, fight("dm"), deps), { ok: false, code: "forbidden", message: HIDDEN_ROW_REFUSED });
    assert.deepEqual(canApply(op, P1, fight("all"), deps), { ok: true });
  });

  test("a creature they do not own or cannot see answers as before", () => {
    const op: Op = { t: "encounter.add", entries: [{ id: "e1", tokenId: "orc" }] };
    assert.equal((canApply(op, P1, fight("all"), deps) as { code: string }).code, "gone");
  });
});

describe("asks", () => {
  test("an ask the copy no longer holds locks nothing: its caster handed on", () => {
    const state = castTable({ casts: { k1: castAsk("k1", { area: "a1" }) } });
    const op: Op = { t: "template.update", templateId: "a1", patch: { label: "Moved" } };
    assert.deepEqual(canApply(op, P1, state, deps), { ok: false, code: "forbidden", message: AREA_ASKED });
    const handed = structuredClone(state);
    handed.characters["thorn-c"]!.ownerIds = ["p2"];
    handed.templates.a1!.casterId = undefined;
    delete handed.templates.a1!.casterId;
    assert.deepEqual(canApply(op, P1, handed, deps), { ok: true });
  });

  test("a roll's tag is used once by its own receipt, whatever became of the ask that took it", () => {
    const ask = (id: string): Op => ({ t: "cast.ask", cast: { id, caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1", damage: { tag: "tag1", parts: 1 } } });
    const state = castTable();
    const taken = (by: string | null | undefined): PermissionDeps => ({ ...deps, rollTag: (member) => (member !== "p1" || by === undefined ? null : { ask: by }) });
    assert.deepEqual(canApply(ask("k2"), P1, state, taken(null)), { ok: true }, "a free receipt");
    assert.deepEqual(canApply(ask("k2"), P1, state, taken("k2")), { ok: true }, "the same ask sent again");
    for (const by of ["k1", undefined]) assert.deepEqual(canApply(ask("k2"), P1, state, taken(by)), { ok: false, code: "invalid", message: ROLL_ASKED_ALREADY });
    const withOpen = castTable({ casts: { k1: castAsk("k1", { area: "a2", damage: { tag: "tag1", parts: 1 } }) } });
    assert.deepEqual(canApply(ask("k2"), P1, withOpen, taken(null)), { ok: true }, "no stored ask is read");
  });

  test("an ask goes with its caster, so a companion asked for and dismissed leaves none", () => {
    const state = castTable({
      tokens: { ...castTable().tokens, pet: token("pet", { companion: { of: "thorn-c", turn: "own" }, ownerIds: ["p1"] }) },
      casts: { k1: castAsk("k1", { caster: "pet", area: undefined, targets: ["g1"] }), k2: castAsk("k2", { caster: "thorn", area: undefined, targets: ["g1"] }) },
    });
    const gone = run(state, { t: "token.delete", tokenId: "pet" });
    assert.ok(gone.ok);
    assert.deepEqual(Object.keys(gone.state.casts), ["k2"]);
    const old = run(state, { t: "token.delete", tokenId: "pet" }, DM, 60);
    assert.ok(old.ok && Object.keys(old.state.casts).length === 2, "an older op kept it");
  });
});

describe("the fight's history", () => {
  const step = (bytes: number): EncounterSnapshot => ({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e", { label: "x".repeat(Math.max(1, bytes - 200)) })] }, effects: {}, revealed: [], at: AT });

  test("keeps its newest steps within its bytes, and a step past them alone keeps nothing", () => {
    const big = Math.floor(HISTORY_BYTES / 3);
    const kept = keptHistory([step(big), step(big), step(big)], step(big));
    assert.equal(kept.length, 2);
    assert.deepEqual(keptHistory([step(10)], step(HISTORY_BYTES + 1)), []);
    assert.equal(keptHistory(Array.from({ length: 25 }, () => step(10)), step(10)).length, 20);
  });
});

describe("copies", () => {
  test("a derived id is never shaped as version 7, and an older op derived as it did", () => {
    for (let i = 0; i < 64; i++) assert.equal(derivedId("s9", `x${i}`)[14], "8");
    assert.ok(Array.from({ length: 64 }, (_, i) => derivedId("s9", `x${i}`, 60)[14]).some((c) => c !== "8"));
  });

  test("a duplicate gives a copy's conditions fresh ids and keeps the bare automatic Unconscious", () => {
    const state = room({ tokens: { orc: token("orc", { actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, life: "dying", effects: [effect("e1"), { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }] }) } }) } });
    const r = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    assert.ok(r.ok);
    const copy = Object.values(r.state.tokens).find((t) => t.sceneId === "s9")!;
    const effects = "inline" in copy.actor ? copy.actor.inline.effects : [];
    assert.equal(effects.length, 2);
    assert.notEqual(effects[0]!.id, "e1");
    assert.equal(effects[1]!.id, ZERO_HP_UNCONSCIOUS_ID);
  });
});

describe("the players' own map", () => {
  test("a delete without the confirm is refused as before, and with it leaves the players on no map", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
    assert.deepEqual(canApply({ t: "scene.delete", sceneId: "s1" }, DM, state, deps), { ok: false, code: "invalid", message: MOVE_PLAYERS_FIRST });
    const op: Op = { t: "scene.delete", sceneId: "s1", leavePlayers: true };
    assert.deepEqual(canApply(op, DM, state, deps), { ok: true });
    const r = run(state, op);
    assert.ok(r.ok);
    assert.equal(r.state.meta.playerSceneId, null);
    assert.ok(r.inverse?.some((e) => e.key === "meta"), "its undo puts them back");
  });
});
