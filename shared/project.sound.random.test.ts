import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { EntityKey } from "./keys.ts";
import type { RoomState, Viewer } from "./model.ts";
import { TRAP_SOUNDS, opSchema, type Op, type OpOf, type RestoreEntry } from "./protocol.ts";
import { allKeys, applyChanges, dependents, diffProjection, heldOf, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { FADES, LEAD_MS, REPEATS, SOUND_USES, musicAt, soundDue, soundStep, type Fade, type Playing, type Repeat, type Sound, type SoundUse } from "./sound.ts";
import { AT, DM, P1, room } from "./testutil.ts";

/**
 * Random sequences of the sound ops through the reducer, with the server's
 * ticks worked out by soundStep at random times from the current
 * `playing.rev` (docs/design/design-v1-music.md 6.2 to 6.5 and section 12).
 * After every op:
 *
 * 1. A player's and a display's projection holds no playlist, no
 *    `dmEffects`, no order, index, label or pause of the run, no scene's
 *    sound, no name for the next track or an effect, no name while the
 *    switch is off, no sound but those of now, next, the loops and the
 *    effects still Effects, and nothing at all behind a blackout. An
 *    effect fired behind a blackout never reaches them, even after it.
 * 2. It is what the table of 6.5 says, read here from the state alone.
 * 3. Each viewer's copy, built by applying every batch's fan-out changes to
 *    their first snapshot, is the fresh projection of the room: the
 *    fan-out misses nothing and sends nothing more.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const OPTS = { sceneId: "s1" };
const BASE = Date.parse(AT);

/** Lengths each use takes (4.1), chosen so a change of use often fits: a 30 s track can be an effect, a 5 s effect background. */
const LENGTHS: Record<SoundUse, readonly number[]> = {
  music: [30_000, 31_000, 40_000, 65_000, 200_000],
  loop: [2_000, 3_000, 20_000, 45_000],
  effect: [200, 1_000, 5_000, 25_000, 30_000],
};

type Act = { gap: number } & (
  | { k: "create"; use: SoundUse; len: number; level: number }
  | { k: "playlist"; pick: number[]; repeat: Repeat; fade: Fade }
  | { k: "playlistEdit"; which: number; pick: number[] }
  | { k: "playlistDelete"; which: number }
  | { k: "play"; which: number; start: number; turn: number; repeat: Repeat; fade: Fade; solo: boolean }
  | { k: "pause" }
  | { k: "resume" }
  | { k: "skip" }
  | { k: "stop" }
  | { k: "set"; repeat: Repeat; fade: Fade }
  | { k: "loopStart"; which: number; volume: number }
  | { k: "loopSet"; which: number; volume: number }
  | { k: "loopStop"; which: number }
  | { k: "fire"; which: number; builtin: boolean }
  | { k: "stopAll" }
  | { k: "use"; which: number; use: SoundUse }
  | { k: "rename"; which: number }
  | { k: "delete"; which: number }
  | { k: "names"; on: boolean }
  | { k: "blackout"; on: boolean }
  | { k: "sceneSound"; which: number; loop: number; music: boolean }
  | { k: "sceneStart" }
  | { k: "undo" }
  | { k: "tick"; due: boolean }
  | { k: "queue"; edit: number; which: number; other: number; seed: string }
  | { k: "jump"; which: number; ms: number; seek: boolean }
);

const n = fc.nat({ max: 999 });
const repeat = fc.constantFrom(...REPEATS);
const fade = fc.constantFrom(...FADES);
const volume = fc.integer({ min: 0, max: 100 });
const gap = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 90_000 }));
const pickOf = fc.array(n, { minLength: 1, maxLength: 4 });

function act<T extends Act["k"]>(k: T, fields: Record<string, fc.Arbitrary<unknown>> = {}): fc.Arbitrary<Act> {
  return fc.record({ gap, k: fc.constant(k), ...fields }) as unknown as fc.Arbitrary<Act>;
}

const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 2, arbitrary: act("create", { use: fc.constantFrom(...SOUND_USES), len: n, level: fc.constantFrom(0, -35, 60) }) },
  { weight: 1, arbitrary: act("playlist", { pick: pickOf, repeat, fade }) },
  { weight: 1, arbitrary: act("playlistEdit", { which: n, pick: pickOf }) },
  { weight: 1, arbitrary: act("playlistDelete", { which: n }) },
  { weight: 4, arbitrary: act("play", { which: n, start: n, turn: n, repeat, fade, solo: fc.boolean() }) },
  { weight: 2, arbitrary: act("pause") },
  { weight: 2, arbitrary: act("resume") },
  { weight: 2, arbitrary: act("skip") },
  { weight: 1, arbitrary: act("stop") },
  { weight: 2, arbitrary: act("set", { repeat, fade }) },
  { weight: 3, arbitrary: act("loopStart", { which: n, volume }) },
  { weight: 1, arbitrary: act("loopSet", { which: n, volume }) },
  { weight: 1, arbitrary: act("loopStop", { which: n }) },
  { weight: 4, arbitrary: act("fire", { which: n, builtin: fc.boolean() }) },
  { weight: 1, arbitrary: act("stopAll") },
  { weight: 5, arbitrary: act("use", { which: n, use: fc.constantFrom(...SOUND_USES) }) },
  { weight: 1, arbitrary: act("rename", { which: n }) },
  { weight: 1, arbitrary: act("delete", { which: n }) },
  { weight: 2, arbitrary: act("names", { on: fc.boolean() }) },
  { weight: 2, arbitrary: act("blackout", { on: fc.boolean() }) },
  { weight: 1, arbitrary: act("sceneSound", { which: n, loop: n, music: fc.boolean() }) },
  { weight: 1, arbitrary: act("sceneStart") },
  { weight: 2, arbitrary: act("undo") },
  { weight: 10, arbitrary: act("tick", { due: fc.boolean() }) },
  // The queue's edits and jumps (docs/design/design-v1-music-player.md 6.6), on the DM's view of the run.
  { weight: 10, arbitrary: act("queue", { edit: fc.nat({ max: 6 }), which: n, other: n, seed: fc.constantFrom("a", "mix1", "Zx-9_q") }) },
  { weight: 4, arbitrary: act("jump", { which: n, ms: fc.integer({ min: 0, max: 210_000 }), seek: fc.boolean() }) },
);

/** Counters for fresh ids, and the Setup steps an Undo can take back, the newest last. */
type World = { state: RoomState; clock: number; seq: number; next: number; undo: RestoreEntry[][] };

function idsOf(state: RoomState, use?: SoundUse): string[] {
  return Object.values(state.sounds ?? {})
    .filter((s) => use === undefined || s.use === use)
    .map((s) => s.id)
    .sort();
}

function chosen<T>(items: readonly T[], i: number): T | undefined {
  return items.length === 0 ? undefined : items[i % items.length];
}

function rotated<T>(items: readonly T[], by: number): T[] {
  const k = items.length === 0 ? 0 : by % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/** The op an action makes in this state, with the time it runs at, or null when it has nothing to act on. */
function opFor(w: World, a: Act): { op: Op; at: number } | null {
  const s = w.state;
  let at = w.clock + a.gap;
  const fresh = (prefix: string) => `${prefix}${w.next++}`;
  const playlists = Object.keys(s.playlists ?? {}).sort();
  const loops = Object.keys(s.playing?.loops ?? {}).sort();
  const music = idsOf(s, "music");
  const op = ((): Op | null => {
    switch (a.k) {
      case "create": {
        const id = fresh("x");
        return { t: "sound.create", id, assetId: `file-${id}`, name: `Sound ${id}`, use: a.use, ms: chosen(LENGTHS[a.use], a.len)!, ...(a.level !== 0 ? { level: a.level } : {}) };
      }
      case "playlist":
        return { t: "playlist.create", id: fresh("p"), name: "List", sounds: [...new Set(a.pick.map((i) => chosen(music, i)).filter((id) => id !== undefined))], repeat: a.repeat, fade: a.fade };
      case "playlistEdit": {
        const id = chosen(playlists, a.which);
        return id === undefined ? null : { t: "playlist.update", id, sounds: [...new Set(a.pick.map((i) => chosen(music, i)).filter((x) => x !== undefined))] };
      }
      case "playlistDelete": {
        const id = chosen(playlists, a.which);
        return id === undefined ? null : { t: "playlist.delete", id };
      }
      case "play": {
        if (a.solo) {
          const id = chosen(music, a.which);
          return id === undefined ? null : { t: "music.play", run: fresh("r"), soundId: id, order: [id], repeat: a.repeat, fade: a.fade };
        }
        const id = chosen(playlists, a.which);
        const tracks = id === undefined ? [] : s.playlists![id]!.sounds;
        if (id === undefined || tracks.length === 0) return null;
        return { t: "music.play", run: fresh("r"), playlistId: id, order: rotated(tracks, a.turn), index: a.start % tracks.length, repeat: a.repeat, fade: a.fade };
      }
      case "pause":
        return { t: "music.pause" };
      case "resume":
        return { t: "music.resume", run: fresh("r") };
      case "skip":
        return { t: "music.skip", run: fresh("r") };
      case "stop":
        return { t: "music.stop" };
      case "set":
        return { t: "music.set", repeat: a.repeat, fade: a.fade };
      case "loopStart": {
        const id = chosen(idsOf(s, "loop"), a.which);
        return id === undefined ? null : { t: "loop.start", id: fresh("l"), soundId: id, volume: a.volume };
      }
      case "loopSet": {
        const id = chosen(loops, a.which);
        return id === undefined ? null : { t: "loop.set", id, volume: a.volume };
      }
      case "loopStop": {
        const id = chosen(loops, a.which);
        return id === undefined ? null : { t: "loop.stop", id };
      }
      case "fire": {
        const id = a.builtin ? undefined : chosen(idsOf(s, "effect"), a.which);
        return id === undefined ? { t: "effect.fire", id: fresh("e"), builtin: chosen(TRAP_SOUNDS, a.which)! } : { t: "effect.fire", id: fresh("e"), soundId: id };
      }
      case "stopAll":
        return { t: "sound.stopAll" };
      case "use": {
        const id = chosen(idsOf(s), a.which);
        return id === undefined ? null : { t: "sound.update", id, use: a.use };
      }
      case "rename": {
        const id = chosen(idsOf(s), a.which);
        return id === undefined ? null : { t: "sound.update", id, name: fresh("Renamed ") };
      }
      case "delete": {
        const id = chosen(idsOf(s), a.which);
        return id === undefined ? null : { t: "sound.delete", id };
      }
      case "names":
        return { t: "room.update", settings: { soundNames: a.on } };
      case "blackout":
        return { t: "view.blackout", blackout: a.on };
      case "sceneSound": {
        const list = chosen(playlists, a.which);
        const loop = chosen(idsOf(s, "loop"), a.loop);
        const sceneMusic = a.music && list !== undefined ? { playlistId: list, repeat: "all" as const, fade: 5 as const } : null;
        return { t: "scene.update", sceneId: "s1", patch: { sound: { music: sceneMusic, loops: loop === undefined ? [] : [{ soundId: loop, volume: 40 }] } } };
      }
      case "sceneStart": {
        const wanted = s.scenes.s1?.sound?.music;
        const order = wanted?.playlistId !== undefined ? (s.playlists?.[wanted.playlistId]?.sounds ?? []) : wanted?.soundId !== undefined ? [wanted.soundId] : [];
        return { t: "sound.scene", sceneId: "s1", run: fresh("r"), order: [...order] };
      }
      case "undo": {
        const entries = w.undo.pop();
        return entries === undefined ? null : { t: "sys.restore", entries, from: "undo", deps: true };
      }
      case "queue":
      case "jump": {
        const view = musicAt(s.playing?.music ?? null, s.sounds ?? {}, at + LEAD_MS);
        if (!view) return null;
        const order = view.order ?? [];
        if (a.k === "jump") {
          const soundId = a.seek ? view.now.soundId : chosen(order, a.which)!;
          return { t: "music.jump", run: fresh("r"), from: view.run, soundId, ...(a.seek ? { ms: a.ms, on: soundId } : {}) };
        }
        const one = chosen(order, a.which)!;
        const edits: OpOf<"music.queue">["edit"][] = [
          { t: "next", soundIds: [...new Set([chosen(music, a.which), chosen(music, a.other)].filter((id) => id !== undefined))] },
          { t: "add", soundIds: [...new Set([chosen(music, a.which), chosen(music, a.other)].filter((id) => id !== undefined))] },
          { t: "move", soundId: one, to: chosen(["first", "passEnd", "last"] as const, a.other)! },
          { t: "move", soundId: one, to: { before: chosen(order, a.other)! } },
          { t: "remove", soundId: one },
          { t: "shuffle", seed: a.seed },
          { t: "unshuffle" },
        ];
        const edit = edits[a.edit]!;
        return "soundIds" in edit && edit.soundIds.length === 0 ? null : { t: "music.queue", from: view.run, edit };
      }
      case "tick": {
        // The actor's timer fires at the due time, or the tick runs late after a gap, from the state it reads then (6.4).
        if (!s.playing?.music) return null;
        const due = soundDue(s.playing, s.sounds ?? {});
        const t = a.due && due !== null ? Math.max(at, due) : at;
        const step = soundStep(s.playing, s.sounds ?? {}, t);
        if (!step.changed) return null;
        at = t;
        return { t: "sys.sound", from: s.playing.rev, music: step.music as OpOf<"sys.sound">["music"] };
      }
    }
  })();
  return op === null ? null : { op, at };
}

// Invariant 2, the table of 6.5 read from the state alone, apart from shared/project.ts.

const SOUND_FIELDS = new Set(["id", "rev", "assetId", "ms", "use", "level", "name"]);
const MUSIC_FIELDS = new Set(["run", "repeat", "fade", "now", "next"]);

function expectedFor(state: RoomState): { playing: Playing | null; sounds: Record<string, Sound> } {
  const playing = state.playing;
  if (!playing || state.meta.view?.blackout === true) return { playing: null, sounds: {} };
  const library = state.sounds ?? {};
  const isA = (id: string | undefined, use: SoundUse) => id !== undefined && Object.hasOwn(library, id) && library[id]!.use === use;
  const m = playing.music;
  const music = m && m.paused === undefined && isA(m.now.soundId, "music") ? { run: m.run, repeat: m.repeat, fade: m.fade, now: m.now, ...(m.next && isA(m.next.soundId, "music") ? { next: m.next } : {}) } : null;
  const loops = Object.fromEntries(Object.entries(playing.loops).filter(([, l]) => isA(l.soundId, "loop")));
  const effects = playing.effects.filter((e) => e.builtin !== undefined || isA(e.soundId, "effect"));
  const shared = state.meta.settings.soundNames === true;
  const named = new Map<string, boolean>();
  const name = (id: string, shown: boolean) => named.set(id, (named.get(id) ?? false) || shown);
  if (music) {
    name(music.now.soundId, shared);
    if (music.next) name(music.next.soundId, false);
  }
  for (const loop of Object.values(loops)) name(loop.soundId, shared);
  for (const e of effects) if (e.soundId !== undefined) name(e.soundId, false);
  const sounds: Record<string, Sound> = {};
  for (const [id, shown] of named) {
    const s = library[id]!;
    sounds[id] = { id, rev: 0, assetId: s.assetId, ms: s.ms, use: s.use, ...(s.level !== undefined ? { level: s.level } : {}), ...(shown && s.name !== undefined ? { name: s.name } : {}) };
  }
  return { playing: { rev: 0, music, loops, effects, volume: playing.volume }, sounds };
}

/** Invariant 1, each rule on its own, so a failure says which one broke. */
function checkPlayer(state: RoomState, view: ProjectedState, hidden: ReadonlySet<string>, where: string): void {
  assert.ok(!("playlists" in view), `${where}: a playlist`);
  for (const scene of Object.values(view.scenes)) assert.ok(!("sound" in scene), `${where}: a scene's sound`);
  if (state.meta.view?.blackout === true) {
    // A copy built from changes holds `playing: null` and `sounds: {}` where a snapshot has neither (normalized).
    assert.equal(view.playing ?? null, null, `${where}: playing behind a blackout`);
    assert.deepEqual(Object.keys(view.sounds ?? {}), [], `${where}: a sound behind a blackout`);
    return;
  }
  const p = view.playing;
  if (p) {
    assert.ok(!("dmEffects" in p), `${where}: dmEffects`);
    assert.equal(p.rev, 0, `${where}: a rev`);
    for (const k of Object.keys(p.music ?? {})) assert.ok(MUSIC_FIELDS.has(k), `${where}: the run's ${k}`);
    if (state.playing?.music?.paused !== undefined) assert.equal(p.music, null, `${where}: a paused run`);
    for (const e of p.effects) assert.ok(!hidden.has(e.id), `${where}: ${e.id}, fired behind a blackout`);
  }
  const shared = state.meta.settings.soundNames === true;
  const now = p?.music?.now.soundId;
  const loops = new Set(Object.values(p?.loops ?? {}).map((l) => l.soundId));
  const library = state.sounds ?? {};
  const isEffect = (id: string) => Object.hasOwn(library, id) && library[id]!.use === "effect";
  const live = new Set([now, p?.music?.next?.soundId, ...loops, ...(state.playing?.effects ?? []).flatMap((e) => (e.soundId !== undefined && isEffect(e.soundId) ? [e.soundId] : []))]);
  for (const [id, sound] of Object.entries(view.sounds ?? {})) {
    assert.ok(live.has(id), `${where}: ${id} is not now, next, a loop or a live effect`);
    assert.deepEqual(Object.keys(sound).filter((k) => !SOUND_FIELDS.has(k)), [], `${where}: ${id}'s fields`);
    assert.equal(sound.rev, 0, `${where}: ${id}'s rev`);
    assert.equal(sound.name !== undefined, shared && (id === now || loops.has(id)), `${where}: ${id}'s name`);
  }
  const expected = expectedFor(state);
  assert.deepEqual(view.playing ?? null, expected.playing, `${where}: playing`);
  assert.deepEqual(view.sounds ?? {}, expected.sounds, `${where}: sounds`);
}

// Invariant 3, the fan-out as server/rooms/fanout.ts publishBatch runs it for a batch with no sight or log ring change.

type Conn = { viewer: Viewer; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function candidates(before: RoomState, r: Applied): EntityKey[] {
  if (r.global) return [...new Set([...allKeys(before), ...allKeys(r.state)])].sort();
  return [...new Set([...r.touched, ...dependents(before, r.touched, r.state), ...dependents(r.state, r.touched, before)])].sort();
}

/** A copy built from changes holds `playing: null` and an empty `sounds` where a fresh snapshot leaves the field out (keys.ts writeEntity), which read the same. */
function normalized(view: ProjectedState): string {
  const { sounds, playlists, playing, ...rest } = view;
  return stableStringify({
    ...rest,
    ...(sounds && Object.keys(sounds).length > 0 ? { sounds } : {}),
    ...(playlists && Object.keys(playlists).length > 0 ? { playlists } : {}),
    ...(playing ? { playing } : {}),
  });
}

/** Undo setup takes back these, the ops of 6.6 that record a step. */
const SETUP = new Set(["sound.update", "playlist.create", "playlist.update", "playlist.delete", "scene.update", "room.update"]);

function library(lengths: { music: number[]; loop: number[]; effect: number[] }): World {
  const w: World = { state: room({ playing: null }), clock: BASE, seq: 0, next: 0, undo: [] };
  const apply = (op: Op) => {
    const r = applyOp(w.state, op, DM, { seq: ++w.seq, at: new Date(w.clock).toISOString() });
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    w.state = r.state;
  };
  for (const use of SOUND_USES) {
    lengths[use].forEach((i, k) => apply({ t: "sound.create", id: `${use}${k}`, assetId: `file-${use}${k}`, name: `${use} ${k}`, use, ms: chosen(LENGTHS[use], i)! }));
  }
  apply({ t: "playlist.create", id: "p0", name: "Tavern night", sounds: idsOf(w.state, "music"), repeat: "all", fade: 5 });
  return w;
}

const START = fc.record({
  music: fc.array(n, { minLength: 1, maxLength: 3 }),
  loop: fc.array(n, { minLength: 1, maxLength: 2 }),
  effect: fc.array(n, { minLength: 1, maxLength: 2 }),
});

test("a player's projection and the fan-out keep every sound rule of 6.5 over random sequences of ops and ticks", () => {
  let applied = 0;
  let ticks = 0;
  let reveals = 0;
  let hiddenFires = 0;
  let reclassified = 0;
  let undone = 0;
  let queued = 0;
  fc.assert(
    fc.property(START, fc.array(ACT, { minLength: 10, maxLength: 60, size: "max" }), (start, acts) => {
      const w = library(start);
      const conns: Conn[] = [DM, P1, DISPLAY].map((viewer) => {
        const view = projectState(w.state, viewer, OPTS);
        return { viewer, held: heldOf(view), view };
      });
      // Effects fired behind a blackout: they stay the DM's for good (4.6).
      const hidden = new Set<string>();
      for (const [i, a] of acts.entries()) {
        const made = opFor(w, a);
        if (made === null) continue;
        const parsed = opSchema.safeParse(made.op);
        assert.ok(parsed.success, `act ${i}: the generator made an invalid ${made.op.t}: ${parsed.success ? "" : parsed.error.message}`);
        const before = w.state;
        const r = applyOp(before, parsed.data, DM, { seq: ++w.seq, at: new Date(made.at).toISOString() });
        w.clock = made.at;
        if (!r.ok) continue;
        applied++;
        if (made.op.t === "sys.sound") {
          ticks++;
          if (r.state.playing?.music?.next && !before.playing?.music?.next) reveals++;
        }
        if (made.op.t === "effect.fire" && before.meta.view?.blackout === true) {
          hidden.add(made.op.id);
          hiddenFires++;
        }
        const op = made.op;
        if (op.t === "sound.update" && op.use !== undefined && before.playing?.effects.some((e) => e.soundId === op.id)) reclassified++;
        if (op.t === "sys.restore") undone++;
        if (op.t === "music.queue" || op.t === "music.jump") {
          queued++;
          // An edit or a jump gives players a next no more than 20 s before its start, or at the start they already held.
          const had = projectState(before, P1, OPTS).playing?.music?.next;
          const next = projectState(r.state, P1, OPTS).playing?.music?.next;
          if (next !== undefined && (had?.soundId !== next.soundId || had.at !== next.at)) {
            assert.ok(next.at - (made.at + LEAD_MS) <= 20_000 || next.at === had?.at, `act ${i} (${op.t}): players get the next track ${next.at - made.at - LEAD_MS} ms before it starts`);
          }
        }
        if (SETUP.has(op.t) && r.inverse) w.undo.push(r.inverse);
        w.state = r.state;
        const where = `act ${i} (${made.op.t})`;
        const keyed = candidates(before, r);
        for (const c of conns) {
          const next = new Map<EntityKey, unknown>();
          for (const key of keyed) next.set(key, projectEntity(key, r.state, c.viewer, OPTS));
          const diff = diffProjection(c.held, next);
          c.held = diff.held;
          c.view = applyChanges(c.view, diff.changes);
          const fresh = projectState(r.state, c.viewer, OPTS);
          if (normalized(c.view) !== normalized(fresh)) assert.deepEqual(JSON.parse(normalized(c.view)), JSON.parse(normalized(fresh)), `${where}: ${c.viewer.memberId}'s copy is the fresh projection`);
          assert.deepEqual([...c.held.keys()].sort(), [...heldOf(c.view).keys()].sort(), `${where}: ${c.viewer.memberId}'s held map is its copy's`);
          if (c.viewer.role === "player") {
            checkPlayer(r.state, fresh, hidden, `${where} for ${c.viewer.memberId}`);
            checkPlayer(r.state, c.view, hidden, `${where} for ${c.viewer.memberId}'s copy`);
          }
        }
      }
    }),
    { numRuns: 500 },
  );
  // The generator reaches the paths that matter, so the invariants hold over something.
  assert.ok(applied > 3_000, `only ${applied} ops applied`);
  assert.ok(ticks > 250 && reveals > 50, `${ticks} ticks, ${reveals} reveals`);
  assert.ok(hiddenFires > 50, `${hiddenFires} effects fired behind a blackout`);
  assert.ok(reclassified > 30 && undone > 100, `${reclassified} fired effects given another use, ${undone} undos`);
  assert.ok(queued > 600, `${queued} queue edits and jumps`);
});
