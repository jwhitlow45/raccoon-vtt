import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "./model.ts";
import { opSchema, type Op, type OpOf } from "./protocol.ts";
import { projectState } from "./project.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { SOUND_WORDS } from "./reducer/sound.ts";
import { FADES, LEAD_MS, REPEATS, following, musicAt, seededShuffle, soundDue, soundStep, type Fade, type MusicRun, type Playing, type Repeat, type Sound, type SoundLengths } from "./sound.ts";
import { AT, DM, P1, room } from "./testutil.ts";

/**
 * The queue's state machine (docs/design/design-v1-music-player.md 6.4 and
 * 11.1) through the reducer: random plays, ticks at their due times and
 * late, pauses, resumes, skips, changes of repeat or crossfade, deletes,
 * and queue edits and jumps each made on the DM's view a random lag
 * behind, as two DMs or a slow round trip make them. After every op:
 *
 * 1. The order holds no id twice and 1 to 100 ids.
 * 2. `index` points at the playing track, which is in the order.
 * 3. `next`, when present, is the track `following` names, and an edit or
 *    a jump places it at or after the op's time.
 * 4. An edit acts on the track musicAt names at its time, under the run it
 *    was made on, and keeps that track playing.
 * 5. A shuffle keeps the same ids, and Repeat off's never moves a heard
 *    track ahead of the playing one. So does Shuffle off.
 * 6. The same edit again at once changes nothing the first did not.
 * 7. Many ticks come to the same as one tick at the last.
 * 8. A player's projection never holds `order`, `index`, `shuffle`,
 *    `playlistId` or `paused`, and an edit or a jump that gives players a
 *    new `next` gives it no more than 20 s before its start, or at the
 *    start they already held.
 */

const BASE = Date.parse(AT);
const LENGTHS = [30_000, 31_000, 40_000, 65_000, 200_000] as const;
const OPTS = { sceneId: "s1" };

type EditPick =
  | { t: "next" | "add"; picks: number[] }
  | { t: "move"; pick: number; to: "first" | "passEnd" | "last" | "before"; before: number }
  | { t: "remove"; pick: number }
  | { t: "shuffle"; seed: string }
  | { t: "unshuffle" };

type Act = { gap: number } & (
  | { k: "tick"; due: boolean }
  | { k: "late"; hops: number[] }
  | { k: "play"; start: number; repeat: Repeat; fade: Fade; shuffle: boolean; seed: string }
  | { k: "pause" }
  | { k: "resume" }
  | { k: "skip" }
  | { k: "set"; repeat: Repeat; fade: Fade }
  | { k: "edit"; lag: number; edit: EditPick }
  | { k: "jump"; lag: number; kind: "now" | "seek" | "previous"; pick: number; ms: number }
  | { k: "delete"; pick: number }
  | { k: "playlistDelete" }
);

const n = fc.nat({ max: 999 });
const seed = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
const gap = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 40_000 }), fc.integer({ min: 0, max: 240_000 }));
const repeat = fc.constantFrom(...REPEATS);
const fade = fc.constantFrom(...FADES);

const EDIT: fc.Arbitrary<EditPick> = fc.oneof(
  fc.record({ t: fc.constantFrom("next" as const, "add" as const), picks: fc.array(n, { minLength: 1, maxLength: 4 }) }),
  { weight: 3, arbitrary: fc.record({ t: fc.constant("move" as const), pick: n, to: fc.constantFrom("first" as const, "passEnd" as const, "last" as const, "before" as const), before: n }) },
  fc.record({ t: fc.constant("remove" as const), pick: n }),
  fc.record({ t: fc.constant("shuffle" as const), seed }),
  fc.constant<EditPick>({ t: "unshuffle" }),
);

function act<T extends Act["k"]>(k: T, fields: Record<string, fc.Arbitrary<unknown>> = {}): fc.Arbitrary<Act> {
  return fc.record({ gap, k: fc.constant(k), ...fields }) as unknown as fc.Arbitrary<Act>;
}

const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 6, arbitrary: act("tick", { due: fc.boolean() }) },
  { weight: 1, arbitrary: act("late", { hops: fc.array(fc.integer({ min: 0, max: 5 * 60_000 }), { maxLength: 4 }) }) },
  { weight: 2, arbitrary: act("play", { start: n, repeat, fade, shuffle: fc.boolean(), seed }) },
  { weight: 1, arbitrary: act("pause") },
  { weight: 1, arbitrary: act("resume") },
  { weight: 1, arbitrary: act("skip") },
  { weight: 1, arbitrary: act("set", { repeat, fade }) },
  { weight: 10, arbitrary: act("edit", { lag: fc.nat({ max: 3 }), edit: EDIT }) },
  { weight: 4, arbitrary: act("jump", { lag: fc.nat({ max: 3 }), kind: fc.constantFrom("now" as const, "seek" as const, "previous" as const), pick: n, ms: fc.integer({ min: 0, max: 210_000 }) }) },
  { weight: 1, arbitrary: act("delete", { pick: n }) },
  { weight: 1, arbitrary: act("playlistDelete") },
);

/** The library: tracks t0 and on in the playlist, e0 and on outside it, and one background sound no edit may add. */
const LIBRARY = fc.record({ listed: fc.array(n, { minLength: 1, maxLength: 8 }), extra: fc.array(n, { minLength: 1, maxLength: 3 }), repeat, fade });

type World = { state: RoomState; clock: number; seq: number; next: number; history: { state: RoomState; clock: number }[] };

/** The world with the playlist playing from its first track, so most acts have a run to act on. */
function start(lib: { listed: number[]; extra: number[]; repeat: Repeat; fade: Fade }): World {
  const sounds: Record<string, Sound> = { rain: { id: "rain", rev: 0, name: "Rain", assetId: "file-rain", ms: 30_000, use: "loop" } };
  const track = (id: string, i: number) => (sounds[id] = { id, rev: 0, name: `Track ${id}`, assetId: `file-${id}`, ms: LENGTHS[i % LENGTHS.length]!, use: "music" });
  lib.listed.forEach((i, k) => track(`t${k}`, i));
  lib.extra.forEach((i, k) => track(`e${k}`, i));
  const listed = lib.listed.map((_, k) => `t${k}`);
  const empty = room({ sounds, playlists: { p: { id: "p", rev: 0, name: "Tavern night", sounds: listed, repeat: "all", fade: 5 } }, playing: null });
  const played = applyOp(empty, { t: "music.play", run: "r", playlistId: "p", order: listed, repeat: lib.repeat, fade: lib.fade }, DM, { seq: 1, at: AT });
  assert.ok(played.ok);
  return { state: played.state, clock: BASE, seq: 1, next: 0, history: [{ state: played.state, clock: BASE }] };
}

function musicIds(state: RoomState): string[] {
  return Object.values(state.sounds ?? {})
    .filter((s) => s.use === "music")
    .map((s) => s.id)
    .sort();
}

function pick<T>(items: readonly T[], i: number): T | undefined {
  return items.length === 0 ? undefined : items[i % items.length];
}

/** The DM's view `lag` ops behind, and the run it shows then: musicAt at that view's time, as Now playing reads it. */
function viewOf(w: World, lag: number): MusicRun | null {
  const seen = w.history[Math.max(0, w.history.length - 1 - lag)]!;
  return musicAt(seen.state.playing?.music ?? null, seen.state.sounds ?? {}, seen.clock + LEAD_MS);
}

function queueEditOf(w: World, view: MusicRun, e: EditPick): OpOf<"music.queue">["edit"] | null {
  const order = view.order ?? [];
  switch (e.t) {
    case "next":
    case "add": {
      const ids = [...new Set(e.picks.map((i) => pick(musicIds(w.state), i)).filter((id) => id !== undefined))];
      return ids.length === 0 ? null : { t: e.t, soundIds: ids };
    }
    case "move": {
      const soundId = pick(order, e.pick)!;
      return { t: "move", soundId, to: e.to === "before" ? { before: pick(order, e.before)! } : e.to };
    }
    case "remove":
      return { t: "remove", soundId: pick(order, e.pick)! };
    case "shuffle":
      return { t: "shuffle", seed: e.seed };
    case "unshuffle":
      return { t: "unshuffle" };
  }
}

/** The op an act makes, at the world's clock moved on by its gap, or null when it has nothing to act on. */
function opFor(w: World, a: Act): { op: Op; at: number } | null {
  let at = w.clock + a.gap;
  const s = w.state;
  const fresh = () => `r${w.next++}`;
  const op = ((): Op | null => {
    switch (a.k) {
      case "tick": {
        const playing = s.playing;
        if (!playing?.music) return null;
        const due = soundDue(playing, s.sounds ?? {});
        if (a.due && due !== null) at = Math.max(w.clock, due);
        const step = soundStep(playing, s.sounds ?? {}, at);
        return step.changed ? { t: "sys.sound", from: playing.rev, music: step.music as OpOf<"sys.sound">["music"] } : null;
      }
      case "late":
        return null;
      case "play": {
        const listed = s.playlists?.p?.sounds ?? [];
        if (listed.length === 0) {
          const id = pick(musicIds(s), a.start);
          return id === undefined ? null : { t: "music.play", run: fresh(), soundId: id, order: [id], repeat: a.repeat, fade: a.fade };
        }
        const order = a.shuffle ? seededShuffle(listed, a.seed) : [...listed];
        return { t: "music.play", run: fresh(), playlistId: "p", order, index: a.start % order.length, repeat: a.repeat, fade: a.fade, ...(a.shuffle ? { shuffle: true as const } : {}) };
      }
      case "pause":
        return { t: "music.pause" };
      case "resume":
        return { t: "music.resume", run: fresh() };
      case "skip":
        return { t: "music.skip", run: fresh() };
      case "set":
        return { t: "music.set", repeat: a.repeat, fade: a.fade };
      case "edit": {
        const view = viewOf(w, a.lag);
        const edit = view && queueEditOf(w, view, a.edit);
        return view && edit ? { t: "music.queue", from: view.run, edit } : null;
      }
      case "jump": {
        const view = viewOf(w, a.lag);
        if (!view) return null;
        const order = view.order ?? [];
        const index = view.index ?? 0;
        if (a.kind === "now") return { t: "music.jump", run: fresh(), from: view.run, soundId: pick(order, a.pick)! };
        if (a.kind === "seek") return { t: "music.jump", run: fresh(), from: view.run, soundId: view.now.soundId, ms: a.ms, on: view.now.soundId };
        return { t: "music.jump", run: fresh(), from: view.run, soundId: order[(index + order.length - 1) % order.length]!, on: view.now.soundId };
      }
      case "delete": {
        const id = pick(musicIds(s), a.pick);
        return id === undefined ? null : { t: "sound.delete", id };
      }
      case "playlistDelete":
        return s.playlists?.p ? { t: "playlist.delete", id: "p" } : null;
    }
  })();
  return op === null ? null : { op, at };
}

/** The refusals a random sequence may meet, each a rule's own words. */
const ALLOWED = new Set<string>([...Object.values(SOUND_WORDS), "sound is not here", "playlist is not here"]);

const SECRET_FIELDS = ["order", "index", "shuffle", "playlistId", "paused"];

function wellFormed(music: MusicRun | null, where: string): void {
  if (music === null) return;
  const order = music.order ?? [];
  assert.ok(order.length >= 1 && order.length <= 100, `${where}: 1 to 100 ids`);
  assert.equal(new Set(order).size, order.length, `${where}: no id twice`);
  assert.equal(order[music.index ?? -1], music.now.soundId, `${where}: index names the playing track`);
  if (music.next === undefined) return;
  assert.notEqual(music.repeat, "one", `${where}: Repeat one reveals no next`);
  assert.equal(music.paused, undefined, `${where}: a paused run reveals no next`);
  assert.equal(order[following(music) ?? -1], music.next.soundId, `${where}: next is the track following names`);
}

/** Many steps at their own times come to one step at the last (invariant 7). */
function stepped(playing: Playing, sounds: SoundLengths, times: number[]): MusicRun | null {
  let p = playing;
  for (const t of times) {
    const step = soundStep(p, sounds, t);
    if (step.changed) p = { ...p, music: step.music };
  }
  return p.music;
}

test("the queue: random edits and jumps on views a random lag behind, among ticks and the other music ops, keep every invariant", () => {
  let edits = 0;
  let jumps = 0;
  let swapsInWindow = 0;
  let stale = 0;
  let movedOn = 0;
  let shuffles = 0;
  let repeats = 0;
  fc.assert(
    fc.property(LIBRARY, fc.array(ACT, { minLength: 10, maxLength: 60 }), (lib, acts) => {
      const w = start(lib);
      for (const [i, a] of acts.entries()) {
        if (a.k === "late") {
          const playing = w.state.playing;
          if (!playing?.music) continue;
          const times = [w.clock + a.gap];
          for (const hop of a.hops) times.push(times.at(-1)! + hop);
          const sounds = w.state.sounds ?? {};
          const one = soundStep(playing, sounds, times.at(-1)!);
          assert.deepEqual(stepped(playing, sounds, times), one.changed ? one.music : playing.music, `act ${i}: many ticks equal one`);
          continue;
        }
        const made = opFor(w, a);
        if (made === null) continue;
        const parsed = opSchema.safeParse(made.op);
        assert.ok(parsed.success, `act ${i}: the generator made an invalid ${made.op.t}: ${parsed.success ? "" : parsed.error.message}`);
        const op = parsed.data;
        const before = w.state;
        const env = { seq: ++w.seq, at: new Date(made.at).toISOString() };
        const r = applyOp(before, op, DM, env);
        w.clock = made.at;
        const where = `act ${i} (${op.t}${op.t === "music.queue" ? ` ${op.edit.t}` : ""})`;
        if (!r.ok) {
          assert.ok(ALLOWED.has(r.message), `${where}: refused in no rule's words: ${r.message}`);
          if (r.message === SOUND_WORDS.musicChanged) stale++;
          if (r.message === SOUND_WORDS.musicMovedOn) movedOn++;
          continue;
        }
        w.state = r.state;
        w.history.push({ state: r.state, clock: made.at });
        const music = r.state.playing?.music ?? null;
        wellFormed(music, where);
        const t = op.t === "sys.sound" ? made.at : made.at + LEAD_MS;
        const current = musicAt(before.playing?.music ?? null, before.sounds ?? {}, t);
        if (op.t === "music.queue" || op.t === "music.jump") {
          if (op.t === "music.queue") edits++;
          else jumps++;
          assert.ok(music !== null && current !== null, `${where}: the run goes on`);
          if (music.next !== undefined && (r.touched.length > 0)) assert.ok(music.next.at >= t || music.next.at === current.next?.at, `${where}: next placed before the op's time`);
          if (op.t === "music.queue" && r.touched.length > 0) {
            // 4: on the track playing at t, under the run it was made on.
            assert.equal(music.run, op.from);
            assert.deepEqual(music.now, current.now, `${where}: the playing track goes on`);
            if (op.edit.t === "shuffle" || op.edit.t === "unshuffle") {
              shuffles++;
              assert.deepEqual([...music.order!].sort(), [...current.order!].sort(), `${where}: the same ids`);
              if (music.repeat === "off") assert.deepEqual(music.order!.slice(0, music.index! + 1), current.order!.slice(0, current.index! + 1), `${where}: nothing heard moves`);
              if (op.edit.t === "shuffle") assert.equal(music.index, current.index, `${where}: Shuffle on keeps the playing track's place`);
            }
            if (current.next !== undefined && music.next !== undefined && music.next.soundId !== current.next.soundId) {
              swapsInWindow++;
              assert.equal(music.next.at, current.next.at, `${where}: a swap keeps the start`);
            }
            // 6: the same edit again at once changes nothing more, while the same track plays. An edit that places next at
            // its own time starts the crossfade then, and the incoming track is the playing one from that moment on.
            if (musicAt(music, r.state.sounds ?? {}, t)!.now.soundId === music.now.soundId) {
              const again = applyOp(r.state, op, DM, { seq: ++w.seq, at: env.at });
              assert.ok(!again.ok || (again as Applied).touched.length === 0, `${where}: the same edit again wrote ${again.ok ? again.touched.join(", ") : ""}`);
              repeats++;
            }
          }
        }
        // 8: what players get.
        const shown = projectState(r.state, P1, OPTS).playing?.music ?? null;
        if (shown !== null) {
          for (const field of SECRET_FIELDS) assert.ok(!(field in shown), `${where}: players get ${field}`);
          const had = projectState(before, P1, OPTS).playing?.music ?? null;
          const placed = shown.next !== undefined && (had?.next === undefined || had.next.soundId !== shown.next.soundId || had.next.at !== shown.next.at);
          if (placed && (op.t === "music.queue" || op.t === "music.jump")) {
            assert.ok(shown.next!.at - t <= 20_000 || shown.next!.at === had?.next?.at, `${where}: players get the next track ${shown.next!.at - t} ms before it starts`);
          }
        }
      }
    }),
    { numRuns: 3_000 },
  );
  // The generator reaches the paths that matter, so the invariants hold over something.
  assert.ok(edits > 5_000 && jumps > 2_000 && repeats > 3_000, `${edits} edits, ${jumps} jumps, ${repeats} repeated`);
  assert.ok(shuffles > 800, `${shuffles} shuffles`);
  assert.ok(swapsInWindow > 150, `${swapsInWindow} swaps of a revealed next`);
  assert.ok(stale > 4_000 && movedOn > 200, `${stale} stale edits, ${movedOn} seeks on a track that moved on`);
});
