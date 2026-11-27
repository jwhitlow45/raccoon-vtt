import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import type { DiceRoll, LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, room } from "#shared/testutil.ts";
import { optionSlot } from "./optionState.ts";
import { ReceiptTracker, receiptsSlot } from "./useReceipt.ts";

/*
 * A stat block's roll header (docs/design/design-v1-token-roll-header.md 3
 * and 5, carrying over docs/design/design-v1-stat-block-rolls.md 8): the roll
 * it sent shown at the top of the panel in the Dice panel's look, its row a
 * fixed 44 px, its mode words only for a roll from a choice and worded from
 * the returned roll, and one announcer per roll.
 */

// useThrows.ts reads the parts gate, a .tsx module, so it loads after the register hooks.
const { throwsSlot } = await import("./throw/useThrows.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { BlockHeader, BlockHeaderHost, modeWords } = await import("./BlockHeader.tsx");
const { PanelHere } = await import("../panels.ts");

const die = (extra: Partial<DiceRoll> = {}): DiceRoll => ({ formula: "1d20+5", faces: [10], total: 15, label: "Dexterity save", ...extra });

function line(tag: string, roll: DiceRoll, to: "all" | "dm" = "all"): LogEntry {
  return { id: `1:${tag}`, at: "", kind: "event", data: { type: "dice", tag, by: "dm1", to, rolls: [roll] } } as LogEntry;
}

/** A scope whose tracker holds `lines` as the log, with every tag in `answers` already answered. */
function scopeWith(lines: LogEntry[]) {
  const scope = new RoomScope();
  const tracker = scope.get(receiptsSlot) as ReceiptTracker;
  tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => lines };
  return { scope, tracker };
}

function render(scope: InstanceType<typeof RoomScope>, outcome: Parameters<typeof BlockHeader>[0]["outcome"], viewer: Viewer = DM, shown = true, child?: ReactNode): string {
  const view = projectState(room(), viewer, { sceneId: "s1" }) as unknown as RoomState;
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(PanelHere, { id: "token", shown, children: child ?? createElement(BlockHeader, { outcome, host: null }) }) as never }),
    }),
  );
}

const sent = (tag: string, override?: "adv" | "dis" | "secret" | "normal", label = "Dexterity save") => ({ kind: "sent" as const, sent: { tag, label, ...(override ? { override } : {}) } });

describe("the mode words (D-261031-134)", () => {
  test("a tap names no mode, whatever the returned roll holds", () => {
    assert.equal(modeWords(undefined, die({ mode: "dis" }), false), "");
    assert.equal(modeWords(undefined, die({ cancelled: true }), true), "");
  });

  test("a picked Advantage or Disadvantage is worded from the returned roll", () => {
    assert.equal(modeWords("adv", die({ mode: "adv" }), false), "with Advantage");
    assert.equal(modeWords("dis", die({ mode: "dis" }), false), "with Disadvantage");
  });

  test("a pick a condition cancelled says so, and one that left no mode says nothing", () => {
    assert.equal(modeWords("adv", die({ cancelled: true }), false), "Advantage and Disadvantage cancelled");
    assert.equal(modeWords("dis", die(), false), "");
  });

  test("a pick whose roll came back with the other mode says the roll's, never the pick's", () => {
    assert.equal(modeWords("adv", die({ mode: "dis" }), false), "with Disadvantage");
  });

  test("Roll secretly says secret only when the roll went to the DM", () => {
    assert.equal(modeWords("secret", die(), true), "secret");
    assert.equal(modeWords("secret", die(), false), "");
  });

  test("a plain Normal pick adds no word, and Normal is never written", () => {
    assert.equal(modeWords("normal", die(), false), "");
  });
});

/** The line's row, which holds every state. */
function rowOf(markup: string): string {
  const row = /<div data-block-header-row="" style="([^"]*)"/.exec(markup);
  assert.ok(row, "the line has its row");
  return row[1]!;
}

describe("the line", () => {
  test("a tap that did not go shows its words as an alert", () => {
    const { scope } = scopeWith([]);
    const markup = render(scope, { kind: "unsent", words: "Rolling needs a connection." });
    assert.match(markup, /data-block-header=""/);
    assert.match(markup, /<span role="alert"[^>]*>Rolling needs a connection\.<\/span>/);
  });

  test("it sticks to the pane's top in the Dice panel's look, over the pane's side padding too, and its row is exactly 44 px tall", () => {
    const { scope, tracker } = scopeWith([line("T", die())]);
    tracker.answer("T", 0, "taken");
    const markup = render(scope, sent("T"));
    const outer = /<div data-block-header="" style="([^"]*)"/.exec(markup)![1]!;
    assert.match(outer, /position:sticky;top:calc\(-1 \* var\(--pane-pad-top, 0px\)\)/);
    assert.match(outer, /box-shadow:calc\(-1 \* var\(--pane-pad-x, 0px\)\) 0 0/);
    assert.match(outer, /border-bottom:1px solid/);
    const row = rowOf(markup);
    assert.match(row, /(^|;)height:44px/);
    assert.doesNotMatch(row, /min-height/, "height, not minHeight, so no state grows it");
  });

  test("before any roll the host draws its content alone, with the foot spacer after it and no line", () => {
    const { scope } = scopeWith([]);
    const markup = render(scope, sent("x"), DM, true, createElement(BlockHeaderHost, { children: createElement("p", null, "Thorn") }));
    assert.equal(markup, '<div data-block-header-host=""><p>Thorn</p><div aria-hidden="true" data-block-header-spacer=""></div></div>');
  });

  test("a waiting roll holds the line with no result in it yet", () => {
    const { scope, tracker } = scopeWith([]);
    tracker.sending("W", 0);
    const markup = render(scope, sent("W"));
    assert.match(markup, /data-block-header=""/);
    assert.doesNotMatch(markup, /Rolled/);
  });

  test("while the dice fly the line keeps what it showed at the answer: \"Rolling…\" only with the store's rolling, else an empty band", () => {
    for (const rolling of [true, false]) {
      const { scope, tracker } = scopeWith([line("F", die())]);
      tracker.answer("F", 0, "taken");
      scope.get(throwsSlot).store.view = () => ({ held: "F", rolling, shown: null });
      const markup = render(scope, sent("F"));
      assert.doesNotMatch(markup, />15</, "no total until the landing");
      assert.equal(/Rolling…/.test(markup), rolling, `rolling ${rolling}`);
      assert.match(markup, /aria-live="polite"[^>]*>Rolled 15/, "said at the answer, before the dice land");
    }
  });

  test("a tap's result shows the total and its label, no mode words, and is said once with the total", () => {
    const { scope, tracker } = scopeWith([line("T", die({ mode: "dis" }))]);
    tracker.sending("T", 0);
    tracker.answer("T", 0, "taken");
    const markup = render(scope, sent("T"));
    assert.match(markup, />15</);
    assert.match(markup, /Dexterity save/);
    assert.doesNotMatch(markup, /data-result-mode/);
    assert.match(markup, /aria-live="polite"[^>]*>Rolled 15: Dexterity save, Disadvantage\.<\/span>/);
  });

  test("an answer's roll, which has no label of its own, is shown and said with the row's label (LP27-A-BLOCK-3)", () => {
    const { label: _, ...bare } = die({ total: 23, faces: [17], formula: "1d20+6" });
    const answer = { id: "1:N", at: "", kind: "event", data: { type: "roll", test: { kind: "save", ability: "wis" }, tag: "N", characterId: "c1", dc: 15, dcShown: true, resultShown: true, total: 23, result: "pass", dice: bare } } as unknown as LogEntry;
    const { scope, tracker } = scopeWith([answer]);
    tracker.answer("N", 0, "taken");
    const markup = render(scope, sent("N", undefined, "Wisdom save"));
    assert.match(markup, />23</);
    assert.match(markup, /data-result-label=""[^>]*>Wisdom save</);
    assert.match(markup, /aria-live="polite"[^>]*>Rolled 23, Pass: Wisdom save, Normal\.<\/span>/);
  });

  test("a picked Advantage adds its words as the line's last part, hidden from a reader, and the description keeps the mode", () => {
    const { scope, tracker } = scopeWith([line("A", die({ mode: "adv" }))]);
    tracker.sending("A", 0);
    tracker.answer("A", 0, "taken");
    const markup = render(scope, sent("A", "adv"));
    assert.match(markup, /<span aria-hidden="true" data-result-mode=""[^>]*>with Advantage<\/span>/);
    assert.match(markup, /aria-description="Advantage"/);
    assert.ok(markup.indexOf("Dexterity save") < markup.indexOf("data-result-mode"), "after the label");
  });

  test("Roll secretly names secret from the returned envelope, and a roll that stayed open names nothing", () => {
    const secret = scopeWith([line("S", die(), "dm")]);
    secret.tracker.answer("S", 0, "taken");
    assert.match(render(secret.scope, sent("S", "secret")), />secret<\/span>/);
    const open = scopeWith([line("O", die(), "all")]);
    open.tracker.answer("O", 0, "taken");
    assert.doesNotMatch(render(open.scope, sent("O", "secret")), /data-result-mode/);
  });

  test("a cancelled pick reads as cancelled, never as the pick", () => {
    const { scope, tracker } = scopeWith([line("C", die({ cancelled: true }))]);
    tracker.answer("C", 0, "taken");
    const markup = render(scope, sent("C", "adv"));
    assert.match(markup, /Advantage and Disadvantage cancelled<\/span>/);
    assert.doesNotMatch(markup, /with Advantage/);
  });

  test("a refusal shows the server's words as an alert, and the line has no Again and no button to open Recent rolls", () => {
    const { scope, tracker } = scopeWith([]);
    tracker.answer("R", 0, "refused", { code: "forbidden", message: "You roll only for your own creatures.", text: "You roll only for your own creatures." });
    const markup = render(scope, sent("R"));
    assert.match(markup, /<span role="alert"[^>]*>You roll only for your own creatures\.<\/span>/);
    assert.doesNotMatch(markup, /Again|<button/);
  });

  test("plain words clip at two lines of small type and stay whole in the DOM and the title (3.2)", () => {
    const long = "The server refused this roll for a reason long enough to need three lines at 320 by 568 at 130%, so it ends in an ellipsis.";
    const { scope, tracker } = scopeWith([]);
    tracker.answer("L", 0, "refused", { code: "forbidden", message: long, text: long });
    const markup = render(scope, sent("L"));
    const words = new RegExp(`<span role="alert" title="${long.replace(/[.%]/g, "\\$&")}" style="([^"]*)">${long.replace(/[.%]/g, "\\$&")}</span>`).exec(markup);
    assert.ok(words, "whole in the DOM and the title");
    assert.match(words[1]!, /display:-webkit-box/);
    assert.match(words[1]!, /-webkit-line-clamp:2/);
    assert.match(words[1]!, /-webkit-box-orient:vertical/);
    assert.match(words[1]!, /overflow:hidden/);
    assert.match(words[1]!, /font-size:13px/);
    assert.match(rowOf(markup), /(^|;)height:44px/);
  });

  test("unknown and no-longer-in-the-log read as the Dice panel's line words them", async () => {
    const unknown = scopeWith([]);
    unknown.tracker.sending("U", 0);
    await unknown.tracker.lookup("U");
    assert.match(render(unknown.scope, sent("U")), /This may have happened\. Check the log\./);
    const gone = scopeWith([]);
    gone.tracker.answer("G", 0, "taken");
    assert.match(render(gone.scope, sent("G")), /Rolled\. Its result is no longer in the log\./);
  });

  test("Initiative written too late adds a second small row under the label and chips, inside the same 44 px row", () => {
    const { scope, tracker } = scopeWith([line("I", die())]);
    tracker.answer("I", 0, "taken");
    const options = scope.get(optionSlot);
    options.setState({ acted: { "I:changed": true } });
    // A server render reads the initial state, as Roller.test.ts does for the panel's store.
    options.getInitialState = options.getState;
    const markup = render(scope, sent("I"));
    assert.match(markup, /<span data-block-header-note="" style="[^"]*font-size:13px[^"]*">Not set: the row changed meanwhile\.<\/span>/);
    assert.match(rowOf(markup), /(^|;)height:44px/);
    const row = markup.slice(markup.indexOf("data-block-header-row"), markup.indexOf('role="status"'));
    assert.ok(row.indexOf(">15<") < row.indexOf("data-result-label") && row.indexOf("data-result-label") < row.indexOf("data-block-header-note"), "the total, then the label, then the note under it, all in the row");
  });
});

describe("one announcer per roll (D-261031-133)", () => {
  // Real only once lane A's tracker holds claims. On its stubs a claim changes nothing, so the cases wait for it.
  const real = (() => {
    const t = new ReceiptTracker();
    t.claimVoice("x");
    return !t.maySpeak("x", false);
  })();

  test("the line claims its tag and says the result", { skip: !real }, () => {
    const { scope, tracker } = scopeWith([line("V", die())]);
    tracker.answer("V", 0, "taken");
    assert.match(render(scope, sent("V")), /aria-live="polite"[^>]*>Rolled 15/);
  });

  test("the line speaks as the sender while a claim is held elsewhere, and shows a roll the toast or another surface already said silent", { skip: !real }, () => {
    const { scope, tracker } = scopeWith([line("D", die())]);
    tracker.answer("D", 0, "taken");
    tracker.claimVoice("D");
    assert.match(render(scope, sent("D")), /aria-live="polite"[^>]*>Rolled 15/);
    tracker.spoken("D");
    const html = render(scope, sent("D"));
    assert.match(html, />15</, "the result still shows");
    assert.doesNotMatch(html, /aria-live="polite"[^>]*>Rolled/, "and its live region says nothing");
  });
});

describe("a hidden sheet or pane (SBR-SOL-002)", () => {
  test("it shows no result, watches no receipt and says nothing, and shows it again when shown", () => {
    const { scope, tracker } = scopeWith([line("H", die())]);
    tracker.answer("H", 0, "taken");
    const hidden = render(scope, sent("H"), DM, false);
    assert.match(hidden, /data-block-header=""/, "the line stays for the return");
    assert.doesNotMatch(hidden, />15</);
    assert.match(hidden, /aria-live="polite"[^>]*><\/span>/);
    assert.match(render(scope, sent("H"), DM, true), />15</);
  });
});
