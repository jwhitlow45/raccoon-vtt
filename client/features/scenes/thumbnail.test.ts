import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClientOp } from "#shared/protocol.ts";
import { encodeThumb, thumbMapVariants, thumbSceneOf, thumbSize, thumbSources } from "./thumbnail.ts";

describe("scene thumbnails", () => {
  test("a thumbnail is at most 320 px on its long side, keeping the scene's shape", () => {
    assert.deepEqual(thumbSize({ w: 40, h: 30 }), { pxPerCell: 8, requested: 8, width: 320, height: 240 });
    assert.deepEqual(thumbSize({ w: 10, h: 200 }), { pxPerCell: 1.6, requested: 1.6, width: 16, height: 320 });
    // A thin scene still has a pixel across.
    assert.equal(thumbSize({ w: 1, h: 200 }).width, 2);
    assert.equal(thumbSize({ w: 1, h: 1000 }).width, 1);
  });

  test("the map's small copy is used when it has the pixels, else the phone copy", () => {
    // 3000 px wide at 100 px a square: the 512 px copy has 17 px a square, more than a 30 square scene needs.
    assert.deepEqual(thumbMapVariants({ widthPx: 3000, heightPx: 2000, cellPx: 100 }, 320 / 30), ["thumb", "mobile"]);
    // A 10 square scene on that same map needs 32 px a square.
    assert.deepEqual(thumbMapVariants({ widthPx: 3000, heightPx: 2000, cellPx: 100 }, 32), ["mobile", "thumb"]);
    // A small image was not shrunk for its small copy.
    assert.deepEqual(thumbMapVariants({ widthPx: 400, heightPx: 300, cellPx: 40 }, 32), ["thumb", "mobile"]);
  });

  test("only edits that change how a scene looks mark it for a new thumbnail", () => {
    const changes: [ClientOp, string | null][] = [
      [{ t: "build.paint", sceneId: "s", terrain: "stone", cells: ["0,0"] }, "s"],
      [{ t: "build.clear", sceneId: "s" }, "s"],
      [{ t: "build.stamps", sceneId: "s", remove: ["x"] }, "s"],
      [{ t: "build.height", sceneId: "s", cells: ["0,0"], height: 10 }, "s"],
      [{ t: "build.stairs", sceneId: "s", cells: ["0,0"], up: "a" }, "s"],
      [{ t: "scene.setGrid", sceneId: "s", cellPx: 70, originPx: { x: 0, y: 0 } }, "s"],
      [{ t: "scene.setMap", sceneId: "s", map: null }, "s"],
      [{ t: "scene.setPhase", sceneId: "s", phaseId: "p" }, "s"],
      [{ t: "scene.update", sceneId: "s", patch: { background: "#000000" } }, "s"],
      [{ t: "scene.update", sceneId: "s", patch: { autoWalls: "floor" } }, "s"],
      [{ t: "undo" }, "viewing"],
      [{ t: "redo" }, "viewing"],
      // A thumbnail of its own must not ask for another one.
      [{ t: "scene.update", sceneId: "s", patch: { thumb: "t" } }, null],
      [{ t: "scene.update", sceneId: "s", patch: { name: "Crypt", folder: "Act one", fogEnabled: true } }, null],
      [{ t: "token.move", tokenId: "t", x: 1, y: 1 }, null],
      [{ t: "fog.reset", sceneId: "s", to: "hidden" }, null],
    ];
    for (const [op, scene] of changes) assert.equal(thumbSceneOf(op, "viewing"), scene, op.t);
  });

  test("a row shows the scene's own thumbnail, then the map's small copy, then its background", () => {
    const map = { assetId: "m", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    assert.deepEqual(thumbSources({ thumb: "t", map }), [
      { assetId: "t", variant: "full" },
      { assetId: "m", variant: "thumb" },
    ]);
    assert.deepEqual(thumbSources({ map }), [{ assetId: "m", variant: "thumb" }]);
    assert.deepEqual(thumbSources({}), []);
  });

  test("WebP where the browser makes it, and JPEG where it quietly hands back a PNG", async () => {
    const canvas = (makes: (type: string) => string) => ({
      asked: [] as string[],
      toBlob(cb: (b: Blob | null) => void, type = "image/png") {
        this.asked.push(type);
        cb(new Blob(["x"], { type: makes(type) }));
      },
    });
    const chrome = canvas((type) => type);
    assert.equal((await encodeThumb(chrome))?.type, "image/webp");
    assert.deepEqual(chrome.asked, ["image/webp"]);
    const safari = canvas((type) => (type === "image/webp" ? "image/png" : type));
    assert.equal((await encodeThumb(safari))?.type, "image/jpeg");
    assert.deepEqual(safari.asked, ["image/webp", "image/jpeg"]);
  });
});
