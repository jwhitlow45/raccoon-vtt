import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "./limits.ts";
import { MAX_EPH_BYTES, MAX_RULER_ENDS, MAX_RULER_STOPS, clientMessageSchema, clientOpSchema, ephEventOutSchema, ephEventSchema, outboundEph, serverMessageSchema, type EphEvent } from "./protocol.ts";

/*
 * Floors phase 3's protocol (docs/design/design-v1-floors.md phase 3, 3.1
 * and 4.2): a floor add's name and own settings, and a carried ruler's
 * frame in each direction, which names its tokens and ends only on its
 * way to the server (D-261110-182).
 */

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(schema.safeParse(value).success, JSON.stringify(value));
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => assert.ok(!schema.safeParse(value).success, JSON.stringify(value));

const OWN = { bounds: { w: 40, h: 30 }, background: "#1b1b20", grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 }, autoWalls: "off" };
const MAP = { assetId: "a1", widthPx: 2800, heightPx: 2100, cellPx: 70, originPx: { x: 0, y: 0 } };
const add = (floor: object, scene: object = {}) => ({ t: "scene.create", scene: { id: "n", name: "Tower", bounds: { w: 10, h: 10 }, ...scene }, floor: { beside: "g", side: "above", ...floor } });

describe("a floor add's name and own settings (3.1)", () => {
  test("an add may name its floor and carry a file's or a dungeon's own settings", () => {
    ok(clientOpSchema, add({}));
    ok(clientOpSchema, add({ name: "Crypt" }));
    ok(clientOpSchema, add({ name: "Crypt level 2", own: { ...OWN, map: MAP, gridFromFile: true } }));
    ok(clientOpSchema, add({ name: "Crypt", own: { ...OWN, autoWalls: "all", fogEnabled: true, vision: { on: true, light: "dark", byClock: false } } }));
    ok(clientOpSchema, add({ own: { ...OWN, vision: { on: false, light: "bright", perPlayer: true, byClock: false } } }));
  });

  test("own names its size, background, grid look and automatic walls, and a file's grid comes with its map", () => {
    for (const field of ["bounds", "background", "grid", "autoWalls"]) {
      const { [field as keyof typeof OWN]: _gone, ...rest } = OWN;
      bad(clientOpSchema, add({ own: rest }));
    }
    bad(clientOpSchema, add({ own: { ...OWN, gridFromFile: true } }));
    bad(clientOpSchema, add({ own: { ...OWN, gridShape: "hexRows" } }));
    bad(clientOpSchema, add({ own: { ...OWN, blockMovement: true } }));
    bad(clientOpSchema, add({ own: { ...OWN, bounds: { w: 201, h: 30 } } }));
  });

  test("the scene still carries only its id, name and size", () => {
    bad(clientOpSchema, add({ own: OWN }, { map: MAP }));
    bad(clientOpSchema, add({ name: "Crypt" }, { fogEnabled: true }));
  });

  test("a name is a floor name: one to 40 code points, no control or text direction characters", () => {
    const dragon = `${"x".repeat(39)}\u{1F409}`;
    assert.equal(dragon.length, LIMITS.floorNameChars + 1, "41 UTF-16 units");
    ok(clientOpSchema, add({ name: dragon }));
    bad(clientOpSchema, add({ name: `${dragon}y` }));
    bad(clientOpSchema, add({ name: "" }));
    bad(clientOpSchema, add({ name: "Crypt‮" }));
    bad(clientOpSchema, add({ name: "Crypt\n2" }));
  });
});

describe("a carried ruler's frame in and out (4.2, D-261110-182)", () => {
  const carried = {
    k: "ruler",
    id: "r1",
    walk: true,
    points: [{ x: 4.5, y: 4.5 }, { x: 8.5, y: 4.5 }],
    prior: { ft: 25, diag: { h: 1, v: 0 }, walker: { size: "medium" }, anchors: ["thorn"], ends: ["l1"] },
  } as const;
  const outbound = { ...carried, prior: { ft: 25, diag: { h: 1, v: 0 }, walker: { size: "medium" } } };
  const withPrior = (prior: object) => ({ ...carried, prior: { ...carried.prior, ...prior } });

  test("inbound, a carried ruler names the tokens it sat on and the ends it crossed, and never comes without them", () => {
    ok(ephEventSchema, carried);
    ok(ephEventSchema, withPrior({ anchors: [] }));
    bad(ephEventSchema, outbound);
    for (const field of ["anchors", "ends"]) {
      const { [field as "anchors" | "ends"]: _gone, ...rest } = carried.prior;
      bad(ephEventSchema, { ...carried, prior: rest });
    }
    bad(ephEventSchema, withPrior({ ends: [] }));
    bad(ephEventSchema, withPrior({ ends: Array.from({ length: MAX_RULER_ENDS + 1 }, (_, i) => `l${i}`) }));
    ok(ephEventSchema, withPrior({ ends: Array.from({ length: MAX_RULER_ENDS }, (_, i) => `l${i}`) }));
    bad(ephEventSchema, withPrior({ anchors: Array.from({ length: MAX_RULER_STOPS + 1 }, (_, i) => `t${i}`) }));
    bad(ephEventSchema, withPrior({ anchors: ["thorn", "thorn"] }));
  });

  test("outbound, a carried ruler names neither, and one that does fails", () => {
    ok(ephEventOutSchema, outbound);
    bad(ephEventOutSchema, carried);
    bad(ephEventOutSchema, { ...outbound, prior: { ...outbound.prior, anchors: ["thorn"] } });
    bad(ephEventOutSchema, { ...outbound, prior: { ...outbound.prior, ends: ["l1"] } });
    ok(serverMessageSchema, { t: "eph", from: "p1", sceneId: "u", e: outbound });
    bad(serverMessageSchema, { t: "eph", from: "p1", sceneId: "u", e: carried });
    ok(clientMessageSchema, { t: "eph", sceneId: "u", e: carried });
    bad(clientMessageSchema, { t: "eph", sceneId: "u", e: outbound });
  });

  test("outboundEph drops both lists from a carried ruler and leaves every other frame as it is", () => {
    const out = outboundEph(ephEventSchema.parse(carried));
    assert.deepEqual(out, outbound);
    assert.ok(ephEventOutSchema.safeParse(out).success);
    assert.ok(!JSON.stringify(out).includes("thorn") && !JSON.stringify(out).includes("l1"), "no id the frame named for the server");
    const plain: EphEvent = { k: "ruler", id: "r2", points: [{ x: 1.5, y: 1.5, tokenId: "thorn" }], walk: true };
    assert.equal(outboundEph(plain), plain);
    const drag: EphEvent = { k: "dragMove", tokenId: "thorn", x: 2, y: 2 };
    assert.equal(outboundEph(drag), drag);
  });

  test("a carried ruler walks on from a free stop", () => {
    const { walk: _walk, ...straight } = carried;
    bad(ephEventSchema, straight);
    bad(ephEventOutSchema, { ...outbound, walk: undefined });
    bad(ephEventSchema, { ...carried, points: [{ x: 4.5, y: 4.5, tokenId: "thorn" }] });
    bad(ephEventOutSchema, { ...outbound, points: [{ x: 4.5, y: 4.5, tokenId: "thorn" }] });
    ok(ephEventSchema, { ...carried, points: [{ x: 4.5, y: 4.5, z: 10 }, { x: 8.5, y: 4.5, tokenId: "gob" }] });
  });

  test("the walker carries its sides only when custom, both of them, within a token's bounds", () => {
    ok(ephEventSchema, withPrior({ walker: { size: "custom", w: 1, h: 3 } }));
    ok(ephEventSchema, withPrior({ walker: { size: "large", squeeze: true } }));
    bad(ephEventSchema, withPrior({ walker: { size: "custom", w: 1 } }));
    bad(ephEventSchema, withPrior({ walker: { size: "custom" } }));
    bad(ephEventSchema, withPrior({ walker: { size: "medium", w: 1, h: 1 } }));
    bad(ephEventSchema, withPrior({ walker: { size: "custom", w: 21, h: 1 } }));
    bad(ephEventSchema, withPrior({ walker: { size: "large", squeeze: false } }));
    bad(ephEventSchema, withPrior({ walker: { size: "large", riders: ["ana"] } }));
  });

  test("the feet and counters are any fraction a walk counts, within bounds, both ways (FL3-ASTRA-01)", () => {
    for (const fractions of [{ ft: 12.5, diag: { h: 1.5, v: 0.5 } }, { ft: 15, diag: { h: 0, v: 0.2 } }, { ft: 13.75, diag: { h: 0.25, v: 1.8 } }]) {
      ok(ephEventSchema, withPrior(fractions));
      ok(ephEventOutSchema, { ...outbound, prior: { ...outbound.prior, ...fractions } });
      ok(serverMessageSchema, { t: "eph", from: "p1", sceneId: "u", e: { ...outbound, prior: { ...outbound.prior, ...fractions } } });
    }
    for (const prior of [{ ft: -0.1 }, { ft: "5" }, { diag: { h: -0.2, v: 0 } }, { diag: { h: 0, v: 100_000.2 } }]) {
      bad(ephEventSchema, withPrior(prior));
      bad(ephEventOutSchema, { ...outbound, prior: { ...outbound.prior, ...prior } });
    }
    bad(ephEventSchema, withPrior({ ft: -5 }));
    bad(ephEventSchema, withPrior({ ft: 100_005 }));
    bad(ephEventSchema, withPrior({ ft: 100_000.5 }));
    bad(ephEventSchema, withPrior({ diag: { h: 1 } }));
    bad(ephEventSchema, withPrior({ tokenId: "thorn" }));
  });

  test("the ephemeral byte cap counts a carried frame's lists, so one past it never leaves a client", () => {
    const id = (prefix: string, i: number) => `${prefix}${i}`.padEnd(64, "x");
    const lists = withPrior({ anchors: Array.from({ length: MAX_RULER_STOPS }, (_, i) => id("t", i)), ends: Array.from({ length: MAX_RULER_ENDS }, (_, i) => id("l", i)) });
    const full = { ...lists, points: Array.from({ length: 10 }, (_, i) => ({ x: i + 0.5, y: 4.5, z: 10 })) };
    ok(ephEventSchema, full);
    assert.ok(JSON.stringify(full).length > MAX_EPH_BYTES);
    bad(clientMessageSchema, { t: "eph", sceneId: "u", e: full });
    ok(clientMessageSchema, { t: "eph", sceneId: "u", e: carried });
  });
});
