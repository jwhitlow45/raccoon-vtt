import { useCallback, useEffect, useRef, useState } from "react";
import type { Playing } from "#shared/sound.ts";
import { setRoomSoundChoice, useRoomSoundChoice } from "../../device/settings.ts";
import { usePreview } from "../../dm/previewContext.ts";
import { useIsDisplay, useRoomStore, useRoomView } from "../../../state/view.ts";
import { firedAfter, setRoomSound } from "./store.ts";

/**
 * The ask (docs/design/design-v1-music.md 4.4, D-261102-469). On a player's
 * device with no choice, the first confirmed state with something to hear
 * raises "The DM is playing sound for the room." with Play here and Not on
 * this device: at load when something already plays (a late joiner), when
 * music or a loop starts, or when an effect is fired after the page
 * loaded. Passed unanswered, the device stays quiet and does not ask again
 * in that page load: Room sound in the Sound panel or This device turns
 * it on. A state with nothing about sound, while Only DM devices play or
 * behind a blackout, closes an open ask without passing it
 * (docs/design/design-v1-sound-dm-only.md 5), so the device is asked again
 * at the first state after with something to hear, as a late joiner is:
 * music, a loop, or an effect fired after the close.
 */

/** An ask nobody answers passes after this. */
export const ASK_MS = 30_000;

export const ASK_TEXT = "The DM is playing sound for the room.";

/** Rooms whose ask passed in this page load, kept for the page rather than the component, so a remount never asks again. */
const passed = new Set<string>();

export function forgetPassedAsksForTests(): void {
  passed.clear();
}

export type SoundAsk = { asking: boolean; playHere(): void; notHere(): void };

/** Whether a projection has something a player would ask about: music, a loop, or an effect fired after the load and not in the first look. */
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

/** The ask between changes. `closedAt` is the server time an open ask last closed unpassed, null until it does. */
export type AskState = { asking: boolean; closedAt: number | null };

/**
 * The ask after a change, at server time `at`, with the first look at the
 * room (null until there is one). An ask that closed unpassed reopens on
 * music, a loop, or an effect fired after `closedAt`. An effect fired before
 * the close has stopped sounding by then or was withdrawn by EffectPlayer,
 * but the room still lists it, so it would bring back an ask with nothing to
 * hear. Pure.
 */
export function askStep(ask: AskState, now: { eligible: boolean; passed: boolean; playing: Playing | null | undefined; first: { ids: ReadonlySet<string>; at: number } | null; at: number }): AskState {
  const { eligible, passed, playing, first } = now;
  const worthy = first !== null && askWorthy(playing, first.ids, ask.closedAt ?? first.at);
  const asking = askShows(ask.asking, { eligible, passed, playing, worthy });
  const closedUnpassed = ask.asking && eligible && playing === null;
  return { asking, closedAt: closedUnpassed ? now.at : ask.closedAt };
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
  const first = useRef<{ ids: Set<string>; at: number } | null>(null);
  const closedAt = useRef<number | null>(null);
  const [asking, setAsking] = useState(false);

  // A choice made elsewhere (This device, another window) answers it too, as eligible goes false.
  useEffect(() => {
    const offset = store.getState().serverOffset;
    const at = offset === undefined ? Date.now() : performance.now() + offset;
    if (playing !== undefined && first.current === null) first.current = { ids: new Set(playing?.effects.map((e) => e.id) ?? []), at };
    const next = askStep({ asking, closedAt: closedAt.current }, { eligible, passed: passed.has(roomId), playing, first: first.current, at });
    closedAt.current = next.closedAt;
    if (next.asking !== asking) setAsking(next.asking);
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
    setRoomSoundChoice("off");
    setAsking(false);
  }, []);

  return { asking: asking && eligible, playHere, notHere };
}
