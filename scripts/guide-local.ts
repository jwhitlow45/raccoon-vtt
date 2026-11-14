/**
 * The DM guide's pictures of the desktop app (docs/dm-guide.md, "Hosting from
 * your computer"): the app's window, taken from its page with the fake
 * bridge, and Home as another device on the network and as the host
 * computer's own network address show it, taken from the real server in
 * local mode. The window's address is an example from the 10.0.0.x range.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It writes
 * docs/dm-guide/desktop-window.webp at 440 x 720 (the window's own size),
 * and local-join-only.webp and local-host-page.webp at 390 x 844, a phone's
 * size, all in the light theme:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=41700 node scripts/guide-local.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import { ROOT, startServer } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3197);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const WINDOW_OUT = path.join(ROOT, "desktop", "out", "window");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

/** The page at the quality the guide's other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-local-"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const files = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const file = path.join(WINDOW_OUT, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(WINDOW_OUT) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
let server: Awaited<ReturnType<typeof startServer>> | null = null;
try {
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "desktop/window/vite.config.ts"], { cwd: ROOT, stdio: "pipe" });
  await new Promise<void>((resolve) => files.listen(PORT + 1, "127.0.0.1", resolve));
  const windowContext = await browser.newContext({ viewport: { width: 440, height: 720 }, colorScheme: "light", reducedMotion: "reduce" });
  const window = await windowContext.newPage();
  await window.goto(`http://127.0.0.1:${PORT + 1}/?scenario=running`);
  await window.locator("main").waitFor();
  await picture(window, "desktop-window");
  await windowContext.close();

  server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL, local: { host: "127.0.0.1" } });
  const origin = server.origin;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light" });
  for (const [name, local] of [
    ["local-join-only", { shareOrigin: "http://10.0.0.20:3170", createHere: false, hostPage: null }],
    ["local-host-page", { shareOrigin: "http://10.0.0.20:3170", createHere: false, hostPage: `${origin}/` }],
  ] as const) {
    const page = await phone.newPage();
    // The server runs here on loopback, so the answer a device on the network would get is put in by hand.
    await page.route("**/api/config", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, local } });
    });
    await page.goto(`${origin}/`);
    await page.getByRole("heading", { name: "New rooms" }).waitFor();
    await picture(page, name);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve) => files.close(() => resolve()));
  await server?.stop();
  rmSync(work, { recursive: true, force: true });
}
