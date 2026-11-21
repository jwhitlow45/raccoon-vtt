export default async (c: any) => {
  const dm = c.state.dm;
  const name = await dm.getByPlaceholder("Name from the file").inputValue().catch(() => "?");
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  // The form from its heading, so the picked file, Paste an image and Upload and create show together.
  await panelScroll(dm, "New scene", 8);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "scenes-new-map");
  await dm.getByRole("button", { name: "Upload and create" }).click();
  await dm.waitForTimeout(7000);
  await c.shot(dm, "look-after-create");
  const t = await dm.locator("body").innerText();
  return name + "\n" + t.slice(0, 3000);
};
