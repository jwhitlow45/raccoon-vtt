import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Trap, TrapRig } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, actor, env, room, token } from "../testutil.ts";
import { UNCOUNTED_LINE, type Env } from "./tx.ts";

/**
 * The net under the room count (tx.ts Env.uncounted): an op reduced under
 * an uncounted envelope takes a number an answered op may hold already, so
 * Tx refuses every line it tries to write, a shared one, the DM's own, and
 * a trap's, with `invalid`. The actor logs such a refusal, and a refused
 * map step makes its scene forget (actor.ts #remember). The server's own
 * explore, remember and music ops never write one (counted.prop.test.ts).
 */

const rig = (over: Partial<TrapRig> = {}): TrapRig => ({ on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "A click underfoot.", ...over });
const plate: Trap = { id: "plate", rev: 0, sceneId: "s1", name: "plate", zone: { cells: [{ x: 3, y: 5, w: 1, h: 1 }] }, state: "armed", found: false, rig: rig() };

function world(): RoomState {
  const state = room();
  state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 0, y: 5 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 9, y: 9, actor: { inline: actor() } });
  state.traps = { plate };
  return state;
}

const uncounted = (seq: number): Env => ({ ...env(seq), uncounted: true });

describe("an uncounted envelope writes no line", () => {
  const cases: [string, Op, typeof DM][] = [
    ["a chat, a shared line", { t: "log.chat", text: "hello" }, DM],
    ["a creature's HP change, an event line", { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 2 } }, DM],
    ["a walk onto a plate, a trap's lines", { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1],
  ];
  for (const [what, op, who] of cases) {
    test(`${what} is refused invalid, and applies under the same number counted`, () => {
      const refused = applyOp(world(), op, who, uncounted(7));
      assert.equal(refused.ok, false);
      assert.deepEqual(refused.ok ? null : { code: refused.code, message: refused.message }, { code: "invalid", message: UNCOUNTED_LINE });
      const counted = applyOp(world(), op, who, env(7));
      assert.ok(counted.ok, counted.ok ? "" : counted.message);
      const written = [...counted.state.log, ...counted.state.trapLog, ...counted.state.trapSeen];
      assert.ok(written.length > 0 && written.every((line) => line.id.startsWith("7:")), "counted, it writes its lines under its number");
    });
  }

  test("an op that writes no line applies the same under either envelope", () => {
    const op: Op = { t: "token.move", tokenId: "gob", x: 9, y: 2 };
    const counted = applyOp(world(), op, DM, env(7));
    const plain = applyOp(world(), op, DM, uncounted(7));
    assert.ok(counted.ok && plain.ok);
    assert.deepEqual(plain.state, counted.state);
    assert.deepEqual(plain.touched, counted.touched);
  });
});
