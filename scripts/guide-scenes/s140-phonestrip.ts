// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// phone-strip.webp (round 3): the DM's phone held upright on the forest road, zoomed in with the wheel at the goblins
// so they fill the map above the strip and their labels stand apart, then Goblin Warrior 2 tapped: its action bar
// rests as a strip at the map's foot with its name, AC and HP, the HP entry and the quick row.
export default async (c: any) => {
  const state = await c.state.dmContext.storageState();
  const ctx = await c.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
  const page = await ctx.newPage();
  try {
    const id = c.state.roomId;
    await page.goto(`${c.origin}/r/${id.slice(0, 4)}-${id.slice(4)}`);
    await page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: /^Panels/ }).first().tap();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /^Scenes/ }).first().tap();
    await page.waitForTimeout(800);
    await page.getByText("Forest road", { exact: true }).first().tap();
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1500);
    const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
    const st = await roomState(c, c.state.forest);
    const gobs = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.forest && /^Goblin/.test(t.name)) as any[];
    const xs = gobs.map((t) => t.x);
    const mid = { x: (Math.min(...xs) + Math.max(...xs) + 1) / 2, y: gobs.reduce((n, t) => n + t.y + 0.5, 0) / gobs.length };
    const cam = async () => page.evaluate(() => { const s = (globalThis as any).Konva?.stages[0]; return s ? { x: s.x(), y: s.y(), scale: s.scaleX() } : null; });
    const start = await cam();
    // The wheel zooms at the pointer: keep the pointer on the goblins' middle as the map grows.
    for (let i = 0; i < 12; i++) {
      const p = await c.harness.pagePoint(page, { w: 30, h: 20 }, mid);
      const now = await cam();
      if (now && now.scale >= 29) break;
      await page.mouse.move(p.x, p.y);
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(350);
    }
    // Then the goblins' middle is moved to the middle of the map above the strip, with a drag of the middle button.
    let p = await c.harness.pagePoint(page, { w: 30, h: 20 }, mid);
    // Across, the goblins' middle; down, the map's top edge just under the top bar, so no empty band shows above it.
    const zoomed = await cam();
    const target = { x: 195, y: 54 + mid.y * (zoomed?.scale ?? 30) };
    await page.mouse.move(p.x, p.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(p.x + (target.x - p.x) / 2, p.y + (target.y - p.y) / 2, { steps: 4 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(800);
    const end = await cam();
    const gob = gobs.find((t) => t.name === "Goblin Warrior" && t.number === 2);
    p = await c.harness.pagePoint(page, { w: 30, h: 20 }, { x: gob.x + 0.5, y: gob.y + 0.5 });
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(1500);
    await c.shot(page, "final-phone-strip");
    const strip = await page.locator("button").evaluateAll((els: HTMLElement[]) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.y > 600 && r.y < 790 && r.width > 0; }).map((e) => (e.getAttribute("aria-label") || "") + "|" + (e.textContent || "").trim()));
    return { start, end, mid, gobs: gobs.map((t) => [t.name, t.number, t.x, t.y]), strip };
  } finally {
    await ctx.close();
  }
};
