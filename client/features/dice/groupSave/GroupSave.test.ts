import "../../../components/testing/register.ts";
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
import { groupSaveSlot } from "./store.ts";

/*
 * The open group save in the Dice panel (docs/design-v1-dice-pass.md 7.8):
 * an info notice with Open, so a DM reads an unfinished group save as a
 * status rather than a sentence among the rolls.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
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
function drawPage(page: Page): string {
  const scope = new RoomScope();
  const saves = scope.get(groupSaveSlot);
  saves.setState({ page });
  saves.getInitialState = saves.getState;
  const store = createStore(() => ({ view: VIEW, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: ["g1"], multi: false } }));
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
