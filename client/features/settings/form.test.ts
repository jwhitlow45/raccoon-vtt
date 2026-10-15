import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, type RoomSettings } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { allFields, drawersOf, moveAnyFor, moveAnyMode, parseFeetPerCell, parseRoomName, settingsOp, settingsPatch, withMover } from "./form.ts";

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
