import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CloseWrites } from "./closeWrites.ts";

function deferred(): { promise: Promise<void>; resolve(): void; reject(err: Error): void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the writes of closing sockets (LP5-OPS-3)", () => {
  test("close waits for a write in flight", async () => {
    const writes = new CloseWrites();
    const write = deferred();
    let finished = false;
    writes.run(
      () => write.promise.then(() => (finished = true)),
      () => assert.fail("no error expected"),
    );
    const closing = writes.close(5_000);
    setTimeout(() => write.resolve(), 20);
    await closing;
    assert.equal(finished, true);
  });

  test("a write asked for after close is never started", async () => {
    const writes = new CloseWrites();
    await writes.close(10);
    let started = false;
    writes.run(
      async () => (started = true),
      () => undefined,
    );
    assert.equal(started, false);
  });

  test("a failure while close waits is reported, one after it stopped waiting is not", async () => {
    const writes = new CloseWrites();
    const quick = deferred();
    const stuck = deferred();
    const reported: string[] = [];
    writes.run(
      () => quick.promise,
      (err) => reported.push((err as Error).message),
    );
    writes.run(
      () => stuck.promise,
      (err) => reported.push((err as Error).message),
    );
    const closing = writes.close(50);
    quick.reject(new Error("refused while waiting"));
    await closing;
    stuck.reject(new Error("Cannot use a pool after calling end on the pool"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reported, ["refused while waiting"]);
  });
});
