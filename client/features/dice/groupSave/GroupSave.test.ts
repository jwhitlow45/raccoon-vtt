import "../../../components/testing/register.ts";
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../../lib/theme.ts";
import { damageSummary } from "../damageSummaryLines.ts";
import { createStore } from "zustand/vanilla";
import { actor, DM, room, token } from "#shared/testutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { newPage, setAmount, type Page } from "./chain.ts";
import { amountsOf, buildPlan, rowOutcome } from "./plan.ts";
import { groupRows } from "./rows.ts";
import { receiptsSlot } from "../useReceipt.ts";
import { groupSaveSlot } from "./store.ts";

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
function drawPage(page: Page, lines: import("#shared/model.ts").LogEntry[] = [], connection = "open"): string {
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
  saves.setState({ page });
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

function captureRolls(page: Page, view = VIEW) {
  const scope = new RoomScope();
  const saves = scope.get(groupSaveSlot);
  saves.setState({ page });
  saves.getInitialState = saves.getState;
  const choices = scope.get(panelModule.diceChoicesSlot);
  const initial = { adv: true, dis: false, secret: true, secretFor: "g1", version: 19, last: null };
  choices.setState(initial);
  choices.getInitialState = choices.getState;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["g1"], multi: false } }));
  const sent: import("#shared/protocol.ts").ClientOp[] = [];
  const buttons: { name: string; source: string; onRoll(override?: import("../rollMode.ts").RollModeOverride): void }[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)) return;
    const element = value as { type: { name?: string } | string; props: { children?: unknown } };
    if (typeof element.type === "function" && ["GroupSavePage", "GroupRow", "OutcomePanel"].includes(element.type.name)) collect((element.type as (p: never) => unknown)(element.props as never));
    else if (typeof element.type !== "string" && element.type.name === "GroupRollButton") buttons.push(element.props as never);
    else collect(element.props.children);
  }
  function Probe() { collect(groupSave.GroupSave({ parent: "Dice", onBack() {} })); return null; }
  renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { newId: () => "ask", dispatch: (op: import("#shared/protocol.ts").ClientOp) => sent.push(op) } as never, ui: { notify() {} } as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: createElement(Probe) }),
  }));
  return { buttons, sent, saves, choices, initial };
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
