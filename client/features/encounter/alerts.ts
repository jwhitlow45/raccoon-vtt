import { useSyncExternalStore } from "react";

/**
 * How a turn banner gets attention beyond the screen (design section 14.4).
 * Android phones vibrate. iOS Safari has no Vibration API, so iPhones get
 * the banner and, when this device has sound on, a short chime.
 *
 * The chime is synthesized with Web Audio rather than shipped as a file, so
 * there is no audio asset to license. Browsers start an AudioContext
 * suspended until the person taps something, so turning sound on is itself
 * a tap that unlocks it, and after a reload the first tap anywhere does.
 */

const SOUND_KEY = "rvtt.sound";

const soundListeners = new Set<() => void>();

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

let soundOn = readSound();

/*
 * Another tab that changes the setting writes storage, and the browser
 * tells this tab with a `storage` event, so the cached value and the
 * switches follow it, as the ping sound's do (features/pings/feedback.ts).
 * A null key means that tab cleared storage, which puts the default back.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== SOUND_KEY && e.key !== null) return;
    const next = e.newValue === "on";
    if (next === soundOn) return;
    soundOn = next;
    for (const fn of soundListeners) fn();
  });
}

export function isSoundOn(): boolean {
  return soundOn;
}

export function subscribeSoundOn(fn: () => void): () => void {
  soundListeners.add(fn);
  return () => soundListeners.delete(fn);
}

export function useSoundOn(): boolean {
  return useSyncExternalStore(subscribeSoundOn, isSoundOn);
}

/** Call from a tap, so the browser lets the audio start. */
export function setSoundOn(on: boolean): void {
  soundOn = on;
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Private mode or storage full: the setting lasts until the page closes.
  }
  for (const fn of soundListeners) fn();
  if (on) playChime("soft");
}

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  if (audio) return audio;
  const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    return null;
  }
  return audio;
}

/**
 * Resumes the audio on the first tap after the page opens, when sound is
 * on. Returns the cleanup for an effect.
 */
export function unlockAudioOnTap(): () => void {
  const unlock = () => {
    if (!soundOn) return;
    const ctx = context();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    window.removeEventListener("pointerdown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  return () => window.removeEventListener("pointerdown", unlock, true);
}

/** Two rising notes for your turn, one soft note to confirm sound is on. */
function playChime(kind: "yours" | "soft"): void {
  const ctx = context();
  if (!ctx) return;
  if (ctx.state !== "running") void ctx.resume().catch(() => {});
  const notes = kind === "yours" ? [660, 880] : [660];
  const start = ctx.currentTime + 0.02;
  notes.forEach((frequency, i) => {
    const at = start + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    // A quick attack and an exponential fade, so the note never clicks.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(kind === "yours" ? 0.25 : 0.15, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.32);
  });
}

/** Banner side effects: vibrate where the browser can, and chime when this device has sound on. */
export function announceTurn(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate([120, 80, 120]);
    } catch {
      // Some browsers throw when the page has not been tapped yet.
    }
  }
  if (soundOn) playChime("yours");
}
