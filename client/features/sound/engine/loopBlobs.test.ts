import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopBlobs } from "./loopBlobs.ts";

function setup(answers: (() => Promise<Response>)[]) {
  let calls = 0;
  const revoked: string[] = [];
  const blobs = new LoopBlobs({
    fetch: () => answers[Math.min(calls++, answers.length - 1)]!(),
    createObjectURL: () => "blob:made",
    revokeObjectURL: (u) => revoked.push(u),
    maxBytes: 100,
  });
  return { blobs, calls: () => calls, revoked };
}
const ok = (size: number) => async () => new Response(new Uint8Array(size), { headers: { "content-length": String(size) } });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a loop's blob", () => {
  test("streams until the blob is in, then plays the blob", async () => {
    const t = setup([ok(10)]);
    assert.equal(t.blobs.urlFor("a", "/a"), "/a");
    await settle();
    assert.equal(t.blobs.urlFor("a", "/a"), "blob:made");
    assert.equal(t.calls(), 1, "fetched once");
  });

  test("a fetch that failed in an outage is tried again at the next pass", async () => {
    const t = setup([() => Promise.reject(new TypeError("offline")), ok(10)]);
    t.blobs.urlFor("a", "/a");
    await settle();
    assert.equal(t.blobs.urlFor("a", "/a"), "/a", "this pass still streams");
    await settle();
    assert.equal(t.blobs.urlFor("a", "/a"), "blob:made", "the pass after takes the blob");
    assert.equal(t.calls(), 2);
  });

  test("a server error is tried again too", async () => {
    const t = setup([async () => new Response("", { status: 503 }), ok(10)]);
    t.blobs.urlFor("a", "/a");
    await settle();
    t.blobs.urlFor("a", "/a");
    await settle();
    assert.equal(t.blobs.urlFor("a", "/a"), "blob:made");
  });

  test("a file too big streams for good and is asked about once", async () => {
    const t = setup([ok(500)]);
    t.blobs.urlFor("a", "/a");
    await settle();
    t.blobs.urlFor("a", "/a");
    t.blobs.urlFor("a", "/a");
    await settle();
    assert.equal(t.calls(), 1);
    assert.equal(t.blobs.urlFor("a", "/a"), "/a");
  });

  test("a call while the fetch is out does not start a second", async () => {
    const t = setup([ok(10)]);
    t.blobs.urlFor("a", "/a");
    t.blobs.urlFor("a", "/a");
    await settle();
    assert.equal(t.calls(), 1);
  });

  test("dispose revokes the blobs and fetches nothing after", async () => {
    const t = setup([ok(10)]);
    t.blobs.urlFor("a", "/a");
    await settle();
    t.blobs.dispose();
    assert.deepEqual(t.revoked, ["blob:made"]);
    t.blobs.urlFor("b", "/b");
    assert.equal(t.calls(), 1);
  });
});
