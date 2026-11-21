export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
  const panel = dm.locator('[role="tabpanel"]').first();
  // Guide pass 2: alerts.webp shows the turn's cards beside the closed row, with its Lair tag and chips.
  await dm.getByText(/^Undid /).first().waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-boss-recharge");
  await panel.getByRole("button", { name: "Adult Red Dragon options" }).click();
  await dm.waitForTimeout(600);
  // Spend one legendary action.
  const t = await panel.innerText();
  const pip = panel.getByRole("button", { name: "1 used" }).first();
  if (await pip.count()) await pip.click();
  await dm.waitForTimeout(500);
  // The undo before this step leaves a notice for a few seconds; the guide's picture is of the card alone.
  await dm.getByText(/^Undid /).first().waitFor({ state: "hidden", timeout: 20000 }).catch(() => {});
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-boss-row-options");
  c.state.keepTurnCard = false;
  const i = t.indexOf("Adult Red Dragon");
  return t.slice(i, i + 1200);
};
