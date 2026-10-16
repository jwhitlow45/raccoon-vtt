import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * A player deletes a character they play alone (features section 15), on
 * the real server serving the production build: Pat on a phone deletes
 * Bree, with a token on the map, another on a scene Pat cannot see, a
 * companion and a row in the fight. Pat reads what goes with it first,
 * the button is busy while the delete waits, and the DM's view loses all
 * of it, the open token panel included. A character Pat shares with
 * another player, and another player's own, offer no Delete.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twelve, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 12;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-characters-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let quinContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E characters ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  roadId: randomUUID(),
  bounds: { w: 30, h: 20 },
  patId: "",
  quinId: "",
  bree: randomUUID(),
  breeToken: randomUUID(),
  breeOnTheRoad: randomUUID(),
  wisp: randomUUID(),
  cyra: randomUUID(),
  cyraToken: randomUUID(),
  dax: randomUUID(),
  goblin: randomUUID(),
};

const WARNING = "Deleting Bree also removes its token here, 1 companion and its place in the fight, and any token of it on another map. This cannot be undone.";

function actor(hp: number) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 1,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** The Characters panel on a phone: from the tool bar's Panels list, as a sheet. */
async function openCharacters(page: Page): Promise<Locator> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (await sheet.isVisible()) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** What has focus: its tag, the `data-opener` id it carries, and its name or text. */
function focusedOn(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { tagName: string; getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
    if (!a) return "none";
    return `${a.tagName.toLowerCase()} [${a.getAttribute("data-opener") ?? ""}] ${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim()}`;
  });
}

describe("raccoon-vtt: a player deletes a character they play alone", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    quinContext = await browser.newContext();
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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
  });

  test("1. a DM's room with Pat's Bree on two scenes with a companion and in the fight, Cyra whom Pat shares with Quin, and Quin's Dax", async () => {
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

    const join = async (context: BrowserContext, name: string, color: string) => {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      return ((await done.json()) as { member: { id: string } }).member.id;
    };
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.quinId = await join(quinContext, "Quin", "#e5484d");

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.create", scene: { id: run.roadId, name: "The road", bounds: { w: 30, h: 20 } } });
    const character = (id: string, name: string, ownerIds: string[]) => ops.send({ t: "character.create", character: { id, name, size: "medium", ownerIds, actor: actor(24) } });
    await character(run.bree, "Bree", [run.patId]);
    await character(run.cyra, "Cyra", [run.patId, run.quinId]);
    await character(run.dax, "Dax", [run.quinId]);
    const token = (id: string, extra: Record<string, unknown>) => ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await token(run.breeToken, { kind: "pc", name: "Bree", x: 5, y: 5, disposition: "ally", actor: { ref: run.bree } });
    await token(run.breeOnTheRoad, { kind: "pc", name: "Bree", sceneId: run.roadId, x: 4, y: 4, disposition: "ally", actor: { ref: run.bree } });
    await token(run.wisp, { kind: "npc", name: "Wisp", x: 6, y: 5, size: "small", disposition: "ally", actor: { inline: actor(8) }, companion: { of: run.bree, turn: "shared" } });
    await token(run.cyraToken, { kind: "pc", name: "Cyra", x: 9, y: 5, disposition: "ally", actor: { ref: run.cyra } });
    await token(run.goblin, { kind: "monster", name: "Goblin", x: 14, y: 5, disposition: "hostile", actor: { inline: actor(7) } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: "e-bree", tokenId: run.breeToken, value: 18 },
        { id: "e-cyra", tokenId: run.cyraToken, value: 12 },
        { id: "e-gob", tokenId: run.goblin, value: 8 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await waitFor("the fight in the DM's view, Bree acting", () => (dmSocket.state?.encounter?.activeEntryId === "e-bree" ? true : null));

    // A new device is answered 403 by GET /me before it joins, which Chrome logs. Pat joined by request, so this is only in case.
    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  test("2. Pat's own Bree says what goes with it before Delete, Cyra whom Pat shares and Quin's Dax offer none", async () => {
    const sheet = await openCharacters(pat);
    await sheet.getByRole("button", { name: /^Bree/ }).click();
    await sheet.getByText(WARNING, { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: "Delete Bree", exact: true }).count(), 1);
    await shots.take(pat, "characters-player-delete-warning");
    // Cyra is Pat's too, played with Quin: her card opens, with no Delete.
    await sheet.getByRole("button", { name: /^Cyra/ }).click();
    await sheet.getByText(WARNING, { exact: true }).waitFor({ state: "detached" });
    await sheet.getByRole("button", { name: "Add a companion", exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: /^Delete/ }).count(), 0, "a character Pat shares offers no Delete");
    // Quin's Dax is in the party list, a row with nothing to press.
    await sheet.getByText("Dax", { exact: true }).waitFor();
    assert.equal(await sheet.getByRole("button", { name: /Dax/ }).count(), 0, "another player's character offers nothing");
    assert.equal(patSocket.everSaw(run.breeOnTheRoad), false, "the token on the road never reached Pat");
  });

  test("3. the delete waits busy while Pat is offline, then takes every token, the companion and the row, and the DM's open token panel lets go", async () => {
    // The DM has Bree's token open in its panel.
    await tapCell(dm, run.bounds, { x: 5, y: 5 });
    await dm.getByRole("dialog", { name: "Bree actions" }).getByRole("button", { name: "Details", exact: true }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token" });
    await panel.getByRole("heading", { name: "Bree" }).waitFor();

    const sheet = await openCharacters(pat);
    await sheet.getByRole("button", { name: /^Bree/ }).click();
    await sheet.getByRole("button", { name: "Delete Bree", exact: true }).tap();
    const confirm = sheet.getByRole("button", { name: "Tap again to delete", exact: true });
    await confirm.waitFor();
    await shots.take(pat, "characters-player-delete-armed");

    // Offline, the delete stays unanswered: the button is busy and takes no second delete.
    patConsole.expectSocketFailures = true;
    await patContext.setOffline(true);
    await confirm.tap();
    const busy = sheet.getByRole("button", { name: "Deleting…", exact: true });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    await shots.take(pat, "characters-player-delete-busy");
    assert.ok(dmSocket.state!.characters[run.bree], "nothing went while Pat was offline");
    await patContext.setOffline(false);

    await waitFor("Bree gone for the DM", () => (dmSocket.state && !dmSocket.state.characters[run.bree] ? true : null), 30_000);
    const state = dmSocket.state!;
    for (const id of [run.breeToken, run.breeOnTheRoad, run.wisp]) assert.equal(state.tokens[id], undefined, `token ${id} went with Bree`);
    assert.deepEqual(
      state.encounter?.entries.map((e) => e.id),
      ["e-cyra", "e-gob"],
    );
    assert.equal(state.encounter?.activeEntryId, "e-cyra", "the turn passed on");
    assert.ok(state.characters[run.cyra] && state.characters[run.dax], "the others stay");
    await panel.getByText("Tap a token to see it here.").waitFor();
    await shots.take(dm, "characters-dm-after-player-delete");

    // Pat's list now holds Cyra alone, and focus went on to her row.
    await sheet.getByRole("button", { name: /^Bree/ }).waitFor({ state: "detached" });
    const onCyra = `button [character:${run.cyra}]`;
    await waitFor("focus on Cyra's row", async () => ((await focusedOn(pat)).startsWith(onCyra) ? true : null), 5_000).catch(async () => assert.fail(`focus is on "${await focusedOn(pat)}", not Cyra's row`));
    await shots.take(pat, "characters-player-after-delete");
    patConsole.expectSocketFailures = false;
  });

  test("4. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
    assert.deepEqual(patConsole.errors, [], "Pat's page logged errors");
  });
});
