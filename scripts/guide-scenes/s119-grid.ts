// Line up grid as it opens after an upload whose drawn grid the app finds: a forest map with a dark grid in the art,
// cropped half a square in, so the first guess (the long side over 30) misses and the found grid is applied with Use default.
// s120 deletes the scene afterwards.
import sharp from "sharp";
export default async (c: any) => {
  const dm = c.state.dm;
  // The forest road with a dark grid drawn into the art, cropped half a square (35 px) in on two sides, so the
  // grid the app finds sits off the first guess.
  const road = sharp(`${c.WORK}/forest-road-export.png`);
  const { width = 0, height = 0 } = await road.metadata();
  const lines: string[] = [];
  for (let x = 0; x <= width; x += 70) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
  for (let y = 0; y <= height; y += 70) lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  const grid = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g stroke="#000" stroke-opacity="0.55" stroke-width="3">${lines.join("")}</g></svg>`);
  const drawn = await road.composite([{ input: grid }]).png().toBuffer();
  await sharp(drawn).extract({ left: 35, top: 35, width: width - 35, height: height - 35 }).toFile(`${c.WORK}/forest-clearing.png`);
  const { roomState, sceneByName } = await import(`./lib.ts?t=${Date.now()}`);
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.waitForTimeout(400);
  const choice = dm.getByText("Map image", { exact: true }).nth(0);
  await choice.scrollIntoViewIfNeeded();
  await choice.click();
  await dm.waitForTimeout(400);
  await dm.getByPlaceholder("Name from the file").fill("Forest clearing");
  const chooser = dm.waitForEvent("filechooser");
  await dm.getByRole("button", { name: "Choose a map image" }).click();
  await (await chooser).setFiles(`${c.WORK}/forest-clearing.png`);
  await dm.waitForTimeout(500);
  await dm.getByRole("button", { name: "Upload and create" }).click();
  await dm.getByText(/^Found a grid of/).first().waitFor({ timeout: 30000 });
  await dm.waitForTimeout(1500);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-grid-lineup");
  const strip = (await dm.locator("body").innerText()).slice(0, 400);
  const after = await roomState(c);
  const scene = sceneByName(after, "Forest clearing");
  return { strip, scene: scene ? { id: scene.id, bounds: scene.bounds, map: { cellPx: scene.map?.cellPx, originPx: scene.map?.originPx } } : null };
};
