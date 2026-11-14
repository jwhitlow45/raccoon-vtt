import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "../../e2e/helpers/alignment.ts";
import { ERRORS, SCENARIO_NAMES } from "../window/scenarios.ts";
import { WORDS } from "../contract.ts";

/**
 * The window's page (design 9) in Chromium, against its production build
 * with the fake bridge: every state and word, both themes, three sizes at two
 * zooms with the alignment check, keys and focus, and busy buttons. It runs
 * on E2E_PORT (default 40600) and takes its shots from E2E_SCREENSHOT_DIR.
 *
 * Zoom is the layout the shell's zoom factor gives: a window of W x H at
 * 130% lays the page out in W/1.3 x H/1.3 CSS pixels, drawn 1.3 times larger.
 * The context sets both, so shots and measurements match what the window shows.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = path.join(ROOT, "desktop/out/window");
const PORT = Number(process.env.E2E_PORT ?? 40600);
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? null;

let server: Server;
let browser: Browser;
const errors: string[] = [];

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

before(async () => {
  // Vite's own script on this Node, as desktop/package.json's build:window
  // runs it: Windows starts pnpm only through its .cmd shim and a shell.
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "desktop/window/vite.config.ts"], { cwd: ROOT, stdio: "pipe" });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = path.join(OUT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(OUT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

type Look = { width: number; height: number; zoom: number; scheme: "light" | "dark" };
const SIZES: [number, number][] = [
  [400, 560],
  [440, 720],
  [900, 700],
];
const ZOOMS = [1, 1.3];
const SCHEMES = ["light", "dark"] as const;

async function context(look: Partial<Look> = {}): Promise<BrowserContext> {
  const { width = 440, height = 720, zoom = 1, scheme = "light" } = look;
  return browser.newContext({
    viewport: { width: Math.floor(width / zoom), height: Math.floor(height / zoom) },
    deviceScaleFactor: zoom,
    colorScheme: scheme,
    // The spinner turns by a CSS animation, whose rotated box would move a measured edge between frames. It holds still under this setting.
    reducedMotion: "reduce",
    permissions: [],
  });
}

async function open(ctx: BrowserContext, query: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${query}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) errors.push(`${query}: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${PORT}/?${query}`);
  await page.locator("main").waitFor();
  return page;
}

const calls = (page: Page): Promise<{ method: string; args: unknown[] }[]> => page.evaluate("window.fakeBridge.calls") as Promise<{ method: string; args: unknown[] }[]>;
const active = (page: Page): Promise<string> => page.evaluate("document.activeElement?.textContent ?? ''") as Promise<string>;
const text = async (page: Page): Promise<string> => (await page.locator("main").innerText()).replace(/\s+/g, " ");

function shot(page: Page, name: string): Promise<unknown> {
  if (!SHOTS) return Promise.resolve();
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** What each scenario must show, in the design's words. */
const EXPECT: Record<string, string[]> = {
  running: ["Running", "Players join at", "http://10.0.0.20:3170", "Copy", "Players on this network can join", "No other devices connected", "Not working?", "Open RaccoonVTT", "Rooms on this computer", "The Sunken Library", "Last played 2 hours ago", "Last played yesterday", "Backups", "Last backup: today at", "Back up now", "By hand", "Daily", "Before the update to 0.5.0", "Show backups folder", "Settings", "Port", "Change port", "Check for updates once a day", "Open my browser when RaccoonVTT starts", "Show data folder", "Show logs", "RaccoonVTT 0.5.0", "Source code", "Quit"],
  "running-linux": ["Running"],
  "running-mac": ["Running"],
  "devices-1": ["1 other device connected", WORDS.players.awake],
  "devices-3": ["3 other devices connected", WORDS.players.awake],
  "firewall-missing": ["Running"],
  "no-rooms": [WORDS.rooms.empty],
  "no-backups": ["No backups yet"],
  "unreadable-backup": ["Backups"],
  "starting-none": [WORDS.steps.startServer, "Quit"],
  clock: ["This computer's clock is 7 minutes off. Set the time automatically, since the Log numbers its lines by this clock."],
  "long-words": ["RaccoonVTT 0.5.1 is out. Your rooms are backed up before it starts.", "Install and restart", "3 other devices connected"],
  "update-install": ["RaccoonVTT 0.5.1 is out. Your rooms are backed up before it starts.", "Install and restart"],
  "update-download": ["RaccoonVTT 0.5.1 is out. Your rooms are backed up before it starts.", "Download"],
  "update-downloading": ["Downloading 42%"],
  "update-stopping": ["Stopping to install"],
  "notice-restored": ["Restored the backup from Nov 9 at"],
  "notice-restoreFailed": ["The restore failed, and nothing changed: the backup's images could not be read."],
  "notice-restoreInterrupted": ["A restore was interrupted, and nothing changed."],
  "notice-restoreFinished": ["The restore of the backup from Nov 9 at"],
};
for (const [step, words] of Object.entries(WORDS.steps)) EXPECT[`step-${step}`] = [words];
for (const [reach, words] of Object.entries(WORDS.players.reach)) EXPECT[`reach-${reach}`] = [words];
for (const [step, words] of Object.entries(WORDS.backups.steps)) EXPECT[`restoring-${step}`] = [words, WORDS.notDuringRestore];
const ERROR_WORDS: Record<string, string[]> = {
  glibc: ["RaccoonVTT needs glibc 2.36 or later (Ubuntu 24.04, Debian 12, Fedora 37 or later)."],
  quarantine: ['macOS blocked part of RaccoonVTT. In Terminal, run: xattr -dr com.apple.quarantine "/Applications/RaccoonVTT.app" then open RaccoonVTT again.'],
  root: ["RaccoonVTT can't run as root. Open it as your own user."],
  alreadyRunning: ["RaccoonVTT is already running with this data folder."],
  pathTooLong: ["RaccoonVTT can't start because your home folder's path is too long for it."],
  guardLeft: ["RaccoonVTT closed while it was starting last time.", "/run/user/1000/raccoonvtt-guard-3f9a", "Copy", "Delete it and start"],
  guardUnreadable: ["RaccoonVTT can't tell whether another copy is running. If no other copy is open, delete the folder", "Copy", "Delete it and start"],
  portInUse: ["Port 3170 is in use by another program. Use port 3171 instead? Player links will change.", "Use port 3171", "Quit"],
  pgMajor: ["This data's database is PostgreSQL 18, and this version runs PostgreSQL 17. Install the latest RaccoonVTT.", "Download the latest version"],
  databaseFailed: ["The database did not start. The log says: FATAL: could not create shared memory segment.", "Try again", "Show logs"],
  serverCrashed: ["RaccoonVTT stopped unexpectedly and did not start again. The log says: Error: listen EADDRINUSE: address already in use :::3170.", "Try again", "Show logs"],
  restoreTangled: ["A restore left the databases in a state RaccoonVTT can't sort out by itself. Nothing was deleted.", "Show data folder"],
  noStamp: ["RaccoonVTT can't tell which version wrote this data.", "Restore a backup"],
  newerData: ["This data was last used by RaccoonVTT 0.6.0, which saves rooms in a newer format than this version (0.5.0) reads. Install 0.6.0 or later, or restore a backup made before that update.", "Download the latest version", "Restore a backup"],
  noReadableBackup: ["No backup this version can read is on this computer. Install 0.6.0 or later to open your rooms.", "Download the latest version"],
  backupBeforeUpdateFailed: ["The backup before the update failed: the disk is full. Your rooms are untouched.", "Try again", "Start without a backup"],
};
for (const key of Object.keys(ERRORS)) EXPECT[`error-${key}`] = ERROR_WORDS[key] ?? [];

describe("the desktop window page", { timeout: 900_000 }, () => {
  test("the scenario list covers every error and the expectations cover every scenario", () => {
    for (const name of SCENARIO_NAMES) assert.ok(EXPECT[name], `no expectation for ${name}`);
    for (const key of Object.keys(ERROR_WORDS)) assert.ok(key in ERRORS, `${key} is not an error`);
  });

  test("every state shows its words, in both themes, and is shot once", async () => {
    for (const scheme of SCHEMES) {
      const ctx = await context({ scheme });
      for (const name of SCENARIO_NAMES) {
        const page = await open(ctx, `scenario=${name}`);
        assert.equal(await page.evaluate("document.documentElement.dataset.rvttScheme"), scheme, `${name} follows the system's ${scheme} theme`);
        const body = await text(page);
        for (const words of EXPECT[name]!) assert.ok(body.includes(words), `${name} (${scheme}): missing "${words}" in: ${body.slice(0, 400)}`);
        assert.ok(!body.includes("\u2014"), `${name}: an em dash is on the page`);
        await shot(page, `${name}-${scheme}`);
        await page.close();
      }
      await ctx.close();
    }
  });

  test("Windows, Linux and macOS differ only where the design says", async () => {
    const ctx = await context();
    const win = await open(ctx, "scenario=running&platform=win32");
    await win.getByRole("button", { name: "Not working?" }).click();
    let body = await text(win);
    assert.ok(!body.includes("sudo ufw"));
    assert.ok(!body.includes(WORDS.notWorking.firewallRuleMissing));
    assert.ok(body.includes("This computer also answers at: 10.0.0.21."));
    const missing = await open(ctx, "scenario=firewall-missing");
    await missing.getByRole("button", { name: "Not working?" }).click();
    assert.ok((await text(missing)).includes(WORDS.notWorking.firewallRuleMissing));
    const linux = await open(ctx, "scenario=running-linux");
    await linux.getByRole("button", { name: "Not working?" }).click();
    body = await text(linux);
    assert.ok(body.includes("If a firewall runs here, allow the port: sudo ufw allow 3170/tcp"));
    assert.ok(!body.includes(WORDS.notWorking.firewallRuleMissing));
    await shot(linux, "not-working-linux");
    await ctx.close();
  });

  for (const scheme of SCHEMES) {
    test(`alignment, no sideways scroll, 44 px targets and 16 px fields at three sizes and two zooms, ${scheme}`, async () => {
      const lines: string[] = [];
      const names = ["running", "devices-3", "long-words", "error-portInUse", "error-newerData", "restoring-images", "step-initdb", "no-rooms", "reach-public", "update-downloading", "notice-restored"];
      for (const zoom of ZOOMS) {
        for (const [width, height] of SIZES) {
          const ctx = await context({ width, height, zoom, scheme });
          for (const name of names) {
            const at = `${name} ${width}x${height} ${zoom * 100}% ${scheme}`;
            const page = await open(ctx, `scenario=${name}`);
            // Open the fold and a long list so the check sees them too.
            const fold = page.getByRole("button", { name: "Not working?" });
            if (await fold.count()) await fold.click();
            lines.push(...alignmentLines(await measureAlignment(page.locator("main")), at));
            const small = (await page.evaluate(`(() => {
              const out = [];
              for (const el of document.querySelectorAll("button, input")) {
                if (el.offsetParent === null) continue;
                const r = el.getBoundingClientRect();
                if (r.height < 43.5) out.push(el.tagName + " " + (el.textContent || el.getAttribute("aria-label")) + " is " + r.height + " px tall");
                if (el.tagName === "INPUT" && parseFloat(getComputedStyle(el).fontSize) < 16) out.push("an input under 16 px");
              }
              return out;
            })()`)) as string[];
            lines.push(...small.map((s) => `${at}: ${s}`));
            const sideways = (await page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth + (document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth)`)) as number;
            if (sideways > 0) lines.push(`${at}: scrolls sideways by ${sideways} px`);
            if (name === "running" || name === "long-words") await shot(page, `size-${name}-${width}x${height}-${zoom * 100}-${scheme}`);
            await page.close();
          }
          await ctx.close();
        }
      }
      assert.deepEqual(lines, []);
    });
  }

  test("focus starts on Open RaccoonVTT, Tab follows the page, Space flips the switch", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.waitForFunction(`document.activeElement?.textContent === "Open RaccoonVTT"`);
    // Backwards from Open RaccoonVTT: the page's own order, bottom to top.
    const back: string[] = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      back.push(await active(page));
    }
    assert.ok(back[0]!.startsWith("Not working?"), back[0]);
    assert.ok(back[1]!.startsWith("Players on this network can join"), back[1]);
    assert.equal(back[2], "Copy");
    // Forwards: the rooms, the backups, the settings, then the foot.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await active(page), "Open RaccoonVTT");
    await page.keyboard.press("Tab");
    assert.equal(await active(page), "New DM link");
    await page.getByRole("switch", { name: "Players on this network can join" }).focus();
    await page.keyboard.press("Space");
    await page.getByText(WORDS.steps.closeToNetwork).waitFor();
    await ctx.close();
  });

  test("the switch is a labeled switch, the status line is polite, errors are alerts, the address is labeled", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    const sw = page.getByRole("switch", { name: "Players on this network can join" });
    assert.equal(await sw.getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("[aria-live=polite]").first().innerText(), "Running");
    assert.ok(await page.getByRole("group", { name: "Players join at" }).count());
    const stop = await open(ctx, "scenario=error-databaseFailed");
    assert.equal(await stop.getByRole("alert").first().locator("p").first().innerText(), ERROR_WORDS.databaseFailed![0]);
    const qr = page.getByRole("img", { name: "QR code for http://10.0.0.20:3170" });
    assert.equal(await qr.count(), 1);
    await ctx.close();
  });

  test("the switch round trip: busy, one call, the words for each restart, then the new state", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running&step=900");
    const sw = page.getByRole("switch", { name: "Players on this network can join" });
    await page.keyboard.press("Tab");
    await sw.focus();
    await page.keyboard.press("Space");
    await page.getByText(WORDS.steps.closeToNetwork).waitFor();
    assert.equal(await sw.getAttribute("aria-busy"), "true");
    await sw.click({ force: true });
    await page.getByText("Only this computer can open RaccoonVTT.").waitFor();
    assert.equal((await calls(page)).filter((c) => c.method === "setNetworkPlay").length, 1);
    assert.equal(await sw.getAttribute("aria-checked"), "false");
    assert.equal(await page.locator("[data-address]").count(), 0);
    await sw.click();
    await page.getByText(WORDS.steps.openToNetwork).waitFor();
    await page.locator("[data-address]").waitFor();
    assert.deepEqual((await calls(page)).filter((c) => c.method === "setNetworkPlay").map((c) => c.args[0]), [false, true]);
    await ctx.close();
  });

  test("Copy copies the address through the shell, then says Copied", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.getByRole("button", { name: "Copy" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    assert.deepEqual((await calls(page)).filter((c) => c.method === "copyText").map((c) => c.args), [["http://10.0.0.20:3170"]]);
    await ctx.close();
  });

  test("New DM link asks first, focus starts on Cancel, Escape cancels, Make link calls once and says it opened", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    const link = page.getByRole("button", { name: "New DM link, The Sunken Library" });
    await link.click();
    const dialog = page.getByRole("dialog", { name: "New DM link" });
    await dialog.waitFor();
    assert.ok((await dialog.innerText()).includes("Make a new DM link for “The Sunken Library”? Every device signed in as DM in this room is signed out, co-DMs become players, and unused DM invites stop working."));
    assert.equal(await active(page), "Cancel");
    await shot(page, "confirm-new-dm-link-light");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal((await calls(page)).filter((c) => c.method === "newDmLink").length, 0);
    await link.click();
    await page.evaluate("window.fakeBridge.hold('newDmLink')");
    await page.getByRole("button", { name: "Make link" }).click();
    await page.getByRole("button", { name: "New DM link, The Sunken Library" }).and(page.locator("[aria-busy=true]")).waitFor();
    await page.evaluate("window.fakeBridge.release('newDmLink')");
    await page.getByText("The new DM link opened in your browser.").waitFor();
    assert.deepEqual((await calls(page)).filter((c) => c.method === "newDmLink").map((c) => c.args), [["7K3M9PQR"]]);
    await ctx.close();
  });

  test("Back up now shows busy, refuses a second press, and lists the new backup", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.evaluate("window.fakeBridge.hold('backupNow')");
    const button = page.getByRole("button", { name: "Back up now" });
    await button.click();
    const busy = page.getByRole("button", { name: "Backing up" });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    await busy.click({ force: true });
    await busy.press("Enter");
    await page.evaluate("window.fakeBridge.release('backupNow')");
    await page.getByRole("button", { name: "Back up now" }).waitFor();
    assert.equal((await calls(page)).filter((c) => c.method === "backupNow").length, 1);
    assert.equal(await page.locator("[data-backups] li").count(), 4);
    await ctx.close();
  });

  test("a failed backup and a restore refused for space say so in the window's words", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.evaluate("window.fakeBridge.fail('backupNow', { error: 'failed', reason: 'the disk is full' })");
    await page.getByRole("button", { name: "Back up now" }).click();
    await page.getByText("The backup failed: the disk is full.").waitFor();
    await page.evaluate("window.fakeBridge.fail('restore', { error: 'noSpace', bytes: 1400000000 })");
    await page.getByRole("button", { name: /^Restore, / }).first().click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByText("Not enough free disk space to restore safely. Free at least 1.4 GB and try again.").waitFor();
    await ctx.close();
  });

  test("Restore asks, shows its steps in a blocking panel with every change refused, then says it finished", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running&step=700");
    await page.getByRole("button", { name: /^Restore, / }).first().click();
    const dialog = page.getByRole("dialog", { name: "Restore" });
    assert.ok((await dialog.innerText()).includes("Players are disconnected while it restores."));
    assert.equal(await active(page), "Cancel");
    await dialog.getByRole("button", { name: "Restore" }).click();
    for (const step of ["stopping", "images", "database", "starting"] as const) await page.getByText(WORDS.backups.steps[step]).first().waitFor();
    const body = await text(page);
    assert.ok(body.includes(WORDS.notDuringRestore));
    assert.equal(await page.getByRole("button", { name: "Back up now" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Open RaccoonVTT" }).isDisabled(), true);
    await page.getByText(/^Restored the backup from /).waitFor();
    assert.equal((await calls(page)).filter((c) => c.method === "restore").length, 1);
    await page.getByRole("button", { name: "Dismiss" }).click();
    assert.equal(await page.getByText(/^Restored the backup from /).count(), 0);
    await page.evaluate("window.fakeBridge.patchSupervisor({ remoteDevices: 0 })");
    assert.equal(await page.getByText(/^Restored the backup from /).count(), 0, "a dismissed notice stays gone through later statuses");
    await ctx.close();
  });

  test("Change port checks the number, asks, then restarts with the new port", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running&step=700");
    const field = page.getByLabel("Port", { exact: true });
    const change = page.getByRole("button", { name: "Change port" });
    assert.equal(await change.isDisabled(), true);
    await field.fill("80");
    await page.getByText("Use a port from 1024 to 65535.").waitFor();
    assert.equal(await change.isDisabled(), true);
    await field.fill("3175");
    assert.equal(await change.isDisabled(), false);
    await change.click();
    const dialog = page.getByRole("dialog", { name: "Change port" });
    assert.ok((await dialog.innerText()).includes("Change the port to 3175? Player links will change."));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await change.click();
    await dialog.getByRole("button", { name: "Change port" }).click();
    await page.getByText(WORDS.steps.changePort).waitFor();
    await page.getByText("http://10.0.0.20:3175").waitFor();
    assert.deepEqual((await calls(page)).filter((c) => c.method === "setPort").map((c) => c.args), [[3175]]);
    await ctx.close();
  });

  test("the two daily choices send their patch", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.getByRole("switch", { name: "Check for updates once a day" }).click();
    await page.getByRole("switch", { name: "Open my browser when RaccoonVTT starts" }).click();
    await page.waitForFunction("window.fakeBridge.calls.filter((c) => c.method === 'setSettings').length === 2");
    assert.deepEqual((await calls(page)).filter((c) => c.method === "setSettings").map((c) => c.args[0]), [{ checkUpdates: false }, { openBrowser: false }]);
    assert.equal(await page.getByRole("switch", { name: "Check for updates once a day" }).getAttribute("aria-checked"), "false");
    await ctx.close();
  });

  test("the buttons that open things call the bridge", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running");
    await page.getByRole("button", { name: "Open RaccoonVTT" }).click();
    await page.getByRole("button", { name: "Show backups folder" }).click();
    await page.getByRole("button", { name: "Show data folder" }).click();
    await page.getByRole("button", { name: "Show logs" }).click();
    await page.getByRole("button", { name: "Source code" }).click();
    const seen = (await calls(page)).map((c) => `${c.method}${c.args.length ? ":" + String(c.args[0]) : ""}`);
    for (const want of ["openApp", "openFolder:backups", "openFolder:data", "openFolder:logs", "openSource"]) assert.ok(seen.includes(want), `${want} in ${seen.join(", ")}`);
    await ctx.close();
  });

  test("Quit asks only when other devices are connected, and its safe choice is Keep running", async () => {
    const ctx = await context();
    const none = await open(ctx, "scenario=running");
    await none.getByRole("button", { name: "Quit", exact: true }).click();
    assert.equal(await none.getByRole("dialog").count(), 0);
    assert.equal((await calls(none)).filter((c) => c.method === "quit").length, 1);
    const some = await open(ctx, "scenario=devices-3");
    await some.getByRole("button", { name: "Quit", exact: true }).click();
    const dialog = some.getByRole("dialog", { name: "Quit" });
    assert.ok((await dialog.innerText()).includes("3 other devices are connected. Quitting ends the game for them."));
    assert.equal(await active(some), "Keep running");
    await shot(some, "confirm-quit-light");
    await some.keyboard.press("Escape");
    assert.equal((await calls(some)).filter((c) => c.method === "quit").length, 0);
    await some.getByRole("button", { name: "Quit", exact: true }).click();
    await some.getByRole("dialog").getByRole("button", { name: "Quit" }).click();
    assert.equal((await calls(some)).filter((c) => c.method === "quit").length, 1);
    await ctx.close();
  });

  test("the update banner installs, downloads and counts", async () => {
    const ctx = await context();
    const install = await open(ctx, "scenario=update-install");
    await install.getByRole("button", { name: "Install and restart" }).click();
    await install.getByText("Stopping to install").waitFor();
    assert.equal((await calls(install)).filter((c) => c.method === "installUpdate").length, 1);
    const download = await open(ctx, "scenario=update-download");
    await download.getByRole("button", { name: "Download" }).click();
    assert.equal((await calls(download)).filter((c) => c.method === "openRelease").length, 1);
    await ctx.close();
  });

  test("a stop's buttons call what they say, and the confirmations guard the two that lose data", async () => {
    const ctx = await context();
    const port = await open(ctx, "scenario=error-portInUse");
    await port.getByRole("button", { name: "Use port 3171" }).click();
    await port.getByText(WORDS.steps.changePort).waitFor({ timeout: 3000 }).catch(() => undefined);
    assert.deepEqual((await calls(port)).filter((c) => c.method === "setPort").map((c) => c.args), [[3171]]);

    const backup = await open(ctx, "scenario=error-backupBeforeUpdateFailed");
    await backup.getByRole("button", { name: "Start without a backup" }).click();
    const ask = backup.getByRole("dialog", { name: "Start without a backup" });
    assert.ok((await ask.innerText()).includes("Start without a backup? Going back to the older version would then lose every change since your last backup."));
    assert.equal(await active(backup), "Cancel");
    await backup.keyboard.press("Escape");
    assert.equal((await calls(backup)).filter((c) => c.method === "startWithoutBackup").length, 0);
    await backup.getByRole("button", { name: "Start without a backup" }).click();
    await ask.getByRole("button", { name: "Start anyway" }).click();
    await backup.getByText("Running").first().waitFor();
    assert.equal((await calls(backup)).filter((c) => c.method === "startWithoutBackup").length, 1);

    const guard = await open(ctx, "scenario=error-guardLeft");
    await guard.getByRole("button", { name: "Copy" }).click();
    assert.deepEqual((await calls(guard)).filter((c) => c.method === "copyText").map((c) => c.args), [["/run/user/1000/raccoonvtt-guard-3f9a"]]);
    await guard.getByRole("button", { name: "Delete it and start" }).click();
    assert.equal((await calls(guard)).filter((c) => c.method === "deleteGuard").length, 0);
    await guard.getByRole("dialog").getByRole("button", { name: "Delete it and start" }).click();
    await guard.getByRole("alert").waitFor({ state: "detached" });
    assert.equal((await calls(guard)).filter((c) => c.method === "deleteGuard").length, 1);

    const logs = await open(ctx, "scenario=error-databaseFailed");
    await logs.getByRole("button", { name: "Show logs" }).first().click();
    await logs.getByRole("button", { name: "Try again" }).click();
    await logs.getByText("Running").first().waitFor();
    assert.ok((await calls(logs)).some((c) => c.method === "retry"));
    const latest = await open(ctx, "scenario=error-newerData");
    await latest.getByRole("button", { name: "Download the latest version" }).click();
    assert.ok((await calls(latest)).some((c) => c.method === "openRelease"));
    await ctx.close();
  });

  test("Restore a backup, on a stop, moves focus to the first Restore", async () => {
    const ctx = await context({ width: 440, height: 500 });
    const page = await open(ctx, "scenario=error-newerData");
    await page.getByRole("button", { name: "Restore a backup" }).click();
    await page.waitForFunction(`document.activeElement?.textContent === "Restore"`);
    await ctx.close();
  });

  test("slow things show the shared spinner after about 200 ms and never before", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=running&delay=700");
    // The rooms list takes 700 ms: no spinner at once, one by 400 ms, gone when the list is in.
    assert.equal(await page.getByText("Loading rooms").count(), 0);
    await page.getByText("Loading rooms").waitFor({ timeout: 600 });
    await shot(page, "loading-rooms-light");
    await page.getByText("The Sunken Library").waitFor();
    assert.equal(await page.getByText("Loading rooms").count(), 0);
    const start = await open(ctx, "scenario=step-initdb");
    assert.equal(await start.locator("[aria-live=polite] svg").count(), 0);
    await start.locator("[aria-live=polite] svg").waitFor({ timeout: 800 });
    await ctx.close();
  });

  test("a status that arrives while the window is open replaces the line and moves the page", async () => {
    const ctx = await context();
    const page = await open(ctx, "scenario=step-startServer");
    await page.getByText(WORDS.steps.startServer).waitFor();
    await page.evaluate("window.fakeBridge.patchSupervisor({ state: 'running', step: 'running', network: 'open', shareOrigin: 'http://10.0.0.20:3170', port: 3170, host: '0.0.0.0' })");
    await page.getByText("Running").waitFor();
    await page.getByText("http://10.0.0.20:3170").waitFor();
    await page.waitForFunction(`document.activeElement?.textContent === "Open RaccoonVTT"`);
    await ctx.close();
  });

  test("no page logged an error", () => {
    assert.deepEqual(errors, []);
  });
});
