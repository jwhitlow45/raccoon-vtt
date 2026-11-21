// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = { w: 30, h: 20 };
  const next = async () => {
    await dm.getByRole("button", { name: "Next", exact: true }).first().click();
    await dm.waitForTimeout(700);
  };
  await next(); // Ivo
  // Ivo's Fire Bolt kills Goblin Warrior 1.
  await c.harness.tapCell(dm, b, { x: 8, y: 7 });
  await dm.waitForTimeout(500);
  await dm.getByLabel("HP change").first().fill("-12");
  await dm.getByRole("button", { name: "Apply", exact: true }).first().click();
  await dm.waitForTimeout(500);
  await dm.keyboard.press("Escape");
  await next(); // Thorn
  await c.harness.tapCell(dm, b, { x: 11, y: 6 });
  await dm.waitForTimeout(500);
  await dm.getByLabel("HP change").first().fill("-6");
  await dm.getByRole("button", { name: "Apply", exact: true }).first().click();
  await dm.waitForTimeout(500);
  await dm.keyboard.press("Escape");
  await dm.keyboard.press("Escape");
  await dm.locator('[role="tabpanel"]').first().evaluate((el: HTMLElement) => {
    let e: HTMLElement | null = el;
    while (e) {
      if (e.scrollHeight > e.clientHeight + 5) e.scrollTop = 0;
      e = e.parentElement;
    }
  });
  const party = dm.getByRole("button", { name: /^Party/ }).first();
  if ((await party.getAttribute("aria-expanded")) === "true") await party.click();
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-initiative");
  return (await dm.locator('[role="tabpanel"]').first().innerText()).slice(0, 600);
};
