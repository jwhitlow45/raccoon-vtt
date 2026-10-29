import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type RoomSettings } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { roomHasHexes } from "../grid/words.ts";
import { allFields, choiceOf, drawersOf, moveAnyFor, moveAnyMode, newScenesChoice, newScenesOptions, newScenesShape, parseFeetPerCell, parseRoomName, SETTING_GROUPS, settingGroups, settingsOp, settingsPatch, toggleOn, withMover } from "./form.ts";

describe("settings form", () => {
  test("lists every room setting exactly once", () => {
    const keys = allFields().map((f) => f.key).sort();
    // Settings a room may lack, which read as a default when absent, so DEFAULT_SETTINGS leaves them out.
    const optional: (keyof RoomSettings)[] = ["playersDraw", "newScenePlayers", "newScenes"];
    assert.deepEqual(keys, [...(Object.keys(DEFAULT_SETTINGS) as (keyof RoomSettings)[]), ...optional].sort());
  });

  test("New scenes comes last, with Players see on new scenes, and As before only while a room never set it (docs/design-v1-map-discovery.md 8.2)", () => {
    const group = SETTING_GROUPS.at(-1)!;
    assert.equal(group.heading, "New scenes");
    assert.deepEqual(group.fields.map((f) => f.key), ["newScenePlayers"]);
    const field = group.fields[0]!;
    assert.equal(field.kind, "newScenes");
    if (field.kind !== "newScenes") return;
    assert.equal(field.label, "Players see on new scenes");
    assert.match(field.help, /^New scenes start on this\. Under Explore a map image with no walls starts on Reveal by hand/);
    const older: RoomSettings = { ...DEFAULT_SETTINGS };
    assert.equal(newScenesChoice(older), "before");
    assert.deepEqual(newScenesOptions(field, older).map((o) => o.label), ["Explore", "Reveal by hand", "Everything", "As before"]);
    assert.equal(newScenesOptions(field, older).at(-1)!.help, "Maps and the builder start under fog, battle mats without.");
    const set: RoomSettings = { ...DEFAULT_SETTINGS, newScenePlayers: "explore" };
    assert.equal(newScenesChoice(set), "explore");
    assert.deepEqual(newScenesOptions(field, set).map((o) => o.value), ["explore", "reveal", "all"], "no op takes the setting away, so As before goes once it is set");
    for (const option of field.options) {
      const op = settingsOp(older, { newScenePlayers: option.value });
      assert.ok(op && clientOpSchema.safeParse(op).success, option.value);
    }
    assert.equal(settingsOp(set, { newScenePlayers: "explore" }), null);
  });

  test("who can draw reads every player in a room from before it, and offers no one, every player or chosen ones", () => {
    const field = allFields().find((f) => f.key === "playersDraw");
    assert.equal(field?.kind, "drawers");
    assert.equal(field?.label, "Who can draw");
    if (field?.kind !== "drawers") return;
    assert.deepEqual(field.options.map((o) => o.label), ["No one", "Every player", "Chosen players"]);
    assert.equal(drawersOf(DEFAULT_SETTINGS), "all");
    assert.equal(drawersOf({ playersDraw: "none" }), "none");
    for (const option of field.options) {
      const op = settingsOp(DEFAULT_SETTINGS, { playersDraw: moveAnyFor(option.value, drawersOf(DEFAULT_SETTINGS)) });
      assert.ok(op && clientOpSchema.safeParse(op).success, option.value);
    }
    assert.deepEqual(settingsOp({ ...DEFAULT_SETTINGS, playersDraw: [] }, { playersDraw: withMover([], "p1", true) }), { t: "room.update", settings: { playersDraw: ["p1"] } });
  });

  test("healing brings back the dead sits after Monsters die at 0 HP, and reads an absent value as on (docs/design-v1-combat-flow.md 3.4)", () => {
    const combat = allFields().map((f) => f.key);
    assert.equal(combat.indexOf("healRevives"), combat.indexOf("monstersDieAtZero") + 1);
    const field = allFields().find((f) => f.key === "healRevives")!;
    assert.equal(field.kind, "toggle");
    assert.equal(field.label, "Healing brings back the dead");
    assert.match(field.help, /only the DM's Revive/);
    const { healRevives: _absent, ...older } = DEFAULT_SETTINGS;
    assert.equal(toggleOn(older as RoomSettings, "healRevives"), true, "a room from before the setting");
    assert.equal(toggleOn({ ...DEFAULT_SETTINGS, healRevives: false }, "healRevives"), false);
    assert.equal(toggleOn({ ...DEFAULT_SETTINGS, healRevives: true }, "healRevives"), true);
    assert.equal(toggleOn({ ...DEFAULT_SETTINGS, skipDefeated: false }, "skipDefeated"), false);
    const off = settingsOp(older as RoomSettings, { healRevives: false });
    assert.deepEqual(off, { t: "room.update", settings: { healRevives: false } });
    assert.ok(clientOpSchema.safeParse(off).success);
  });

  test("critical hit damage offers the four rules in a line each, marks the 2024 one, and shows it picked in a room from before the setting", () => {
    const field = allFields().find((f) => f.key === "critRule");
    assert.equal(field?.kind, "choice");
    if (field?.kind !== "choice") return;
    assert.equal(field.label, "Critical Hit damage");
    assert.equal(SETTING_GROUPS.find((g) => g.fields.includes(field))?.heading, "Combat");
    assert.deepEqual(
      field.options.map((o) => [o.value, o.label]),
      [
        ["rollTwice", "Roll the dice twice"],
        ["maxPlusRoll", "Max plus a roll"],
        ["doubleDice", "Double the dice rolled"],
        ["doubleTotal", "Double the total"],
      ],
    );
    assert.deepEqual(field.options.map((o) => /2024/.test(o.help)), [true, false, false, false]);
    for (const text of [field.help, ...field.options.map((o) => o.help)]) assert.doesNotMatch(text, /\n/);
    assert.equal(DEFAULT_SETTINGS.critRule, "rollTwice");
    const { critRule: _absent, ...older } = DEFAULT_SETTINGS;
    assert.equal(choiceOf(older as RoomSettings, "critRule"), "rollTwice");
    assert.equal(choiceOf({ ...DEFAULT_SETTINGS, critRule: "maxPlusRoll" }, "critRule"), "maxPlusRoll");
    assert.equal(choiceOf(DEFAULT_SETTINGS, "diagonal"), "five");
    assert.deepEqual(settingsOp(older as RoomSettings, { critRule: "maxPlusRoll" }), { t: "room.update", settings: { critRule: "maxPlusRoll" } });
  });

  test("the initiative order players see sits after Reveal hidden combatants, starts new rooms on the party, and reads an older room as everyone (docs/design-v1-combat-flow.md 11.1)", () => {
    const combat = allFields().map((f) => f.key);
    assert.equal(combat.indexOf("playersSeeOrder"), combat.indexOf("revealHiddenOnTurn") + 1);
    const field = allFields().find((f) => f.key === "playersSeeOrder");
    assert.equal(field?.kind, "choice");
    if (field?.kind !== "choice") return;
    assert.equal(field.label, "Initiative order players see");
    assert.equal(SETTING_GROUPS.find((g) => g.fields.includes(field))?.heading, "Combat");
    assert.deepEqual(
      field.options.map((o) => [o.value, o.label]),
      [
        ["party", "Player characters, the rest on their turn"],
        ["allies", "Player characters and allies, the rest on their turn"],
        ["all", "Everyone"],
      ],
    );
    assert.match(field.help, /hide stays out/);
    assert.match(field.options[0]!.help, /first turn comes, and stays/);
    assert.match(field.options[1]!.help, /Ally ring/);
    assert.equal(DEFAULT_SETTINGS.playersSeeOrder, "party");
    const { playersSeeOrder: _absent, ...older } = DEFAULT_SETTINGS;
    assert.equal(choiceOf(older as RoomSettings, "playersSeeOrder"), "all", "a room from before the setting");
    assert.equal(choiceOf({ ...DEFAULT_SETTINGS, playersSeeOrder: "allies" }, "playersSeeOrder"), "allies");
    const op = settingsOp(older as RoomSettings, { playersSeeOrder: "party" });
    assert.deepEqual(op, { t: "room.update", settings: { playersSeeOrder: "party" } });
    assert.ok(clientOpSchema.safeParse(op).success);
    assert.equal(clientOpSchema.safeParse({ t: "room.update", settings: { playersSeeOrder: "monsters" } }).success, false);
  });

  test("Skip defeated says what Next passes over: any dead creature, a player character's row included", () => {
    const field = allFields().find((f) => f.key === "skipDefeated")!;
    assert.equal(field.label, "Skip defeated creatures");
    assert.match(field.help, /dead creatures/);
    assert.doesNotMatch(`${field.label} ${field.help}`, /monster/i);
  });

  test("each control matches its setting's type, and every choice is a valid value", () => {
    for (const field of allFields()) {
      const value = DEFAULT_SETTINGS[field.key];
      if (field.kind === "toggle") assert.equal(typeof value, "boolean", field.key);
      if (field.kind === "number") assert.equal(typeof value, "number", field.key);
      if (field.kind === "seconds") {
        assert.ok(field.options.some((o) => o.value === value), `${field.key} offers its default`);
        for (const option of field.options) assert.ok(clientOpSchema.safeParse({ t: "room.update", settings: { [field.key]: option.value } }).success, `${field.key}=${option.value}`);
      }
      if (field.kind === "choice") {
        assert.ok(field.options.some((o) => o.value === value), `${field.key} offers its default`);
        for (const option of field.options) {
          const op = settingsOp(DEFAULT_SETTINGS, { [field.key]: option.value });
          if (op) assert.ok(clientOpSchema.safeParse(op).success, `${field.key}=${option.value}`);
        }
      }
    }
  });

  test("who can move any token starts at no one, and offers every player or chosen ones", () => {
    const field = allFields().find((f) => f.key === "playersMoveAny");
    assert.equal(field?.kind, "movers");
    assert.equal(field?.label, "Who can move any token");
    assert.equal(DEFAULT_SETTINGS.playersMoveAny, "none");
    if (field?.kind !== "movers") return;
    assert.deepEqual(field.options.map((o) => o.label), ["No one", "Every player", "Chosen players"]);
    for (const option of field.options) {
      const op = settingsOp(DEFAULT_SETTINGS, { playersMoveAny: moveAnyFor(option.value, DEFAULT_SETTINGS.playersMoveAny) });
      if (op) assert.ok(clientOpSchema.safeParse(op).success, option.value);
    }
  });

  test("picking players: a mode keeps the players chosen, and a tick adds or takes one", () => {
    assert.equal(moveAnyMode("none"), "none");
    assert.equal(moveAnyMode("all"), "all");
    assert.equal(moveAnyMode([]), "some");
    assert.deepEqual(moveAnyFor("some", "all"), []);
    assert.deepEqual(moveAnyFor("some", ["p1"]), ["p1"]);
    assert.equal(moveAnyFor("all", ["p1"]), "all");
    assert.deepEqual(withMover([], "p1", true), ["p1"]);
    assert.deepEqual(withMover(["p1", "p2"], "p1", false), ["p2"]);
    assert.deepEqual(withMover(["p1"], "p1", true), ["p1"]);
    assert.deepEqual(withMover("all", "p2", true), ["p2"]);
  });

  test("a change becomes a patch of only what differs", () => {
    assert.deepEqual(settingsPatch(DEFAULT_SETTINGS, { playersMoveAny: "all", skipDefeated: true }), { playersMoveAny: "all" });
    assert.equal(settingsPatch({ ...DEFAULT_SETTINGS, playersMoveAny: ["p1"] }, { playersMoveAny: ["p1"] }), null, "a list compares by its contents");
    assert.deepEqual(settingsPatch({ ...DEFAULT_SETTINGS, playersMoveAny: ["p1"] }, { playersMoveAny: ["p1", "p2"] }), { playersMoveAny: ["p1", "p2"] });
    assert.equal(settingsPatch(DEFAULT_SETTINGS, { diagonal: "five" }), null);
    assert.equal(settingsOp(DEFAULT_SETTINGS, {}), null);
    const op = settingsOp(DEFAULT_SETTINGS, { feetPerCell: 10, diagonal: "fiveTen" });
    assert.deepEqual(op, { t: "room.update", settings: { feetPerCell: 10, diagonal: "fiveTen" } });
    assert.ok(clientOpSchema.safeParse(op).success);
  });

  test("feet per square must be a whole number from 1 to 100", () => {
    assert.deepEqual(parseFeetPerCell(" 5 "), { ok: true, value: 5 });
    assert.deepEqual(parseFeetPerCell("100"), { ok: true, value: 100 });
    assert.equal(parseFeetPerCell("0").ok, false);
    assert.equal(parseFeetPerCell("101").ok, false);
    assert.equal(parseFeetPerCell("2.5").ok, false);
    assert.equal(parseFeetPerCell("").ok, false);
  });

  test("the room name is trimmed and bounded", () => {
    assert.deepEqual(parseRoomName("  Tuesday  "), { ok: true, value: "Tuesday" });
    assert.equal(parseRoomName("   ").ok, false);
    assert.equal(parseRoomName("x".repeat(81)).ok, false);
  });

  test("Grid on new scenes is last in Grid and distance, squares by default, and squares in a square room send nothing (docs/design-v1-hex-grids.md HX-D19)", () => {
    const group = SETTING_GROUPS.find((g) => g.heading === "Grid and distance")!;
    const field = group.fields.at(-1)!;
    assert.equal(field.key, "newScenes");
    assert.equal(field.label, "Grid on new scenes");
    assert.equal(field.help, "The grid a new battle mat or map starts with. Builder scenes and starter maps start on squares. Each new scene can pick its own.");
    assert.equal(field.kind, "gridShape", "the scene's own Grid shape choice, with its words");
    assert.equal(newScenesShape(DEFAULT_SETTINGS), "squares");
    assert.equal(newScenesShape({ newScenes: "hexColumns" }), "hexColumns");
    const op = settingsOp(DEFAULT_SETTINGS, { newScenes: "hexRows" });
    assert.ok(op && clientOpSchema.safeParse(op).success);
    assert.equal(settingsOp(DEFAULT_SETTINGS, { newScenes: "squares" } as unknown as Partial<RoomSettings>), null, "squares are no shape at all");
    const back = settingsOp({ ...DEFAULT_SETTINGS, newScenes: "hexRows" }, { newScenes: "squares" } as unknown as Partial<RoomSettings>);
    assert.ok(back && clientOpSchema.safeParse(back).success, "squares take the shape away again");
  });

  test("a room with hexes names squares or hexes, and a square room's words stay as they were (docs/design-v1-hex-grids.md section 6)", () => {
    assert.equal(settingGroups(false), SETTING_GROUPS);
    const hex = settingGroups(true).flatMap((g) => g.fields);
    const by = (key: string) => hex.find((f) => f.key === key)!;
    assert.equal(by("feetPerCell").label, "Feet per square or hex");
    assert.match(by("diagonal").help, /On hex scenes every hex is one step\. This rule counts only height there\.$/);
    assert.equal(by("aoeCoverage").label, "Which squares or hexes an area covers");
    const cover = by("aoeCoverage");
    if (cover.kind !== "choice") return assert.fail();
    assert.deepEqual(cover.options.map((o) => o.label), ["At least half the square or hex", "Any part of the square or hex", "The square's or hex's center"]);
    assert.equal(cover.options[0]!.help, "The 2024 rule.", "an option's own help stays where the words name no cell");
    const caught = by("aoeInclusion");
    if (caught.kind !== "choice") return assert.fail();
    assert.equal(caught.options[0]!.label, "Any square or hex the creature is in");
    assert.deepEqual(hex.map((f) => f.key), allFields().map((f) => f.key), "the same settings in the same order");
    assert.equal(roomHasHexes([{}, {}], {}), false);
    assert.equal(roomHasHexes([{}, { gridShape: "hexColumns" }], {}), true);
    assert.equal(roomHasHexes([], { newScenes: "hexRows" }), true);
  });
});
