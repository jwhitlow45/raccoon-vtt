import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crc32 as nodeCrc32 } from "node:zlib";
import { crc32, storedZip } from "./zipStore.ts";

/*
 * Export every floor's zip (docs/design/design-v1-floors.md phase 4, 9.3):
 * read back here by the format's own rules, field by field, as an unzip
 * reads it, with each entry's CRC checked against node's zlib.
 */

type Read = { name: string; bytes: Uint8Array; flags: number; method: number; time: number; date: number };

/** Reads a zip from its end record, through the central directory, to each local header and its bytes. */
function readZip(zip: Uint8Array): Read[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "the end record");
  assert.equal(view.getUint16(end + 20, true), 0, "no comment");
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  assert.equal(at + size, end, "the central directory ends where the end record starts");
  const out: Read[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "a central header");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const csize = view.getUint32(at + 20, true);
    const usize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50, "a local header");
    assert.equal(view.getUint32(local + 14, true), crc, "the local CRC is the central one");
    assert.equal(view.getUint32(local + 18, true), csize);
    assert.equal(decoder.decode(zip.subarray(local + 30, local + 30 + view.getUint16(local + 26, true))), name, "the local name is the central one");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const bytes = zip.subarray(start, start + csize);
    assert.equal(csize, usize, "stored, so both sizes agree");
    assert.equal(nodeCrc32(bytes), crc, `${name}'s CRC`);
    out.push({ name, bytes, flags, method, time: view.getUint16(at + 12, true), date: view.getUint16(at + 14, true) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  assert.equal(at, end);
  return out;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("a stored zip", () => {
  test("CRC-32 is the format's: the check value and node's for random bytes", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
    assert.equal(crc32(new Uint8Array()), 0);
    for (let n = 0; n < 20; n++) {
      const bytes = new Uint8Array(1 + Math.floor(Math.random() * 5000));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      assert.equal(crc32(bytes), nodeCrc32(bytes));
    }
  });

  test("holds each entry in order, stored, with UTF-8 names and the time given", async () => {
    const pictures = [new Uint8Array([137, 80, 78, 71, 1, 2, 3]), new Uint8Array(70_000).map((_, i) => i % 251), new Uint8Array()];
    const names = ["01-ground-floor.png", "02-café-floor.png", "03-floor.png"];
    const when = new Date(2026, 10, 19, 14, 37, 58);
    const zip = await storedZip(
      names.map((name, i) => ({ name, data: new Blob([pictures[i]!], { type: "image/png" }) })),
      when,
    );
    assert.equal(zip.type, "application/zip");
    const read = readZip(await bytesOf(zip));
    assert.deepEqual(
      read.map((r) => r.name),
      names,
    );
    read.forEach((r, i) => {
      assert.deepEqual([...r.bytes], [...pictures[i]!], r.name);
      assert.equal(r.method, 0, "stored");
      assert.equal(r.flags, 0x0800, "names in UTF-8");
      assert.equal(r.time, (14 << 11) | (37 << 5) | 29);
      assert.equal(r.date, ((2026 - 1980) << 9) | (11 << 5) | 19);
    });
  });

  test("an empty zip is the end record alone, and two entries of one name are refused", async () => {
    const empty = await bytesOf(await storedZip([]));
    assert.equal(empty.byteLength, 22);
    assert.deepEqual(readZip(empty), []);
    const one = new Blob([new Uint8Array([1])]);
    await assert.rejects(
      storedZip([
        { name: "01-floor.png", data: one },
        { name: "01-floor.png", data: one },
      ]),
      /two zip entries are named 01-floor\.png/,
    );
  });
});
