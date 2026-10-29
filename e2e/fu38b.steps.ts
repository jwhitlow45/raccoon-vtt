import assert from "node:assert/strict";
import type { Page } from "playwright-core";

type CoverCheck = { check(): string[]; first: string[] | null; stop(): void };

/** FU38-B: check the opening commit as well as the settled popover, with a notice across its whole box. */
export async function watchNoticeCover(page: Page, name: string): Promise<void> {
  await page.evaluate((name) => {
    type Box = { left: number; top: number; right: number; bottom: number };
    type El = {
      style: Record<string, string>;
      textContent: string | null;
      getBoundingClientRect(): Box;
      appendChild(child: El): void;
      remove(): void;
      contains(child: El): boolean;
      getAttribute(name: string): string | null;
      querySelectorAll(selector: string): El[];
    };
    type Observer = { observe(el: El, options: object): void; disconnect(): void };
    const win = globalThis as unknown as {
      fu38bCover?: CoverCheck;
      document: { body: El; querySelector(selector: string): El | null; querySelectorAll(selector: string): El[]; getElementById(id: string): El | null; createElement(tag: string): El; elementFromPoint(x: number, y: number): El | null };
      MutationObserver: new (callback: () => void) => Observer;
    };
    win.fu38bCover?.stop();
    const doc = win.document;
    const find = () => [...doc.querySelectorAll('[role="dialog"], [role="menu"]')].find((el) =>
      (el.getAttribute("aria-label") ?? doc.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent?.trim()) === name,
    );
    const check = () => {
      const list = find();
      const layer = doc.querySelector("[data-rvtt-toast-layer]");
      if (!list || !layer) return ["The popover or notices layer is missing."];
      const r = list.getBoundingClientRect();
      const l = layer.getBoundingClientRect();
      const cover = doc.createElement("div");
      Object.assign(cover.style, { position: "absolute", left: `${r.left - l.left}px`, top: `${r.top - l.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`, pointerEvents: "auto" });
      layer.appendChild(cover);
      const wrong: string[] = [];
      const buttons = list.querySelectorAll("button, [role='menuitem'], [role='radio']");
      if (buttons.length === 0) wrong.push("The popover has no controls to check.");
      for (const button of buttons) {
        const b = button.getBoundingClientRect();
        if (b.right <= b.left || b.bottom <= b.top) continue;
        const top = doc.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
        if (!top || !button.contains(top)) wrong.push(`${button.textContent?.trim().slice(0, 40)} is covered by the notice.`);
      }
      cover.remove();
      return wrong;
    };
    const observer = new win.MutationObserver(() => {
      if (!find()) return;
      observer.disconnect();
      win.fu38bCover!.first = check();
    });
    win.fu38bCover = { check, first: null, stop: () => observer.disconnect() };
    observer.observe(doc.body, { childList: true, subtree: true });
  }, name);
}

export async function assertNoticeCover(page: Page): Promise<void> {
  const checks = await page.evaluate(() => {
    const cover = (globalThis as unknown as { fu38bCover: CoverCheck }).fu38bCover;
    return { first: cover.first, now: cover.check() };
  });
  assert.deepEqual(checks.first, [], "the popover stands over notices in its opening commit");
  assert.deepEqual(checks.now, [], "the popover still stands over notices");
}
