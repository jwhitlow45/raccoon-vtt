import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { RoomState, Token, TurnStart } from "./model.ts";
import { dependents, projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { reads, satisfies } from "./reads.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, env, room, token } from "./testutil.ts";

/**
 * What players get of attached tokens (docs/design-v1-attach.md 8.4 and
 * 8.5): a link only while its holder is in their projection, the turn's
 * mounts they can see, the re-projection a holder's change needs, and
 * which moves their device predicts.
 */

/** Bree (P1's) rides a warhorse at 4,4. A stalker no player sees holds a torch at 8,2. */
function table(setup?: (s: RoomState) => void): RoomState {
  const state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } }),
      stalker: token("stalker", { name: "Stalker", x: 8, y: 2, visibility: "dm" }),
      torch: token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 8.5, y: 2.5, attached: { to: "stalker", kind: "carry" } }),
    },
  });
  setup?.(state);
  return state;
}

const copyOf = (state: RoomState, viewer = P1) => projectState(state, viewer, { sceneId: "s1" });
const tokenIn = (state: RoomState, id: string, viewer = P1) => copyOf(state, viewer).tokens[id] as Token | undefined;

describe("a link as players get it (8.5)", () => {
  test("with its kind and steer while the holder is in their projection", () => {
    const state = table();
    for (const p of [P1, P2, DM]) assert.deepEqual(tokenIn(state, "bree", p)?.attached, { to: "horse", kind: "ride", steer: true }, p.memberId);
  });

  test("never while the holder is hidden from them, even to the carried token's owner, which reaches them loose", () => {
    const state = table();
    for (const p of [P1, P2]) {
      const torch = tokenIn(state, "torch", p);
      assert.ok(torch, p.memberId);
      assert.equal(torch.attached, undefined, p.memberId);
    }
    assert.equal(tokenIn(state, "torch", DM)?.attached?.to, "stalker");
  });

  test("a holder withheld by the fog withholds the link too", () => {
    const state = table((s) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      s.tokens.stalker = { ...s.tokens.stalker!, visibility: "all" };
    });
    assert.equal(tokenIn(state, "stalker"), undefined);
    assert.equal(tokenIn(state, "torch")?.attached, undefined);
  });
});

describe("the turn's mounts as players get them (8.5)", () => {
  function sharing(hide: boolean): RoomState {
    const state = table((s) => {
      s.tokens.shade = token("shade", { name: "Shade", size: "large", x: 20, y: 20, visibility: hide ? "dm" : "all" });
    });
    const start: TurnStart = { entryId: "e1", tokenId: "bree", sceneId: "s1", x: 4, y: 4, elevation: 0, seq: 3, seen: true, mounts: ["horse", "shade"] };
    state.encounter = { rev: 0, round: 1, activeEntryId: "e1", started: true, entries: [{ id: "e1", tokenId: "bree", value: 15, tieOrder: 0, hidden: false, inLair: false, reactionUsed: false }], turnStart: start };
    return state;
  }

  test("only those their copy holds, and none when it holds none", () => {
    assert.deepEqual(copyOf(sharing(false)).encounter?.turnStart?.mounts, ["horse", "shade"]);
    assert.deepEqual(copyOf(sharing(true)).encounter?.turnStart?.mounts, ["horse"]);
    const none = sharing(true);
    none.encounter!.turnStart!.mounts = ["shade"];
    assert.equal(copyOf(none).encounter?.turnStart?.mounts, undefined);
    assert.deepEqual(copyOf(none, DM).encounter?.turnStart?.mounts, ["shade"]);
  });

  test("a change to a sharing mount re-projects the turn, and a holder's change its carried tokens", () => {
    const state = sharing(true);
    const touched = dependents(state, [keys.token("shade")]);
    assert.ok(touched.includes(keys.encounter));
    assert.ok(dependents(state, [keys.token("stalker")]).includes(keys.token("torch")));
    assert.ok(dependents(state, [keys.token("horse")]).includes(keys.token("bree")));
  });

  test("showing the holder hands players the link at once", () => {
    const before = table();
    const r = applyOp(before, { t: "token.update", tokenId: "stalker", patch: { visibility: "all" } }, DM, env(5));
    assert.ok(r.ok);
    const keysSent = new Set([...r.touched, ...dependents(r.state, r.touched)]);
    assert.ok(keysSent.has(keys.token("torch")));
    assert.equal(tokenIn(r.state, "torch")?.attached?.to, "stalker");
  });
});

describe("prediction (8.4)", () => {
  /** As the device asks it, of its own copy (client/state/store.ts). */
  const predicted = (state: RoomState, op: Op, viewer = P1) => {
    const copy = copyOf(state, viewer);
    return satisfies(reads(op, copy as unknown as RoomState), copy, viewer, { sceneId: "s1" });
  };

  test("a holder's move reads every token of its group the viewer's copy holds, and is predicted for what it holds", () => {
    const state = table((s) => {
      s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 5, y: 5, visibility: "dm", attached: { to: "horse", kind: "perch" } });
    });
    const op: Op = { t: "token.move", tokenId: "horse", x: 8, y: 4 };
    const read = reads(op, state);
    assert.ok(!("never" in read));
    assert.deepEqual(read.keys.map((k) => k.key).sort(), [keys.token("bree"), keys.token("horse"), keys.token("imp")].sort());
    // The imp is not in P1's copy, which reads its own group.
    assert.equal(predicted(state, op), true);
  });

  test("a controlled ride during a fight waits for the server, and other attaches are predicted", () => {
    const fight = table((s) => {
      s.tokens.bree = { ...s.tokens.bree!, x: 6, y: 4, attached: undefined };
      s.encounter = { rev: 0, round: 1, activeEntryId: null, started: true, entries: [] };
    });
    const ride: Op = { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 };
    assert.equal(predicted(fight, ride), false);
    assert.equal(predicted(fight, ride, DM), true);
    const free: Op = { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 0 };
    assert.equal(predicted(fight, free), true);
  });
});
