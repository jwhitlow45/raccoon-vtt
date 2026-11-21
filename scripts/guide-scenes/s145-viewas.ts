// guidepass6 draft, for phase 2: the token panel's header with View as Pat, and the view it opens.
// The DM on the crypt selects Thorn (Pat's), opens Details, and the panel's header shows the View as button
// under his name. Then the button opens Pat's view, with "Viewing as Pat." at the top.
export default async (c: any) => {
  const dm = c.state.dm;
  const { roomState } = await import(`./lib.ts?t=${Date.now()}`);
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const st = await roomState(c, c.state.crypt);
  const scene = st.scenes[c.state.crypt];
  const thorn = Object.values(st.tokens).find((t: any) => t.sceneId === c.state.crypt && t.name === "Thorn") as any;
  if (!thorn) throw new Error("no Thorn on the crypt");
  // The pit's card from s134 would stand over the map: set it aside on this device first.
  const dismiss = dm.getByRole("button", { name: /^Dismiss/ });
  if (await dismiss.count()) await dismiss.first().click();
  await c.harness.pickTool(dm, "Select");
  await c.harness.tapCell(dm, scene.bounds, { x: thorn.x, y: thorn.y });
  await dm.waitForTimeout(800);
  const bar = dm.getByRole("dialog", { name: "Thorn actions" });
  await bar.waitFor();
  await c.shot(dm, "gp3-viewas-bar");
  await bar.getByRole("button", { name: "Details", exact: true }).first().click();
  await dm.waitForTimeout(800);
  const header = dm.locator("[data-token-panel] [data-creature-header]");
  await header.waitFor();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp3-viewas-panel");
  const button = header.getByRole("button", { name: /^View as / }).first();
  const label = await button.getAttribute("aria-label");
  await button.click();
  await dm.getByText(/^Viewing as /).first().waitFor({ timeout: 20000 });
  await dm.waitForTimeout(2500);
  await c.shot(dm, "gp3-viewas-preview");
  const banner = await dm.getByRole("status").filter({ hasText: /Viewing as/ }).first().innerText().catch(() => "?");
  await dm.getByRole("button", { name: "Exit", exact: true }).first().click();
  await dm.waitForTimeout(800);
  return { label, banner, header: (await header.innerText()).slice(0, 300) };
};
