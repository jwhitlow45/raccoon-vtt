// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const resetScroll = () =>
    dm.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const root = document.getElementById("root");
      if (root) root.scrollTop = 0;
    });
  await resetScroll();
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByRole("button", { name: "Scimitar", exact: true }).first().evaluate((el: HTMLElement) => el.click());
  await dm.waitForTimeout(1500);
  await resetScroll();
  await panel.evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
  await resetScroll();
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-dice");
  return (await panel.innerText()).slice(0, 500);
};
