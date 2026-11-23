/*
 * Import this first in a unit test that reads app words said with "Tap": the test runs without a
 * browser, where the main pointer reads as a mouse and the words say "Click" (client/lib/pointerWords.ts).
 * This makes it a touch screen, so the test reads the words a phone shows. The mouse's words are
 * tested in client/lib/rootWords.test.ts and beside each rule.
 */
(globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query === "(pointer: coarse)" });
