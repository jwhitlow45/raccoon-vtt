import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type RoomSettings } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { allFields, choiceOf, drawersOf, moveAnyFor, moveAnyMode, parseFeetPerCell, parseRoomName, SETTING_GROUPS, settingsOp, settingsPatch, toggleOn, withMover } from "./form.ts";

describe("settings form", () => {
  test("lists every room setting exactly once", () => {
    const keys = allFields().map((f) => f.key).sort();
    // Settings a room may lack, which read as a default when absent, so DEFAULT_SETTINGS leaves them out.
    const optional: (keyof RoomSettings)[] = ["playersDraw"];
    assert.deepEqual(keys, [...(Object.keys(DEFAULT_SETTINGS) as (keyof RoomSettings)[]), ...optional].sort());
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
    assert.equal(field.label, "Critical hit damage");
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
});
