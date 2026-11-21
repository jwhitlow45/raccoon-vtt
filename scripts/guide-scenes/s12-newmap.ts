// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
export default async (c: any) => {
  const dm = c.state.dm;
  const b = dm.getByText("Map image", { exact: true }).nth(0);
  const all = await dm.getByText("Map image", { exact: true }).evaluateAll((els: HTMLElement[]) => els.map((e) => `${e.tagName} role=${e.getAttribute("role")} parent=${e.parentElement?.tagName}/${e.parentElement?.getAttribute("role")}`));
  // The second "Map image" is the THIS SCENE label; the first is the new scene choice.
  await b.scrollIntoViewIfNeeded();
  await b.click();
  await dm.waitForTimeout(600);
  await c.shot(dm, "look-newmap");
  return all.join("\n");
};
