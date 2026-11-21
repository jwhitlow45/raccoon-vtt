// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  await c.shot(dm, "look-folder");
  const dlg = dm.getByRole("dialog").last();
  return (await dlg.innerText()) + "\n" + (await dlg.getByRole("button").evaluateAll((els: HTMLElement[]) => els.map((e) => `[${e.getAttribute("aria-label")}] ${e.textContent?.trim()}`))).join(" | ");
};
