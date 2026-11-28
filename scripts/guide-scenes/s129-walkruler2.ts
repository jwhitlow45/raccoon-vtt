// Review round 1, walking-ruler.webp as kept: back in the crypt, framed as s125 framed it, the walking ruler from Ivo
// to the chamber's upper left, where its label covers no creature's name. Guide pass 2: run right after s129 (it was
// s138), before s130's pit opens in the chamber and its card stands over the ruler, and it ends s129's fight first.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Initiative");
  const end = dm.getByRole("button", { name: /^End the fight/ }).first();
  if (await end.count()) {
    await end.click();
    await dm.waitForTimeout(300);
    await dm.getByRole("button", { name: /^(End the fight|(?:Tap|Click) again|Sure)/ }).first().click();
    await dm.waitForTimeout(800);
  }
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByText("Crypt", { exact: true }).first().click();
  await dm.waitForTimeout(2000);
  await c.harness.openSideTab(dm, "Initiative");
  await dm.keyboard.press("0");
  await dm.waitForTimeout(800);
  const mid = await c.harness.pagePoint(dm, b, { x: 3, y: 10 });
  await dm.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 2; i++) { await dm.mouse.wheel(0, -120); await dm.waitForTimeout(150); }
  await dm.waitForTimeout(800);
  await c.harness.pickTool(dm, "Ruler");
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "Clear", exact: true }).first().click().catch(() => {});
  const walking = dm.getByRole("button", { name: /^Walking$|^Measure: Walking/ }).or(dm.getByRole("radio", { name: "Walking" })).first();
  await walking.click();
  await dm.waitForTimeout(300);
  const a = await c.harness.pagePoint(dm, b, { x: 2.5, y: 8.5 });
  const z = await c.harness.pagePoint(dm, b, { x: 15.5, y: 5.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 25 });
  await dm.waitForTimeout(500);
  await dm.mouse.up();
  await dm.waitForTimeout(900);
  await dm.mouse.move(1000, 700);
  await c.shot(dm, "extra-walking-ruler2");
  return (await dm.locator("body").innerText()).slice(0, 120);
};
