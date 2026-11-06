import { useSyncExternalStore } from "react";
import { LEAD_MS, type FiredEffect, type Playing, type Sound, type SoundId } from "#shared/sound.ts";
import { api } from "../../../lib/api.ts";
import { useRoomRoleIfAny } from "../../../state/view.ts";
import { roomSoundOnFor, setRoomSoundChoice, useRoomSoundChoice } from "../../device/settings.ts";
import { useDisplaySound } from "../../display/remember.ts";
import { builtinMs } from "./builtins.ts";
import { LISTEN_ELEMENT, soundContext, soundUnlock } from "./context.ts";

/**
 * What Ambiance's Sound, This device and the table display read of room
 * sound on this page (docs/design/design-v1-music.md 4.1 to 4.5), in the
 * main bundle so reading it never loads the engine: the server's switch,
 * what this page does with the room's sound, the music's state, and
 * Listen here.
 */

/** A tiny store with useSyncExternalStore's shape, so one value has one source and every reader follows it. */
class Value<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  constructor(value: T) {
    this.#value = value;
  }
  readonly get = (): T => this.#value;
  readonly set = (next: T): void => {
    if (Object.is(next, this.#value)) return;
    this.#value = next;
    for (const listener of [...this.#listeners]) listener();
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

// ---------------------------------------------------------------- the server's switch

/** The server's switch as this page knows it: not answered yet, on, off, or a read that failed. */
export type ServerSound = "unknown" | "on" | "off" | "failed";

const serverSwitch = new Value<ServerSound>("unknown");
let serverAsked: Promise<boolean> | null = null;

/**
 * Whether the server's owner turned sound files on (ROOM_SOUND, from GET
 * /api/config). Read once a page load. Until it answers the switch is
 * unknown, never off, so Ambiance's Sound never says the server has none
 * while it asks. A failed read says so, and the next call asks again. The
 * promise answers false for anything but on, the safe answer. The built-in
 * effects play either way.
 */
export function serverRoomSound(): Promise<boolean> {
  if (serverAsked) return serverAsked;
  if (serverSwitch.get() === "failed") serverSwitch.set("unknown");
  serverAsked = api.getConfig().then(
    (config) => {
      const on = config.roomSound === true;
      serverSwitch.set(on ? "on" : "off");
      return on;
    },
    () => {
      serverAsked = null;
      serverSwitch.set("failed");
      return false;
    },
  );
  return serverAsked;
}

export const serverSound = serverSwitch.get;

function subscribeServerSwitch(listener: () => void): () => void {
  void serverRoomSound();
  return serverSwitch.subscribe(listener);
}

/**
 * The server's switch: unknown, on, off or failed. The first reader asks
 * the server. Only "off" is the server's own no, so anything that may
 * send a sound file's op goes on unless it is "off", and the server decides.
 */
export function useServerRoomSoundState(): ServerSound {
  return useSyncExternalStore(subscribeServerSwitch, serverSwitch.get, serverSwitch.get);
}

/** Whether the server said it offers sound files: false until it answers on, as it always was. */
export function useServerRoomSound(): boolean {
  return useServerRoomSoundState() === "on";
}

/** Forgets the switch, so a test can answer again. */
export function resetServerRoomSoundForTests(): void {
  serverAsked = null;
  serverSwitch.set("unknown");
}

// ---------------------------------------------------------------- this page's part

/**
 * What this page does with the room's sound: "off" (Room sound off, or a
 * player's not chosen yet), "tap" (on, waiting for a tap the browser
 * counts), "plays", "other" (another window of this browser plays it), or
 * "cannot" (the browser lacks what the mixer needs).
 */
export type SoundHere = "off" | "tap" | "plays" | "other" | "cannot";
/** The music on this page: "loading" only once a track has waited 200 ms. */
export type MusicHere = "none" | "loading" | "failed" | "playing";
export type SoundHereState = { readonly here: SoundHere; readonly music: MusicHere };

const OFF: SoundHereState = { here: "off", music: "none" };
const hereValue = new Value<SoundHereState>(OFF);

export function useSoundHere(): SoundHereState {
  return useSyncExternalStore(hereValue.subscribe, hereValue.get, hereValue.get);
}

export const soundHere = hereValue.get;

/** The engine's and SoundHost's alone. A new object only on a change. */
export function setSoundHere(next: SoundHereState): void {
  const now = hereValue.get();
  if (now.here === next.here && now.music === next.music) return;
  hereValue.set(next);
}

let musicRetry: (() => void) | null = null;

/** Try again for music that did not load on this device. */
export function retryMusic(): void {
  musicRetry?.();
}

/** The engine's alone: what Try again does. */
export function setMusicRetry(fn: (() => void) | null): void {
  musicRetry = fn;
}

/** Whether this page's Room sound is on: a member's choice for its role, or a display's own Sound. */
export function useRoomSoundOn(): boolean {
  const room = useRoomRoleIfAny();
  const choice = useRoomSoundChoice();
  const display = useDisplaySound();
  if (room?.display) return display;
  return roomSoundOnFor(choice, room?.role ?? "player");
}

/**
 * Room sound on or off on this device, from a click. Turning it on unlocks
 * the audio inside that click, since the window's capture listeners ran
 * before the setting changed (4.4), as Play here does.
 */
export function setRoomSound(on: boolean): void {
  setRoomSoundChoice(on ? "on" : "off");
  if (!on) return;
  const ctx = soundContext();
  if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
  void soundUnlock().blessPool();
}

// ---------------------------------------------------------------- what is there to hear

/** A projected effect's length, or null when its sound is not an Effect in the projection. */
export function effectMs(e: FiredEffect, sounds: Readonly<Record<SoundId, Pick<Sound, "ms" | "use">>> | undefined): number | null {
  if (e.builtin) return builtinMs(e.builtin);
  const s = e.soundId && sounds && Object.hasOwn(sounds, e.soundId) ? sounds[e.soundId] : undefined;
  return s && s.use === "effect" ? s.ms : null;
}

/** Whether a projection has anything sounding now: music not paused (a DM's state keeps a paused run), a loop, or an effect not over. */
export function somethingToHear(playing: Playing | null | undefined, sounds: Readonly<Record<SoundId, Pick<Sound, "ms" | "use">>> | undefined, now: number): boolean {
  if (!playing) return false;
  if ((playing.music && playing.music.paused === undefined) || Object.keys(playing.loops).length > 0) return true;
  for (const e of [...playing.effects, ...(playing.dmEffects ?? [])]) {
    const ms = effectMs(e, sounds);
    if (ms !== null && e.at + ms > now) return true;
  }
  return false;
}

/**
 * An entry counts as fired after the load when its op's server time is no
 * earlier than this before the load, so a clock reading a little ahead
 * never takes a fresh effect for an old one.
 */
export const LOAD_SLACK_MS = 1_000;

/** Whether an effect counts as fired after a page loaded, for the ask and for the effects that play (effects.ts). */
export function firedAfter(e: FiredEffect, loadAt: number): boolean {
  return e.at - LEAD_MS >= loadAt - LOAD_SLACK_MS;
}

// ---------------------------------------------------------------- Listen here

type Listening = { readonly soundId: string | null; readonly busy: boolean };
const listeningValue = new Value<Listening>({ soundId: null, busy: false });
let listenHeld: (() => void) | null = null;

export function useListening(): Listening {
  return useSyncExternalStore(listeningValue.subscribe, listeningValue.get, listeningValue.get);
}

/**
 * Listen here, on this device alone (4.1), through the pool's own element.
 * Call it from the click, so the browser lets it play: the element plays
 * at once, busy until it sounds, and Stop or its end lets it go.
 */
export function listenHere(sound: { soundId: string; url: string; level?: number }): void {
  const el = soundUnlock().pool()[LISTEN_ELEMENT] as HTMLAudioElement | undefined;
  if (!el) return;
  // While it sounds its element keeps the sound through a bless, as a voice's does.
  listenHeld ??= soundUnlock().holdWith((held) => held === el && listeningValue.get().soundId !== null);
  el.onplaying = () => listeningValue.set({ soundId: sound.soundId, busy: false });
  el.onended = () => listeningValue.set({ soundId: null, busy: false });
  el.onerror = () => listeningValue.set({ soundId: null, busy: false });
  el.src = sound.url;
  try {
    el.currentTime = 0;
  } catch {
    // Not loaded yet: it starts from 0 anyway.
  }
  // Its level evens loudness only downward here: an element's volume stops at 1.
  el.volume = Math.min(1, 10 ** ((sound.level ?? 0) / 200));
  listeningValue.set({ soundId: sound.soundId, busy: true });
  const played = el.play();
  void Promise.resolve(played).catch(() => listeningValue.set({ soundId: null, busy: false }));
}

export function stopListening(): void {
  const el = soundUnlock().pool()[LISTEN_ELEMENT] as HTMLAudioElement | undefined;
  el?.pause();
  listeningValue.set({ soundId: null, busy: false });
}
