import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, character, room, token } from "#shared/testutil.ts";
import { projectState } from "#shared/project.ts";
import type { RoomState } from "#shared/model.ts";
import { optionSlot } from "./optionState.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";
import { throwHooksSlot } from "./throw/hooks.ts";
import type { ThrowOrigin } from "./throw/store.ts";

/*
 * What the Dice panel's rows send through useRollOption
 * (docs/design/design-v1-combat-controls.md 2.3 and 6): a death save and a
 * Recharge 1d6 that settle an open prompt with its record, and whether a
 * roll went secret, which the recharge it spends follows.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { useRollOption, useRowResult } = await import("./useRollOption.ts");
const { PanelHere } = await import("../panels.ts");

type Api = ReturnType<typeof useRollOption>;

/** The hook's sends, captured from one render: its functions read the room's store and scope when called, not when drawn. */
function probe(connection = "open", pending: readonly { n: number; op: ClientOp; at: number }[] = []): { api: Api; sent: ClientOp[]; scope: InstanceType<typeof RoomScope>; view: ReturnType<typeof room> } {
  const view = room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    tokens: { drag: token("drag", { kind: "monster", name: "Dragon" }), bt: token("bt", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }) },
  });
  const store = createStore(() => ({ view, confirmed: { ...view, encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] } }, pending, roomId: "r1", connection, you: DM, sceneId: "s1", local: { selectedIds: ["drag"], multi: false } }));
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

describe("while a turn change waits for its answer, a roll that would settle the turn's prompt sends nothing", () => {
  test("a death save and a recharge given \"pending\" send no op and keep no tag", () => {
    const { api, sent, scope } = probe();
    assert.equal(api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag", "pending"), null);
    const row = "t:drag|actions:fire-breath|recharge";
    assert.equal(api.recharge({ tokenId: "drag" }, { key: "actions:fire-breath", name: "Fire Breath", min: 5 }, row, "pending"), null);
    assert.deepEqual(sent, []);
    assert.equal(scope.get(optionSlot).getState().tags[row], undefined);
  });

  test("whatever record the surface read, nothing goes while the store holds a turn change", () => {
    const { api, sent } = probe("open", [{ n: 1, op: { t: "encounter.next" }, at: 0 }]);
    assert.equal(api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag", 12), null);
    assert.equal(api.deathSave({ tokenId: "drag" }, NONE, "deathSave:drag"), null);
    assert.equal(api.recharge({ tokenId: "drag" }, { key: "actions:fire-breath", name: "Fire Breath", min: 5 }, "t:drag|actions:fire-breath|recharge", 7), null);
    assert.deepEqual(sent, []);
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

describe("a stat block's d20, which takes no panel choices (docs/design/design-v1-stat-block-rolls.md 7)", () => {
  const request = { id: "q1", rev: 0, at: "2026-10-30T12:00:00Z", test: { kind: "save" as const, choices: [{ ability: "dex" as const }] }, dcShown: false, resultShown: false, targets: [{ tokenId: "drag" }] };
  const input = { creature: { tokenId: "drag" }, test: { kind: "save" as const, ability: "dex" as const }, bonus: 4, preset: { ...NONE, sources: [{ kind: "dis" as const, from: "restrained" }] }, label: "Dexterity save", row: "t:drag|save", played: false, ask: false, choices: "none" as const };

  test("an answer sends only the preset's sources and the pick's, and the panel's Adv and Secret stand", () => {
    const { api, sent, scope, view } = probe();
    view.rolls.q1 = request;
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ adv: true, secret: true, version: 31 });
    assert.ok(api.d20(input));
    assert.equal(sent[0]?.t === "roll.dice" && sent[0].mode, "dis", "Restrained alone: the Adv pressed in the panel never reaches it");
    assert.equal(sent[0]?.t === "roll.dice" && sent[0].cancelled, undefined);
    assert.ok(api.d20({ ...input, override: "adv" }));
    assert.equal(sent[1]?.t === "roll.dice" && sent[1].cancelled, true, "the pick meets Restrained");
    assert.deepEqual([choices.getState().adv, choices.getState().secret, choices.getState().version], [true, true, 31]);
    assert.deepEqual(choices.getState().last, { tag: (sent[1] as { tag: string }).tag, once: true, label: "Dexterity save" }, "the answer is the newest line, with no Again");
  });

  test("a free roll goes under its own start with the panel's choices untouched", () => {
    const { api, sent, scope } = probe();
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ adv: true, secret: false, secretFor: "drag", version: 41 });
    assert.ok(api.d20(input));
    assert.equal(sent[0]?.t === "dice.roll" && sent[0].to, "dm", "a DM's monster roll is secret, whatever was pressed off for it");
    assert.equal(sent[0]?.t === "dice.roll" && sent[0].rolls[0]?.mode, "dis");
    assert.equal(choices.getState().version, 41);
  });

  test("an answer or a roll that does not go tells the caller why, once, and the newest line stays", () => {
    for (const answer of [true, false]) {
      const { api, sent, scope, view } = probe("closed");
      if (answer) view.rolls.q1 = request;
      const choices = scope.get(diceChoicesSlot);
      choices.setState({ last: { tag: "older", once: true, label: "Strength check" } });
      const heard: string[] = [];
      assert.equal(api.d20({ ...input, onFail: (w) => heard.push(w) }), null);
      assert.deepEqual(heard, ["Rolling needs a connection."], answer ? "the answer route" : "the free route");
      assert.equal(sent.length, 0);
      assert.deepEqual(choices.getState().last, { tag: "older", once: true, label: "Strength check" });
    }
  });

  test("its origin, the block's host and box, goes with the free roll and with an answer, so the dice leave the box (docs/design/design-v1-token-roll-header.md 4.1)", () => {
    const box = { name: "DEX box" } as unknown as Element;
    const origin: ThrowOrigin = { surface: "block", host: 7, element: box, tapAt: 120 };
    for (const answer of [false, true]) {
      const { api, scope, view } = probe();
      if (answer) view.rolls.q1 = request;
      const registered: [string, ThrowOrigin][] = [];
      scope.get(throwHooksSlot).current = { register: (tag, o) => registered.push([tag, o]), origin: () => ({ surface: "dice", element: null, tapAt: 0 }) };
      const tag = api.d20({ ...input, origin });
      assert.ok(typeof tag === "string" && tag !== "asked");
      assert.deepEqual(registered, [[tag, origin]], answer ? "the answer, through noted" : "the free roll, through roll");
    }
  });

  test("without one, a surface that is not the Dice panel throws nothing", () => {
    const { api, scope } = probe();
    const registered: string[] = [];
    scope.get(throwHooksSlot).current = { register: (tag) => registered.push(tag), origin: () => ({ surface: "dice", element: null, tapAt: 0 }) };
    assert.ok(api.d20(input));
    assert.deepEqual(registered, []);
  });

  test("a null for anything else is no failure: a creature gone, a missing bonus", () => {
    const { api } = probe();
    const heard: string[] = [];
    assert.equal(api.d20({ ...input, creature: { tokenId: "gone" }, onFail: (w) => heard.push(w) }), null);
    assert.equal(api.d20({ ...input, bonus: null, onFail: (w) => heard.push(w) }), null);
    assert.deepEqual(heard, []);
  });
});

test("a row in a hidden pane reads no tag, so it watches no receipt and leaves the roll's toast alone", () => {
  const read = (shown: boolean) => {
    const scope = new RoomScope();
    scope.get(optionSlot).setState({ tags: { row: "T1" } });
    const options = scope.get(optionSlot);
    options.getInitialState = options.getState;
    const view = projectState(room(), DM, { sceneId: "s1" }) as unknown as RoomState;
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
    let seen: string | null | undefined;
    function Probe() {
      seen = useRowResult("row").tag;
      return null;
    }
    renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1 } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: createElement(PanelHere, { id: "dice", shown, children: createElement(Probe) }) as never }),
      }),
    );
    return seen;
  };
  assert.equal(read(true), "T1");
  assert.equal(read(false), null);
});
