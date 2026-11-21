// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.openSideTab(dm, "Initiative");
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  const party = dm.getByRole("button", { name: /^Party/ }).first();
  const exp = await party.getAttribute("aria-expanded");
  if (exp === "false") await party.click();
  await dm.waitForTimeout(500);
  await dm.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
  // Let the group save's "took damage" notice go first.
  await dm.getByText(/took damage\. Undo takes it all back\./).first().waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
  await dm.mouse.move(5, 790);
  // The tab picked by keyboard keeps a focus ring a mouse user would never see.
  await dm.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-screen-computer");
  return exp;
};
