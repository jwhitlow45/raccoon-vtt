import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Character, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, character, room, token } from "#shared/testutil.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import { tokenAccess } from "./access.ts";
import { offersMakeCompanion, panelSections, type PanelSectionId } from "./panelOrder.ts";
import { vitals } from "./statSummary.ts";

/**
 * The sections a viewer gets for a token, worked out from their own copy
 * of the room as the panel does: access from ownership, the stat block
 * from its link, the summary from what the copy holds.
 */
function sectionsFor(state: ReturnType<typeof room>, viewer: typeof DM, tokenId: string, companion = false): PanelSectionId[] {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const t = view.tokens[tokenId] as Token;
  const character = ("ref" in t.actor ? view.characters[t.actor.ref] : undefined) as Character | undefined;
  const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: { characters: character ? { [character.id]: character } : {} }, token: t });
  const a = ("inline" in t.actor ? t.actor.inline : character?.actor) as Partial<Actor> | undefined;
  return panelSections({
    dm: access.dm,
    owner: access.owner,
    kind: t.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: t.kind, actor: a }),
    summary: vitals({ actor: a, token: t, fullAccess: access.full, place: "panel" }).length > 0,
    actor: a !== undefined,
    ownerRenames: !access.dm && access.canEditToken("name"),
  });
}

const PLAY: PanelSectionId[] = ["hp", "conditions", "position", "rangeRings", "notes"];

describe("the token panel's order", () => {
  test("the DM on an SRD monster: name, image, the block, play, then setup at the foot", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(sectionsFor(state, DM, "g"), ["name", "image", "statBlock", ...PLAY, "rest", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on an unlinked NPC still gets the stat block row, for Attach", () => {
    const state = room();
    state.tokens.n = token("n", { kind: "npc", actor: { inline: actor() } });
    assert.deepEqual(sectionsFor(state, DM, "n").slice(0, 3), ["name", "image", "statBlock"]);
  });

  test("the DM on a character: the summary line alone, row 3b", () => {
    const state = room();
    state.characters.c = character("c");
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, DM, "t"), ["name", "image", "summary", ...PLAY, "rest", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on an object: no summary line, no rest", () => {
    const state = room();
    state.tokens.o = token("o", { kind: "object", actor: { inline: actor() } });
    assert.deepEqual(sectionsFor(state, DM, "o"), ["name", "image", ...PLAY, "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on a companion: its section after Token settings and before Owners", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    const sections = sectionsFor(state, DM, "w", true);
    assert.deepEqual(sections.slice(-4), ["settings", "companion", "owners", "remove"]);
  });

  test("an owner of a character: the summary line, Stats and Token settings with their Name fields, no Owners or Remove", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, P1, "t"), ["name", "image", "summary", ...PLAY, "rest", "sight", "stats", "settings"]);
  });

  test("an owner of a character's token without the character: no summary line", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p2"] });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], actor: { ref: "c" } });
    const sections = sectionsFor(state, P1, "t");
    assert.equal(sections.includes("summary"), false);
    assert.equal(sections.includes("statBlock"), false);
  });

  test("an owner of a companion: its section, Token settings for its name, and Dismiss is the bar's", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    const sections = sectionsFor(state, P1, "w", true);
    assert.ok(sections.includes("companion"));
    assert.equal(sections.includes("owners"), false);
  });

  test("an owner of an SRD Wild Shape reads its block", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ srdId: "brown-bear" }) } });
    assert.deepEqual(sectionsFor(state, P1, "w").slice(0, 3), ["name", "image", "statBlock"]);
  });

  test("another player on a monster: name, image, then play, no setup", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(sectionsFor(state, P1, "g"), ["name", "image", ...PLAY, "sight"]);
  });

  test("Companion shows only on a companion", () => {
    const state = room();
    state.tokens.n = token("n", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    assert.equal(sectionsFor(state, DM, "n").includes("companion"), false);
    assert.equal(sectionsFor(state, P1, "n").includes("companion"), false);
  });

  test("Make a companion is offered only in the DM's Token settings, on a token that is neither a PC nor a companion", () => {
    assert.equal(offersMakeCompanion({ dm: true, kind: "npc", companion: false }), true);
    assert.equal(offersMakeCompanion({ dm: true, kind: "monster", companion: false }), true);
    assert.equal(offersMakeCompanion({ dm: true, kind: "object", companion: false }), true);
    assert.equal(offersMakeCompanion({ dm: true, kind: "pc", companion: false }), false);
    assert.equal(offersMakeCompanion({ dm: true, kind: "npc", companion: true }), false);
    assert.equal(offersMakeCompanion({ dm: false, kind: "npc", companion: false }), false);
  });
});
