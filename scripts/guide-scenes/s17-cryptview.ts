export default async (c: any) => {
  const dm = c.state.dm;
  await c.harness.pickTool(dm, "Select").catch(() => {});
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2500);
  await c.shot(dm, "look-crypt");
  return "ok";
};
