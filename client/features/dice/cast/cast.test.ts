import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { ASKS_WAITING } from "#shared/permissions.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { P1, castAsk, castTable, diceLine, damageRoll, token } from "#shared/testutil.ts";
import type { OnAnswer } from "../../../state/types.ts";
import { ReceiptTracker } from "../useReceipt.ts";
import type { PanelRoll } from "../useDicePanel.ts";
import {
  SELECT_TARGETS,
  areaAskSpec,
  askAgain,
  askFor,
  askInput,
  blockLevel,
  busySend,
  casterToken,
  closedText,
  fillLine,
  fillRolls,
  forgetSend,
  openedBlock,
  readCastDraft,
  rolledText,
  rollWords,
  selectionTargets,
  sendBlocked,
  sendWords,
  spellLevel,
  targetsLine,
  waitingCount,
  waitingLines,
  withdrawAsk,
  writeCastDraft,
  type CastEnv,
  type CastSends,
} from "./cast.ts";

/** A player's ask for saves, the block's rules and its sends (docs/design-v1-player-save-spell.md 3.1, 3.2 and 8). */

const fire: PanelRoll = { formula: "9d6", label: "Fireball damage, Fire", creature: { characterId: "thorn-c" } };
const radiant: PanelRoll = { formula: "2d8", label: "Fireball damage and Divine Smite, Radiant", creature: { characterId: "thorn-c" } };

describe("the block", () => {
  test("the caster is the creature's token on this scene, and goes when the token does", () => {
    const view = castTable();
    assert.equal(casterToken(view, { characterId: "thorn-c" }, "s1")?.id, "thorn");
    assert.equal(casterToken(view, { tokenId: "g1" }, "s1")?.id, "g1");
    assert.equal(casterToken(view, { characterId: "thorn-c" }, "s2"), undefined, "no token on another scene");
    assert.equal(casterToken(view, { characterId: "thorn-c" }, null), undefined, "behind a pause");
    delete view.tokens.thorn;
    assert.equal(casterToken(view, { characterId: "thorn-c" }, "s1"), undefined, "removed while the block is open");
  });

  test("a selection's targets are the tokens selected on the scene, less the caster, once each", () => {
    const view = castTable();
    view.tokens.far = token("far", { sceneId: "s2" });
    assert.deepEqual(selectionTargets(view, ["thorn", "g1", "far", "gone", "g1", "bree"], "thorn", "s1"), ["g1", "bree"]);
    assert.equal(targetsLine(["Goblin 1", "Bree"]), "Targets (2): Goblin 1, Bree");
    assert.equal(targetsLine([]), "Select the creatures it targets on the map.");
  });

  test("an area's ask opens on its caster when that is the player's, else the picked creature, else their first", () => {
    const view = castTable();
    view.characters["bree-c"]!.ownerIds = ["p1"];
    const creatures = [
      { tokenId: "bree", characterId: "bree-c" },
      { tokenId: "thorn", characterId: "thorn-c" },
    ];
    const area = view.templates.a1!;
    assert.deepEqual(areaAskSpec({ creatures, view, template: area, picked: "c:bree-c" }), { key: "c:thorn-c", creature: { characterId: "thorn-c" }, spell: "Fireball", area: "a1" });
    const uncast = { ...area, casterId: undefined };
    assert.equal(areaAskSpec({ creatures, view, template: uncast, picked: "c:thorn-c" })?.key, "c:thorn-c", "the panel's pick");
    assert.equal(areaAskSpec({ creatures, view, template: uncast, picked: null })?.key, "c:bree-c", "their first");
    assert.equal(areaAskSpec({ creatures: [], view, template: area, picked: null }), null, "none of theirs here");
    assert.equal(areaAskSpec({ creatures: [{ tokenId: "g1" }], view, template: { ...area, spell: undefined, label: "Stinking cloud" }, picked: null })?.spell, "Stinking cloud");
  });

  test("opening it pins the panel's pick to its creature", () => {
    const spec = { key: "c:thorn-c", creature: { characterId: "thorn-c" }, spell: "Hold Person", roll: "spells:hold-person" };
    assert.deepEqual(openedBlock(spec), { cast: spec, picked: "c:thorn-c" });
  });

  test("a leveled spell gets a level from its own to 9: the row's stepper where it has one, else the block's, as for Hold Person", () => {
    const holdPerson = spellLevel({ section: "spells", level: 2 }, "Hold Person");
    assert.deepEqual(blockLevel({ level: holdPerson, rowSlot: null, picked: 3 }), { min: 2, value: 3, own: true });
    assert.deepEqual(blockLevel({ level: holdPerson, rowSlot: null, picked: undefined }), { min: 2, value: 2, own: true });
    assert.deepEqual(blockLevel({ level: holdPerson, rowSlot: null, picked: 12 }), { min: 2, value: 9, own: true });
    assert.deepEqual(blockLevel({ level: 3, rowSlot: 4, picked: 7 }), { min: 3, value: 4, own: false }, "Fireball's row scales its damage");
    assert.equal(blockLevel({ level: spellLevel({ section: "spells", level: 0 }, "Sacred Flame"), rowSlot: null, picked: undefined }), null, "a cantrip");
    assert.equal(blockLevel({ level: spellLevel({ section: "actions" }, "Fire Breath"), rowSlot: null, picked: undefined }), null, "a save action");
    assert.equal(spellLevel(null, "Fireball"), 3, "an area's preset");
  });

  test("the first line is the player's own fill, with their DC or the DM's", () => {
    assert.equal(fillLine({ test: { kind: "save", ability: "dex" }, dc: 15 }, "Fireball", 4), "Dexterity save, DC 15, against Fireball at level 4");
    assert.equal(fillLine({ test: { kind: "save", ability: "wis" }, dc: null }, "Hold Person", 2), "Wisdom save against Hold Person at level 2. The DM sets the DC.");
    assert.equal(fillLine({ test: { kind: "none" }, dc: null }, "Magic Missile", undefined), "No save, against Magic Missile");
    assert.equal(fillLine(null, "Stinking cloud", undefined), "Against Stinking cloud. The DM sets the save and the DC.");
  });

  test("the buttons say what they roll", () => {
    assert.deepEqual(sendWords({ rolls: [fire], save: true }), { first: "Roll 9d6 Fire and ask", dmRolls: "Ask, the DM rolls" });
    assert.equal(rollWords([fire, radiant]), "9d6 Fire + 2d8 Radiant");
    assert.deepEqual(sendWords({ rolls: [], save: true }), { first: "Ask the DM", dmRolls: null }, "Hold Person");
    assert.deepEqual(sendWords({ rolls: [], save: false }), { first: "Ask the DM to apply", dmRolls: null }, "a preset with no save");
    assert.deepEqual(fillRolls("Ice Storm", "2d10 Bludgeoning + 4d6 Cold + 3", { tokenId: "g1" }).map((r) => [r.formula, r.label]), [
      ["2d10", "Ice Storm damage, Bludgeoning"],
      ["4d6", "Ice Storm damage, Cold"],
    ]);
  });

  test("is disabled with its reason: no connection, no caster token, no target, three asks waiting", () => {
    const caster = castTable().tokens.thorn!;
    const base = { blocked: null, casterName: "Thorn", caster, targets: 2, waiting: 0 };
    assert.equal(sendBlocked(base), null);
    assert.equal(sendBlocked({ ...base, blocked: "Rolling needs a connection." }), "Rolling needs a connection.");
    assert.equal(sendBlocked({ ...base, caster: undefined }), "Thorn is not on this scene.");
    assert.equal(sendBlocked({ ...base, targets: 0 }), SELECT_TARGETS);
    assert.equal(sendBlocked({ ...base, targets: null }), null, "an area asks whoever it catches");
    assert.equal(sendBlocked({ ...base, waiting: 3 }), ASKS_WAITING);
  });

  test("the cap counts the asks whose caster exists and the player owns now, as the server counts them", () => {
    const view = castTable({ casts: { k1: castAsk("k1"), k2: castAsk("k2", { caster: "gone" }), k3: castAsk("k3", { by: "p2" }) } });
    assert.equal(waitingCount(view, P1), 1);
  });

  test("its ask names the area, or the targets and the row's roll, with the spell's name cut to fit", () => {
    assert.deepEqual(askInput({ caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 4, area: "a1", targets: ["g1"], roll: "spells:fireball" }), { caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 4, area: "a1" });
    assert.deepEqual(askInput({ caster: "thorn", sceneId: "s1", spell: "Hold Person", targets: ["g1", "bree"], roll: "spells:hold-person" }), { caster: "thorn", sceneId: "s1", spell: "Hold Person", targets: ["g1", "bree"], roll: "spells:hold-person" });
    assert.ok(askInput({ caster: "thorn", sceneId: "s1", spell: "A very long name ".repeat(6), targets: ["g1"] }).spell.length <= 60);
  });

  test("a roll's words read by type, and a toast for each DM's end", () => {
    const lines = [diceLine("40:0", "dmg", [damageRoll({ total: 31 }), damageRoll({ total: 9, label: "Fireball damage, Radiant" })])];
    assert.equal(rolledText(lines), "Rolled 31 Fire + 9 Radiant");
    assert.equal(rolledText([]), null);
    assert.equal(closedText({ spell: "Fireball", end: "done" }), "The DM resolved Fireball.");
    assert.equal(closedText({ spell: "Fireball", end: "dismissed" }), "The DM set Fireball aside.");
    assert.equal(closedText({ spell: "Fireball", end: "withdrawn" }), null, "a withdrawal is the player's own");
    assert.equal(closedText({ spell: "Fireball" }), null, "the ask's own line");
  });
});

/** A fake page: what it sent, in order, and the answers it can give. */
function page(view: RoomState = castTable()) {
  const sent: { op: ClientOp; onAnswer: OnAnswer }[] = [];
  const rolled: PanelRoll[][] = [];
  const toasts: string[] = [];
  const saved: unknown[][] = [];
  const tracker = new ReceiptTracker();
  tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => [] };
  let ids = 0;
  let connected = true;
  let parts = 1;
  const holder = { view };
  const env: CastEnv = {
    store: createStore<CastSends>(() => ({ sends: {}, withdrawing: {} })),
    tracker,
    connected: () => connected,
    dispatch: (op, opts) => (connected ? sent.push({ op, onAnswer: opts.onAnswer }) : null),
    rollDamage: (rolls) => {
      if (!connected) return null;
      rolled.push(rolls);
      sent.push({ op: { t: "dice.roll", tag: `roll-${rolled.length}`, to: "all", rolls: rolls.map((r) => ({ formula: r.formula })) }, onAnswer: () => undefined });
      return { tag: `roll-${rolled.length}`, parts };
    },
    newId: () => `ask-${++ids}`,
    view: () => holder.view,
    save: (sends) => saved.push([...sends]),
    notify: (text) => toasts.push(text),
  };
  return {
    env,
    sent,
    rolled,
    toasts,
    saved,
    holder,
    offline: () => (connected = false),
    batches: (n: number) => (parts = n),
  };
}

const input = (overrides: Partial<Parameters<typeof askFor>[1]> = {}) => ({ key: "c:thorn-c", spell: "Fireball", area: "a1", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" }, rolls: [fire], ...overrides });

describe("the send", () => {
  test("rolls the damage first, then asks naming that roll and its batches, on the same socket and in that order", () => {
    const p = page();
    p.batches(2);
    const id = askFor(p.env, input());
    assert.equal(id, "ask-1");
    assert.deepEqual(
      p.sent.map((s) => s.op.t),
      ["dice.roll", "cast.ask"],
    );
    assert.deepEqual(p.sent[1]!.op, { t: "cast.ask", cast: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1", id: "ask-1", damage: { tag: "roll-1", parts: 2 } } });
  });

  test("Ask, the DM rolls and Hold Person send the ask alone", () => {
    const p = page();
    askFor(p.env, input({ rolls: null }));
    assert.deepEqual(
      p.sent.map((s) => s.op.t),
      ["cast.ask"],
    );
    assert.equal("damage" in (p.sent[0]!.op as { cast: object }).cast, false);
  });

  test("a second tap while it waits asks nothing, and nothing goes offline", () => {
    const p = page();
    askFor(p.env, input());
    assert.equal(askFor(p.env, input()), null);
    assert.equal(p.sent.length, 2);
    assert.ok(busySend(p.env, "c:thorn-c", "Fireball"));
    const q = page();
    q.offline();
    assert.equal(askFor(q.env, input()), null);
    assert.deepEqual(q.sent, []);
  });

  test("taken, it toasts and leaves the draft, and waits in the view", () => {
    const p = page();
    askFor(p.env, input());
    p.holder.view = castTable({ casts: { "ask-1": castAsk("ask-1") } });
    p.sent[1]!.onAnswer("taken");
    assert.deepEqual(p.toasts, ["Asked the DM for saves against Fireball."]);
    assert.deepEqual(p.saved.at(-1), []);
    assert.deepEqual(waitingLines(p.holder.view, p.env.store.getState().sends, (id) => p.env.tracker.state(id)), [{ id: "ask-1", spell: "Fireball", caster: "thorn", asked: true }]);
  });

  test("refused after its roll committed, Ask again names the same roll and never rolls it again", () => {
    const p = page();
    askFor(p.env, input());
    p.sent[1]!.onAnswer("refused", { code: "quota", message: ASKS_WAITING, text: ASKS_WAITING });
    assert.deepEqual(p.saved.at(-1)?.map((s) => (s as { id: string }).id), ["ask-1"], "kept for a reload");
    const again = askAgain(p.env, "ask-1");
    assert.equal(again, "ask-2");
    assert.equal(p.rolled.length, 1, "rolled once");
    assert.deepEqual((p.sent.at(-1)!.op as { cast: { damage?: unknown } }).cast.damage, { tag: "roll-1", parts: 1 });
    assert.equal(p.env.store.getState().sends["ask-1"], undefined, "the refused send gives way to the new one");
  });

  test("an unknown never sends again on its own, and only Ask again sends", () => {
    const p = page();
    askFor(p.env, input({ rolls: null }));
    p.sent[0]!.onAnswer("unknown", undefined, "expired");
    assert.equal(p.sent.length, 1);
    assert.equal(askAgain(p.env, "missing"), null);
  });

  test("a roll that went without its ask is kept as refused, so Ask again names it", () => {
    const p = page();
    p.env.dispatch = () => null;
    const id = askFor(p.env, input());
    assert.equal(id, "ask-1");
    assert.equal(p.env.tracker.state("ask-1")?.state, "refused");
    const q = page();
    q.env.dispatch = () => null;
    assert.equal(askFor(q.env, input({ rolls: null })), null, "with no roll, nothing is kept");
    assert.deepEqual(q.env.store.getState().sends, {});
  });

  test("Close forgets a settled send, and Withdraw closes the ask, busy until its answer", () => {
    const p = page();
    askFor(p.env, input({ rolls: null }));
    p.sent[0]!.onAnswer("refused", { code: "gone", message: "that is not here", text: "that is not here" });
    forgetSend(p.env, "ask-1");
    assert.deepEqual(p.env.store.getState().sends, {});
    withdrawAsk(p.env, "k1");
    assert.equal(withdrawAsk(p.env, "k1"), null, "one Withdraw at a time");
    assert.deepEqual(p.sent.at(-1)!.op, { t: "cast.close", castId: "k1", end: "withdrawn" });
    assert.equal(p.env.store.getState().withdrawing.k1, true);
    p.sent.at(-1)!.onAnswer("refused", { code: "gone", message: "The ask was closed meanwhile.", text: "The ask was closed meanwhile." });
    assert.equal(p.env.store.getState().withdrawing.k1, undefined);
    assert.deepEqual(p.toasts, ["The ask was closed meanwhile."]);
  });

  test("the session draft keeps unsettled sends for a reload, and reads nothing from a bad one", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const send = { id: "ask-1", key: "c:thorn-c", spell: "Fireball", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" }, damage: { tag: "roll-1", parts: 1 } };
    writeCastDraft("R1", [send], storage);
    assert.deepEqual(readCastDraft("R1", storage), [send]);
    writeCastDraft("R1", [], storage);
    assert.equal(store.size, 0);
    store.set("rvtt.castAsk.R1", "{not json");
    assert.deepEqual(readCastDraft("R1", storage), []);
    assert.deepEqual(readCastDraft("R1", { getItem: () => { throw new Error("blocked"); } }), []);
  });
});
