import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { character, DM, P1, P2, room, template, token } from "#shared/testutil.ts";
import { describeEvent } from "../log/format.ts";
import { areaReminderText, arrivals, remindsYou, type AreaEvent } from "./reminders.ts";

const event = (over: Partial<AreaEvent> = {}): AreaEvent => ({ type: "area", templateId: "sg", tokenId: "g2", trigger: "turnEnd", area: "Spirit Guardians", seen: true, ...over });

describe("area reminders on this device", () => {
  test("read as the table says them", () => {
    assert.equal(areaReminderText(event(), "Goblin 2"), "Goblin 2 ended its turn in Spirit Guardians.");
    assert.equal(areaReminderText(event({ trigger: "turnStart", area: "Stinking Cloud" }), "Ayla"), "Ayla started its turn in Stinking Cloud.");
    assert.equal(areaReminderText(event({ trigger: "enter" }), "Goblin 2"), "Goblin 2 entered Spirit Guardians.");
    assert.equal(areaReminderText(event({ trigger: "enter", moved: true }), "Goblin 2"), "Spirit Guardians moved onto Goblin 2.");
    // An area with no name is stored in lowercase, as the reducer has always written it, and reads with the SRD's capitals.
    assert.equal(areaReminderText(event({ trigger: "enter", area: "20 ft sphere" }), "Goblin 2"), "Goblin 2 entered 20 ft Sphere.");
    assert.equal(areaReminderText(event({ trigger: "turnStart", area: "15 ft emanation" }), "Ayla"), "Ayla started its turn in 15 ft Emanation.");
    // An area's size need not be a whole number of feet.
    assert.equal(areaReminderText(event({ trigger: "turnEnd", area: "7.5 ft sphere" }), "Ayla"), "Ayla ended its turn in 7.5 ft Sphere.");
    // The log names the creature as this viewer's view does.
    const s = room({ tokens: { g2: token("g2", { name: "Goblin", number: 2 }) } });
    assert.equal(describeEvent(event(), s), "Goblin 2 ended its turn in Spirit Guardians.");
    assert.equal(describeEvent(event({ tokenId: "gone" }), s), "A creature ended its turn in Spirit Guardians.");
  });

  test("toast for the DM, the creature's player and the area's player, and nobody else", () => {
    const s = room({
      characters: { c1: character("c1", { ownerIds: ["p1"] }) },
      tokens: { g2: token("g2"), ayla: token("ayla", { kind: "pc", actor: { ref: "c1" } }), pet: token("pet", { ownerIds: ["p2"] }) },
      templates: { sg: template("sg", { ownerId: "p1" }), cloud: template("cloud", { ownerId: "dm1" }) },
    });
    assert.ok(remindsYou(event(), DM, s));
    assert.ok(remindsYou(event(), P1, s), "Ayla's player cast it");
    assert.ok(!remindsYou(event(), P2, s));
    assert.ok(remindsYou(event({ templateId: "cloud", tokenId: "ayla" }), P1, s), "Ayla must save");
    assert.ok(remindsYou(event({ templateId: "cloud", tokenId: "pet" }), P2, s));
    assert.ok(!remindsYou(event({ templateId: "cloud", tokenId: "g2" }), P1, s));
  });

  test("an area reaching another player's character reads that player's view without its owners", () => {
    const s = room({
      characters: { c1: character("c1", { ownerIds: ["p1"] }) },
      tokens: { ayla: token("ayla", { kind: "pc", actor: { ref: "c1" } }) },
      templates: { cloud: template("cloud", { ownerId: "dm1" }) },
    });
    // What each device holds: P2's copy of Ayla's character has no owners at all.
    const seen = (viewer: typeof P1) => projectState(s, viewer, { sceneId: "s1" }) as unknown as Pick<RoomState, "tokens" | "characters" | "templates">;
    assert.equal(seen(P2).characters.c1?.ownerIds, undefined);
    assert.ok(!remindsYou(event({ templateId: "cloud", tokenId: "ayla" }), P2, seen(P2)));
    assert.ok(remindsYou(event({ templateId: "cloud", tokenId: "ayla" }), P1, seen(P1)));
  });

  test("only entries that arrive and are confirmed count, never the history a snapshot carries", () => {
    const line = (id: string): LogEntry => ({ id, at: "", kind: "event", data: event() });
    const first = arrivals(null, [line("3:0"), line("4:0")], 4);
    assert.deepEqual(first.fresh, []);
    const next = arrivals(first.seen, [line("3:0"), line("4:0"), line("5:0"), line("6:0")], 5);
    assert.deepEqual(
      next.fresh.map((e) => e.id),
      ["5:0"],
    );
    // A predicted line waits until its op is confirmed.
    assert.deepEqual(
      arrivals(next.seen, [line("5:0"), line("6:0")], 6).fresh.map((e) => e.id),
      ["6:0"],
    );
  });
});
