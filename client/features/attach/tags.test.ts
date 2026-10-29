import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { applyOp } from "#shared/reducer.ts";
import { opSchema, type ClientOp, type Op } from "#shared/protocol.ts";
import type { Encounter, RoomState, Token } from "#shared/model.ts";
import { actor, character, DM, entry, env, P1, P2, room, token } from "#shared/testutil.ts";
import { carriesTag, linkTag, marksTime, moveAfterRider, panelLinkTags, rowLink, steerChoice, steerOp } from "./tags.ts";
import { copyFor } from "./testing.ts";

const dm = { role: "dm" as const, memberId: DM.memberId };
const p1 = { role: "player" as const, memberId: P1.memberId };
const p2 = { role: "player" as const, memberId: P2.memberId };

/** Bree, p1's, riding the DM's warhorse controlled, a torch in her hand, a familiar on her shoulder, and a goblin the warhorse drags. */
function stable(over: (state: RoomState) => void = () => {}): RoomState {
  const state = room();
  state.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"] });
  const list: Token[] = [
    token("bree", { name: "Bree", kind: "pc", actor: { ref: "bree" }, x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } }),
    token("horse", { name: "Warhorse", size: "large", x: 5, y: 5 }),
    token("torch", { name: "Torch", kind: "object", size: "tiny", x: 5, y: 5, attached: { to: "bree", kind: "carry" } }),
    token("owl", { name: "Owl", size: "tiny", ownerIds: ["p1"], x: 5.5, y: 5, attached: { to: "bree", kind: "perch" } }),
    token("goblin", { name: "Goblin", number: 2, x: 7, y: 5, attached: { to: "horse", kind: "drag" } }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  over(state);
  return state;
}

const t = (state: RoomState, id: string) => state.tokens[id]!;

describe("the link's words in the panel and the tracker", () => {
  test("the name block names what carries a token and what it carries, by the names the viewer sees", () => {
    const state = stable();
    assert.equal(linkTag(state.tokens, t(state, "bree")), "Riding Warhorse");
    assert.equal(linkTag(state.tokens, t(state, "owl")), "On Bree", "a perch");
    assert.equal(linkTag(state.tokens, t(state, "torch")), "On Bree", "a carry");
    assert.equal(linkTag(state.tokens, t(state, "goblin")), "Dragged by Warhorse");
    assert.equal(linkTag(state.tokens, t(state, "horse")), null);
    assert.equal(carriesTag(state.tokens, t(state, "bree")), "Carries Owl and Torch");
    assert.equal(carriesTag(state.tokens, t(state, "horse")), "Carries Bree and Goblin 2");
    assert.deepEqual(panelLinkTags(state.tokens, t(state, "bree")), ["Riding Warhorse", "Carries Owl and Torch"]);
    assert.deepEqual(panelLinkTags(state.tokens, t(state, "goblin")), ["Dragged by Warhorse"]);
  });

  test("a player reads only the links their copy holds, and a hidden holder's name never", () => {
    const hidden = stable((s) => (s.tokens.horse = { ...s.tokens.horse!, visibility: "dm" }));
    const view = copyFor(hidden, P1);
    assert.equal(linkTag(view.tokens, t(view, "bree")), null, "the holder is not in the copy, so neither is the link");
    assert.deepEqual(panelLinkTags(view.tokens, t(view, "bree")), ["Carries Owl and Torch"]);
    const masked = stable((s) => (s.tokens.horse = { ...s.tokens.horse!, nameHidden: true, publicName: "Big horse" }));
    const other = copyFor(masked, P2);
    assert.equal(linkTag(other.tokens, t(other, "bree")), "Riding Big horse");
  });

  test("a rider's row reads Riding, a controlled mount's row whose turn it shares, and an independent mount's nothing", () => {
    const state = stable();
    assert.deepEqual(rowLink(state.tokens, t(state, "bree")), { riding: "Riding Warhorse", controlled: null });
    assert.deepEqual(rowLink(state.tokens, t(state, "horse")), { riding: null, controlled: "Controlled by Bree: moves and acts on Bree's turn (Dash, Disengage or Dodge)" });
    const free = stable((s) => (s.tokens.bree = { ...s.tokens.bree!, attached: { to: "horse", kind: "ride" } }));
    assert.deepEqual(rowLink(free.tokens, t(free, "horse")), { riding: null, controlled: null });
    assert.deepEqual(rowLink(free.tokens, undefined), { riding: null, controlled: null });
  });

  test("a row reads muted only in the round its mount shared a rider's turn", () => {
    assert.equal(marksTime({ round: 3 }, { markRound: 3 }), true);
    assert.equal(marksTime({ round: 4 }, { markRound: 3 }), false, "from the next round it has its own turn again");
    assert.equal(marksTime({ round: 3 }, {}), false);
    assert.equal(marksTime(null, { markRound: 3 }), false);
  });
});

describe("Move after Bree", () => {
  /** The warhorse's row acting, mounted during it, its value and place still its own. */
  function fight(horse: Partial<{ value: number | null; tieOrder: number }> = {}, active = "i-horse"): RoomState {
    return stable((s) => {
      s.encounter = {
        rev: 1,
        round: 2,
        activeEntryId: active,
        entries: [entry("i-bree", { tokenId: "bree", value: 15 }), entry("i-gob", { tokenId: "goblin", value: 12 }), entry("i-horse", { tokenId: "horse", value: 8, ...horse })],
      } as Encounter;
    });
  }
  const row = (state: RoomState, id: string) => state.encounter!.entries.find((e) => e.id === id)!;

  test("FU23A-AT-1: finishing a mount ahead of its rider does not skip the rider or repeat the mount's duration tick", () => {
    for (const between of [false, true]) {
      let state = fight({ value: 20 });
      if (between) state.encounter!.entries = state.encounter!.entries.map((e) => e.id === "i-gob" ? { ...e, value: 18 } : e);
      const offer = moveAfterRider(state, row(state, "i-horse"));
      assert.ok(offer);
      let seq = 10;
      const run = (op: ClientOp) => {
        const result = applyOp(state, opSchema.parse(op), DM, env(seq++));
        assert.ok(result.ok, result.ok ? "" : result.message);
        state = result.state;
      };
      for (const op of offer.ops) run(op);
      assert.equal(state.encounter!.activeEntryId, between ? "i-gob" : "i-bree", "the original next row acts");
      assert.equal(row(state, "i-horse").skipRound, 2, "the mount already finished its own row this round");
      if (between) run({ t: "encounter.next" });
      assert.equal(state.encounter!.activeEntryId, "i-bree");
      run({ t: "encounter.next" });
      assert.notEqual(state.encounter!.activeEntryId, "i-horse", "its own row never ticks again this round");
    }
  });

  test("FU23A-AT-1: ending a last mount starts the next round and does not skip its new round's row", () => {
    let state = fight();
    const offer = moveAfterRider(state, row(state, "i-horse"));
    assert.ok(offer);
    let seq = 10;
    for (const op of [...offer.ops, { t: "encounter.next" } as const]) {
      const result = applyOp(state, opSchema.parse(op), DM, env(seq++));
      assert.ok(result.ok);
      state = result.state;
    }
    assert.equal(state.encounter!.round, 3);
    assert.equal(state.encounter!.activeEntryId, "i-horse");
    assert.equal(row(state, "i-horse").markRound, 3, "its rider shared the new turn");
  });

  test("FU23A-AT-1: a mount left acting after defeated rows are skipped can move in its next round", () => {
    let state = fight({ value: 20 });
    state.meta.settings = { ...state.meta.settings, skipDefeated: true };
    state.characters.bree = { ...state.characters.bree!, actor: actor({ life: "dead" }) };
    state.tokens.goblin = { ...state.tokens.goblin!, actor: { inline: actor({ life: "dead" }) } };
    const offer = moveAfterRider(state, row(state, "i-horse"));
    assert.ok(offer);
    let seq = 10;
    for (const op of offer.ops) {
      const result = applyOp(state, opSchema.parse(op), DM, env(seq++));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
    }
    assert.equal(state.encounter!.round, 3);
    assert.equal(state.encounter!.activeEntryId, "i-horse");
    assert.equal(row(state, "i-horse").skipRound, 2);
    assert.equal(row(state, "i-horse").value, 15);
    assert.deepEqual(state.encounter!.entries.map((e) => e.id), ["i-bree", "i-horse", "i-gob"]);
  });

  test("on the mount's acting row, it takes its rider's value and goes right after the rider's row, as one gesture", () => {
    const state = fight();
    const offer = moveAfterRider(state, row(state, "i-horse"));
    assert.ok(offer);
    assert.equal(offer.riderName, "Bree");
    assert.deepEqual(offer.ops, [
      { t: "encounter.next", from: { entry: "i-horse", round: 2 } },
      { t: "encounter.setValue", entryId: "i-horse", value: 15 },
      { t: "encounter.reorder", entryIds: ["i-bree", "i-horse", "i-gob"], finished: { entryId: "i-horse", round: 2 } },
    ] satisfies ClientOp[]);
  });

  test("a mount already right after its rider with its value needs nothing, and one with the value but out of place only the order", () => {
    const placed = fight({ value: 15, tieOrder: 1 });
    assert.equal(moveAfterRider(placed, row(placed, "i-horse")), null);
    const tied = stable((s) => {
      s.encounter = {
        rev: 1,
        round: 2,
        activeEntryId: "i-horse",
        entries: [entry("i-horse", { tokenId: "horse", value: 15, tieOrder: 0 }), entry("i-bree", { tokenId: "bree", value: 15, tieOrder: 1 }), entry("i-gob", { tokenId: "goblin", value: 12 })],
      } as Encounter;
    });
    assert.deepEqual(moveAfterRider(tied, row(tied, "i-horse"))?.ops, [{ t: "encounter.next", from: { entry: "i-horse", round: 2 } }, { t: "encounter.reorder", entryIds: ["i-bree", "i-horse", "i-gob"], finished: { entryId: "i-horse", round: 2 } }]);
  });

  test("never on another row, a row not acting, a free ride, or a rider with no value", () => {
    const state = fight();
    assert.equal(moveAfterRider(state, row(state, "i-bree")), null);
    const waiting = fight({}, "i-gob");
    assert.equal(moveAfterRider(waiting, row(waiting, "i-horse")), null);
    const free = fight();
    free.tokens.bree = { ...free.tokens.bree!, attached: { to: "horse", kind: "ride" } };
    assert.equal(moveAfterRider(free, row(free, "i-horse")), null);
    const unrolled = fight();
    unrolled.encounter!.entries = unrolled.encounter!.entries.map((e) => (e.id === "i-bree" ? { ...e, value: null } : e));
    assert.equal(moveAfterRider(unrolled, row(unrolled, "i-horse")), null);
  });

  test("a rider listed by its character's row is found too", () => {
    const state = fight();
    state.encounter!.entries = state.encounter!.entries.map((e) => (e.id === "i-bree" ? entry("i-bree", { characterId: "bree", value: 15 }) : e));
    assert.equal(moveAfterRider(state, row(state, "i-horse"))?.riderName, "Bree");
  });
});

describe("the rider's Controlled or Independent", () => {
  test("whoever may attach the pair gets it, with the ride's control, and a change is a plain attach where the rider sits", () => {
    const state = stable((s) => (s.tokens.horse = { ...s.tokens.horse!, ownerIds: ["p1"] }));
    assert.deepEqual(steerChoice(state, dm, t(state, "bree")), { holderId: "horse", holderName: "Warhorse", riderName: "Bree", controlled: true });
    const mine = copyFor(state, P1);
    assert.equal(steerChoice(mine, p1, t(mine, "bree"))?.controlled, true);
    const theirs = copyFor(state, P2);
    assert.equal(steerChoice(theirs, p2, t(theirs, "bree")), null, "p2 may move neither");
    assert.equal(steerChoice(state, dm, t(state, "owl")), null, "a perch has no control");
    assert.deepEqual(steerOp(t(state, "bree"), "horse", false), { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 5, elevation: 0 });
    assert.deepEqual(steerOp(t(state, "bree"), "horse", true), { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 5, elevation: 0 });
    // The op is one the server takes from the player it is offered to.
    for (const controlled of [false, true]) {
      const op = steerOp(t(mine, "bree"), "horse", controlled);
      assert.equal(canApply(op, P1, state, { canUseAsset: () => true }).ok, true);
      const applied = applyOp(state, op as Op, P1, env(1));
      assert.ok(applied.ok, applied.ok ? "" : applied.message);
      assert.equal(applied.state.tokens.bree!.attached?.steer === true, controlled);
    }
  });

  test("a player loses it on the DM's horse, and in a fight off the rider's turn", () => {
    const state = stable();
    const view = copyFor(state, P1);
    assert.equal(steerChoice(view, p1, t(view, "bree")), null, "the warhorse is the DM's");
    const owned = stable((s) => {
      s.tokens.horse = { ...s.tokens.horse!, ownerIds: ["p1"] };
      s.encounter = { rev: 1, round: 1, activeEntryId: "i-gob", entries: [entry("i-bree", { tokenId: "bree", value: 15 }), entry("i-gob", { tokenId: "goblin", value: 12 })] } as Encounter;
    });
    const fighting = copyFor(owned, P1);
    assert.equal(steerChoice(fighting, p1, t(fighting, "bree")), null);
  });
});
