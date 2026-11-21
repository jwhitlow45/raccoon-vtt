// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Guide pass 2: the trap's own toast ("Hidden Pit went off: Thorn.") outlasts the steps before, and the caption names the card alone.
  await dm.getByText(/^Hidden Pit went off: /).first().waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "tr-card");
  return "ok";
};
