import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { theme } from "../../lib/theme.ts";

/*
 * The HP entry's modes were four buttons with role="radio": four Tab stops
 * and no arrow keys. They are the shared Segmented now, native radios with
 * one Tab stop, so these check the markup the e2e runs and screen readers
 * find: one radiogroup named "What the number does", each mode a radio
 * named by its label, one checked.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { DeathSaves, HpEntry, HpSection, oneTarget } = await import("./HpSection.tsx");
const { actor, customMonster, DM, entry, room, token } = await import("#shared/testutil.ts");
const { projectState } = await import("#shared/project.ts");
const { hpDraftKey, hpDraftSlot } = await import("./hpDraft.ts");

function render(access: "all" | "relative", vitals = { name: "Thorn", dead: false, max: 20 as number | undefined }, settings: { healRevives?: boolean } = {}, role: "dm" | "player" = "dm"): string {
  const target = oneTarget({ tokenId: "t1" }, access, false, vitals);
  // HpEntry reads the room's actions only when a change is applied. The store gives the room's healing setting and the role, for the lines on the dead. The page's scope holds what a blackout keeps (hpDraft.ts).
  const store = createStore(() => ({ view: { meta: { settings } }, you: { role } }));
  const entry = createElement(HpEntry, { targets: [target], access, place: "bar" });
  return renderToStaticMarkup(
    createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: entry }) }),
  );
}

/** A string as a literal in a RegExp: the accent is a CSS variable with parentheses. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function radios(markup: string): string[] {
  return [...markup.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
}

/** Each radio's name: the text of the label it lies in, as getByRole("radio", { name }) reads it. */
function names(markup: string): string[] {
  return [...markup.matchAll(/<label[^>]*><input type="radio"(?![^>]*aria-label)[^>]*>([^<]*)<\/label>/g)].map((m) => m[1]!);
}

describe("the HP entry's modes are native radios", () => {
  test("FL-3: a rolled chip restored after blackout keeps its damage breakdown and resistance preview", () => {
    const state = room({
      monsters: { frost: customMonster("frost", { resistances: "Cold" }) },
      tokens: { a: token("a", { actor: { inline: actor({ monsterId: "frost" }) } }) },
    });
    const target = oneTarget({ tokenId: "a" }, "all", false, { name: "Frost", dead: false, max: 20 });
    const scope = new RoomScope();
    const chip = { amount: 11, parts: [{ amount: 11, type: "cold" as const }], lineId: "1:0", lineIds: ["1:0"], text: "Use 11 (Cold damage)", critical: false };
    scope.get(hpDraftSlot).set(hpDraftKey("bar", [target]), { mode: "damage", text: "11", crit: false, chip });
    const store = createStore(() => ({ view: state, you: DM }));
    const el = createElement(HpEntry, { targets: [target], access: "all", place: "bar" });
    const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope, children: el }) }));
    assert.match(markup, /<s aria-hidden="true"[^>]*>11<\/s>/);
    assert.match(markup.replace(/<[^>]*>/g, ""), /5 Cold damage/);
    assert.match(markup, /data-damage-icon="cold"/);
    assert.match(markup.replace(/<[^>]*>/g, ""), /Resists: Cold/);
  });

  test("FL-3: typed damage uses a text keyboard and shows defense words only to a viewer who may read them", () => {
    const state = room({
      monsters: { frost: customMonster("frost", { resistances: "Cold" }) },
      tokens: { a: token("a", { actor: { inline: actor({ monsterId: "frost" }) } }) },
    });
    state.meta.settings.playersApplyDamage = true;
    for (const you of [DM, { memberId: "p1", role: "player" as const }]) for (const place of ["bar", "panel"] as const) {
      const target = oneTarget({ tokenId: "a" }, "relative", false, { name: "Frost", dead: false, max: 20 });
      const scope = new RoomScope();
      scope.get(hpDraftSlot).set(hpDraftKey(place, [target]), { mode: "damage", text: "11 cold", crit: false });
      const store = createStore(() => ({ view: projectState(state, you, { sceneId: "s1" }), you }));
      const el = createElement(HpEntry, { targets: [target], access: "relative", place });
      const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope, children: el }) }));
      assert.match(markup, /aria-label="HP change"[^>]*inputMode="text"/);
      if (you.role === "dm") assert.match(markup.replace(/<[^>]*>/g, ""), /Resists: Cold/);
      else {
        assert.match(markup.replace(/<[^>]*>/g, ""), /11 Cold damage/);
        assert.doesNotMatch(markup, /<s |Resists|Vulnerable|Immune/);
      }
    }
  });

  test("one radiogroup named What the number does, a radio per mode sharing one name, Damage checked", () => {
    const markup = render("all");
    assert.equal([...markup.matchAll(/role="radiogroup"/g)].length, 1);
    assert.match(markup, /<div role="radiogroup" aria-label="What the number does"/);
    assert.doesNotMatch(markup, /<button[^>]*role="radio"/, "no button poses as a radio");
    const inputs = radios(markup);
    assert.deepEqual(names(markup), ["Damage", "Heal", "Set", "Temp"]);
    assert.equal(new Set(inputs.map((i) => /name="([^"]+)"/.exec(i)?.[1])).size, 1, "one name, so one Tab stop");
    assert.deepEqual(
      inputs.map((i) => / checked=""/.test(i)),
      [true, false, false, false],
    );
  });

  test("the chosen mode wears its own color, not the accent", () => {
    // Only the modes: the Apply button after them is the accent's own.
    const all = render("all");
    const markup = all.slice(all.indexOf('role="radiogroup"'), all.indexOf('aria-label="HP change"'));
    assert.match(markup, new RegExp(`border:${theme.line.border}px solid ${theme.color.danger}`));
    assert.doesNotMatch(markup, new RegExp(escape(`border:${theme.line.border}px solid ${theme.color.accent}`)));
  });

  test("a player who may only damage or heal sees those two", () => {
    assert.deepEqual(names(render("relative")), ["Damage", "Heal"]);
  });
});

describe("the HP entry's lines on the dead (docs/design-v1-combat-flow.md 3.5)", () => {
  const dead = { name: "Thorn", dead: true, max: 20 };
  test("with healing off, Heal chosen before anything is typed says healing does nothing, and the DM is told to Revive first", () => {
    // The entry opens on Damage, which adds no line. The lines follow the mode only until the text parses.
    assert.doesNotMatch(render("all", dead, { healRevives: false }), /Healing does nothing/);
    assert.doesNotMatch(render("all", dead, {}), /Brings back/, "damage counts no revival");
  });

  test("a living target gets no line", () => {
    assert.doesNotMatch(render("all", { name: "Thorn", dead: false, max: 20 }, { healRevives: false }), /dead/);
  });
});

describe("the Hit points section of a creature with no HP to show (docs/design-v1-combat-flow.md 3.6.6)", () => {
  const section = (actor: object, token: { kind: "object" | "npc" | "monster"; companion?: unknown }, life = true) => {
    const store = createStore(() => ({ view: { meta: { settings: {} } }, you: { role: "dm" } }));
    const el = createElement(HpSection, { actor: actor as never, hpVisibility: "exact", target: { tokenId: "t1" }, access: { full: true, hp: "all", deathSaves: true, life }, name: "Thorn", token });
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: el }) }));
  };
  const hp = (cur: number, max: number) => ({ hp: { cur, max, temp: 0 }, life: "dead", deathSaves: { ok: 0, fail: 2 }, effects: [] });

  test("an effect companion shows one line and nothing else, whatever HP it stores", () => {
    const markup = section(hp(0, 15), { kind: "object", companion: { of: "c1", turn: "none" } });
    assert.match(markup, /No HP: it is an effect\./);
    assert.doesNotMatch(markup, /HP change|Max HP|Revive|Dead|Death saves/);
  });

  test("a token at max HP 0 shows No HP yet with the Max HP field that gives it HP", () => {
    const markup = section(hp(0, 0), { kind: "npc" });
    assert.match(markup, /No HP yet\./);
    assert.match(markup, /aria-label="Max HP"/);
    assert.doesNotMatch(markup, /HP change|Temporary HP|Revive/);
  });

  test("an ordinary object keeps its HP and has no life buttons", () => {
    const markup = section({ ...hp(0, 10), life: "dead" }, { kind: "object" });
    assert.match(markup, /aria-label="HP change"/);
    assert.doesNotMatch(markup, />Revive</);
    assert.match(section({ ...hp(0, 10), life: "dead" }, { kind: "monster" }), />Revive</, "a creature's panel keeps it");
  });
});


/*
 * The token panel's and the token bar's death save Roll (DeathSaves) waits
 * while this device shows the creature's Regeneration open, with the reason
 * under it (docs/design-v1-combat-controls.md 2.3 and 4.4).
 */
describe("the death save Roll while Regeneration is open", () => {
  const TROLL = customMonster("troll", {
    name: "Troll",
    traits: [{ name: "Regeneration", text: "The troll regains 15 Hit Points at the start of each of its turns. If the troll takes Acid or Fire damage, this trait doesn't function at the start of the troll's next turn." }],
  });

  function draw(settled: boolean): string {
    const record = { id: 7, entryId: "e1", round: 2, hp: 0, life: "dying" as const, ...(settled ? { settled: { regeneration: { state: "done" as const, total: 15 } } } : {}) };
    const view = room({
      monsters: { troll: TROLL },
      tokens: { tr: token("tr", { kind: "monster", name: "Troll", actor: { inline: actor({ monsterId: "troll", hp: { cur: 0, max: 84, temp: 0 }, life: "dying", turnRecord: record }) } }) },
      encounter: { rev: 0, round: 2, activeEntryId: "e1", entries: [entry("e1", { tokenId: "tr" })] },
    });
    const store = createStore(() => ({ view, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
    const saves = createElement(DeathSaves, { saves: { ok: 0, fail: 1 }, canEdit: true, target: { tokenId: "tr" }, onChange() {} });
    return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: saves }) }));
  }
  const roll = (markup: string) => /<button[^>]*aria-label="Roll a Death Save"[^>]*>/.exec(markup)?.[0] ?? "";

  test("off, and saying why, while Regeneration is open, and on once it is settled", () => {
    const waiting = draw(false);
    assert.match(roll(waiting), /disabled=""/);
    const reason = /aria-describedby="([^"]+)"/.exec(roll(waiting))?.[1];
    assert.ok(reason && new RegExp(`id="${reason}"[^>]*>Waiting for Regeneration<`).test(waiting));
    const open = draw(true);
    assert.ok(roll(open), "the Roll draws");
    assert.doesNotMatch(roll(open), /disabled=""/);
    assert.doesNotMatch(open, /Waiting for Regeneration/);
  });
});

test("FL-4 design: healing, temporary and set HP entries render the shared slip in bars and pages", () => {
  for (const place of ["bar", "panel"] as const) for (const [input, kind, words] of [["+5", "heal", "Heal 5"], ["t5", "temp", "Set Temporary HP to 5"], ["=20", "set", "Set HP to 20"]] as const) {
    const state = room({ tokens: { a: token("a", { actor: { inline: actor() } }) } });
    const target = oneTarget({ tokenId: "a" }, "all", false, { name: "Guard", dead: false, max: 20 });
    const scope = new RoomScope();
    scope.get(hpDraftSlot).set(hpDraftKey(place, [target]), { mode: "damage", text: input, crit: false });
    const store = createStore(() => ({ view: state, you: DM }));
    const el = createElement(HpEntry, { targets: [target], access: "all", place });
    const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope, children: el }) }));
    assert.ok(markup.includes(`data-hp-preview="${kind}"`));
    assert.ok(markup.includes(words));
  }
});
