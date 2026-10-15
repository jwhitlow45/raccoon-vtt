import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { batchByBytes } from "./batch.ts";

describe("batches", () => {
  test("every batch is exactly within its bytes and its count", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `item-${i}`, text: "x".repeat(i % 97) }));
    const wrap = (list: unknown[]) => ({ t: "build.walls", sceneId: "s", put: list });
    for (const [max, bytes] of [
      [500, 48 * 1024],
      [100, 4096],
      [7, 1_000_000],
    ] as const) {
      const batches = batchByBytes(items, max, bytes, wrap);
      assert.deepEqual(batches.flat(), items);
      for (const b of batches) {
        assert.ok(b.length <= max);
        assert.ok(serializedBytes(wrap(b)) <= bytes);
      }
      // Greedy: the next item would not have fit.
      for (let i = 0; i + 1 < batches.length; i++) {
        const next = [...batches[i]!, batches[i + 1]![0]!];
        assert.ok(next.length > max || serializedBytes(wrap(next)) > bytes);
      }
    }
  });
});
