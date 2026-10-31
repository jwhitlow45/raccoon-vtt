import "../../../components/testing/register.ts";
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../../lib/theme.ts";
import { damageSummary } from "../damageSummaryLines.ts";
import { createStore } from "zustand/vanilla";
import { actor, apply, character, customMonster, DM, room, token } from "#shared/testutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { newPage, setAmount, type Page } from "./chain.ts";
import { amountsOf, buildPlan, rowOutcome } from "./plan.ts";
import { groupRows } from "./rows.ts";
import { receiptsSlot } from "../useReceipt.ts";
import { groupSaveSlot } from "./store.ts";
import { captureChoices, OUTCOME_UNDONE, OUTCOME_RESTORED, OUTCOME_UNAVAILABLE, SAVE_MEMORY_ONLY, type SaveReopen } from "./reopen.ts";

/*
 * The open group save in the Dice panel (docs/design-v1-dice-pass.md 7.8):
 * an info notice with Open, so a DM reads an unfinished group save as a
 * status rather than a sentence among the rolls.
 */

const panelModule = await import("../useDicePanel.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
let menuBindings: import("../useRollModeMenu.tsx").UseRollModeMenuOptions[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for("group-save-bindings")] = (options: import("../useRollModeMenu.tsx").UseRollModeMenuOptions) => menuBindings.push(options);
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/dice/useRollModeMenu.tsx")) return result;
  return { ...result, source: String(result.source).replace(/(function useRollModeMenu\(options\) \{)/, '$1\nglobalThis[Symbol.for("group-save-bindings")](options);') };
} });
const groupSave = await import("./GroupSave.tsx");
const { OpenGroupSave } = groupSave;
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../../state/scope.ts");
const VIEW = room({ tokens: { g1: token("g1", { name: "Guard", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }) } });
const DICE = { view: VIEW, you: DM, srd: { monsters: [], rolls: {} } };
function damagePage(damage: string): Page {
  const test = { kind: "none" } as const;
  return { ...newPage({ id: "damage", sceneId: "s1", source: { kind: "selection", tokenIds: ["g1"] }, test, dc: null, secret: false, spell: false, switches: { dcShown: true, resultShown: true }, outcome: { damage, conditions: ["prone"] } }), rows: groupRows(DICE, ["g1"], test, false) };
}
function drawPage(page: Page, lines: import("#shared/model.ts").LogEntry[] = [], connection = "open", reopen: SaveReopen | null = null): string {
  const scope = new RoomScope();
  const saves = scope.get(groupSaveSlot);
  const tags = [...new Set(lines.flatMap((line) => line.data?.type === "dice" && line.data.tag ? [line.data.tag] : []))];
  if (tags.length > 0) {
    const tracker = scope.get(receiptsSlot);
    tracker.env = { lookup: async () => ({ parts: [] }), log: () => lines };
    for (const tag of tags) {
      tracker.sending(tag, 0);
      tracker.answer(tag, 0, "taken");
    }
  }
  saves.setState({ page, reopen });
  saves.getInitialState = saves.getState;
  const store = createStore(() => ({ view: VIEW, roomId: "r1", connection, you: DM, sceneId: "s1", local: { selectedIds: ["g1"], multi: false } }));
  return renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: createElement(groupSave.GroupSave, { parent: "Dice", onBack() {} }) }),
  }));
}

const PAGE = newPage({
  id: "p",
  sceneId: "s1",
  source: { kind: "selection", tokenIds: ["g1", "g2"] },
  test: { kind: "save", ability: "dex" },
  dc: 13,
  secret: true,
  spell: false,
  switches: { dcShown: true, resultShown: true },
  outcome: { damage: "", conditions: [], saveEnds: { ability: "con", dc: null } },
});

describe("the open group save's notice (7.8)", () => {
  test("FL-3: row damage accepts type words and describes invalid input beside the field", () => {
    assert.equal(typeof groupSave.RowDamageField, "function");
    const draw = (value: string) => renderToStaticMarkup(createElement(groupSave.RowDamageField, { name: "Frost", value, computed: 7, onChange() {} }));
    assert.match(draw("11 cold"), /aria-label="Frost&#x27;s damage"[^>]*inputMode="text"/);
    assert.match(draw("11 cold"), /value="11 cold"/);
    const invalid = draw("11 frost");
    assert.match(invalid, /aria-invalid="true"/);
    assert.match(invalid, /is not a damage type/);
    const id = /aria-describedby="([^"]+)"/.exec(invalid)?.[1];
    assert.ok(id && invalid.includes(`id="${id}"`));
    assert.match(draw("11 cold"), /Back to 7/);
  });
  test("marked for the sweep, an info notice on the raised fill inside its outline, its words and then Open", () => {
    const markup = renderToStaticMarkup(createElement(OpenGroupSave, { page: PAGE, onOpen() {} }));
    assert.match(markup, /^<div data-open-group-save=""/);
    assert.ok(markup.includes(`border:1px solid ${theme.color.border};background:${theme.color.surfaceRaised}`), "the info tone's outline and fill");
    const words = markup.indexOf("Dexterity save for 2: set up.");
    assert.ok(words > 0, "what is open and where it stands");
    const open = markup.search(/<button[^>]*>Open<\/button>/);
    assert.ok(open > words, "Open after the words, as the notice's action");
  });

  test("the words follow the page as it goes: waiting rows once rolled", () => {
    const rolled = { ...PAGE, phase: "rolled" as const };
    const markup = renderToStaticMarkup(createElement(OpenGroupSave, { page: rolled, onOpen() {} }));
    assert.match(markup, /Dexterity save for 2: [a-z0-9 ]+\./);
    assert.doesNotMatch(markup, /set up\./);
  });
});

test("FL-4: an override renders the computed parts and describes a struck amount", () => {
  const summary = damageSummary([{ amount: 11, type: "cold" }], { result: { amount: 5, byPart: [5], notes: ["Resists Cold"] }, defenses: [{ kind: "resist", of: "cold", source: "Stat block" }] });
  const markup = renderToStaticMarkup(createElement(groupSave.RowDamageField, { name: "Frost", value: "11 cold", computed: 7, summary, onChange() {} }));
  assert.match(markup, /data-damage-icon="cold"/);
  assert.match(markup, /<s aria-hidden="true"[^>]*>11<\/s>/);
  assert.match(markup, /was 11, now /);
  assert.match(markup.replace(/<[^>]*>/g, ""), /5 Cold damage/);
  assert.match(markup.replace(/<[^>]*>/g, ""), /Resists: Cold/);
});

test("FL-4 review: negative rolls agree in the field, row and applied parts", () => {
  const page: Page = { ...damagePage("1d6-6 cold + 1d6 fire"), damage: { tag: "damage", state: "committed", amounts: [-5, 6] } };
  const amounts = amountsOf(page)!;
  const outcome = rowOutcome(page, page.rows[0]!, DICE, amounts);
  const plan = buildPlan(page, DICE, amounts, { plan: "negative", newId: () => "effect" })!;
  assert.deepEqual(plan.targets[0]!.damage?.parts.map(p => p.amount), [0, 6]);
  assert.deepEqual(outcome.summary?.parts.map(p => p.amount), [0, 6]);
  assert.equal(outcome.amount, 6);
  const markup = drawPage(page);
  const shown = [...markup.matchAll(/data-damage-result=""[^>]*>([^<]*)</g)].map(m => Number(m[1]));
  assert.deepEqual(shown, [0, 6, 6, 0, 6, 6], "the Damage field and row both show zero Cold, six Fire and a total of six");
  const applied = applyOp(VIEW, clientOpSchema.parse(plan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
  assert.ok(applied.ok);
  const changed = applied.state.tokens.g1!.actor;
  assert.ok("inline" in changed);
  assert.equal(changed.inline.hp.cur, 24);
});

for (const override of ["5 fire", "5"]) test(`FL-4 review: ${override} compares only with actual computed damage`, () => {
  for (const save of [false, true]) for (const state of ["empty", "spaces", "unrolled", "sending", "zero", "positive"] as const) {
    let page = damagePage(state === "empty" ? "" : state === "spaces" ? "   " : "1d6-6 fire");
    if (save) page = { ...page, phase: "rolled", test: { kind: "save", ability: "dex" }, states: { [page.rows[0]!.holder]: { way: "type", mark: "fail" } } };
    if (state === "zero" || state === "positive") page = { ...page, damage: { tag: "rolled", state: "committed", amounts: [state === "zero" ? 0 : 6] } };
    if (state === "sending") page = { ...page, damage: { tag: "pending", state: "sending" } };
    page = setAmount(page, page.rows[0]!.holder, override);
    const markup = drawPage(page).replace(/<[^>]*>/g, "");
    if (state === "zero" || state === "positive") assert.match(markup, new RegExp(`worked out ${state === "zero" ? 0 : 6}`));
    else assert.doesNotMatch(markup, /worked out/, state);
    if (override === "5 fire") assert.doesNotMatch(markup, /Typed 5 fire:/, "the slip already explains the typed parts");
    else assert.match(markup, /Typed 5/, "plain overrides retain their note");
  }
});

test("FL-4 review: an override with no computed damage can be cleared without promising zero", () => {
  const markup = renderToStaticMarkup(createElement(groupSave.RowDamageField, { name: "Guard", value: "5 fire", computed: null, onChange() {} }));
  assert.match(markup, /Clear override/);
  assert.match(markup, /placeholder="10 fire"/);
});

test("one-roll group damage uses safe public labels and preserves the fixed caster exception", () => {
  const page = { ...damagePage("1d20 fire + 7 cold + 1d6 radiant"), fill: { name: "Hidden trap", publicName: "Trap", from: "Trap" } };
  for (const override of ["normal", "secret"] as const) {
    const invocation = groupSave.groupDamageInvocation(page, VIEW, override);
    assert.equal(invocation.to, override === "secret" ? "dm" : "all");
    assert.equal(invocation.rolls.length, 2, "typed damage stays typed");
    assert.ok(invocation.rolls.every((r) => r.modeEligible === false));
    assert.match(invocation.rolls[0]!.label!, override === "secret" ? /^Hidden trap damage/ : /^Trap damage/);
    assert.equal(page.secret, false);
  }
  const own = { ...page, secret: true, fill: { ...page.fill, caster: "g1" } };
  const view = structuredClone(VIEW);
  view.tokens.g1!.ownerIds = ["p1"];
  const invocation = groupSave.groupDamageInvocation(own, view, "secret");
  assert.equal(invocation.to, "all");
  assert.match(invocation.rolls[0]!.label!, /^Trap damage/);
  const html = drawPage(page);
  assert.match(html, /Hold, right-click or Shift\+F10 for Secret or Normal/);
  assert.doesNotMatch(html, /type="submit"/);
});

function captureRolls(page: Page, view = VIEW, reopen: SaveReopen | null = null, room: Record<string, unknown> = {}) {
  const scope = new RoomScope();
  const saves = scope.get(groupSaveSlot);
  saves.setState({ page, reopen });
  saves.getInitialState = saves.getState;
  const choices = scope.get(panelModule.diceChoicesSlot);
  const initial = { adv: true, dis: false, secret: true, secretFor: "g1", version: 19, last: null };
  choices.setState(initial);
  choices.getInitialState = choices.getState;
  const store = createStore(() => ({ view, confirmed: view, confirmedReady: true, seq: 0, pending: [], ended: null, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["g1"], multi: false }, ...room }));
  const sent: import("#shared/protocol.ts").ClientOp[] = [];
  const snapshots: ReturnType<typeof saves.getState>[] = [];
  const controls: { children?: unknown; onClick?(): void; disabled?: boolean }[] = [];
  const buttons: { name: string; source: string; onRoll(override?: import("../rollMode.ts").RollModeOverride): void }[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)) return;
    const element = value as { type: { name?: string } | string; props: { children?: unknown } };
    if (typeof element.type === "function" && ["GroupSavePage", "GroupRow", "OutcomePanel"].includes(element.type.name)) collect((element.type as (p: never) => unknown)(element.props as never));
    else if (typeof element.type !== "string" && element.type.name === "GroupRollButton") buttons.push(element.props as never);
    else if (typeof element.type !== "string" && element.type.name === "Button") controls.push(element.props as never);
    else collect(element.props.children);
  }
  function Probe() { collect(groupSave.GroupSave({ parent: "Dice", onBack() {} })); return null; }
  renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { newId: () => "ask", dispatch: (op: import("#shared/protocol.ts").ClientOp) => { snapshots.push(structuredClone(saves.getState())); return sent.push(op); } } as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: createElement(Probe) }),
  }));
  return { buttons, controls, sent, snapshots, saves, choices, initial };
}

for (const override of ["adv", "dis", "secret", "normal"] as const) test(`group page ${override} callbacks preserve the existing switch and choices`, () => {
  const base: Page = { ...PAGE, secret: false, source: { kind: "selection", tokenIds: ["g1"] }, states: { "token:g1": { way: "server", typedBonus: 4 } } };
  const ready = captureRolls(base);
  assert.ok(ready.buttons.some((button) => button.name.startsWith("Roll ")), JSON.stringify(ready.buttons));
  ready.buttons.find((button) => button.name.startsWith("Roll "))!.onRoll(override);
  const sent = ready.sent.find((op) => op.t === "dice.roll");
  assert.ok(sent?.t === "dice.roll");
  assert.equal(sent.to, override === "secret" ? "dm" : "all");
  assert.equal(sent.rolls[0]!.mode, override === "secret" ? "adv" : override === "normal" ? undefined : override);
  assert.equal(ready.saves.getState().page!.secret, false);
  assert.deepEqual({ ...ready.choices.getState(), last: null }, ready.initial);
  const rolled = ready.saves.getState().page!;
  const retry = captureRolls({ ...rolled, states: { "token:g1": { way: "server", typedBonus: 4, status: "unknown" } } });
  retry.buttons.find((button) => button.name === "Guard's roll")!.onRoll(override);
  const resent = retry.sent.find((op) => op.t === "dice.roll");
  assert.ok(resent?.t === "dice.roll");
  assert.equal(resent.to, override === "secret" ? "dm" : "all");
  assert.equal(resent.rolls[0]!.mode, override === "adv" || override === "dis" ? override : undefined);
  assert.deepEqual({ ...retry.choices.getState(), last: null }, retry.initial);
  const waiting = captureRolls({ ...rolled, rows: rolled.rows.map((r) => ({ ...r, askRef: { tokenId: "g1" }, bonus: 4 })), states: { "token:g1": { way: "ask", asked: { rollId: "request" } } } });
  const button = waiting.buttons.find((b) => b.name === "Guard's requested roll")!;
  button.onRoll(override);
  button.onRoll(override);
  assert.equal(waiting.sent.length, 1, "an outstanding request answer cannot be sent twice");
  const answer = waiting.sent[0];
  assert.ok(answer?.t === "roll.dice");
  assert.equal(answer.unanswered, true);
  assert.equal(answer.mode, override === "adv" || override === "dis" ? override : undefined);
  assert.equal("to" in answer, false, "request visibility stays fixed");
  assert.deepEqual({ ...waiting.choices.getState(), last: null }, waiting.initial);
});

for (const override of ["normal", "secret"] as const) test(`group damage ${override} callback keeps every part and its page envelope`, () => {
  const base = { ...damagePage("1d20 fire + 8 cold + 1d6 radiant"), fill: { name: "Hidden trap", publicName: "Trap", from: "Trap" } };
  const ready = captureRolls(base);
  ready.buttons.find((b) => b.name === "Group damage")!.onRoll(override);
  ready.buttons.find((b) => b.name === "Group damage")!.onRoll(override);
  assert.equal(ready.sent.length, 1, "busy damage cannot send twice");
  const op = ready.sent[0];
  assert.ok(op?.t === "dice.roll");
  assert.equal(op.to, override === "secret" ? "dm" : "all");
  assert.equal(op.rolls.length, 2);
  assert.ok(op.rolls.every((r) => r.mode === undefined));
  assert.deepEqual(op.rolls.map((r) => r.type), ["fire", "radiant"]);
  assert.match(op.rolls[0]!.label!, override === "secret" ? /^Hidden trap damage/ : /^Trap damage/);
  assert.equal(ready.saves.getState().page!.secret, false);
  assert.deepEqual({ ...ready.choices.getState(), last: null }, ready.initial);
});

test("group row details name the returned effective mode", () => {
  const base = damagePage("");
  for (const [fields, words] of [[{ mode: "dis" as const }, "Disadvantage"], [{ cancelled: true as const }, "normal: Advantage and Disadvantage cancelled"]] as const) {
    const page: Page = { ...base, phase: "rolled", states: { "token:g1": { way: "server", rolled: { formula: "1d20+4", faces: [12], total: 16, ...fields } } } };
    assert.ok(drawPage(page).replace(/<[^>]*>/g, "").includes(words));
  }
});

test("group damage result names Secret only from its returned envelope", () => {
  const page = { ...damagePage("1d6 fire"), damage: { tag: "damage", state: "committed" as const, amounts: [4] } };
  const line: import("#shared/model.ts").LogEntry = { id: "1:0", kind: "event", at: "now", data: { type: "dice", tag: "damage", to: "dm", by: DM.memberId, rolls: [{ formula: "1d6", total: 4, faces: [4] }] } };
  assert.match(drawPage(page, [line]), /Rolled, Secret/);
  assert.ok(line.data?.type === "dice");
  line.data.to = "all";
  assert.doesNotMatch(drawPage(page, [line]), /Rolled, Secret/);
  line.data.to = "dm";
  assert.doesNotMatch(drawPage({ ...page, secret: true }, [line]), /Rolled, Secret/);
});


test("ordinary group rows add no plain Normal to their text or name", () => {
  const page: Page = { ...damagePage(""), phase: "rolled", states: { "token:g1": { way: "server", rolled: { formula: "1d20+4", faces: [12], total: 16 } } } };
  const html = drawPage(page);
  assert.doesNotMatch(html, /Normal/);
  assert.match(html, /data-roll-result-base=""[^>]*>Rolled 16 \(1d20\+4: 12\)<\/span>/);
});


test("group result names retain informative cancellation and omit Secret already shown by the page", () => {
  const page: Page = { ...damagePage(""), phase: "rolled", secret: true, states: { "token:g1": { way: "server", rolled: { formula: "1d20+4", faces: [12], total: 16, cancelled: true } } } };
  const html = drawPage(page);
  assert.match(html, /data-roll-result-base=""[^>]*>Rolled 16 \(1d20\+4: 12\), normal: Advantage and Disadvantage cancelled<\/span>/);
  assert.doesNotMatch(html, /data-roll-result-detail/);
  assert.doesNotMatch(html, /aria-label="Rolled[^"]*Secret/);
});


test("group row Secret is informative only when it differs from the page switch", () => {
  const dice = { formula: "1d20+4", faces: [12], total: 16 };
  const page: Page = { ...damagePage(""), phase: "rolled", states: { "token:g1": { way: "server", rolled: dice, batch: { tag: "save", part: 0 } } } };
  const line: import("#shared/model.ts").LogEntry = { id: "1:0", kind: "event", at: "now", data: { type: "dice", tag: "save", to: "dm", by: DM.memberId, rolls: [dice] } };
  assert.match(drawPage(page, [line]), /data-roll-result-missing=""[^>]*>, Secret<\/span>/);
  assert.match(drawPage({ ...page, secret: true }, [line]), /data-roll-result-base=""[^>]*>Rolled 16 \(1d20\+4: 12\)<\/span>/);
  assert.doesNotMatch(drawPage({ ...page, secret: true }, [line]), /aria-label="Rolled[^"]*Secret/);
});


test("group main, row and damage sources ignore unrelated room and row state", () => {
  const view = structuredClone(VIEW);
  view.tokens.other = token("other");
  const base: Page = { ...PAGE, rows: groupRows(DICE, ["g1"], PAGE.test, false), source: { kind: "selection", tokenIds: ["g1"] }, states: { "token:g1": { way: "server", typedBonus: 4 } } };
  for (const page of [base, { ...base, phase: "rolled" as const, states: { "token:g1": { way: "server" as const, typedBonus: 4, status: "unknown" as const } } }, damagePage("1d6 fire")]) {
    const source = (p: Page) => new Map(captureRolls(p, view).buttons.map((b) => [b.name, b.source]));
    const before = source(page);
    view.tokens.other!.x++;
    view.rolls.other = { id: "other", rev: 3, at: "", dcShown: true, resultShown: true, test: { kind: "save", choices: [{ ability: "wis" }] }, targets: [{ tokenId: "other", total: 15 }] };
    assert.deepEqual(source(page), before, "unrelated movement and request answers do not close the menu");
    if (page.test.kind !== "none") {
      view.tokens.g1!.actor = { inline: actor({ effects: [{ id: "bane", key: "baned" }] }) };
      assert.notDeepEqual(source(page), before, "this row's roll preset changes its source");
      view.tokens.g1!.actor = structuredClone(VIEW.tokens.g1!.actor);
    } else assert.notDeepEqual(source({ ...page, outcome: { ...page.outcome, damage: "2d6 fire" } }), before);
  }
});


test("offline damage retains its enabled base tap and guards only menu picks", () => {
  menuBindings = [];
  const html = drawPage(damagePage("1d6 fire"), [], "closed");
  const menu = menuBindings.find((b) => b.name === "Group damage")!;
  assert.ok(menu); assert.equal(!!menu.disabled, false); assert.equal(menu.valid?.(), false);
  const roll = /<button[^>]*aria-keyshortcuts="ContextMenu Shift\+F10"[^>]*>/.exec(html)?.[0];
  assert.ok(roll); assert.doesNotMatch(roll, /disabled=/);
});

test("a group row source ignores its sibling request answer and request bookkeeping", () => {
  let view = structuredClone(VIEW);
  view.tokens.other = token("other");
  view.rolls.request = { id: "request", rev: 1, at: "now", dcShown: true, resultShown: true, test: { kind: "save", choices: [{ ability: "dex" }] }, targets: [{ tokenId: "g1" }, { tokenId: "other" }] };
  const page: Page = { ...PAGE, phase: "rolled", rows: groupRows(DICE, ["g1"], PAGE.test, false).map((row) => ({ ...row, askRef: { tokenId: "g1" }, bonus: 4 })), states: { "token:g1": { way: "ask", asked: { rollId: "request" } } } };
  const source = () => captureRolls(page, view).buttons.find((button) => button.name === "Guard's requested roll")!.source;
  const before = source();
  view = apply(view, { t: "roll.answer", rollId: "request", target: { tokenId: "other" }, total: 15, tag: "sibling-answer" });
  assert.equal(view.rolls.request!.rev, 2);
  assert.equal(source(), before);
  view.rolls.request!.at = "different envelope time";
  assert.equal(source(), before);
  view.rolls.request!.spell = true;
  assert.notEqual(source(), before, "semantic request fields still invalidate this source");
});


test("reopened and relocked pages use the exact lifecycle words and existing controls", () => {
  const page = { ...damagePage("9 fire"), phase: "rolled" as const, test: { kind: "save" as const, ability: "dex" as const }, states: { "token:g1": { way: "server" as const, typed: 18 } } };
  const reopened = drawPage(page, [], "open", { check: "undone", notice: OUTCOME_UNDONE });
  assert.match(reopened, /Outcome undone\. Change the DC, roll again, or apply again\./);
  assert.match(reopened, />Roll saves again<\/button>/);
  assert.match(reopened, />Roll again<\/button>/);
  assert.match(reopened, />Start over<\/button>/);
  const restored = drawPage({ ...page, phase: "applied", apply: "taken" }, [], "open", { check: "applied", notice: OUTCOME_RESTORED });
  assert.match(restored, /Outcome restored\. Undo it before changing this save\./);
  assert.match(restored, /<fieldset disabled=""/);
});

test("checking and unverifiable pages lock editing and storage failure retains the page", () => {
  const page = { ...damagePage("9 fire"), phase: "rolled" as const };
  const pending = drawPage(page, [], "open", { check: "checking" });
  assert.match(pending, /data-save-lifecycle="checking"/);
  assert.match(pending, /<fieldset disabled=""/);
  const unavailable = drawPage(page, [], "open", { check: "unavailable", notice: OUTCOME_UNAVAILABLE, memoryOnly: true });
  assert.match(unavailable, /outcome cannot be checked\. Start a new group save to continue\./);
  assert.ok(unavailable.includes(SAVE_MEMORY_ONLY));
  assert.match(unavailable, /<fieldset disabled=""/);
});


test("Apply captures before any close, embeds recharge, and blocks a second tap", () => {
  const view = structuredClone(VIEW);
  view.monsters.dragon = customMonster("dragon", { actions: [{ name: "Fire Breath (Recharge 5-6)", text: "Dexterity Saving Throw: DC 15. Failure: 9 (2d6 + 2) Fire damage. Success: Half damage." }] });
  view.tokens.g1!.actor = { inline: actor({ monsterId: "dragon", hp: { cur: 30, max: 30, temp: 0 } }) };
  const base = damagePage("9 fire");
  const page: Page = { ...base, fill: { name: "Fire Breath", from: "Fire Breath", recharge: { holder: "t:g1", key: "actions:fire-breath" } }, requests: [{ rollId: "old", holders: ["token:g1"], state: "open" }] };
  const ui = captureRolls(page, view);
  const button = ui.controls.find(control => typeof control.children === "string" && control.children.startsWith("Apply:"));
  assert.ok(button?.onClick);
  button.onClick();
  button.onClick();
  assert.deepEqual(ui.sent.map(op => op.t), ["roll.close", "actor.outcome"]);
  assert.equal(ui.snapshots[0]?.reopen?.beforeApply?.choices.phase, "setup");
  assert.equal(ui.snapshots[0]?.reopen?.beforeApply?.choices.requests[0]?.rollId, "old");
  const outcome = ui.sent[1] as import("#shared/protocol.ts").OpOf<"actor.outcome"> & import("#shared/saveOutcomeContract.ts").SaveOutcomeFields;
  assert.deepEqual(outcome.page, { id: outcome.plan, expectRevision: 0 });
  assert.deepEqual(outcome.recharge, { target: { tokenId: "g1" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true } });
});

test("a page Redo locked again draws Done alone in its foot, with no empty line above it to push it off its middle", () => {
  const relocked = drawPage({ ...damagePage("9 fire"), phase: "applied", apply: "taken", plan: null }, [], "open", { check: "applied", notice: OUTCOME_RESTORED });
  assert.match(relocked, new RegExp(`<div style="display:grid;gap:${theme.space(1)}px"><button[^>]*>Done</button></div>`));
});

test("a reopened row waiting on its ask keeps the typed bonus with its roll, and its switches in a group that fills a line it wraps onto", () => {
  const page: Page = { ...PAGE, phase: "rolled", outcome: { ...PAGE.outcome, damage: "9 fire", onPass: "half" }, rows: groupRows(DICE, ["g1"], PAGE.test, false).map((row) => ({ ...row, askRef: { tokenId: "g1" }, bonus: null })), states: { "token:g1": { way: "ask", asked: { rollId: "request" } } } };
  const markup = drawPage(page, [], "open", { check: "undone", notice: OUTCOME_UNDONE });
  const gap = theme.space(1);
  assert.match(markup, new RegExp(`<div style="display:flex;align-items:center;gap:${gap}px;flex:none"><input aria-label="Bonus for Guard"[^>]*/><button[^>]*>Roll d20</button></div><button[^>]*>Ask again</button><div style="display:flex;flex-wrap:wrap;align-items:center;gap:${gap}px;flex:1 1 auto"><label[^>]*>(?:(?!</label>).)*Evasion`));
});

test("a page that can no longer be checked drops a refused request's note, which asks for steps the page no longer offers", () => {
  const says = "Not saved. The roll request changed. Check its answers and ask again.";
  const page: Page = { ...damagePage("9 fire"), phase: "rolled", test: { kind: "save", ability: "dex" }, requests: [{ rollId: "again", holders: ["token:g1"], state: "refused", says, selected: ["token:g1"] }] };
  assert.ok(drawPage(page, [], "open", { check: "undone", notice: OUTCOME_UNDONE }).includes(says), "a reopened page still says why its request was not saved");
  assert.ok(!drawPage(page, [], "open", { check: "unavailable", notice: OUTCOME_UNAVAILABLE }).includes(says));
});

test("a page that can no longer be checked draws All fail, All pass, the damage, its Roll again, On a pass and Add a condition locked, as an applied page does", () => {
  // A damage-only page reopens in setup, so its outcome is open without a tap on Edit.
  const page: Page = { ...damagePage("1d6 fire"), damage: { tag: "damage", state: "committed", amounts: [4] } };
  const draw = (reopen: SaveReopen) => {
    menuBindings = [];
    const markup = drawPage(page, [], "open", reopen);
    return { markup, damageRoll: menuBindings.find((binding) => binding.name === "Group damage") };
  };
  const locked = (markup: string, name: string) => new RegExp(`<button(?=[^>]*disabled="")[^>]*>${name}</button>`).test(markup);
  const reopened = draw({ check: "undone", notice: OUTCOME_UNDONE });
  assert.match(reopened.markup, />All fail<\/button>/);
  assert.equal(locked(reopened.markup, "All fail"), false);
  assert.ok(reopened.damageRoll && !reopened.damageRoll.disabled, "the reopened damage rolls again");
  assert.ok(reopened.markup.includes("Add a condition"));
  const unavailable = draw({ check: "unavailable", notice: OUTCOME_UNAVAILABLE });
  assert.ok(locked(unavailable.markup, "All fail") && locked(unavailable.markup, "All pass"), "All fail and All pass look locked");
  assert.match(unavailable.markup, /<input(?=[^>]*value="1d6 fire")(?=[^>]*disabled="")[^>]*>/, "the damage field looks locked");
  assert.ok(unavailable.damageRoll?.disabled, "the damage's Roll again looks locked");
  assert.match(unavailable.markup, /role="radiogroup" aria-label="On a pass"[^>]*aria-disabled="true"/);
  assert.ok(!unavailable.markup.includes("Add a condition"), "Add a condition goes, as on an applied page");
});

test("a reopened No save page applies to the creatures its first Apply named, never to another creature its token now stands for", () => {
  const PLAN_ID = "019a4000-0000-7000-8000-000000000001";
  const page: Page = damagePage("9 fire");
  const ledger = { [PLAN_ID]: { memberId: DM.memberId, plan: PLAN_ID, revision: 2, state: "undone" as const, firstAppliedAt: new Date().toISOString(), seq: 0 } };
  const reopen: SaveReopen = { tracking: { id: PLAN_ID, plan: PLAN_ID, revision: 2 }, check: "undone", observed: { revision: 2, state: "undone" }, beforeApply: { version: 1, pageId: page.id, plan: PLAN_ID, choices: captureChoices(page) } };
  const repointed = structuredClone(VIEW) as typeof VIEW & { saveOutcomes: typeof ledger };
  repointed.characters.c1 = character("c1", { name: "Mira", actor: actor({ hp: { cur: 20, max: 20, temp: 0 } }) });
  repointed.tokens.g1!.actor = { ref: "c1" };
  repointed.saveOutcomes = ledger;
  const ui = captureRolls(page, repointed, reopen);
  assert.match(drawPage(page), /aria-label="What they roll"/);
  assert.doesNotMatch(drawPage(page, [], "open", reopen), /aria-label="What they roll"/, "the reopened page keeps its test, which Start over changes");
  const apply = ui.controls.find((control) => typeof control.children === "string" && control.children.startsWith("Apply:"));
  assert.ok(apply?.onClick, JSON.stringify(ui.controls.map((control) => control.children)));
  apply.onClick();
  // The token now stands for Mira, so its row's first creature is gone and nothing goes out. Before, the row was read again
  // from the token, and Mira took the damage and Prone the Guard was dealt.
  assert.deepEqual(ui.sent.filter((op) => op.t === "actor.outcome"), []);
});

test("a row keeps its total field while the connection is down, so a total being typed survives, with its actions waiting", () => {
  const page: Page = { ...PAGE, phase: "rolled", outcome: { ...PAGE.outcome, damage: "9 fire" }, rows: groupRows(DICE, ["g1"], PAGE.test, false), states: { "token:g1": { way: "type" } } };
  const online = drawPage(page, [], "open");
  assert.match(online, /aria-label="Guard&#x27;s total"/);
  const offline = drawPage(page, [], "closed");
  assert.match(offline, /<input(?=[^>]*aria-label="Guard&#x27;s total")(?=[^>]*readOnly="")[^>]*>/, "the field stays, read-only until the connection is back");
  assert.match(offline, /role="radiogroup" aria-label="Guard: fail, pass or skip"[^>]*aria-disabled="true"/);
  // A reopened page offline only waits to check its outcome, and keeps the field too. One that cannot be checked freezes.
  const tracking = { id: "019a4000-0000-7000-8000-000000000001", plan: "019a4000-0000-7000-8000-000000000001", revision: 2 };
  assert.match(drawPage(page, [], "closed", { tracking, check: "checking" }), /aria-label="Guard&#x27;s total"/);
  assert.doesNotMatch(drawPage(page, [], "open", { tracking, check: "unavailable", notice: OUTCOME_UNAVAILABLE }), /aria-label="Guard&#x27;s total"/);
});

test("a first Apply on a device whose clock runs ten minutes fast mints its tracking id from the server's time", () => {
  const fast = 10 * 60 * 1000;
  const ui = captureRolls(damagePage("9 fire"), VIEW, null, { serverOffset: -fast });
  const apply = ui.controls.find((control) => typeof control.children === "string" && control.children.startsWith("Apply:"));
  assert.ok(apply?.onClick);
  const now = Date.now();
  apply.onClick();
  const outcome = ui.sent.find((op) => op.t === "actor.outcome") as (import("#shared/protocol.ts").OpOf<"actor.outcome"> & import("#shared/saveOutcomeContract.ts").SaveOutcomeFields) | undefined;
  assert.ok(outcome?.page, JSON.stringify(ui.sent));
  const minted = Number.parseInt(outcome.page.id.replaceAll("-", "").slice(0, 12), 16);
  assert.ok(Math.abs(minted - (now - fast)) < 5_000, `minted ${minted - now} ms from this device's clock`);
});

test("an Apply the queue let go of with no receipt draws Start over and Discard, and Discard waits while it is still queued", () => {
  const plan = { t: "actor.outcome" as const, plan: "019a4000-0000-7000-8000-000000000002", targets: [{ target: { tokenId: "g1" }, amount: 9 }] };
  const page: Page = { ...damagePage("9 fire"), phase: "applying", apply: "sending", plan };
  const stranded = drawPage(page, [], "open", { check: "unavailable", notice: OUTCOME_UNAVAILABLE });
  assert.match(stranded, />Start over<\/button>/);
  assert.match(stranded, />Discard<\/button>/);
  assert.doesNotMatch(stranded, /Applying…|aria-busy/, "nothing is on its way any more");
  const checking = drawPage(page, [], "open", { check: "checking" });
  assert.doesNotMatch(checking, />Discard<\/button>/);
  assert.match(checking, /Applying…/);
});
