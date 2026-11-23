/*
 * The rule of pointerWords apart from the browser, so the e2e checks, which run without a DOM, word
 * a line the way a page does.
 */

/** What follows "click" for each form of "tap": taps, tapped and tapping read clicks, clicked and clicking. */
const END: Readonly<Record<string, string>> = { "": "", s: "s", ped: "ed", ping: "ing" };

/** `template` for a main pointer that is touch or not: "Tap" words, or "Click" for a mouse, then the names in. */
export function pointerWordsFor(template: string, names: Readonly<Record<string, string>>, touch: boolean): string {
  const words = touch ? template : template.replace(/\b(Double-)?([Tt])ap(s|ped|ping)?\b/g, (_all, double: string | undefined, t: string, end: string | undefined) => `${double ?? ""}${t === "T" ? "C" : "c"}lick${END[end ?? ""]}`);
  return words.replace(/\{(\w+)\}/g, (hole, key: string) => (Object.hasOwn(names, key) ? names[key]! : hole));
}
