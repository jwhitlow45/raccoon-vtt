import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "#shared/model.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { cleanFolderName, folderNames, groupScenes, moveFolder, moveScene, readCollapsed, renameFolderOps, renameMergesInto, sendFolderRename, writeCollapsed, type CollapsedStorage } from "./folders.ts";

function scene(id: string, order: number, folder?: string): Scene {
  const s: Scene = { id, rev: 0, name: id, order, bounds: { w: 10, h: 10 }, grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 }, background: "#000000", fogEnabled: false, wallsVersion: 0 };
  if (folder !== undefined) s.folder = folder;
  return s;
}

/** Scenes in order: a and d in no folder, Crypt holding b and e, Town holding c. */
const sorted = [scene("a", 0), scene("b", 1, "Crypt"), scene("c", 2, "Town"), scene("d", 3), scene("e", 4, "Crypt")];

function ids(groups: ReturnType<typeof groupScenes>) {
  return groups.map((g) => [g.folder, g.scenes.map((s) => s.id)]);
}

describe("scene folders", () => {
  test("scenes in no folder sit at the top, and each folder sits where its first scene is", () => {
    assert.deepEqual(ids(groupScenes(sorted)), [
      [null, ["a", "d"]],
      ["Crypt", ["b", "e"]],
      ["Town", ["c"]],
    ]);
    assert.deepEqual(folderNames(sorted), ["Crypt", "Town"]);
    // With every scene in a folder there is no group for loose scenes.
    assert.deepEqual(ids(groupScenes([scene("x", 0, "Town")])), [["Town", ["x"]]]);
  });

  test("moving a scene swaps it with its neighbor in its own group and sends the order the panel shows", () => {
    const groups = groupScenes(sorted);
    assert.deepEqual(moveScene(groups, "e", -1), ["a", "d", "e", "b", "c"]);
    assert.deepEqual(moveScene(groups, "d", -1), ["d", "a", "b", "e", "c"]);
    // The ends of a group stop the move, even with another group past them.
    assert.equal(moveScene(groups, "b", -1), null);
    assert.equal(moveScene(groups, "d", 1), null);
    assert.equal(moveScene(groups, "c", 1), null);
    assert.equal(moveScene(groups, "missing", 1), null);
  });

  test("a move inside one folder never shifts where another folder sits", () => {
    // Stored order interleaves the folders: Crypt's first scene is first, then Town's.
    const interleaved = [scene("b", 0, "Crypt"), scene("c", 1, "Town"), scene("e", 2, "Crypt"), scene("f", 3, "Town")];
    const order = moveScene(groupScenes(interleaved), "b", 1)!;
    assert.deepEqual(order, ["e", "b", "c", "f"]);
    const reordered = order.map((id, i) => ({ ...interleaved.find((s) => s.id === id)!, order: i }));
    assert.deepEqual(folderNames(reordered), ["Crypt", "Town"]);
  });

  test("a folder moves past the folder next to it, never above the scenes in no folder", () => {
    const groups = groupScenes(sorted);
    assert.deepEqual(moveFolder(groups, "Town", -1), ["a", "d", "c", "b", "e"]);
    assert.deepEqual(moveFolder(groups, "Crypt", 1), ["a", "d", "c", "b", "e"]);
    assert.equal(moveFolder(groups, "Crypt", -1), null);
    assert.equal(moveFolder(groups, "Town", 1), null);
    assert.equal(moveFolder(groups, "Nowhere", 1), null);
    // Every reorder the panel sends is one the protocol takes.
    assert.ok(clientOpSchema.safeParse({ t: "scene.reorder", order: moveFolder(groups, "Town", -1) }).success);
  });

  test("a folder name is one trimmed line of at most 40 characters", () => {
    assert.equal(cleanFolderName("  Act   one  "), "Act one");
    assert.equal(cleanFolderName("   "), null);
    assert.equal(cleanFolderName("x".repeat(41)), null);
    assert.equal(cleanFolderName("x".repeat(40)), "x".repeat(40));
    assert.equal(cleanFolderName("Crypt‮"), null);
  });

  test("renaming a folder renames it on every scene in it, as ops the protocol takes", () => {
    const ops = renameFolderOps(sorted, "Crypt", "Tomb");
    assert.deepEqual(ops, [
      { t: "scene.update", sceneId: "b", patch: { folder: "Tomb" } },
      { t: "scene.update", sceneId: "e", patch: { folder: "Tomb" } },
    ]);
    for (const op of ops) assert.ok(clientOpSchema.safeParse(op).success);
    assert.deepEqual(renameFolderOps(sorted, "Crypt", "Crypt"), []);
  });

  test("a rename goes out as one undo group, a folder of one scene too", () => {
    const sent: Array<{ op: ClientOp; group: string | undefined }> = [];
    let ids = 0;
    const actions = { dispatch: (op: ClientOp, opts?: { group?: string }) => (sent.push({ op, group: opts?.group }), sent.length), newId: () => `g${++ids}` };
    sendFolderRename(actions, sorted, "Crypt", "Tomb");
    sendFolderRename(actions, sorted, "Town", "Village");
    assert.deepEqual(
      sent.map((s) => [s.op.t === "scene.update" ? s.op.sceneId : "", s.group]),
      [
        ["b", "g1"],
        ["e", "g1"],
        ["c", "g2"],
      ],
    );
  });

  test("a rename to another folder's name is told, before saving, that it merges the two", () => {
    const folders = folderNames(sorted);
    assert.equal(renameMergesInto(folders, "Crypt", "Town"), "Town");
    // The name as it will be saved: trimmed, with runs of spaces made one.
    assert.equal(renameMergesInto(folders, "Crypt", "  Town "), "Town");
    assert.equal(renameMergesInto(folders, "Crypt", "Tomb"), null);
    assert.equal(renameMergesInto(folders, "Crypt", "Crypt"), null);
    // Names are exact, so another case is another folder.
    assert.equal(renameMergesInto(folders, "Crypt", "town"), null);
    assert.equal(renameMergesInto(folders, "Crypt", ""), null);
  });

  test("collapsed folders survive a reload, and storage that throws is ignored", () => {
    const data = new Map<string, string>();
    const storage: CollapsedStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    writeCollapsed(storage, "ROOM1", new Set(["Crypt"]));
    assert.deepEqual([...readCollapsed(storage, "ROOM1")], ["Crypt"]);
    assert.deepEqual([...readCollapsed(storage, "ROOM2")], []);

    data.set("rvtt.sceneFoldersCollapsed.ROOM1", "{not json");
    assert.deepEqual([...readCollapsed(storage, "ROOM1")], []);
    data.set("rvtt.sceneFoldersCollapsed.ROOM1", JSON.stringify(["Crypt", 4, null]));
    assert.deepEqual([...readCollapsed(storage, "ROOM1")], ["Crypt"]);

    const blocked: CollapsedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual([...readCollapsed(blocked, "ROOM1")], []);
    assert.doesNotThrow(() => writeCollapsed(blocked, "ROOM1", new Set(["Crypt"])));
    assert.deepEqual([...readCollapsed(null, "ROOM1")], []);
  });
});
