/*
 * The rule of pointerWords apart from the browser, so the e2e checks, which run without a DOM, word
 * a line the way a page does.
 */

/** `template` for a main pointer that is touch or not: "Tap" words, or "Click" for a mouse, then the names in. */
export function pointerWordsFor(template: string, names: Readonly<Record<string, string>>, touch: boolean): string {
  const words = touch ? template : template.replace(/\b(Double-)?([Tt])ap(s?)\b/g, (_all, double: string | undefined, t: string, s: string) => `${double ?? ""}${t === "T" ? "C" : "c"}lick${s}`);
  return words.replace(/\{(\w+)\}/g, (hole, key: string) => (Object.hasOwn(names, key) ? names[key]! : hole));
}
