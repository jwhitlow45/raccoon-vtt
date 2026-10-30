import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, character, room, token } from "#shared/testutil.ts";
import { optionSlot } from "./optionState.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";

/*
 * What the Dice panel's rows send through useRollOption
 * (docs/design-v1-combat-controls.md 2.3 and 6): a death save and a
 * Recharge 1d6 that settle an open prompt with its record, and whether a
 * roll went secret, which the recharge it spends follows.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useRollOption } = await import("./useRollOption.ts");

type Api = ReturnType<typeof useRollOption>;

/** The hook's sends, captured from one render: its functions read the room's store and scope when called, not when drawn. */
function probe(): { api: Api; sent: ClientOp[]; scope: InstanceType<typeof RoomScope>; view: ReturnType<typeof room> } {
  const view = room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    tokens: { drag: token("drag", { kind: "monster", name: "Dragon" }), bt: token("bt", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }) },
  });
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["drag"], multi: false } }));
  const sent: ClientOp[] = [];
  const scope = new RoomScope();
  let api: Api | null = null;
  function Probe() {
    api = useRollOption();
    return null;
  }
  renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: (op: ClientOp) => sent.push(op), newId: () => "x" } as never,
      ui: {} as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(Probe) }),
    }),
  );
  assert.ok(api);
  return { api, sent, scope, view };
}

const NONE = { sources: [], extra: [], notes: [] };

describe("the rows' rolls that settle an open prompt", () => {
  test("a death save carries the record it settles, and none outside an open prompt", () => {
    const { api, sent } = probe();
    api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag", 12);
    api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag");
    const [settles, manual] = sent;
    assert.equal(settles?.t === "actor.deathRoll" && settles.record, 12);
    assert.equal(manual?.t, "actor.deathRoll");
    assert.ok(manual && !("record" in manual), "a manual roll names no record");
  });

  test("Recharge 1d6 is the server's roll of the ability, kept on its row, settling an open prompt with its record", () => {
    const { api, sent, scope } = probe();
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ adv: true });
    const row = "t:drag|actions:fire-breath|recharge";
    const tag = api.recharge({ tokenId: "drag" }, { key: "actions:fire-breath", name: "Fire Breath", min: 5 }, row, 7);
    assert.ok(tag);
    assert.deepEqual(sent[0], { t: "actor.rechargeRoll", tag, target: { tokenId: "drag" }, key: "actions:fire-breath", name: "Fire Breath", min: 5, record: 7 });
    assert.equal(scope.get(optionSlot).getState().tags[row], tag, "the row and the combat uses' Roll recharge both read it");
    assert.deepEqual(choices.getState().last, { tag, once: true, label: "Fire Breath recharge" }, "the header line names it");
    assert.equal(choices.getState().adv, true, "no d20, so the panel's choices stay for the next roll");
    api.recharge({ tokenId: "drag" }, { key: "actions:fire-breath", name: "Fire Breath", min: 5 }, row);
    assert.ok(sent[1] && !("record" in sent[1]), "outside an open prompt the roll stays manual");
  });
});

describe("whether a panel roll went secret", () => {
  test("a DM's roll for a monster goes to the DM, one for a player's creature in the open, and another tag is not this roll", () => {
    const { api } = probe();
    const monster = api.rolls([{ formula: "7d6", label: "Fire Breath damage, Fire", creature: { tokenId: "drag" } }], "t:drag|actions:fire-breath|damage");
    assert.ok(monster);
    assert.equal(api.wentSecret(monster), true);
    assert.equal(api.wentSecret("another-tag"), false, "a tag the newest roll is not");
    const pc = api.rolls([{ formula: "1d8", label: "Rapier damage, Piercing", creature: { tokenId: "bt" } }], "c:bree|r1|damage");
    assert.ok(pc);
    assert.equal(api.wentSecret(pc), false);
    assert.equal(api.wentSecret(monster), false, "it is asked right after its own tap: a later roll replaces what the panel knows");
  });
});

test("one-off death saves preserve panel presses, resolve opposing sources once and keep the turn record", () => {
  const { api, sent, scope } = probe();
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ adv: true, secret: true, version: 9 });
  api.deathSave({ tokenId: "drag" }, { ...NONE, sources: [{ kind: "dis", from: "restrained" }] }, "deathSave:drag", 12, "adv");
  assert.equal(sent[0]?.t === "actor.deathRoll" && sent[0].record, 12);
  assert.equal(sent[0]?.t === "actor.deathRoll" && sent[0].cancelled, true);
  assert.equal(sent[0]?.t === "actor.deathRoll" && sent[0].mode, undefined);
  assert.equal(choices.getState().adv, true); assert.equal(choices.getState().version, 9);
  api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag", 12, "secret");
  assert.equal(sent.length, 1, "fixed death-save route refuses a secret override");
});
test("request answers retain route, typed bonus, unanswered guard and extra dice without consuming choices", () => {
  const { api, sent, scope, view } = probe();
  view.rolls.q1 = { id: "q1", rev: 0, at: "2026-10-30T12:00:00Z", test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: false, resultShown: false, targets: [{ tokenId: "drag" }] };
  const choices = scope.get(diceChoicesSlot); choices.setState({ dis: true, version: 13 });
  const input = { creature: { tokenId: "drag" }, test: { kind: "save" as const, ability: "dex" as const }, bonus: 4, typed: true, preset: { ...NONE, extra: ["+1d4"] }, label: "Dexterity save", row: "drag:dex", played: false, ask: false, override: "adv" as const };
  api.d20(input);
  const op = sent[0]; assert.equal(op?.t, "roll.dice");
  if (op?.t === "roll.dice") { assert.equal(op.rollId, "q1"); assert.equal(op.mode, "adv"); assert.equal(op.bonus, 4); assert.equal(op.extra, "1d4"); assert.equal(op.unanswered, true); assert.ok(!("to" in op)); }
  assert.equal(choices.getState().dis, true); assert.equal(choices.getState().version, 13);
  api.d20({ ...input, override: "secret" }); assert.equal(sent.length, 1);
});

test("free d20 and plain-roll overrides reach the panel without taking its choices", () => {
  const { api, sent, scope } = probe();
  const choices = scope.get(diceChoicesSlot); choices.setState({ adv: true, secret: false, secretFor: "drag", version: 17 });
  api.d20({ creature: { tokenId: "drag" }, test: { kind: "attack" }, bonus: 4, preset: { ...NONE, sources: [{ kind: "dis", from: "poisoned" }], extra: ["+1d4"] }, label: "Claw", row: "drag:claw", played: false, ask: false, override: "normal" });
  assert.equal(sent[0]?.t === "dice.roll" && sent[0].to, "dm");
  assert.equal(sent[0]?.t === "dice.roll" && sent[0].rolls[0]?.mode, "dis");
  assert.equal(sent[0]?.t === "dice.roll" && sent[0].rolls[0]?.formula, "1d20+4+1d4");
  api.rolls([{ formula: "1d6" }], "plain", "secret");
  assert.equal(sent[1]?.t === "dice.roll" && sent[1].to, "dm");
  assert.equal(choices.getState().adv, true); assert.equal(choices.getState().version, 17);
});
