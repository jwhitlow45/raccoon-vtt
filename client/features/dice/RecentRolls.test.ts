import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogNames } from "#shared/logText.ts";
import type { DiceRoll, LogEntry, LogEvent, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { character, member, P1, room, token } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { diceFoldsSlot } from "./diceFolds.ts";
import { recentRolls } from "./logic.ts";

/*
 * Recent rolls as a fold of the Dice panel (docs/design-v1-dice-pass.md 6.1
 * to 6.5 and 7.6): one fold for the device, its newest roll as the folded
 * line, rows evened to a touch target's height with their first line on
 * Again's middle, and the Log's link on the column's edge.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { RecentRolls, recentSummary } = await import("./RecentRolls.tsx");

let seq = 0;
function entry(data: LogEvent): LogEntry {
  return { id: `${++seq}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data };
}

const LONGSWORD: DiceRoll = { formula: "1d20+6", faces: [14], total: 20, label: "Longsword", characterId: "thorn" };
const FREE: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 13 };

function table(log: LogEntry[]): RoomState {
  const state = room({ characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }) }, log });
  state.members.p1 = { ...member("p1"), name: "Pat" };
  state.members.p2 = { ...member("p2"), name: "Bree" };
  state.tokens.gob = token("gob", { name: "Goblin 1" });
  return state;
}

function namesOf(state: RoomState): LogNames {
  return { members: state.members, tokens: state.tokens, characters: state.characters, handouts: state.handouts, encounter: state.encounter };
}

function render(log: LogEntry[], opts: { viewer?: Viewer; folded?: boolean } = {}): string {
  const viewer = opts.viewer ?? P1;
  const state = table(log);
  const view = projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
  const scope = new RoomScope();
  if (opts.folded) scope.get(diceFoldsSlot).tap("recent", false, false);
  const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(RecentRolls, { names: namesOf(view), me: viewer.memberId, open: null, again() {} }) }),
    }),
  );
}

describe("Recent rolls' folded line (6.5)", () => {
  const names = namesOf(table([]));

  test("the newest roll for a creature goes by the creature: its name, its total and its label", () => {
    const rows = recentRolls([entry({ type: "dice", by: "p2", to: "all", rolls: [FREE] }), entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD] })]);
    assert.equal(recentSummary(rows, names, false), "Thorn 20 Longsword");
  });

  test("a free roll goes by its roller, and with no label by its formula", () => {
    const rows = recentRolls([entry({ type: "dice", by: "p2", to: "all", rolls: [FREE] })]);
    assert.equal(recentSummary(rows, names, false), "Bree 13 2d6+3");
  });

  test("a roll for a token goes by the token's name", () => {
    const rows = recentRolls([entry({ type: "dice", by: "dm1", to: "dm", rolls: [{ ...FREE, label: "Scimitar", tokenId: "gob" }] })]);
    assert.equal(recentSummary(rows, names, true), "Goblin 1 13 Scimitar");
  });

  test("a row of several rolls names its first and counts the rest", () => {
    const rows = recentRolls([entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD, { ...LONGSWORD, total: 9 }, { ...LONGSWORD, total: 4 }] })]);
    assert.equal(recentSummary(rows, names, false), "Thorn 20 Longsword and 2 more");
  });

  test("totals read as the rows do, with a thousands comma", () => {
    const rows = recentRolls([entry({ type: "dice", by: "p2", to: "all", rolls: [{ ...FREE, total: 1234 }] })]);
    assert.equal(recentSummary(rows, names, false), "Bree 1,234 2d6+3");
  });

  test("someone else's secret rolls and a request's answer read as their rows do", () => {
    assert.equal(recentSummary([{ kind: "bare", key: "b", by: "p2", count: 1, at: "", ids: ["1:0"] }], names, false), "Bree rolled in secret.");
    assert.equal(recentSummary([{ kind: "bare", key: "b", by: "p2", count: 3, at: "", ids: ["1:0"] }], names, false), "Bree rolled in secret 3 times.");
    const rows = recentRolls([entry({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "thorn", total: 14, dice: { formula: "1d20+2", faces: [12], total: 14 } })]);
    const said = recentSummary(rows, names, false);
    assert.ok(said?.includes("Thorn") && said.includes("14"), said ?? "nothing");
  });

  test("nothing at all with no rolls yet, so the folded row says nothing", () => {
    assert.equal(recentSummary([], names, false), null);
  });
});

describe("Recent rolls folds as a group (6.1 to 6.3)", () => {
  const log = () => [entry({ type: "dice", by: "p2", to: "all", rolls: [FREE] }), entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD] })];

  test("open at first: a fold row named Recent rolls, open, its rows drawn, and no folded line", () => {
    const markup = render(log());
    assert.match(markup, /^<div data-dice-recent=""/);
    assert.match(markup, /<div data-panel-group=""/);
    const fold = /<button type="button" data-group-fold="" aria-labelledby="([^"]+)"[^>]*aria-expanded="true"/.exec(markup);
    assert.ok(fold, "the fold's disclosure, open");
    assert.match(markup, new RegExp(`<span id="${fold[1]}"[^>]*>Recent rolls</span>`), "named by the group's name alone");
    assert.equal([...markup.matchAll(/data-roll-row=/g)].length, 2);
    assert.doesNotMatch(markup, /Thorn 20 Longsword/, "an open group shows no summary");
    assert.match(markup, /Older rolls are in the Log/);
  });

  test("folded: no rows and no Log link drawn, and the newest roll as the fold's description", () => {
    const markup = render(log(), { folded: true });
    const fold = /<button type="button" data-group-fold=""[^>]*aria-describedby="([^"]+)" aria-expanded="false"/.exec(markup);
    assert.ok(fold, "the fold's disclosure, folded, described by its summary");
    assert.match(markup, new RegExp(`<span id="${fold[1]}"[^>]*>Thorn 20 Longsword</span>`));
    assert.doesNotMatch(markup, /data-roll-row=/);
    assert.doesNotMatch(markup, /Older rolls are in the Log/);
  });

  test("with no rolls the empty line shows, and folded there is no description", () => {
    assert.match(render([]), /No rolls yet/);
    assert.doesNotMatch(render([], { folded: true }), /aria-describedby/);
  });
});

describe("Recent rolls' rows (7.6)", () => {
  /** The box of words of the roll line holding `words`. */
  function wordsBox(markup: string, words: string): string {
    const line = '<div style="display:flex;align-items:flex-start;gap:8px">';
    const box = /<div style="display:flex;align-items:flex-start;gap:8px"><div style="([^"]*)"/.exec(markup.slice(markup.lastIndexOf(line, markup.indexOf(words))));
    assert.ok(box, `the words' box of ${words}`);
    return box[1]!;
  }

  test("beside Again, the words' first line stands on its middle: 10 px down a 44 px floor, the lines from the top", () => {
    const box = wordsBox(render([entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD] })]), "Longsword");
    assert.match(box, /align-content:flex-start/);
    assert.match(box, /line-height:24px/);
    assert.match(box, new RegExp(`padding-top:${(theme.touch - 24) / 2}px;min-height:${theme.touch}px`));
  });

  test("a row of one roll with no Again splits Again's 10 px above and below its words, so rows of the same lines share a height, its words in its middle", () => {
    const markup = render([entry({ type: "dice", by: "p2", to: "all", rolls: [FREE] })]);
    assert.doesNotMatch(markup, /Roll again/, "Bree's roll offers Pat no Again");
    const box = wordsBox(markup, "2d6+3");
    assert.match(box, /align-content:center/);
    const half = (theme.touch - 24) / 4;
    assert.match(box, new RegExp(`padding-top:${half}px;padding-bottom:${half}px;min-height:${theme.touch}px`));
  });

  test("a row of several rolls keeps its earlier lines to their words' height, and only Again's line takes its floor", () => {
    const markup = render([entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD, { ...LONGSWORD, total: 9, label: "Second" }] })]);
    assert.doesNotMatch(wordsBox(markup, ">Thorn, Longsword<"), /min-height/);
    assert.match(wordsBox(markup, ">Thorn, Second<"), new RegExp(`min-height:${theme.touch}px`));
  });

  test("a row's last part grows to its line's end, so one that wraps alone fills its line, and the dice wrap in a box of their own", () => {
    const markup = render([entry({ type: "dice", by: "p2", to: "all", rolls: [{ ...FREE, formula: "1d20+3", faces: [20], total: 23, label: "Perception" }] })]);
    const last = /<span style="flex:1 0 auto;display:flex;align-items:center;min-width:0;max-width:100%">(.*?)<\/span><\/div>/.exec(markup);
    assert.ok(last, "the last part's growing box closes the words' row");
    assert.match(last[1]!, /Natural 20/, "the verdict, last here");
    assert.equal([...markup.matchAll(/flex:1 0 auto/g)].length, 1, "one growing part per roll line");
    assert.doesNotMatch(markup, /display:contents/, "no box-less wrapper around the dice");
    assert.match(markup, /<span style="display:inline-flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:4px;min-width:0"><span style="[^"]*">1d20\+3<\/span><span style="display:inline-flex;min-width:0"><span aria-hidden="true"/, "the formula and its dice wrap as one");
    assert.match(markup, /<span aria-hidden="true" style="display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0"><span data-face=""/);
  });

  test("someone's secret rolls hold the floor too", () => {
    const markup = render([entry({ type: "dice", by: "p2", to: "dm", rolls: [FREE] })]);
    assert.match(markup, new RegExp(`<div style="display:grid;align-content:center;min-height:${theme.touch}px">Bree rolled in secret.</div>`));
  });

  test("Older rolls are in the Log stands out by a quiet button's padding and border, so its words start on the column's edge", () => {
    const markup = render([]);
    assert.match(markup, new RegExp(`margin-inline-start:-${theme.space(3) + theme.line.border}px">Older rolls are in the Log`));
  });
});

test("only own homogeneous d20 repeats get a menu, and fixed repeats omit Secret from their hint", () => {
  const own = render([entry({ type: "dice", by: "p1", to: "all", rolls: [LONGSWORD] })]);
  assert.match(own, /aria-label="Roll again:[^"]*"[^>]*aria-haspopup="menu"/);
  assert.match(own, /Hold, right-click or Shift\+F10 for Advantage, Disadvantage or Normal/);
  for (const rolls of [[FREE], [LONGSWORD, FREE], [{ ...LONGSWORD, type: "fire" as const }]]) {
    const html = render([entry({ type: "dice", by: "p1", to: "all", rolls })]);
    assert.doesNotMatch(html, /aria-haspopup|aria-keyshortcuts|Hold, right-click/);
    assert.match(html, /aria-label="Roll again:/);
  }
  const other = render([entry({ type: "dice", by: "p2", to: "all", rolls: [LONGSWORD] })]);
  assert.doesNotMatch(other, /aria-haspopup|Roll again:/);
});

test("plain and cancelled d20 rows keep the same visible words without another mode label", () => {
  const draw = (roll: DiceRoll) => render([entry({ type: "dice", by: "p1", to: "all", rolls: [roll] })]);
  const words = (markup: string) => markup
    .replace(/<span\b[^>]*\bhidden=""[^>]*>[^<]*<\/span>/g, "")
    .replace(/<span style="position:absolute;[^"]*"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
  const plain = draw(LONGSWORD);
  assert.match(words(plain), /Longsword/);
  assert.match(words(plain), /1d20\+6/);
  assert.doesNotMatch(words(plain), /Normal|Advantage|Disadvantage/);
  assert.doesNotMatch(plain, />Normal<\/span>/, "plain rolls gain no extra mode description either");
  const cancelled = draw({ ...LONGSWORD, cancelled: true });
  assert.equal(words(cancelled), words(plain), "cancellation adds no words that can wrap into another line");
  assert.match(cancelled, /<span style="position:absolute;[^"]*">Normal: Advantage and Disadvantage cancelled<\/span>/);
});
