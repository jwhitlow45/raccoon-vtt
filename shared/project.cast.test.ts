import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { CastAsk, LogEntry, RoomState, Viewer } from "./model.ts";
import { dependents, projectEntity, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, castAsk, castTable, damageRoll, diceLine, env } from "./testutil.ts";

/** Who receives a player's ask for saves and its lines (docs/design-v1-player-save-spell.md 5.5). */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };

const rolled: CastAsk["rolled"] = [{ formula: "8d6", total: 28, type: "fire" }];

/** Thorn's open Fireball over a1, with its Secret damage line, and Hold Person on g1, g2 and Bree, with their lines. */
function table(): RoomState {
  const state = castTable({
    casts: {
      k1: castAsk("k1", { damage: { tag: "dmg", parts: 1 }, rolled }),
      k2: castAsk("k2", { spell: "Hold Person", slot: 2, area: undefined, targets: ["g1", "g2", "bree"], roll: "spells:Hold Person" }),
    },
    log: [
      diceLine("40:0", "dmg", [damageRoll()], { to: "dm" }),
      { id: "41:0", at: "2026-10-18T20:00:00.000Z", kind: "event", data: { type: "cast", castId: "k1", tokenId: "thorn", spell: "Fireball", slot: 3 } },
      { id: "42:0", at: "2026-10-18T20:00:00.000Z", kind: "event", data: { type: "cast", castId: "k2", tokenId: "thorn", spell: "Hold Person", slot: 2 } },
    ],
  });
  state.members.p3 = { ...state.members.p2!, id: "p3", name: "p3" };
  return state;
}

const view = (state: RoomState, who: Viewer) => projectState(state, who, { sceneId: "s1" });
const castLines = (log: LogEntry[]) => log.filter((e) => e.data?.type === "cast").map((e) => e.id);
/** The ask as the asker's projection holds it now. */
const asked = (state: RoomState, id: string) => projectEntity(keys.cast(id), state, P1, { sceneId: "s1" }) as CastAsk | null;

describe("an ask's projection", () => {
  test("the DM gets every ask whole and every line", () => {
    const state = table();
    const p = view(state, DM);
    assert.deepEqual(p.casts, state.casts);
    assert.deepEqual(castLines(p.log), ["41:0", "42:0"]);
  });

  test("the asker gets their asks with the targets they see, the area, and their own roll", () => {
    const p = view(table(), P1);
    assert.deepEqual(p.casts.k1, table().casts.k1);
    assert.deepEqual(p.casts.k2?.targets, ["g1", "bree"], "the hidden goblin is cut");
    assert.deepEqual(castLines(p.log), ["41:0", "42:0"]);
  });

  test("a co-owner gets the asks without the asker's roll, whose Secret line reads bare", () => {
    const state = table();
    state.characters["thorn-c"]!.ownerIds = ["p1", "p3"];
    const p = view(state, P3);
    assert.equal(p.casts.k1?.damage, undefined);
    assert.equal(p.casts.k1?.rolled, undefined);
    assert.equal(p.casts.k1?.area, "a1");
    assert.deepEqual(p.log.find((e) => e.id === "40:0")?.data, { type: "dice", by: "p1", to: "dm", rolls: [] });
    assert.deepEqual(castLines(p.log), ["41:0", "42:0"]);
  });

  test("another player and a table display get neither the asks nor their lines", () => {
    for (const who of [P2, DISPLAY]) {
      const p = view(table(), who);
      assert.deepEqual(p.casts, {}, who.memberId);
      assert.deepEqual(castLines(p.log), [], who.memberId);
    }
  });

  test("behind a pause the caster's players hold none", () => {
    const state = table();
    state.meta.view.blackout = true;
    const p = view(state, P1);
    assert.deepEqual(p.casts, {});
    assert.deepEqual(castLines(p.log), []);
  });

  test("an area the viewer cannot see is cut, and a caster that is gone takes the ask out of its players' view", () => {
    const hidden = table();
    hidden.templates.a1!.visibility = "dm";
    assert.equal(view(hidden, P1).casts.k1?.area, undefined);
    const gone = table();
    delete gone.tokens.thorn;
    assert.deepEqual(view(gone, P1).casts, {});
    assert.ok(view(gone, DM).casts.k1, "the DM keeps it, and its card says what is gone");
  });

  test("an ask a player's former creature made goes with the creature", () => {
    const state = table();
    state.characters["thorn-c"]!.ownerIds = ["p2"];
    assert.deepEqual(view(state, P1).casts, {});
    assert.deepEqual(Object.keys(view(state, P2).casts).sort(), ["k1", "k2"], "whoever owns the caster now");
    assert.equal(view(state, P2).casts.k1?.rolled, undefined, "the roll stays the asker's");
  });
});

describe("an ask follows what it names", () => {
  /** Applies the DM's op and checks every touched or dependent key against a fresh projection for the asker. */
  function follows(state: RoomState, op: Op): RoomState {
    const r = applyOp(state, op, DM, env(60));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const candidates = new Set([...r.touched, ...dependents(r.state, r.touched)]);
    for (const id of Object.keys({ ...state.casts, ...r.state.casts })) {
      const before = asked(state, id);
      const after = asked(r.state, id);
      if (JSON.stringify(before) !== JSON.stringify(after)) assert.ok(candidates.has(keys.cast(id)), `${op.t} changed ask ${id} without re-projecting it`);
    }
    return r.state;
  }

  test("the area hidden, revealed and deleted", () => {
    let state = follows(table(), { t: "template.update", templateId: "a1", patch: { visibility: "dm" } });
    assert.equal(asked(state, "k1")?.area, undefined);
    state = follows(state, { t: "template.update", templateId: "a1", patch: { visibility: "all" } });
    assert.equal(asked(state, "k1")?.area, "a1");
    state = follows(state, { t: "template.delete", templateId: "a1" });
    assert.equal(asked(state, "k1")?.area, undefined);
  });

  test("a target hidden after the ask, and the caster passed to another player", () => {
    let state = follows(table(), { t: "token.update", tokenId: "bree", patch: { visibility: "dm" } });
    assert.deepEqual(asked(state, "k2")?.targets, ["g1"]);
    state = follows(state, { t: "token.update", tokenId: "g2", patch: { visibility: "all" } });
    assert.deepEqual(asked(state, "k2")?.targets, ["g1", "g2"]);
    state = follows(state, { t: "token.delete", tokenId: "thorn" });
    assert.equal(asked(state, "k2"), null);
  });
});

describe("the caster's closing line", () => {
  test("is the same, id and all, for outcomes that differ only in hidden creatures and for a close with nothing to apply", () => {
    const lines: unknown[] = [];
    const outcomes: Op[] = [
      { t: "actor.outcome", plan: "pl1", cast: "k2", targets: [{ target: { tokenId: "g1" }, effects: [{ id: "e1", key: "paralyzed" }] }] },
      { t: "actor.outcome", plan: "pl1", cast: "k2", targets: [{ target: { tokenId: "g2" }, effects: [{ id: "e1", key: "paralyzed" }] }, { target: { tokenId: "g1" }, effects: [{ id: "e2", key: "paralyzed" }] }] },
      { t: "cast.close", castId: "k2", end: "done" },
    ];
    for (const op of outcomes) {
      const r = applyOp(table(), op, DM, env(70));
      assert.ok(r.ok, r.ok ? "" : r.message);
      const mine = view(r.state, P1).log.filter((e) => e.data?.type === "cast" && e.data.end !== undefined);
      lines.push(mine);
    }
    assert.deepEqual(lines[1], lines[0]);
    assert.deepEqual(lines[2], lines[0]);
    assert.equal((lines[0] as LogEntry[])[0]?.id, "70:0");
  });
});
