// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// guidepass6: This device on a phone, Sheet handle with its whole preview band above the toolbar, as sheet-handle.webp.
export default async (c: any) => {
  const state = await c.state.dmContext.storageState();
  const ctx = await c.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
  const page = await ctx.newPage();
  try {
    const id = c.state.roomId;
    await page.goto(`${c.origin}/r/${id.slice(0, 4)}-${id.slice(4)}`);
    await page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /^Panels/ }).first().tap();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Menu", exact: true }).first().tap();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: /^This device/ }).first().tap();
    await page.waitForTimeout(800);
    const sel = page.getByLabel("Sheet handle").first();
    const info = await sel.evaluate((el: HTMLElement) => {
      const out: string[] = [];
      for (let e: HTMLElement | null = el; e; e = e.parentElement) {
        if (e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) { e.scrollTop = e.scrollHeight; out.push(`${e.tagName} ${e.scrollTop}/${e.scrollHeight}/${e.clientHeight} bottom=${Math.round(e.getBoundingClientRect().bottom)}`); }
      }
      const prev = el.parentElement?.querySelectorAll("*");
      return out.join(" | ") + " sel=" + JSON.stringify(el.getBoundingClientRect()) + " parentBottom=" + Math.round(el.parentElement!.getBoundingClientRect().bottom);
    });
    await page.waitForTimeout(500);
    await c.shot(page, "gp5-sheet-handle");
    return info;
  } finally {
    await ctx.close();
  }
};
