import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { readPngText, writePngText } from "./pngText.ts";

const root = new URL("../", import.meta.url);

test("the README's Docker Hub button shows the version package.json releases (run pnpm readme-button after a bump)", () => {
  const version = (JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string }).version;
  const png = readFileSync(new URL("docs/images/docker-hub-button.png", root));
  assert.equal(readPngText(png, "Version"), version);
});

test("a PNG's text chunk is written once before IEND and read back", () => {
  // A 1 x 1 PNG built by hand: IHDR, one IDAT and IEND.
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    return out;
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.equal(readPngText(png, "Version"), undefined);
  const once = writePngText(png, "Version", "0.2.0");
  assert.equal(readPngText(once, "Version"), "0.2.0");
  const twice = writePngText(once, "Version", "0.3.0");
  assert.equal(readPngText(twice, "Version"), "0.3.0");
  assert.equal(twice.toString("latin1").split("tEXtVersion").length, 2, "one Version chunk, not two");
  assert.equal(twice.toString("latin1", twice.length - 8, twice.length - 4), "IEND", "IEND stays last");
});
