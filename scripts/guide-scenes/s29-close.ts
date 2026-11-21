// Closes the image picker without using a picture.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("dialog", { name: "Choose an image" }).getByRole("button", { name: /^Close/ }).first().click();
  await dm.waitForTimeout(400);
  return (await dm.getByRole("dialog", { name: "Choose an image" }).count()) === 0 ? "closed" : "still open";
};
