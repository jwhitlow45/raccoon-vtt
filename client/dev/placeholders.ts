/**
 * Placeholder images for the dev fixture, drawn with plain canvas shapes at
 * runtime: no files ship and no art is generated. The map has its own grid
 * printed into it at the fixture's calibration, so the app's grid lining up
 * with it shows that the calibration math is right.
 */

async function toUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("placeholder: canvas.toBlob failed");
  return URL.createObjectURL(blob);
}

export const FIXTURE_MAP = { widthPx: 2440, heightPx: 1690, cellPx: 80, originPx: { x: 40, y: 50 } };

/** A dungeon-ish floor plan: stone, a few rooms and a corridor, a printed grid. */
export async function drawMap(scale = 1): Promise<string> {
  const { widthPx, heightPx, cellPx, originPx } = FIXTURE_MAP;
  const c = document.createElement("canvas");
  c.width = Math.round(widthPx * scale);
  c.height = Math.round(heightPx * scale);
  const g = c.getContext("2d")!;
  g.scale(scale, scale);
  g.fillStyle = "#3b3530";
  g.fillRect(0, 0, widthPx, heightPx);
  const cell = (x: number, y: number) => [originPx.x + x * cellPx, originPx.y + y * cellPx] as const;
  const room = (x: number, y: number, w: number, h: number, fill: string) => {
    const [px, py] = cell(x, y);
    g.fillStyle = fill;
    g.fillRect(px, py, w * cellPx, h * cellPx);
    g.strokeStyle = "#1c1916";
    g.lineWidth = 10;
    g.strokeRect(px, py, w * cellPx, h * cellPx);
  };
  room(1, 1, 14, 11, "#8a7f6c");
  room(15, 5, 7, 2, "#7d725f");
  room(16, 3, 9, 10, "#6f7f6a");
  room(22, 13, 7, 6, "#5d6470");
  room(3, 13, 6, 5, "#8a6f5a");
  // Water in the cave room, with a little texture so panning is visible.
  g.fillStyle = "#2f5d7a";
  g.beginPath();
  const [wx, wy] = cell(19, 8);
  g.ellipse(wx, wy, 2.2 * cellPx, 1.4 * cellPx, 0.3, 0, Math.PI * 2);
  g.fill();
  // The printed grid. The margin before the first line is the origin offset.
  g.strokeStyle = "rgba(0, 0, 0, 0.45)";
  g.lineWidth = 2;
  g.beginPath();
  for (let x = originPx.x; x <= widthPx; x += cellPx) {
    g.moveTo(x, 0);
    g.lineTo(x, heightPx);
  }
  for (let y = originPx.y; y <= heightPx; y += cellPx) {
    g.moveTo(0, y);
    g.lineTo(widthPx, y);
  }
  g.stroke();
  g.fillStyle = "rgba(255, 255, 255, 0.55)";
  g.font = "bold 40px system-ui, sans-serif";
  g.fillText(scale < 1 ? "fixture map (mobile variant)" : "fixture map (full variant)", originPx.x + 20, originPx.y + 50);
  return toUrl(c);
}

/** A round portrait: a two-color gradient and a letter. */
export async function drawPortrait(letter: string, from: string, to: string): Promise<string> {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  g.fillStyle = "rgba(255, 255, 255, 0.9)";
  g.font = "bold 140px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, size / 2, size / 2 + 8);
  return toUrl(c);
}
