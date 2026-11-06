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
 * in that page load: Room sound in Ambiance's Sound or This device turns
 * it on.
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
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (playing === undefined) return;
    if (first.current === null) {
      const offset = store.getState().serverOffset;
      first.current = { ids: new Set(playing?.effects.map((e) => e.id) ?? []), at: offset === undefined ? Date.now() : performance.now() + offset };
    }
    if (!eligible || asking || passed.has(roomId)) return;
    if (askWorthy(playing, first.current.ids, first.current.at)) setAsking(true);
  }, [playing, eligible, asking, roomId, store]);

  // A choice made elsewhere (This device, another window) answers it too.
  useEffect(() => {
    if (asking && !eligible) setAsking(false);
  }, [asking, eligible]);

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
