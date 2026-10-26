import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isometric, TOP_DOWN, type Turn } from "../../lib/view.ts";

const stored = new Map<string, string>();
let blocked = false;
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => {
      if (blocked) throw new Error("blocked");
      return stored.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (blocked) throw new Error("blocked");
      stored.set(k, String(v));
    },
    removeItem: (k: string) => void stored.delete(k),
  },
});

const store = await import("./store.ts");
const { displayViewKey, FOLLOW_THE_SCENE, isoReady, MAX_TURNS, parseStoredView, pickView, readView, serializeStoredView, settledView, shownView, turnOf, turnView, viewKey, withPick, withTurn } = store;

const ids = (s: { turns: readonly (readonly [string, Turn])[] }) => s.turns.map(([id]) => id);

/** The module as a reloaded page has it: its own cache, the same storage. */
let reloads = 0;
const reloaded = () => import(`./store.ts?reload=${++reloads}`) as Promise<typeof store>;

describe("the view store (docs/design-v1-isometric-view.md 7)", () => {
  test("any device after the deploy shows Top-down: it follows the scene, and no scene suggests Isometric until the DM sets one", () => {
    assert.equal(isoReady, true);
    assert.deepEqual(readView(viewKey("fresh")), FOLLOW_THE_SCENE);
    assert.equal(shownView({ stored: readView(viewKey("fresh")), sceneId: "s1", suggested: undefined }), TOP_DOWN);
    // isoReady is the one switch: set false, every device shows Top-down whatever it stored or the scene suggests.
    for (const pick of [null, "topDown", "isometric"] as const) {
      for (const suggested of [undefined, "isometric"] as const) {
        const s = withTurn(withPick(FOLLOW_THE_SCENE, pick), "s1", 2);
        assert.equal(shownView({ stored: s, sceneId: "s1", suggested, ready: false }), TOP_DOWN, `${pick} ${suggested}`);
      }
    }
  });

  test("the pick holds for the whole room, Follow the scene shows each scene's suggestion, and a tool can show Top-down", () => {
    const ready = true;
    const follow = FOLLOW_THE_SCENE;
    assert.equal(shownView({ stored: follow, sceneId: "s1", suggested: undefined, ready }), TOP_DOWN);
    assert.equal(shownView({ stored: follow, sceneId: "s1", suggested: "isometric", ready }), isometric(0));
    const iso = withPick(follow, "isometric");
    for (const sceneId of ["s1", "s2", "s3"]) assert.equal(shownView({ stored: iso, sceneId, suggested: undefined, ready }), isometric(0), sceneId);
    const flat = withPick(follow, "topDown");
    assert.equal(shownView({ stored: flat, sceneId: "s1", suggested: "isometric", ready }), TOP_DOWN, "a pick of Top-down beats the suggestion");
    assert.equal(shownView({ stored: iso, sceneId: "s1", suggested: undefined, ready, forcedTopDown: true }), TOP_DOWN);
    assert.equal(withPick(iso, null).pick, null, "Follow the scene again");
  });

  test("a turn is kept per scene, writes only its own, and is never a pick", () => {
    const ready = true;
    let s = withTurn(FOLLOW_THE_SCENE, "s1", 1);
    s = withTurn(s, "s2", 3);
    assert.equal(s.pick, null, "Q while following still follows");
    assert.equal(shownView({ stored: s, sceneId: "s1", suggested: "isometric", ready }), isometric(1));
    assert.equal(shownView({ stored: s, sceneId: "s2", suggested: "isometric", ready }), isometric(3));
    assert.equal(shownView({ stored: s, sceneId: "s3", suggested: "isometric", ready }), isometric(0));
    assert.equal(shownView({ stored: s, sceneId: "s1", suggested: undefined, ready }), TOP_DOWN, "the DM suggests Top-down again: the device follows");
  });

  test("turns are kept for 100 scenes, the oldest dropped, and a scene turned again is the newest", () => {
    let s = FOLLOW_THE_SCENE;
    for (let i = 0; i < MAX_TURNS; i++) s = withTurn(s, `s${i}`, 1);
    s = withTurn(s, "s0", 2);
    s = withTurn(s, "new", 3);
    const kept = ids(s);
    assert.equal(kept.length, MAX_TURNS);
    assert.ok(!kept.includes("s1"), "the oldest went");
    assert.ok(kept.includes("s0"), "turned again, so kept");
    assert.deepEqual(kept.slice(-2), ["s0", "new"]);
    const few = withTurn(withTurn(withTurn(withTurn(FOLLOW_THE_SCENE, "a", 1), "b", 1), "c", 1), "a", 2);
    assert.deepEqual(ids(few), ["b", "c", "a"], "the newest last, so the oldest goes first");
  });

  test("any scene id is a scene's own: none reads the object prototype, and an integer-like id keeps its place (ISO1-OPUS-1)", () => {
    const ready = true;
    const odd = ["constructor", "__proto__", "7", "toString", "hasOwnProperty"];
    const iso = withPick(FOLLOW_THE_SCENE, "isometric");
    for (const id of odd) {
      assert.equal(turnOf(iso, id), 0, `${id} unturned`);
      assert.equal(shownView({ stored: iso, sceneId: id, suggested: undefined, ready }), isometric(0), `${id} shows at turn 0`);
    }
    let s = iso;
    s = withTurn(s, "a", 1);
    s = withTurn(s, "7", 2);
    s = withTurn(s, "constructor", 3);
    s = withTurn(s, "__proto__", 1);
    assert.deepEqual(ids(s), ["a", "7", "constructor", "__proto__"], "in the order turned");
    assert.equal(shownView({ stored: s, sceneId: "constructor", suggested: undefined, ready }), isometric(3));
    assert.equal(shownView({ stored: s, sceneId: "__proto__", suggested: undefined, ready }), isometric(1));
    assert.equal(shownView({ stored: s, sceneId: "7", suggested: undefined, ready }), isometric(2));
    const back = parseStoredView(serializeStoredView(s));
    assert.deepEqual(back, s, "a reload keeps every turn, in order");
    // At the cap the oldest goes, not the integer-like id the object form would list first.
    let full: typeof s = withTurn(FOLLOW_THE_SCENE, "first", 1);
    full = withTurn(full, "7", 2);
    for (let i = 0; i < MAX_TURNS - 2; i++) full = withTurn(full, `s${i}`, 1);
    full = withTurn(parseStoredView(serializeStoredView(full)), "new", 3);
    assert.ok(!ids(full).includes("first"), "the oldest went");
    assert.equal(turnOf(full, "7"), 2, "the integer-like id stayed");
    // Turns kept as an object read too, own keys only.
    assert.deepEqual(parseStoredView('{"v":1,"turns":{"__proto__":2,"constructor":1}}').turns, [
      ["__proto__", 2],
      ["constructor", 1],
    ]);
  });

  test("a following device switches only once a gesture in progress ends", () => {
    const showing = TOP_DOWN;
    const wanted = isometric(0);
    assert.equal(settledView(showing, wanted, true), showing);
    assert.equal(settledView(showing, wanted, false), wanted);
  });

  test("the stored form is the design's, and whatever cannot be read reads as its default", () => {
    assert.deepEqual(parseStoredView('{"v":1,"pick":"isometric","turns":[["s1",1]]}'), { pick: "isometric", turns: [["s1", 1]] });
    assert.equal(serializeStoredView({ pick: "isometric", turns: [["s1", 1]] }), '{"v":1,"pick":"isometric","turns":[["s1",1]]}');
    assert.equal(serializeStoredView(FOLLOW_THE_SCENE), '{"v":1,"turns":[]}', "no pick: Follow the scene");
    for (const raw of [null, "", "{", "null", "[]", '{"v":2,"pick":"isometric"}', '"isometric"']) assert.deepEqual(parseStoredView(raw), FOLLOW_THE_SCENE, String(raw));
    assert.deepEqual(parseStoredView('{"v":1,"pick":"sideways","turns":[["s1",2],["s2",4],["s3","1"],["s4",1.5],[5,1],["",1],["s5"],"s6"]}'), { pick: null, turns: [["s1", 2]] });
    assert.deepEqual(parseStoredView('{"v":1,"turns":[["a",1],["b",2],["a",3]]}').turns, [["b", 2], ["a", 3]], "a scene named twice keeps its last turn, last");
    assert.deepEqual(parseStoredView('{"v":1,"turns":{"s1":2,"s2":4}}').turns, [["s1", 2]], "turns kept as an object still read");
    const many: [string, Turn][] = [];
    for (let i = 0; i < 150; i++) many.push([`s${i}`, 1]);
    const read = parseStoredView(JSON.stringify({ v: 1, turns: many }));
    assert.equal(read.turns.length, MAX_TURNS);
    assert.equal(read.turns[0]?.[0], "s50", "the oldest went");
  });

  test("a pick survives a reload, reaches every scene of the room, and leaves the display's and another room's alone", async () => {
    stored.clear();
    pickView(viewKey("r1"), "isometric");
    turnView(viewKey("r1"), "s2", 2);
    const page = await reloaded();
    assert.deepEqual(page.readView(page.viewKey("r1")), { pick: "isometric", turns: [["s2", 2]] });
    assert.deepEqual(page.readView(page.displayViewKey("r1")), FOLLOW_THE_SCENE, "the display's is apart");
    assert.deepEqual(page.readView(page.viewKey("r2")), FOLLOW_THE_SCENE, "another room is a separate game");
    pickView(displayViewKey("r1"), "topDown");
    assert.equal(readView(viewKey("r1")).pick, "isometric");
  });

  test("with storage blocked a pick lasts until the page closes, and a fresh page follows the scene", async () => {
    stored.clear();
    blocked = true;
    try {
      const page = await reloaded();
      assert.deepEqual(page.readView(page.viewKey("r3")), FOLLOW_THE_SCENE);
      page.pickView(page.viewKey("r3"), "isometric");
      assert.equal(page.readView(page.viewKey("r3")).pick, "isometric");
      const next = await reloaded();
      assert.deepEqual(next.readView(next.viewKey("r3")), FOLLOW_THE_SCENE);
    } finally {
      blocked = false;
    }
  });
});
