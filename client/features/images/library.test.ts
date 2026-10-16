import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { ApiError, api, type AssetRow } from "../../lib/api.ts";
import type { Handout, HandoutDoc } from "#shared/model.ts";
import {
  deleteBatches,
  deleteImages,
  docAssetIds,
  docBytes,
  docShowing,
  docsNewestFirst,
  looseHandouts,
  notInUse,
  refreshLibrary,
  resetLibraryForTest,
  totalBytes,
  uploadingSlot,
} from "./library.ts";
import { RoomScope } from "../../state/scope.ts";

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
    assert.deepEqual(result, { deleted: 700, inUse: false, error: null, remaining: [] });
    assert.deepEqual(server.requests.map((r) => r.length), [500, 200]);
    assert.equal(server.held.size, 0);
  });

  test("an image put back on a token meanwhile is kept, and the others in its batch still go", async () => {
    const server = fakeServer([row("a", { inUse: false }), row("b", { inUse: false }), row("c", { inUse: false })], new Set(["b"]));
    await refreshLibrary("room");
    const result = await deleteImages("room", ["a", "b", "c"]);
    assert.deepEqual(result, { deleted: 2, inUse: true, error: null, remaining: ["b"] });
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
    assert.deepEqual(result.remaining, ["a"]);
  });
});

/*
 * The DM's Library lists a PDF handout as one document with its pages
 * (docs/design-v1-pdf-handouts.md 8.1 and 11.1).
 */
const page = (assetId: string) => ({ assetId, width: 1584, height: 2048 });
const doc = (id: string, assetIds: string[], createdAt = "2026-10-16T10:00:00.000Z"): HandoutDoc => ({ id, rev: 1, title: `Doc ${id}`, pages: assetIds.map(page), createdAt });
const shown = (id: string, pages: string[] | { assetId: string }): Handout =>
  Array.isArray(pages)
    ? { id, rev: 1, assetId: pages[0]!, pages: pages.map(page), title: id, to: "all", shownAt: "2026-10-16T11:00:00.000Z" }
    : { id, rev: 1, assetId: pages.assetId, title: id, to: "all", shownAt: "2026-10-16T11:00:00.000Z" };

describe("documents in the DM's library", () => {
  test("documents come newest first, and the loose handout images after them leave out every image a document names", () => {
    const older = doc("older", ["p1", "p2"], "2026-10-15T10:00:00.000Z");
    const newer = doc("newer", ["p3", "blank", "p4"], "2026-10-16T10:00:00.000Z");
    assert.deepEqual(docsNewestFirst({ older, newer, gone: undefined }).map((d) => d.id), ["newer", "older"]);
    assert.deepEqual(docsNewestFirst(undefined), []);
    const rows = [
      row("p1", { kind: "handout", inUse: true }),
      row("blank", { kind: "handout", inUse: true }),
      row("loose", { kind: "handout", inUse: false }),
      row("kept", { kind: "handout", inUse: true }),
      row("map", { kind: "map", inUse: false }),
    ];
    assert.deepEqual(looseHandouts(rows, [older, newer]).map((r) => r.id), ["loose", "kept"]);
    // The pages of a document being deleted go with it.
    assert.deepEqual(looseHandouts(rows, [], new Set(["p1", "blank"])).map((r) => r.id), ["loose", "kept"]);
  });

  test("a running upload's pages, and a document's, are never offered to Clean up, though a stale list calls them unused", () => {
    const rows = [row("job1", { kind: "handout", inUse: false }), row("docpage", { kind: "handout", inUse: false }), row("loose", { kind: "handout", inUse: false })];
    const scope = new RoomScope();
    const uploading = scope.get(uploadingSlot);
    assert.equal(uploading.getState().ids.size, 0);
    uploading.setState({ ids: new Set(["job1"]) });
    const held = new Set([...uploading.getState().ids, ...docAssetIds(doc("d", ["docpage", "docpage"]))]);
    assert.deepEqual(notInUse(rows, held).map((r) => r.id), ["loose"]);
    // Each Room has its own.
    assert.equal(new RoomScope().get(uploadingSlot).getState().ids.size, 0);
  });

  test("a document shows only while a handout shows exactly its pages, in order", () => {
    const letter = doc("letter", ["a", "b", "c"]);
    assert.equal(docShowing(letter, [shown("h", ["a", "b", "c"])]), true);
    assert.equal(docShowing(letter, [shown("h", ["a", "c", "b"])]), false, "reordered");
    assert.equal(docShowing(letter, [shown("h", ["a", "b"])]), false, "a part of it");
    assert.equal(docShowing(letter, [shown("h", ["a", "b", "c", "d"])]), false, "more than it");
    assert.equal(docShowing(letter, [shown("h", { assetId: "a" })]), false, "its first page alone");
    assert.equal(docShowing(letter, []), false);
    assert.equal(docShowing(letter, [undefined, shown("x", ["z"]), shown("h", ["a", "b", "c"])]), true);
    // One image is the one-page sequence.
    assert.equal(docShowing(doc("one", ["a"]), [shown("h", { assetId: "a" })]), true);
  });

  test("two documents sharing only a blank page stay apart: showing one does not mark the other", () => {
    const first = doc("first", ["a1", "blank", "a2"]);
    const second = doc("second", ["b1", "blank"]);
    const handouts = [shown("h", ["a1", "blank", "a2"])];
    assert.equal(docShowing(first, handouts), true);
    assert.equal(docShowing(second, handouts), false);
  });

  test("a document with a repeated page shows only with the page repeated in its place", () => {
    const repeated = doc("rep", ["a", "blank", "b", "blank"]);
    assert.deepEqual(docAssetIds(repeated), ["a", "blank", "b"]);
    assert.equal(docShowing(repeated, [shown("h", ["a", "blank", "b", "blank"])]), true);
    assert.equal(docShowing(repeated, [shown("h", ["a", "blank", "b"])]), false);
    assert.equal(docShowing(repeated, [shown("h", ["a", "b", "blank", "blank"])]), false);
  });

  test("a document's size counts each image once, and only once the list holds every image's size", () => {
    const repeated = doc("rep", ["a", "blank", "b", "blank"]);
    const rows = new Map([
      ["a", row("a", { kind: "handout", bytes: 300_000 })],
      ["blank", row("blank", { kind: "handout", bytes: 10_000 })],
      ["b", row("b", { kind: "handout", bytes: 200_000 })],
    ]);
    assert.equal(docBytes(repeated, rows), 510_000);
    assert.equal(docBytes(repeated, null), null, "the list not loaded yet");
    assert.equal(docBytes(doc("more", ["a", "missing"]), rows), null, "a page the list does not hold");
    assert.equal(docBytes(doc("nosize", ["a"]), new Map([["a", row("a", { kind: "handout" })]])), null, "a row without its size");
  });
});
