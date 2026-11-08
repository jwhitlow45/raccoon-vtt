import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "./keys.ts";
import type { Effect, RoomClock, RoomState, Viewer } from "./model.ts";
import { dependents, projectEntity, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, env, room, token } from "./testutil.ts";

/**
 * A time span's end in each audience's copy (docs/design/design-v1-calendar-c2c3.md
 * 4.4): the DM's whole, a player's and a table display's, owners included,
 * with the end only while their view holds that very clock, and the
 * creatures that re-project when the clock appears, goes, changes id or
 * flips its sharing.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const PLAYERS = [P1, P2, DISPLAY];
const H = 3_600;
const SPAN: Effect = { id: "x", key: "blessed", ends: { span: H, at: 9 * H, clock: "c1" } };
const LENGTH_ONLY: Effect = { id: "x", key: "blessed", ends: { span: H } };

function table(clock: Partial<RoomClock> | null, blackout = false): RoomState {
  return room({
    meta: { ...room().meta, view: { follow: false, blackout } },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [SPAN] }) }) },
    tokens: {
      "bree-t": token("bree-t", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p1"] }),
      gob: token("gob", { actor: { inline: actor({ effects: [SPAN] }) } }),
    },
    ...(clock === null ? {} : { clock: { id: "c1", rev: 3, t: 8 * H, shown: true, calendar: { kind: "days" }, ...clock } }),
  });
}

/** Bree's effects and the goblin's, null where the copy holds no goblin, as behind a blackout. */
function copies(state: RoomState, who: Viewer): { bree: Effect[]; gob: Effect[] | null } {
  const seen = projectState(state, who, { sceneId: "s1" });
  const gob = seen.tokens.gob?.actor;
  return { bree: seen.characters.bree!.actor.effects, gob: gob && "inline" in gob ? gob.inline.effects : null };
}

describe("a time span's end in each copy (4.4)", () => {
  test("shown: every player and the display get the end, owners or not", () => {
    for (const who of [DM, ...PLAYERS]) assert.deepEqual(copies(table({}), who), { bree: [SPAN], gob: [SPAN] }, who.memberId);
  });

  test("hidden, behind a blackout, with no clock or on a clock that stopped: players and the display get the length alone, the DM the whole", () => {
    const rooms = { hidden: table({ shown: false }), blackout: table({}, true), none: table(null), replaced: table({ id: "c2" }) };
    for (const [name, state] of Object.entries(rooms)) {
      assert.deepEqual(copies(state, DM), { bree: [SPAN], gob: [SPAN] }, `${name} DM`);
      for (const who of PLAYERS) assert.deepEqual(copies(state, who), { bree: [LENGTH_ONLY], gob: name === "blackout" ? null : [LENGTH_ONLY] }, `${name} ${who.memberId}`);
    }
  });

  test("an entity's own projection follows the same rule", () => {
    assert.deepEqual((projectEntity(keys.character("bree"), table({ shown: false }), P1, { sceneId: "s1" }) as { actor: { effects: Effect[] } }).actor.effects, [LENGTH_ONLY]);
    assert.deepEqual((projectEntity(keys.character("bree"), table({}), P1, { sceneId: "s1" }) as { actor: { effects: Effect[] } }).actor.effects, [SPAN]);
  });

  test("a DM's span added while the clock is hidden reaches Pat as its length alone", () => {
    const state = table({ shown: false });
    const r = applyOp(state, { t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: "y", key: "hasted", duration: { mode: "span", seconds: H } } }, DM, env(5));
    assert.ok(r.ok);
    assert.deepEqual(copies(r.state, P1).bree.at(-1), { id: "y", key: "hasted", ends: { span: H } });
  });
});

describe("re-projection on a sharing flip, a stop and a start (4.4)", () => {
  const after = (state: RoomState, op: Op) => {
    const r = applyOp(state, op, DM, env(7));
    assert.ok(r.ok, r.ok ? "" : r.message);
    return r;
  };
  const reprojected = (before: RoomState, op: Op): EntityKey[] => {
    const r = after(before, op);
    return [...new Set([...dependents(before, r.touched, r.state), ...dependents(r.state, r.touched, before)])];
  };
  const TIMED = [keys.character("bree"), keys.token("gob")];

  test("sharing turned on or off, a stop and a start re-project every creature holding a span", () => {
    for (const [state, op] of [
      [table({ shown: false }), { t: "clock.update", shown: true }],
      [table({}), { t: "clock.update", shown: false }],
      [table({}), { t: "clock.stop" }],
      [table(null), { t: "clock.start", id: "c1", at: 0, shown: true, calendar: { kind: "days" } }],
    ] as [RoomState, Op][]) {
      const keysOut = reprojected(state, op);
      for (const key of TIMED) assert.ok(keysOut.includes(key), `${op.t} ${key}`);
    }
  });

  test("sharing turned on gives Pat's copy the end in that batch", () => {
    const r = after(table({ shown: false }), { t: "clock.update", shown: true });
    assert.deepEqual(copies(r.state, P1).bree, [SPAN]);
  });

  test("a plain step or a rename re-projects no creature that the step does not change", () => {
    for (const op of [{ t: "clock.advance", by: 60 }, { t: "clock.update", calendar: { kind: "months", months: [{ name: "One", days: 30 }] } }] as Op[]) {
      const keysOut = reprojected(table({}), op);
      for (const key of TIMED) assert.equal(keysOut.includes(key), false, `${op.t} ${key}`);
    }
  });
});
