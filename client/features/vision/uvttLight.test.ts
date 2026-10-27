import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room } from "#shared/testutil.ts";
import { importScene, placeMap } from "../uvtt/batch.ts";
import { convertUvtt } from "../uvtt/convert.ts";
import { readUvtt } from "../uvtt/schema.ts";
import { uvttFile } from "../uvtt/synthetic.ts";
import { proposedLight } from "./uvttLight.ts";

describe("the light a Universal VTT import proposes", () => {
  test("a map whose image is already lit is Bright", () => {
    assert.deepEqual(proposedLight({ baked: true, ambient: "ff000000" }), { level: "bright", why: "The map image already shows its lighting." });
  });

  test("otherwise the ambient light's last six hex digits, by luminance", () => {
    assert.equal(proposedLight({ baked: false, ambient: "ffffffff" })?.level, "bright");
    assert.equal(proposedLight({ baked: false, ambient: "ffb3b3b3" })?.level, "bright");
    // Mid grey is 50%: dim.
    assert.equal(proposedLight({ baked: false, ambient: "ff808080" })?.level, "dim");
    assert.equal(proposedLight({ baked: false, ambient: "#4d4d4d" })?.level, "dim");
    // A night's dark blue.
    assert.equal(proposedLight({ baked: false, ambient: "ff2a3550" })?.level, "dark");
    assert.equal(proposedLight({ baked: false, ambient: "000000" })?.level, "dark");
    assert.match(proposedLight({ baked: false, ambient: "ff808080" })?.why ?? "", /50% bright/);
  });

  test("a file that says nothing readable proposes nothing", () => {
    assert.equal(proposedLight(null), null);
    assert.equal(proposedLight({ baked: false, ambient: null }), null);
    assert.equal(proposedLight({ baked: false, ambient: "bright" }), null);
    assert.equal(proposedLight({ baked: false, ambient: "fff" }), null);
  });

  test("the file's environment is read, and an odd one never stops the import", () => {
    const lit = readUvtt(uvttFile());
    assert.ok(lit.ok);
    assert.deepEqual(lit.map.environment, { baked: true, ambient: "ffffffff" });
    const odd = readUvtt({ ...uvttFile(), environment: { baked_lighting: "yes", ambient_light: 7 } });
    assert.ok(odd.ok);
    assert.deepEqual(odd.map.environment, { baked: false, ambient: null });
    const none = readUvtt({ ...uvttFile(), environment: "dark" });
    assert.ok(none.ok);
    assert.equal(none.map.environment, null);
  });

  test("the scene starts with the light chosen and vision off", () => {
    const read = readUvtt(uvttFile());
    assert.ok(read.ok);
    const converted = convertUvtt(read.map, { objects: true, portals: "window", feetPerCell: 5 });
    assert.ok(converted.ok);
    const map = placeMap(converted.plan, { assetId: "a1", width: 700, height: 700, fileImageWidth: 700 });
    assert.ok(map);
    const scene = importScene(converted.plan, map, { id: "imp", name: "Night", light: "dark" });
    assert.deepEqual(scene.vision, { on: false, light: "dark" });
    const op = { t: "scene.create" as const, scene };
    assert.equal(clientOpSchema.safeParse(op).success, true);
    assert.deepEqual(apply(room(), op).scenes.imp?.vision, { on: false, light: "dark" });
    assert.equal(importScene(converted.plan, map, { id: "imp", name: "Day" }).vision, undefined);
  });
});
