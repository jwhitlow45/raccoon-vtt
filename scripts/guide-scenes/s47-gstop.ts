// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export const scrollPanelTop = (page: any) =>
  page.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
export default async (c: any) => {
  const dm = c.state.dm;
  await scrollPanelTop(dm);
  await dm.waitForTimeout(300);
  await c.shot(dm, "look-gs-applied-top");
  return "ok";
};
