// Extra (review round 1: ends in the chamber's upper half, so its label is clear of Skeleton 3's name): the walking ruler from Ivo in the hall to the crypt chamber, around the hall's wall, along the corridor and
// over its two squares of difficult ground. The view is the one s125 left.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  await c.harness.pickTool(dm, "Ruler");
  await dm.waitForTimeout(400);
  const walking = dm.getByRole("button", { name: /^Walking$|^Measure: Walking/ }).or(dm.getByRole("radio", { name: "Walking" })).first();
  await walking.click();
  await dm.waitForTimeout(300);
  const a = await c.harness.pagePoint(dm, b, { x: 2.5, y: 8.5 });
  const z = await c.harness.pagePoint(dm, b, { x: 19.5, y: 6.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + 5, a.y, { steps: 3 });
  await dm.mouse.move(z.x, z.y, { steps: 25 });
  await dm.waitForTimeout(500);
  await dm.mouse.up();
  await dm.waitForTimeout(900);
  await dm.mouse.move(1000, 700);
  await c.shot(dm, "extra-walking-ruler");
  const opts = await dm.locator('[aria-label*="options" i]').allInnerTexts().catch(() => []);
  return { opts, text: (await dm.locator("body").innerText()).slice(0, 400) };
};
