import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";

/*
 * Menu, This device, Features (docs/design/design-v1-features.md 5): its
 * words as section 5 quotes them, the presets and the own choice line, a
 * dependent's help while its need hides, the groups' summaries, the
 * search over the parts and the core list, and the page as it draws for
 * each role, with each switch's anchor the one its "Show" result routes to.
 */

const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const page = await import("./FeaturesPage.tsx");
const { switchAnchor } = await import("./search.ts");
const { MODULE_IDS, modulesFor, moduleById, simpleFor } = await import("./registry.ts");
const { NO_CHOICES, withChoice, withPreset } = await import("./store.ts");
const { applyPreset, resetAllFeatures, setModuleShown, showModule } = await import("./store.ts");

const { FEATURES_WORDS, SWITCH_ANCHORS, coreMatching, featuresValue, groupSummary, ownChoiceLine, partsMatching, partsWord, switchHelp } = page;

function draw(role: "dm" | "player"): string {
  const store = createStore(() => ({ roomId: "K7QH2MXA", you: { memberId: "m1", role }, view: null, local: {} }));
  return renderToStaticMarkup(
    createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(page.default) }) }),
  );
}

describe("the Features page's words", () => {
  test("section 5's words, whole", () => {
    assert.equal(FEATURES_WORDS.rowHelp, "Hide the parts you don't use, on this device.");
    assert.equal(FEATURES_WORDS.help, "Hide the parts of the app you don't use. Only this device changes. Everyone else, the game and its rules stay as they are.");
    assert.deepEqual(FEATURES_WORDS.role, { dm: "For your DM rooms on this device.", player: "For the rooms you play in on this device." });
    assert.equal(FEATURES_WORDS.simpleHelp.dm, "The map, tokens, monsters, fog, dice and turns, with Ruler, Areas, Draw and Ping.");
    assert.equal(FEATURES_WORDS.simpleHelp.player, "Your character's HP, conditions and rolls, turns, Ruler and Ping, and what the DM shares.");
    assert.equal(FEATURES_WORDS.resetConfirm, "Tap again to show every part, as the DM and as a player");
    assert.equal(FEATURES_WORDS.resetHelp, "Shows every part again on this device, for the DM and for players.");
  });

  test("the row's value and the own choice line: Everything, Simple, or how many hide", () => {
    assert.equal(featuresValue("dm", NO_CHOICES), "Everything");
    assert.equal(ownChoiceLine("dm", NO_CHOICES), null);
    const simple = withPreset(NO_CHOICES, "player", "simple");
    assert.equal(featuresValue("player", simple), "Simple");
    assert.equal(ownChoiceLine("player", simple), null);
    // Simple, then one switch changed: neither preset holds (section 13).
    const own = withChoice(simple, "player", "ping", false);
    // Simple keeps eight of a player's sixteen parts, so eight hide, and Ping makes nine.
    assert.equal(simpleFor("player").size, 8);
    assert.equal(featuresValue("player", own), "9 hidden");
    assert.equal(ownChoiceLine("player", own), "Your own choice: 9 parts hidden.");
    assert.equal(ownChoiceLine("dm", withChoice(NO_CHOICES, "dm", "sound", false)), "Your own choice: 1 part hidden.");
    assert.equal(partsWord(1), "1 part");
    assert.equal(partsWord(4), "4 parts");
  });

  test("a part whose need hides says what turning it on shows too, its own help otherwise", () => {
    const dungeon = moduleById("dungeon");
    assert.equal(switchHelp(dungeon, "dm", NO_CHOICES), "Generate a dungeon for a new scene, or add a wing.");
    assert.equal(switchHelp(dungeon, "dm", withChoice(NO_CHOICES, "dm", "builder", false)), "Turning it on shows Map builder too.");
    assert.equal(switchHelp(moduleById("sound"), "player", NO_CHOICES), "Music, background sounds and effects the DM plays. Hidden, this device plays none.");
  });

  test("a group's summary: All shown, or how many hide, a need's dependent counted", () => {
    const maps = modulesFor("dm").filter((m) => m.group === "maps");
    assert.equal(groupSummary(maps, "dm", NO_CHOICES), "All shown");
    assert.equal(groupSummary(maps, "dm", withChoice(NO_CHOICES, "dm", "builder", false)), "2 hidden");
  });

  test("Find a part: names, help and other names, a core part's line, and nothing for a player's missing part", () => {
    const ids = (role: "dm" | "player", q: string) => partsMatching(role, q).map((m) => m.id);
    assert.deepEqual(ids("dm", "hit dice"), ["hitDice"]);
    assert.deepEqual(ids("dm", "slots"), ["spellSlots"]);
    assert.ok(ids("dm", "music").includes("sound"));
    assert.deepEqual(ids("dm", "calendar"), ["time"]);
    assert.deepEqual(ids("dm", "3d dice"), ["diceAnimation"]);
    assert.ok(ids("dm", "iso").includes("isometric"));
    assert.deepEqual(ids("player", "trap"), [], "a player has no Traps");
    assert.deepEqual(ids("player", "attacks of opportunity"), ["opportunity"]);
    assert.deepEqual(ids("dm", "disengage"), ["opportunity"]);
    assert.equal(partsMatching("dm", "").length, 24);
    assert.equal(partsMatching("player", "  ").length, 16);
    assert.equal(coreMatching("x-card"), "The X-card always shows.");
    assert.equal(coreMatching("xcard"), null, "a core name is matched as written");
    assert.equal(coreMatching("fog"), "The Fog always shows.");
    assert.equal(coreMatching("x"), null, "one letter names nothing");
  });

  test("each switch's anchor is written whole and is the one its Show result routes to", () => {
    assert.deepEqual(Object.keys(SWITCH_ANCHORS).sort(), [...MODULE_IDS].sort());
    for (const id of MODULE_IDS) assert.equal(SWITCH_ANCHORS[id].search, switchAnchor(id), id);
  });
});

describe("the Features page as it draws", () => {
  test("a DM's: the help, the role line, Start from on Everything, the search, five groups of 24 switches, Always shown and Reset all", () => {
    resetAllFeatures();
    const html = draw("dm");
    for (const words of [FEATURES_WORDS.help.replace("'", "&#x27;"), FEATURES_WORDS.role.dm, "Start from", "Every part shows.", "Find a part", "Always shown", "Reset all", FEATURES_WORDS.resetHelp]) assert.ok(html.includes(words), words);
    for (const group of ["Characters", "Tools", "Maps", "Panels", "Visuals"]) assert.ok(html.includes(`>${group}<`), group);
    assert.equal((html.match(/role="switch"/g) ?? []).length, 24);
    assert.equal((html.match(/role="switch" aria-checked="true"/g) ?? []).length, 24);
    assert.match(html, /checked="" value="everything"/);
    assert.ok(html.includes(`data-search="${switchAnchor("tableDisplay")}"`));
  });

  test("a player's: 16 switches, the player's line, no DM part", () => {
    resetAllFeatures();
    const html = draw("player");
    assert.ok(html.includes(FEATURES_WORDS.role.player));
    assert.equal((html.match(/role="switch"/g) ?? []).length, 16);
    for (const name of ["Map pins", "Traps", "Map builder", "Encounters", "Table display"]) assert.ok(!html.includes(`>${name}<`), name);
  });

  test("hidden parts read off, a need's dependent too, and neither preset is picked for an own choice", () => {
    resetAllFeatures();
    setModuleShown("builder", "dm", false);
    const html = draw("dm");
    assert.equal((html.match(/role="switch" aria-checked="false"/g) ?? []).length, 2, "Map builder and the Dungeon generator, which needs it");
    assert.ok(html.includes("Turning it on shows Map builder too."));
    assert.ok(html.includes("Your own choice: 2 parts hidden."));
    assert.doesNotMatch(html, /type="radio"[^>]*checked=""/, "neither preset is picked");
    // A Show turns the part's needs on, a switch off hides that part alone (D-261127-308).
    showModule("dungeon", "dm");
    assert.doesNotMatch(draw("dm"), /aria-checked="false"/);
    applyPreset("dm", "simple");
    assert.match(draw("dm"), /checked="" value="simple"/);
    resetAllFeatures();
  });
});
