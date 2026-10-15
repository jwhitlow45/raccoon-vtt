import { useSyncExternalStore } from "react";

/**
 * What a ping sounds and feels like (features section 12): a short rising
 * tone through Web Audio, and a buzz on phones that have the Vibration API
 * (Android: iOS Safari has none). Both are feature-detected, and the sound
 * is a per-device preference.
 */

const SOUND_KEY = "rvtt.pingSound";

/*
 * One value for the whole page, read from storage once. The ping tool's
 * "Ping sound" and This device's switch are the same setting
 * (docs/design-v1-visual.md 3.7), so both subscribe to it: a change in one
 * shows in the other while both are on screen, and a tap never flips a
 * stale copy.
 */
const soundListeners = new Set<() => void>();
let soundOn = readSound();

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return soundOn;
}

export function subscribeSound(fn: () => void): () => void {
  soundListeners.add(fn);
  return () => soundListeners.delete(fn);
}

export function usePingSound(): boolean {
  return useSyncExternalStore(subscribeSound, soundEnabled);
}

export function setSoundEnabled(on: boolean): void {
  soundOn = on;
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
  for (const fn of soundListeners) fn();
}

let audio: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    return null;
  }
  return audio;
}

/**
 * Browsers start audio only from a user gesture, so the first tap anywhere
 * on the page creates and resumes the context. Pings from other people that
 * arrive later can then be heard.
 */
export function unlockAudio(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

export function playPing(): void {
  if (!soundEnabled() || document.visibilityState !== "visible") return;
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.3);
}

export function vibrate(ms: number): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(ms);
  } catch {
    // Some browsers refuse without a recent user gesture. The ring still shows.
  }
}
