import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Character, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, actor, character, room, token } from "#shared/testutil.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import { characterAccess, tokenAccess } from "./access.ts";
import { cardGroups, offersMakeCompanion, panelGroups, panelRelation, panelSections, type CardPartId, type PanelPart, type PanelSectionId } from "./panelOrder.ts";

/**
 * The sections a viewer gets for a token, worked out from their own copy
 * of the room as the panel does: access from ownership, the stat block
 * from its link, Stats from what the copy holds.
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

  test("the DM on a character with no stat block: play under the image, its numbers being in the name's header", () => {
    const state = room();
    state.characters.c = character("c");
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, DM, "t"), ["name", "image", ...PLAY, "rest", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on an object: no rest", () => {
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

  test("an owner of a character: Stats and Token settings with their Name fields, no Owners or Remove", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, P1, "t"), ["name", "image", ...PLAY, "rest", "sight", "stats", "settings"]);
  });

  test("an owner of a character's token without the character: no stat block", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p2"] });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], actor: { ref: "c" } });
    const sections = sectionsFor(state, P1, "t");
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

/** A character's page's parts for a viewer, from their own copy of the room, as CharacterPage decides them. */
function pageFor(state: ReturnType<typeof room>, viewer: typeof DM, characterId: string, has: { companions?: boolean } = {}): CardPartId[] {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const c = view.characters[characterId] as Character;
  const access = characterAccess({ role: viewer.role, memberId: viewer.memberId, character: c });
  return cardGroups({
    dm: access.dm,
    plays: access.owner,
    statBlock: access.full,
    companions: has.companions ?? true,
    notes: access.canEditActor("notes") || !!c.actor.notes?.trim() || access.dm,
    image: access.canEdit("defaultImage"),
  });
}

describe("a character's page's parts (docs/design-v1-look-pass.md 3.1)", () => {
  const SETUP: CardPartId[] = ["image", "stats"];

  test("the DM: the header, Place a token, the block, Combat, Companions, Notes, setup, Played by and Remove", () => {
    const state = room();
    state.characters.c = character("c");
    assert.deepEqual(pageFor(state, DM, "c"), ["header", "place", "statBlock", "combat", "companions", "notes", ...SETUP, "owners", "remove"]);
  });

  test("a player who plays it alone: the same, with no Played by", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    assert.deepEqual(pageFor(state, P1, "c"), ["header", "place", "statBlock", "combat", "companions", "notes", ...SETUP, "remove"]);
  });

  test("a player who shares it: the same parts, Remove holding the line that says why there is no Delete", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1", "p2"] });
    assert.deepEqual(pageFor(state, P1, "c"), pageFor(state, P2, "c"));
    assert.equal(pageFor(state, P1, "c").at(-1), "remove");
  });

  test("with a block or with none, the stat block follows the header, for Add a stat block or the block itself", () => {
    const state = room();
    state.characters.c = character("c");
    const none = pageFor(state, DM, "c");
    state.characters.c = character("c", { stats: {} as Character["stats"] });
    assert.deepEqual(pageFor(state, DM, "c"), none);
    assert.equal(none.indexOf("statBlock"), none.indexOf("place") + 1);
  });

  test("Companions follows Combat with companions or the right to add one, and is not drawn with neither", () => {
    const state = room();
    state.characters.c = character("c");
    const parts = pageFor(state, P1, "c");
    assert.equal(parts.indexOf("companions"), parts.indexOf("combat") + 1);
    assert.equal(pageFor(state, P1, "c", { companions: false }).includes("companions"), false);
  });

  test("Notes is not drawn with nothing to read and no right to write", () => {
    assert.equal(cardGroups({ dm: false, plays: true, statBlock: true, companions: true, notes: false, image: true }).includes("notes"), false);
  });

  test("anyone else sees the header alone: only the DM and the character's players open its page", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    assert.deepEqual(pageFor(state, P2, "c"), ["header"]);
  });

  test("each part shows exactly once, whoever looks", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1", "p2"] });
    for (const viewer of [DM, P1, P2]) {
      for (const companions of [true, false]) {
        const parts = pageFor(state, viewer, "c", { companions });
        assert.equal(new Set(parts).size, parts.length, `${viewer.memberId}: ${parts.join(" ")}`);
      }
    }
  });
});
