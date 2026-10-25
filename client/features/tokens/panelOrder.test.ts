import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LimitedUse } from "#shared/dice/uses.ts";
import type { Actor, Character, RoomState, Token, TurnRecord } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, actor, character, entry, room, token } from "#shared/testutil.ts";
import { attachControls, barSlots } from "../attach/detach.ts";
import { currentRecord, usesPresence } from "../combat/logic.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import { characterAccess, ownsCharacter, tokenAccess } from "./access.ts";
import {
  cardCombat,
  cardGroups,
  combatSummary,
  holdsClassResources,
  offersMakeCompanion,
  panelGroups,
  panelRelation,
  panelSections,
  reactionSpent,
  type CardPartId,
  type PanelGroupsInput,
  type PanelPart,
  type PanelSectionId,
} from "./panelOrder.ts";

const { reactionFor } = await import("../encounter/ReactionSection.tsx");

/** A viewer's own copy of the room, read as the client's helpers read it. */
const seen = (state: RoomState, viewer: typeof DM) => projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;

type Opts = {
  companion?: boolean;
  /** The creature's block's uses as this device read them, none by default, null while it loads. */
  uses?: readonly LimitedUse[] | null;
  /** Whether the attach controls are read by the bar's slots alone, as the design rejected (a mutation's stand-in). */
  slotsOnly?: boolean;
};

/**
 * The panel's input for a viewer on a token, worked out from their own
 * copy of the room as TokenPanel does: access from ownership, the stat
 * block from its link, Stats from what the copy holds, Uses from its
 * presence, Reaction from the row and attach controls as the bar offers
 * them.
 */
function inputFor(state: RoomState, viewer: typeof DM, tokenId: string, opts: Opts = {}): PanelGroupsInput {
  const view = seen(state, viewer);
  const t = view.tokens[tokenId] as Token;
  const companion = opts.companion ?? t.companion !== undefined;
  const character = ("ref" in t.actor ? view.characters[t.actor.ref] : undefined) as Character | undefined;
  const access = tokenAccess({ role: viewer.role, memberId: viewer.memberId, view: { characters: character ? { [character.id]: character } : {} }, token: t });
  const a = ("inline" in t.actor ? t.actor.inline : character?.actor) as Partial<Actor> | undefined;
  const playsCharacter = character !== undefined && ownsCharacter(viewer.memberId, character);
  const you = { role: viewer.role, memberId: viewer.memberId };
  const uses = opts.uses === undefined ? [] : opts.uses;
  return {
    dm: access.dm,
    owner: access.owner,
    kind: t.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: t.kind, actor: a, companion }),
    actor: a !== undefined && (character === undefined || access.dm || playsCharacter),
    ownerRenames: !access.dm && access.canEditToken("name"),
    classResources: holdsClassResources({ dm: access.dm, character: character !== undefined, playsCharacter }),
    uses: access.full ? usesPresence({ actor: a, resources: character?.resources, uses, loading: uses === null, record: currentRecord(view.encounter, a) }) : "no",
    reaction: reactionFor(view, you, { tokenId }) !== null,
    attach: opts.slotsOnly ? barSlots(view, you, t).length > 0 : attachControls(view, you, t),
    locked: t.locked,
    dismiss: access.dismiss,
    // As TokenPanel decides it, the card's notes included.
    notes: access.canEditToken("notes") || !!t.notes || access.dm || (access.full && a !== undefined && (access.canEditActor("notes") || a.notes !== undefined)),
    image: access.canEditToken("image"),
  };
}

/** The sections a viewer gets for a token, in panelSections' order. */
function sectionsFor(state: RoomState, viewer: typeof DM, tokenId: string, opts: Opts = {}): PanelSectionId[] {
  return panelSections(inputFor(state, viewer, tokenId, opts));
}

/** The panel's parts as the panel draws them, in one line each: "name", "combat: hp conditions". */
function groupsFor(state: RoomState, viewer: typeof DM, tokenId: string, opts: Opts = {}): string[] {
  return panelGroups(inputFor(state, viewer, tokenId, opts)).map((p: PanelPart) => (p.group === null ? p.id : `${p.group}: ${p.sections.join(" ")}`));
}

/** One group's sections as the panel draws them, or null without that group. */
function groupOf(state: RoomState, viewer: typeof DM, tokenId: string, group: string, opts: Opts = {}): string | null {
  const line = groupsFor(state, viewer, tokenId, opts).find((p) => p.startsWith(`${group}: `));
  return line === undefined ? null : line.slice(group.length + 2);
}

const PLAY: PanelSectionId[] = ["hp", "conditions", "position", "rangeRings", "notes"];

/**
 * A fight under way: the dragon (legendary counts) and a goblin with rows,
 * Thorn's token (Pat's, p1) with his row, Skitter sharing his turn, and
 * Bree's token lent to p2 with her row keyed by the character. A crate on
 * the map with no row.
 */
function fight(): RoomState {
  const state = room({
    characters: {
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], resources: [{ id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne" }] }),
      bree: character("bree", { name: "Bree", ownerIds: [], resources: [{ id: "loh", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true }] }),
    },
  });
  state.tokens.dragon = token("dragon", { name: "Dragon", actor: { inline: actor({ legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } });
  state.tokens.goblin = token("goblin", { name: "Goblin", actor: { inline: actor() } });
  state.tokens.thornT = token("thornT", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } });
  state.tokens.skitter = token("skitter", { kind: "npc", name: "Skitter", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor() } });
  state.tokens.breeT = token("breeT", { kind: "pc", name: "Bree", ownerIds: ["p2"], actor: { ref: "bree" } });
  state.tokens.crate = token("crate", { kind: "object", name: "Crate", actor: { inline: actor() } });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "et",
    entries: [entry("et", { tokenId: "thornT", value: 18 }), entry("ed", { tokenId: "dragon", value: 16 }), entry("eb", { characterId: "bree", value: 15 }), entry("eg", { tokenId: "goblin", value: 10 })],
  };
  return state;
}

describe("the token panel's order", () => {
  test("the DM on an SRD monster: name, image, the block, play, then setup at the foot", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(sectionsFor(state, DM, "g"), ["name", "image", "statBlock", "hp", "conditions", "position", "attach", "rangeRings", "notes", "rest", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on an unlinked NPC still gets the stat block row, for Attach", () => {
    const state = room();
    state.tokens.n = token("n", { kind: "npc", actor: { inline: actor() } });
    assert.deepEqual(sectionsFor(state, DM, "n").slice(0, 3), ["name", "image", "statBlock"]);
  });

  test("the DM on a character with no stat block: play under the image, Uses for its class resources", () => {
    const state = room();
    state.characters.c = character("c");
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, DM, "t"), ["name", "image", "hp", "conditions", "uses", "position", "attach", "rangeRings", "notes", "rest", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on an object: no rest", () => {
    const state = room();
    state.tokens.o = token("o", { kind: "object", actor: { inline: actor() } });
    assert.deepEqual(sectionsFor(state, DM, "o"), ["name", "image", "hp", "conditions", "position", "attach", "rangeRings", "notes", "sight", "stats", "settings", "owners", "remove"]);
  });

  test("the DM on a companion: its section after Token settings and before Owners", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    const sections = sectionsFor(state, DM, "w", { companion: true });
    assert.deepEqual(sections.slice(-4), ["settings", "companion", "owners", "remove"]);
  });

  test("an owner of a character: Uses, Stats and Token settings with their Name fields, no Owners or Remove", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(sectionsFor(state, P1, "t"), ["name", "image", "hp", "conditions", "uses", "position", "attach", "rangeRings", "notes", "rest", "sight", "stats", "settings"]);
  });

  test("an owner of a character's token without the character: no stat block, no class resources, and Stats for its Size alone", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p2"] });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], actor: { ref: "c" } });
    const input = inputFor(state, P1, "t");
    const sections = panelSections(input);
    assert.equal(sections.includes("statBlock"), false);
    assert.equal(sections.includes("uses"), false, "the character's resources are not theirs");
    assert.equal(input.actor, false, "no stat card");
    assert.ok(sections.includes("stats"), "Stats, for Size");
  });

  test("an owner of a companion: its section, Token settings for its name, and Remove for Dismiss", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], companion: { of: "c", turn: "own" }, actor: { inline: actor() } });
    const sections = sectionsFor(state, P1, "w");
    assert.ok(sections.includes("companion"));
    assert.equal(sections.includes("owners"), false);
    assert.equal(sections.at(-1), "remove", "Dismiss, in Delete's place");
  });

  test("an owner of an SRD Wild Shape reads its block", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ srdId: "brown-bear" }) } });
    assert.deepEqual(sectionsFor(state, P1, "w").slice(0, 3), ["name", "image", "statBlock"]);
  });

  test("another player on a monster: name, image, then play, no Position, Sight or setup", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(sectionsFor(state, P1, "g"), ["name", "image", "hp", "conditions", "rangeRings", "notes"]);
  });

  test("a creature companion's player gets its stat block row with no link, for Attach, and an effect's gets none (docs/design-v1-companion-stat-blocks.md 6.5)", () => {
    const state = room({ characters: { bree: character("bree", { ownerIds: ["p1"] }) } });
    state.tokens.owl = token("owl", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor() } });
    state.tokens.blade = token("blade", { kind: "object", ownerIds: ["p1"], companion: { of: "bree", turn: "none" }, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0, srdId: "owl" }) } });
    assert.deepEqual(sectionsFor(state, P1, "owl").slice(0, 3), ["name", "image", "statBlock"]);
    assert.equal(sectionsFor(state, P1, "blade").includes("statBlock"), false);
    assert.equal(sectionsFor(state, DM, "blade").includes("statBlock"), false);
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
    assert.deepEqual(groupsFor(state, DM, "g"), ["name", "statBlock", "combat: hp conditions rangeRings rest", "notes: notes", "position: position attach sight", "image: image", "stats", "settings", "owners", "remove"]);
  });

  test("an owner of a character: the same groups, Uses in Combat, and setup without Owners or Remove", () => {
    const state = room();
    state.characters.c = character("c", { ownerIds: ["p1"] });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "c" } });
    assert.deepEqual(groupsFor(state, P1, "t"), ["name", "combat: hp conditions uses rangeRings rest", "notes: notes", "position: position attach sight", "image: image", "stats", "settings"]);
  });

  test("another player on a monster: Combat, and Notes only with the DM's note for everyone. No Position, Image or setup", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ srdId: "goblin-warrior" }) } });
    assert.deepEqual(groupsFor(state, P1, "g"), ["name", "combat: hp conditions rangeRings"]);
    state.tokens.g.notes = "Wears the blue sash.";
    assert.deepEqual(groupsFor(state, P1, "g"), ["name", "combat: hp conditions rangeRings", "notes: notes"]);
  });

  test("a companion: its section in the setup beside Owners, for the DM and for its player", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor() } });
    assert.deepEqual(groupsFor(state, DM, "w", { companion: true }).slice(-4), ["settings", "companion", "owners", "remove"]);
    assert.ok(groupsFor(state, P1, "w", { companion: true }).includes("companion"));
  });

  test("every section panelSections gives lands in exactly one part, once, whoever looks", () => {
    const state = fight();
    state.tokens.mule = token("mule", { name: "Mule", size: "large", x: 12, y: 12, actor: { inline: actor() } });
    state.tokens.pack = token("pack", { kind: "object", name: "Pack", size: "tiny", x: 12, y: 12, attached: { to: "mule", kind: "carry" }, actor: { inline: actor() } });
    for (const viewer of [DM, P1, P2]) {
      for (const id of Object.keys(state.tokens)) {
        if (seen(state, viewer).tokens[id] === undefined) continue;
        const input = inputFor(state, viewer, id);
        const sections = panelSections(input);
        assert.equal(new Set(sections).size, sections.length, `${viewer.memberId} on ${id}: ${sections.join(" ")}`);
        // Notes and Image draw only with something to read or change there (panelGroups' own inputs).
        const drawn = sections.filter((s) => (s !== "notes" || input.notes) && (s !== "image" || input.image));
        const placed = groupsFor(state, viewer, id).flatMap((p) => (p.includes(": ") ? p.split(": ")[1]!.split(" ") : [p]));
        assert.deepEqual([...placed].sort(), [...drawn].sort(), `${viewer.memberId} on ${id}`);
      }
    }
  });

  test("whose folds a tap keeps: the DM's and an owner's own, everyone else's other", () => {
    assert.equal(panelRelation({ dm: true, owner: false }), "own");
    assert.equal(panelRelation({ dm: false, owner: true }), "own");
    assert.equal(panelRelation({ dm: false, owner: false }), "other");
  });
});

describe("Combat's sections (docs/design-v1-token-sections.md 3)", () => {
  const state = fight();

  test("in a fight, Combat runs Hit points, Conditions, Uses, Reaction, Range rings, Rest, for the DM and an owner", () => {
    assert.equal(groupOf(state, DM, "dragon", "combat"), "hp conditions uses reaction rangeRings rest", "the DM on the dragon");
    assert.equal(groupOf(state, P1, "thornT", "combat"), "hp conditions uses reaction rangeRings rest", "Pat on Thorn");
  });

  test("another player reads Hit points, Conditions and the rings alone, in or out of a fight", () => {
    assert.equal(groupOf(state, P2, "dragon", "combat"), "hp conditions rangeRings");
    assert.equal(groupOf(state, P2, "goblin", "combat"), "hp conditions rangeRings");
  });

  test("a player lent a character's token, its row keyed by the character: no Uses and no Reaction", () => {
    assert.equal(groupOf(state, P2, "breeT", "combat"), "hp conditions rangeRings rest");
  });

  test("a companion sharing its character's turn holds a Reaction of its own, for the DM and its player", () => {
    assert.equal(groupOf(state, P1, "skitter", "combat"), "hp conditions reaction rangeRings rest");
    assert.equal(groupOf(state, DM, "skitter", "combat"), "hp conditions reaction rangeRings rest");
  });

  test("an object: no Rest, and Reaction only with a row of its own", () => {
    assert.equal(groupOf(state, DM, "crate", "combat"), "hp conditions rangeRings");
  });

  test("Uses shows only with something in it, or for a character's DM and players, who add class resources there", () => {
    assert.equal(sectionsFor(state, DM, "goblin").includes("uses"), false, "a goblin with no use");
    assert.ok(sectionsFor(state, DM, "goblin", { uses: null }).includes("uses"), "a block still loading, as the bar's button holds its place");
    assert.ok(sectionsFor(state, DM, "goblin", { uses: [{ kind: "day", key: "web", name: "Web", max: 1 } as LimitedUse] }).includes("uses"), "a block's use");
    assert.ok(sectionsFor(state, DM, "dragon").includes("uses"), "legendary counts");
    assert.equal(sectionsFor(state, P2, "dragon").includes("uses"), false, "never to another player");
    const bare = fight();
    bare.characters.thorn!.resources = undefined;
    assert.ok(sectionsFor(bare, DM, "thornT").includes("uses"), "Thorn with no resource yet, for the DM");
    assert.ok(sectionsFor(bare, P1, "thornT").includes("uses"), "and for Pat");
    assert.equal(sectionsFor(bare, P1, "skitter").includes("uses"), false, "a companion with nothing in it");
  });

  test("a creature whose only rows are the turn's skipped prompts shows Uses while the turn lasts (D-261024-40)", () => {
    const skipped = fight();
    skipped.encounter!.activeEntryId = "eg";
    const record: TurnRecord = { id: 3, entryId: "eg", round: 1, hp: 0, life: "dying", settled: { deathSave: { state: "skipped" } } };
    (skipped.tokens.goblin!.actor as { inline: Actor }).inline.turnRecord = record;
    assert.ok(sectionsFor(skipped, DM, "goblin").includes("uses"));
    skipped.encounter!.activeEntryId = "et";
    assert.equal(sectionsFor(skipped, DM, "goblin").includes("uses"), false, "gone after Next");
  });

  test("Reaction shows only with a row in the fight, for the DM or the row's owner", () => {
    assert.ok(sectionsFor(state, DM, "goblin").includes("reaction"));
    assert.equal(sectionsFor(state, P1, "goblin").includes("reaction"), false, "not Pat's row");
    assert.ok(sectionsFor(state, P1, "thornT").includes("reaction"));
    assert.equal(sectionsFor(state, DM, "crate").includes("reaction"), false, "no row");
    const calm = fight();
    calm.encounter = null;
    for (const id of ["dragon", "thornT", "skitter"]) assert.equal(sectionsFor(calm, DM, id).includes("reaction"), false, `no fight: ${id}`);
  });

  test("a character's page: Hit points, Conditions, Uses, Reaction while its row is the viewer's to mark, Rest, and never rings", () => {
    assert.deepEqual(cardCombat({ reaction: true }), ["hp", "conditions", "uses", "reaction", "rest"]);
    assert.deepEqual(cardCombat({ reaction: false }), ["hp", "conditions", "uses", "rest"]);
    const you = (v: typeof DM) => ({ role: v.role, memberId: v.memberId });
    assert.ok(reactionFor(seen(state, P1), you(P1), { characterId: "thorn" }) !== null, "Pat on Thorn's page");
    assert.equal(reactionFor(seen(state, P2), you(P2), { characterId: "thorn" }), null, "not Quinn's");
  });

  test("Combat's summary: Reaction used before the rings, for every viewer while it is spent", () => {
    const spent = fight();
    spent.encounter!.entries.find((e) => e.id === "eg")!.reactionUsed = true;
    spent.tokens.skitter!.companion!.reactionUsed = true;
    for (const viewer of [DM, P1, P2]) assert.equal(reactionSpent(seen(spent, viewer), { tokenId: "goblin" }), true, viewer.memberId);
    assert.equal(reactionSpent(seen(spent, DM), { tokenId: "skitter" }), true, "a companion's own");
    assert.equal(reactionSpent(seen(spent, DM), { tokenId: "thornT" }), false, "its character's row is not spent");
    assert.equal(reactionSpent(seen(spent, DM), { tokenId: "crate" }), false, "no row");
    assert.equal(combatSummary({ hp: "HP 52/60", effects: 1, reactionUsed: true, rings: [30] }), "HP 52/60 · 1 condition · Reaction used · rings 30 ft");
    assert.equal(combatSummary({ hp: "HP 7/7", effects: 2, reactionUsed: false }), "HP 7/7 · 2 conditions");
  });
});

describe("setup and Position for each viewer (docs/design-v1-token-sections.md 3 and 3.3)", () => {
  test("Remove for the DM, and for a companion's player, who dismisses it, never for anyone else", () => {
    const state = fight();
    assert.ok(sectionsFor(state, DM, "skitter").includes("remove"));
    assert.ok(sectionsFor(state, P1, "skitter").includes("remove"));
    assert.equal(sectionsFor(state, P1, "thornT").includes("remove"), false, "Thorn's token is the DM's to delete");
    assert.equal(sectionsFor(state, P2, "skitter").includes("remove"), false);
  });

  test("Stats holds Size alone for a player lent a character's token while it is unlocked, a Custom size included", () => {
    const state = fight();
    const lent = inputFor(state, P2, "breeT");
    assert.equal(lent.actor, false, "no stat card");
    assert.ok(panelSections(lent).includes("stats"));
    state.tokens.breeT = { ...state.tokens.breeT!, size: "custom", w: 3, h: 2 };
    assert.ok(sectionsFor(state, P2, "breeT").includes("stats"), "Custom, read only in the bar's words");
    state.tokens.breeT = { ...state.tokens.breeT!, locked: true };
    assert.equal(sectionsFor(state, P2, "breeT").includes("stats"), false, "locked");
    assert.equal(sectionsFor(state, P1, "breeT").includes("stats"), false, "not theirs");
  });

  test("Position: everything for the DM and owners, the attach controls alone for a player the room lets move any token", () => {
    const state = fight();
    assert.equal(groupOf(state, P2, "goblin", "position"), null, "a goblin is not Quinn's to move");
    state.meta.settings.playersMoveAny = "all";
    assert.equal(groupOf(state, P2, "goblin", "position"), "attach", "Attach alone");
    assert.equal(groupOf(state, P1, "thornT", "position"), "position attach sight");
  });

  test("Position for a player whose creature drags a goblin: Let go alone, on the goblin's panel", () => {
    const state = fight();
    state.tokens.thornT = { ...state.tokens.thornT!, x: 3, y: 3 };
    state.tokens.goblin = { ...state.tokens.goblin!, x: 4, y: 3, attached: { to: "thornT", kind: "drag" } };
    assert.equal(groupOf(state, P1, "goblin", "position"), "attach");
    assert.equal(groupOf(state, P2, "goblin", "position"), null, "nobody else's");
  });

  test("Position for a player whose creature a goblin drags: the group line's Let go alone, on the goblin's panel, which its bar's slots alone miss", () => {
    const state = fight();
    state.tokens.goblin = { ...state.tokens.goblin!, x: 3, y: 3 };
    state.tokens.thornT = { ...state.tokens.thornT!, x: 4, y: 3, attached: { to: "goblin", kind: "drag" } };
    assert.equal(groupOf(state, P1, "goblin", "position"), "attach");
    assert.equal(groupOf(state, P1, "goblin", "position", { slotsOnly: true }), null, "the bar's slots alone hide the holder's Let go");
    assert.equal(groupOf(state, P2, "goblin", "position"), null, "nobody else's");
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
