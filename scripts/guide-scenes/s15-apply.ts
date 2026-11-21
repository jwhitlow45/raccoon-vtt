export default async (c: any) => {
  const dm = c.state.dm;
  // Apply is disabled until the box moves? Try Nudge menu first to read its options.
  const apply = dm.getByRole("button", { name: "Apply" }).first();
  const disabled = await apply.isDisabled();
  await dm.getByRole("button", { name: /Nudge/ }).click();
  await dm.waitForTimeout(400);
  await c.shot(dm, "look-nudge");
  const pop = await dm.locator("body").innerText();
  await dm.keyboard.press("Escape");
  await dm.getByRole("button", { name: "More options" }).click().catch(() => {});
  await dm.waitForTimeout(400);
  await c.shot(dm, "look-grid-more");
  const more = await dm.locator("body").innerText();
  await dm.keyboard.press("Escape");
  return { disabled, nudge: pop.slice(0, 600), more: more.slice(0, 600) };
};
