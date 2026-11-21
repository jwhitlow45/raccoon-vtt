// New picture class-resources.webp (guide pass 2): Thorn's page, a level 5 fighter, after the DM adds his Fighter
// resources with Add a class resource and he spends a Second Wind, so Uses shows his counts with Use, Restore and Edit.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  await dm.keyboard.press("Escape");
  // The crypt's trap card and ruler stay behind from s135: settle the card, drop the ruler, and show the forest road instead.
  await c.harness.pickTool(dm, "Select");
  await dm.getByRole("button", { name: "Dismiss", exact: true }).first().click().catch(() => {});
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const { charactersList } = await import(`./lib.ts?t=${Date.now()}`);
  await charactersList(c, dm);
  await panel.getByText("Thorn", { exact: true }).first().click();
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: "Add a class resource" }).click();
  const sheet = dm.getByRole("dialog", { name: "Add a class resource" });
  await sheet.waitFor();
  await sheet.getByRole("combobox").first().selectOption({ label: "Fighter" });
  await dm.waitForTimeout(600);
  const listed = await sheet.innerText();
  await sheet.getByRole("button", { name: /^Add \d+ resource/ }).click();
  await dm.waitForTimeout(1000);
  await panel.getByRole("button", { name: /^Use one Second Wind|^Use Second Wind/ }).first().click().catch(async () => {
    await panel.getByRole("button", { name: /^Use/ }).first().click();
  });
  await dm.waitForTimeout(900);
  const { rowsIntoView } = await import(`./lib.ts?t=${Date.now()}`);
  const moved = await rowsIntoView(dm, "^Conditions$", 8);
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-class-resources");
  const t = await panel.innerText();
  const i = t.indexOf("USES");
  return moved + "\n" + listed.slice(0, 600) + "\n=====\n" + t.slice(i, i + 500);
};
