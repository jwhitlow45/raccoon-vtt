import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import type { OnAnswer } from "../../state/types.ts";
import { answerKey, draftKey, type AnswerDraft } from "./logic.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { RoomState, RollRequest } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { pendingSaves } from "#shared/rules/saveEnds.ts";
import { actor, character, DM, P1, effect, entry, room, token } from "#shared/testutil.ts";
import type { UseRollModeMenuOptions } from "../dice/useRollModeMenu.tsx";
import type { PromptCard } from "../combat/alerts.ts";
import type { DeathSavePrompt } from "../combat/logic.ts";
import { diceChoicesSlot } from "../dice/useDicePanel.ts";

// Capture each consumer's invocation at the hook boundary. Gestures and focus are tested by the shared hook's tests.
let captured: UseRollModeMenuOptions[] = [];
const capture = Symbol.for("rvtt-test-roll-mode-consumers");
(globalThis as Record<symbol, unknown>)[capture] = (options: UseRollModeMenuOptions) => captured.push(options);
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/dice/useRollModeMenu.tsx")) return result;
  const source = String(result.source);
  const replaced = source.replace(/(function useRollModeMenu\(options\) \{)/, '$1\nglobalThis[Symbol.for("rvtt-test-roll-mode-consumers")](options);');
  assert.notEqual(source, replaced, "the hook capture must be installed");
  return { ...result, source: replaced };
} });

const { createElement, createRef } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RollCard } = await import("./PlayerRolls.tsx");
const { DmCard } = await import("./DmDesk.tsx");
const { SaveEndsCard } = await import("../encounter/SaveEndsCard.tsx");
const { ConcentrationCard } = await import("../encounter/InitiativeStrip.tsx");
const { DeathSaveCard } = await import("../combat/DeathSaveCard.tsx");
const { optionSlot } = await import("../dice/optionState.ts");
const { receiptsSlot } = await import("../dice/useReceipt.ts");
const { PreviewContext } = await import("../dm/previewContext.ts");
const { AutoInitiativeControls } = await import("../encounter/AutoInitiative.tsx");
const { DeathSaves } = await import("../tokens/HpSection.tsx");
const { EntryRow } = await import("../encounter/Row.tsx");
const { RechargeCard } = await import("../encounter/RechargeCard.tsx");
const { CombatUses } = await import("../combat/CombatUses.tsx");

function fixture() {
  const state = room({ characters: { hero: character("hero", {
    stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["dex"], abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 10 } },
    actor: actor({ life: "dying", hp: { cur: 0, max: 20, temp: 0 }, effects: [
      effect("restrained", { key: "restrained" }),
      effect("bless", { key: "concentrating", spell: "Bless" }),
      effect("fear", { key: "frightened", save: { ability: "dex", dc: 15 }, due: { id: "5:0", state: "pending" } }),
    ], turnRecord: { id: 7, entryId: "eh", round: 2, hp: 0, life: "dying" } }),
  }) } });
  state.encounter = { rev: 0, round: 2, activeEntryId: "eh", entries: [entry("eh", { characterId: "hero", value: null })] };
  return state;
}
function ask(): RollRequest {
  return { id: "ask", rev: 1, at: "", dcShown: false, resultShown: false, test: { kind: "save", choices: [{ ability: "dex" }, { ability: "str" }] }, targets: [{ characterId: "hero" }] };
}
function player(request: RollRequest, drafts = new Map<string, AnswerDraft>()) {
  return createElement(RollCard, { request, cardRef: createRef<HTMLElement>(), drafts, sheet: false, hidden: false, stand: "toolbar", stickyHeader: false, whole: 0, onMeasure() {}, onFold() {}, onEngage() {}, onFocusWithin() {} });
}
function desk(request: RollRequest) { return createElement(DmCard, { request, open: true, toggleRef() {}, onClose() {}, onToggle() {} }); }
function provide(state: RoomState, child: ReactNode, connection = "open", you = DM, configure?: (scope: InstanceType<typeof RoomScope>) => void) {
  captured = [];
  const scope = new RoomScope();
  const store = createStore(() => ({ view: state, you, roomId: "r1", sceneId: "s1", connection, local: { selectedIds: [], multi: false } }));
  const sent: ClientOp[] = [];
  const answers: OnAnswer[] = [];
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ adv: false, dis: true, secret: true, version: 31 });
  const before = { ...choices.getState() };
  configure?.(scope);
  const html = renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { newId: () => "roll-tag", dispatch: (op: ClientOp, options?: { onAnswer?: OnAnswer }) => { sent.push(op); if (options?.onAnswer) answers.push(options.onAnswer); return sent.length; } } as never,
    ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: child }),
  }));
  return { html, sent, answers, menus: captured.filter((o) => o.source !== "no-roll-menu"), store, choices, before };
}
function death(state: RoomState) {
  const record = state.characters.hero!.actor.turnRecord!;
  const card: PromptCard<DeathSavePrompt> = { id: "hero-death", participant: { target: { characterId: "hero" }, holder: "c:hero", name: "Hero", record, landing: true }, record: record.id, prompt: { what: "deathSave", settled: undefined } };
  return createElement(DeathSaveCard, { card, waits: false, onDismiss() {} });
}
function tracker(state: RoomState) {
  return createElement(EntryRow, { entry: state.encounter!.entries[0]!, active: true, role: "dm", mine: true, expanded: true, picking: false, selected: false, onExpand() {}, onShow() {}, onShowToken() {}, drag: null, rowRef() {} });
}
const concentration = () => createElement(ConcentrationCard, { prompt: { logId: "1:0", target: { characterId: "hero" }, dc: 12 }, onDone() {}, onResult() {} });
const hp = () => createElement(DeathSaves, { saves: { ok: 0, fail: 0 }, canEdit: true, target: { characterId: "hero" }, onChange() {} });

for (const surface of ["player", "dm", "saveEnds", "linkedSave", "concentration", "death", "hp", "tracker"] as const) {
  test(`one-roll ${surface}: dispatch keeps its envelope, applies modes and leaves choices untouched`, () => {
    for (const override of ["adv", "dis", "normal"] as const) {
      const state = fixture();
      const request = ask(); state.rolls[request.id] = request;
      const pending = pendingSaves(state)[0]!;
      if (surface === "linkedSave") {
        request.ends = { effect: pending.effect.id, occurrence: pending.effect.due.id };
        request.cause = "saveEnds";
        request.test = { kind: "save", choices: [{ ability: "dex" }] };
      }
      const child = surface === "player" ? player(request) : surface === "dm" ? desk(request) : surface === "saveEnds" || surface === "linkedSave" ? createElement(SaveEndsCard, { pending: pendingSaves(state)[0]!, onResult() {} }) : surface === "concentration" ? concentration() : surface === "death" ? death(state) : surface === "hp" ? hp() : tracker(state);
      const f = provide(state, child);
      const menu = f.menus.find((m) => !m.disabled && m.capability.d20);
      assert.ok(menu, "an actual enabled roll must register its menu");
      assert.match(f.html, /aria-keyshortcuts="ContextMenu Shift\+F10"/);
      assert.equal(menu.capability.visibility, surface === "tracker" ? "selectable" : surface === "player" || surface === "dm" || surface === "linkedSave" ? "request" : "creature");
      assert.equal(menu.valid?.(), true);
      menu.onRoll(override);
      assert.equal(f.sent.length, 1);
      const op = f.sent[0]!;
      if (surface === "player" || surface === "dm" || surface === "linkedSave") {
        assert.equal(op.t, "roll.dice");
        if (op.t !== "roll.dice") throw new Error("wrong request route");
        assert.equal(op.rollId, request.id); assert.deepEqual(op.target, { characterId: "hero" });
        assert.equal("to" in op, false);
        if (surface !== "player") assert.equal(op.unanswered, true);
        else assert.equal(op.choice, 0);
        assert.equal(op.cancelled, override === "adv" ? true : undefined);
        assert.equal(op.mode, override === "adv" ? undefined : "dis");
      } else if (surface === "hp" || surface === "death") {
        assert.equal(op.t, "actor.deathRoll");
        if (op.t !== "actor.deathRoll") throw new Error("wrong death route");
        assert.equal(op.record, 7); assert.equal("to" in op, false);
        assert.equal(op.mode, override === "normal" ? undefined : override);
      } else {
        assert.equal(op.t, "dice.roll");
        if (op.t !== "dice.roll") throw new Error("wrong dice route");
        const die = op.rolls[0]!;
        assert.deepEqual(die.creature, { characterId: "hero" });
        assert.equal(op.to, surface === "tracker" && override !== "normal" ? "dm" : "all");
        assert.equal(die.mode, surface === "saveEnds" ? override === "adv" ? undefined : "dis" : override === "normal" ? undefined : override);
        if (surface === "saveEnds") assert.equal(die.cancelled, override === "adv" ? true : undefined);
        if (surface === "tracker") assert.equal(die.initiative, true);
        if (surface === "saveEnds") assert.equal(die.save, "dex");
      }
      assert.deepEqual({ ...f.choices.getState(), last: null }, f.before, "no sticky choice or version consumed");
      f.store.setState({ connection: "closed" });
      assert.equal(menu.valid?.(), false, "late disconnected pick is invalid");
    }
  });
}

test("final player/DM answers and disabled rolls offer no menu or hint", () => {
  const state = fixture(); const request = ask();
  request.targets[0] = { characterId: "hero", total: 12, result: "pass", dice: { formula: "1d20+2", faces: [10], total: 12 } };
  state.rolls.ask = request;
  for (const child of [player(request), desk(request), concentration(), hp()]) {
    const f = provide(state, child, "closed");
    assert.doesNotMatch(f.html, /aria-keyshortcuts="ContextMenu Shift\+F10"|Hold, right-click/);
  }
});

test("recharge card and Uses list retain their plain roll, without any menu or hint", () => {
  const state = fixture();
  const use = { kind: "recharge", key: "actions:breath", name: "Breath", min: 5, section: "actions" } as const;
  state.characters.hero!.actor.uses = { [use.key]: { kind: "recharge", name: use.name, min: use.min, used: 1, max: 1 } };
  const record = state.characters.hero!.actor.turnRecord!;
  const card = { id: "recharge", participant: { target: { characterId: "hero" }, holder: "c:hero", name: "Hero", record, landing: true }, record: 7, prompt: { ...use, what: "recharge:actions:breath" as const, settled: undefined } };
  for (const child of [createElement(RechargeCard, { card, onDismiss() {} }), createElement(CombatUses, { target: { characterId: "hero" }, form: "list", uses: [use], loading: false, failed: false, ownTurn: true, name: "Hero" })]) {
    const f = provide(state, child);
    assert.match(f.html, /Roll/);
    assert.doesNotMatch(f.html, /aria-haspopup="menu"|aria-keyshortcuts|Hold, right-click/);
  }
});


test("unknown bonuses disclose first and carry no menu or shortcut hint", () => {
  const state = fixture(); delete state.characters.hero!.stats;
  for (const child of [concentration(), createElement(SaveEndsCard, { pending: pendingSaves(state)[0]!, onResult() {} })]) {
    const f = provide(state, child);
    assert.match(f.html, /Roll/);
    assert.doesNotMatch(f.html, /aria-keyshortcuts|Hold, right-click/);
    assert.ok(f.menus.every((m) => !m.capability.d20));
  }
});

test("a tracker Roll d20 opener has no menu when this player cannot read the character's bonus", () => {
  const state = fixture(); state.characters.hero!.ownerIds = ["p2"];
  const f = provide(state, tracker(state), "open", P1);
  assert.match(f.html, /Roll d20/);
  assert.doesNotMatch(f.html, /aria-keyshortcuts|Hold, right-click/);
});

test("a request menu keeps its chosen ability, typed bonus, extras and manual chip", () => {
  const state = fixture(); delete state.characters.hero!.stats;
  const request = ask(); state.rolls.ask = request;
  const target = request.targets[0]!;
  const drafts = new Map<string, AnswerDraft>([[draftKey(request.id, target), { base: answerKey(target), choice: 1, text: "", inputs: { bonus: "+4", extra: "1d6", pressed: "dis" } }]]);
  const f = provide(state, player(request, drafts));
  f.menus[0]!.onRoll("adv");
  assert.deepEqual(f.sent[0], { t: "roll.dice", tag: "roll-tag", rollId: "ask", target: { characterId: "hero" }, choice: 1, mode: "adv", extra: "+1d6", bonus: 4 });
  assert.equal(drafts.values().next().value?.inputs?.pressed, "dis");
  assert.match(f.html, /type="submit"/, "Enter in either field retains form submission");
});

test("a late answer, deleted request and replaced request invalidate player and DM menu callbacks", () => {
  for (const surface of [player, desk]) for (const event of ["answer", "fail", "delete", "replace"] as const) {
    const state = fixture(); const request = ask(); state.rolls.ask = request;
    const f = provide(state, surface(request)); const menu = f.menus[0]!;
    const view = structuredClone(state);
    if (event === "answer") Object.assign(view.rolls.ask!.targets[0]!, { total: 10, tag: "other" });
    else if (event === "fail") Object.assign(view.rolls.ask!.targets[0]!, { noRoll: true });
    else if (event === "delete") delete view.rolls.ask;
    else view.rolls.ask!.rev++;
    f.store.setState({ view });
    assert.equal(menu.valid?.(), false);
    menu.onRoll("adv");
    assert.deepEqual(f.sent, []);
  }
});

test("fixed cards reject vanished routes and death-save regeneration blocks the shortcut", () => {
  for (const surface of ["save", "concentration", "death", "hp", "tracker"] as const) {
    const state = fixture();
    const child = surface === "save" ? createElement(SaveEndsCard, { pending: pendingSaves(state)[0]!, onResult() {} }) : surface === "concentration" ? concentration() : surface === "death" ? death(state) : surface === "hp" ? hp() : tracker(state);
    const f = provide(state, child); const menu = f.menus.find((m) => m.capability.d20)!;
    const view = structuredClone(state);
    if (surface === "tracker") view.encounter!.entries = [];
    else if (surface === "death") view.characters.hero!.actor.turnRecord!.settled = { deathSave: { state: "done", total: 10 } };
    else if (surface === "hp") view.characters.hero!.actor.life = "alive";
    else view.characters.hero!.actor.effects = [];
    f.store.setState({ view });
    assert.equal(menu.valid?.(), false, surface);
    menu.onRoll("normal"); assert.deepEqual(f.sent, [], surface);
  }
  const child = death(fixture());
  const f = provide(fixture(), createElement(DeathSaveCard, { ...child.props, waits: true }));
  assert.doesNotMatch(f.html, /aria-keyshortcuts|Hold, right-click/);
});

test("tracker Secret keeps the same initiative metadata without taking choices", () => {
  const f = provide(fixture(), tracker(fixture()));
  f.menus[0]!.onRoll("secret");
  const op = f.sent[0]!;
  assert.equal(op.t, "dice.roll");
  if (op.t !== "dice.roll") throw new Error("wrong route");
  assert.equal(op.to, "dm"); assert.equal(op.rolls[0]!.mode, "dis"); assert.equal(op.rolls[0]!.initiative, true);
  assert.deepEqual({ ...f.choices.getState(), last: null }, f.before);
});

test("seeded request sequences preserve finality and newer choices across late refusals and unknown replies", () => {
  for (let seed = 1; seed <= 40; seed++) {
    let random = seed;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    for (let step = 0; step < 12; step++) {
      const state = fixture(); const request = ask(); state.rolls.ask = request;
      const f = provide(state, (next() & 1) ? player(request) : desk(request));
      const menu = f.menus[0]!;
      const event = next() % 4;
      if (event === 0) {
        const view = structuredClone(state); view.rolls.ask!.targets[0]!.total = 17; f.store.setState({ view });
      } else if (event === 1) f.store.setState({ connection: "closed" });
      const valid = event > 1;
      assert.equal(menu.valid?.(), valid, `seed ${seed}, step ${step}: finality`);
      menu.onRoll((["adv", "dis", "normal"] as const)[next() % 3]!);
      assert.equal(f.sent.length, valid ? 1 : 0, `seed ${seed}, step ${step}: one send`);
      const current = { adv: true, dis: false, secret: false, version: 99 };
      f.choices.setState(current);
      for (const answer of f.answers) answer((next() & 1) ? "unknown" : "refused", { code: "invalid", message: "Refused", text: "Refused" });
      const { adv, dis, secret, version } = f.choices.getState();
      assert.deepEqual({ adv, dis, secret, version }, current, `seed ${seed}, step ${step}: newer choices`);
    }
  }
});


test("Normal on fixed save cards and tracker keeps a DM creature's secret envelope and private DC", () => {
  for (const surface of ["save", "concentration", "tracker"] as const) {
    const state = fixture(); state.characters.hero!.ownerIds = [];
    const child = surface === "save" ? createElement(SaveEndsCard, { pending: pendingSaves(state)[0]!, onResult() {} }) : surface === "concentration" ? concentration() : tracker(state);
    const f = provide(state, child);
    f.choices.setState({ secret: false });
    const menu = f.menus.find((m) => m.capability.d20)!;
    menu.onRoll("normal");
    const op = f.sent[0]!;
    assert.equal(op.t, "dice.roll");
    if (op.t !== "dice.roll") throw new Error("wrong route");
    assert.equal(op.to, "dm");
    assert.equal(op.dc, surface === "save" ? 15 : surface === "concentration" ? 12 : undefined);
    assert.equal(f.choices.getState().secret, false);
    assert.equal(f.choices.getState().dis, true);
    assert.equal(f.choices.getState().version, 31);
  }
});


test("player and DM results retain informative modes and omit plain Normal", () => {
  for (const surface of [player, desk]) for (const mode of ["adv", "dis", "cancelled", "normal"] as const) {
    const state = fixture(); const request = ask();
    const dice = mode === "adv" || mode === "dis" ? { formula: `2d20k${mode === "adv" ? "h" : "l"}1+2`, faces: [10, 12], total: mode === "adv" ? 14 : 12, mode } : { formula: "1d20+2", faces: [10], total: 12, ...(mode === "cancelled" ? { cancelled: true as const } : {}) };
    request.targets[0] = { characterId: "hero", choice: 0, total: dice.total, dice };
    state.rolls.ask = request;
    const f = provide(state, surface(request));
    const text = f.html.replace(/<[^>]*>/g, "");
    const words = mode === "adv" ? "with Advantage" : mode === "dis" ? "with Disadvantage" : mode === "cancelled" ? "Normal: Advantage and Disadvantage cancelled" : "Normal";
    if (mode === "normal") assert.doesNotMatch(text, /Normal/);
    else assert.ok(text.includes(words), `${mode} remains readable`);
    assert.doesNotMatch(f.html, /role="note"/);
    if (surface === desk) assert.match(f.html, /aria-label="Proficient"/, "the result keeps its proficiency mark readable");
    assert.doesNotMatch(f.html, /aria-keyshortcuts|Hold, right-click/);
  }
});


test("death-save sources ignore other tracker rows and follow this creature's effects", () => {
  for (const surface of ["hp", "death"] as const) {
    const state = fixture();
    const source = (view: RoomState) => provide(view, surface === "hp" ? hp() : death(view)).menus[0]!.source;
    const before = source(state);
    const unrelated = structuredClone(state); unrelated.encounter!.entries.push(entry("other", { value: 12 })); unrelated.encounter!.rev++;
    assert.equal(source(unrelated), before, surface);
    unrelated.characters.hero!.actor.effects.push(effect("bane", { key: "baned" }));
    assert.notEqual(source(unrelated), before, surface);
  }
});

test("fight cards fit added mode words while HP retains its base cancellation text", () => {
  for (const surface of ["save", "concentration", "death", "hp"] as const) {
    const state = fixture();
    state.characters.hero!.actor.legendary = { actionsMax: 0, actionsUsed: 0, resistMax: 1, resistUsed: 0 };
    const deathCard = death(state);
    deathCard.props.card.prompt.settled = { state: "done", total: 4, outcome: "failure" };
    const child = surface === "save" ? createElement(SaveEndsCard, { pending: pendingSaves(state)[0]!, onResult() {} }) : surface === "concentration" ? concentration() : surface === "death" ? deathCard : hp();
    const f = provide(state, child, "open", DM, (scope) => {
      const row = surface === "save" ? "c:hero|saveEnds:5:0" : surface === "concentration" ? "concentration|1:0" : "deathSave:hero";
      const options = scope.get(optionSlot); options.setState({ tags: { [row]: "landed" }, since: { [row]: 7 } }); options.getInitialState = options.getState;
      const tracker = scope.get(receiptsSlot);
      tracker.env = { lookup: async () => ({ parts: [] }), log: () => [{ id: "8:0", kind: "event", at: "", data: { type: "dice", tag: "landed", by: DM.memberId, to: "dm", rolls: [{ formula: "1d20", faces: [4], total: 4, cancelled: true }] } }] };
      tracker.sending("landed", 0); tracker.answer("landed", 0, "taken");
    });
    if (surface === "hp") {
      assert.match(f.html, /data-roll-result-base=""[^>]*>4, normal: Advantage and Disadvantage cancelled<\/span>/);
      assert.doesNotMatch(f.html, /data-roll-result-detail/);
    } else {
      assert.match(f.html, /data-roll-result-missing=""[^>]*> Normal: Advantage and Disadvantage cancelled\.<\/span>/, surface);
      const base = /data-roll-result-base=""[^>]*>(.*?)<\/span>/.exec(f.html)?.[1];
      assert.ok(base); assert.doesNotMatch(base, /cancelled/); assert.match(base, /4/);
    }
  }
});

test("auto initiative sources ignore unrelated movement and follow the rolled creature's modifier", () => {
  const state = fixture(); state.tokens.goblin = token("goblin"); state.tokens.other = token("other");
  state.encounter!.entries.push(entry("eg", { tokenId: "goblin", value: null }));
  const source = () => provide(state, createElement(AutoInitiativeControls)).menus[0]!.source;
  const before = source(); state.tokens.other!.x++;
  assert.equal(source(), before);
  assert.ok("inline" in state.tokens.goblin!.actor); state.tokens.goblin!.actor.inline.initBonus++;
  assert.notEqual(source(), before);
});


test("preview blocks request menus while ordinary taps retain the base send path", () => {
  for (const surface of [player, desk]) {
    const state = fixture(); const request = ask(); state.rolls.ask = request;
    const f = provide(state, createElement(PreviewContext.Provider, { value: {} as never, children: surface(request) }));
    const menu = f.menus[0]!;
    assert.equal(menu.disabled, false);
    assert.equal(menu.valid?.(), false);
    menu.onTap();
    assert.equal(f.sent.length, 1, "the preview dispatcher retains responsibility for its ordinary refusal");
  }
});

test("request sources exclude sibling answers but retain the current target and test", () => {
  for (const surface of [player, desk]) {
    const state = fixture(); const request = ask(); request.targets.push({ characterId: "sibling" }); state.rolls.ask = request;
    const source = () => provide(state, surface(request)).menus[0]!.source;
    const before = source(); request.targets[1]!.total = 15;
    assert.equal(source(), before);
    request.test.choices[0]!.ability = "con";
    assert.notEqual(source(), before);
  }
});


test("an ordinary tracker tap keeps its base roll path when menu validation is stale", () => {
  const state = fixture(); const f = provide(state, tracker(state));
  const menu = f.menus[0]!;
  const view = structuredClone(state); view.encounter!.entries[0]!.value = 19; f.store.setState({ view });
  assert.equal(menu.valid?.(), false);
  menu.onTap();
  assert.equal(f.sent[0]?.t, "dice.roll");
});
