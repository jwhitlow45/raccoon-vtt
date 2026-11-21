// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
  await dm.getByRole("button", { name: "Move players to Crypt", exact: true }).click();
  await dm.waitForTimeout(800);
  const warn = await dm.locator('[role="tabpanel"]').first().innerText();
  await c.shot(dm, "look-move-warning");
  const anyway = dm.getByRole("button", { name: "Move anyway" });
  if (await anyway.count()) await anyway.click();
  await dm.waitForTimeout(2500);
  await c.shot(c.state.pat, "look-pat-crypt");
  const i = warn.indexOf("Crypt");
  return warn.slice(i, i + 500);
};
