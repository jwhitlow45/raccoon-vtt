import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { Character, ClassResource } from "#shared/model.ts";
import { character, room } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ClassResourcesSection } = await import("./ClassResourcesSection.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * The Class resources section as it draws (docs/design-v1-combat-controls.md
 * 7.1 and 7.2): what it is for while empty, its rows with Give one back
 * and Edit, Add after them or the limit in its place, and the question a
 * rise in level asks once per class.
 */

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
const hands: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };

function render(pat: Character, element: ReturnType<typeof createElement>): string {
  const store = createStore(() => ({ view: room({ characters: { pat } }), you: { role: "player", memberId: "p1" } }));
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }) }));
}

const section = (over: Partial<Character>) => {
  const pat = character("pat", { name: "Pat", ...over });
  return render(pat, createElement(ClassResourcesSection, { character: pat }));
};

/** Each button's tag, from `<button` to its closing `>`, in order. */
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const named = (markup: string, name: string) => buttons(markup).find((b) => b.includes(`aria-label="${name}"`));

describe("the Class resources section", () => {
  test("with none: what it is for, and Add", () => {
    const markup = section({});
    assert.match(markup, /Class resources<\/h/);
    assert.match(markup, />Count Rage, Channel Divinity, Lay on Hands and the like here, picked by class and level or typed.</);
    assert.match(markup, />Add a class resource<\/button>/);
  });

  test("its rows with Give one back and Edit, then Add", () => {
    const markup = section({ resources: [rage, hands], level: 5 });
    assert.ok(named(markup, "Give one back: Rage"));
    assert.match(markup, /aria-label="Edit Rage"/);
    assert.match(markup, /aria-label="Edit Lay on Hands"/);
    assert.ok(markup.indexOf("Edit Lay on Hands") < markup.indexOf("Add a class resource"), "Add after the rows");
    assert.doesNotMatch(markup, /Your level went up/, "the level has not risen");
  });

  test("a level past what a class was read at asks to update that class, once", () => {
    const persistent: ClassResource = { id: "p", name: "Persistent Rage", max: 1, used: 0, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 5 };
    const markup = section({ resources: [rage, persistent, hands], level: 6 });
    assert.equal([...markup.matchAll(/Your level went up\. Update Barbarian resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/Your level went up\. Update Paladin resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/>Update<\/button>/g)].length, 2);
    assert.ok(markup.indexOf("Your level went up") < markup.indexOf("Edit Rage"), "the question comes first");
  });

  test("a full list says so in place of Add", () => {
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const markup = section({ resources: many });
    assert.doesNotMatch(markup, /Add a class resource/);
    assert.match(markup, />A character holds at most 12 class resources. Remove one to add another.</);
    assert.ok(section({ resources: many.slice(1) }).includes("Add a class resource"), "one short of the limit");
  });
});
