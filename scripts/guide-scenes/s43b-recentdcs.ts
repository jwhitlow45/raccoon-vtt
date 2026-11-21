// @ts-nocheck
// The DCs the DM has sent before, as this device keeps them, so the group save's DC shows the Recent chips 13 and 15
// the guide's picture names. They are the page's own storage, which a few earlier requests would have filled.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.evaluate((roomId: string) => localStorage.setItem(`rvtt.saveDcs.${roomId}`, JSON.stringify([15, 13])), c.state.roomId);
  return "ok";
};
