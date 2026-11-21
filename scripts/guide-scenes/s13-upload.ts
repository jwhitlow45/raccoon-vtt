export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByPlaceholder("Name from the file").fill("Forest road");
  const chooser = dm.waitForEvent("filechooser");
  await dm.getByRole("button", { name: "Choose a map image" }).click();
  const fc = await chooser;
  await fc.setFiles(`${c.WORK}/forest-road-export.png`);
  await dm.waitForTimeout(500);
  await c.shot(dm, "look-upload-1");
  const t1 = await dm.locator("body").innerText();
  await dm.waitForTimeout(6000);
  await c.shot(dm, "look-upload-2");
  const t2 = await dm.locator("body").innerText();
  return t1.slice(t1.indexOf("NEW SCENE"), t1.indexOf("NEW SCENE") + 900) + "\n-----\n" + t2.slice(0, 2500);
};
