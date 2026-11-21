// Bree and Mara go into the crypt's chamber, its door open, for the crypt's later pictures. Spirit Guardians is cast on the forest road (s69-guard*).
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const ops = c.state.ops;
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.bree, x: 18, y: 10 });
  await ops.send({ t: "token.move", tokenId: c.state.cryptPcs.mara, x: 15, y: 11 });
  await ops.send({ t: "door.set", sceneId: c.state.crypt, door: { edge: "14,9,w" }, state: "open" });
  await dm.waitForTimeout(500);
  return "Bree and Mara in the chamber, its door open";
};
