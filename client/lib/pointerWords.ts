import { isCoarsePointer } from "./device.ts";

/**
 * A line's words for the main pointer: the app words touch as "Tap", and a
 * mouse or trackpad reads "Click" for the same thing. Like the Draw hint,
 * it follows the device's main pointer, so a phone keeps its words.
 *
 * It takes the line as a template of fixed instruction text, with `{key}`
 * where a name from the room goes, and the names in `names`. They go in
 * after the words are chosen and are never read again, so a creature named
 * "Tap Room" reads as named.
 */
export function pointerWords(template: string, names: Readonly<Record<string, string>> = {}, touch: boolean = isCoarsePointer()): string {
  const words = touch ? template : template.replace(/\b(Double-)?([Tt])ap(s?)\b/g, (_all, double: string | undefined, t: string, s: string) => `${double ?? ""}${t === "T" ? "C" : "c"}lick${s}`);
  return words.replace(/\{(\w+)\}/g, (hole, key: string) => (Object.hasOwn(names, key) ? names[key]! : hole));
}
