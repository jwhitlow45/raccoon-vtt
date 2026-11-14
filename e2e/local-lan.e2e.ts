import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright-core";
import { openSideTab, Shots, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The desktop app's web side over plain HTTP on the local network
 * (docs/design/design-v1-local-app.md 5 and 14): the real server in local
 * mode on 0.0.0.0, a DM on localhost and the same computer's network
 * address standing in for a phone on the LAN. Links show the LAN address,
 * the switch off then on reaches the open DM tab without a reload, a
 * player on the LAN address joins, Copy falls back where the page has no
 * clipboard, a DM link opens on the LAN address, and Home's two
 * other-device states are measured at 1440 x 900, 390 x 844 and 320 x 568
 * at 100% and 130%.
 *
 * It uses only Playwright's calls that work in every engine, none of the
 * harness's CDP helpers, so `E2E_BROWSERS=chromium,webkit` runs it in
 * WebKit too, where a same-origin POST over plain HTTP sends no
 * Sec-Fetch-Site and the referrer policy decides the Origin it sends.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus thirty-four, and plus
 * thirty-five for the server that starts with the switch off. With no
 * private address on this computer the tests skip.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 34;
const OFF_PORT = PORT + 1;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const BROWSERS = (process.env.E2E_BROWSERS ?? "chromium").split(",").map((b) => b.trim());

/** The address players type: this computer's first private IPv4, which is what the server reports as its share address. */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

const LAN = lanAddress();
const SIZES = [
  { name: "1440x900", width: 1440, height: 900, touch: false },
  { name: "390x844", width: 390, height: 844, touch: true },
  { name: "320x568", width: 320, height: 568, touch: true },
] as const;
const SCALES = [1, 1.3] as const;

const OTHER_DEVICE = "New rooms are made on the computer running RaccoonVTT. Join with the room's link, or its ID and password.";
const HOST_PAGE = "This is the computer running RaccoonVTT. Make rooms on its own page.";

function launch(kind: string): Promise<Browser> {
  const type: BrowserType = kind === "webkit" ? webkit : chromium;
  return type.launch({ ...(kind === "webkit" ? {} : { channel: "chrome" }), headless: process.env.E2E_HEADED !== "1" });
}

for (const kind of BROWSERS) {
  describe(`raccoon-vtt on the local network in ${kind}`, { timeout: 600_000, skip: LAN === null ? "no private network address on this computer" : false }, () => {
    const lan = LAN ?? "";
    const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-local-lan-"));
    const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
    const localhost = `http://localhost:${PORT}`;
    const lanOrigin = `http://${lan}:${PORT}`;
    const run = { roomId: "", roomName: "Lantern Hall", dmLink: "", password: "" };
    let server: Server;
    let browser: Browser;
    let dmContext: BrowserContext;
    let dm: Page;

    function start(port: number, host: "127.0.0.1" | "0.0.0.0"): Promise<Server> {
      return startServer({ port, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL, local: { host } });
    }

    /** The same, or "" while the tab is still reconnecting and the panel is not ready, for a wait to try again. */
    async function playerLinkWhenReady(page: Page): Promise<string> {
      try {
        return await playerLinkText(page);
      } catch {
        return "";
      }
    }

    /** The DM tab's Player link, shown, as the text it prints. */
    async function playerLinkText(page: Page): Promise<string> {
      await openSideTab(page, "DM");
      const code = page.locator('code[aria-label="Player link"]');
      if ((await code.count()) === 0) await page.getByRole("button", { name: "Show the player link" }).click();
      await code.waitFor();
      return (await code.textContent()) ?? "";
    }

    /** Home in a context with the config answer changed, as another device on the network gets it. */
    async function homeAs(local: { shareOrigin: string | null; createHere: boolean; hostPage: string | null }, size: (typeof SIZES)[number], scale: number): Promise<Page> {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: kind === "webkit" ? false : size.touch, hasTouch: size.touch });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      await page.route("**/api/config", async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({ response: res, json: { ...body, local } });
      });
      await page.goto(`${localhost}/`);
      await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
      await page.goto(`${localhost}/`);
      return page;
    }

    before(async () => {
      server = await start(PORT, "0.0.0.0");
      browser = await launch(kind);
      dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      dmContext.setDefaultTimeout(10_000);
      dm = await dmContext.newPage();
    });

    after(async () => {
      if (run.roomId && dmContext) {
        try {
          const res = await dmContext.request.delete(`${localhost}/api/rooms/${run.roomId}`, { headers: { Origin: localhost }, data: { name: run.roomName } });
          if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
        } catch (err) {
          console.error("Deleting the room failed", err);
        }
      }
      await browser?.close();
      await server?.stop();
      rmSync(work, { recursive: true, force: true });
    });

    test("ll-1. the DM on localhost makes a room, and its DM link and player link show the network address", async () => {
      await dm.goto(`${localhost}/`);
      await dm.getByLabel("Room name").fill(run.roomName);
      await dm.getByLabel("Your name").fill("Dana the DM");
      run.password = await dm.getByLabel("Player password").inputValue();
      await dm.getByRole("button", { name: "Create room" }).click();
      await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
      const code = dm.locator("code").first();
      // The page's own origin shows until /api/config answers, so wait for the network address.
      await waitFor("the DM link on the network address", async () => (((await code.textContent()) ?? "").startsWith(`${lanOrigin}/r/`) ? true : null));
      run.dmLink = (await code.textContent()) ?? "";
      const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(run.dmLink);
      assert.ok(match, `DM link looks wrong: ${run.dmLink}`);
      run.roomId = match[1]!.replace("-", "");
      await dm.getByLabel("I saved my DM link").check();
      await dm.getByRole("button", { name: "Continue to the room" }).click();
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      assert.ok((await playerLinkText(dm)).startsWith(`${lanOrigin}/r/`), "the player link names the network address");
      await shots.take(dm, "ll-1-player-link");
    });

    test("ll-2. the switch off then on reaches the open DM tab without a reload", async () => {
      await dm.evaluate(() => ((globalThis as unknown as { __tabKept: boolean }).__tabKept = true));
      await server.stop();
      // The tab sees the server go and comes back by itself once it answers.
      server = await start(PORT, "127.0.0.1");
      await waitFor("the player link back on the page's own origin", async () => ((await playerLinkWhenReady(dm)).startsWith(`${localhost}/r/`) ? true : null), 40_000);
      await server.stop();
      server = await start(PORT, "0.0.0.0");
      await waitFor("the player link on the network address again", async () => ((await playerLinkWhenReady(dm)).startsWith(`${lanOrigin}/r/`) ? true : null), 40_000);
      assert.equal(await dm.evaluate(() => (globalThis as unknown as { __tabKept?: boolean }).__tabKept), true, "the tab was never reloaded");
    });

    test("ll-3. a player on the network address joins and the DM sees them", async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      try {
        await page.goto(`${lanOrigin}/`);
        // A POST from the page itself, so the engine sends the Origin or Sec-Fetch-Site it really would.
        const joined = await page.evaluate(
          async ({ roomId, password }) => {
            const post = async (url: string, body: unknown) => {
              const res = await fetch(url, { method: "POST", mode: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              return { status: res.status, body: (await res.json()) as Record<string, unknown> };
            };
            const first = await post(`/api/rooms/${roomId}/join`, { password });
            if (first.status !== 200) return first;
            return post(`/api/rooms/${roomId}/join/complete`, { ticket: first.body.ticket, name: "Pat", color: "#30a46c" });
          },
          { roomId: run.roomId, password: run.password },
        );
        assert.equal(joined.status, 200, JSON.stringify(joined.body));
        await page.goto(`${lanOrigin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await shots.take(page, "ll-3-player-on-the-network");
        const members = await dmContext.request.get(`${localhost}/api/rooms/${run.roomId}`, { headers: { Origin: localhost } });
        assert.equal(members.ok(), true);
      } finally {
        await context.close();
      }
    });

    test("ll-4. on the network address the DM link opens, Copy works or selects, and Home offers the computer's own page", async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      try {
        const path = new URL(run.dmLink).pathname + new URL(run.dmLink).hash;
        await page.goto(`${lanOrigin}${path}`);
        // A device with no member in the room picks who it is: a new DM member here.
        await page.getByText("Is this you?", { exact: true }).waitFor();
        await page.getByLabel("Your name").fill("Dana at the table");
        await page.getByRole("button", { name: "Join as a new DM" }).click();
        await page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 20_000 });
        // This computer opened its own network address, so Home leads back to localhost.
        await page.goto(`${lanOrigin}/`);
        await page.getByText(HOST_PAGE, { exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Open it" }).getAttribute("href"), `${localhost}/`);
        assert.equal(await page.getByRole("button", { name: "Create room" }).count(), 0, "no Create room on the network address");
        assert.equal(await page.evaluate(() => (globalThis as unknown as { isSecureContext: boolean }).isSecureContext), false, "the page is not a secure context");
        await page.goto(`${lanOrigin}/r/${run.roomId.slice(0, 4)}-${run.roomId.slice(4)}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await playerLinkText(page);
        const copy = page.getByRole("button", { name: "Copy link" }).first();
        await copy.click();
        await page.getByRole("button", { name: "Copied" }).first().waitFor();
        // Neither way of copying works: the text is selected and the words say so.
        await page.evaluate(() => {
          (globalThis as unknown as { document: { execCommand: () => boolean } }).document.execCommand = () => false;
        });
        await page.getByRole("button", { name: /^(Copy link|Copied)$/ }).first().click();
        await page.getByText("Selected. Use your device's Copy.", { exact: true }).waitFor();
        const selected = await page.evaluate(() => (globalThis as unknown as { getSelection(): { toString(): string } | null }).getSelection()?.toString() ?? "");
        assert.ok(selected.startsWith(`${lanOrigin}/r/`), `the link is selected: ${selected}`);
        await shots.take(page, "ll-4-copy-selected");
      } finally {
        await context.close();
      }
    });

    test("ll-5. Home on another device and on the host's network address, measured at three sizes and two zooms", async () => {
      const lines: string[] = [];
      const states = [
        { name: "join-only", local: { shareOrigin: lanOrigin, createHere: false, hostPage: null }, words: OTHER_DEVICE, open: false },
        { name: "host-page", local: { shareOrigin: lanOrigin, createHere: false, hostPage: `${localhost}/` }, words: HOST_PAGE, open: true },
      ];
      for (const state of states) {
        for (const size of SIZES) {
          for (const scale of SCALES) {
            const at = `${state.name}-${size.name}${scale === 1 ? "" : "-130"}`;
            const page = await homeAs(state.local, size, scale);
            try {
              const words = page.getByText(state.words, { exact: true });
              await words.waitFor();
              assert.equal(await page.getByRole("button", { name: "Create room" }).count(), 0, `${at}: no Create room`);
              await page.getByText("Join a room", { exact: true }).waitFor();
              if (state.open) assert.equal(await wholeInReach(page.getByRole("link", { name: "Open it" })), true, `${at}: Open it is in reach`);
              const card = page.locator("section, div").filter({ has: words }).last();
              lines.push(...alignmentLines(await measureAlignment(card), `Home ${at}`));
              if (scale === 1) await shots.take(page, `ll-5-${at}`);
            } finally {
              await page.context().close();
            }
          }
        }
      }
      assert.deepEqual(lines, [], "Home's other-device states out of line");
    });

    test("ll-6. a server started with the switch off answers with no network address", async () => {
      const off = await start(OFF_PORT, "127.0.0.1");
      try {
        const res = await fetch(`http://localhost:${OFF_PORT}/api/config`);
        const body = (await res.json()) as { local: { shareOrigin: string | null; createHere: boolean } | null };
        assert.equal(body.local?.shareOrigin, null);
        assert.equal(body.local?.createHere, true);
      } finally {
        await off.stop();
      }
    });
  });
}
