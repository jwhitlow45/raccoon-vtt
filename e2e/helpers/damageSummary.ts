import type { Locator } from "playwright-core";

/** FL-4: measure icons and defense labels against text bounds, plus the two amount columns. */
export async function damageSummaryAlignment(root: Locator, screen: string): Promise<string[]> {
  return root.evaluateAll((roots, screen) => {
    type Element = {
      tagName: string;
      matches(selector: string): boolean;
      querySelector(selector: string): Element | null;
      querySelectorAll(selector: string): ArrayLike<Element>;
      lastChild: unknown;
      children: ArrayLike<Element>;
      textContent: string | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number };
      ownerDocument: {
        createRange(): { selectNodeContents(node: unknown): void; getBoundingClientRect(): { top: number; bottom: number; right: number }; getClientRects(): ArrayLike<{ top: number; bottom: number }> };
        defaultView: { getComputedStyle(element: Element): { display: string } } | null;
      };
    };
    const lines: string[] = [];
    for (const root of roots as unknown as Element[]) {
      const summaries = root.matches("[data-damage-summary]") ? [root] : Array.from(root.querySelectorAll("[data-damage-summary]"));
      for (const summary of summaries) {
        const bounds = summary.getBoundingClientRect();
        for (const element of Array.from(summary.querySelectorAll("*"))) {
          const box = element.getBoundingClientRect();
          if (box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1)) {
            lines.push(`${screen}: damage summary content extends past the slip's edge: ${element.tagName.toLowerCase()} "${element.textContent?.trim().slice(0, 48) ?? ""}" at ${box.left.toFixed(2)}..${box.right.toFixed(2)}, slip ${bounds.left.toFixed(2)}..${bounds.right.toFixed(2)}`);
          }
        }
        const icons: number[] = [];
        for (const part of Array.from(summary.querySelectorAll("[data-damage-part], [data-damage-defense-entry]"))) {
          const icon = part.querySelector("[data-damage-icon]");
          const text = part.querySelector("[data-damage-text]");
          if (!icon || !text?.lastChild) {
            lines.push(`${screen}: damage part has no icon or words`);
            continue;
          }
          const box = icon.getBoundingClientRect();
          if (box.width < 1 || box.height < 1) continue;
          const range = text.ownerDocument.createRange();
          range.selectNodeContents(text);
          const words = range.getBoundingClientRect();
          const offset = Math.abs((box.top + box.bottom - words.top - words.bottom) / 2);
          if (offset > 1) lines.push(`${screen}: ${icon.getAttribute("data-damage-icon")} icon is ${offset.toFixed(2)} px off its text's vertical center`);
          if (part.matches("[data-damage-part]")) icons.push(box.left);
        }
        const list = summary.querySelector('[aria-label="Damage parts"]');
        const display = list ? list.ownerDocument.defaultView?.getComputedStyle(list).display : null;
        if (display === "grid" && icons.some((left) => Math.abs(left - icons[0]!) > 1)) lines.push(`${screen}: damage icons do not share a column`);
        for (const row of Array.from(summary.querySelectorAll("[data-damage-defense], [data-damage-target]"))) {
          const entry = row.querySelector("[data-damage-defense-entry]");
          const value = entry?.querySelector("[data-damage-text]");
          const icon = entry?.querySelector("[data-damage-icon]");
          if (!value || !icon || icon.getBoundingClientRect().width < 1) continue;
          const range = value.ownerDocument.createRange();
          range.selectNodeContents(value);
          const words = range.getBoundingClientRect();
          const picture = icon.getBoundingClientRect();
          // Read the existing label spans too, so this check detects the original baseline bug without new markup.
          for (const label of Array.from(row.children)) {
            if (label === entry) break;
            range.selectNodeContents(label);
            const lastLine = Array.from(range.getClientRects()).at(-1);
            if (!lastLine || lastLine.bottom <= words.top || lastLine.top >= words.bottom) continue;
            const textOffset = Math.abs((lastLine.top + lastLine.bottom - words.top - words.bottom) / 2);
            const baselineOffset = Math.abs(lastLine.bottom - words.bottom);
            const iconOffset = Math.abs((lastLine.top + lastLine.bottom - picture.top - picture.bottom) / 2);
            const name = label.textContent?.trim();
            if (textOffset > 1 || baselineOffset > 1) lines.push(`${screen}: defense label "${name}" and its first value differ by ${textOffset.toFixed(2)} px at their text centers and ${baselineOffset.toFixed(2)} px at their text bottoms`);
            if (iconOffset > 1) lines.push(`${screen}: defense label "${name}" is ${iconOffset.toFixed(2)} px off its first value's icon center`);
          }
        }
        for (const [selector, name] of [["[data-damage-result]", "result"], ["[data-damage-part] s", "struck original"]] as const) {
          const rights = Array.from(summary.querySelectorAll(selector)).flatMap((amount) => {
            if (amount.getBoundingClientRect().width < 1) return [];
            const range = amount.ownerDocument.createRange();
            range.selectNodeContents(amount);
            return [range.getBoundingClientRect().right];
          });
          if (rights.some((right) => Math.abs(right - rights[0]!) > 1)) lines.push(`${screen}: ${name} amounts do not share a right edge`);
        }
      }
    }
    return lines;
  }, screen);
}
