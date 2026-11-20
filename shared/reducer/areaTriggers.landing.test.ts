import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, GROUND, UPPER, applied, onThornsTurn, thornToken, tower, trapdoor, withOpening, withStairs, withTrapdoor } from "../floorLinksTestutil.ts";
import type { AreaTemplate, RoomState, Token } from "../model.ts";
import type { Op } from "../protocol.ts";
import { template, token } from "../testutil.ts";

/*
 * Landing reminders (docs/design/design-v1-floors.md phase 4, 4.3 step 11,
 * D-261119-105, D-261119-122): during a turn, a creature that lands in an
 * op enters each area its last landing lies in, and an area that came with
 * it covers who stands there, read against who each area held before the
 * op. The walk's own reminders read the walk where it stopped, before any
 * fall or drop (step 4). The tower's opening lies at 6, 6, its trapdoor
 * (td1) at 10, 10.
 */

/** An area that reminds on entering, 10 ft round a point, unless told otherwise. */
function area(id: string, sceneId: string, x: number, y: number, over: Partial<AreaTemplate> = {}): AreaTemplate {
  return template(id, { sceneId, shape: "sphere", size: 10, origin: { x, y, z: 0 }, ownerId: "dm1", spell: id, triggers: ["enter"], ...over });
}

function withAreas(state: RoomState, ...areas: AreaTemplate[]): RoomState {
  return { ...state, templates: { ...state.templates, ...Object.fromEntries(areas.map((a) => [a.id, a])) } };
}

function withTokens(state: RoomState, ...tokens: Token[]): RoomState {
  return { ...state, tokens: { ...state.tokens, ...Object.fromEntries(tokens.map((t) => [t.id, t])) } };
}

/** The reminders the op wrote, each as its area and creature, in log order. */
function reminders(before: RoomState, after: RoomState): string[] {
  const had = new Set(before.log.map((l) => l.id));
  return after.log.filter((l) => !had.has(l.id) && l.data?.type === "area").map((l) => `${(l.data as { templateId: string }).templateId} ${(l.data as { tokenId: string }).tokenId}`);
}

function move(tokenId: string, x: number, y: number): Op {
  return { t: "token.move", tokenId, x, y };
}

describe("landing reminders (4.3 step 11)", () => {
  test("a walk into Spirit Guardians upstairs that ends over the hole into a second area below reminds of each once, on its floor", () => {
    const state = onThornsTurn(withAreas(withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 1, y: 6 }) } })), area("guardians", UPPER, 7, 7), area("below", GROUND, 7, 7)));
    const r = applied(state, move("thorn", 6, 6), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(reminders(state, r.state), ["guardians thorn", "below thorn"]);
  });

  test("the same walk ending on a trapdoor reminds of the area upstairs before the drop and the one below after it", () => {
    const state = onThornsTurn(withAreas(withTrapdoor(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 10 }) } }), trapdoor()), area("guardians", UPPER, 11, 11), area("below", GROUND, 11, 11)));
    const r = applied(state, move("thorn", 10, 10), ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
    assert.deepEqual(reminders(state, r.state), ["guardians thorn", "below thorn"]);
  });

  for (const includeOrigin of [false, true]) {
    test(`a bearer whose aura falls with it onto two goblins reminds of the goblins and never of itself (includeOrigin ${includeOrigin ? "on" : "off"})`, () => {
      const aura = area("aura", UPPER, 1.5, 6.5, { size: 15, attachedTo: "thorn", includeOrigin });
      const goblins = [token("g1", { sceneId: GROUND, name: "Goblin", x: 8, y: 6 }), token("g2", { sceneId: GROUND, name: "Goblin", x: 6, y: 8 })];
      const state = onThornsTurn(withAreas(withTokens(withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 1, y: 6 }) } })), ...goblins), aura));
      const r = applied(state, move("thorn", 6, 6), ANA);
      assert.equal(r.state.tokens.thorn!.sceneId, GROUND);
      assert.equal(r.state.templates.aura!.sceneId, GROUND, "the aura comes with it");
      assert.deepEqual(reminders(state, r.state).sort(), ["aura g1", "aura g2"]);
    });
  }

  test("a climb into an area reminds from change format 64 and not before", () => {
    const state = onThornsTurn(withAreas(withStairs(), area("guardians", UPPER, 4, 3.5)));
    const at64 = applied(state, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
    assert.deepEqual(reminders(state, at64.state), ["guardians thorn"]);
    const at63 = applied(state, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA, 63);
    assert.equal(at63.state.tokens.thorn!.sceneId, UPPER);
    assert.deepEqual(reminders(state, at63.state), []);
  });

  test("a landing reminds only during a turn", () => {
    const state = withAreas(withStairs(), area("guardians", UPPER, 4, 3.5));
    const r = applied(state, { t: "token.climb", tokenId: "thorn", linkId: "l1" }, ANA);
    assert.equal(r.state.tokens.thorn!.sceneId, UPPER);
    assert.deepEqual(reminders(state, r.state), []);
  });
});
