// First, so the components below import under node --test (components/testing/register.ts).
import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { statBlockOf } from "#shared/statBlock.ts";
import { P1, actor, character, companionBlock, customMonster, room, token } from "#shared/testutil.ts";
import { defenseLines, hpUnits, linkedBlockState, moreStatsShown, quickUnit, saveUnits, shortSplit, speedUnits, unitText, validSheetUrl, vitals, type VitalItem, type VitalUnit } from "./statSummary.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SavesLine, VitalsLine } = await import("./StatSummary.tsx");
const { QuickNumbers } = await import("./QuickNumbers.tsx");

/*
 * Inter's advance widths in ems at text size (its optical size 14), the
 * interface font the vitals draw in (client/lib/interFont.ts), for the
 * characters they use. Node has no font to measure, and its flat 0.6 em a
 * character overstates narrow letters by a third. The vitals line asks for
 * tabular digits, each 0.648 em. A unit's label is regular and its value at
 * weight 600, which runs about 2% wider.
 */
const INTER: Record<string, number> = {
  " ": 0.281, ",": 0.288, "/": 0.36, "+": 0.648, "(": 0.365, ")": 0.365, "%": 0.982, "↗": 0.775,
  ...Object.fromEntries([..."0123456789"].map((d) => [d, 0.648])),
  a: 0.562, b: 0.612, c: 0.571, d: 0.612, e: 0.583, f: 0.37, g: 0.613, h: 0.591, i: 0.242, k: 0.549, l: 0.242, m: 0.876, n: 0.591, o: 0.6, p: 0.612,
  r: 0.376, s: 0.528, t: 0.327, u: 0.591, v: 0.562, w: 0.818, y: 0.562, A: 0.69, C: 0.73, D: 0.722, H: 0.743, O: 0.765, P: 0.639, S: 0.642,
};
const ems = (text: string) => [...text].reduce((w, ch) => w + (INTER[ch] ?? 0.6), 0);
const unitWidth = (unit: VitalUnit) =>
  unit.kind === "text" ? (ems(unit.label ? `${unit.label} ` : "") + ems(`${unit.value}${unit.comma ? "," : ""}`) * 1.02) * 14 : ems(unitText(unit)) * 14 * 1.02;

const keys = (items: readonly VitalItem[]) => items.map((i) => i.key);
const words = (item: VitalItem | undefined) => item?.units.map(unitText) ?? [];
const inlineOf = (t: Token | { actor: unknown } | undefined) => (t?.actor as { inline?: Partial<Actor> } | undefined)?.inline;

describe("the vitals, by viewer", () => {
  test("the DM on a monster: AC, HP, speed and Passive Perception", () => {
    const a = actor({ ac: 15, hp: { cur: 10, max: 10, temp: 0 }, speeds: { walk: 30 }, passivePerception: 9 });
    const items = vitals({ actor: a, token: { kind: "monster", hpVisibility: "label" }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(items), ["ac", "hp", "speed", "passivePerception"]);
    assert.deepEqual(items.map(words), [["15"], ["HP 10/10"], ["Speed 30 ft"], ["Passive Perception 9"]]);
  });

  test("an owner on their character: the same with the sheet link last, and in the panel no HP", () => {
    const state = room();
    state.characters.hero = character("hero", { ownerIds: ["p1"], actor: actor({ ac: 16, hp: { cur: 31, max: 38, temp: 5 }, passivePerception: 14, sheetUrl: "https://www.dndbeyond.com/characters/1" }) });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "hero" } });
    const view = projectState(state, P1, { sceneId: null });
    const a = view.characters.hero!.actor;
    const bar = vitals({ actor: a, token: { kind: "pc", hpVisibility: view.tokens.t!.hpVisibility }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(bar), ["ac", "hp", "speed", "passivePerception", "sheet"]);
    assert.deepEqual(words(bar[1]), ["HP 31/38", "+5"]);
    assert.deepEqual(keys(shortSplit(bar).line), ["ac", "hp", "sheet"], "a short bar keeps the link on its line");
    const panel = vitals({ actor: a, token: { kind: "pc" }, fullAccess: true, place: "panel" });
    assert.deepEqual(keys(panel), ["ac", "speed", "passivePerception", "sheet"]);
  });

  test("a player who owns a character's token but not the character: its HP as the party's rule sends it, nothing else", () => {
    const state = room();
    state.characters.bree = character("bree", { ownerIds: ["p2"], actor: actor({ ac: 17, hp: { cur: 4, max: 20, temp: 0 }, passivePerception: 15 }) });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], hpVisibility: "exact", actor: { ref: "bree" } });
    for (const party of [true, false]) {
      state.meta.settings.pcHpVisibleToParty = party;
      const view = projectState(state, P1, { sceneId: null });
      const items = vitals({ actor: view.characters.bree!.actor, token: { kind: "pc", hpVisibility: view.tokens.t!.hpVisibility }, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(items), ["hp"], `party HP ${party}`);
      assert.deepEqual(words(items[0]), party ? ["HP 4/20"] : ["Bloodied"]);
      assert.deepEqual(vitals({ actor: view.characters.bree!.actor, token: { kind: "pc" }, fullAccess: true, place: "panel" }), [], "no summary line in the panel");
    }
  });

  test("a player on another's monster: the HP the DM allows and nothing else, none when it shows nothing", () => {
    for (const [hpVisibility, expected] of [
      ["label", ["Bloodied"]],
      ["bar", ["HP about 30%"]],
      ["exact", ["HP 3/10"]],
      ["hidden", null],
    ] as const) {
      const state = room();
      state.tokens.g = token("g", { hpVisibility, actor: { inline: actor({ ac: 15, srdId: "goblin-warrior", hp: { cur: 3, max: 10, temp: 0 } }) } });
      const t = projectState(state, P1, { sceneId: null }).tokens.g!;
      const items = vitals({ actor: inlineOf(t), token: { kind: t.kind, hpVisibility: t.hpVisibility }, fullAccess: false, place: "bar" });
      assert.deepEqual(items.length === 0 ? null : items.map(words).flat(), expected, hpVisibility);
      assert.deepEqual(vitals({ actor: inlineOf(t), token: { kind: t.kind }, fullAccess: false, place: "panel" }), []);
    }
  });

  test("an object: its HP alone", () => {
    const items = vitals({ actor: actor({ ac: 15, hp: { cur: 8, max: 10, temp: 0 } }), token: { kind: "object", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(items), ["hp"]);
    assert.deepEqual(vitals({ actor: actor({ ac: 15 }), token: { kind: "object" }, fullAccess: true, place: "panel" }), []);
  });

  test("an HP-less token shows nothing of its HP or AC: max HP 0, an effect companion, and a creature companion turned into an effect, alive or dead", () => {
    const zero = actor({ ac: 0, hp: { cur: 0, max: 0, temp: 0 } });
    assert.deepEqual(keys(vitals({ actor: zero, token: { kind: "object" }, fullAccess: true, place: "bar" })), []);
    const effect = { kind: "object" as const, companion: { of: "c1", turn: "none" } };
    for (const life of ["alive", "dead"] as const) {
      const stored = actor({ ac: 13, life, hp: { cur: life === "dead" ? 0 : 15, max: 15, temp: 0 } });
      const items = vitals({ actor: stored, token: effect, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(items), [], `${life}: no HP, life tag or AC`);
      // Turned back into a creature, all of it returns as stored.
      const back = vitals({ actor: stored, token: { kind: "npc", companion: { of: "c1", turn: "shared" } }, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(back), life === "dead" ? ["hp", "speed", "passivePerception"] : ["ac", "hp", "speed", "passivePerception"]);
      if (life === "dead") assert.deepEqual(words(back[0]), ["HP 0/15", "Dead"]);
    }
    assert.deepEqual(keys(vitals({ actor: zero, token: { kind: "npc" }, fullAccess: true, place: "bar" })), ["speed", "passivePerception"], "a creature at 0 of 0 keeps its other numbers");
  });

  test("an actor missing each field in turn leaves only that item out", () => {
    const full = actor({ ac: 12, passivePerception: 11 });
    for (const [field, key] of [
      ["ac", "ac"],
      ["hp", "hp"],
      ["speeds", "speed"],
      ["passivePerception", "passivePerception"],
    ] as const) {
      const partial: Partial<Actor> = { ...full };
      delete partial[field];
      const got = keys(vitals({ actor: partial, token: { kind: "npc", hpVisibility: "exact" }, fullAccess: true, place: "bar" }));
      assert.deepEqual(got, ["ac", "hp", "speed", "passivePerception"].filter((k) => k !== key), field);
    }
    assert.deepEqual(vitals({ actor: undefined, token: { kind: "npc" }, fullAccess: true, place: "bar" }), []);
  });
});

describe("the vitals' units", () => {
  test("speed splits per mode, walk first, with the commas that join them", () => {
    assert.deepEqual(speedUnits({ walk: 30 }).map(unitText), ["Speed 30 ft"]);
    assert.deepEqual(speedUnits({ walk: 30, fly: 60, hover: true }).map(unitText), ["Speed 30 ft,", "Fly 60 ft (hover)"]);
    assert.deepEqual(speedUnits({ walk: 0, fly: 30, hover: true }).map(unitText), ["Speed 0 ft,", "Fly 30 ft (hover)"]);
    assert.deepEqual(speedUnits({ walk: 40, burrow: 30, fly: 80, swim: 40 }).map(unitText), ["Speed 40 ft,", "Fly 80 ft,", "Swim 40 ft,", "Burrow 30 ft"]);
    const five = speedUnits({ walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }).map(unitText);
    assert.deepEqual(five, ["Speed 1000 ft,", "Fly 1000 ft (hover),", "Swim 1000 ft,", "Climb 1000 ft,", "Burrow 1000 ft"]);
  });

  test("HP and temporary HP are separate units from the tag", () => {
    const units = hpUnits({ actor: actor({ hp: { cur: 0, max: 30, temp: 5 }, life: "dying" }), hpVisibility: "exact", fullAccess: true });
    assert.deepEqual(units.map(unitText), ["HP 0/30", "+5", "Dying"]);
    assert.deepEqual(units.map((u) => u.kind), ["text", "text", "tag"]);
    const stable = hpUnits({ actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "stable" }), hpVisibility: "exact", fullAccess: true });
    assert.deepEqual(stable.at(-1), { kind: "tag", text: "Stable", tone: "warning" });
  });

  test("no unit is wider than the narrowest box it shows in, the largest numbers included", () => {
    const big = actor({ ac: 100, hp: { cur: 100000, max: 100000, temp: 100000 }, speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }, passivePerception: 60 });
    const items = vitals({ actor: big, token: { kind: "monster", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    for (const unit of items.flatMap((i) => i.units)) {
      const w = unitWidth(unit);
      // The compact bar at 480 x 320 at 130% gives its content 234 px (docs/design-v1-token-panel.md 3.12). Each unit is measured by its full words, wider than the bar draws them ("Passive Perception 60", about 150, draws as "PP 60"), so the bound holds for both.
      assert.ok(w <= 234, `"${unitText(unit)}" is ${Math.round(w)} px`);
    }
    assert.ok(unitWidth({ kind: "text", label: "HP", value: "100000/100000" }) >= 120, "the HP unit is about 130 px");
  });
});

describe("AC on the vitals line", () => {
  test("left out at 0 and on the dead, shown at 9, 99 and 100", () => {
    const ac = (a: Partial<Actor>) => vitals({ actor: a, token: { kind: "npc" }, fullAccess: true, place: "bar" }).find((i) => i.key === "ac")?.units[0];
    assert.equal(ac(actor({ ac: 0 })), undefined);
    assert.equal(ac(actor({ ac: 15, life: "dead", hp: { cur: 0, max: 10, temp: 0 } })), undefined);
    for (const n of [9, 99, 100]) assert.deepEqual(ac(actor({ ac: n })), { kind: "ac", ac: n });
  });
});

describe("a short bar's split", () => {
  test("AC and HP stay on the line, speed and Passive Perception go to More stats", () => {
    const items = vitals({ actor: actor({ ac: 15 }), token: { kind: "monster", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    const { line, more } = shortSplit(items);
    assert.deepEqual(keys(line), ["ac", "hp"]);
    assert.deepEqual(keys(more), ["speed", "passivePerception"]);
    assert.equal(moreStatsShown(more, { kind: "none" }), true);
  });

  test("no disclosure when all four are empty", () => {
    const items = vitals({ actor: { hp: { cur: 5, max: 5, temp: 0 }, life: "alive" }, token: { kind: "npc", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    const { more } = shortSplit(items);
    assert.deepEqual(more, []);
    assert.equal(moreStatsShown(more, { kind: "none" }), false);
    assert.equal(moreStatsShown(more, { kind: "loading" }), true, "saves on their way count");
  });
});

/**
 * Each quick number's markup in a rendered line, by its full name: the
 * span named "Speed ..." or "Passive Perception ..." and all inside it,
 * less the spacing a line puts after it, which is the line's and not the
 * unit's.
 */
function quickMarkup(markup: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of markup.matchAll(/<span role="img" aria-label="((?:Speed|Passive Perception) [^"]+)"/g)) {
    let depth = 0;
    let end = m.index;
    for (const tag of markup.slice(m.index).matchAll(/<\/?span\b/g)) {
      depth += tag[0] === "<span" ? 1 : -1;
      end = m.index + tag.index;
      if (depth === 0) break;
    }
    found.set(m[1]!, markup.slice(m.index, end + "</span>".length).replace(/;?margin-inline-end:[^;"]*/, ""));
  }
  return found;
}

describe("the token window's summary and the panel's header", () => {
  const creatures: [string, Actor, Parameters<typeof vitals>[0]["token"]][] = [
    ["a monster with one speed", actor({ ac: 15, hp: { cur: 7, max: 7, temp: 0 }, speeds: { walk: 30 }, passivePerception: 9 }), { kind: "monster", hpVisibility: "exact" }],
    ["a flier that hovers", actor({ ac: 13, hp: { cur: 19, max: 19, temp: 0 }, speeds: { walk: 10, fly: 60, hover: true }, passivePerception: 15 }), { kind: "npc", hpVisibility: "exact" }],
    ["five speeds", actor({ ac: 18, speeds: { walk: 40, fly: 80, swim: 40, climb: 30, burrow: 20 }, passivePerception: 21 }), { kind: "monster", hpVisibility: "exact" }],
    ["a character", actor({ ac: 16, hp: { cur: 31, max: 38, temp: 5 }, speeds: { walk: 30 }, passivePerception: 14, sheetUrl: "https://www.dndbeyond.com/characters/1" }), { kind: "pc", hpVisibility: "exact" }],
  ];

  test("speed and Passive Perception are the same units in both, each named in full", () => {
    for (const [label, a, t] of creatures) {
      const bar = vitals({ actor: a, token: t, fullAccess: true, place: "bar" }).map(quickUnit).filter((u) => u !== null);
      const panel = vitals({ actor: a, token: t, fullAccess: true, place: "panel" }).map(quickUnit).filter((u) => u !== null);
      assert.deepEqual(bar, panel, label);
      assert.deepEqual(bar.map((u) => u.key), ["speed", "passivePerception"], label);
    }
    const [, flier, t] = creatures[1]!;
    const units = vitals({ actor: flier, token: t, fullAccess: true, place: "bar" }).map(quickUnit);
    assert.deepEqual(units, [null, null, { key: "speed", name: "Speed 10 ft, Fly 60 ft (hover)", modes: ["10 ft", "Fly 60 ft (hover)"] }, { key: "passivePerception", name: "Passive Perception 15", value: "15" }], "AC and HP are not quick units");
  });

  test("the window draws them with the header's markup, the footprints and PP, and keeps HP in its words", () => {
    for (const [label, a, t] of creatures) {
      const line = renderToStaticMarkup(createElement(VitalsLine, { items: vitals({ actor: a, token: t, fullAccess: true, place: "bar" }) }));
      const header = renderToStaticMarkup(createElement(QuickNumbers, { items: vitals({ actor: a, token: t, fullAccess: true, place: "panel" }), actor: a, token: { kind: t.kind, elevation: 0 } }));
      const ours = quickMarkup(line);
      assert.equal(ours.size, 2, `${label}: ${[...ours.keys()].join(", ")}`);
      const theirs = quickMarkup(header);
      // The header keeps a speed of several modes whole (QuickNumbers.tsx, D-261026-15), where the window keeps its last mode with PP.
      for (const [name, markup] of ours) if (!line.includes("data-speed-pp") || !name.startsWith("Speed")) assert.equal(theirs.get(name), markup, `${label}: ${name}`);
      assert.doesNotMatch(line, />Passive Perception</, `${label}: the words stay in the name`);
      assert.match(line, />HP <\/span><span[^>]*>\d+\/\d+</, `${label}: HP keeps its words`);
    }
    const [, goblin, t] = creatures[0]!;
    const line = renderToStaticMarkup(createElement(VitalsLine, { items: vitals({ actor: goblin, token: t, fullAccess: true, place: "bar" }) }));
    assert.match(line, /aria-label="Speed 30 ft"[^>]*><svg[^>]*>.*?<\/svg><strong data-unit="speed"[^>]*>30 ft<\/strong>/, "the footprints, then the number");
    assert.match(line, /aria-label="Passive Perception 9"[^>]*><span[^>]*>PP<\/span><strong>9<\/strong>/);
  });

  /*
   * In More stats at 320 x 568 at 130%, a dragon's "40 ft, Fly 80 ft,"
   * filled a line and "Climb 40 ft" stood alone on the next, with PP under
   * it (FU30-NOTED). The last mode now wraps with PP.
   */
  test("a speed of several modes keeps its last beside Passive Perception in the window, stays whole in the header, and names itself whole once", () => {
    for (const [label, a, t] of creatures.slice(1, 3)) {
      const line = renderToStaticMarkup(createElement(VitalsLine, { items: vitals({ actor: a, token: t, fullAccess: true, place: "bar" }) }));
      const header = renderToStaticMarkup(createElement(QuickNumbers, { items: vitals({ actor: a, token: t, fullAccess: true, place: "panel" }), actor: a, token: { kind: t.kind, elevation: 0 } }));
      const speed = quickUnit(vitals({ actor: a, token: t, fullAccess: true, place: "bar" }).find((item) => item.key === "speed")!);
      assert.ok(speed?.key === "speed", label);
      const last = speed.modes.at(-1)!;
      // The header's first part holds the whole speed, every mode in its picture, and nothing of it goes with PP (D-261026-15).
      const whole = quickMarkup(header).get(speed.name);
      assert.ok(whole, `${label}, header: the speed names itself whole`);
      for (const mode of speed.modes) assert.match(whole, new RegExp(`>${mode.replace(/[()]/g, "\\$&")},?<`), `${label}, header: ${mode} in the speed`);
      assert.doesNotMatch(header, /data-speed-pp/, `${label}, header: no mode with PP`);
      for (const [where, markup] of [["window", line]] as const) {
        const img = quickMarkup(markup).get(speed.name);
        assert.ok(img, `${label}, ${where}: the speed names itself whole`);
        assert.doesNotMatch(img, new RegExp(`>${last.replace(/[()]/g, "\\$&")}<`), `${label}, ${where}: the last mode stays out of the picture`);
        assert.match(img, new RegExp(`>${speed.modes.at(-2)!},?<`), `${label}, ${where}: the mode before it`);
        const part = new RegExp(`<span[^>]*><strong data-unit="speed" aria-hidden="true"[^>]*>${last.replace(/[()]/g, "\\$&")}</strong><span role="img" aria-label="Passive Perception \\d+"`);
        assert.match(markup, part, `${label}, ${where}: the last mode and PP in one part, the mode hidden from a screen reader`);
        // Hidden from a screen reader, it still names the whole speed under a pointer and paints over the sheet link's reach, as the rest of the speed does (FU31 review F7).
        assert.match(markup, new RegExp(`<strong data-unit="speed" aria-hidden="true" title="${speed.name.replace(/[()]/g, "\\$&")}" style="[^"]*position:relative`), `${label}, ${where}: the last mode's tooltip and reach`);
      }
    }
    const [, one, t] = creatures[0]!;
    assert.doesNotMatch(renderToStaticMarkup(createElement(VitalsLine, { items: vitals({ actor: one, token: t, fullAccess: true, place: "bar" }) })), /data-speed-pp/, "one speed stays one unit");
  });

  test("More stats on a short bar holds the same units", () => {
    const [, a, t] = creatures[1]!;
    const { more } = shortSplit(vitals({ actor: a, token: t, fullAccess: true, place: "bar" }));
    const opened = renderToStaticMarkup(createElement(VitalsLine, { items: more }));
    assert.deepEqual([...quickMarkup(opened).keys()], ["Speed 10 ft, Fly 60 ft (hover)", "Passive Perception 15"]);
  });
});

/**
 * The part of a summary line that holds the first `needle` in its markup:
 * the `data-*-part` span around it, by its name and its place among the
 * line's parts, or null outside every part.
 */
function partOf(markup: string, needle: string): string | null {
  const at = markup.indexOf(needle);
  assert.ok(at >= 0, `no ${needle} in ${markup}`);
  const open: (string | null)[] = [];
  let seen = 0;
  for (const tag of markup.slice(0, at).matchAll(/<(\/?)[a-z][a-z0-9]*([^>]*?)(\/?)>/g)) {
    if (tag[1]) open.pop();
    else if (!tag[3]) {
      const part = /data-(vitals|saves)-part="([^"]*)"/.exec(tag[2] ?? "");
      open.push(part ? `${part[2] || "part"} ${++seen}` : null);
    }
  }
  return open.findLast((p) => p !== null) ?? null;
}

describe("the summary lines' parts, so no unit stands alone on a line (D-261024-42)", () => {
  test("the vitals hold AC and HP as one part, and Speed, Passive Perception, the sheet link and the elevation as another (FU30-OPUS-3)", () => {
    const a = actor({ ac: 13, hp: { cur: 40, max: 40, temp: 6 }, speeds: { walk: 50, climb: 40 }, passivePerception: 15, sheetUrl: "https://www.dndbeyond.com/characters/1" });
    const items = vitals({ actor: a, token: { kind: "pc", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    const line = renderToStaticMarkup(createElement(VitalsLine, { items, end: "10 ft" }));
    assert.equal(partOf(line, 'aria-label="Armor Class'), "numbers 1");
    assert.equal(partOf(line, ">40/40<"), "numbers 1");
    assert.equal(partOf(line, ">+6<"), "numbers 1", "temporary HP with its HP");
    assert.equal(partOf(line, 'aria-label="Speed 50 ft, Climb 40 ft"'), "quick 2");
    assert.equal(partOf(line, 'aria-label="Passive Perception 15"'), "quick 2");
    assert.equal(partOf(line, ">Sheet"), "quick 2", "the sheet link with them");
    assert.equal(partOf(line, ">10 ft<"), "quick 2", "and the elevation last");
    // A short bar's line keeps the sheet link, which the elevation still follows in one part.
    const split = shortSplit(items);
    const short = renderToStaticMarkup(createElement(VitalsLine, { items: split.line, end: "10 ft" }));
    assert.equal(partOf(short, ">Sheet"), "quick 2");
    assert.equal(partOf(short, ">10 ft<"), "quick 2");
    // Its More stats holds Speed and Passive Perception alone, still as one part.
    const more = renderToStaticMarkup(createElement(VitalsLine, { items: split.more }));
    assert.equal(partOf(more, 'aria-label="Passive Perception 15"'), "quick 1");
  });

  test("an item of a key the parts do not name still shows, after the numbers (FU30-OPUS-4)", () => {
    const later = { key: "later" as VitalItem["key"], units: [{ kind: "text" as const, value: "Later" }] };
    const line = renderToStaticMarkup(createElement(VitalsLine, { items: [...vitals({ actor: actor({ ac: 13 }), token: { kind: "monster" }, fullAccess: true, place: "bar" }), later] }));
    assert.equal(partOf(line, ">Later<"), "quick 2");
  });

  test("marked saves add no inline width and keep three complete name-number units together", () => {
    const saves = { str: 8, dex: 6, con: 7, int: 3, wis: 7, cha: 6 };
    const line = renderToStaticMarkup(createElement(SavesLine, { block: { kind: "numbers", saves, defenses: [], proficiency: { str: "none", dex: "prof", con: "prof", int: "none", wis: "prof", cha: "prof" } } }));
    const triples = line.split('data-saves-triple=""').slice(1);
    assert.equal(triples.length, 2, "two indivisible triples, independently of the Saves heading");
    for (const [index, triple] of triples.entries()) {
      assert.match(triple, /^ style="[^"]*flex-wrap:nowrap/, "a triple cannot leave its last save alone");
      assert.equal(triple.match(/data-proficiency-label=/g)?.length, 3, "every save retains its whole label");
      const names = [...triple.matchAll(/>(STR|DEX|CON|INT|WIS|CHA) </g)].map((match) => match[1]);
      assert.deepEqual(names, index === 0 ? ["STR", "DEX", "CON"] : ["INT", "WIS", "CHA"]);
    }
    assert.equal(line.replace(/<[^>]*>/g, ""), "SavesSTR +8DEX +6CON +7INT +3WIS +7CHA +6");
    assert.doesNotMatch(line, /data-proficiency-layout="column"|data-proficiency-marker="none"/);
    assert.equal(line.match(/data-proficiency-placement="under"/g)?.length, 4, "four marks decorate the existing line without taking inline width");
  });

  test("the saves wrap three and three: Saves with the first three as one part, the other three as another", () => {
    const saves = { str: 8, dex: 6, con: 7, int: 3, wis: 7, cha: 6 };
    const line = renderToStaticMarkup(createElement(SavesLine, { block: { kind: "numbers", saves, defenses: [] } }));
    assert.equal(partOf(line, ">Saves<"), "part 1");
    for (const ability of ["STR", "DEX", "CON"]) assert.equal(partOf(line, `>${ability} <`), "part 1", ability);
    for (const ability of ["INT", "WIS", "CHA"]) assert.equal(partOf(line, `>${ability} <`), "part 2", ability);
  });
});

describe("saves and defenses", () => {
  test("from a room monster, in its own numbers", () => {
    const block = statBlockOf(customMonster("m1"));
    assert.deepEqual(saveUnits(block), ["STR +2", "DEX +2", "CON +1", "INT −4", "WIS +3", "CHA −2"]);
  });

  test("from an SRD monster, with the SRD's minus sign", async () => {
    const list = await loadMonsters();
    const state = linkedBlockState({ srdId: "goblin-warrior" }, {}, { list, failed: false });
    assert.equal(state.kind, "ready");
    assert.deepEqual(saveUnits(state.kind === "ready" ? state.block : statBlockOf(customMonster("x"))), ["STR −1", "DEX +2", "CON +0", "INT +0", "WIS −1", "CHA −1"]);
  });

  test("defense lines: none, each alone, and all three in the block's order", () => {
    const base = { vulnerabilities: "", resistances: "", immunities: "" };
    assert.deepEqual(defenseLines(base), []);
    assert.deepEqual(defenseLines({ ...base, vulnerabilities: "Fire" }), [{ label: "Vulnerabilities", text: "Fire" }]);
    assert.deepEqual(defenseLines({ ...base, resistances: "Cold" }), [{ label: "Resistances", text: "Cold" }]);
    assert.deepEqual(defenseLines({ ...base, immunities: "Poison; Charmed, Poisoned" }), [{ label: "Immunities", text: "Poison; Charmed, Poisoned" }]);
    assert.deepEqual(defenseLines({ immunities: "Poison", resistances: "Cold", vulnerabilities: "Fire" }).map((l) => l.label), ["Vulnerabilities", "Resistances", "Immunities"]);
  });
});

describe("the linked block's state", () => {
  const monsters = { m1: customMonster("m1") };
  const loaded = async () => ({ list: await loadMonsters(), failed: false });

  test("a companion's stored block reads at once, with no chunk, and a deleted one as none (docs/design-v1-companion-stat-blocks.md 6.6)", () => {
    const blocks = { b1: companionBlock("b1", "bree", { resistances: "Cold" }) };
    const state = linkedBlockState({ blockId: "b1" }, monsters, { list: null, failed: false }, blocks);
    assert.equal(state.kind, "ready");
    assert.ok(state.kind === "ready" && !("characterId" in state.block) && !("id" in state.block));
    assert.deepEqual(state.kind === "ready" ? defenseLines(state.block) : [], [{ label: "Resistances", text: "Cold" }]);
    const again = linkedBlockState({ blockId: "b1" }, monsters, { list: null, failed: false }, blocks);
    assert.ok(again.kind === "ready" && state.kind === "ready" && again.block === state.block, "the same block for the same version, so a bar drawn again keeps it");
    assert.deepEqual(linkedBlockState({ blockId: "gone" }, monsters, { list: null, failed: false }, blocks), { kind: "none" });
  });

  test("none, a room monster at once, and a deleted one as none", () => {
    assert.deepEqual(linkedBlockState({}, monsters, { list: null, failed: false }), { kind: "none" });
    assert.deepEqual(linkedBlockState(undefined, monsters, { list: null, failed: false }), { kind: "none" });
    const room = linkedBlockState({ monsterId: "m1" }, monsters, { list: null, failed: false });
    assert.equal(room.kind, "ready", "a room monster needs no chunk");
    assert.deepEqual(linkedBlockState({ monsterId: "gone" }, monsters, { list: null, failed: false }), { kind: "none" });
  });

  test("an SRD link: loading, failed, ready, and an id the chunk lacks as none", async () => {
    assert.deepEqual(linkedBlockState({ srdId: "goblin-warrior" }, {}, { list: null, failed: false }), { kind: "loading" });
    assert.deepEqual(linkedBlockState({ srdId: "goblin-warrior" }, {}, { list: null, failed: true }), { kind: "failed" });
    assert.equal(linkedBlockState({ srdId: "goblin-warrior" }, {}, await loaded()).kind, "ready");
    assert.deepEqual(linkedBlockState({ srdId: "no-such-monster" }, {}, await loaded()), { kind: "none" });
  });

  test("a block that does not read counts as none", () => {
    const broken = { srdId: "broken", name: "Broken", statBlock: "## Broken\n\nnot a stat block" } as SrdMonster;
    assert.deepEqual(linkedBlockState({ srdId: "broken" }, {}, { list: [broken], failed: false }), { kind: "none" });
  });

  test("a player's view never yields saves for a room monster's link, since it holds no monsterId", () => {
    const state = room();
    state.monsters.m1 = customMonster("m1");
    state.tokens.g = token("g", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ monsterId: "m1" }) } });
    const view = projectState(state, P1, { sceneId: null });
    assert.deepEqual(linkedBlockState(inlineOf(view.tokens.g), view.monsters, { list: null, failed: false }), { kind: "none" });
  });
});

describe("the sheet link", () => {
  test("https only, at most 500 characters", () => {
    assert.equal(validSheetUrl("https://www.dndbeyond.com/characters/1"), "https://www.dndbeyond.com/characters/1");
    assert.equal(validSheetUrl("http://example.com"), null);
    assert.equal(validSheetUrl("javascript:alert(1)"), null);
    assert.equal(validSheetUrl(`https://example.com/${"a".repeat(500)}`), null);
  });
});
