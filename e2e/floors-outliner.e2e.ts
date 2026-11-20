import assert from "node:assert/strict";
import { uuidv7 } from "#shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, openSideTab, sleep, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The outliner's Other floors group (docs/design/design-v1-floors.md phase 4,
 * 9.6), on the real server serving the production build. Dana the DM is at a
 * desk and then at phone sizes. Tower has Ground floor, Upper floor and
 * Attic. Ground holds Thorn, a goblin and Thorn's wildfire spirit, Upper an
 * imp and Thorn's twin, and Attic a bat and a hidden urn. Labels carry the
 * prefix FL4L.
 * - fl4l-0: the room on a scene of one floor: no Other floors chip, no group.
 * - fl4l-1: Tower's floors: Other floors lists the imp, the twin, the bat and
 *   the urn with their floor's name, lowest floor first, the urn marked Hidden.
 *   A search by a floor's name narrows to it. The spirit is not away from Thorn
 *   while he stands one floor up.
 * - fl4l-2: a press on the imp shows Upper floor and selects it, and the group
 *   is now the other two floors'.
 * - fl4l-3: the group at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130%
 *   within 1 px, and a press on a phone closes the sheet and shows the floor.
 * - fl4l-4: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus forty, one file after another.
 * The other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 40;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-outliner-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const BOUNDS = { w: 32, h: 18 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoleWatch = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E floors outliner ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: uuidv7(),
  attic: uuidv7(),
  thorn: uuidv7(),
  tThorn: uuidv7(),
  tTwin: uuidv7(),
  tGoblin: uuidv7(),
  tSpirit: uuidv7(),
  tImp: uuidv7(),
  tBat: uuidv7(),
  tUrn: uuidv7(),
};

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 13, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

const floorButton = (page: Page) => page.locator("header[data-rvtt-topbar]").first().locator('[data-floors="button"]');
const outliner = (page: Page) => page.getByRole("tabpanel", { name: "Outliner" }).or(page.locator('section[aria-label="Outliner"]')).first();
const chip = (page: Page, name: RegExp) => outliner(page).getByRole("group", { name: "Show one group" }).getByRole("button", { name });
const otherRows = (page: Page) => outliner(page).locator("[data-other-floor]");

/** Opens the outliner in the side panel at a desk, or from the Panels sheet on a phone. */
async function openOutliner(page: Page): Promise<Locator> {
  if ((await page.getByRole("tablist", { name: "Panels" }).count()) > 0) await openSideTab(page, "Outliner");
  else {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Outliner", exact: true }).click();
  }
  const panel = outliner(page);
  await panel.waitFor();
  return panel;
}

/** The names of the Other floors rows with their floor, top to bottom. */
async function otherNames(page: Page): Promise<string[]> {
  return otherRows(page).evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
}

async function showsFloor(page: Page, floor: string): Promise<void> {
  await waitFor(`${floor} shown`, async () => ((await floorButton(page).getAttribute("aria-label").catch(() => null)) === `Floor: ${floor}. Show another floor` ? true : null), 15_000);
}

describe("The outliner's Other floors", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    consoleWatch.attach(dm);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error("errors", consoleWatch.errors, "warnings", consoleWatch.warnings);
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
  });

  test("fl4l-0. a scene of one floor has no Other floors chip and no group", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=(.+)$/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.ground = dmSocket.state!.meta.playerSceneId!;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower" } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [], actor: actor(24) } });
    const at = { size: "medium", visibility: "all", disposition: "ally" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.ground, kind: "pc", name: "Thorn", ownerIds: [], actor: { ref: run.thorn }, x: 4, y: 4, ...at } });
    await ops.send({ t: "token.create", token: { id: run.tGoblin, sceneId: run.ground, kind: "monster", name: "Goblin", ownerIds: [], x: 8, y: 4, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: actor(10) } } });
    await ops.send({ t: "token.create", token: { id: run.tSpirit, sceneId: run.ground, kind: "npc", name: "Wildfire Spirit", ownerIds: [], x: 5, y: 4, companion: { of: run.thorn, turn: "shared" }, ...at, actor: { inline: actor(10) } } });
    const panel = await openOutliner(dm);
    await panel.getByRole("button", { name: /^Goblin/ }).waitFor();
    assert.equal(await chip(dm, /^Other floors/).count(), 0, "no chip on a scene of one floor");
    assert.equal(await otherRows(dm).count(), 0);
    await shots.take(dm, "fl4l-0-one-floor");
  });

  test("fl4l-1. Tower's floors: the group lists each creature and object above with its floor, lowest first, the urn Hidden, and a search by floor narrows it", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.attic, name: "Tower", bounds: BOUNDS }, floor: { beside: run.upper, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor" } } });
    await ops.send({ t: "scene.update", sceneId: run.attic, patch: { floor: { name: "Attic" } } });
    await waitFor("three floors in the DM's copy", () => (Object.values(dmSocket.state?.scenes ?? {}).filter((s) => s.floor !== undefined).length === 3 ? true : null));
    const at = { size: "medium", visibility: "all", disposition: "ally" } as const;
    await ops.send({ t: "token.create", token: { id: run.tImp, sceneId: run.upper, kind: "monster", name: "Imp", ownerIds: [], x: 10, y: 6, size: "small", visibility: "all", disposition: "hostile", actor: { inline: actor(10) } } });
    await ops.send({ t: "token.create", token: { id: run.tTwin, sceneId: run.upper, kind: "pc", name: "Thorn's Twin", ownerIds: [], actor: { ref: run.thorn }, x: 4, y: 4, ...at } });
    await ops.send({ t: "token.create", token: { id: run.tBat, sceneId: run.attic, kind: "monster", name: "Bat", ownerIds: [], x: 12, y: 8, size: "tiny", visibility: "all", disposition: "hostile", actor: { inline: actor(10) } } });
    await ops.send({ t: "token.create", token: { id: run.tUrn, sceneId: run.attic, kind: "object", name: "Urn", ownerIds: [], x: 3, y: 9, size: "small", visibility: "dm", disposition: "neutral", actor: { inline: actor(10) } } });
    const panel = outliner(dm);
    await chip(dm, /^Other floors/).waitFor();
    await waitFor("four rows in Other floors", async () => ((await otherRows(dm).count()) === 4 ? true : null));
    const names = await otherNames(dm);
    assert.match(names[0]!, /^Imp.*Upper floor/);
    assert.match(names[1]!, /^Thorn's Twin.*Upper floor/);
    assert.match(names[2]!, /^Bat.*Attic/);
    assert.match(names[3]!, /^Urn.*Attic.*Hidden/, "the urn, Hidden, last");
    await shots.take(dm, "fl4l-1-other-floors");
    await panel.getByLabel("Search the scene").fill("attic");
    await waitFor("the search narrows to the Attic", async () => ((await otherRows(dm).count()) === 2 ? true : null));
    assert.equal(await panel.getByRole("button", { name: /^Goblin/ }).count(), 0);
    await panel.getByLabel("Search the scene").fill("companion");
    const spirit = panel.getByRole("button", { name: /^Wildfire Spirit/ });
    await spirit.waitFor();
    assert.doesNotMatch(await spirit.innerText(), /Away from/, "Thorn's twin one floor up still counts as Thorn on the scene");
    await panel.getByLabel("Search the scene").fill("");
  });

  test("fl4l-2. a press on the imp shows Upper floor and selects it, and the group becomes Ground's and the Attic's", async () => {
    await showsFloor(dm, "Ground floor");
    await outliner(dm).locator(`[data-other-floor="${run.tImp}"]`).click();
    await showsFloor(dm, "Upper floor");
    const bar = dm.getByRole("dialog", { name: "Imp actions" });
    await bar.waitFor();
    await waitFor("the group without the imp, five long", async () => {
      const names = await otherNames(dm);
      return names.length === 5 && names.every((n) => !n.startsWith("Imp")) && names.some((n) => /^Thorn.*Ground floor/.test(n)) ? true : null;
    });
    await sleep(500);
    await shots.take(dm, "fl4l-2-imp-shown");
    await outliner(dm).locator(`[data-other-floor="${run.tBat}"]`).click();
    await showsFloor(dm, "Attic");
    await dm.getByRole("dialog", { name: "Bat actions" }).waitFor();
    await dm.keyboard.press("[");
    await dm.keyboard.press("[");
    await showsFloor(dm, "Ground floor");
  });

  test("fl4l-3. the group at 1440 x 900, 390 x 844 and 320 x 568 at 100% and 130% within 1 px, and a press on a phone closes the sheet and shows the floor", async () => {
    const lines: string[] = [];
    const setScale = (s: number) => dm.evaluate((v) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(v)), s);
    try {
      for (const size of [DESK, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
        for (const scale of [1, 1.3]) {
          const at = `${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;
          await dm.setViewportSize(size);
          await setScale(scale);
          await dm.reload();
          await dm.getByRole("status", { name: "Connected" }).first().waitFor();
          await sleep(800);
          const panel = await openOutliner(dm);
          // The list is windowed, so the chip puts the group first where a small screen would not render it.
          await chip(dm, /^Other floors/).click();
          await waitFor(`the group at ${at}`, async () => ((await otherRows(dm).count()) >= 4 ? true : null));
          const first = otherRows(dm).first();
          const box = await first.boundingBox();
          assert.ok(box && box.height >= 44, `a row is at least 44 px tall at ${at}, was ${box?.height}`);
          lines.push(...alignmentLines(await measureAlignment(panel), `${at} outliner`));
          await shots.take(dm, `fl4l-3-outliner-${at}`);
          if (size.width < 1000) {
            const name = (await first.getAttribute("data-other-floor")) ?? "";
            await first.click();
            await outliner(dm).waitFor({ state: "hidden" });
            await dm.getByRole("dialog", { name: /actions$/ }).first().waitFor();
            assert.ok(name !== "", "the row carries its creature's id");
            await shots.take(dm, `fl4l-3-picked-${at}`);
          }
        }
      }
    } finally {
      await setScale(1);
      await dm.setViewportSize(DESK);
      await dm.reload();
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    }
    assert.deepEqual(lines, [], "Other floors out of line");
  });

  test("fl4l-4. no page logged an error", () => {
    assert.deepEqual(consoleWatch.errors, []);
  });
});
