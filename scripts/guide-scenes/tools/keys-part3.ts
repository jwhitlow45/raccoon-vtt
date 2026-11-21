// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// Round 3's shortcut pictures on a computer.
// final-shortcuts-r3: the list from its top, where each tool sits beside its key: Ping moved to K (Reset under its
// Change), and Trap's X waiting on F, which Fog already has (Swap and Cancel).
// final-shortcuts-toolbar: the Toolbar section's row for a tool's key pressed again.
// The keys are reset afterwards.
export async function shortcutsShots(c: any): Promise<Record<string, unknown>> {
  const dm = c.state.dm;
  const dlg = dm.getByRole("dialog", { name: "Shortcuts" });
  if (!(await dlg.count())) await dm.keyboard.press("?");
  await dlg.waitFor();
  await dm.waitForTimeout(600);
  await dlg.getByRole("button", { name: "Change the key for Ping", exact: true }).click();
  await dm.waitForTimeout(200);
  await dm.keyboard.press("k");
  await dm.waitForTimeout(400);
  await dlg.getByRole("button", { name: "Change the key for Trap", exact: true }).click();
  await dm.waitForTimeout(200);
  await dm.keyboard.press("f");
  await dm.waitForTimeout(500);
  const line = (await dlg.innerText()).match(/Already[^\n]*/)?.[0] ?? "no taken line";
  const scrollTop = async (text: string, by = 0) =>
    dlg.getByText(text, { exact: true }).first().evaluate((el: HTMLElement, by: number) => {
      let box: HTMLElement | null = el.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      const row = el.closest("tr") ?? el;
      if (box) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - by;
    }, by);
  // The Swap's focus scrolls the list: bring the Select row back to its top, so every tool's row shows whole.
  await scrollTop("Select");
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-shortcuts-r3");
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await dm.waitForTimeout(300);
  const reset = dlg.getByRole("button", { name: "Reset all keys" });
  await reset.click();
  await dm.waitForTimeout(300);
  if (/Tap again|Sure/.test(await dlg.innerText())) await dlg.getByRole("button", { name: /Reset all keys|Tap again/ }).first().click();
  await dm.waitForTimeout(300);
  await scrollTop("Toolbar", 8);
  await dm.mouse.move(5, 790);
  await dm.waitForTimeout(400);
  await c.shot(dm, "final-shortcuts-toolbar");
  const stored = await dm.evaluate(() => Object.entries(localStorage).filter(([k]) => /key/i.test(k)).map(([k, v]) => `${k}=${v}`).join("; "));
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(300);
  return { line, stored };
}
