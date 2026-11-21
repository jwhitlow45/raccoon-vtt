export default async (c: any) => {
  const state = await c.state.dmContext.storageState();
  const ctx = await c.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
  const page = await ctx.newPage();
  c.state.dmPhoneCtx = ctx;
  c.state.dmPhone = page;
  const id = c.state.roomId;
  await page.goto(`${c.origin}/r/${id.slice(0, 4)}-${id.slice(4)}`);
  await page.waitForTimeout(4000);
  await c.shot(page, "look-dmphone");
  const t0 = (await page.locator("body").innerText()).slice(0, 400);
  await page.locator('button[title="Panels"]').tap().catch(async () => page.getByRole("button", { name: /^Panels/ }).first().tap());
  await page.waitForTimeout(800);
  await c.shot(page, "final-screen-phone");
  return t0 + "\n----\n" + (await page.locator("body").innerText()).slice(0, 800);
};
