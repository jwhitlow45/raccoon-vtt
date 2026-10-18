import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Character, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, actor, character, room, token } from "#shared/testutil.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import { tokenAccess } from "./access.ts";
import { offersMakeCompanion, panelGroups, panelRelation, panelSections, type PanelPart, type PanelSectionId } from "./panelOrder.ts";
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
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: t.kind, actor: a, companion }),
    summary: vitals({ actor: a, token: t, fullAccess: access.full, place: "panel" }).length > 0,
    actor: a !== undefined,
    ownerRenames: !access.dm && access.canEditToken("name"),
  });
}

/** The panel's parts as the panel draws them, in one line each: "name", "combat: hp conditions". */
function groupsFor(state: ReturnType<typeof room>, viewer: typeof DM, tokenId: string, companion = false): string[] {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const t = view.tokens[tokenId] as Token;
  const character = ("ref" in t.actor ? view.characters[t.actor.ref] : undefined) as Character | undefined;
  const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: { characters: character ? { [character.id]: character } : {} }, token: t });
  const a = ("inline" in t.actor ? t.actor.inline : character?.actor) as Partial<Actor> | undefined;
  const parts = panelGroups({
    dm: access.dm,
    owner: access.owner,
    kind: t.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: t.kind, actor: a, companion }),
    summary: vitals({ actor: a, token: t, fullAccess: access.full, place: "panel" }).length > 0,
    actor: a !== undefined,
    ownerRenames: !access.dm && access.canEditToken("name"),
    // As TokenPanel decides it, the card's notes included.
    notes: access.canEditToken("notes") || !!t.notes || access.dm || (access.full && a !== undefined && (access.canEditActor("notes") || a.notes !== undefined)),
    image: access.canEditToken("image"),
  });
  return parts.map((p: PanelPart) => (p.group === null ? p.id : `${p.group}: ${p.sections.join(" ")}`));
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

  test("a creature companion's player gets its stat block row with no link, for Attach, and an effect's gets none (docs/design-v1-companion-stat-blocks.md 6.5)", () => {
    const state = room({ characters: { bree: character("bree", { ownerIds: ["p1"] }) } });
    state.tokens.owl = token("owl", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor() } });
    state.tokens.blade = token("blade", { kind: "object", ownerIds: ["p1"], companion: { of: "bree", turn: "none" }, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0, srdId: "owl" }) } });
    assert.deepEqual(sectionsFor(state, P1, "owl", true).slice(0, 3), ["name", "image", "statBlock"]);
    assert.equal(sectionsFor(state, P1, "blade", true).includes("statBlock"), false);
    assert.equal(sectionsFor(state, DM, "blade", true).includes("statBlock"), false);
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

describe("the token panel grouped by use (docs/design-v1-token-panel-groups.md 2)", () => {
  test("the DM on a monster: the name, the block, Combat, Notes, Position, Image, then setup", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(groupsFor(state, DM, "g"), ["name", "statBlock", "combat: hp conditions rangeRings rest", "notes: notes", "position: position sight", "image: image", "stats", "settings", "owners", "remove"]);
  });

  test("an owner of a character: the same groups, and setup without Owners or Remove", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(groupsFor(state, P1, "t"), ["name", "combat: hp conditions rangeRings rest", "notes: notes", "position: position sight", "image: image", "stats", "settings"]);
  });

  test("another player on a monster: Combat, and Notes only with the DM's note for everyone. No Position, Image or setup", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(groupsFor(state, P1, "g"), ["name", "combat: hp conditions rangeRings"]);
    state.tokens.g.notes = "Wears the blue sash.";
    assert.deepEqual(groupsFor(state, P1, "g"), ["name", "combat: hp conditions rangeRings", "notes: notes"]);
  });

  test("the DM on an object: Combat without Rest", () => {
    const state = room();
    state.tokens.o = token("o", { kind: "object", actor: { inline: actor() } });
    assert.equal(groupsFor(state, DM, "o")[1], "combat: hp conditions rangeRings");
  });

  test("a companion: its section in the setup beside Owners, for the DM and for its player", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    assert.deepEqual(groupsFor(state, DM, "w", true).slice(-4), ["settings", "companion", "owners", "remove"]);
    assert.ok(groupsFor(state, P1, "w", true).includes("companion"));
  });

  test("every section panelSections gives the DM lands in exactly one part", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    const placed = groupsFor(state, DM, "g").flatMap((p) => (p.includes(": ") ? p.split(": ")[1]!.split(" ") : [p]));
    assert.deepEqual(placed.sort(), sectionsFor(state, DM, "g").sort());
  });

  test("whose folds a tap keeps: the DM's and an owner's own, everyone else's other", () => {
    assert.equal(panelRelation({ dm: true, owner: false }), "own");
    assert.equal(panelRelation({ dm: false, owner: true }), "own");
    assert.equal(panelRelation({ dm: false, owner: false }), "other");
  });
});
