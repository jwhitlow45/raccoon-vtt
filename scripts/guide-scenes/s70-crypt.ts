export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  // Thorn through the UI: Characters, Thorn, Place a token, tap the hall.
  await (await import(`./lib.ts?t=${Date.now()}`)).charactersList(c, dm);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByText("Thorn", { exact: true }).first().click();
  await dm.waitForTimeout(400);
  await panel.getByRole("button", { name: "Place a token" }).click();
  await dm.waitForTimeout(600);
  const strip = (await dm.locator("body").innerText()).slice(0, 200);
  await c.harness.tapCell(dm, b, { x: 5, y: 9 });
  await dm.waitForTimeout(800);
  const { pcToken } = await import(`./lib.ts?t=${Date.now()}`);
  const ids: Record<string, string> = {};
  ids.bree = await pcToken(c, c.state.crypt, "bree", 3, 10, { image: c.state.icons.bree });
  ids.mara = await pcToken(c, c.state.crypt, "mara", 6, 10, { image: c.state.icons.mara, light: { bright: 20, dim: 20 } });
  ids.ivo = await pcToken(c, c.state.crypt, "ivo", 4, 11, { image: c.state.icons.ivo });
  c.state.cryptPcs = ids;
  await dm.keyboard.press("Escape");
  return strip;
};
