// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// guidepass7: Menu, This device, Features on a DM's phone, the Tools group open, as features.webp (docs/design/design-v1-features.md 5).
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
    await page.getByRole("button", { name: /^Features/ }).first().tap();
    await page.getByText("Find a part", { exact: true }).waitFor();
    const menu = page.getByRole("dialog", { name: "Menu" });
    // Tools open, its switches under the presets and the search, with the sheet scrolled to show them.
    await menu.locator("[data-group-fold]").filter({ hasText: /^Tools/ }).first().tap();
    await page.waitForTimeout(500);
    await menu.getByText("Find a part", { exact: true }).scrollIntoViewIfNeeded();
    await menu.getByText("Find a part", { exact: true }).evaluate((el: HTMLElement) => {
      for (let e: HTMLElement | null = el; e; e = e.parentElement) {
        if (e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) {
          e.scrollTop = el.getBoundingClientRect().top - e.getBoundingClientRect().top + e.scrollTop - 8;
          return;
        }
      }
    });
    await page.waitForTimeout(500);
    await c.shot(page, "gp7-features");
    return "ok";
  } finally {
    await ctx.close();
  }
};
