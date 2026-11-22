import { isCoarsePointer } from "./device.ts";

/**
 * A line's words for the main pointer: the app words touch as "Tap", and a
 * mouse or trackpad reads "Click" for the same thing. Like the Draw hint,
 * it follows the device's main pointer, so a phone keeps its words.
 */
export function pointerWords(text: string, touch: boolean = isCoarsePointer()): string {
  if (touch) return text;
  return text.replace(/\b(Double-)?([Tt])ap(s?)\b/g, (_all, double: string | undefined, t: string, s: string) => `${double ?? ""}${t === "T" ? "C" : "c"}lick${s}`);
}
