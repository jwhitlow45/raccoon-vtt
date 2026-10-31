import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, room } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";
import { receiptsSlot } from "./useReceipt.ts";

/*
 * The roller's part of the dice pass (docs/design-v1-dice-pass.md 4, 7.4
 * and 7.7): the roll modes as "Next roll" with Adv and Dis joined and
 * Secret apart, the sticky line's row in the middle of its painted box,
 * and the quick dice standing on the field's edge.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { LastResult, RollModes, Roller } = await import("./Roller.tsx");

function modes(props: Partial<Parameters<typeof RollModes>[0]> = {}): string {
  return renderToStaticMarkup(createElement(RollModes, { adv: false, dis: false, secret: false, dm: true, onPress() {}, ...props }));
}

/** Each button's opening tag, by its name. */
function buttons(markup: string): Map<string, string> {
  return new Map([...markup.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => [m[1]!, m[0]]));
}

function inRoom(viewer: Viewer, children: unknown[], scope = new RoomScope(), connection = "open"): string {
  const view = projectState(room(), viewer, { sceneId: "s1" }) as unknown as RoomState;
  const store = createStore(() => ({ view, roomId: "r1", connection, you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: children as never }),
    }),
  );
}

describe("the roll modes: Next roll, Adv and Dis joined, Secret apart (4)", () => {
  test("one group named For the next roll, marked, with the visible words inside its name and heard once", () => {
    const markup = modes();
    assert.match(markup, /^<div role="group" aria-label="For the next roll" data-dice-modes=""/);
    const label = /<span aria-hidden="true" style="([^"]*)">Next roll<\/span>/.exec(markup);
    assert.ok(label, "the visible words, hidden from a screen reader, which hears the group's name");
    assert.match(label[1]!, new RegExp(`font-size:${theme.font.small}px;font-weight:${theme.weight.bold}`));
    assert.match(label[1]!, /text-transform:uppercase/);
    assert.match(markup, /^<div[^>]*style="display:flex;flex-wrap:wrap;align-items:center;gap:8px"/, "the label centered on the controls' middle, 8 px apart");
  });

  test("three toggles by their names, in reading order Adv, Dis, Secret, each with aria-pressed", () => {
    const named = buttons(modes({ dm: true }));
    assert.deepEqual([...named.keys()], ["Advantage", "Disadvantage", "Hide from players"]);
    for (const tag of named.values()) assert.match(tag, /aria-pressed="false"/);
    assert.deepEqual([...buttons(modes({ dm: false })).keys()], ["Advantage", "Disadvantage", "Only the DM sees it"]);
    const markup = modes();
    assert.ok(markup.indexOf(">Adv<") < markup.indexOf(">Dis<") && markup.indexOf(">Dis<") < markup.indexOf("Secret<"));
  });

  test("Adv and Dis are one pill split by one line: their outer corners round, the end half over the start half's edge", () => {
    const named = buttons(modes());
    const adv = named.get("Advantage")!;
    const dis = named.get("Disadvantage")!;
    assert.match(adv, new RegExp(`border-radius:${theme.radius.pill}px 0 0 ${theme.radius.pill}px`));
    assert.match(dis, new RegExp(`border-radius:0 ${theme.radius.pill}px ${theme.radius.pill}px 0`));
    assert.match(dis, /margin-inline-start:-1px/);
    assert.match(adv, /margin-inline-start:0/);
    for (const tag of [adv, dis]) assert.match(tag, new RegExp(`min-height:${theme.touch}px`));
    // Both halves in one box, Secret in a box of its own after it.
    const pair = /<div style="display:flex;flex:none">(.*?)<\/div>/.exec(modes());
    assert.ok(pair, "the pair's own box");
    assert.match(pair[1]!, /Advantage[\s\S]*Disadvantage/);
    assert.doesNotMatch(pair[1]!, /Secret/);
  });

  test("Secret stands apart as a pill with its eye, its own width while it shares the line", () => {
    const markup = modes();
    const secret = /<span data-dice-secret="" style="([^"]*)">([\s\S]*?)<\/span><\/div>$/.exec(markup);
    assert.ok(secret, "Secret's box, last in the row");
    assert.match(secret[1]!, /display:grid;flex:none/);
    assert.match(secret[2]!, new RegExp(`border-radius:${theme.radius.pill}px`));
    assert.match(secret[2]!, /<svg/);
  });

  test("the pressed half takes the app's pressed look and stands over the other, so the split line shows in its accent", () => {
    const named = buttons(modes({ adv: true }));
    const adv = named.get("Advantage")!;
    const dis = named.get("Disadvantage")!;
    assert.match(adv, /aria-pressed="true"/);
    assert.ok(adv.includes(`background:${theme.color.accentTint};border:1px solid ${theme.color.accent}`), "the accent's tint inside an accent outline");
    assert.match(adv, /z-index:1/);
    assert.match(dis, /aria-pressed="false"/);
    assert.ok(dis.includes(`border:1px solid ${theme.color.border}`));
    assert.match(dis, /z-index:0/);
    assert.match(buttons(modes({ dis: true })).get("Disadvantage")!, /z-index:1/);
    assert.match(buttons(modes({ secret: true })).get("Hide from players")!, /aria-pressed="true"/);
  });
});

describe("the roller's frame (7.4, 7.7, 7.9)", () => {
  test("the sticky line gives the pane's top padding back half above its row and half below, its height unchanged", () => {
    const scope = new RoomScope();
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ last: { error: "Not a dice formula", at: 1 } });
    choices.getInitialState = choices.getState;
    const markup = inRoom(DM, [createElement(LastResult, { key: "last", onOpen() {} })], scope);
    const line = /<div data-dice-last="" style="([^"]*)"/.exec(markup);
    assert.ok(line);
    assert.match(line[1]!, /margin:calc\(-1 \* var\(--pane-pad-top, 0px\)\) 0 0;padding:calc\(var\(--pane-pad-top, 0px\) \/ 2\) 0/);
    assert.match(markup, new RegExp(`min-height:${theme.touch}px`), "its row one touch target tall");
  });

  test("the quick dice stand 3 px wider on each side than the column, the room their end rings keep, so the d20 starts on the field's edge", () => {
    const markup = inRoom(P1, [createElement(Roller, { key: "roller" })]);
    assert.match(markup, /<div style="position:relative;display:flex;min-width:0;margin-inline:-3px"><div aria-label="Quick dice"/, "the strip's outer box, in the pane's padding");
    assert.match(markup, /aria-label="Quick dice"[^>]*style="[^"]*padding-inline:3px/);
    const first = markup.indexOf('aria-label="Add a d20"');
    assert.ok(first > 0 && first < markup.indexOf('aria-label="Add a d4"'), "the d20 leads");
  });

  test("the field's hint is the long one until the field is measured too narrow for it", () => {
    const markup = inRoom(P1, [createElement(Roller, { key: "roller" })]);
    assert.match(markup, /placeholder="1d20\+5 or 2d6\+3 fire"/);
  });

  test("the roll modes sit last in the roller, after the quick dice", () => {
    const markup = inRoom(P1, [createElement(Roller, { key: "roller" })]);
    assert.ok(markup.indexOf("Quick dice") < markup.indexOf("data-dice-modes"));
    assert.match(markup, /aria-label="Only the DM sees it"/);
  });
});

test("the discoverability help sits outside the unchanged modes and quick-dice rows", () => {
  const html = inRoom(P1, [createElement(Roller)]);
  assert.match(html, /Hold or right-click a roll button for one-roll options\. Keyboard: Shift\+F10\./);
  assert.ok(html.indexOf("data-roll-mode-help") > html.indexOf("data-dice-modes"));
  for (const button of buttons(html).values()) if (button.includes("Add a d")) assert.doesNotMatch(button, /aria-haspopup|aria-keyshortcuts/);
});
test("the result announcement names returned effective modes and secrecy once", async () => {
  const { spokenResult } = await import("./Roller.tsx");
  const dice = [{ formula: "1d20+5", faces: [10], total: 15, cancelled: true as const }];
  assert.equal(spokenResult({ total: 15, label: "Dexterity save", sums: null, dice, more: 0 }, null, undefined, true), "Rolled 15: Dexterity save, Normal: Advantage and Disadvantage cancelled, Secret.");
  assert.equal(spokenResult({ total: 15, label: "Stealth check", sums: "10 + 5", dice: [{ ...dice[0]!, mode: "adv", cancelled: undefined }], more: 0 }, "Pass"), "Rolled 15 (10 + 5), Pass: Stealth check, Advantage.");
  assert.equal(spokenResult({ total: 15, label: undefined, sums: null, dice: [{ ...dice[0]!, cancelled: undefined }], more: 0 }, null), "Rolled 15, Normal.");
});

test("offline sticky Again reaches the existing connection error handler", () => {
  const scope = new RoomScope();
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ last: { tag: "previous", rolls: [{ formula: "1d20+5" }], to: "all" } });
  choices.getInitialState = choices.getState;
  scope.get(receiptsSlot).answer("previous", 0, "taken");
  type Node = { props?: { children?: unknown; icon?: string; onClick?(e: unknown): void } };
  let click: ((e: unknown) => void) | undefined;
  const find = (tree: unknown): void => {
    if (Array.isArray(tree)) { tree.forEach(find); return; }
    const node = tree as Node | null;
    if (!node?.props) return;
    if (node.props.icon === "again") click = node.props.onClick;
    find(node.props.children);
  };
  function Probe() { find(LastResult({ onOpen() {} })); return null; }
  inRoom(P1, [createElement(Probe)], scope, "closed");
  assert.ok(click);
  click({ detail: 1 });
  assert.ok(choices.getState().last && "error" in choices.getState().last!);
  assert.equal((choices.getState().last as { error: string }).error, "Rolling needs a connection.");
});
