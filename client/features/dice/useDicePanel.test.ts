import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ClientOp } from "#shared/protocol.ts";
import { createDicePanel, type DiceState } from "./useDicePanel.ts";
import type { RollSender } from "./send.ts";
import { ReceiptTracker } from "./useReceipt.ts";

function setup() {
  const store = createStore<DiceState>(() => ({ adv: true, dis: false, secret: false, version: 7, last: null }));
  const sent: ClientOp[] = []; const callbacks: (() => void)[] = []; const origins: unknown[] = [];
  const receipts = new ReceiptTracker();
  const sender: RollSender = { connected: () => true, receipts, dispatch(op, opts) { sent.push(op); callbacks.push(() => opts?.onAnswer?.("refused", undefined)); return sent.length; } };
  const panel = createDicePanel({ store, sender, secretStart: () => true, registerThrow: (tag, origin) => origins.push({ tag, origin }) });
  return { store, sent, callbacks, origins, panel, receipts };
}
test("menu overrides preserve choices and versions through sends, refusal, receipts and batches", () => {
  const { store, sent, callbacks, origins, panel, receipts } = setup();
  const origin = { surface: "dice" as const, element: null, tapAt: 25 };
  let parts = 0;
  const tag = panel.roll(Array.from({ length: 120 }, () => ({ formula: "1d20+1d4", sources: [{ kind: "dis" as const, from: "restrained" }] })), { override: "adv", origin, parts: (n) => { parts = n; } });
  assert.ok(tag); assert.ok(parts > 1); assert.equal(sent.length, parts);
  for (const op of sent) { assert.equal(op.t, "dice.roll"); if (op.t === "dice.roll") { assert.equal(op.tag, tag); assert.equal(op.to, "all"); for (const roll of op.rolls) { assert.equal(roll.mode, undefined); assert.equal(roll.cancelled, true); } } }
  assert.deepEqual(origins, [{ tag, origin }]);
  assert.equal(receipts.state(tag)?.state, "sending");
  assert.ok(store.getState().last && "rolls" in store.getState().last!);
  for (const refuse of callbacks) refuse();
  assert.deepEqual({ ...store.getState(), last: null }, { adv: true, dis: false, secret: false, version: 7, last: null });
});
test("Normal retains default monster secrecy, removes typed/manual modes, and never rebuilds damage modes", () => {
  const { store, sent, panel } = setup();
  panel.roll([{ formula: "1d20+4", sources: [{ kind: "adv", from: "typed" }, { kind: "dis", from: "poisoned" }] }], { override: "normal" });
  assert.equal(sent[0]?.t === "dice.roll" && sent[0].to, "dm");
  assert.deepEqual(sent[0]?.t === "dice.roll" && sent[0].rolls[0], { formula: "1d20+4", mode: "dis" });
  panel.roll([{ formula: "1d20+2", modeEligible: false }], { override: "secret" });
  assert.deepEqual(sent[1]?.t === "dice.roll" && sent[1].rolls[0], { formula: "1d20+2" });
  assert.equal(store.getState().version, 7);
  panel.roll([{ formula: "1d20" }]); assert.equal(store.getState().adv, false, "ordinary rolls still consume choices");
});

test("Secret retains invalid formula-word modes instead of silently dropping them", () => {
  const { panel, sent, store } = setup();
  assert.equal(panel.roll([{ formula: "1d6", sources: [{ kind: "adv", from: "typed" }] }], { override: "secret" }), null);
  assert.equal(sent.length, 0);
  assert.equal(store.getState().version, 7);
  assert.ok(panel.roll([{ formula: "1d6", sources: [{ kind: "adv", from: "typed" }] }], { override: "normal" }));
});
