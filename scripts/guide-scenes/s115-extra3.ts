export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const { panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  const out: Record<string, string> = {};
  // Table display: Add a TV.
  await c.harness.openSideTab(dm, "DM");
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Add a TV" }).click();
  await dm.waitForTimeout(1200);
  await panelScroll(dm, "Table display", 20).catch(() => {});
  await dm.mouse.move(5, 790);
  // Cropped above the link and the QR code, which differ on every run and name the machine.
  await c.shot(dm, "final-table-display", { clip: { x: 0, y: 0, width: 1280, height: 491 } });
  out.tv = (await dm.locator("body").innerText()).match(/Type this on the TV[\s\S]{0,300}/)?.[0] ?? "no card";
  await dm.getByRole("button", { name: "Done", exact: true }).first().click().catch(() => {});
  // Shortcuts sheet, with a key moved and a swap offered (tools/keys-part.ts).
  const { shortcutsShot } = await import(`./tools/keys-part.ts?t=${Date.now()}`);
  out.keys = await shortcutsShot(c);
  return out;
};
