import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectionOf, compareLogIds, doorChunk, keys, parseKey, readEntity, revOf, sightOf, writeEntity } from "./keys.ts";
import { room, token } from "./testutil.ts";

describe("keys", () => {
  test("build and parse round trip for every kind", () => {
    assert.deepEqual(parseKey(keys.token("t1")), { kind: "token", id: "t1" });
    assert.deepEqual(parseKey(keys.chunk("s1", -1, 2)), { kind: "chunk", sceneId: "s1", cx: -1, cy: 2 });
    assert.deepEqual(parseKey(keys.fog("s1", 3, 4)), { kind: "fog", sceneId: "s1", tx: 3, ty: 4 });
    assert.deepEqual(parseKey(keys.fogDraft("s1")), { kind: "fogDraft", sceneId: "s1" });
    assert.deepEqual(parseKey(keys.explored("s1", 3, 4)), { kind: "explored", sceneId: "s1", tx: 3, ty: 4 });
    assert.deepEqual(parseKey(keys.sight("s:1", 0, 12)), { kind: "sight", sceneId: "s:1", tx: 0, ty: 12 });
    assert.deepEqual(parseKey(keys.log("12:3")), { kind: "log", id: "12:3" });
    assert.deepEqual(parseKey(keys.encounter), { kind: "encounter" });
    assert.deepEqual(parseKey(keys.encounterHistory), { kind: "encounterHistory" });
    assert.deepEqual(parseKey(keys.meta), { kind: "meta" });
    for (const kind of ["scene", "member", "character", "template", "drawing", "label", "handout", "journal", "pin", "roll", "handoutDoc"] as const) {
      assert.deepEqual(parseKey(keys[kind]("x")), { kind, id: "x" });
    }
  });

  test("wave 5's collections read and write by key (docs/design-v1-dm-tools.md 2.2)", () => {
    const state = room();
    const page = { id: "pg1", rev: 0, title: "P", access: "all" as const, blocks: [] };
    const pin = { id: "p1", rev: 0, sceneId: "s1", x: 1, y: 1, color: "#ffffff", visibility: "all" as const };
    const roll = { id: "r1", rev: 0, test: { kind: "save" as const, choices: [{ ability: "dex" as const }] }, dcShown: true, resultShown: true, at: "x", targets: [{ characterId: "c1" }] };
    for (const [key, value, collection] of [
      [keys.journal("pg1"), page, "journal"],
      [keys.pin("p1"), pin, "pins"],
      [keys.roll("r1"), roll, "rolls"],
    ] as const) {
      assert.equal(collectionOf(key), collection);
      const next = writeEntity(state, key, value);
      assert.equal(readEntity(next, key), value);
      assert.equal(readEntity(state, key), null);
      assert.equal(readEntity(writeEntity(next, key, null), key), null);
    }
  });

  test("documents of handout pages read and write by key (docs/design-v1-pdf-handouts.md 3.3)", () => {
    const state = room();
    const doc = { id: "d1", rev: 0, title: "Strange letter", pages: [{ assetId: "a", width: 1584, height: 2048 }], createdAt: "x" };
    const key = keys.handoutDoc("d1");
    assert.equal(key, "handoutDoc:d1");
    assert.equal(collectionOf(key), "handoutDocs");
    const next = writeEntity(state, key, doc);
    assert.equal(readEntity(next, key), doc);
    assert.equal(readEntity(state, key), null);
    assert.equal(readEntity(writeEntity(next, key, null), key), null);
  });

  test("rejects malformed keys", () => {
    assert.equal(parseKey("bogus"), null);
    assert.equal(parseKey("bogus:1"), null);
    assert.equal(parseKey("token:"), null);
    assert.equal(parseKey("chunk:s1:a,b"), null);
    assert.equal(parseKey("chunk:s1"), null);
    assert.equal(collectionOf("meta"), null);
    assert.equal(collectionOf(keys.fog("s", 0, 0)), "fogTiles");
    assert.equal(collectionOf(keys.explored("s", 0, 0)), "exploredTiles");
    assert.equal(collectionOf(keys.sight("s", 0, 0)), null, "sight is derived, never a stored collection");
  });

  test("sight lives only in a projected state, and writing a tile makes the state one", () => {
    const state = room();
    assert.equal(sightOf(state), undefined);
    assert.equal(readEntity(state, keys.sight("s1", 0, 0)), null);
    const next = writeEntity(state, keys.sight("s1", 0, 0), { f: 2 });
    assert.deepEqual(sightOf(next), { "s1:0,0": { f: 2 } });
    assert.deepEqual(readEntity(next, keys.sight("s1", 0, 0)), { f: 2 });
    assert.deepEqual(sightOf(writeEntity(next, keys.sight("s1", 0, 0), null)), {});
    const explored = writeEntity(state, keys.explored("s1", 1, 0), { sceneId: "s1", tx: 1, ty: 0, rev: 1, bits: "x" });
    assert.equal(readEntity(explored, keys.explored("s1", 1, 0)), explored.exploredTiles["s1:1,0"]);
  });

  test("a door's chunk is its edge cell's, or the one a free door names", () => {
    assert.deepEqual(doorChunk({ edge: "16,31,n" }), { cx: 1, cy: 1 });
    assert.deepEqual(doorChunk({ edge: "15,0,w" }), { cx: 0, cy: 0 });
    assert.deepEqual(doorChunk({ cx: 3, cy: 2 }), { cx: 3, cy: 2 });
  });

  test("readEntity and writeEntity share structure and never mutate", () => {
    const state = room();
    const t = token("t1");
    const next = writeEntity(state, keys.token("t1"), t);
    assert.equal(readEntity(next, keys.token("t1")), t);
    assert.equal(readEntity(state, keys.token("t1")), null);
    assert.equal(next.scenes, state.scenes);
    const removed = writeEntity(next, keys.token("t1"), null);
    assert.equal(readEntity(removed, keys.token("t1")), null);
    const withLog = writeEntity(state, keys.log("2:0"), { id: "2:0", at: "x", kind: "chat", text: "b" });
    const sorted = writeEntity(withLog, keys.log("1:1"), { id: "1:1", at: "x", kind: "chat", text: "a" });
    assert.deepEqual(sorted.log.map((e) => e.id), ["1:1", "2:0"]);
    assert.throws(() => writeEntity(state, keys.meta, null));
    assert.deepEqual(writeEntity(state, keys.encounterHistory, null).encounterHistory, []);
  });

  test("log ids compare numerically and revOf reads only numbers", () => {
    assert.ok(compareLogIds("9:0", "10:0") < 0);
    assert.ok(compareLogIds("10:2", "10:10") < 0);
    assert.equal(revOf({ rev: 3 }), 3);
    assert.equal(revOf({ rev: "3" }), undefined);
    assert.equal(revOf(null), undefined);
  });
});
