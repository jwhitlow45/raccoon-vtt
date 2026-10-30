import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Actor, LogEntry } from "#shared/model.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, companionBlock } from "#shared/testutil.ts";
import type { CorrectionLogEvent, HistoryMessage } from "#shared/undoContract.ts";
import { ConsoleWatch, Shots, SocketWatch, openSideTab, pickTool, startServer, untilReady, waitFor, type Server } from "./harness.ts";
import { UndoWire, historyOf, playControl, setupHistory } from "./helpers/undoScope.ts";

const PORT = Number(process.env.E2E_PORT ?? 3100) + 4;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
const work = mkdtempSync(path.join(tmpdir(), "raccoon-undo-scope-"));
const ids = { bree: randomUUID(), pc: randomUUID(), goblin: randomUUID(), moth: randomUUID() };
const roomName = `Undo scope ${randomUUID()}`;
const password = "undo-scope-owlbear-wand";
let server: Server;
let browser: Browser;
let roomId = "";
let sceneId = "";
let ownId = "";
let dmWire: UndoWire;
let coWire: UndoWire;
const clients: { context: BrowserContext; page: Page; watch: SocketWatch; console: ConsoleWatch }[] = [];
const dm = () => clients[0]!;
const second = () => clients[1]!;
const co = () => clients[2]!;
const owner = () => clients[3]!;
const other = () => clients[4]!;
const cookie = (context: BrowserContext) => context.cookies(server.origin).then((values) => values.map((v) => `${v.name}=${v.value}`).join("; "));
const corrections = (lines: readonly LogEntry[]) => lines.flatMap((line) => {
  const data = line.data as LogEntry["data"] | CorrectionLogEvent;
  return data?.type === "correction" ? [data] : [];
});
const goblin = () => dm().watch.state!.tokens[ids.goblin]!;
const goblinActor = (): Actor => { const held = goblin().actor; assert.ok("inline" in held); return held.inline; };
const bree = () => dm().watch.state!.characters[ids.bree]!;
const gate = { command: false, history: false, commands: [] as (() => void)[], histories: [] as (() => void)[], sent: [] as { t?: string; n?: number; op?: { t?: string; head?: string } }[] };
const stackCommands = () => gate.sent.filter((frame) => frame.t === "op" && (frame.op?.t === "undo" || frame.op?.t === "redo"));
const releaseCommands = () => { gate.command = false; for (const send of gate.commands.splice(0)) send(); };
const releaseHistory = () => { gate.history = false; for (const send of gate.histories.splice(0)) send(); };
const frames = () => clients.map((client) => client.watch.received.length);

async function settle(): Promise<HistoryMessage> {
  const latest = await dmWire.history();
  const seq = Math.max(latest.seq, historyOf(dm().watch)?.seq ?? 0);
  await waitFor("all pages cover the committed change", () => clients.every((client) => (historyOf(client.watch)?.seq ?? -1) >= seq));
  return latest;
}
async function clickPlay(direction: "undo" | "redo") {
  const button = playControl(dm().page, direction);
  await untilReady(button, direction);
  const count = stackCommands().length;
  await button.click();
  await waitFor("Play command sent", () => stackCommands().length > count);
  const n = stackCommands().at(-1)!.n!;
  await waitFor(`Play ${direction} commits`, () => historyOf(dm().watch)!.watermark >= n);
  await settle();
}
async function clickSetup(direction: "undo" | "redo") {
  const { sheet } = await setupHistory(dm().page);
  const button = sheet.getByRole("button", { name: direction === "undo" ? "Undo setup" : "Redo setup", exact: true });
  await untilReady(button, `Setup ${direction}`);
  const count = stackCommands().length;
  await button.click();
  await waitFor("Setup command sent", () => stackCommands().length > count);
  const n = stackCommands().at(-1)!.n!;
  await waitFor(`Setup ${direction} answers`, () => historyOf(dm().watch)!.watermark >= n);
  return sheet;
}
async function closeSheet(page = dm().page) { await page.keyboard.press("Escape"); }

// This file uses tools' port offset and runs on its own, like the other browser files.
describe("undo-scope batch A", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    for (const [index, name] of ["DM", "same DM phone", "co-DM", "Bree's player", "unrelated player"].entries()) {
      const phone = index === 1 || index === 3;
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (index === 0) await page.routeWebSocket(/\/ws\?room=/, (socket) => {
        const upstream = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as (typeof gate.sent)[number];
          gate.sent.push(frame);
          if (gate.command && frame.t === "op" && (frame.op?.t === "undo" || frame.op?.t === "redo")) gate.commands.push(() => upstream.send(message));
          else upstream.send(message);
        });
        upstream.onMessage((message) => {
          const frame = JSON.parse(String(message)) as { t?: string };
          if (gate.history && frame.t === "history") gate.histories.push(() => socket.send(message));
          else socket.send(message);
        });
      });
      const watch = new SocketWatch(name);
      const console = new ConsoleWatch(name);
      await watch.attach(context, page);
      console.attach(page);
      clients.push({ context, page, watch, console });
    }
    const post = async (context: BrowserContext, route: string, data: object) => {
      const response = await context.request.post(`${server.origin}${route}`, { headers: { Origin: server.origin }, data });
      assert.ok(response.ok(), `${route}: ${response.status()}`);
      return response.json();
    };
    const created = await post(dm().context, "/api/rooms", { name: roomName, playerPassword: password, dmName: "Dungeon Master" }) as { roomId: string; dmLink: string };
    roomId = created.roomId;
    await second().context.addCookies(await dm().context.cookies(server.origin));
    await post(co().context, `/api/rooms/${roomId}/dm`, { key: created.dmLink.split("#dm=")[1], name: "Co-DM" });
    for (const [client, name] of [[owner(), "Ana"], [other(), "Cy"]] as const) {
      const { ticket } = await post(client.context, `/api/rooms/${roomId}/join`, { password }) as { ticket: string };
      await post(client.context, `/api/rooms/${roomId}/join/complete`, { ticket, name, color: "#3e8ef7" });
    }
    for (const client of clients) {
      await client.page.goto(`${server.origin}/r/${roomId}`);
      await waitFor("page snapshot and private history", () => client.watch.state && historyOf(client.watch));
    }
    sceneId = dm().watch.state!.meta.playerSceneId!;
    ownId = owner().watch.you!.memberId;
    dmWire = await UndoWire.open({ origin: server.origin, roomId, cookie: await cookie(dm().context) });
    coWire = await UndoWire.open({ origin: server.origin, roomId, cookie: await cookie(co().context) });
    await coWire.apply({ t: "character.create", character: { id: ids.bree, name: "Bree", size: "medium", ownerIds: [ownId], level: 4, stats: structuredClone(EMPTY_PC_STATS), actor: actor({ dmNotes: "", initBonus: 0, passivePerception: 10, hp: { cur: 30, max: 30, temp: 0 } }) } });
    await coWire.apply({ t: "token.create", token: { id: ids.pc, sceneId, kind: "pc", name: "Bree", size: "medium", x: 8, y: 5, actor: { ref: ids.bree } } });
    await coWire.apply({ t: "token.create", token: { id: ids.goblin, sceneId, kind: "monster", name: "Goblin 2", size: "medium", x: 3, y: 3, actor: { inline: actor({ dmNotes: "" }) } } });
    const { rev: _rev, ...block } = companionBlock(ids.moth, ids.bree, { name: "Moth" });
    await coWire.apply({ t: "companionBlock.create", block });
    await settle();
  });

  after(async () => {
    dmWire?.close();
    coWire?.close();
    if (roomId && clients[0]) await dm().context.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } });
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("undo-scope-empty-play: ordinary Undo never falls back to Setup, focused Setup shortcuts use its own history", async () => {
    await dmWire.apply({ t: "token.update", tokenId: ids.goblin, patch: { actor: { ac: 18 } } });
    await settle();
    assert.equal(historyOf(dm().watch)!.play.undo.depth, 0);
    assert.ok(await playControl(dm().page, "undo").isDisabled());
    const commands = stackCommands().length;
    await dm().page.keyboard.press("ControlOrMeta+z");
    assert.equal(stackCommands().length, commands);
    assert.equal(goblinActor().ac, 18);
    const { sheet, opener } = await setupHistory(dm().page);
    await sheet.getByRole("button", { name: "Undo setup", exact: true }).focus();
    await dm().page.keyboard.press("ControlOrMeta+z");
    await waitFor("focused Setup Undo", () => goblinActor().ac === 14);
    await dm().page.keyboard.press("ControlOrMeta+Shift+z");
    await waitFor("focused Setup Redo", () => goblinActor().ac === 18);
    await dm().page.keyboard.press("Escape");
    assert.ok(await opener.evaluate((button) => button === button.ownerDocument.activeElement));
  });

  test("undo-scope-1-pose: toolbar Undo and Redo preserve later AC, and each DM has private histories", async () => {
    await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 6, y: 3 });
    await dmWire.apply({ t: "token.update", tokenId: ids.goblin, patch: { actor: { ac: 19 } } });
    const before = await settle();
    assert.ok(before.play.undo.head && before.setup?.undo.head);
    assert.equal(historyOf(second().watch)?.play.undo.head?.id, before.play.undo.head.id);
    assert.notEqual(historyOf(co().watch)?.setup?.undo.head?.id, before.setup.undo.head.id);
    await clickPlay("undo");
    assert.equal(goblin().x, 3);
    assert.equal(goblinActor().ac, 19);
    await clickPlay("redo");
    assert.equal(goblin().x, 6);
    assert.equal(goblinActor().ac, 19);
    for (const client of [owner(), other()]) {
      assert.equal(historyOf(client.watch)?.setup, undefined);
      assert.ok(!client.watch.everSaw(before.setup.undo.head.id));
      await openSideTab(client.page, "Menu");
      assert.equal(await client.page.getByRole("button", { name: /^Setup history/ }).count(), 0);
    }
    await shots.take(dm().page, "undo-scope-pose-preserves-ac");
  });

  test("undo-scope-1-retention: setup behind a hit, then Play Redo behind Setup Redo, keeps its head and names the prerequisite", async () => {
    const stats = { ...bree().stats!, abilities: { ...bree().stats!.abilities, cha: 18 } };
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { stats } });
    await dmWire.apply({ t: "actor.hp", target: { characterId: ids.bree }, change: { kind: "damage", amount: 4 } });
    const before = await settle();
    let sheet = await clickSetup("undo");
    await sheet.getByText(/^Undo the play step first:/).waitFor();
    assert.equal(historyOf(dm().watch)?.setup?.undo.head?.id, before.setup!.undo.head!.id);
    await sheet.getByRole("button", { name: "Review step", exact: true }).click();
    await sheet.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await shots.take(dm().page, "undo-scope-retained-setup");
    await closeSheet();
    await clickPlay("undo");
    sheet = await clickSetup("undo");
    await closeSheet();
    await clickPlay("redo");
    const kept = historyOf(dm().watch)!.play.redo.head!;
    assert.equal(kept.retained?.scope, "setup");
    assert.equal(kept.retained?.direction, "redo");
    await dm().page.getByRole("button", { name: "Review step", exact: true }).last().click();
    const review = dm().page.getByRole("dialog", { name: "Play history", exact: true });
    await review.getByText(/^Redo the setup step first:/).waitFor();
    await shots.take(dm().page, "undo-scope-play-redo-prerequisite");
    await closeSheet();
    sheet = await clickSetup("redo");
    await closeSheet();
    await clickPlay("redo");
    assert.equal(bree().stats?.abilities.cha, 18);
    assert.equal(bree().actor.hp.cur, 26);
    await clickPlay("undo");
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { stats: { abilities: { ...bree().stats!.abilities, cha: 20 } } } });
    await settle();
    await clickPlay("redo");
    assert.equal(historyOf(dm().watch)!.play.redo.head?.retained?.direction, "undo", "a new still-applied Setup edit blocks Play Redo");
    await clickSetup("undo");
    await closeSheet();
    await clickPlay("redo");
    assert.equal(bree().stats?.abilities.cha, 18);
    await dmWire.apply({ t: "actor.hp", target: { characterId: ids.bree }, change: { kind: "damage", amount: 1 } });
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 24 } } });
    await settle();
    await clickPlay("undo");
    assert.equal(historyOf(dm().watch)!.play.undo.head?.retained?.scope, "setup", "damage before setup retains the whole damage step");
    await clickSetup("undo");
    await closeSheet();
    await clickPlay("undo");
    assert.equal(bree().actor.hp.cur, 26);
  });

  test("undo-scope-1-notices: Evasion, formulas and companion action text notify only the owner with Actor unchanged", async () => {
    const patches = [
      { evasion: true },
      { rolls: [{ id: randomUUID(), name: "Arcane bolt", kind: "spell", dice: [{ formula: "2d6+3", type: "fire" }] }] },
    ];
    for (const patch of patches) {
      const actorBefore = structuredClone(bree().actor);
      const marks = frames();
      await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { stats: { ...bree().stats!, ...patch } } });
      await settle();
      assert.deepEqual(bree().actor, actorBefore);
      const counts = [owner(), other()].map((client) => corrections(client.watch.state!.log).length);
      await clickSetup("undo");
      await closeSheet();
      await settle();
      await waitFor("owner correction", () => corrections(owner().watch.state!.log).length === counts[0]! + 1);
      assert.equal(corrections(other().watch.state!.log).length, counts[1]);
      for (const index of [3, 4]) for (const raw of clients[index]!.watch.received.slice(marks[index])) {
        assert.ok(!/"type":"correction"[^}]*"label":/.test(raw), "player payload never carries the DM's exact phrase");
      }
    }
    const actorBefore = structuredClone(bree().actor);
    const characterBefore = structuredClone(bree());
    await dmWire.apply({ t: "companionBlock.update", blockId: ids.moth, patch: { actions: [{ name: "Flash", text: "The moth emits a spark." }] } });
    await settle();
    assert.deepEqual(bree(), characterBefore);
    const before = corrections(owner().watch.state!.log).length;
    await clickSetup("undo");
    await closeSheet();
    await settle();
    assert.deepEqual(bree().actor, actorBefore);
    await waitFor("companion owner correction", () => corrections(owner().watch.state!.log).length === before + 1);
  });

  test("undo-scope-1-discard: retained step opens a confirmation, stale confirmation preserves the replacement, co-DM conflicts drop", async () => {
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 20 } } });
    await dmWire.apply({ t: "actor.hp", target: { characterId: ids.bree }, change: { kind: "damage", amount: 1 } });
    await settle();
    let sheet = await clickSetup("undo");
    await sheet.getByRole("button", { name: "Review step", exact: true }).click();
    await sheet.getByRole("button", { name: "Discard this step", exact: true }).click();
    const confirm = dm().page.getByRole("dialog", { name: "Discard this step", exact: true });
    await confirm.getByText("Discard this undo step? The game stays as it is.", { exact: true }).waitFor();
    await shots.take(dm().page, "undo-scope-discard-confirmation");
    await dmWire.apply({ t: "room.update", settings: { playersApplyDamage: true } });
    const replacement = await settle();
    await confirm.getByRole("button", { name: "Discard this step", exact: true }).click();
    await sheet.getByText("Setup history changed. Check the next change.", { exact: true }).waitFor();
    assert.equal(historyOf(dm().watch)?.setup?.undo.head?.id, replacement.setup?.undo.head?.id);
    await closeSheet();
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 21 } } });
    await coWire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 22 } } });
    await settle();
    const depth = historyOf(dm().watch)!.setup!.undo.depth;
    sheet = await clickSetup("undo");
    assert.equal(historyOf(dm().watch)!.setup!.undo.depth, depth - 1);
    assert.equal(historyOf(dm().watch)!.setup!.undo.head?.retained, undefined);
    assert.equal(bree().actor.ac, 22);
    assert.equal(await sheet.getByRole("button", { name: "Discard this step", exact: true }).count(), 0);
    await closeSheet();
    await dmWire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 23 } } });
    await dmWire.apply({ t: "actor.hp", target: { characterId: ids.bree }, change: { kind: "damage", amount: 1 } });
    await settle();
    sheet = await clickSetup("undo");
    const state = structuredClone(dm().watch.state);
    const count = historyOf(dm().watch)!.setup!.undo.depth;
    await sheet.getByRole("button", { name: "Review step", exact: true }).click();
    await sheet.getByRole("button", { name: "Discard this step", exact: true }).click();
    await dm().page.getByRole("dialog", { name: "Discard this step", exact: true }).getByRole("button", { name: "Discard this step", exact: true }).click();
    await sheet.getByText("Discarded this step. The game stays as it is.", { exact: true }).waitFor();
    assert.equal(historyOf(dm().watch)!.setup!.undo.depth, count - 1);
    assert.deepEqual(dm().watch.state, state, "confirmed discard changes no game state or log");
    await closeSheet();
  });

  test("undo-scope-2-boundary: board edits and HP maximum stay Play, scene settings stay Setup, phone access restores focus", async () => {
    const noticeCount = corrections(owner().watch.state!.log).length;
    await dmWire.apply({ t: "build.paint", sceneId, terrain: "stone", cells: ["1,1"] });
    await settle();
    await pickTool(dm().page, "Map builder");
    const builderUndo = dm().page.getByRole("button", { name: "Undo your last change", exact: true });
    await untilReady(builderUndo, "Builder Undo");
    await builderUndo.click();
    await waitFor("Builder Undo removes the paint", () => !Object.values(dm().watch.state!.buildChunks).some((chunk) => chunk.cells["1,1"] === "stone"));
    await settle();
    await dm().page.keyboard.press("ControlOrMeta+Shift+z");
    await waitFor("board Redo", () => Object.values(dm().watch.state!.buildChunks).some((chunk) => chunk.cells["1,1"] === "stone"));
    assert.equal(corrections(owner().watch.state!.log).length, noticeCount);
    await dmWire.apply({ t: "scene.update", sceneId, patch: { name: "Prepared cavern" } });
    await settle();
    await clickPlay("undo");
    assert.equal(dm().watch.state!.scenes[sceneId]!.name, "Prepared cavern");
    const max = bree().actor.hp.max;
    await dmWire.apply({ t: "actor.hp", target: { characterId: ids.bree }, change: { kind: "set", max: max + 5 } });
    await settle();
    await clickPlay("undo");
    assert.equal(bree().actor.hp.max, max);
    const { sheet, opener } = await setupHistory(second().page);
    await sheet.getByRole("button", { name: "Undo setup", exact: true }).waitFor();
    await shots.take(second().page, "undo-scope-phone-setup-history");
    await second().page.keyboard.press("Escape");
    assert.ok(await opener.evaluate((button) => button === button.ownerDocument.activeElement), "Escape restores the opener's focus");
  });

  test("undo-scope-4-delayed: a captured Undo or Redo cannot consume a replacement from the other DM device", async () => {
    for (const direction of ["undo", "redo"] as const) {
      await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 11, y: 3 });
      if (direction === "redo") await dmWire.restore("play");
      await settle();
      const captured = historyOf(dm().watch)!.play[direction].head!.id;
      const button = playControl(dm().page, direction);
      await untilReady(button, `delayed ${direction}`);
      gate.command = true;
      try {
        await button.click();
        await waitFor("captured outgoing history command", () => gate.commands.length === 1);
        assert.equal(stackCommands().at(-1)!.op!.head, captured);
        await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 12, y: 3 });
        if (direction === "redo") await dmWire.restore("play");
        const replacement = await dmWire.history();
        await settle();
        const pose = { x: goblin().x, y: goblin().y };
        releaseCommands();
        await dm().page.getByText("Play history changed. Check the next change.", { exact: true }).first().waitFor();
        await settle();
        assert.deepEqual(historyOf(dm().watch)!.play, replacement.play);
        assert.deepEqual({ x: goblin().x, y: goblin().y }, pose);
      } finally { releaseCommands(); }
    }
  });

  test("undo-scope-4-activation: pointer double activation across an ack reuses its intent, held keys do not repeat, separate keys wait for history", async () => {
    await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 14, y: 3 });
    await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 15, y: 3 });
    await settle();
    const undo = playControl(dm().page, "undo");
    await untilReady(undo, "first pointer Undo");
    const before = stackCommands().length;
    await undo.click({ clickCount: 1 });
    await waitFor("first pointer Undo committed", () => goblin().x === 14);
    await settle();
    await undo.click({ clickCount: 2 });
    await dmWire.apply({ t: "log.chat", text: "Pointer sequence barrier" });
    await settle();
    assert.equal(stackCommands().length, before + 1, "the platform's second click sends no second Undo");
    assert.equal(goblin().x, 14);

    await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 16, y: 3 });
    await dmWire.apply({ t: "token.move", tokenId: ids.goblin, x: 17, y: 3 });
    await settle();
    await undo.focus();
    gate.history = true;
    const start = stackCommands().length;
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    try {
      await dm().page.keyboard.down(modifier);
      await dm().page.keyboard.down("z");
      await dm().page.keyboard.down("z");
      await dm().page.keyboard.up("z");
      await dm().page.keyboard.up(modifier);
      await waitFor("ack delivered while history waits", () => goblin().x === 16 && gate.histories.length > 0);
      assert.equal(stackCommands().length, start + 1, "repeated keydown does not repeat Undo");
      await dm().page.keyboard.press("ControlOrMeta+z");
      assert.equal(stackCommands().length, start + 1, "a separate keydown waits for the preceding command's summary");
      await dm().page.getByText("Loading undo history…", { exact: true }).first().waitFor();
      await shots.take(dm().page, "undo-scope-waiting-for-history");
      releaseHistory();
      await waitFor("second deliberate Undo", () => stackCommands().length === start + 2 && goblin().x === 14);
      await settle();
      const last = stackCommands().slice(-2).map((frame) => frame.op!.head);
      assert.notEqual(last[0], last[1], "separate activations capture consecutive heads");
    } finally {
      releaseHistory();
      await dm().page.keyboard.up("z");
      await dm().page.keyboard.up(modifier);
    }
  });

  test("undo-scope-2-native: typing in a text field uses native Undo without changing either history", async () => {
    await openSideTab(dm().page, "Menu");
    await dm().page.getByRole("button", { name: /^Room settings/ }).click();
    const name = dm().page.getByRole("textbox", { name: "Room name", exact: true });
    await name.waitFor();
    const before = await dmWire.history();
    const commands = stackCommands().length;
    await name.focus();
    await name.press("End");
    await name.pressSequentially(" temporary");
    await name.press("ControlOrMeta+z");
    assert.equal(await name.inputValue(), roomName);
    assert.equal(stackCommands().length, commands);
    assert.deepEqual((await dmWire.history()).play, before.play);
    assert.deepEqual((await dmWire.history()).setup, before.setup);
    await name.press("Escape");
  });

  test("undo-scope-4-offline: another device changes history, reconnect takes its current head and never another member's", async () => {
    const retired = historyOf(dm().watch)!;
    dm().console.allow = [/WebSocket/, /ERR_INTERNET_DISCONNECTED/, /ERR_NETWORK_CHANGED/];
    try {
      await dm().context.setOffline(true);
      await dm().page.getByRole("status", { name: "Connected" }).first().waitFor({ state: "hidden" });
      const { sheet } = await setupHistory(second().page);
      const undo = sheet.getByRole("button", { name: "Undo setup", exact: true });
      await untilReady(undo, "second device Setup Undo");
      await undo.click();
      await waitFor("second device advances history", () => historyOf(second().watch)!.serial > retired.serial);
      const next = historyOf(second().watch)!;
      await closeSheet(second().page);
      await dm().context.setOffline(false);
      await dm().page.reload();
      await waitFor("reconnected history", () => historyOf(dm().watch)?.serial === next.serial);
      assert.deepEqual(historyOf(dm().watch)?.setup, next.setup);
      assert.equal(historyOf(dm().watch)?.epoch, next.epoch);
      assert.equal(historyOf(owner().watch)?.setup, undefined);
    } finally {
      await dm().context.setOffline(false);
      dm().console.allow = [];
    }
  });

  test("undo-scope-2-player: an owner's sheet save preserves movement Redo without adding Setup history", async () => {
    const wire = await UndoWire.open({ origin: server.origin, roomId, cookie: await cookie(owner().context) });
    try {
      await wire.apply({ t: "token.move", tokenId: ids.pc, x: 10, y: 5 });
      await wire.restore("play");
      const before = await wire.history();
      await wire.apply({ t: "character.update", characterId: ids.bree, patch: { actor: { ac: 23 } } });
      const after = await wire.history();
      assert.deepEqual(after.play.redo, before.play.redo);
      assert.equal(after.setup, undefined);
      await settle();
      const redo = playControl(owner().page, "redo");
      await untilReady(redo, "player movement Redo after a sheet save");
      await redo.click();
      await waitFor("player Redo restores only the pose", () => owner().watch.state!.tokens[ids.pc]?.x === 10);
      assert.equal(owner().watch.state!.characters[ids.bree]!.actor.ac, 23);
    } finally { wire.close(); }
  });

  test("undo-scope-2-forget: Setup Undo and Redo ask against current map memory, cancel and stale yes preserve it", async () => {
    for (const direction of ["undo", "redo"] as const) {
      const cavern = randomUUID();
      const tokenId = randomUUID();
      const name = `Remembered cavern ${direction}`;
      await coWire.apply({ t: "scene.create", scene: { id: cavern, name, bounds: { w: 80, h: 64 }, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "bright" } } });
      for (let y = 0; y < 64; y += 16) await coWire.apply({ t: "build.rect", sceneId: cavern, terrain: "stone", x: 0, y, w: 80, h: 16 });
      await coWire.apply({ t: "token.create", token: { id: tokenId, sceneId: cavern, kind: "pc", name: "Bree", size: "medium", x: 40, y: 32, disposition: "ally", actor: { ref: ids.bree } } });
      const visitAndLeave = async () => {
        await coWire.apply({ t: "room.setPlayerScene", sceneId: cavern });
        await waitFor("the whole cavern is explored", () => { const state = owner().watch.state; return state?.meta.playerSceneId === cavern && !isCellFullyFogged(state.fogTiles, cavern, { x: 79, y: 63 }); });
        await coWire.apply({ t: "room.setPlayerScene", sceneId });
        await waitFor("players leave the remembered cavern", () => owner().watch.state?.meta.playerSceneId === sceneId);
      };
      await visitAndLeave();
      await dmWire.apply({ t: "build.rect", sceneId: cavern, terrain: "wood", x: 0, y: 0, w: 80, h: 16 }, { g: randomUUID(), groupScope: "setup" });
      if (direction === "redo") await dmWire.restore("setup");
      // Refresh the remembered baseline without changing the target's guarded build chunk.
      await visitAndLeave();
      for (let y = 16; y < 64; y += 16) await coWire.apply({ t: "build.rect", sceneId: cavern, terrain: "grass", x: 0, y, w: 80, h: 16 });
      await openSideTab(dm().page, "Scenes");
      await dm().page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
      await waitFor("DM's cavern view", () => dm().watch.you?.sceneId === cavern);
      await settle();
      const head = historyOf(dm().watch)!.setup![direction].head!.id;
      const before = structuredClone({ chunks: dm().watch.state!.buildChunks, memory: dm().watch.state!.memory, explored: dm().watch.state!.exploredTiles });
      let sheet = await clickSetup(direction);
      await sheet.getByText("Players' remembered map here will be forgotten. Go ahead?", { exact: true }).waitFor();
      assert.equal(historyOf(dm().watch)!.setup![direction].head!.id, head);
      await shots.take(dm().page, `undo-scope-setup-${direction}-forget`);
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.deepEqual({ chunks: dm().watch.state!.buildChunks, memory: dm().watch.state!.memory, explored: dm().watch.state!.exploredTiles }, before);
      await closeSheet();
      sheet = await clickSetup(direction);
      const question = stackCommands().at(-1)!.n!;
      const wrongClient = await dmWire.send({ t: direction, scope: "setup", head, forget: question });
      assert.equal(wrongClient.rejects?.[0]?.code, "invalid", "a different device cannot answer this question's command number");
      if (direction === "undo") {
        await dmWire.apply({ t: "room.update", settings: { playersApplyDamage: !dm().watch.state!.meta.settings.playersApplyDamage } });
        const replacement = await settle();
        await sheet.getByRole("button", { name: "Forget and undo", exact: true }).click();
        await sheet.getByText("Setup history changed. Check the next change.", { exact: true }).waitFor();
        assert.equal(historyOf(dm().watch)!.setup!.undo.head!.id, replacement.setup!.undo.head!.id);
        assert.deepEqual({ chunks: dm().watch.state!.buildChunks, memory: dm().watch.state!.memory, explored: dm().watch.state!.exploredTiles }, before);
        await closeSheet();
        await dmWire.restore("setup");
        await settle();
        sheet = await clickSetup(direction);
      }
      await sheet.getByRole("button", { name: direction === "undo" ? "Forget and undo" : "Forget and redo", exact: true }).click();
      await waitFor("confirmed Setup restore", () => historyOf(dm().watch)!.setup![direction].head?.id !== head);
      await settle();
      assert.equal(dm().watch.state!.buildChunks[`${cavern}:0,0`]?.cells["0,0"], direction === "undo" ? "stone" : "wood");
      assert.notDeepEqual(dm().watch.state!.exploredTiles, before.explored, "confirmed restore forgets part of the remembered map");
      await closeSheet();
    }
  });

  test("undo-scope-7-legacy: queued raw commands refuse and later chat proceeds without consuming any head", async () => {
    const old = await UndoWire.open({ origin: server.origin, roomId, cookie: await cookie(dm().context) });
    try {
      const before = await old.history();
      for (const op of [{ t: "undo" }, { t: "redo" }, { t: "undo", of: 1 }]) {
        const refused = await old.send(op);
        assert.equal(refused.rejects?.[0]?.message, "Reload to use Undo");
      }
      await old.apply({ t: "log.chat", text: "The old queue continued." });
      const after = await old.history();
      assert.deepEqual(after.play, before.play);
      assert.deepEqual(after.setup, before.setup);
      await settle();
      assert.ok(dm().watch.state!.log.some((line) => line.text === "The old queue continued."));
    } finally { old.close(); }
  });

  test("undo-scope-console: no unexpected browser errors", () => {
    for (const client of clients) assert.deepEqual(client.console.errors, [], client.watch.label);
  });
});
