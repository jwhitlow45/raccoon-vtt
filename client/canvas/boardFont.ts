import { useSyncExternalStore } from "react";
import { INTER_FAMILY } from "../lib/interFont.ts";

/**
 * Which load of the interface font the board's text is drawn and measured
 * in. A canvas neither waits for a web font nor draws again when one
 * arrives: text drawn before Inter loads stays in the fallback font, and
 * the widths measured then (where labels go, how wide a pill is) stay the
 * fallback's. So each time Inter's roman face finishes loading the count
 * moves on, measureText.ts drops the widths it holds, and Stage.tsx lays
 * the board's text out again and mounts its stage anew, as it does for a
 * new interface size, so Konva measures and draws every text in Inter.
 *
 * index.html preloads the font, so on most loads it is in before the room's
 * code runs and the count never moves. The face is asked for here too: a
 * canvas alone does not always make the browser fetch it, and the table
 * display may have no other text in Inter on screen.
 */

let epoch = 0;
const listeners = new Set<() => void>();

function bump(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function isInterRoman(face: FontFace): boolean {
  return face.family.replace(/["']/g, "") === INTER_FAMILY && face.style === "normal";
}

if (typeof document !== "undefined" && "fonts" in document) {
  document.fonts.addEventListener("loadingdone", (event) => {
    if ((event as FontFaceSetLoadEvent).fontfaces.some(isInterRoman)) bump();
  });
  // A failed load leaves the fallback drawing, which the board already measured in.
  document.fonts.load(`16px ${INTER_FAMILY}`).catch(() => {});
}

/** The current count, for code that caches what it measured. */
export function boardFontEpoch(): number {
  return epoch;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The count as React state, so a component lays its text out again when Inter arrives. */
export function useBoardFontEpoch(): number {
  return useSyncExternalStore(subscribe, boardFontEpoch, boardFontEpoch);
}
