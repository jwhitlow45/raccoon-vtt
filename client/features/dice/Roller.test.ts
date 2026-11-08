import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, room } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { diceChoicesSlot } from "./useDicePanel.ts";
import { ReceiptTracker, receiptsSlot } from "./useReceipt.ts";

/*
 * The roller's part of the dice pass (docs/design/design-v1-dice-pass.md 4, 7.4
 * and 7.7): the roll modes as "Next roll" with Adv and Dis joined and
 * Secret apart, the sticky line's row in the middle of its painted box,
 * and the quick dice standing on the field's edge.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { LastResult, RollModes, Roller, settleDropped, wrappedOut } = await import("./Roller.tsx");
const { PanelHere } = await import("../panels.ts");

function modes(props: Partial<Parameters<typeof RollModes>[0]> = {}): string {
  return renderToStaticMarkup(createElement(RollModes, { adv: false, dis: false, secret: false, dm: true, onPress() {}, ...props }));
}

/** Each button's opening tag, by its name. */
function buttons(markup: string): Map<string, string> {
  return new Map([...markup.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => [m[1]!, m[0]]));
}

function inRoom(viewer: Viewer, children: unknown[], scope = new RoomScope(), connection = "open", shown = true): string {
  const view = projectState(room(), viewer, { sceneId: "s1" }) as unknown as RoomState;
  const store = createStore(() => ({ view, roomId: "r1", connection, you: viewer, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1 } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope, children: createElement(PanelHere, { id: "dice", shown }, ...(children as never[])) as never }),
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

describe("one announcer per roll: the sticky line yields to the surface that sent the roll (docs/design/design-v1-stat-block-rolls.md 8)", () => {
  // Real only once the tracker holds claims. On the contract's stubs a claim changes nothing.
  const real = (() => {
    const probe = new ReceiptTracker();
    probe.claimVoice("x");
    return !probe.maySpeak("x", false);
  })();

  function sticky(settle: (tracker: ReceiptTracker) => void, before?: (tracker: ReceiptTracker) => void): string {
    const scope = new RoomScope();
    const choices = scope.get(diceChoicesSlot);
    choices.setState({ last: { tag: "B", rolls: [{ formula: "1d20+5" }], to: "all" } });
    choices.getInitialState = choices.getState;
    const tracker = scope.get(receiptsSlot);
    const log = [{ id: "1:0", at: "", kind: "event", data: { type: "dice", tag: "B", by: "dm1", to: "all", rolls: [{ formula: "1d20+5", faces: [10], total: 15, label: "Dexterity save" }] } }];
    tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => log as never };
    before?.(tracker);
    settle(tracker);
    return inRoom(DM, [createElement(LastResult, { key: "last", onOpen() {} })], scope);
  }
  const taken = (t: ReceiptTracker) => t.answer("B", 0, "taken");
  const refused = (t: ReceiptTracker) => t.answer("B", 0, "refused", { code: "forbidden", message: "Nope.", text: "Nope." });

  test("a block's roll shows in the line and the line says nothing", { skip: !real }, () => {
    const markup = sticky(taken, (t) => void t.claimVoice("B"));
    assert.match(markup, />15</, "the result still shows");
    assert.match(markup, /aria-live="polite"[^>]*><\/span>/, "its live region stays empty");
  });

  test("a block's refused roll shows in the line with no alert role", { skip: !real }, () => {
    const markup = sticky(refused, (t) => void t.claimVoice("B"));
    assert.match(markup, /<span style="color:[^"]*">Nope\.<\/span>/);
    assert.doesNotMatch(markup, /role="alert"/);
  });

  test("a claim released before anyone said the roll lets the line say it once", { skip: !real }, () => {
    const markup = sticky(taken, (t) => t.claimVoice("B")());
    assert.match(markup, /aria-live="polite"[^>]*>Rolled 15/);
    const refusal = sticky(refused, (t) => t.claimVoice("B")());
    assert.match(refusal, /role="alert"[^>]*>Nope\./);
  });

  test("a panel roll nobody claims is said by the line as before", () => {
    const markup = sticky(taken);
    assert.match(markup, /aria-live="polite"[^>]*>Rolled 15/);
    assert.match(sticky(refused), /role="alert"[^>]*>Nope\./);
  });
});

test("a hidden Dice pane's sticky line shows nothing of the roll and says nothing, so the toast can (docs/design/design-v1-stat-block-rolls.md 8)", () => {
  const scope = new RoomScope();
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ last: { tag: "H", rolls: [{ formula: "1d20+5" }], to: "all" } });
  choices.getInitialState = choices.getState;
  const tracker = scope.get(receiptsSlot);
  const log = [{ id: "1:0", at: "", kind: "event", data: { type: "dice", tag: "H", by: "dm1", to: "all", rolls: [{ formula: "1d20+5", faces: [10], total: 15, label: "Acrobatics" }] } }];
  tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => log as never };
  tracker.answer("H", 0, "taken");
  const line = (shown: boolean) => inRoom(DM, [createElement(LastResult, { key: "last", onOpen() {} })], scope, "open", shown);
  const hidden = line(false);
  assert.doesNotMatch(hidden, />15</);
  assert.doesNotMatch(hidden, /Rolled 15/);
  assert.match(line(true), /aria-live="polite"[^>]*>Rolled 15/);
});

test("an answer's line says the roll's name the option gave it, since its roll has none (LP27-A-BLOCK-3)", () => {
  const scope = new RoomScope();
  const choices = scope.get(diceChoicesSlot);
  choices.setState({ last: { tag: "N", once: true, label: "Wisdom save" } });
  choices.getInitialState = choices.getState;
  const tracker = scope.get(receiptsSlot);
  const log = [{ id: "1:0", at: "", kind: "event", data: { type: "roll", test: { kind: "save", ability: "wis" }, tag: "N", characterId: "c1", dc: 15, dcShown: true, resultShown: true, total: 23, result: "pass", dice: { formula: "1d20+6", faces: [17], total: 23 } } }];
  tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => log as never };
  tracker.answer("N", 0, "taken");
  const markup = inRoom(DM, [createElement(LastResult, { key: "last", onOpen() {} })], scope);
  assert.match(markup, /data-result-label=""[^>]*>Wisdom save</);
  assert.match(markup, /aria-live="polite"[^>]*>Rolled 23, Pass: Wisdom save, Normal\.<\/span>/);
});

test("a part of a result line's dice box is out of sight only from the line's foot down: small words centered on the first row sit a few px lower (review FU44-OPUS-2)", () => {
  // Measured in Chrome at 100% and 130%: "and 2 more" in 13 px words on the 24 px first row stands 2 px down, wrapped one row down 24. The line's top here is 100, its foot 124.
  const at = (top: number) => ({ getBoundingClientRect: () => ({ top }) });
  assert.equal(wrappedOut(at(100), 124), false, "a chip on the first row");
  assert.equal(wrappedOut(at(102), 124), false, "\"and 2 more\" centered on the first row");
  assert.equal(wrappedOut(at(123), 124), false);
  assert.equal(wrappedOut(at(124), 124), true, "the second row");
  assert.equal(wrappedOut(at(100 + 24 * 1.3), 100 + 24 * 1.3), true, "the second row at 130%");
});

describe("the \"+2\" for the chips a result line drops ends on one count (ROLLER-185-LOOP)", () => {
  /** `hiddenWith` from a table of what each count drawn hides, failing past a few dozen tries as React's update limit would. */
  const measured = (table: Record<number, number>) => {
    const tried: number[] = [];
    const hiddenWith = (n: number) => {
      tried.push(n);
      if (tried.length > 50) throw new Error(`no end: ${tried.slice(0, 8).join(", ")}…`);
      return table[n] ?? 0;
    };
    return { hiddenWith, tried };
  };

  test("nothing hidden draws none, and a count the \"+2\" holds is tried once more", () => {
    const none = measured({ 0: 0 });
    assert.equal(settleDropped(none.hiddenWith), 0);
    assert.deepEqual(none.tried, [0]);
    const two = measured({ 0: 2, 2: 2 });
    assert.equal(settleDropped(two.hiddenWith), 2);
    assert.deepEqual(two.tried, [0, 2]);
  });

  test("a \"+2\" that takes the room of another chip says the larger count", () => {
    const more = measured({ 0: 2, 2: 3, 3: 3 });
    assert.equal(settleDropped(more.hiddenWith), 3);
    assert.deepEqual(more.tried, [0, 2, 3], "it says what it drew last");
  });

  test("a count the \"+2\" brings back, as when it wraps out of sight and frees the dice's room, ends at once", () => {
    // pl3-b6 at 320 x 568 at 130%: drawn, the "+3" and the dice wrapped out together, and with neither the line had room again.
    const flips = measured({ 0: 3, 3: 0 });
    assert.equal(settleDropped(flips.hiddenWith), 3);
    assert.deepEqual(flips.tried, [0, 3]);
    const climbs = measured({ 0: 1, 1: 2, 2: 1 });
    assert.equal(settleDropped(climbs.hiddenWith), 2);
    assert.deepEqual(climbs.tried, [0, 1, 2]);
  });

  test("any table of counts ends within one try a chip, on a count it drew", () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 500; run++) {
      const chips = 1 + next(12);
      const table: Record<number, number> = {};
      for (let n = 0; n <= chips; n++) table[n] = next(chips + 1);
      const { hiddenWith, tried } = measured(table);
      const said = settleDropped(hiddenWith);
      assert.ok(tried.length <= chips + 1, `run ${run}: ${tried.length} tries for ${chips} chips`);
      assert.equal(tried[tried.length - 1], said, `run ${run}: the "+2" drawn last is the count said`);
      assert.ok(said === 0 || said === table[tried[tried.length - 2]!], `run ${run}: the count said was measured`);
    }
  });
});
