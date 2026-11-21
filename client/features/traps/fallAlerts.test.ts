import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Fall, RoomState } from "#shared/model.ts";
import { character, room, scene, token } from "#shared/testutil.ts";
import { LIMITS } from "#shared/limits.ts";
import { applied, GROUND, putOpeningOp, tower, UPPER } from "#shared/floorLinksTestutil.ts";
import { FALL_TOASTS_MOST, fallAlerts, fallsAfter, newestMade } from "./alerts.ts";

/*
 * The DM's toast for each new fall card (docs/design/design-v1-floors.md
 * phase 4, 4.4): only cards made since the device loaded, and Show where
 * the floor named is not the one shown.
 */

const NO_LABELS = new Map();

/** Tower's two floors and Crypt, a scene of its own. Thorn fell to Ground floor. */
function view(): RoomState {
  return room({
    scenes: {
      ground: scene("ground", { name: "Tower", floor: { of: "ground", level: 0, name: "Ground floor" } }),
      upper: scene("upper", { name: "Tower", order: 1, floor: { of: "ground", level: 1, name: "Upper floor" } }),
      crypt: scene("crypt", { name: "Crypt", order: 2, floor: { of: "crypt", level: 0, name: "Vault" } }),
    },
    characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: { thorn: token("thorn", { sceneId: "ground", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }) },
  });
}

const card = (over: Partial<Fall> = {}): Fall => {
  const made = over.made ?? 120;
  return { id: `${made}:0`, rev: 0, tokenId: "thorn", sceneId: "ground", from: "upper", ft: 10, made, ...over };
};

describe("the DM's toast for a new fall card", () => {
  test("only a card made after the newest the device held, so a reconnect toasts nothing old, oldest first", () => {
    const falls = { "120:0": card(), "125:0": card({ made: 125 }), "125:1": { ...card({ made: 125 }), id: "125:1" } };
    assert.equal(newestMade(falls), 125);
    assert.equal(newestMade(undefined), -1);
    assert.deepEqual(fallsAfter(falls, 120).map((c) => c.id), ["125:0", "125:1"]);
    assert.deepEqual(fallsAfter(falls, 125), []);
    assert.deepEqual(fallsAfter(falls, -1).map((c) => c.id), ["120:0", "125:0", "125:1"]);
  });

  test("Show where the floor it names is not the one shown, and for another scene", () => {
    assert.deepEqual(fallAlerts([card()], view(), "upper", NO_LABELS), [{ text: "Thorn fell 10 ft to Ground floor.", show: { sceneId: "ground" } }]);
    assert.deepEqual(fallAlerts([card()], view(), "ground", NO_LABELS), [{ text: "Thorn fell 10 ft to Ground floor." }], "the floor is shown already");
    assert.deepEqual(fallAlerts([card({ tokenId: "imp", sceneId: "crypt" })], view(), "upper", NO_LABELS), [{ text: "A creature fell 10 ft to Vault on Crypt.", show: { sceneId: "crypt" } }]);
    assert.deepEqual(fallAlerts([card({ tokenId: "wolf" })], view(), "upper", NO_LABELS), [{ text: "A creature no longer on the map fell 10 ft to Ground floor." }]);
  });

  test("a card's riders are named with the creature that fell (D-261120-007)", () => {
    const state = view();
    state.tokens.horse = token("horse", { sceneId: "ground", name: "Horse" });
    assert.deepEqual(fallAlerts([card({ tokenId: "horse", riders: ["thorn"] })], state, "ground", NO_LABELS), [{ text: "Horse and Thorn fell 10 ft to Ground floor." }]);
    assert.deepEqual(fallAlerts([card({ tokenId: "wolf", riders: ["thorn"] })], state, "ground", NO_LABELS), [{ text: "Thorn fell 10 ft to Ground floor." }], "a rider whose mount went since");
  });
});

describe("one toast for a crowd that fell in one op (LP46A polish)", () => {
  const crowd = (n: number, made = 130, over: Partial<Fall> = {}) => Array.from({ length: n }, (_, i) => ({ ...card({ made, tokenId: `c${i}`, ...over }), id: `${made}:${i}` }));

  test("up to the most it toasts one by one, past that once with the count, riders counted", () => {
    assert.equal(fallAlerts(crowd(FALL_TOASTS_MOST), view(), "ground", NO_LABELS).length, FALL_TOASTS_MOST);
    const some = crowd(6);
    some[0] = { ...some[0]!, riders: ["r1", "r2"] };
    assert.deepEqual(fallAlerts(some, view(), "ground", NO_LABELS), [{ text: "8 creatures fell to Ground floor." }]);
    assert.deepEqual(fallAlerts(crowd(LIMITS.fallsPerRoom - 1), view(), "ground", NO_LABELS), [{ text: "9 creatures fell to Ground floor." }]);
    assert.deepEqual(fallAlerts(crowd(4), view(), "upper", NO_LABELS), [{ text: "4 creatures fell to Ground floor.", show: { sceneId: "ground" } }]);
  });

  test("each op on its own, and floors of more than one landing named as the floors below", () => {
    const two = [...crowd(4, 130), ...crowd(1, 140)];
    assert.deepEqual(fallAlerts(two, view(), "ground", NO_LABELS).map((a) => a.text), ["4 creatures fell to Ground floor.", "A creature no longer on the map fell 10 ft to Ground floor."]);
    const mixed = [...crowd(3, 150), ...crowd(1, 150, { sceneId: "crypt" }).map((c) => ({ ...c, id: "150:9" }))];
    assert.deepEqual(fallAlerts(mixed, view(), "ground", NO_LABELS), [{ text: "4 creatures fell to the floors below." }]);
  });

  test("an opening placed under 12 creatures keeps 10 cards, and the toast says 10 or more (PUB46-SOL-02)", () => {
    const imps = Array.from({ length: 12 }, (_, i) => token(`imp${i}`, { sceneId: UPPER, kind: "monster", name: `Imp ${i}`, x: 6 + (i % 4), y: 6 + Math.floor(i / 4) }));
    const before = tower({ tokens: Object.fromEntries(imps.map((t) => [t.id, t])) });
    const after = applied(before, putOpeningOp({ rect: { x: 6, y: 6, w: 4, h: 3 } })).state;
    const cards = fallsAfter(after.falls, -1);
    assert.equal(cards.length, LIMITS.fallsPerRoom, "the room keeps its cap");
    assert.equal(imps.filter((t) => after.tokens[t.id]?.sceneId === GROUND).length, 12, "all 12 fell");
    assert.deepEqual(fallAlerts(cards, after, GROUND, NO_LABELS), [{ text: "10 or more creatures fell to Ground floor." }]);
  });
});
