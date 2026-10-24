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
