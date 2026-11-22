import { isCoarsePointer } from "./device.ts";
import { pointerWordsFor } from "./pointerRules.ts";

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
  return pointerWordsFor(template, names, touch);
}

/**
 * The central pass a shared component runs on the words it was given: a
 * mouse reads "Click" where they say "Tap". A caller whose words hold a name
 * from the room, or text a person typed, words them itself with
 * pointerWords(template, names) and passes `worded`, so the pass never
 * reads the name.
 */
export function passWords(words: string, worded?: true, touch: boolean = isCoarsePointer()): string {
  return worded === true ? words : pointerWords(words, {}, touch);
}
