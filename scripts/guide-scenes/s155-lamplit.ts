// guidepass6: a Universal VTT file that brings its own lights, written here around the forest road the app exported in
// s146 (forest-plain.png), with four lanterns along the road under a night's ambient light. The import's summary leads
// with the lights and Keep it lit.
import { readFileSync, writeFileSync } from "node:fs";
export default async (c: any) => {
  const dm = c.state.dm;
  const image = readFileSync(`${c.WORK}/forest-plain.png`).toString("base64");
  const border = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }];
  const lights = [{ x: 4.5, y: 8.5 }, { x: 11.5, y: 10.5 }, { x: 18.5, y: 9.5 }, { x: 25.5, y: 8.5 }];
  const file = {
    format: 0.3,
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 30, y: 20 }, pixels_per_grid: 70 },
    line_of_sight: [border],
    objects_line_of_sight: [],
    portals: [],
    environment: { baked_lighting: false, ambient_light: "ff1a1a24" },
    lights: lights.map((position) => ({ position, range: 4, intensity: 1, color: "ffeccd8b", shadows: true })),
    image,
  };
  const path = `${c.WORK}/Lantern_road.dd2vtt`;
  writeFileSync(path, JSON.stringify(file));
  await dm.keyboard.press("Escape");
  await c.harness.pickTool(dm, "Select");
  await c.harness.openSideTab(dm, "Scenes");
  await dm.getByLabel("From a Universal VTT file", { exact: true }).setInputFiles(path);
  const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
  await dialog.getByText(/^This map brings 4 lights/).first().waitFor({ timeout: 30000 });
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "gp4-lamplit");
  const text = await dialog.innerText();
  return text.slice(0, 1500);
};
