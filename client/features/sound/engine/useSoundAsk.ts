import { useCallback, useEffect, useRef, useState } from "react";
import type { Playing } from "#shared/sound.ts";
import { setRoomSoundChoice, useRoomSoundChoice } from "../../device/settings.ts";
import { usePreview } from "../../dm/previewContext.ts";
import { useIsDisplay, useRoomStore, useRoomView } from "../../../state/view.ts";
import { firedAfter, setRoomSound } from "./store.ts";

/**
 * The ask (docs/design/design-v1-music.md 4.4, D-261102-469). On a player's
 * device with no choice, the first confirmed state with something to hear
 * raises "The DM is playing sound for the room." with Play here, which
 * unmutes, and Stay muted (docs/design/design-v1-volume.md 5): at load when
 * something already plays (a late joiner), when music or a loop starts, or
 * when an effect is fired after the page loaded. Passed unanswered, the
 * device stays muted and does not ask again in that page load: the top
 * bar's speaker, This device or the Sound panel unmutes it. A state with
 * nothing about sound, while Only DM devices play or behind a blackout,
 * closes an open ask without passing it
 * (docs/design/design-v1-sound-dm-only.md 5), so the device is asked again
 * at the first state after with something to hear, as a late joiner is:
 * music, a loop, or an effect fired after the close.
 */

/** The ask's Stay muted: a choice made, so it never asks again, and the level kept for an unmute later. */
export function stayMuted(): void {
  setRoomSoundChoice("off");
}

/** An ask nobody answers passes after this. */
export const ASK_MS = 30_000;

export const ASK_TEXT = "The DM is playing sound for the room.";

/** Rooms whose ask passed in this page load, kept for the page rather than the component, so a remount never asks again. */
const passed = new Set<string>();

export function forgetPassedAsksForTests(): void {
  passed.clear();
}

export type SoundAsk = { asking: boolean; playHere(): void; notHere(): void };

/** Whether a projection has something a player would ask about: music, a loop, or an effect fired after the load (or an unpassed close) and not listed in the look then. */
export function askWorthy(playing: Playing | null | undefined, firstIds: ReadonlySet<string> | null, loadAt: number): boolean {
  if (!playing) return false;
  if (playing.music || Object.keys(playing.loops).length > 0) return true;
  if (firstIds === null) return false;
  return playing.effects.some((e) => !firstIds.has(e.id) && firedAfter(e, loadAt));
}

/**
 * Whether the ask shows after a change, from whether it shows now. A device
 * that is no longer eligible (a choice made here or elsewhere) has its
 * answer. An open ask stays until the state holds nothing about sound
 * (`playing` null), and then closes without passing, since its timer is
 * what passes it. A closed one opens on a state with something to hear,
 * unless it passed in this page load. Undefined, a reconnect's cleared
 * store, keeps an open ask. Pure.
 */
export function askShows(asking: boolean, now: { eligible: boolean; passed: boolean; playing: Playing | null | undefined; worthy: boolean }): boolean {
  if (!now.eligible) return false;
  if (asking) return now.playing !== null;
  return !now.passed && now.worthy;
}

/** A look at the room: the effects it listed, and from when, in server ms, an effect not among them counts as fired after it. */
export type AskLook = { ids: ReadonlySet<string>; at: number };

/**
 * The ask between changes. `listed` is the effects of the last state that
 * held a `playing`. `closed` is the last time an open ask closed unpassed,
 * with the effects listed until then, null until it does.
 */
export type AskState = { asking: boolean; listed: ReadonlySet<string>; closed: AskLook | null };

export const ASK_START: AskState = { asking: false, listed: new Set(), closed: null };

/**
 * The ask after a change, at server time `at`, with the first look at the
 * room (null until there is one). An ask that closed unpassed reopens on
 * music, a loop, or an effect fired after the close and not listed in the
 * last state before it. An effect fired before the close has stopped
 * sounding by then or was withdrawn by EffectPlayer, but the room still
 * lists it, so it would bring back an ask with nothing to hear. The time
 * alone cannot tell it from a fresh one: firedAfter's slack for a clock a
 * little ahead counts one fired up to a second before the close
 * (DMUSBUILD-SOL-01). Pure.
 */
export function askStep(ask: AskState, now: { eligible: boolean; passed: boolean; playing: Playing | null | undefined; first: AskLook | null; at: number }): AskState {
  const { eligible, passed, playing, first } = now;
  const since = ask.closed ?? first;
  const worthy = since !== null && askWorthy(playing, since.ids, since.at);
  const asking = askShows(ask.asking, { eligible, passed, playing, worthy });
  const closedUnpassed = ask.asking && eligible && playing === null;
  const closed = closedUnpassed ? { at: now.at, ids: ask.listed } : ask.closed;
  return { asking, listed: playing ? new Set(playing.effects.map((e) => e.id)) : ask.listed, closed };
}

export function useSoundAsk(): SoundAsk {
  const preview = usePreview() !== null;
  const display = useIsDisplay();
  const role = useRoomView((s) => s.you?.role ?? "player");
  const roomId = useRoomView((s) => s.roomId);
  const choice = useRoomSoundChoice();
  const playing = useRoomView((s): Playing | null | undefined => (s.confirmed ? (s.confirmed.playing ?? null) : undefined));
  const store = useRoomStore();
  const eligible = !preview && !display && role === "player" && choice === null;
  // The first look at the room: what played then counts for a late joiner, and an effect fired before it never asks.
  const first = useRef<AskLook | null>(null);
  const between = useRef<Omit<AskState, "asking">>(ASK_START);
  const [asking, setAsking] = useState(false);

  // A choice made elsewhere (This device, another window) answers it too, as eligible goes false.
  useEffect(() => {
    const offset = store.getState().serverOffset;
    const at = offset === undefined ? Date.now() : performance.now() + offset;
    if (playing !== undefined && first.current === null) first.current = { ids: new Set(playing?.effects.map((e) => e.id) ?? []), at };
    const { asking: next, ...kept } = askStep({ ...between.current, asking }, { eligible, passed: passed.has(roomId), playing, first: first.current, at });
    between.current = kept;
    if (next !== asking) setAsking(next);
  }, [playing, eligible, asking, roomId, store]);

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => {
      passed.add(roomId);
      setAsking(false);
    }, ASK_MS);
    return () => clearTimeout(timer);
  }, [asking, roomId]);

  const playHere = useCallback(() => {
    // The window's capture listeners ran before the setting changed, so this click unlocks by itself (MUS-OPUS-67).
    setRoomSound(true);
    setAsking(false);
  }, []);

  const notHere = useCallback(() => {
    stayMuted();
    setAsking(false);
  }, []);

  return { asking: asking && eligible, playHere, notHere };
}
