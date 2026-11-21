// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
// Pasting a picture: the Hollow cave lair from the starter maps as a new scene, an Owlbear on it, selected with its
// action bar closed, then a PNG of the Illustrated Bestiary's owlbear pasted with nothing focused, which opens the offer.
export default async (c: any) => {
  const dm = c.state.dm;
  if (await dm.getByRole("dialog", { name: "Starter maps" }).count()) await dm.keyboard.press("Escape");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  const choice = dm.getByText("Map image", { exact: true }).nth(0);
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  await dm.waitForTimeout(400);
  await dm.getByRole("button", { name: "From starter packs" }).click();
  const dlg = dm.getByRole("dialog", { name: "Starter maps" });
  await dlg.waitFor();
  await dm.waitForTimeout(600);
  const fold = dlg.getByRole("button", { name: /^Dyson Logos maps/ }).first();
  if ((await fold.count()) && (await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await dm.waitForTimeout(600);
  await dlg.getByRole("button", { name: "Hollow cave lair", exact: true }).first().click();
  await dm.waitForTimeout(800);
  await dlg.getByRole("button", { name: "Use", exact: true }).click();
  await dm.waitForTimeout(6000);
  const { roomState, sceneByName } = await import(`./lib.ts?t=${Date.now()}`);
  c.state.cave = sceneByName(await roomState(c), "Hollow cave lair")?.id;

  const b = { w: 17, h: 27 };
  await c.harness.openSideTab(dm, "Monsters");
  const panel = dm.locator('[role="tabpanel"]').first();
  const back = panel.getByRole("button", { name: "Back to Monsters" });
  if (await back.count()) await back.click();
  await dm.getByLabel("Search monsters").fill("owlbear");
  await dm.waitForTimeout(600);
  await panel.getByText("Owlbear", { exact: true }).first().click();
  await dm.waitForTimeout(500);
  await panel.getByRole("button", { name: /^Place on the map/ }).click();
  await dm.waitForTimeout(400);
  // The west passage, left of where the offer opens.
  await c.harness.tapCell(dm, b, { x: 3, y: 18 });
  await dm.waitForTimeout(800);
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(300);
  // The Token panel first: opening a tab after the window closes would let go of the selection.
  await c.harness.openSideTab(dm, "Token");
  await dm.waitForTimeout(400);
  // The Large owlbear covers x 2 to 3, y 18 to 19: a tap inside it selects it and opens its window.
  await c.harness.tapCell(dm, b, { x: 3, y: 19 });
  await dm.getByRole("button", { name: "Close", exact: true }).waitFor();
  await dm.waitForTimeout(400);
  // Closing the window keeps the selection, so the offer leads with the token's picture.
  await dm.getByRole("button", { name: "Close", exact: true }).click();
  await dm.waitForTimeout(500);

  await dm.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const handled = await dm.evaluate(async () => {
    // The pasted file is named for the clock, "Pasted image 9:41 AM.png", so the clock reads one time while it is named.
    (window as any).__toLocaleTimeString = Date.prototype.toLocaleTimeString;
    Date.prototype.toLocaleTimeString = () => "9:41 AM";
    const res = await fetch("/starter/illustrated-bestiary/oz-34.webp");
    const bmp = await createImageBitmap(await res.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    const png: Blob = await new Promise((r) => canvas.toBlob((x) => r(x!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([png], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  await dm.waitForTimeout(1500);
  await dm.evaluate(() => {
    Date.prototype.toLocaleTimeString = (window as any).__toLocaleTimeString;
  });
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-paste-offer");
  const offer = await dm.getByRole("dialog").last().innerText().catch(() => "");
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(400);
  return { handled, offer };
};
