import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEAD_MS, type FiredEffect } from "#shared/sound.ts";
import { EffectPlayer, LATE_WHOLE_MS, PARTWAY_LEFT_MS, type DecodedEffect, type EffectEnv, type EffectSound } from "./effects.ts";

/*
 * Effects on a page (docs/design/design-v1-music.md 5.4 and 12): the late
 * rules, the 48 MB budget, a full list with two fires 200 ms apart, a
 * pending load kept while another entry leaves, per-entry cancelling
 * against the engine-wide generation, and an entry withdrawn and brought
 * back, or fired before the load and seen later, never starting.
 */

const MB = 1024 * 1024;

type Started = { id: string | null; asset: string | null; builtin: string | null; at: number; offset: number; stopped: boolean; end: () => void };

function harness(options: { budget?: number } = {}) {
  const w = {
    now: 1_000_000,
    started: [] as Started[],
    decodes: [] as { assetId: string; signal: AbortSignal; resolve(d: DecodedEffect): void; reject(e: unknown): void }[],
    bytes: new Map<string, number>(),
  };
  const env: EffectEnv = {
    serverNow: () => w.now,
    decode: (assetId, signal) =>
      new Promise<DecodedEffect>((resolve, reject) => {
        w.decodes.push({ assetId, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    play: (what, at, offset) => {
      const s: Started = {
        id: null,
        asset: "buffer" in what ? (what.buffer as string) : null,
        builtin: "builtin" in what ? what.builtin : null,
        at,
        offset,
        stopped: false,
        end: () => {},
      };
      w.started.push(s);
      return {
        stop: () => {
          s.stopped = true;
        },
        onEnded: (fn) => {
          s.end = fn;
        },
      };
    },
  };
  const player = new EffectPlayer(env, options);
  const finish = async (assetId: string) => {
    const d = w.decodes.find((x) => x.assetId === assetId && !x.signal.aborted);
    assert.ok(d, `a decode of ${assetId} is in flight`);
    w.decodes.splice(w.decodes.indexOf(d), 1);
    d.resolve({ buffer: assetId, bytes: w.bytes.get(assetId) ?? MB });
    await new Promise((r) => setImmediate(r));
  };
  return { w, player, finish };
}

const SOUNDS: Record<string, EffectSound> = {
  thunder: { assetId: "a-thunder", ms: 25_000 },
  bell: { assetId: "a-bell", ms: 2_000 },
  gong: { assetId: "a-gong", ms: 8_000 },
  door: { assetId: "a-door", ms: 1_500 },
};

function fired(id: string, soundId: string, at: number): FiredEffect {
  return { id, soundId, at };
}

describe("effects on a page", () => {
  test("an effect fired after the load starts at its time, and one ready late by up to a second plays whole", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 5_000;
    player.see([fired("e1", "bell", w.now + LEAD_MS)], SOUNDS);
    await finish("a-bell");
    assert.deepEqual(w.started.map((s) => [s.at, s.offset]), [[w.now + LEAD_MS, 0]]);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("e1", "bell", at - 1_000), fired("e2", "gong", at)], SOUNDS);
    w.now = at + LATE_WHOLE_MS;
    await finish("a-gong");
    assert.deepEqual(w.started.at(-1)!.offset, 0, "whole, late");
    assert.equal(w.started.at(-1)!.at, w.now);
  });

  test("later than a second it starts partway with 3 s left, else it is skipped", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("g", "gong", at), fired("b", "bell", at)], SOUNDS);
    w.now = at + 2_000;
    await finish("a-gong");
    assert.equal(w.started.length, 1);
    assert.equal(w.started[0]!.offset, 2_000, "8 s gong, 6 s left: partway");
    await finish("a-bell");
    assert.equal(w.started.length, 1, "2 s bell, nothing left: skipped");
    const late = harness();
    late.player.setActive(true);
    late.player.see([], SOUNDS);
    late.w.now += 1_000;
    const at2 = late.w.now + LEAD_MS;
    late.player.see([fired("g", "gong", at2)], SOUNDS);
    late.w.now = at2 + SOUNDS.gong!.ms - PARTWAY_LEFT_MS + 1;
    await late.finish("a-gong");
    assert.equal(late.w.started.length, 0, "under 3 s left: skipped");
  });

  test("in the first look, only entries with 3 s or more left start, partway", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    const now = w.now;
    player.see([fired("t", "thunder", now - 10_000), fired("g", "gong", now - 6_000), fired("b", "bell", now - 500)], SOUNDS);
    await finish("a-thunder");
    assert.deepEqual(w.started.map((s) => [s.asset, s.offset]), [["a-thunder", 10_000]]);
    assert.equal(w.decodes.length, 0, "nothing else to load");
  });

  test("an entry withdrawn and brought back, or fired before the load and seen later, never starts", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([fired("old", "door", w.now - 60_000)], SOUNDS);
    w.now += 2_000;
    const at = w.now + LEAD_MS;
    player.see([fired("old", "door", w.now - 62_000), fired("e", "thunder", at)], SOUNDS);
    // Changed to another use before it loaded: it leaves, and Undo brings it back.
    player.see([fired("old", "door", w.now - 62_000)], SOUNDS);
    await new Promise((r) => setImmediate(r));
    player.see([fired("old", "door", w.now - 62_000), fired("e", "thunder", at)], SOUNDS);
    // An entry fired before the load that was hidden at the load (its sound was not an Effect then).
    player.see([fired("old", "door", w.now - 62_000), fired("e", "thunder", at), fired("hidden", "gong", w.now - 4_000)], SOUNDS);
    await new Promise((r) => setImmediate(r));
    assert.equal(w.decodes.filter((d) => !d.signal.aborted).length, 0, "no load for either");
    assert.equal(w.started.length, 0);
    void finish;
  });

  test("a reconnect's cleared store withdraws nothing: the next snapshot's list goes on", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("e", "thunder", at)], SOUNDS);
    // The caller passes no list while the store is cleared, so the player hears nothing of it, and the snapshot has the entry.
    player.see([fired("e", "thunder", at)], SOUNDS);
    await finish("a-thunder");
    assert.equal(w.started.length, 1);
  });

  test("a full list with two fires 200 ms apart: the long effect plays on and its load is untouched", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const thunderAt = w.now + LEAD_MS;
    const list: FiredEffect[] = [fired("thunder", "thunder", thunderAt)];
    player.see(list, SOUNDS);
    for (let i = 0; i < 9; i++) {
      w.now += 200;
      list.push({ id: `b${i}`, builtin: "click", at: w.now + LEAD_MS });
      // The reducer keeps the newest 8 and the ones still sounding: Thunder stays.
      const kept = [list[0]!, ...list.slice(1).slice(-8)];
      player.see(kept, SOUNDS);
    }
    const d = w.decodes.find((x) => x.assetId === "a-thunder")!;
    assert.ok(!d.signal.aborted, "Thunder's load is untouched");
    await finish("a-thunder");
    assert.ok(w.started.some((s) => s.asset === "a-thunder" && !s.stopped));
  });

  test("a pending load is kept while another entry leaves", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("a", "gong", at), fired("b", "thunder", at)], SOUNDS);
    player.see([fired("b", "thunder", at)], SOUNDS);
    await new Promise((r) => setImmediate(r));
    // A's decode went with it, so B's is next and untouched.
    const live = w.decodes.filter((d) => !d.signal.aborted);
    assert.deepEqual(live.map((d) => d.assetId), ["a-thunder"]);
    await finish("a-thunder");
    assert.equal(w.started.length, 1);
  });

  test("an entry leaving stops its voice alone, and Stop all stops every voice and every late load", async () => {
    const { w, player, finish } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("a", "gong", at), fired("b", "thunder", at), { id: "c", builtin: "rumble", at }], SOUNDS);
    await finish("a-gong");
    await finish("a-thunder");
    assert.equal(w.started.length, 3);
    player.see([fired("b", "thunder", at), { id: "c", builtin: "rumble", at }], SOUNDS);
    assert.ok(w.started.find((s) => s.asset === "a-gong")!.stopped, "the gong's entry left");
    assert.ok(!w.started.find((s) => s.asset === "a-thunder")!.stopped);
    assert.ok(!w.started.find((s) => s.builtin === "rumble")!.stopped);
    w.now += 100;
    const later = w.now + LEAD_MS;
    player.see([fired("b", "thunder", at), { id: "c", builtin: "rumble", at }, fired("d", "bell", later)], SOUNDS);
    assert.ok(w.decodes.some((d) => d.assetId === "a-bell"));
    player.stopAll();
    assert.ok(w.started.every((s) => s.stopped), "every voice stopped");
    // The decode in flight answers late: nothing starts.
    const pending = w.decodes.find((d) => d.assetId === "a-bell")!;
    pending.resolve({ buffer: "a-bell", bytes: MB });
    await new Promise((r) => setImmediate(r));
    assert.equal(w.started.length, 3);
  });

  test("decoded effects keep to the budget: the least recently played cached ones go first, then the oldest playing one", async () => {
    const { w, player, finish } = harness({ budget: 30 * MB });
    w.bytes.set("a-thunder", 12 * MB);
    w.bytes.set("a-gong", 12 * MB);
    w.bytes.set("a-bell", 12 * MB);
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    let at = w.now + LEAD_MS;
    player.see([fired("t", "thunder", at)], SOUNDS);
    await finish("a-thunder");
    w.now += 100;
    at = w.now + LEAD_MS;
    player.see([fired("t", "thunder", at - 100), fired("g", "gong", at)], SOUNDS);
    await finish("a-gong");
    assert.equal(player.cachedBytes, 24 * MB);
    // Thunder ends by itself, so its buffer is cached but not playing.
    w.started[0]!.end();
    w.now += 100;
    at = w.now + LEAD_MS;
    player.see([fired("t", "thunder", at - 200), fired("g", "gong", at - 100), fired("b", "bell", at)], SOUNDS);
    await finish("a-bell");
    assert.equal(player.cachedBytes, 24 * MB, "Thunder's cached buffer went");
    assert.ok(!w.started[1]!.stopped, "the playing gong is kept");
    w.bytes.set("a-door", 12 * MB);
    w.now += 100;
    at = w.now + LEAD_MS;
    player.see([fired("g", "gong", at - 200), fired("b", "bell", at - 100), fired("d", "door", at)], SOUNDS);
    await finish("a-door");
    assert.ok(w.started[1]!.stopped, "nothing cached was free, so the oldest playing voice stopped");
    assert.ok(player.cachedBytes <= 30 * MB);
  });

  test("six play at once at most: a seventh stops the oldest", async () => {
    const { w, player } = harness();
    player.setActive(true);
    player.see([], SOUNDS);
    w.now += 1_000;
    const list: FiredEffect[] = [];
    for (let i = 0; i < 7; i++) {
      list.push({ id: `r${i}`, builtin: "rumble", at: w.now + LEAD_MS + i });
      player.see([...list], SOUNDS);
    }
    assert.equal(w.started.length, 7);
    assert.ok(w.started[0]!.stopped);
    assert.equal(player.voices, 6);
  });

  test("a page that is not playing starts nothing, and on starting plays only what still has 3 s left", async () => {
    const { w, player, finish } = harness();
    player.see([], SOUNDS);
    w.now += 1_000;
    const at = w.now + LEAD_MS;
    player.see([fired("t", "thunder", at), fired("b", "bell", at)], SOUNDS);
    assert.equal(w.decodes.length, 0);
    w.now = at + 4_000;
    player.setActive(true);
    await finish("a-thunder");
    assert.deepEqual(w.started.map((s) => [s.asset, s.offset]), [["a-thunder", 4_000]]);
  });
});
