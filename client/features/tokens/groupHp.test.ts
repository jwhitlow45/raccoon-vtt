import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { actor, DM, room, token } from "#shared/testutil.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { groupAccess, hpOps, hpTargets, sendHpEntry, type HpTarget } from "./groupHp.ts";

const target = (id: string, over: Partial<HpTarget> = {}): HpTarget => ({
  holder: `token:${id}`,
  target: { tokenId: id },
  name: id,
  access: "all",
  atZero: false,
  ...over,
});

describe("one HP entry for several creatures", () => {
  test("each creature gets its own op, and a shared character only once", () => {
    const ops = hpOps([target("a"), target("b"), target("pc1", { holder: "character:c" }), target("pc2", { holder: "character:c" })], { kind: "damage", amount: 7 }, false);
    assert.deepEqual(
      ops.map((o) => (o.t === "actor.hp" ? o.target : null)),
      [{ tokenId: "a" }, { tokenId: "b" }, { tokenId: "pc1" }],
    );
    for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("what the viewer may not change is left out, and the entry offers only what all of them allow", () => {
    const mixed = [target("own"), target("goblin", { access: "relative" }), target("hidden", { access: "none" })];
    assert.equal(groupAccess(mixed), "relative");
    assert.equal(groupAccess([target("a"), target("b")]), "all");
    assert.equal(groupAccess([target("x", { access: "none" })]), "none");
    assert.deepEqual(
      hpOps(mixed, { kind: "heal", amount: 3 }, false).map((o) => (o.t === "actor.hp" ? o.target : null)),
      [{ tokenId: "own" }, { tokenId: "goblin" }],
    );
    assert.equal(hpOps(mixed, { kind: "set", cur: 1 }, false).length, 1, "a set reaches only the creature that allows it");
  });

  test("a critical hit counts only on creatures at 0 HP", () => {
    const ops = hpOps([target("up"), target("down", { atZero: true })], { kind: "damage", amount: 4 }, true);
    assert.deepEqual(
      ops.map((o) => (o.t === "actor.hp" && o.change.kind === "damage" ? o.change.crit ?? false : null)),
      [false, true],
    );
  });

  test("temporary HP is spent first on each creature, by the shared rules", () => {
    let state = room({
      tokens: {
        g1: token("g1", { actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 5 } }) } }),
        g2: token("g2", { actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }),
      },
    });
    const targets = hpTargets([state.tokens.g1!, state.tokens.g2!], { role: "dm", memberId: DM.memberId, characters: state.characters, playersApplyDamage: false });
    assert.equal(groupAccess(targets), "all");
    for (const op of hpOps(targets, { kind: "damage", amount: 6 }, false)) {
      const r = applyOp(state, op, DM, { seq: 1, at: new Date(0).toISOString() });
      assert.ok(r.ok);
      state = r.state;
    }
    const hp = (id: string) => {
      const t = state.tokens[id]!;
      return "inline" in t.actor ? t.actor.inline.hp : undefined;
    };
    assert.deepEqual(hp("g1"), { cur: 6, max: 7, temp: 0 });
    assert.deepEqual(hp("g2"), { cur: 1, max: 7, temp: 0 });
  });

  test("one entry for several creatures is one undo step, and one for a single creature needs no group", () => {
    const sent: { op: ClientOp; group?: string }[] = [];
    let n = 0;
    const actions = {
      dispatch(op: ClientOp, opts?: { group?: string }) {
        sent.push({ op, ...(opts?.group !== undefined ? { group: opts.group } : {}) });
        return sent.length;
      },
      newId: () => `g${n++}`,
    };
    sendHpEntry(actions, [target("a"), target("b"), target("c")], { kind: "damage", amount: 7 }, false);
    assert.equal(sent.length, 3);
    assert.ok(sent.every((s) => s.group === "g0"), "every op of the entry shares one undo group");
    sent.length = 0;
    sendHpEntry(actions, [target("a")], { kind: "heal", amount: 2 }, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.group, undefined);
  });
});
