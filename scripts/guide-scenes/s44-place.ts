// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const pat = c.state.pat;
  // What Pat's tracker shows of the revealed goblins.
  await pat.locator('button[title="Panels"]').tap().catch(async () => pat.getByRole("button", { name: /^Panels/ }).first().tap());
  await pat.waitForTimeout(500);
  await pat.getByRole("button", { name: /^Initiative/ }).first().tap();
  await pat.waitForTimeout(800);
  await c.shot(pat, "look-pat-tracker");
  const patText = await pat.locator("body").innerText();
  await dm.getByRole("button", { name: "Place", exact: true }).click();
  await dm.waitForTimeout(800);
  const placed = await dm.locator("body").innerText();
  await dm.getByRole("button", { name: "Save and damage" }).first().click();
  await dm.waitForTimeout(2000);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-groupsave");
  const gs = await dm.locator('[role="tabpanel"]').first().innerText();
  // The foot of the page, the creatures' rows over the roll button, before anything is rolled.
  await dm.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = e.scrollHeight;
      e = e.parentElement;
    }
  });
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-ambush-fireball");
  await dm.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
  return patText.slice(0, 700) + "\n-----\n" + placed.slice(0, 300) + "\n-----\n" + gs.slice(0, 2500);
};
