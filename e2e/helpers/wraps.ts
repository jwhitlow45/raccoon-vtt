import type { Locator } from "playwright-core";

type Dom = { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<{ top: number }> } };
type Node = { textContent: string | null };
type Root = Node & { querySelectorAll(selector: string): ArrayLike<Node> };

/** How many lines an element's text lays out in: the distinct tops of its text boxes. */
export function textLines(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const range = (globalThis as unknown as { document: Dom }).document.createRange();
    range.selectNodeContents(node);
    return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
  });
}

/** The buttons under `root` whose text starts with `prefix`: how many, and the texts of those that wrap. */
export function wrappedButtons(root: Locator, prefix: string): Promise<{ seen: number; wrapped: string[] }> {
  return root.evaluate((node, start) => {
    const doc = (globalThis as unknown as { document: Dom }).document;
    const found = Array.from((node as unknown as Root).querySelectorAll("button")).filter((b) => (b.textContent ?? "").startsWith(start));
    const wrapped = found.filter((b) => {
      const range = doc.createRange();
      range.selectNodeContents(b);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size > 1;
    });
    return { seen: found.length, wrapped: wrapped.map((b) => b.textContent ?? "") };
  }, prefix);
}

/**
 * An element's words by the line each lays out on, top to bottom: every
 * run of text between spaces, as a line may break at a space, so words
 * kept on one line (white-space: nowrap) still count one by one. Text that
 * draws no box of its own (a screen reader's words, 1 px across) is left out.
 */
export function wordLines(el: Locator): Promise<string[][]> {
  return el.evaluate((node) => {
    type R = { top: number; bottom: number; width: number; height: number };
    type T = { textContent: string | null };
    type D = {
      createRange(): { setStart(n: unknown, o: number): void; setEnd(n: unknown, o: number): void; getClientRects(): ArrayLike<R> };
      createTreeWalker(root: unknown, show: number): { nextNode(): T | null };
    };
    const doc = (globalThis as unknown as { document: D }).document;
    const walker = doc.createTreeWalker(node, 4);
    const words: { word: string; top: number; bottom: number }[] = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      for (const m of (text.textContent ?? "").matchAll(/\S+/g)) {
        const range = doc.createRange();
        range.setStart(text, m.index);
        range.setEnd(text, m.index + m[0].length);
        const box = Array.from(range.getClientRects()).find((r) => r.width > 1 && r.height > 1);
        if (box) words.push({ word: m[0], top: box.top, bottom: box.bottom });
      }
    }
    // A word starts a new line where it stands wholly below the line so far, so a taller word (a button's) on the same line stays on it.
    const lines: { bottom: number; words: string[] }[] = [];
    for (const w of [...words].sort((a, b) => a.top - b.top)) {
      const line = lines[lines.length - 1];
      if (line && w.top < line.bottom - 1) {
        line.words.push(w.word);
        line.bottom = Math.max(line.bottom, w.bottom);
      } else lines.push({ bottom: w.bottom, words: [w.word] });
    }
    return lines.map((l) => l.words);
  });
}

/**
 * The word an element's wrapped text leaves alone on its last line, under
 * a line of two or more it could have shared ("ft)" under "Companion of
 * Thorn · Medium (5"), or null.
 */
export async function loneLastWord(el: Locator): Promise<string | null> {
  const lines = await wordLines(el);
  const last = lines[lines.length - 1];
  const before = lines[lines.length - 2];
  return last && before && last.length === 1 && before.length >= 2 ? last[0]! : null;
}
