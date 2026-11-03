import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { FADES, REPEATS, fadeMs, following, lengthAs, musicChanged, occurrencesAt, playingAt, soundDue, soundStep, type MusicChange, type MusicRun, type Playing, type SoundLengths } from "./sound.ts";

/**
 * The server's music schedule (docs/design/design-v1-sound.md 6.3, 6.4 and
 * section 12): random playlists, lengths, crossfades and repeats, with
 * pauses, resumes, skips and changes of repeat or crossfade at random
 * times, and ticks at their due times and late. Invariants:
 *
 * 1. Many steps come to the same as one step at the last.
 * 2. A tick's reveal at its due time comes 10 to 20 s before the track starts.
 * 3. No track leaves while it sounds: a tick moves `now` on, or ends the run, only once its track has ended.
 * 4. `next` is the track after `now` in the order, under the run's repeat.
 * 5. A run ends only with Repeat off past its last track.
 * 6. An op during a crossfade acts on the track sounding then, never the outgoing one.
 * 7. A change of repeat or crossfade keeps the place heard, a pause keeps it, and a resume goes on from it.
 * 8. An op never places `next` before its own time.
 * 9. After a step, the next due time lies in the future.
 */

const T0 = 1_800_000_000_000;

const trackMs = fc.oneof(fc.integer({ min: 30_000, max: 15 * 60_000 + 100 }), fc.constantFrom(30_000, 30_100, 45_000));
const library = fc.array(trackMs, { minLength: 1, maxLength: 6 }).map((lengths) => {
  const sounds: Record<string, { ms: number; use: "music" }> = {};
  lengths.forEach((ms, i) => (sounds[`s${i}`] = { ms, use: "music" }));
  return { sounds: sounds as SoundLengths, order: lengths.map((_, i) => `s${i}`) };
});

type Action = { kind: "due" } | { kind: "late"; gap: number; hops: number[] } | { kind: "op"; gap: number; change: MusicChange };

const change: fc.Arbitrary<MusicChange> = fc.oneof(
  fc.constant<MusicChange>({ t: "pause" }),
  fc.constant<MusicChange>({ t: "resume", run: "r" }),
  fc.constant<MusicChange>({ t: "skip", run: "r" }),
  fc.record({ t: fc.constant("set" as const), repeat: fc.constantFrom(...REPEATS), fade: fc.constantFrom(...FADES) }, { requiredKeys: ["t"] }),
);
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Action>({ kind: "due" }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("late" as const), gap: fc.integer({ min: 0, max: 20 * 60_000 }), hops: fc.array(fc.integer({ min: 0, max: 5 * 60_000 }), { maxLength: 4 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("op" as const), gap: fc.oneof(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 0, max: 15 * 60_000 })), change }) },
);

function playing(music: MusicRun | null): Playing {
  return { rev: 1, music, loops: {}, effects: [], volume: { music: 80, effects: 80 } };
}

function stepped(music: MusicRun | null, sounds: SoundLengths, t: number): MusicRun | null {
  if (music === null) return null;
  const step = soundStep(playing(music), sounds, t);
  return step.changed ? step.music : music;
}

/** Invariant 4, and that `index` names `now`. */
function wellPlaced(music: MusicRun | null): void {
  if (music === null) return;
  assert.equal(music.order![music.index!], music.now.soundId, "index names now");
  if (music.next === undefined) return;
  assert.notEqual(music.repeat, "one", "Repeat one reveals no next");
  assert.equal(music.paused, undefined, "a paused run reveals no next");
  const j = following(music);
  assert.notEqual(j, null);
  assert.equal(music.order![j!], music.next.soundId, "now and next are neighbors in the order");
}

/** The newest occurrence's place in the track sounding at `t`. */
function heard(music: MusicRun, sounds: SoundLengths, t: number): { soundId: string; positionMs: number } | null {
  const at = playingAt(music, t);
  const ms = lengthAs(sounds, at.soundId, "music")!;
  const crossing = music.repeat === "one" && at === music.now ? fadeMs(music) : null;
  const o = occurrencesAt(at.at, ms, crossing, t).at(-1);
  return o ? { soundId: at.soundId, positionMs: o.positionMs } : null;
}

test("the music schedule: random playlists, ops and ticks keep every invariant", () => {
  fc.assert(
    fc.property(library, fc.constantFrom(...REPEATS), fc.constantFrom(...FADES), fc.array(action, { minLength: 10, maxLength: 60 }), ({ sounds, order }, repeat, fade, actions) => {
      let t = T0;
      let music: MusicRun | null = { run: "r0", order, index: 0, repeat, fade, now: { soundId: order[0]!, at: t } };
      for (const a of actions) {
        if (music === null) break;
        if (a.kind === "due") {
          const due = soundDue(playing(music), sounds);
          if (due === null) continue;
          assert.ok(due >= t - 0 || due < t, "a due time is a number");
          const at = Math.max(due, t);
          const before: MusicRun = music;
          const step = soundStep(playing(before), sounds, at);
          assert.ok(step.changed, "a step at its due time changes something");
          const after = step.changed ? step.music : before;
          if (after === null) {
            // 3 and 5: a run ends with Repeat off past its last track, once that track ended.
            assert.equal(before.repeat, "off");
            assert.equal(before.index, order.length - 1);
            assert.ok(at >= before.now.at + lengthAs(sounds, before.now.soundId, "music")!);
          } else if (after.now.soundId !== before.now.soundId || after.now.at !== before.now.at) {
            // 3: promoted only once the outgoing track has ended.
            assert.ok(at >= before.now.at + lengthAs(sounds, before.now.soundId, "music")!, "no track leaves while sounding");
            assert.deepEqual(after.now, before.next, "the revealed track becomes now");
          } else if (before.next === undefined && after.next !== undefined && due >= t) {
            // 2: a tick's reveal at its due time.
            const lead = after.next.at - due;
            assert.ok(lead >= 10_000 && lead <= 20_000, `revealed ${lead} ms before its start`);
          }
          music = after;
          t = at;
        } else if (a.kind === "late") {
          // 1: many steps at the last equal one, a late one included.
          const times = [t + a.gap];
          for (const hop of a.hops) times.push(times.at(-1)! + hop);
          const end = times.at(-1)!;
          let many: MusicRun | null = music;
          for (const at of times) many = stepped(many, sounds, at);
          const one = stepped(music, sounds, end);
          assert.deepEqual(many, one, "many steps equal one step at the last");
          music = one;
          t = end;
        } else {
          const at = t + a.gap;
          const caught = stepped(music, sounds, at);
          const before = caught === null ? null : heard(caught, sounds, at);
          const after = musicChanged(music, a.change, sounds, at);
          if (after !== null && after.next !== undefined && a.change.t !== "pause") {
            // 8: an op places next at its own time or later, unless the schedule placed it, which a step's catch-up did.
            const placedByOp = caught === null || caught.next === undefined || caught.next.at !== after.next.at || caught.next.soundId !== after.next.soundId;
            if (placedByOp) assert.ok(after.next.at >= at, "an op never places next before t");
          }
          if (after !== null && caught !== null && before !== null) {
            const sounding = playingAt(caught, at);
            if (a.change.t === "pause" && caught.paused === undefined) {
              // 6 and 7: the pause keeps the incoming track's place, never the outgoing one's.
              assert.equal(after.now.soundId, sounding.soundId);
              assert.equal(after.paused, Math.floor(before.positionMs));
            }
            if (a.change.t === "set" && caught.paused === undefined) {
              assert.equal(after.now.soundId, sounding.soundId, "a set acts on the track sounding at t");
              const ms = lengthAs(sounds, after.now.soundId, "music")!;
              const places = occurrencesAt(after.now.at, ms, after.repeat === "one" ? fadeMs(after) : null, at).map((o) => o.positionMs);
              assert.ok(places.includes(before.positionMs), "the place heard goes on");
            }
            if (a.change.t === "skip") {
              const j = order.indexOf(sounding.soundId) + 1;
              if (j < order.length || caught.repeat !== "off") assert.equal(after.now.soundId, order[j % order.length], "a skip goes past the track sounding at t");
              assert.equal(after.now.at, at);
            }
          }
          if (a.change.t === "resume" && caught?.paused !== undefined && after !== null) {
            const ms = lengthAs(sounds, after.now.soundId, "music")!;
            // A crossfade changed while paused may put the place in a crossing, where the next pass starts fading in beside it.
            const places = occurrencesAt(after.now.at, ms, after.repeat === "one" ? fadeMs(after) : null, at).map((o) => o.positionMs);
            assert.ok(places.includes(caught.paused), "a resume goes on from the pause");
          }
          music = after;
          t = at;
        }
        wellPlaced(music);
        // 9: what is due next lies after now.
        const due = music === null ? null : soundDue(playing(music), sounds);
        if (due !== null && a.kind !== "op") assert.ok(due > t, "the due time lies in the future after a step");
      }
    }),
    { numRuns: 3_000 },
  );
});
