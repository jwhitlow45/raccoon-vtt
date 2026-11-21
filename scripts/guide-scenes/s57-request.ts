// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await dm.keyboard.press("Escape");
  await dm.getByRole("button", { name: "Ask the party" }).click();
  await dm.waitForTimeout(800);
  const dlg = dm.getByRole("dialog", { name: "Request a roll" });
  const t0 = await dlg.innerText();
  const btns = await dlg.getByRole("button").evaluateAll((els: HTMLElement[]) => els.map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`));
  return t0.slice(0, 1500) + "\n" + btns.join(" | ");
};
