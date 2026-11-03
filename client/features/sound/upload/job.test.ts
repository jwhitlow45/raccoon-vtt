import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../../lib/api.ts";
import { ADDED_MS, SoundQueue } from "./job.ts";
import { assetRow, fakeFile, FakeWorld, flush, OUT_OF_SPACE, prepared } from "./job.testutil.ts";
import { OUT_OF_STORAGE } from "./words.ts";

function setup() {
  const world = new FakeWorld();
  const queue = new SoundQueue(world.deps());
  const steps = () => queue.store.getState().rows.map((r) => r.step.t);
  return { world, queue, steps };
}

describe("the Add buttons' queue", () => {
  test("a file goes through reading, uploading and sound.create, then says Added for 3 seconds", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("tavern_night.wav")], "music");
    assert.deepEqual(steps(), ["waiting"]);
    world.reads[0]!.onStep({ t: "reading" });
    assert.deepEqual(steps(), ["reading"]);
    world.reads[0]!.onStep({ t: "converting", percent: 40 });
    assert.deepEqual(queue.store.getState().rows[0]!.step, { t: "converting", percent: 40 });
    world.reads[0]!.resolve(prepared(25));
    await flush();
    assert.deepEqual(steps(), ["uploading"]);
    world.uploads[0]!.options.onProgress?.(0.6);
    assert.deepEqual(queue.store.getState().rows[0]!.step, { t: "uploading", percent: 60 });
    world.uploads[0]!.resolve(assetRow("a1"));
    await flush();
    assert.deepEqual(steps(), ["adding"]);
    assert.deepEqual(world.creates[0]!.op, { id: "id2", assetId: "a1", name: "tavern night", use: "music", ms: 31_020, level: 25 });
    world.creates[0]!.resolve({ t: "taken" });
    await flush();
    assert.deepEqual(steps(), ["added"]);
    assert.equal(queue.store.getState().rows[0]!.added, "tavern night");
    assert.deepEqual(world.added, ["id2"]);
    assert.equal(world.timers[0]!.ms, ADDED_MS);
    world.timers[0]!.run();
    assert.deepEqual(steps(), []);
  });

  test("a level of 0 is left out, as the model reads an absent level", async () => {
    const { world, queue } = setup();
    queue.add([fakeFile("Rain.wav")], "loop");
    world.reads[0]!.resolve(prepared(0));
    await flush();
    world.uploads[0]!.resolve(assetRow("a1"));
    await flush();
    assert.equal("level" in world.creates[0]!.op, false);
  });

  test("one file is read at a time, and the next is read while the first uploads", async () => {
    const { world, queue } = setup();
    queue.add([fakeFile("a.wav"), fakeFile("b.wav"), fakeFile("c.wav")], "effect");
    assert.equal(world.reads.length, 1);
    world.reads[0]!.resolve(prepared());
    await flush();
    assert.equal(world.reads.length, 2);
    assert.equal(world.uploads.length, 1);
    assert.equal(world.maxReads, 1);
  });

  test("a refusal stays on its row and the others go on, and Dismiss clears it", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("Thunder.wav"), fakeFile("Drip.wav")], "effect");
    world.reads[0]!.resolve({ ok: false, why: { t: "useTooLong", use: "effect" } });
    await flush();
    assert.deepEqual(steps(), ["refused", "waiting"]);
    assert.deepEqual(queue.store.getState().rows[0]!.step, { t: "refused", text: "Thunder.wav: an effect is 30 seconds at most. Add it as background or music." });
    assert.equal(world.reads.length, 2);
    queue.dismiss(queue.store.getState().rows[0]!.id);
    assert.deepEqual(steps(), ["waiting"]);
  });

  test("Cancel stops a read, and the next file waits until the cancelled read has settled", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav"), fakeFile("b.wav")], "music");
    const first = queue.store.getState().rows[0]!.id;
    queue.cancel(first);
    assert.equal(world.reads[0]!.signal.aborted, true);
    assert.deepEqual(steps(), ["waiting"]);
    await flush();
    assert.equal(world.reads.length, 1, "a decode cannot stop partway, so a second one waits");
    world.reads[0]!.reject(world.reads[0]!.signal.reason);
    await flush();
    assert.equal(world.reads.length, 2);
    assert.equal(world.creates.length, 0);
  });

  test("Cancel during an upload aborts it and sends no sound.create", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    queue.cancel(queue.store.getState().rows[0]!.id);
    assert.equal(world.uploads[0]!.options.signal.aborted, true);
    await flush();
    assert.deepEqual(steps(), []);
    assert.equal(world.creates.length, 0);
    assert.equal(world.storageChanges, 1);
  });

  test("a cancel that lands as the upload answers sends no sound.create", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    world.uploads[0]!.resolve(assetRow("a1"));
    queue.cancel(queue.store.getState().rows[0]!.id);
    await flush();
    assert.equal(world.creates.length, 0);
    assert.deepEqual(steps(), []);
  });

  test("a cancel while sound.create is on its way leaves the row gone and says nothing more", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    world.uploads[0]!.resolve(assetRow("a1"));
    await flush();
    queue.cancel(queue.store.getState().rows[0]!.id);
    world.creates[0]!.resolve({ t: "taken" });
    await flush();
    assert.deepEqual(steps(), []);
    assert.deepEqual(world.added, []);
  });

  test("the room out of storage stops the batch: the refused row says why, the rest go", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav"), fakeFile("b.wav"), fakeFile("c.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    world.reads[1]!.resolve(prepared());
    await flush();
    assert.equal(world.uploads.length, 2);
    world.uploads[0]!.reject(OUT_OF_SPACE);
    await flush();
    assert.deepEqual(steps(), ["refused"]);
    assert.deepEqual(queue.store.getState().rows[0]!.step, { t: "refused", text: OUT_OF_STORAGE });
    assert.equal(world.uploads[1]!.options.signal.aborted, true);
    assert.equal(world.reads[2]!.signal.aborted, true);
    assert.equal(world.creates.length, 0);
  });

  test("other upload refusals are worded after the file's name", async () => {
    const { world, queue } = setup();
    queue.add([fakeFile("a.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    world.uploads[0]!.reject(new ApiError(503, "busy", "busy", null));
    await flush();
    assert.deepEqual(queue.store.getState().rows[0]!.step, { t: "refused", text: "a.wav: The server is busy. Try again in a minute." });
  });

  test("a refused sound.create says the store's words, and an unheard answer reads the room", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav"), fakeFile("b.wav"), fakeFile("c.wav")], "music");
    for (let i = 0; i < 3; i++) {
      world.reads[i]!.resolve(prepared());
      await flush();
      world.uploads[i]!.resolve(assetRow(`a${i}`));
      await flush();
    }
    world.creates[0]!.resolve({ t: "refused", text: "Not saved. the room is full: it can hold at most 300 sounds" });
    world.held.add(world.creates[1]!.op.id);
    world.creates[1]!.resolve({ t: "unknown" });
    world.creates[2]!.resolve({ t: "unknown" });
    await flush();
    assert.deepEqual(steps(), ["refused", "added", "refused"]);
    assert.match((queue.store.getState().rows[0]!.step as { text: string }).text, /^a\.wav: Not saved\./);
    assert.match((queue.store.getState().rows[2]!.step as { text: string }).text, /may not have been added/);
  });

  test("a pick of more than 20 takes its first 20", () => {
    const { queue } = setup();
    const left = queue.add(Array.from({ length: 23 }, (_, i) => fakeFile(`${i}.wav`)), "effect");
    assert.equal(left, 3);
    assert.equal(queue.store.getState().rows.length, 20);
  });

  test("leaving the room stops everything and sends nothing more", async () => {
    const { world, queue, steps } = setup();
    queue.add([fakeFile("a.wav"), fakeFile("b.wav")], "music");
    world.reads[0]!.resolve(prepared());
    await flush();
    queue.dispose();
    assert.deepEqual(steps(), []);
    assert.equal(world.uploads[0]!.options.signal.aborted, true);
    world.reads[1]?.resolve(prepared());
    await flush();
    assert.equal(world.creates.length, 0);
    // The development double mount goes on using a disposed scope: a new file still queues, once the old read settles.
    queue.add([fakeFile("c.wav")], "music");
    assert.deepEqual(steps(), ["waiting"]);
  });
});
