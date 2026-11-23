import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { PcStats } from "#shared/model.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { hash12 } from "#shared/rules/pcSync.ts";
import { actor, character, room, token } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * An import's new ids reach inside a character and the clock
 * (docs/design/design-v1-calendar.md 6.6): each roll and class resource
 * takes one, the sync record keys them by the new ids' hashes, and the
 * clock's new id is the one its rest stamps and effect ends name.
 */
describe("an import's ids inside characters and the clock", () => {
  test("rolls, resources and the clock take new ids, and the sync record, rest stamps and effect ends follow", () => {
    const clock = uuidv7();
    const roll = uuidv7();
    const res = uuidv7();
    const stats: PcStats = { ...structuredClone(EMPTY_PC_STATS as PcStats), rolls: [{ id: roll, name: "Longbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8" }] }] };
    const ends = { span: 600, at: 1_600, clock };
    const state = room({
      clock: { id: clock, rev: 0, t: 1_000, shown: true, calendar: { kind: "days" } },
      characters: {
        bree: character("bree", {
          stats,
          resources: [{ id: res, name: "Rage", max: 2, used: 0, reset: "long" }],
          ddbSync: { at: "2026-10-01T12:00:00.000Z", base: { level: 3 }, rolls: { [hash12(roll)]: { k: "w:00000000000a", h: "00000000000b" } }, res: { [hash12(res)]: { k: "r:00000000000c", h: "00000000000d" } } },
          longRest: { at: 900, clock },
          actor: actor({ effects: [{ id: uuidv7(), key: "blessed", ends }] }),
        }),
      },
      tokens: { gob: token("gob", { actor: { inline: actor({ effects: [{ id: uuidv7(), key: "frightened", ends }] }) } }) },
    });
    assert.ok(parseRoomState(structuredClone(state)).ok, "the file is a valid room");
    const made: string[] = [];
    const out = remapState(state, {
      assets: new Map(),
      newId: () => {
        made.push(uuidv7());
        return made.at(-1)!;
      },
    });
    const bree = Object.values(out.characters)[0]!;
    const [newRoll] = bree.stats!.rolls.map((r) => r.id);
    const [newRes] = bree.resources!.map((r) => r.id);
    const newClock = out.clock!.id;
    for (const id of [newRoll, newRes, newClock]) assert.ok(id !== undefined && made.includes(id), `${id} is one the import made`);
    assert.deepEqual(Object.keys(bree.ddbSync!.rolls ?? {}), [hash12(newRoll!)]);
    assert.deepEqual(Object.keys(bree.ddbSync!.res ?? {}), [hash12(newRes!)]);
    assert.deepEqual(bree.longRest, { at: 900, clock: newClock });
    assert.deepEqual(bree.actor.effects.map((e) => e.ends), [{ ...ends, clock: newClock }]);
    const gob = Object.values(out.tokens)[0]!;
    assert.ok("inline" in gob.actor);
    assert.deepEqual(gob.actor.inline.effects.map((e) => e.ends), [{ ...ends, clock: newClock }]);
    assert.ok(!JSON.stringify(out).includes(clock), "the old clock id is nowhere");
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(out))).ok, "the imported room is a valid room");
  });
});
