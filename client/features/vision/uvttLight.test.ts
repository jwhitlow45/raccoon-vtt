import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room } from "#shared/testutil.ts";
import { withPlayersSee } from "../scenes/create.ts";
import { importOps, importScene, placeMap } from "../uvtt/batch.ts";
import { convertUvtt } from "../uvtt/convert.ts";
import { readUvtt } from "../uvtt/schema.ts";
import { uvttFile } from "../uvtt/synthetic.ts";
import { lightsLead, proposedLight, startingLight, whyShown } from "./uvttLight.ts";

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

  // FL2: D-261028-08, a map that brings its own lights.
  test("FL2 lights inside the map propose Dark under party vision, unless the ambient light is daylight", () => {
    const dark = { level: "dark", why: "The map's own lights light it for the party.", lights: 41 };
    // Lights and baked lighting: the image's own glow is no daylight.
    assert.deepEqual(proposedLight({ baked: true, ambient: "ff000000" }, 41), dark);
    assert.deepEqual(proposedLight({ baked: true, ambient: null }, 41), dark);
    // Lights and a dark, or a dim, ambient light.
    assert.deepEqual(proposedLight({ baked: false, ambient: "ff2a3550" }, 41), dark);
    assert.deepEqual(proposedLight({ baked: false, ambient: "ff808080" }, 41), dark);
    // Lights and a file that says nothing of its light.
    assert.deepEqual(proposedLight(null, 41), dark);
    // Lights and a bright ambient light: a daylit map keeps its level, baked or not. 70% is the line (b3 is 70.2%, b2 69.8%).
    assert.deepEqual(proposedLight({ baked: true, ambient: "ffffffff" }, 41), { level: "bright", why: "The map image already shows its lighting." });
    assert.deepEqual(proposedLight({ baked: false, ambient: "ffb3b3b3" }, 41), { level: "bright", why: "The map's ambient light is 70% bright." });
    assert.equal(proposedLight({ baked: false, ambient: "ffb2b2b2" }, 41)?.lights, 41);
    // Baked lighting with no lights stays Bright, and a file with neither proposes nothing.
    assert.deepEqual(proposedLight({ baked: true, ambient: "ff000000" }, 0), { level: "bright", why: "The map image already shows its lighting." });
    assert.equal(proposedLight({ baked: false, ambient: null }, 0), null);
    assert.equal(proposedLight(null), null);
  });

  test("FL2 the dialog starts dark under party vision for a map with lights, else on the room's default and the file's level", () => {
    assert.deepEqual(startingLight(proposedLight(null, 3), "reveal"), { seen: "explore", light: "dark" });
    assert.deepEqual(startingLight(proposedLight({ baked: false, ambient: "ff808080" }), "reveal"), { seen: "reveal", light: "dim" });
    assert.deepEqual(startingLight(proposedLight({ baked: true, ambient: "ffffffff" }, 3), "all"), { seen: "all", light: "bright" });
    assert.deepEqual(startingLight(null, "explore"), { seen: "explore", light: "bright" });
  });

  test("FL2 the summary leads with the count and Keep it lit, which puts back Bright and the room's default", () => {
    const proposal = proposedLight({ baked: true, ambient: "ff000000" }, 41);
    const dark = startingLight(proposal, "reveal");
    const lead = lightsLead(proposal, dark, "reveal");
    assert.deepEqual(lead, {
      text: "This map brings 41 lights. The scene starts dark with party vision on, so they light it for the party.",
      action: "Keep it lit",
      to: { seen: "reveal", light: "bright" },
    });
    // Kept lit, the line offers the dark start again from the same button.
    assert.deepEqual(lightsLead(proposal, lead!.to, "reveal"), {
      text: "This map brings 41 lights. Start the scene dark with party vision on, and they light it for the party.",
      action: "Start it dark",
      to: dark,
    });
    // Moving off the dark start any other way offers it too: another light, or another Players see.
    assert.equal(lightsLead(proposal, { seen: "explore", light: "dim" }, "reveal")?.action, "Start it dark");
    assert.equal(lightsLead(proposal, { seen: "like", light: "dark" }, "reveal")?.action, "Start it dark");
    // In a room whose new scenes start on Explore, Keep it lit leaves party vision on, as an import made it before.
    assert.deepEqual(lightsLead(proposal, dark, "explore")?.to, { seen: "explore", light: "bright" });
    assert.equal(
      lightsLead(proposedLight(null, 1), dark, "reveal")?.text,
      "This map brings 1 light. The scene starts dark with party vision on, so it lights the scene for the party.",
    );
    // No lights, no line.
    assert.equal(lightsLead(proposedLight({ baked: true, ambient: "ff000000" }), dark, "reveal"), null);
    assert.equal(lightsLead(proposedLight({ baked: true, ambient: "ffffffff" }, 41), dark, "reveal"), null);
    assert.equal(lightsLead(null, dark, "reveal"), null);
  });

  test("FL2 a file with lights makes its scene dark with party vision on, its lights in the same ops", () => {
    const file = uvttFile({ lights: [{ at: { x: 5, y: 5 }, range: 4 }, { at: { x: 12, y: 8 }, range: 2 }, { at: { x: 40, y: 40 }, range: 2 }] });
    const read = readUvtt({ ...file, environment: { baked_lighting: true, ambient_light: "ff1a1a24" } });
    assert.ok(read.ok);
    const converted = convertUvtt(read.map, { objects: true, portals: "window", feetPerCell: 5 });
    assert.ok(converted.ok);
    // The light far outside the map is left out, so the count is the two the scene keeps.
    const proposal = proposedLight(read.map.environment, converted.plan.lights.length);
    assert.equal(proposal?.lights, 2);
    const start = startingLight(proposal, "reveal");
    const map = placeMap(converted.plan, { assetId: "a1", width: 1400, height: 1400, fileImageWidth: 1400 });
    assert.ok(map);
    const scene = withPlayersSee(importScene(converted.plan, map, { id: "imp", name: "Vault", light: start.light }), { preset: start.seen as "explore" }, start.light);
    assert.equal(scene.fogEnabled, true);
    assert.deepEqual(scene.vision, { on: true, light: "dark" });
    let ids = 0;
    const ops = importOps(scene, converted.plan, () => `l${ids++}`);
    let state = room();
    for (const op of ops) {
      assert.equal(clientOpSchema.safeParse(op).success, true);
      state = apply(state, op);
    }
    assert.deepEqual(state.scenes.imp?.vision, { on: true, light: "dark" });
    assert.equal(Object.values(state.lights).filter((l) => l?.sceneId === "imp").length, 2);
  });

  test("FL2 the light row gives the proposal's reason only while the pick is still the proposal (FL-OPUS-02)", () => {
    const lit = proposedLight({ baked: true, ambient: "ff000000" }, 41);
    const dark = startingLight(lit, "reveal");
    assert.equal(whyShown(lit, dark)?.why, "The map's own lights light it for the party.");
    // Kept lit, or dark without party vision: the map's lights no longer light it for the party.
    assert.equal(whyShown(lit, lightsLead(lit, dark, "reveal")!.to), null);
    assert.equal(whyShown(lit, { seen: "reveal", light: "dark" }), null);
    // A level proposal holds while the level does, whatever players see.
    const dim = proposedLight({ baked: false, ambient: "ff808080" });
    assert.equal(whyShown(dim, { seen: "all", light: "dim" })?.why, "The map's ambient light is 50% bright.");
    assert.equal(whyShown(dim, { seen: "all", light: "dark" }), null);
    assert.equal(whyShown(null, dark), null);
  });
});
