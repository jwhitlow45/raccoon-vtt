// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const dlg = dm.getByRole("dialog", { name: "Request a roll" });
  const radios = await dlg.getByRole("radio").evaluateAll((els: HTMLElement[]) => els.slice(0, 14).map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`));
  const save = dlg.getByRole("radiogroup", { name: /Saving throw/ });
  if (await save.count()) await save.getByRole("radio", { name: /Dex/i }).first().click();
  else await dlg.getByRole("radio").nth(1).click();
  await dm.waitForTimeout(300);
  await dlg.getByLabel("DC", { exact: true }).first().fill("15");
  await dm.waitForTimeout(300);
  await dlg.getByText(/^Player view/i).first().click();
  await dm.waitForTimeout(300);
  await c.shot(dm, "final-request");
  const t = await dlg.innerText();
  return radios.join(" | ") + "\n" + t.slice(-700);
};
