export default async (c: any) => {
  const dm = c.state.dm;
  await dm.getByRole("button", { name: "Undo", exact: true }).first().click();
  await dm.waitForTimeout(1500);
  const body = await dm.locator("body").innerText();
  // guidepass6: wait for the three toasts to clear so the picture shows only the reopened page.
  await dm.waitForTimeout(9000);
  await c.shot(dm, "gp5-undo-reopen-a");
  const reopened = await dm.locator('[role="tabpanel"]').first().innerText();
  // guidepass6: Undo reopens the group save page. Leave it by Discard, so the Fireball save does not stay open over the later steps.
  // guidepass6: a reopened group save page stays open over the later steps. Discard asks once more, so it is pressed twice.
  const discard = dm.getByRole("button", { name: "Discard", exact: true }).first();
  let discarded = "no Discard";
  if (await discard.count()) {
    await discard.scrollIntoViewIfNeeded();
    await discard.click();
    await dm.waitForTimeout(500);
    await dm.getByRole("button", { name: "Discard", exact: true }).first().click();
    await dm.waitForTimeout(700);
    discarded = "Discard pressed twice";
  }
  await c.harness.openSideTab(dm, "Initiative");
  await dm.waitForTimeout(500);
  const t = await dm.locator('[role="tabpanel"]').first().innerText();
  return discarded + "\nREOPENED: " + reopened.slice(0, 700) + "\n---\n" + (body.match(/Undid[^\n]*|Took back[^\n]*|Undo[^\n]*/g) ?? []).slice(0, 5).join(" | ") + "\n" + t.slice(0, 900);
};
