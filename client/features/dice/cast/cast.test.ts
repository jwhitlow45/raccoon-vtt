import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { blockActions } from "#shared/dice/named.ts";
import type { RoomState } from "#shared/model.ts";
import { ASKS_WAITING, canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { monsterView, statBlockOf } from "#shared/statBlock.ts";
import { P1, castAsk, castTable, customMonster, diceLine, damageRoll, token } from "#shared/testutil.ts";
import type { OnAnswer } from "../../../state/types.ts";
import type { CastBlock } from "../optionState.ts";
import { ReceiptTracker } from "../useReceipt.ts";
import type { PanelRoll } from "../useDicePanel.ts";
import {
  SELECT_TARGETS,
  TOO_MANY_TARGETS,
  areaAskSpec,
  askAgain,
  askFor,
  askInput,
  blockDone,
  blockLevel,
  busySend,
  casterToken,
  closedText,
  fillLine,
  fillRolls,
  followSend,
  forgetSend,
  openedBlock,
  pendingSend,
  phaseOf,
  readCastDraft,
  restoreSends,
  retryFromList,
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
  type CastSend,
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
    assert.equal(targetsLine(["Goblin 1", "Bree"]), "Targets (2): Bree, Goblin 1");
    assert.equal(targetsLine(["Mook 32", "Mook 1", "Mook 10"]), "Targets (3): Mook 1, Mook 10, Mook 32", "a box drag's order, read by name and number (LP10-SAVE-3)");
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
    assert.deepEqual(areaAskSpec({ creatures, view, me: "p1", template: area, picked: "c:bree-c" }), { key: "c:thorn-c", creature: { characterId: "thorn-c" }, spell: "Fireball", area: "a1" });
    const uncast = { ...area, casterId: undefined };
    assert.equal(areaAskSpec({ creatures, view, me: "p1", template: uncast, picked: "c:thorn-c" })?.key, "c:thorn-c", "the panel's pick");
    assert.equal(areaAskSpec({ creatures, view, me: "p1", template: uncast, picked: null })?.key, "c:bree-c", "their first");
    assert.equal(areaAskSpec({ creatures: [], view, me: "p1", template: area, picked: null }), null, "none of theirs here");
    assert.equal(areaAskSpec({ creatures: [{ tokenId: "g1" }], view, me: "p1", template: { ...area, spell: undefined, label: "Stinking cloud" }, picked: null })?.spell, "Stinking cloud");
  });

  test("a lent token whose character the player does not play asks and rolls by its token, which the server takes (SSB-A-04)", () => {
    const view = castTable();
    view.tokens.lent = token("lent", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree-c" }, x: 7, y: 4 });
    const area = { ...view.templates.a1!, casterId: "lent" };
    const spec = areaAskSpec({ creatures: [{ tokenId: "lent", characterId: "bree-c" }], view, me: "p1", template: area, picked: null })!;
    assert.deepEqual(spec.creature, { tokenId: "lent" });
    assert.equal(spec.key, "c:bree-c", "keyed as playerCreatures keys it");
    const roll = (creature: { tokenId: string } | { characterId: string }): ClientOp => ({ t: "dice.roll", tag: "r1", to: "all", rolls: [{ formula: "8d6", label: "Fireball damage, Fire", creature }] });
    assert.deepEqual(canApply(roll(spec.creature as { tokenId: string }), P1, view, { canUseAsset: () => true }), { ok: true });
    assert.equal(canApply(roll({ characterId: "bree-c" }), P1, view, { canUseAsset: () => true }).ok, false, "by the character it would be refused");
  });

  test("opening it pins the panel's pick to its creature, and takes back a send of its own that has not settled well", () => {
    const spec = { key: "c:thorn-c", creature: { characterId: "thorn-c" }, spell: "Hold Person", roll: "spells:hold-person" };
    assert.deepEqual(openedBlock({ openings: 0 }, spec), { cast: { ...spec, opened: 1 }, picked: "c:thorn-c", openings: 1 });
    assert.deepEqual(openedBlock({ openings: 4 }, { ...spec, sent: "old", opened: 2 }), { cast: { ...spec, opened: 5 }, picked: "c:thorn-c", openings: 5 }, "a fresh block drops a stale send and its old stamp");
    assert.deepEqual(openedBlock({ openings: 1 }, spec, "ask-1"), { cast: { ...spec, opened: 2, sent: "ask-1" }, picked: "c:thorn-c", openings: 2 });
    const send = (id: string, over: Record<string, unknown>) => ({ id, key: "c:thorn-c", spell: "Fireball", ask: { caster: "thorn", sceneId: "s1", spell: "Fireball", area: "a1" }, area: "a1", ...over });
    const sends = { r: send("r", {}), x: send("x", { area: "a2" }), t: send("t", { area: undefined, roll: "spells:hold-person", spell: "Hold Person" }) };
    const refused = { state: "refused" as const, code: "quota" as const, message: ASKS_WAITING, text: ASKS_WAITING, parts: [] };
    const state = (id: string) => (id === "r" || id === "t" ? (refused as never) : null);
    const area = { key: "c:thorn-c", spell: "Fireball", area: "a1" };
    assert.equal(pendingSend({ spec: area, sends, casts: {}, state })?.id, "r", "the same area's refused send");
    assert.equal(pendingSend({ spec: { ...area, area: "a2" }, sends, casts: {}, state })?.id, "x", "one still on its way");
    assert.equal(pendingSend({ spec: area, sends, casts: { r: {} }, state }), undefined, "one asked is the waiting line's");
    assert.equal(pendingSend({ spec, sends, casts: {}, state })?.id, "t", "the same row's");
    assert.equal(pendingSend({ spec: { ...spec, key: "c:bree-c" }, sends, casts: {}, state }), undefined, "another creature's");
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
    assert.deepEqual(fillRolls("Ice Storm", "2d10 Bludgeoning + 4d6 Cold + 3", { tokenId: "g1" }).map((r) => [r.formula, r.label, r.type]), [
      ["2d10", "Ice Storm damage, Bludgeoning", "bludgeoning"],
      ["4d6", "Ice Storm damage, Cold", "cold"],
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

  test("a selection past 50 targets is refused before anything rolls, and none is cut unseen (SSB-A-01)", () => {
    const caster = castTable().tokens.thorn!;
    const base = { blocked: null, casterName: "Thorn", caster, waiting: 0 };
    assert.equal(sendBlocked({ ...base, targets: 50 }), null);
    assert.equal(sendBlocked({ ...base, targets: 51 }), TOO_MANY_TARGETS);
    assert.equal(TOO_MANY_TARGETS, "An ask names at most 50 targets. Select fewer.");
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    assert.equal(askInput({ caster: "thorn", sceneId: "s1", spell: "Hold Person", targets: ids }).targets?.length, 51, "askInput sends what it is given");
  });

  test("the cap counts the player's own asks in their projected view, as the server counts them, after a scene change too (SSB-A-03)", () => {
    const state = castTable({ casts: { k1: castAsk("k1"), k2: castAsk("k2", { caster: "gone" }), k3: castAsk("k3", { by: "p2" }), k4: castAsk("k4", { area: undefined, targets: ["g1"] }) } });
    state.characters["thorn-c"]!.ownerIds = ["p1", "p2"];
    const view = projectState(state, P1, { sceneId: "s1" }) as RoomState;
    assert.equal(waitingCount(view, P1), 2, "k1 and k4: k2's caster is gone, and k3 is p2's");
    // The DM moves the players to s2: Thorn's token leaves their view, the server still counts the asks, and so does the block.
    state.meta.playerSceneId = "s2";
    const away = projectState(state, P1, { sceneId: "s2" }) as RoomState;
    assert.equal(away.tokens.thorn, undefined);
    assert.equal(waitingCount(away, P1), 2);
  });

  test("its ask names the area, or the targets and the row's roll, with the spell's name cut to fit", () => {
    assert.deepEqual(askInput({ caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 4, area: "a1", targets: ["g1"], roll: "spells:fireball" }), { caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 4, area: "a1" });
    assert.deepEqual(askInput({ caster: "thorn", sceneId: "s1", spell: "Hold Person", targets: ["g1", "bree"], roll: "spells:hold-person" }), { caster: "thorn", sceneId: "s1", spell: "Hold Person", targets: ["g1", "bree"], roll: "spells:hold-person" });
    assert.ok(askInput({ caster: "thorn", sceneId: "s1", spell: "A very long name ".repeat(6), targets: ["g1"] }).spell.length <= 60);
  });

  test("a row of a long-named custom action keeps its whole key, and the op passes the protocol (SSB-O-1)", () => {
    const name = "Breath of the Ancient Storm That Scours the Northern Wastes!";
    assert.equal(name.length, 60);
    const monster = customMonster("storm", { actions: [{ name, text: "Dexterity Saving Throw: DC 13, each creature in a 30-foot cone. Failure: 21 (6d6) Lightning damage. Success: Half damage." }] });
    const named = blockActions(monsterView(statBlockOf(monster))).find((r) => r.save)!;
    // A slug that long is cut to a hash of the whole name (shared/dice/named.ts entryKeys), which the ask keeps whole as it kept the long key.
    assert.match(named.key, /^actions:[a-z0-9-]{37}-[0-9a-f]{6}$/);
    const input = askInput({ caster: "thorn", sceneId: "s1", spell: named.name, targets: ["g1"], roll: named.key });
    assert.equal(input.roll, named.key, "never dropped, since the DM's name fallback reads the cut name");
    const op = { t: "cast.ask", cast: { ...input, id: "0192f0a8-6c1e-7a4b-9c3d-000000000001" } };
    assert.equal(clientOpSchema.safeParse(op).success, true);
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
    assert.deepEqual(waitingLines(p.holder.view, p.env.store.getState().sends, (id) => p.env.tracker.state(id)), [{ id: "ask-1", spell: "Fireball", caster: "thorn", phase: "asked" }]);
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

  test("a refused or unknown send for an area with no row leads the options with its Ask again, across a reload, until it is closed or held by its block (SSB-A-06)", async () => {
    const p = page();
    askFor(p.env, input());
    p.sent[1]!.onAnswer("refused", { code: "quota", message: ASKS_WAITING, text: ASKS_WAITING });
    const lines = () => waitingLines(p.holder.view, p.env.store.getState().sends, (id) => p.env.tracker.state(id));
    assert.deepEqual(lines(), [{ id: "ask-1", spell: "Fireball", caster: "thorn", phase: "refused" }]);
    assert.deepEqual(waitingLines(p.holder.view, p.env.store.getState().sends, (id) => p.env.tracker.state(id), "ask-1"), [], "its open block shows it in place");
    // A reload: a new page restores the draft and settles each send by its receipt, refused and unknown alike.
    for (const receipt of ["refused", "unknown"] as const) {
      const q = page();
      (q.env.tracker as ReceiptTracker).env = { lookup: () => Promise.resolve(receipt === "refused" ? { parts: [{ part: 0, state: "refused", code: "quota", message: ASKS_WAITING }] } : { parts: [] }), log: () => [] };
      restoreSends(q.env, p.saved.at(-1) as CastSend[]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const after = waitingLines(q.holder.view, q.env.store.getState().sends, (id) => q.env.tracker.state(id));
      assert.equal(after.length, 1, `${receipt}: one line`);
      assert.ok(after[0]!.phase === "refused" || after[0]!.phase === "unknown", `${receipt}: reads ${after[0]!.phase}`);
      // Reopening the area's block takes it back, so the block offers Ask again rather than a second roll.
      assert.equal(pendingSend({ spec: { key: "c:thorn-c", spell: "Fireball", area: "a1" }, sends: q.env.store.getState().sends, casts: {}, state: (id) => q.env.tracker.state(id) })?.id, "ask-1");
      q.env.newId = () => "ask-9";
      assert.equal(askAgain(q.env, "ask-1"), "ask-9");
      assert.deepEqual(q.rolled, [], "Ask again rolls nothing");
      assert.deepEqual((q.sent.at(-1)!.op as { cast: { damage?: unknown } }).cast.damage, { tag: "roll-1", parts: 1 }, "it names the first roll");
    }
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

describe("a send the list above the card changes while its block is folded or another creature is picked (3.2)", () => {
  const BLOCK: CastBlock = { key: "c:thorn-c", creature: { characterId: "thorn-c" }, spell: "Fireball", area: "a1", opened: 1, sent: "ask-1" };
  /** Thorn's Fireball block, its send refused, with the option store it lives in. */
  function refused() {
    const p = page();
    askFor(p.env, input());
    p.sent[1]!.onAnswer("refused", { code: "quota", message: ASKS_WAITING, text: ASKS_WAITING });
    const options = createStore<{ cast: CastBlock | null }>(() => ({ cast: BLOCK }));
    const done = () => {
      const cast = options.getState().cast;
      const sent = cast?.sent;
      return blockDone(cast, p.env.store.getState().sends, sent === undefined ? null : phaseOf(p.env.tracker.state(sent), p.holder.view.casts[sent] !== undefined));
    };
    return { p, options, done };
  }

  test("Ask again there moves the block to the retry, which closes once the DM has it, and so once it settles", () => {
    const { p, options, done } = refused();
    assert.equal(done(), false, "refused, the block stays to offer Ask again");
    const next = retryFromList(p.env, options, "ask-1");
    assert.equal(next, "ask-2");
    assert.equal(options.getState().cast?.sent, "ask-2", "the block follows the retry, so unfolding shows it, never a second ask");
    assert.equal(done(), false, "still on its way");
    p.holder.view = castTable({ casts: { "ask-2": castAsk("ask-2") } });
    p.sent.at(-1)!.onAnswer("taken");
    assert.equal(done(), true, "the DM has it: the block becomes the row's waiting line");
    p.holder.view = castTable();
    assert.equal(done(), true, "settled and gone from the view");
  });

  test("Ask again there tells the caller the retry's id, so it is marked seen before the options draw", () => {
    const { p, options } = refused();
    const seen: string[] = [];
    assert.equal(retryFromList(p.env, options, "ask-1", (id) => seen.push(id)), "ask-2");
    assert.deepEqual(seen, ["ask-2"]);
  });

  test("Close there lets the block go, and a block whose send went any other way closes too", () => {
    const { p, options, done } = refused();
    forgetSend(p.env, "ask-1");
    assert.equal(done(), true, "a block left on a forgotten send is done");
    followSend(options, "ask-1", null);
    assert.equal(options.getState().cast, null, "Close lets the block go");
  });

  test("another block's send leaves the open block as it is", () => {
    const { options } = refused();
    followSend(options, "ask-9", "ask-10");
    followSend(options, "ask-9", null);
    assert.equal(options.getState().cast, BLOCK);
  });
});

for (const override of ["normal", "secret"] as const) test(`cast ${override} covers every damage part and never survives into ask-again`, () => {
  const p = page();
  const picks: unknown[] = [];
  const original = p.env.rollDamage;
  p.env.rollDamage = (rolls, chosen) => {
    picks.push(chosen);
    assert.ok(rolls.every((r) => r.modeEligible === false), "even d20 damage cannot gain d20 modes");
    return original(rolls, chosen);
  };
  const id = askFor(p.env, input({ rolls: [fire, radiant, { formula: "1d20", type: "fire" }], override }));
  assert.ok(id);
  assert.deepEqual(picks, [override]);
  assert.equal("override" in p.env.store.getState().sends[id]!, false);
  const answer = p.sent.find((s) => s.op.t === "cast.ask")!;
  assert.ok(answer.op.t === "cast.ask");
  assert.equal("mode" in answer.op.cast, false);
  answer.onAnswer("refused", { code: "invalid", message: "Try again", text: "Try again" });
  assert.ok(askAgain(p.env, id));
  assert.deepEqual(picks, [override], "retry keeps the first damage reference without rolling again");
});

test("cast result secrecy comes from the returned dice envelope", () => {
  const line = diceLine("1:0", "roll", [damageRoll({ total: 12 })]);
  assert.ok(line.data?.type === "dice");
  line.data.to = "dm";
  assert.match(rolledText([line])!, /, Secret$/);
  line.data.to = "all";
  assert.doesNotMatch(rolledText([line])!, /Secret/);
});
