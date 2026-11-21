export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByText("Forest road (builder)", { exact: true }).first().click();
  await dm.waitForTimeout(2500);
  await c.shot(dm, "look-forest-draft");
  return "ok";
};
