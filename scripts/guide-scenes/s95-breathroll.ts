// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const panel = dm.locator('[role="tabpanel"]').first();
  const radios = await panel.getByRole("radio").evaluateAll((els: HTMLElement[]) => els.map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`).filter((s) => /Server|Ask/.test(s)));
  // Bree and Ivo roll on the server (their player is away).
  const serverFor = async (name: string) => {
    const grp = panel.getByRole("radiogroup", { name: new RegExp(`How ${name} rolls`) });
    if (await grp.count()) await grp.getByRole("radio", { name: /^Server/ }).click();
  };
  await serverFor("Bree");
  await serverFor("Ivo");
  await dm.waitForTimeout(300);
  const btn = panel.getByRole("button", { name: /^Roll \d+ saves?/ });
  const label = (await btn.count()) ? await btn.innerText() : "none";
  if (await btn.count()) await btn.click();
  await dm.waitForTimeout(2000);
  const t = await panel.innerText();
  await dm.mouse.move(5, 790);
  await c.shot(dm, "look-breath-rolled");
  return radios.join(" | ") + "\nBTN " + label + "\n" + t.slice(0, 1500);
};
