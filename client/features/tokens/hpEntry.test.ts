import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
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

function render(access: "all" | "relative"): string {
  const target = oneTarget({ tokenId: "t1" }, access, false);
  // HpEntry reads the room's actions only when a change is applied, and the store only as it unmounts. The page's scope holds what a blackout keeps (hpDraft.ts).
  const entry = createElement(HpEntry, { targets: [target], access, place: "bar" });
  return renderToStaticMarkup(
    createElement(RoomProvider, { store: {} as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: entry }) }),
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
