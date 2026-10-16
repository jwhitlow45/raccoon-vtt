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
const { HpEntry, oneTarget } = await import("./HpSection.tsx");

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
