import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { build, type Rolldown } from "vite";
import { lameLicense } from "../../../../vite.config.ts";

/*
 * The encoder's license beside its chunk (vite.config.ts lameLicense,
 * docs/design/design-v1-music.md 7.4), on a small build of a page whose
 * worker loads the library by `import()`, as the encode worker does.
 */

const LAMEJS = fileURLToPath(new URL("../../../../node_modules/@breezystack/lamejs/dist/lamejs.js", import.meta.url));

async function buildWorker(workerSource: string): Promise<Rolldown.RolldownOutput["output"]> {
  const root = mkdtempSync(path.join(tmpdir(), "raccoon-vite-lame-"));
  try {
    writeFileSync(path.join(root, "main.js"), 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" });\n');
    writeFileSync(path.join(root, "worker.js"), workerSource);
    const output = (await build({
      configFile: false,
      root,
      logLevel: "silent",
      worker: { format: "es", plugins: () => [lameLicense()] },
      build: { write: false, sourcemap: true, rollupOptions: { input: path.join(root, "main.js") } },
    })) as Rolldown.RolldownOutput;
    return output.output;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const text = (file: Rolldown.OutputAsset | Rolldown.OutputChunk) => (file.type === "chunk" ? file.code : String(Buffer.from(file.source as Uint8Array | string)));

describe("the encoder's license", () => {
  test("its chunk carries the banner, its map moves down a line, and the license texts sit beside it", async () => {
    const files = await buildWorker(`const { Mp3Encoder } = await import(${JSON.stringify(LAMEJS)});\nself.postMessage(typeof Mp3Encoder);\n`);
    const chunk = files.find((f) => /^assets\/lamejs-[\w-]+\.js$/.test(f.fileName));
    assert.ok(chunk, `a lamejs chunk among ${files.map((f) => f.fileName).join(", ")}`);
    assert.match(text(chunk), /^\/\*! @license @breezystack\/lamejs 1\.2\.7, LGPL-3\.0\. Source: https:\/\/github\.com\/shijinyu\/lamejs/);
    const map = files.find((f) => f.fileName === `${chunk.fileName}.map`);
    assert.ok(map);
    assert.match(text(map), /"mappings":";/);
    for (const name of ["lamejs-1.2.7-LGPL-3.0.txt", "lamejs-1.2.7-GPL-3.0.txt", "lamejs-1.2.7-LICENSE.txt"]) {
      const license = files.find((f) => f.fileName === `assets/${name}`);
      assert.ok(license, `${name} beside the chunk`);
    }
    assert.match(text(files.find((f) => f.fileName === "assets/lamejs-1.2.7-LGPL-3.0.txt")!), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
    assert.match(text(files.find((f) => f.fileName === "assets/lamejs-1.2.7-GPL-3.0.txt")!), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  });

  test("a build that merges the library into other code fails", async () => {
    await assert.rejects(buildWorker(`import { Mp3Encoder } from ${JSON.stringify(LAMEJS)};\nself.postMessage(typeof Mp3Encoder);\n`), /must stay a chunk of its own/);
  });
});
