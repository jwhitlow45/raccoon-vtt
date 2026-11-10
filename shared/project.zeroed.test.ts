import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fogRoom, lift, remember } from "./discoveryTestutil.ts";
import { keys, readEntity } from "./keys.ts";
import type { Label, RoomState, Stamp, Viewer } from "./model.ts";
import { allKeys, hashValue, projectEntity, projectState, rankedStamp, stampOrder } from "./project.ts";
import { DM, P1, P2, randomState, rng, room, scene } from "./testutil.ts";

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

/** Every `rev` anywhere in a value, with where it sits. */
function revsIn(value: unknown, at = "", out: [string, unknown][] = []): [string, unknown][] {
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if (k === "rev") out.push([at, v]);
    revsIn(v, `${at}.${k}`, out);
  }
  return out;
}

/** The room with every entity of every collection, and each single value, given a rev past 0, as a room that has been played in holds them. */
function written(state: RoomState, r: () => number): RoomState {
  const out: Record<string, unknown> = {};
  const bump = (v: unknown) => (v !== null && typeof v === "object" && "rev" in v ? { ...v, rev: 1 + Math.floor(r() * 50) } : v);
  for (const [field, value] of Object.entries(state)) {
    if (value === null || typeof value !== "object") out[field] = value;
    else if (Array.isArray(value)) out[field] = value.map(bump);
    else if ("rev" in value) out[field] = bump(value);
    else out[field] = Object.fromEntries(Object.entries(value).map(([id, v]) => [id, bump(v)]));
  }
  return out as unknown as RoomState;
}

function stamp(id: string, z: number, more: Partial<Stamp> = {}): Stamp {
  return { id, rev: 0, sceneId: "s1", art: { key: "chest" }, x: 3.5, y: 3.5, w: 1, h: 1, rotation: 0, z, visibility: "all", ...more };
}

describe("a player's copy carries rev 0", () => {
  test("every rev in a player's or a table display's copy is 0, snapshot and single entities alike, and the DM's are as stored", () => {
    let nonzero = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed);
      const state = written(randomState(r), r);
      for (const viewer of [P1, P2, DISPLAY]) {
        const p = projectState(state, viewer, { sceneId: "s2" });
        assert.deepEqual(revsIn(p).filter(([, v]) => v !== 0), [], `seed ${seed} ${viewer.memberId} snapshot`);
        for (const key of allKeys(state)) assert.deepEqual(revsIn(projectEntity(key, state, viewer, { sceneId: "s2" })).filter(([, v]) => v !== 0), [], `seed ${seed} ${viewer.memberId} ${key}`);
      }
      const dm = projectState(state, DM, { sceneId: "s2" });
      nonzero += revsIn(dm).filter(([, v]) => v !== 0).length;
      for (const [id, label] of Object.entries(state.labels)) if (label.sceneId === "s2") assert.equal(dm.labels[id], label, `seed ${seed} the DM's label ${id}`);
    }
    assert.ok(nonzero > 1000, `only ${nonzero} revs past 0 in the DM's copies`);
  });

  test("a zeroed value is the same object every time and hashes once, and the snapshot holds that same object", () => {
    const state = room();
    const label: Label = { id: "l1", rev: 7, sceneId: "s1", x: 2.5, y: 2.5, text: "Hall", size: 1 };
    state.labels.l1 = label;
    const a = projectEntity(keys.label("l1"), state, P1, { sceneId: null }) as Label;
    const b = projectEntity(keys.label("l1"), state, P1, { sceneId: null }) as Label;
    assert.equal(a.rev, 0);
    assert.equal(a, b, "one copy per source");
    assert.equal(projectState(state, P1, { sceneId: null }).labels.l1, a, "the snapshot's copy is the same object");
    assert.equal(hashValue(a), hashValue({ ...label, rev: 0 }));
    // A new source, as the reducer writes one, makes a new copy, and a hidden edit's rev alone changes nothing a player gets.
    state.labels = { l1: { ...label, rev: 8 } };
    const c = projectEntity(keys.label("l1"), state, P1, { sceneId: null }) as Label;
    assert.notEqual(c, a);
    assert.equal(hashValue(c), hashValue(a));
    assert.equal(projectEntity(keys.label("l1"), state, DM, { sceneId: "s1" }), state.labels.l1, "the DM's is the stored label");
  });
});

describe("a player's stamps carry their rank", () => {
  test("projectEntity alone gives a player rank 0, whatever the stored z, and the DM the stored z", () => {
    for (const z of [0, 1, 7, -3, 999_999]) {
      const state = room();
      state.stamps.st1 = stamp("st1", z, { rev: 4 });
      const p = projectEntity(keys.stamp("st1"), state, P1, { sceneId: null }) as Stamp;
      assert.equal(p.z, 0, `stored z ${z}`);
      assert.equal(p.rev, 0);
      assert.equal(stampOrder(p), z, "the order stays on the server");
      assert.equal((projectEntity(keys.stamp("st1"), state, DM, { sceneId: "s1" }) as Stamp).z, z);
    }
  });

  test("hidden stamps between shown ones leave the shown ones ranked 0 to n - 1, as in a room without them", () => {
    const plain = room();
    const busy = room();
    const shown = [stamp("a", 2), stamp("b", 5, { x: 6.5 }), stamp("c", 9, { x: 9.5 })];
    for (const st of shown) plain.stamps[st.id] = busy.stamps[st.id] = st;
    for (const [k, z] of [1, 3, 4, 6, 7, 8, 10].entries()) busy.stamps[`h${k}`] = stamp(`h${k}`, z, { visibility: "dm" });
    for (const viewer of [P1, DISPLAY]) {
      const a = projectState(plain, viewer, { sceneId: null }).stamps;
      const b = projectState(busy, viewer, { sceneId: null }).stamps;
      assert.deepEqual(b, a, viewer.memberId);
      assert.deepEqual(Object.values(b).map((st) => [st.id, st.z]), [["a", 0], ["b", 1], ["c", 2]]);
    }
    assert.deepEqual(projectState(busy, DM, { sceneId: "s1" }).stamps.b, shown[1], "the DM's are stored");
  });

  test("ties in the stored z rank by id, and each scene ranks on its own", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) } });
    state.stamps = { b: stamp("b", 4), a: stamp("a", 4), c: stamp("c", 1), d: stamp("d", 0, { sceneId: "s2" }) };
    const p = projectState(state, P1, { sceneId: null }).stamps;
    assert.deepEqual([p.c?.z, p.a?.z, p.b?.z], [0, 1, 2]);
  });

  test("a copy at the same rank is the same object, and a copy ranked again names its source's order", () => {
    const source = stamp("st1", 12, { rev: 3 });
    const one = rankedStamp(source, 1);
    assert.equal(rankedStamp(source, 1), one);
    assert.equal(rankedStamp(rankedStamp(source, 0), 1), one, "ranked from another copy");
    assert.equal(stampOrder(one), 12);
    assert.equal(one.z, 1);
    assert.equal(one.rev, 0);
  });

  test("a remembered stamp the live build lost ranks by the z it was remembered with", () => {
    const state = fogRoom({ vision: true });
    lift(state, "party", { x: 0, y: 0, w: 10, h: 10 });
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 2 });
    // Shown live, in their live ground along the top rows.
    state.stamps.live = stamp("live", 5, { x: 5.5, y: 0.5 });
    remember(state, null, 0, 0, { stamps: { gone: stamp("gone", 8) } });
    const p = projectState(state, P1, { sceneId: "s1" }).stamps;
    assert.deepEqual([p.live?.z, p.gone?.z], [0, 1]);
    // The DM's live build reorders and then deletes nothing the memory holds: the remembered order still ranks it.
    remember(state, null, 0, 0, { stamps: { gone: stamp("gone", 2) } });
    const q = projectState(state, P1, { sceneId: "s1" }).stamps;
    assert.deepEqual([q.live?.z, q.gone?.z], [1, 0]);
  });

  test("a remembered stamp whose live one moved on ranks by the remembered z, not the live one", () => {
    const state = fogRoom({ vision: true });
    lift(state, "party", { x: 0, y: 0, w: 10, h: 10 });
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 2 });
    state.stamps.live = stamp("live", 5, { x: 5.5, y: 0.5 });
    // Out of their sight the DM brought the crate to the front, at 50, and they remember it at 1.
    state.stamps.crate = stamp("crate", 50);
    remember(state, null, 0, 0, { stamps: { crate: stamp("crate", 1) } });
    const p = projectState(state, P1, { sceneId: "s1" }).stamps;
    assert.deepEqual([p.crate?.z, p.live?.z], [0, 1]);
  });

  test("on a scene seen per player two holders who remember one stamp at different orders each rank by their own memory", () => {
    const state = fogRoom({ vision: true, perPlayer: true });
    state.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
    lift(state, "dm", { x: 0, y: 0, w: 10, h: 2 });
    lift(state, { holder: "p1" }, { x: 0, y: 0, w: 10, h: 10 });
    lift(state, { holder: "p2" }, { x: 0, y: 0, w: 10, h: 10 });
    state.stamps.live = stamp("live", 5, { x: 5.5, y: 0.5 });
    remember(state, "p1", 0, 0, { stamps: { gone: stamp("gone", 9) } });
    remember(state, "p2", 0, 0, { stamps: { gone: stamp("gone", 1) } });
    const p1 = projectState(state, P1, { sceneId: "s1" }).stamps;
    const p2 = projectState(state, P2, { sceneId: "s1" }).stamps;
    assert.deepEqual([p1.live?.z, p1.gone?.z], [0, 1], "p1 remembers it above");
    assert.deepEqual([p2.gone?.z, p2.live?.z], [0, 1], "p2 remembers it below");
    assert.equal(readEntity(state, keys.stamp("gone")), null, "only memory names it");
  });
});
