// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// The shortcut list on a computer, its lower rows in view down to W: Other panel moved to K (Reset beside it), and
// Side panel waiting on W, which Full screen already has (Swap and Cancel). The keys are reset afterwards.
export async function shortcutsShot(c: any): Promise<string> {
  const dm = c.state.dm;
  const dlg = dm.getByRole("dialog", { name: "Shortcuts" });
  if (!(await dlg.count())) await dm.keyboard.press("?");
  await dlg.waitFor();
  await dm.waitForTimeout(600);
  await dlg.getByRole("button", { name: /^Change the key for Other panel$/ }).click();
  await dm.waitForTimeout(200);
  await dm.keyboard.press("k");
  await dm.waitForTimeout(400);
  await dlg.getByRole("button", { name: /^Change the key for Side panel$/ }).click();
  await dm.waitForTimeout(200);
  await dm.keyboard.press("w");
  await dm.waitForTimeout(500);
  const line = (await dlg.innerText()).match(/Already[^\n]*/)?.[0] ?? "no taken line";
  // Rows from Next turn down, so N to ? show, the waiting line under S included.
  await dlg.getByText("Next turn, or End turn on your own turn").evaluate((el: HTMLElement) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const row = el.closest("tr") ?? el;
    if (box) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
  });
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-shortcuts");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await dm.waitForTimeout(300);
  const reset = dlg.getByRole("button", { name: "Reset all keys" });
  await reset.click();
  await dm.waitForTimeout(300);
  const again = dlg.getByRole("button", { name: /Reset all keys|Tap again/ }).first();
  const after = await dlg.innerText();
  if (/Tap again|Sure/.test(after)) await again.click();
  await dm.waitForTimeout(300);
  const stored = await dm.evaluate(() => Object.entries(localStorage).filter(([k]) => /key/i.test(k)).map(([k, v]) => `${k}=${v}`).join("; "));
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(300);
  return `${line} | stored after reset: ${stored}`;
}
