import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceResult, LogEntry, RollTarget } from "#shared/model.ts";
import { reminderPreset } from "#shared/rules/rollReminders.ts";
import { askedText, askItems, askKept, askRowText, bestChoice, BONUS_WORDS, cardRoll, dmRoll, choiceLabel, CLEAR_TOTAL, knownOrTyped, NO_INPUTS, parseBonus, rolledDice, rolledNews, rolledText, returnedRollMode, normalResult, informativeRollMode, fitResultWords, watchResultWords, RollResultLine, TYPE_BONUS, verdictText } from "./card.ts";

const DEX = { kind: "save", ability: "dex" } as const;
const restrained = [{ key: "restrained" as const }];

describe("the card's Roll (docs/design-v1-roll-request.md 5.2, 5.3)", () => {
  test("with a known bonus it reads Roll +3, and with none it waits for a typed one", () => {
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll +3");
    // A draft total hidden by typed totals off never holds Roll back, nor says to clear it (B7B-ASTRA-03).
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "12" }).blocked, CLEAR_TOTAL);
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "12", typeTotals: false }).blocked, null);
    assert.equal(cardRoll({ bonus: null, preset: null, inputs: { ...NO_INPUTS, bonus: "2" }, text: "12", typeTotals: false }).blocked, null, "with a typed bonus too");
    assert.equal(cardRoll({ bonus: null, preset: null, inputs: NO_INPUTS, text: "12", typeTotals: false }).blocked, TYPE_BONUS, "only the bonus it still needs");
    assert.equal(cardRoll({ bonus: -1, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll −1");
    assert.equal(cardRoll({ bonus: 0, preset: null, inputs: NO_INPUTS, text: "" }).label, "Roll +0");
    const none = cardRoll({ bonus: null, preset: null, inputs: NO_INPUTS, text: "" });
    assert.equal(none.label, "Roll d20");
    assert.equal(none.blocked, TYPE_BONUS);
    assert.deepEqual(none.fields, { ok: false, error: TYPE_BONUS });
    const typed = cardRoll({ bonus: null, preset: null, inputs: { ...NO_INPUTS, bonus: "5" }, text: "" });
    assert.equal(typed.label, "Roll d20+5");
    assert.deepEqual(typed.fields, { ok: true, value: { bonus: 5 } }, "the typed bonus goes as `bonus`");
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, bonus: "5" }, text: "" }).fields, { ok: true, value: {} }, "a known bonus never sends one");
    assert.equal(cardRoll({ bonus: null, preset: null, inputs: { ...NO_INPUTS, bonus: "31" }, text: "" }).fields.ok, false);
    assert.deepEqual([parseBonus(""), parseBonus("+5"), parseBonus("−2"), parseBonus("-20"), parseBonus("x")], [null, { ok: true, bonus: 5 }, { ok: true, bonus: -2 }, { ok: true, bonus: -20 }, { ok: false, error: "A bonus is a whole number from -20 to 30." }]);
  });

  test("a total in the field holds Roll back", () => {
    assert.equal(cardRoll({ bonus: 3, preset: null, inputs: NO_INPUTS, text: "9" }).blocked, CLEAR_TOTAL);
  });

  test("the reading names each source and extra, and nothing at all draws none", () => {
    const blessed = reminderPreset([...restrained, { key: "blessed" }], DEX);
    const roll = cardRoll({ bonus: 3, preset: blessed, inputs: NO_INPUTS, text: "" });
    assert.equal(roll.reading, "Rolls 1d20+3 with Disadvantage (Restrained), +1d4 (Blessed).");
    assert.deepEqual(roll.fields, { ok: true, value: { mode: "dis", extra: "+1d4" } });
    // Restrained and the player's Adv: any advantage with any disadvantage is a normal roll.
    const adv = cardRoll({ bonus: 3, preset: reminderPreset(restrained, DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" });
    assert.equal(adv.reading, "Rolls 1d20+3: Advantage and Restrained cancel.");
    assert.deepEqual(adv.fields, { ok: true, value: { cancelled: true } });
    // Hasted (advantage on Dex saves) and Restrained, the player presses Adv too: still normal.
    const hasted = cardRoll({ bonus: 3, preset: reminderPreset([...restrained, { key: "hasted" }], DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" });
    assert.deepEqual(hasted.fields, { ok: true, value: { cancelled: true } });
    // Blessed and Exhaustion 2, the player types +1d6: "+1d4-4+1d6", each named.
    const tired = cardRoll({ bonus: 3, preset: reminderPreset([{ key: "blessed" }, { key: "exhaustion", level: 2 }], DEX), inputs: { ...NO_INPUTS, extra: "1d6" }, text: "" });
    assert.equal(tired.reading, "Rolls 1d20+3, -4 (Exhaustion), +1d4 (Blessed), +1d6.");
    assert.deepEqual(tired.fields, { ok: true, value: { extra: "-4+1d4+1d6" } });
    assert.equal(cardRoll({ bonus: 3, preset: reminderPreset([], DEX), inputs: NO_INPUTS, text: "" }).reading, null);
    assert.equal(cardRoll({ bonus: 3, preset: reminderPreset([], DEX), inputs: { ...NO_INPUTS, pressed: "adv" }, text: "" }).reading, "Rolls 1d20+3 with Advantage.");
    assert.equal(tired.extraRoom, 40 - "-4+1d4".length, "the whole extra keeps within 40 characters");
  });

  test("Stunned on a Dex save says it fails whatever the roll", () => {
    const stunned = cardRoll({ bonus: 3, preset: reminderPreset([{ key: "stunned" }], DEX), inputs: NO_INPUTS, text: "" });
    assert.equal(stunned.reading, "Stunned: this save fails whatever the roll.");
  });

  test("the card checks what the server would refuse first, in its words", () => {
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, extra: "+1d" }, text: "" }).fields.ok, false);
    assert.deepEqual(cardRoll({ bonus: 3, preset: null, inputs: { ...NO_INPUTS, extra: "+10d20" }, text: "" }).fields, { ok: false, error: "That roll could total outside -50 to 100. Type the total instead." });
  });

  test("two choices start at the higher bonus and name it", () => {
    assert.equal(bestChoice([1, 3]), 1);
    assert.equal(bestChoice([3, 3]), 0, "the first on a tie");
    assert.equal(bestChoice([null, 3]), 0, "the first with one unknown");
    assert.equal(choiceLabel("Dexterity", 3), "Dexterity +3");
    assert.equal(choiceLabel("Strength", null), "Strength");
  });
});

describe("a rolled result's words (5.4)", () => {
  const dis: DiceResult = { formula: "2d20kl1+3+1d4", faces: [14, 6, 3], total: 12, mode: "dis" };
  test("the dice with the dropped one, the verdict, a natural, and the news", () => {
    const target: RollTarget = { characterId: "thorn", total: 12, result: "fail", dice: dis, tag: "t1" };
    assert.deepEqual(rolledDice(dis), { formula: "1d20+3+1d4 with Disadvantage", faces: [{ face: 14, dropped: true }, { face: 6, dropped: false }, { face: 3, dropped: false }] });
    assert.equal(rolledText(target), "Rolled 12 (1d20+3+1d4 with Disadvantage: 14 dropped, 6, 3). Fail.");
    assert.equal(rolledNews("Thorn", target), "Thorn rolled 12. Disadvantage. Fail.");
    const twenty: RollTarget = { characterId: "thorn", total: 25, result: "pass", dice: { formula: "1d20+5", faces: [20], total: 25 }, tag: "t2" };
    assert.equal(rolledText(twenty), "Rolled 25 (1d20+5: 20). Natural 20. Pass.");
    assert.equal(verdictText({ result: "fail", dice: { ...dis, fails: "stunned" } }), "Fail (Stunned)");
    assert.equal(verdictText({ dice: dis }), null, "pass or fail hidden");
  });
});

describe("the DM's Roll for a waiting creature (6)", () => {
  test("worded as doc 3's buttons, with the fields its unanswered roll sends", () => {
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset([], DEX) }), { label: "Roll +5", fields: {} });
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset(restrained, DEX), ability: "Dex" }), { label: "Roll Dex +5, Disadvantage (Restrained)", fields: { mode: "dis" } });
    assert.deepEqual(dmRoll({ bonus: 5, preset: reminderPreset([{ key: "stunned" }], DEX) }).label, "Roll +5: fails (Stunned)");
    const mr = reminderPreset([], { ...DEX, spell: true }, { magicResistance: true });
    assert.deepEqual(dmRoll({ bonus: 2, preset: mr }), { label: "Roll +2, Advantage (Magic Resistance)", fields: { mode: "adv" } });
    assert.deepEqual(dmRoll({ bonus: 2, preset: reminderPreset([{ key: "blessed" }], DEX) }), { label: "Roll +2, +1d4 (Blessed)", fields: { extra: "+1d4" } });
  });

  test("a creature with no stat block rolls with the bonus the DM types, sent for the server to use, and reads d20 until then (owner's no-numbers rule)", () => {
    assert.deepEqual(dmRoll({ bonus: null, typed: true, preset: reminderPreset([], DEX) }), { label: "Roll d20", fields: {} });
    assert.deepEqual(dmRoll({ bonus: 3, typed: true, preset: reminderPreset(restrained, DEX) }), { label: "Roll d20+3, Disadvantage (Restrained)", fields: { mode: "dis", bonus: 3 } });
    assert.deepEqual(dmRoll({ bonus: -1, typed: true, preset: reminderPreset([], DEX), ability: "Dex" }).label, "Roll Dex d20-1");
  });

  test("the bonus beside it: the known one wins, else the one typed, and the Roll waits for it in the card's words", () => {
    assert.deepEqual(knownOrTyped(null, "", false), { bonus: null, typing: false, waits: null, error: false }, "nothing typed while the block loads");
    assert.deepEqual(knownOrTyped(null, "", true), { bonus: null, typing: true, waits: TYPE_BONUS, error: false });
    assert.deepEqual(knownOrTyped(null, "+3", true), { bonus: 3, typing: true, waits: null, error: false });
    assert.deepEqual(knownOrTyped(null, "x", true), { bonus: null, typing: true, waits: BONUS_WORDS, error: true });
    assert.deepEqual(knownOrTyped(4, "+3", true), { bonus: 4, typing: false, waits: null, error: false });
  });
});

describe("asking the DM to change an answer (5.5)", () => {
  const labels = (dice: DiceResult | undefined) => askItems({ dice }, true).map((i) => `${i.label}${i.ask.face !== undefined ? ` @${i.ask.face}` : ""}`);
  test("a disadvantage roll with Bless: the kept d20 by default, every other die named, Lucky, and the four Bardic dice", () => {
    const dis: DiceResult = { formula: "2d20kl1+3+1d4", faces: [14, 6, 3], total: 12, mode: "dis" };
    assert.deepEqual(labels(dis), [
      "Reroll: Heroic Inspiration @1",
      "Reroll the d20 (14): Heroic Inspiration @0",
      "Reroll the d4 (3): Heroic Inspiration @2",
      "Advantage: Lucky",
      "Add a d6 (Bardic Inspiration)",
      "Add a d8 (Bardic Inspiration)",
      "Add a d10 (Bardic Inspiration)",
      "Add a d12 (Bardic Inspiration)",
    ]);
  });

  test("an advantage roll rerolls the dropped die, offers no Lucky, and Halfling Luck only on a 1", () => {
    const adv: DiceResult = { formula: "2d20kh1+5", faces: [1, 15], total: 20, mode: "adv" };
    const items = labels(adv);
    assert.equal(items[0], "Reroll: Heroic Inspiration @0", "the dropped one");
    assert.ok(items.includes("Reroll: Halfling Luck @0"));
    assert.ok(!items.some((i) => i.startsWith("Advantage: Lucky")), "Lucky changes nothing on an advantage roll");
    assert.ok(!labels({ formula: "1d20+5", faces: [7], total: 12 }).some((i) => i.includes("Halfling")), "no d20 shows 1");
    assert.ok(!labels({ formula: "1d20+5", faces: [7], total: 12, cancelled: true }).some((i) => i.includes("Lucky")), "nor on a cancelled one");
  });

  test("a typed answer that is final offers only Fix my total, and each ask has its words", () => {
    assert.deepEqual(askItems({}, true).map((i) => i.label), ["Fix my total"]);
    assert.deepEqual(askItems({}, false), [], "with typed totals off, Fix my total is gone");
    assert.ok(askItems({ dice: { formula: "1d20+5", faces: [7], total: 12 } }, false).some((i) => i.label.includes("Bardic")), "a rolled answer keeps its asks");
    assert.equal(askedText({ reason: "heroic-inspiration" }), "Asked the DM to reroll (Heroic Inspiration).");
    assert.equal(askRowText({ reason: "lucky" }), "Asks for Advantage (Lucky)");
    assert.equal(askRowText({ reason: "bardic-inspiration", die: 8 }), "Asks to add a d8 (Bardic Inspiration)");
    assert.equal(askRowText({ reason: "fix-total" }, "Thorn"), "Thorn asks to fix the total");
  });
});

describe("an ask that went away (docs/design-v1-roll-request.md 5.5)", () => {
  const ask = { id: "ask-1", on: "answer-1" };

  test("reads as kept only while the answer it named still stands and this device did not withdraw it", () => {
    assert.equal(askKept(ask, { tag: "answer-1" }, null), true, "the DM's Keep, or a close that settled it");
    assert.equal(askKept(ask, { tag: "answer-1" }, "ask-1"), false, "this device's Withdraw");
    assert.equal(askKept(ask, { tag: "answer-1", change: { id: "ask-2", on: "answer-1", reason: "lucky" } }, null), false, "still pending, or replaced");
    assert.equal(askKept(undefined, { tag: "answer-1" }, null), false, "no ask went");
  });

  test("an Allow is never kept, even when the reroll lands on the same total (LP7-DICE-2)", () => {
    assert.equal(askKept(ask, { tag: "answer-2" }, null), false, "the allowed change wrote a new answer");
    assert.equal(askKept(ask, {}, null), false, "a Reopen, or an allowed Fix my total, cleared the answer");
  });
});


describe("one-roll request modes", () => {
  test("a pick replaces only the manual chip and retains typed bonus, extras and effects", () => {
    const inputs = { pressed: "dis" as const, extra: "1d6", bonus: "+4" };
    const preset = reminderPreset(restrained, DEX);
    const base = { bonus: null, preset, inputs, text: "" };
    assert.deepEqual(cardRoll({ ...base, override: "adv" }).fields, { ok: true, value: { cancelled: true, extra: "+1d6", bonus: 4 } });
    assert.deepEqual(cardRoll({ ...base, override: "normal" }).fields, { ok: true, value: { mode: "dis", extra: "+1d6", bonus: 4 } });
    assert.equal(inputs.pressed, "dis");
    assert.equal(cardRoll({ ...base, text: "12", override: "adv" }).blocked, CLEAR_TOTAL);
    assert.equal(cardRoll({ ...base, inputs: { ...inputs, bonus: "" }, override: "normal" }).blocked, TYPE_BONUS);
  });

  test("the DM resolves all preset sources once and keeps its typed bonus", () => {
    const preset = reminderPreset([{ key: "restrained" }, { key: "blessed" }], DEX);
    assert.deepEqual(dmRoll({ bonus: 4, typed: true, preset, override: "adv" }).fields, { cancelled: true, extra: "+1d4", bonus: 4 });
    assert.deepEqual(dmRoll({ bonus: 4, typed: true, preset, override: "normal" }).fields, { mode: "dis", extra: "+1d4", bonus: 4 });
  });
});


test("returned result modes describe cancellation and Secret without reading the picked action", () => {
  const line: LogEntry = { id: "8:0", at: "", kind: "event", data: { type: "dice", by: "dm", to: "dm", rolls: [{ formula: "1d20+2", faces: [10], total: 12, cancelled: true }] } };
  assert.equal(returnedRollMode([line]), "Normal: Advantage and Disadvantage cancelled");
  assert.equal(returnedRollMode([]), "");
  assert.equal(normalResult({ formula: "1d20+2", faces: [10], total: 12 }), "");
  assert.equal(normalResult({ formula: "2d20kh1+2", faces: [10, 12], total: 14, mode: "adv" }), "");
  assert.match(rolledText({ dice: { formula: "1d20+2", faces: [10], total: 12, cancelled: true } }), /Normal: Advantage and Disadvantage cancelled/);
  assert.equal(rolledNews("Hero", { dice: { formula: "1d20+2", faces: [10], total: 12, cancelled: true } }), "Hero rolled 12. Normal: Advantage and Disadvantage cancelled.");
});


test("result modes never invent Normal and retain only informative visibility", () => {
  const plain = { formula: "1d20+3", faces: [12], total: 15 };
  assert.equal(informativeRollMode(plain), "");
  assert.equal(informativeRollMode(plain, true), "Secret");
  assert.equal(informativeRollMode({ ...plain, mode: "adv" }), "Advantage");
  assert.equal(informativeRollMode({ ...plain, mode: "dis" }), "Disadvantage");
  assert.equal(informativeRollMode({ ...plain, cancelled: true }), "Normal: Advantage and Disadvantage cancelled");
  assert.equal(rolledNews("Hero", { dice: plain }), "Hero rolled 15.");
});

test("result lines retain informative names while starting with compact visible words", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  for (const suffix of [" (Advantage)", " (Disadvantage)", " (Normal: Advantage and Disadvantage cancelled)", " (Secret)", ""]) {
    const html = renderToStaticMarkup(createElement(RollResultLine, { text: "15 hit", suffix }));
    assert.doesNotMatch(html, /role="note"|aria-label=|aria-hidden=/);
    if (suffix) assert.match(html, /data-roll-result-missing=""/);
    assert.match(html, /data-roll-result-base=""[^>]*>15 hit<\/span>/);
    if (suffix) assert.match(html, /hidden="" data-roll-result-detail=""/);
    else assert.doesNotMatch(html, /data-roll-result-detail/);
  }
});

test("informative words stay visible only without an added line, sibling row or horizontal overflow", () => {
  for (const change of ["none", "line", "parent", "width"] as const) {
    const base = { hidden: false };
    const detail = { hidden: true };
    const parent = { clientWidth: 120, get scrollWidth() { return !detail.hidden && change === "width" ? 140 : 120; }, getBoundingClientRect: () => ({ height: !detail.hidden && change === "parent" ? 44 : 22 }) };
    const root = { parentElement: parent, getBoundingClientRect: () => ({ height: base.hidden && detail.hidden ? 0 : !detail.hidden && change === "line" ? 44 : 22 }) };
    const fits = fitResultWords(root as unknown as HTMLElement, base as unknown as HTMLElement, detail as unknown as HTMLElement);
    assert.equal(fits, change === "none");
    assert.equal(base.hidden, fits);
    assert.equal(detail.hidden, !fits);
    // A later wider/narrower layout starts by measuring the original words again.
    assert.equal(fitResultWords(root as unknown as HTMLElement, base as unknown as HTMLElement, detail as unknown as HTMLElement), fits);
  }
});


test("wrapping follows resizes and font loads, then disconnects both watchers", () => {
  const previous = { ResizeObserver: globalThis.ResizeObserver, document: globalThis.document };
  let resize: (() => void) | undefined;
  let watched: unknown;
  let disconnected = false;
  let narrow = false;
  const fonts = new EventTarget();
  const base = { hidden: false };
  const detail = { hidden: true };
  const parent = { clientWidth: 120, scrollWidth: 120, getBoundingClientRect: () => ({ height: 22 }) };
  const root = { parentElement: parent, getBoundingClientRect: () => ({ height: base.hidden && detail.hidden ? 0 : narrow && !detail.hidden ? 44 : 22 }) };
  class Observer {
    constructor(run: () => void) { resize = run; }
    observe(node: unknown) { watched = node; }
    disconnect() { disconnected = true; }
  }
  Object.assign(globalThis, { ResizeObserver: Observer, document: { fonts } });
  try {
    const stop = watchResultWords(root as unknown as HTMLElement, base as unknown as HTMLElement, detail as unknown as HTMLElement);
    assert.equal(watched, parent);
    assert.equal(detail.hidden, false, "the initial wider layout shows informative words");
    narrow = true;
    resize!();
    assert.equal(detail.hidden, true, "a narrower layout returns to the original line");
    narrow = false;
    fonts.dispatchEvent(new Event("loadingdone"));
    assert.equal(detail.hidden, false, "font changes recheck the available line");
    stop();
    assert.equal(disconnected, true);
    narrow = true;
    fonts.dispatchEvent(new Event("loadingdone"));
    assert.equal(detail.hidden, true, "cleanup restores compact text without measuring fonts");
    assert.equal(base.hidden, false);
  } finally { Object.assign(globalThis, previous); }
});

test("card cancellation can move out of visible words without losing formula, verdict or news", () => {
  const dice = { formula: "1d20+5", faces: [20], total: 25, cancelled: true as const };
  assert.equal(rolledText({ dice, result: "pass" }, false), "Rolled 25 (1d20+5: 20). Natural 20. Pass.");
  assert.equal(rolledNews("Hero", { dice, result: "pass" }), "Hero rolled 25. Normal: Advantage and Disadvantage cancelled. Pass.");
  const plain: LogEntry = { id: "8:0", kind: "event", at: "", data: { type: "dice", by: "dm", to: "dm", rolls: [{ ...dice, cancelled: undefined }] } };
  assert.equal(returnedRollMode([plain]), "", "a fixed card adds neither plain Normal nor redundant Secret");
});


test("an existing marked result name survives without creating visible detail", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(RollResultLine, { text: "DEX: typed 15", children: createElement("span", {}, "DEX, proficient: typed 15") }));
  assert.match(html, />DEX, proficient: typed 15<\/span>/);
  assert.doesNotMatch(html, /role="note"|aria-label=|aria-hidden=/);
  assert.doesNotMatch(html, /data-roll-result-detail/);
});


test("mounted result transitions restore compact words and keep each accessible addition once", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripTypeScriptTypes } = await import("node:module");
  const source = readFileSync(new URL("./card.ts", import.meta.url), "utf8");
  const body = stripTypeScriptTypes(source.slice(source.indexOf("export function RollResultLine("))).replace("export function", "function");
  const refs: { current: unknown }[] = [];
  let cursor = 0;
  let effect: (() => (() => void) | void) | undefined;
  let cleanup: (() => void) | void = undefined;
  const nodes = new Map<string, { hidden: boolean; children: unknown[]; props: Record<string, unknown>; parentElement?: unknown; getBoundingClientRect(): { height: number } }>();
  let narrow = false;
  const parent = { clientWidth: 200, scrollWidth: 200, getBoundingClientRect: () => ({ height: 20 }) };
  const make = (_tag: string, props: Record<string, unknown>, ...children: unknown[]) => {
    const key = ["base", "detail", "missing"].find((k) => `data-roll-result-${k}` in props) ?? "root";
    let node = nodes.get(key);
    if (!node) { node = { hidden: !!props.hidden, children, props, parentElement: parent, getBoundingClientRect: () => ({ height: narrow && !nodes.get("detail")?.hidden ? 40 : 20 }) }; nodes.set(key, node); }
    if (props.hidden !== node.props.hidden) node.hidden = !!props.hidden;
    node.props = props; node.children = children;
    const ref = props.ref as { current: unknown } | undefined; if (ref) ref.current = node;
    return node;
  };
  class Observer { observe() {} disconnect() {} }
  const previous = { ResizeObserver: globalThis.ResizeObserver, document: globalThis.document };
  Object.assign(globalThis, { ResizeObserver: Observer, document: {} });
  try {
    const render = new Function("useRef", "useLayoutEffect", "createElement", "watchResultWords", "VISUALLY_HIDDEN", `${body}\nreturn RollResultLine;`)(
      (value: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
      (run: typeof effect) => { effect = run; }, make, watchResultWords, { position: "absolute" },
    ) as (props: { text: string; suffix?: string }) => void;
    const commit = (suffix: string) => {
      cursor = 0; effect = undefined; render({ text: "15 hit", suffix });
      if (!suffix) for (const key of ["detail", "missing"]) { nodes.delete(key); }
      cleanup?.(); cleanup = (effect as (() => (() => void) | void) | undefined)?.();
    };
    const readable = () => [...nodes.entries()].filter(([key, n]) => key !== "root" && !n.hidden).flatMap(([, n]) => n.children).join("");
    commit(" (Secret)");
    assert.equal(nodes.get("base")!.hidden, true);
    assert.equal(readable(), "15 hit (Secret)", "wide text is readable once");
    narrow = true; commit(" (Disadvantage)");
    assert.equal(nodes.get("base")!.hidden, false);
    assert.equal(readable(), "15 hit (Disadvantage)", "the narrow result keeps only missing words out of flow");
    narrow = false; commit(" (Advantage)");
    assert.equal(nodes.get("base")!.hidden, true);
    commit("");
    assert.equal(nodes.get("base")!.hidden, false, "removing the detail restores the mounted base");
    assert.equal(readable(), "15 hit");
    (cleanup as (() => void) | undefined)?.();
  } finally { Object.assign(globalThis, previous); }
});
