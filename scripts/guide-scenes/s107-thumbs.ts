export default async (c: any) => {
  const dm = c.state.dm;
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const out: string[] = [];
  for (const name of ["Crypt", "Watchtower"]) {
    await dm.getByText(name, { exact: true }).first().click();
    await dm.waitForTimeout(1800);
    await dm.getByRole("button", { name: `More for ${name}` }).click();
    await dm.waitForTimeout(400);
    const dlg = dm.getByRole("dialog").last();
    out.push((await dlg.innerText()).slice(0, 300));
    await dlg.getByRole("button", { name: /^Update thumbnail/ }).click();
    await dm.waitForTimeout(2500);
    out.push((await dlg.innerText().catch(() => "closed")).slice(0, 200));
    await dm.keyboard.press("Escape");
    await dm.waitForTimeout(300);
  }
  await dm.getByText("Forest road", { exact: true }).first().click();
  await dm.waitForTimeout(1800);
  await panelScroll(dm, null);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(500);
  await c.shot(dm, "final-scenes");
  return out.join("\n----\n");
};
