import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { ApiError, api, type AssetRow } from "../../lib/api.ts";
import { deleteBatches, deleteImages, notInUse, refreshLibrary, resetLibraryForTest, totalBytes } from "./library.ts";

const row = (id: string, over: Partial<AssetRow> = {}): AssetRow => ({ id, kind: "token", width: 512, height: 512, variants: ["full", "thumb"], ...over });

const realList = api.listAssets;
const realDelete = api.deleteAssets;
afterEach(() => {
  api.listAssets = realList;
  api.deleteAssets = realDelete;
  resetLibraryForTest();
});

/** A server holding `rows`, which deletes what it is asked unless `inUseNow` names one, then refuses the whole request. */
function fakeServer(rows: AssetRow[], inUseNow: Set<string> = new Set()) {
  const held = new Map(rows.map((r) => [r.id, r]));
  const requests: string[][] = [];
  api.listAssets = async () => ({ assets: [...held.values()].map((r) => (inUseNow.has(r.id) ? { ...r, inUse: true } : r)) });
  api.deleteAssets = async (_roomId, ids) => {
    requests.push([...ids]);
    if (ids.some((id) => inUseNow.has(id))) throw new ApiError(409, "in use", "asset_in_use", null);
    for (const id of ids) held.delete(id);
    return {};
  };
  return { held, requests };
}

describe("the DM's library cleanup", () => {
  test("only images the state does not use are offered, never a scene thumbnail", () => {
    const rows = [row("a", { inUse: false }), row("b", { inUse: true }), row("c"), row("d", { kind: "thumb", inUse: false }), row("e", { kind: "map", inUse: false })];
    assert.deepEqual(notInUse(rows).map((r) => r.id), ["a", "e"]);
  });

  test("at most 500 ids a request", () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id${i}`);
    assert.deepEqual(deleteBatches(ids).map((b) => b.length), [500, 500, 201]);
    assert.deepEqual(deleteBatches([]), []);
  });

  test("the size is given only when the server sent every image's", () => {
    assert.equal(totalBytes([row("a", { bytes: 6_000_000 }), row("b", { bytes: 6_000_000 })]), 12_000_000);
    assert.equal(totalBytes([row("a", { bytes: 6_000_000 }), row("b")]), null);
    assert.equal(totalBytes([]), 0);
  });

  test("deletes every batch and counts what the fresh list no longer holds", async () => {
    const ids = Array.from({ length: 700 }, (_, i) => `id${i}`);
    const server = fakeServer(ids.map((id) => row(id, { inUse: false })));
    await refreshLibrary("room");
    const result = await deleteImages("room", ids);
    assert.deepEqual(result, { deleted: 700, inUse: false, error: null });
    assert.deepEqual(server.requests.map((r) => r.length), [500, 200]);
    assert.equal(server.held.size, 0);
  });

  test("an image put back on a token meanwhile is kept, and the others in its batch still go", async () => {
    const server = fakeServer([row("a", { inUse: false }), row("b", { inUse: false }), row("c", { inUse: false })], new Set(["b"]));
    await refreshLibrary("room");
    const result = await deleteImages("room", ["a", "b", "c"]);
    assert.deepEqual(result, { deleted: 2, inUse: true, error: null });
    assert.deepEqual(server.requests, [["a", "b", "c"], ["a", "c"]]);
    assert.deepEqual([...server.held.keys()], ["b"]);
  });

  test("a failure that is not about use stops and is reported", async () => {
    fakeServer([row("a", { inUse: false })]);
    api.deleteAssets = async () => {
      throw new ApiError(0, "offline", "network", null);
    };
    await refreshLibrary("room");
    const result = await deleteImages("room", ["a"]);
    assert.equal(result.deleted, 0);
    assert.ok(result.error instanceof ApiError && result.error.code === "network");
  });
});
