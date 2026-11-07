import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { encodeRecentPicks, loadRecentPicks, parseRecentPicks, RECENT_PICKS, recentEntries, recentPicksKey, recordPick, rememberPick, type PickStorage, type RecentPicks } from "./recent.ts";

function memory(initial: Record<string, string> = {}): PickStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const blocked: PickStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

const store = () => createStore<RecentPicks>(() => ({ key: null, ids: [] }));

describe("the search's recent picks (design-v1-qol.md 5, The results and Players)", () => {
  test("newest first, each once, five kept", () => {
    let ids: string[] = [];
    for (const id of ["a", "b", "c", "a", "d", "e", "f"]) ids = recordPick(ids, id);
    assert.deepEqual(ids, ["f", "e", "d", "a", "c"]);
    assert.equal(ids.length, RECENT_PICKS);
  });

  test("kept per room and member, so a DM's picks on a shared device are never a player's", () => {
    assert.equal(recentPicksKey("r1", "dm1"), "rvtt.searchRecent.r1.dm1");
    const storage = memory();
    const dm = store();
    loadRecentPicks(dm, "r1", "dm1", storage);
    rememberPick(dm, "token:boss", storage);
    const pat = store();
    loadRecentPicks(pat, "r1", "p1", storage);
    assert.deepEqual(pat.getState().ids, []);
    loadRecentPicks(pat, "r2", "dm1", storage);
    assert.deepEqual(pat.getState().ids, [], "another room");
    loadRecentPicks(pat, "r1", "dm1", storage);
    assert.deepEqual(pat.getState().ids, ["token:boss"]);
  });

  test("storage holds result ids only, read back whatever wrote there", () => {
    assert.deepEqual(parseRecentPicks(encodeRecentPicks(["a", "b"])), ["a", "b"]);
    assert.deepEqual(parseRecentPicks(null), []);
    assert.deepEqual(parseRecentPicks("{"), []);
    assert.deepEqual(parseRecentPicks('{"a":1}'), []);
    assert.deepEqual(parseRecentPicks(JSON.stringify(["a", 3, "", "a", "x".repeat(201), "b\u0007", { id: "c" }, "b", "c", "d", "e", "f"])), ["a", "b", "c", "d", "e"]);
  });

  test("blocked storage keeps the picks for this page load", () => {
    const s = store();
    loadRecentPicks(s, "r1", "p1", blocked);
    rememberPick(s, "panel:dice", blocked);
    assert.deepEqual(s.getState().ids, ["panel:dice"]);
  });

  test("a pick shows only while the index holds it, newest first", () => {
    const entry = (id: string) => ({ id, kind: "panel" as const, title: id, where: "", icon: "more" as const, act: { t: "open" as const, route: { panel: id } } });
    const byId = new Map(["dice", "log"].map((id) => [id, { entry: entry(id) }]));
    assert.deepEqual(recentEntries(["log", "gone", "dice"], byId).map((e) => e.id), ["log", "dice"]);
  });

  test("nothing is kept before the room said who this is", () => {
    const s = store();
    const storage = memory();
    rememberPick(s, "panel:dice", storage);
    assert.deepEqual(s.getState().ids, []);
    assert.deepEqual(storage.data, {});
  });
});
