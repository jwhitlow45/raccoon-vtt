import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { LIMITS } from "#shared/limits.ts";
import type { Character, ClassResource, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, character, room, token } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { UsesSection, NOTHING_TO_LIST } = await import("./UsesSection.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * Combat's Uses section as it draws (docs/design-v1-token-sections.md 3.1),
 * moved from the Class resources section's test: what it is for while a
 * character has nothing in it, its rows with Restore and Edit, Add after
 * them or the limit in its place, and the question a rise in level asks
 * once per class. Then the DM's pips under a monster's list, and nothing
 * at all for a creature with no use.
 */

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 5 };
const hands: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };

function render(state: RoomState, viewer: Viewer, element: ReturnType<typeof createElement>): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }),
    }),
  );
}

/** Pat's Uses on his character's page, as Pat sees it. */
const section = (over: Partial<Character>) => {
  const pat = character("pat", { name: "Pat", ...over });
  return render(room({ characters: { pat } }), P1, createElement(UsesSection, { target: { characterId: "pat" }, name: "Pat", character: pat }));
};

/** Each button's tag, from `<button` to its closing `>`, in order. */
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const named = (markup: string, name: string) => buttons(markup).find((b) => b.includes(`aria-label="${name}"`));

describe("Combat's Uses for a character", () => {
  test("with none: what it is for, and Add, under the Uses heading", () => {
    const markup = section({});
    assert.match(markup, />Uses<\/h/);
    assert.doesNotMatch(markup, /Class resources/, "no Class resources heading");
    assert.ok(markup.includes(`>${NOTHING_TO_LIST.replace("&", "&amp;")}<`));
    assert.match(markup, />Add a class resource<\/button>/);
    assert.doesNotMatch(markup, /data-combat-uses/, "no empty list box to take a gap");
  });

  test("its rows with Restore and Edit on their button line, then Add", () => {
    const markup = section({ resources: [rage, hands], level: 5 });
    assert.ok(named(markup, "Restore one use of Rage"));
    assert.match(markup, /aria-label="Edit Rage"/);
    assert.match(markup, /aria-label="Edit Lay on Hands"/);
    // Edit stands with Use and Restore on one line: no element closes between Restore and Edit but Restore's own.
    const rageLine = markup.slice(markup.indexOf('aria-label="Restore one use of Rage"'), markup.indexOf('aria-label="Edit Rage"'));
    assert.equal([...rageLine.matchAll(/<\/div>/g)].length, 0, rageLine);
    assert.ok(markup.indexOf("Edit Lay on Hands") < markup.indexOf("Add a class resource"), "Add after the rows");
    assert.doesNotMatch(markup, /Your level went up/, "the level has not risen");
    assert.ok(!markup.includes(NOTHING_TO_LIST.slice(0, 20)), "no help line beside rows");
  });

  test("a level past what a class was read at asks to update that class, once", () => {
    const persistent: ClassResource = { id: "p", name: "Persistent Rage", max: 1, used: 0, reset: "long", preset: "barbarian-persistent-rage", level: 15, atLevel: 5 };
    const markup = section({ resources: [rage, persistent, hands], level: 6 });
    assert.equal([...markup.matchAll(/Your level went up\. Update Barbarian resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/Your level went up\. Update Paladin resources\?/g)].length, 1);
    assert.equal([...markup.matchAll(/>Update<\/button>/g)].length, 2);
    assert.ok(markup.indexOf("Your level went up") < markup.indexOf("Edit Rage"), "the question comes first");
  });

  test("its rows are a list named for its uses, or for its class resources beside a block's uses (LP22-SECT-4)", () => {
    assert.match(section({ resources: [rage] }), /<ul aria-label="Pat&#x27;s uses"/);
    const mixed = section({ resources: [rage], actor: actor({ legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) });
    assert.match(mixed, /<ul aria-label="Pat&#x27;s uses"/, "the block's list");
    assert.match(mixed, /<ul aria-label="Pat&#x27;s class resources"/, "the class resources apart from it");
  });

  test("a full list says so in place of Add", () => {
    const many: ClassResource[] = Array.from({ length: LIMITS.resourcesPerCharacter }, (_, i) => ({ id: `o${i}`, name: `Own ${i}`, max: 1, used: 0, reset: "long" }));
    const markup = section({ resources: many });
    assert.doesNotMatch(markup, /Add a class resource/);
    assert.match(markup, />A character holds at most 12 class resources. Remove one to add another.</);
    assert.ok(section({ resources: many.slice(1) }).includes("Add a class resource"), "one short of the limit");
  });
});

describe("Combat's Uses for a creature of its own", () => {
  const legendary = { actionsMax: 3, actionsUsed: 1, resistMax: 2, resistUsed: 0 };
  const state = room();
  state.tokens.dragon = token("dragon", { name: "Dragon", ownerIds: ["p1"], actor: { inline: actor({ legendary }) } });
  state.tokens.goblin = token("goblin", { name: "Goblin" });
  const of = (tokenId: string, viewer: Viewer) => render(state, viewer, createElement(UsesSection, { target: { tokenId }, name: tokenId }));

  test("the DM's pips stand under the list, each count's words over its pips", () => {
    const markup = of("dragon", DM);
    assert.match(markup, />Uses<\/h/);
    assert.match(markup, /Legendary Actions 2 of 3/, "the list's row");
    assert.match(markup, /Legendary Actions used: 1 of 3/);
    assert.match(markup, /Legendary Resistances used today: 0 of 2/);
    assert.ok(markup.indexOf("Legendary Actions 2 of 3") < markup.indexOf("Legendary Actions used: 1 of 3"), "the pips after the list");
    assert.equal(buttons(markup).filter((b) => /aria-label="\d+ used"/.test(b)).length, 5, "a pip for each of 3 and 2");
    assert.ok(named(markup, "1 used")?.includes('aria-pressed="true"'));
    assert.ok(named(markup, "2 used")?.includes('aria-pressed="false"'));
    assert.doesNotMatch(markup, /Add a class resource/, "no class resources for a creature of its own");
  });

  test("its player reads the list with no pips", () => {
    const markup = of("dragon", P1);
    assert.match(markup, /Legendary Actions 2 of 3/);
    assert.doesNotMatch(markup, /Legendary Actions used/);
  });

  test("a creature with no use draws nothing", () => {
    assert.equal(of("goblin", DM), "");
  });
});
