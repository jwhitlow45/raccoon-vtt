// Closes the re-sync review without applying, stops answering the import route, and deletes Wren, who was made for the picture only.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("dialog", { name: "Check what changes" }).getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
  await dm.waitForTimeout(500);
  await dm.unroute("**/api/rooms/*/ddb-import");
  await c.state.ops.send({ t: "character.delete", characterId: c.state.wren });
  await dm.waitForTimeout(500);
  return "ok";
};
