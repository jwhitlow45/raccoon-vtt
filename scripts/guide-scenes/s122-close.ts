// Closes the starter maps without using one.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Close Starter maps" }).click();
  await dm.waitForTimeout(400);
  return (await dm.getByRole("dialog", { name: "Starter maps" }).count()) === 0 ? "closed" : "still open";
};
