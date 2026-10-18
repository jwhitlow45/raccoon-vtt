import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * The room, the browsers and the computer's reach sweep of the docked
 * token action bar, shared by bardock.e2e.ts and the sweep's files
 * bardock-sweep-*.e2e.ts. Each file starts its own server and browsers and
 * builds its own room, so the CI shards (scripts/e2e-shard.ts) can run
 * the sweep's halves beside the rest. One file held it all before, at
 * about 8 minutes on a laptop.
 *
 * The server, the browsers and the op socket are live bindings: a file
 * reads them once its `before` has run openBrowsers and createRoom.
 */

export const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
export const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

export const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-bardock-"));
export const assetDir = path.join(work, "assets");
export const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

export const DESK = { width: 1280, height: 800 };
export const SPOT_KEY = "rvtt.tokenBarSpot";
export const SIZE_KEY = "rvtt.tokenBarSize";

export let server: Server;
export let browser: Browser;
export let dmContext: BrowserContext;
export let dm: Page;
export let dmCdp: CDPSession;
export let playerContext: BrowserContext;
export let player: Page;
export let playerCdp: CDPSession;
export let ops: OpSocket;
export const dmSocket = new SocketWatch("dm");
export const playerSocket = new SocketWatch("player");
export const dmConsole = new ConsoleWatch("dm");
export const playerConsole = new ConsoleWatch("player");

export const run = {
  roomId: "",
  roomName: `E2E bar dock ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  thorn: { id: randomUUID(), characterId: randomUUID(), x: 4, y: 4 },
  goblins: [
    { id: randomUUID(), x: 6, y: 6 },
    { id: randomUUID(), x: 8, y: 4 },
    { id: randomUUID(), x: 4, y: 9 },
  ],
  /** Far in the map's bottom right, where the docked bar sits. */
  far: { id: randomUUID(), x: 27, y: 17 },
  /** The roll asked of Thorn in step 6, which waits in the DM's column until step 10 closes it. */
  deskRoll: randomUUID(),
};

export type Rect = { left: number; top: number; right: number; bottom: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
export type El = {
  getAttribute(name: string): string | null;
  textContent: string | null;
  closest(selector: string): El | null;
  getBoundingClientRect(): Rect & { width: number; height: number };
};
export type Doc = { activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

export function actor(hp = 20) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 12,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Sets the window, the interface size, the spot and the window's size, then loads the room again. */
export async function setUp(page: Page, view: { width: number; height: number; scale: number }, spot: string | null = null, size: string | null = null): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate(
    ([s, keys, values]) => {
      const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } };
      g.localStorage.setItem("rvtt.uiScale", String(s));
      (keys as readonly string[]).forEach((key, i) => {
        const value = (values as readonly (string | null)[])[i] ?? null;
        if (value === null) g.localStorage.removeItem(key);
        else g.localStorage.setItem(key, value);
      });
    },
    [view.scale, [SPOT_KEY, SIZE_KEY], [spot, size]] as const,
  );
  /*
   * A fresh load of the room's address rather than a reload, and one more
   * try if it meets a navigation the page started itself: a page left with
   * the window open steps off the window's Back entry (lib/backClose.ts).
   */
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await page.waitForTimeout(300);
    }
  }
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Stores this device's side panel choice (client/pages/sidePanel.ts), or clears it with null, for the next reload. */
export async function sidePanelChoice(page: Page, choice: "shown" | "hidden" | null): Promise<void> {
  await page.evaluate(
    (value) => {
      const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } };
      if (value === null) g.localStorage.removeItem("rvtt.sidePanel");
      else g.localStorage.setItem("rvtt.sidePanel", value);
    },
    choice,
  );
}

/** The token bar's frame, whichever token or group it is for. */
export function barFrame(page: Page): Locator {
  return page.locator('[role="dialog"][data-bar-mode]');
}

export async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** The bar's box once it holds still, since it settles after the column and the bars measure themselves. */
export async function barRect(page: Page): Promise<Rect> {
  let last = await rectOf(barFrame(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(60);
    const next = await rectOf(barFrame(page));
    if (Math.abs(next.left - last.left) < 0.5 && Math.abs(next.top - last.top) < 0.5 && Math.abs(next.bottom - last.bottom) < 0.5) return next;
    last = next;
  }
  return last;
}

/** The room's chrome as drawn: the top bar with its band, the toolbar, the side panel from 900 px up, and the window. */
export function chrome(page: Page): Promise<{ top: number; toolbar: number; panel: number | null; width: number; height: number }> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { document: Doc; innerWidth: number; innerHeight: number };
    const header = Array.from(g.document.querySelectorAll("header")).find((h) => h.textContent !== null && h.getAttribute("style") !== null && h.closest("aside") === null);
    const nav = g.document.querySelector('nav[aria-label="Tools"]');
    const aside = g.document.querySelector("aside");
    return {
      top: header?.getBoundingClientRect().bottom ?? 0,
      toolbar: nav?.getBoundingClientRect().top ?? g.innerHeight,
      panel: aside ? aside.getBoundingClientRect().left : null,
      width: g.innerWidth,
      height: g.innerHeight,
    };
  });
}

/** Each goblin takes a point of damage, and with its Hex up, a concentration check comes up for the DM. */
export async function damageGoblins(): Promise<void> {
  for (const g of run.goblins) await ops.send({ t: "actor.hp", target: { tokenId: g.id }, change: { kind: "damage", amount: 1 } });
}

/** The server, the DM at a computer, and Pat on a touch tablet. */
export async function openBrowsers(): Promise<void> {
  server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
  browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
  dmContext = await browser.newContext({ viewport: DESK });
  dm = await dmContext.newPage();
  dmConsole.attach(dm);
  await dmSocket.attach(dmContext, dm);
  dmCdp = await dmContext.newCDPSession(dm);
  // Pat on a tablet: a touch screen, for the touch drag and Find my token.
  playerContext = await browser.newContext({ viewport: { width: 900, height: 800 }, hasTouch: true });
  player = await playerContext.newPage();
  playerConsole.attach(player);
  await playerSocket.attach(playerContext, player);
  playerCdp = await playerContext.newCDPSession(player);
}

/** Deletes the room, then stops the browsers and the server. */
export async function closeAll(): Promise<void> {
  if (process.env.E2E_DEBUG === "1") {
    for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
    console.error(server?.output().split("\n").slice(-40).join("\n"));
  }
  ops?.close();
  if (run.roomId && dmContext) {
    try {
      const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
    } catch (err) {
      console.error(`Deleting room ${run.roomId} failed`, err);
    }
  }
  await browser?.close();
  await server?.stop();
  rmSync(work, { recursive: true, force: true });
}

/** Case 1: a DM's room with Pat's Thorn, three goblins and one far in the corner, and Pat in it. */
export async function createRoom(): Promise<void> {
  await dm.goto(`${server.origin}/`);
  await dm.getByLabel("Room name").fill(run.roomName);
  await dm.getByLabel("Your name").fill("Dana the DM");
  const password = await dm.getByLabel("Player password").inputValue();
  await dm.getByRole("button", { name: "Create room" }).click();
  await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await dm.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  assert.ok(match, `DM link looks wrong: ${link}`);
  run.roomId = match[1]!.replace("-", "");
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  run.sceneId = dmSocket.state!.meta.playerSceneId!;
  run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  const patId = ((await done.json()) as { member: { id: string } }).member.id;

  const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
  await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor: actor(24) } });
  const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
  await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thorn.characterId } }));
  for (const [i, g] of run.goblins.entries()) {
    // Hardy goblins: each step's checks hurt them again.
    await ops.send(token(g.id, { kind: "monster", name: `Goblin ${i + 1}`, x: g.x, y: g.y, disposition: "hostile", actor: { inline: actor(40) } }));
  }
  await ops.send(token(run.far.id, { kind: "monster", name: "Far goblin", x: run.far.x, y: run.far.y, disposition: "hostile", actor: { inline: actor(7) } }));
  await waitFor("every token in the DM's view", () => [...run.goblins, run.far].every((g) => dmSocket.state?.tokens[g.id]) || null);
  await waitFor("Thorn in the DM's view", () => dmSocket.state?.tokens[run.thorn.id]);

  await player.goto(`${server.origin}/r/${run.roomId}`);
  await player.getByRole("status", { name: "Connected" }).first().waitFor();
}

/** The last case: nothing went wrong in either browser. */
export function assertNoConsoleErrors(): void {
  assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
  assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
}

/**
 * Case 19, the computer's reach sweep, over some of its window sizes:
 * each half runs in a file of its own (bardock-sweep-*.e2e.ts).
 */
export function computerSweepTest(SWEEP: readonly { width: number; height: number }[]): void {
  const sizes = SWEEP.map((s) => `${s.width} x ${s.height}`).join(" and ");
  test(`19. the computer's reach sweep: every size and interface size, the side panel shown and hidden, no stored size, the smallest and the largest, the DM and Pat, out of a fight and with checks and a roll card, and a sheet on the right where there is one, at ${sizes}`, async () => {
    const STORED = [null, '{"w":1,"h":1}', '{"w":4096,"h":4096}'] as const;
    const misses: string[] = [];
    /** Steps where the bars and the alerts leave the token no map to be tapped on, which a viewer could not do either. */
    const skipped: string[] = [];
    let steps = 0;
    const reach = async (page: Page, label: string, what: string, target: Locator) => {
      if ((await target.count()) === 0) {
        misses.push(`${label}: no ${what}`);
        return;
      }
      if (!(await wholeInReach(target))) misses.push(`${label}: ${what} is cut off or takes no tap`);
    };
    /** Each control of the open window, whole and on top, the window in its room, nothing sideways, and Apply in view in the smallest. */
    const sweepWindow = async (page: Page, name: string, label: string, smallest: boolean, resizable: boolean, sheetLeft?: number) => {
      const frame = page.getByRole("dialog", { name: `${name} actions` });
      if ((await frame.getAttribute("data-bar-mode")) !== "dock") return;
      steps += 1;
      const r = await barRect(page);
      const c = await chrome(page);
      // A hidden side panel stays in the page with no box.
      const right = sheetLeft ?? (c.panel !== null && c.panel > 0 ? c.panel : c.width);
      if (r.left < -0.5 || r.top < c.top - 0.5 || r.bottom > c.toolbar + 0.5 || r.right > right + 0.5) misses.push(`${label}: the window leaves its room: ${JSON.stringify({ r, c })}`);
      await reach(page, label, "Move window", frame.getByRole("button", { name: "Move window", exact: true }));
      await reach(page, label, "Close", frame.getByRole("button", { name: "Close", exact: true }));
      const reset = frame.getByRole("button", { name: "Reset window position and size", exact: true });
      if ((await reset.count()) > 0) await reach(page, label, "Reset", reset);
      if (resizable) await reach(page, label, "Resize window", frame.getByRole("button", { name: "Resize window", exact: true }));
      const scroller = frame.locator("[data-bar-scroll]");
      if (smallest && resizable) {
        const view = await rectOf(scroller);
        const top = await scroller.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop);
        const field = await rectOf(frame.getByRole("textbox", { name: "HP change" }));
        const apply = await rectOf(frame.getByRole("button", { name: "Apply", exact: true }));
        if (top !== 0 || field.top < view.top - 0.5 || apply.bottom > view.bottom + 0.5) misses.push(`${label}: the smallest window has the HP field or Apply out of view`);
      }
      for (const button of ["One size smaller", "One size larger"]) {
        const b = frame.getByRole("group", { name: "Size", exact: true }).getByRole("button", { name: button });
        if ((await b.count()) === 0) continue;
        if (await b.isDisabled()) continue;
        await b.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "nearest" }));
        await page.waitForTimeout(80);
        await reach(page, label, button, b);
      }
      if (await scroller.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (el as unknown as { clientWidth: number }).clientWidth + 1)) {
        misses.push(`${label}: the window scrolls sideways`);
      }
    };
    /** Opens a token's window from a fitted map, or says why it cannot. */
    const open = async (page: Page, cell: { x: number; y: number }, name: string, label: string): Promise<boolean> => {
      const close = page.locator('[role="dialog"][data-bar-mode]').getByRole("button", { name: "Close", exact: true }).first();
      if ((await close.count()) > 0 && (await close.isVisible())) await close.click();
      const fit = page.getByRole("button", { name: "Fit the map to the screen" });
      if ((await fit.count()) > 0 && (await wholeInReach(fit))) await fit.click();
      await page.waitForTimeout(250);
      const p = await pagePoint(page, run.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      const tag = await page.evaluate(([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null, [p.x, p.y] as const);
      if (tag !== "CANVAS") {
        skipped.push(`${label}: ${name} is under ${tag}`);
        return false;
      }
      await page.mouse.click(p.x, p.y);
      await page.getByRole("dialog", { name: `${name} actions` }).waitFor({ timeout: 5000 }).catch(() => undefined);
      return (await page.getByRole("dialog", { name: `${name} actions` }).count()) > 0;
    };
    const sidePanelShown = async (page: Page) => {
      const aside = page.locator("aside").first();
      return (await aside.count()) > 0 && ((await aside.boundingBox())?.width ?? 0) > 0;
    };

    for (const fight of ["none", "checks"] as const) {
      if (fight === "checks") {
        await ops.send({ t: "encounter.start", entries: run.goblins.map((g, i) => ({ id: randomUUID(), tokenId: g.id, value: 15 - i })) });
        for (const g of run.goblins) await ops.send({ t: "actor.effect.add", target: { tokenId: g.id }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } }).catch(() => undefined);
        await ops.send({ t: "roll.ask", request: { id: randomUUID(), test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      }
      for (const scale of [1, 1.3]) {
        for (const stored of STORED) {
          await setUp(dm, { ...DESK, scale }, null, stored);
          await setUp(player, { ...DESK, scale }, null, stored);
          // Checks come up as damage arrives, so a page loaded again has none until the goblins take more.
          if (fight === "checks") {
            await damageGoblins();
            await dm.locator('[data-alert="concentration"]').nth(2).waitFor().catch(() => undefined);
          }
          for (const size of SWEEP) {
            await dm.setViewportSize(size);
            await player.setViewportSize(size);
            await dm.waitForTimeout(250);
            const wide = size.width / scale >= 900;
            for (const room of wide ? (["shown", "hidden"] as const) : (["alone", "sheet"] as const)) {
              if (wide && (await sidePanelShown(dm)) !== (room === "shown")) {
                await dm.keyboard.press("s");
                await dm.waitForTimeout(250);
              }
              if (wide && (await sidePanelShown(dm)) !== (room === "shown")) misses.push(`${size.width} x ${size.height} at ${Math.round(scale * 100)}%: S did not make the side panel ${room}`);
              const label = `${size.width} x ${size.height} at ${Math.round(scale * 100)}%, ${room}, stored ${stored ?? "none"}, ${fight}`;
              const smallest = stored === '{"w":1,"h":1}';
              for (const [cell, name] of [
                [run.goblins[1]!, "Goblin 2"],
                [run.thorn, "Thorn"],
              ] as const) {
                if (!(await open(dm, cell, name, `DM on ${name}, ${label}`))) continue;
                // The window open first, then a panel's sheet on the right beside it, as a DM on a small screen would.
                if (room === "sheet") {
                  await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
                  await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
                  await dm.locator('section[aria-label="Outliner"]').waitFor();
                  await dm.waitForTimeout(250);
                }
                // Beside the sheet, its room ends at the sheet's edge.
                const sheet = room === "sheet" ? await dm.locator('section[aria-label="Outliner"]').boundingBox() : null;
                await sweepWindow(dm, name, `DM on ${name}, ${label}`, smallest, true, sheet ? sheet.x - 2 : undefined);
                if (room === "sheet") {
                  const closeSheet = dm.getByRole("button", { name: /^Close Outliner/ }).first();
                  if (await closeSheet.isVisible()) await closeSheet.click();
                }
              }
            }
            // Pat on a touch tablet: the window keeps its default size, and no handle.
            if (await open(player, run.thorn, "Thorn", `Pat on Thorn, ${size.width} x ${size.height} at ${Math.round(scale * 100)}%, ${fight}`)) {
              await sweepWindow(player, "Thorn", `Pat on Thorn, ${size.width} x ${size.height} at ${Math.round(scale * 100)}%, stored ${stored ?? "none"}, ${fight}`, false, false);
            }
          }
          if (scale === 1.3 && stored === '{"w":4096,"h":4096}' && fight === "checks") await shots.take(dm, "token-window-sweep-largest-in-a-fight-130");
        }
      }
      if (fight === "checks") await ops.send({ t: "encounter.end" });
    }
    await setUp(dm, { ...DESK, scale: 1 });
    await sidePanelChoice(dm, null);
    console.error(`the computer's sweep: ${steps} windows, ${misses.length} misses, ${skipped.length} skipped${skipped.length ? `:\n${skipped.join("\n")}` : ""}`);
    assert.deepEqual(misses, []);
  });
}

/** A file of the sweep: its own server, browsers and room around the sweep `register` adds, then case 20 over its browsers. */
export function sweepFile(title: string, register: () => void): void {
  describe(`raccoon-vtt: the docked token action bar: ${title}`, { timeout: 900_000 }, () => {
    before(async () => {
      await openBrowsers();
      await createRoom();
    });
    after(closeAll);
    register();
    test("20. nothing went wrong in the browsers", assertNoConsoleErrors);
  });
}
