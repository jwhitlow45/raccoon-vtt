export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  const st = await roomState(c, c.state.tower);
  const toks = Object.values(st.tokens).filter((t: any) => t.sceneId === c.state.tower) as any[];
  const harpies = toks.filter((t) => t.name === "Harpy").sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const h1 = harpies[0].id;
  const h2 = harpies[1].id;
  c.state.harpies = [h1, h2];
  c.state.towerThorn = toks.find((t) => t.name === "Thorn").id;
  c.state.towerMara = toks.find((t) => t.name === "Mara").id;
  await ops.send({ t: "token.move", tokenId: h1, x: 11, y: 9 });
  // Both over the field, so each pill reads its 40 ft, as the guide's step says.
  await ops.send({ t: "token.move", tokenId: h2, x: 10, y: 14 });
  for (const [id, elev] of [[h1, 40], [h2, 40]] as const) {
    await ops.send({ t: "token.update", tokenId: id, patch: { elevation: elev } });
  }
  await dm.waitForTimeout(800);
  // guidepass6: picking the tool that is already in use would hide its options.
  if (!(await dm.getByRole("button", { name: /^Builder mode/ }).count())) await c.harness.pickTool(dm, "Map builder");
  // guidepass6: the menu may already be open, and a second click would close it.
  if (!(await dm.getByRole("radio", { name: "Heights and stairs" }).count())) {
    await dm.getByRole("button", { name: /^Builder mode/ }).first().click();
    await dm.waitForTimeout(300);
  }
  await dm.getByRole("radio", { name: "Heights and stairs" }).first().click({ force: true });
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-heights");
  return (await dm.locator("body").innerText()).slice(0, 300);
};
