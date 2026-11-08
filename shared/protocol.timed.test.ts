import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "./limits.ts";
import { actorSchemaForImport, clientOpSchema, opSchema } from "./protocol.ts";
import { actor } from "./testutil.ts";

/** The time span's op fields, the clock claims and where an end may come in (docs/design/design-v1-calendar-c2c3.md 4.2, 4.6, 4.7). */
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(!schema.safeParse(value).success, JSON.stringify(value));

const add = (duration: unknown) => ({ t: "actor.effect.add", target: { characterId: "c" }, effect: { id: "e", key: "blessed", duration } });
const ENDS = { span: 600, at: 1_200, clock: "c1" };

describe("a time span on the effect ops (4.2)", () => {
  test("whole minutes from 1 minute to 365 days, with no creature", () => {
    for (const seconds of [60, 600, 3_600, 8 * 3_600, 86_400, LIMITS.effectSpanMax]) ok(clientOpSchema, add({ mode: "span", seconds }));
    for (const seconds of [0, 59, 61, 90, LIMITS.effectSpanMax + 60, 1.5 * 60, -60]) bad(clientOpSchema, add({ mode: "span", seconds }));
    bad(clientOpSchema, add({ mode: "span", seconds: 60, of: { characterId: "c" } }));
    bad(clientOpSchema, add({ mode: "span" }));
  });

  test("the update patch, the bulk op and an outcome carry it, and null still removes a duration", () => {
    ok(clientOpSchema, { t: "actor.effect.update", target: { characterId: "c" }, effectId: "e", patch: { duration: { mode: "span", seconds: 60 } } });
    ok(clientOpSchema, { t: "actor.effect.update", target: { characterId: "c" }, effectId: "e", patch: { duration: null } });
    ok(clientOpSchema, { t: "actor.effects", add: [{ target: { characterId: "c" }, effect: { id: "e", key: "blessed", duration: { mode: "span", seconds: 60 } } }] });
    ok(clientOpSchema, { t: "actor.outcome", plan: "p", targets: [{ target: { characterId: "c" }, effects: [{ id: "e", key: "blessed", duration: { mode: "span", seconds: 60 } }] }] });
  });
});

describe("an end comes in on import alone (4.7)", () => {
  test("token.create's inline actor, character.create's and an effect op refuse a stored end", () => {
    const timed = actor({ effects: [{ id: "e", key: "blessed", ends: ENDS }] });
    bad(clientOpSchema, { t: "token.create", token: { id: "t", sceneId: "s", kind: "monster", name: "Goblin", size: "medium", x: 0, y: 0, actor: { inline: timed } } });
    bad(clientOpSchema, { t: "character.create", character: { id: "c", name: "Bree", size: "medium", ownerIds: [], actor: timed } });
    bad(clientOpSchema, { t: "actor.effect.add", target: { characterId: "c" }, effect: { id: "e", key: "blessed", ends: ENDS } });
    ok(clientOpSchema, { t: "character.create", character: { id: "c", name: "Bree", size: "medium", ownerIds: [], actor: actor() } });
  });

  test("the import's actor accepts an end with its time and clock, within their bounds", () => {
    ok(actorSchemaForImport, actor({ effects: [{ id: "e", key: "blessed", ends: ENDS }] }));
    for (const ends of [{ span: 600 }, { span: 600, at: 1_200 }, { span: 600, clock: "c1" }, { ...ENDS, span: 59 }, { ...ENDS, span: 90 }, { ...ENDS, at: LIMITS.clockSecondsMax + 1 }, { ...ENDS, extra: 1 }]) {
      bad(actorSchemaForImport, actor({ effects: [{ id: "e", key: "blessed", ends }] }));
    }
  });
});

describe("clock claims (4.6)", () => {
  test("start, set, advance and update carry one, stop none, and a restore one", () => {
    const claim = "0b3c5d5e-8f1a-4b2c-9d3e-4f5a6b7c8d9e";
    ok(clientOpSchema, { t: "clock.start", id: "c1", at: 0, shown: true, calendar: { kind: "days" }, claim });
    ok(clientOpSchema, { t: "clock.set", at: 0, claim });
    ok(clientOpSchema, { t: "clock.advance", by: 60, claim });
    ok(clientOpSchema, { t: "clock.update", at: 0, claim });
    bad(clientOpSchema, { t: "clock.stop", claim });
    bad(clientOpSchema, { t: "clock.set", at: 0, claim: "" });
    ok(opSchema, { t: "sys.restore", entries: [{ key: "clock", value: null }], from: "undo", deps: true, claim });
    bad(clientOpSchema, { t: "sys.restore", entries: [{ key: "clock", value: null }], from: "undo", deps: true, claim });
  });
});
