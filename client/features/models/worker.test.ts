import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { box, Glb } from "./fixtures.testutil.ts";
import { MODEL_WORDS, type FromModelWorker, type ModelMesh, type ToModelWorker } from "./mesh.ts";

/**
 * The model worker where it cannot draw (docs/design/design-v1-token-models.md
 * 5, D-261127-184): Node has no OffscreenCanvas, as a browser without WebGL
 * in a worker has none to draw on, so every request ends in the sheet's
 * words for that, before the file is read.
 */

test("a browser that cannot draw in a worker is told so, in words, before the file is read", async () => {
  let receive: ((event: { data: ToModelWorker }) => void) | undefined;
  const answers: FromModelWorker[] = [];
  const prior = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      addEventListener(_type: string, listener: typeof receive) {
        receive = listener;
      },
      postMessage(message: FromModelWorker) {
        answers.push(message);
      },
    },
  });
  try {
    await import("./worker.ts");
    assert.equal(typeof OffscreenCanvas, "undefined");
    let read = false;
    const file = new File(["solid x"], "x.stl");
    Object.defineProperty(file, "slice", { value: () => ((read = true), new Blob()) });
    receive!({ data: { t: "draw", id: 7, file, device: "computer", options: { color: "stone", up: 0, front: 0, size: 100 } } });
    for (let i = 0; i < 20 && answers.length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, [{ t: "refused", id: 7, message: MODEL_WORDS.noWebgl }]);
    assert.equal(MODEL_WORDS.noWebgl, "This browser can't draw 3D models. Recent Chrome, Edge, Firefox and Safari can.");
    assert.equal(read, false);
  } finally {
    if (prior) Object.defineProperty(globalThis, "self", prior);
    else delete (globalThis as { self?: unknown }).self;
  }
});

test("after a read the kept mesh holds no texture bytes, which would keep the whole file alive, and draws on from it", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", { configurable: true, value: { addEventListener() {}, postMessage() {} } });
  try {
    const { createServer } = await import("./worker.ts");
    const g = new Glb();
    const png = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer());
    g.json.images = [{ bufferView: g.view(png), mimeType: "image/png" }];
    g.json.textures = [{ source: 0 }];
    g.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    const cube = box([0, 0, 0], [1, 1, 1]);
    g.node({ mesh: g.meshOf(cube, { material: 0, attributes: { TEXCOORD_0: g.floats(new Array(72).fill(0.5), "VEC2") } }) });
    const loaded: ModelMesh[] = [];
    let draws = 0;
    const answers: FromModelWorker[] = [];
    const server = createServer(
      () => ({
        load: async (mesh: ModelMesh) => void loaded.push(mesh),
        draw: async () => (draws++, { sheet: new Blob(), front: new Blob() }),
      }),
      (m) => answers.push(m),
    );
    const options = { color: "stone", up: 0, front: 0, size: 100 } as const;
    await server.handle({ t: "draw", id: 1, file: new File([g.build() as Uint8Array<ArrayBuffer>], "t.glb"), device: "computer", options });
    assert.equal(loaded[0]!.textures.length, 1, "the drawer gets the texture to decode");
    assert.deepEqual(server.mesh!.textures, [], "the kept mesh lets the file's buffer go");
    await server.handle({ t: "draw", id: 2, file: null, device: "computer", options: { ...options, size: 120 } });
    assert.equal(draws, 2);
    assert.deepEqual(answers.filter((a) => a.t !== "stage").map((a) => a.t), ["drawn", "drawn"]);
  } finally {
    if (prior) Object.defineProperty(globalThis, "self", prior);
    else delete (globalThis as { self?: unknown }).self;
  }
});
