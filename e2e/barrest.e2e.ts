import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The token action bar at rest on a phone held upright
 * (docs/design-v1-bar-compact.md): a strip at the foot of the map that
 * stays put as the map pans and keeps every token in reach, and Expand,
 * which shows the whole bar.
 *
 * The room is the design's measuring room (section 1): a 30 x 20 map
 * with Pat's Thorn in its middle, goblins below and right of him, and a
 * token of each size at the edges and corners. The DM and Pat each play
 * from a phone. Frame steps carry `br-f-` and content steps `br-c-`.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with the phone files, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-barrest-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** The map, in cells. */
const BOUNDS = { w: 30, h: 20 };
/** An upright phone, the size the 2 s probes run at. */
const PHONE = { width: 390, height: 844 };
/** The four phones the design measures, by their window and interface size. */
const PHONES = [
  { width: 390, height: 844, scale: 1 },
  { width: 375, height: 667, scale: 1 },
  { width: 440, height: 956, scale: 1 },
  { width: 320, height: 568, scale: 1.3 },
] as const;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let patContext: BrowserContext;
let pat: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

/** A token placed in the room: its id, name and cell. */
type Placed = { id: string; name: string; x: number; y: number };
const placed = (name: string, x: number, y: number): Placed => ({ id: randomUUID(), name, x, y });

const run = {
  roomId: "",
  roomName: `E2E resting bar ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thorn: { ...placed("Thorn", 15, 10), characterId: randomUUID(), entryId: randomUUID() },
  /** Below and right of Thorn. */
  goblin1: placed("Goblin 1", 17, 12),
  goblin2: placed("Goblin 2", 16, 13),
  /** A token of each size at the map's edges and corners. */
  darkmantle: placed("Darkmantle", 0, 0),
  allosaurus: placed("Allosaurus", 28, 0),
  dragon: placed("Adult Black Dragon", 0, 17),
  ancient: placed("Ancient Black Dragon", 26, 16),
  goblinTop: placed("Goblin Top", 15, 0),
  goblinBottom: placed("Goblin Bottom", 15, 19),
  goblinLeft: placed("Goblin Left", 0, 10),
  goblinRight: placed("Goblin Right", 29, 10),
  /** Objects with no HP: the DM's barrel and Pat's lantern. */
  barrel: placed("Barrel", 12, 8),
  lantern: placed("Lantern", 13, 12),
};

/** The tokens at the edges and corners, which a reach sweep pans into the band above the strip. */
const EDGE_TOKENS = [run.darkmantle, run.allosaurus, run.dragon, run.ancient, run.goblinTop, run.goblinBottom, run.goblinLeft, run.goblinRight];

function actor(hp: number, ac = 14) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac,
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

/** Sets a phone's window and interface size, then loads the room again. */
async function setUp(page: Page, view: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

describe("raccoon-vtt: the token bar rests on an upright phone (docs/design-v1-bar-compact.md)", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    pat = await patContext.newPage();
    patConsole.attach(pat);
    await patSocket.attach(patContext, pat);
    patCdp = await patContext.newCDPSession(pat);
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

  test("br-0. the DM's room on a 30 x 20 map, Pat's Thorn in its middle, goblins by him and a token of each size at the edges, the DM and Pat on phones", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
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

    // Pat joins from his phone, whose cookies the request shares.
    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (t: Placed, extra: Record<string, unknown>) => ({ t: "token.create", token: { id: t.id, sceneId: run.sceneId, name: t.name, x: t.x, y: t.y, size: "medium", visibility: "all", ...extra } });
    const monster = (t: Placed, size: string, hp: number) => ops.send(token(t, { kind: "monster", size, disposition: "hostile", actor: { inline: actor(hp, 15) } }));
    await ops.send(token(run.thorn, { kind: "pc", disposition: "ally", actor: { ref: run.thorn.characterId } }));
    await monster(run.goblin1, "medium", 7);
    await monster(run.goblin2, "medium", 7);
    await monster(run.darkmantle, "small", 22);
    await monster(run.allosaurus, "large", 51);
    await monster(run.dragon, "huge", 195);
    await monster(run.ancient, "gargantuan", 367);
    for (const t of [run.goblinTop, run.goblinBottom, run.goblinLeft, run.goblinRight]) await monster(t, "medium", 7);
    await ops.send(token(run.barrel, { kind: "object", disposition: "neutral", actor: { inline: actor(0, 10) } }));
    await ops.send(token(run.lantern, { kind: "object", size: "small", disposition: "ally", ownerIds: [run.patId], actor: { inline: actor(0, 10) } }));

    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    for (const t of [run.thorn, ...EDGE_TOKENS, run.goblin1, run.goblin2, run.barrel, run.lantern]) {
      await waitFor(`${t.name} on Pat's map`, () => patSocket.state?.tokens[t.id]);
      await waitFor(`${t.name} on the DM's map`, () => dmSocket.state?.tokens[t.id]);
    }
    await shots.take(pat, "barrest-room-pat");
  });

  // ------------------------------------------------------------ br-f: the frame (lane F)

  describe("br-f: the strip's place, reach and the clearing move", () => {});

  // ------------------------------------------------------------ br-c: the content (the content lane)

  describe("br-c: the strip's header, HP entry and quick row", () => {
    // Imported here, so the content's steps touch no line of the file's own setup.
    type Locator = import("playwright-core").Locator;
    const harness = () => import("./harness.ts");
    // The fit rule itself, by a path the server's typecheck does not follow: it covers e2e and stops at the client's JSX.
    const STRIP: string = "../client/canvas/barButtons.ts";
    const strip = async () => (await import(STRIP)) as { restFit(widths: Readonly<Record<string, number>>, room: number, gap: number, fieldMin: number): string[] };
    const alignment = () => import("./helpers/alignment.ts");

    /** The little of the page's DOM the in-page measures use, since e2e has no DOM types. */
    type PageBox = { left: number; right: number; width: number };
    type PageEl = {
      dataset: Record<string, string | undefined>;
      firstElementChild: PageEl | null;
      style: { flex: string; cssText: string };
      offsetWidth: number;
      textContent: string | null;
      cloneNode(deep: boolean): PageEl;
      querySelector(selector: string): PageEl | null;
      querySelectorAll(selector: string): Iterable<PageEl>;
      closest(selector: string): PageEl | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): PageBox;
      append(node: PageEl): void;
      replaceChildren(...nodes: PageEl[]): void;
      remove(): void;
    };
    type PageGlobals = { document: { createElement(tag: string): PageEl; activeElement: PageEl | null }; getComputedStyle(el: PageEl): { columnGap: string; visibility: string } };

    /** A token's bar, by its frame's name. */
    const barOf = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
    const socketOf = (page: Page) => (page === dm ? dmSocket : patSocket);

    /** Closes whatever bar is open, so the next tap lands on the map. */
    async function closeBars(page: Page): Promise<void> {
      for (const name of ["Close", "Deselect all"]) {
        const close = page.locator('[role="dialog"]').getByRole("button", { name, exact: true });
        if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().tap();
      }
      await waitFor("no bar open", async () => (await page.locator('[role="dialog"][aria-label$="actions"], [role="dialog"][aria-label$="selected tokens"]').count()) === 0);
    }

    /** Taps a token's middle on the map, where it stands now, and waits for a bar named `bar`. */
    async function tapToken(page: Page, t: Placed, bar = `${t.name} actions`): Promise<Locator> {
      const { pagePoint } = await harness();
      const now = socketOf(page).state!.tokens[t.id]!;
      const cells = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 }[now.size as string] ?? 1;
      const p = await pagePoint(page, BOUNDS, { x: now.x + cells / 2, y: now.y + cells / 2 });
      await page.touchscreen.tap(p.x, p.y);
      const frame = page.getByRole("dialog", { name: bar });
      await frame.waitFor();
      return frame;
    }

    /** Opens a token's bar afresh, as a viewer's tap does. */
    async function openBar(page: Page, t: Placed): Promise<Locator> {
      await closeBars(page);
      return tapToken(page, t);
    }

    /** The strip's state: the frame's Expand, by today's or the strip's name, and whether it rests. */
    const expandButton = (bar: Locator) => bar.getByRole("button", { name: /^(Expand|Larger)$/ });
    const collapseButton = (bar: Locator) => bar.getByRole("button", { name: /^(Collapse|Smaller)$/ });

    /** Presses a control, in the quick row where it shows there, and else behind Expand (the design's barControl). */
    async function press(bar: Locator, name: string): Promise<void> {
      const inRow = bar.locator("[data-rest-row]").getByRole("button", { name, exact: true });
      if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) {
        await inRow.first().tap();
        return;
      }
      if ((await expandButton(bar).count()) > 0) await expandButton(bar).tap();
      await bar.getByRole("button", { name, exact: true }).first().tap();
    }

    /**
     * The quick row as drawn: every candidate's id in order, those drawn,
     * each one's own width as the fit counts it (a copy laid out at its
     * natural width inside the row, so the font, the interface size and a
     * candidate the row skipped all count), the row's room and gap, and
     * the field's least width, all in the screen's px.
     */
    async function quickRow(bar: Locator) {
      return bar.locator("[data-rest-row]").first().evaluate((el) => {
        const row = el as unknown as PageEl;
        const { document, getComputedStyle } = globalThis as unknown as PageGlobals;
        const items = [...row.querySelectorAll(":scope > [data-rest-item]")];
        const box = row.getBoundingClientRect();
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;display:flex;width:max-content";
        row.append(probe);
        const widths: Record<string, number> = {};
        let fieldMin = 0;
        for (const item of items) {
          const id = item.dataset.restItem!;
          const node = item.firstElementChild;
          if (!node) {
            widths[id] = 0;
            continue;
          }
          const copy = node.cloneNode(true);
          copy.style.flex = "none";
          probe.replaceChildren(copy);
          const field = copy.querySelector("[data-rest-field]");
          const fieldWidth = field ? field.getBoundingClientRect().width : 0;
          if (field) fieldMin = fieldWidth;
          widths[id] = copy.getBoundingClientRect().width - fieldWidth;
        }
        probe.remove();
        // The field's least width is 56 layout px, so it gives the chrome's zoom for the gap, which CSS states unzoomed.
        const zoom = fieldMin > 0 ? fieldMin / 56 : box.width / Math.max(1, row.offsetWidth);
        const gap = (Number.parseFloat(getComputedStyle(row).columnGap) || 0) * zoom;
        const shown = items
          .filter((item) => {
            const r = item.getBoundingClientRect();
            return r.width > 0.5 && getComputedStyle(item).visibility !== "hidden" && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
          })
          .map((item) => item.dataset.restItem!);
        return { ids: items.map((item) => item.dataset.restItem!), shown, widths, room: box.width, gap, fieldMin: fieldMin || 56 * zoom };
      });
    }

    /** Asserts the row draws what restFit gives for its drawn widths (3.3), and returns it. */
    async function fitsByWidth(bar: Locator, label: string) {
      const { restFit } = await strip();
      const row = await quickRow(bar);
      const want = restFit(row.widths, row.room, row.gap, row.fieldMin);
      assert.deepEqual(row.shown, want, `${label}: the row draws ${row.shown.join(", ")}, the fit gives ${want.join(", ")} for ${JSON.stringify(row)}`);
      return row;
    }

    /** What the status line says, wherever it says it: the sentence that needs more room, else the line. */
    async function said(bar: Locator): Promise<string> {
      const line = bar.locator("[data-rest-status]").first();
      return (await line.getAttribute("data-rest-sentence")) ?? ((await line.textContent()) ?? "").trim();
    }

    async function alignmentOf(page: Page, root: Locator, screen: string): Promise<string[]> {
      const { alignmentLines, measureAlignment } = await alignment();
      return alignmentLines(await measureAlignment(root), screen);
    }

    test("br-c-1. the quick row per role and token, the group's, Undo move in Roll's place and Conditions from rest, fitted by drawn widths, once more with wider letters", async () => {
      await setUp(dm, PHONES[0]);
      await setUp(pat, PHONES[0]);
      const cases: { page: Page; who: string; token: Placed; ids: string[] }[] = [
        { page: dm, who: "the DM", token: run.thorn, ids: ["mode", "conditions", "roll", "multiSelect", "hidden"] },
        // A player's own token offers the door's button, which draws nothing with no door in reach, so the fit leaves it out.
        { page: pat, who: "Pat", token: run.thorn, ids: ["mode", "conditions", "door", "roll", "multiSelect"] },
        { page: pat, who: "Pat", token: run.goblin1, ids: ["multiSelect", "details"] },
        { page: dm, who: "the DM", token: run.barrel, ids: ["conditions", "roll", "multiSelect", "hidden", "details"] },
        { page: pat, who: "Pat", token: run.lantern, ids: ["conditions", "door", "roll", "multiSelect", "details"] },
      ];
      for (const c of cases) {
        const bar = await openBar(c.page, c.token);
        const label = `${c.who} on ${c.token.name} at 390 x 844`;
        const row = await fitsByWidth(bar, label);
        assert.deepEqual(row.ids, c.ids, `${label}: the candidates`);
        if (c.ids.includes("mode")) assert.equal(await said(bar), "AC 14 · HP 24/24", `${label}: the vitals in the status line`);
        await shots.take(c.page, `br-c-1-${c.page === dm ? "dm" : "pat"}-${c.token.name.toLowerCase().replace(/ /g, "-")}`);
      }

      // Undo move after a drag takes Roll's place where it fits, Conditions kept (D-261024-12), at 390 and 375.
      const { pagePoint, touchSwipe } = await harness();
      for (const view of [PHONES[0], PHONES[1]]) {
        await setUp(pat, view);
        const label = `Pat at ${view.width} x ${view.height}`;
        await openBar(pat, run.thorn);
        const before = patSocket.state!.tokens[run.thorn.id]!;
        const from = await pagePoint(pat, BOUNDS, { x: before.x + 0.5, y: before.y + 0.5 });
        const to = await pagePoint(pat, BOUNDS, { x: before.x + 1.5, y: before.y + 0.5 });
        await touchSwipe(patCdp, from, to, { steps: 10, everyMs: 20 });
        await waitFor(`${label}: Thorn one cell east`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x + 1);
        const bar = barOf(pat, "Thorn");
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).waitFor({ state: "attached" });
        const row = await fitsByWidth(bar, `${label}, Undo move`);
        assert.ok(row.ids.includes("undoMove") && row.ids.includes("roll"), `${label}: Undo move and Roll are both candidates`);
        assert.ok(row.shown.includes("undoMove") && !row.shown.includes("roll") && row.shown.includes("conditions"), `${label}: Undo move in Roll's place, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(pat, `br-c-1-undo-${view.width}`);
        await bar.locator("[data-rest-row]").getByRole("button", { name: "Undo move", exact: true }).tap();
        await waitFor(`${label}: Thorn back`, () => patSocket.state?.tokens[run.thorn.id]?.x === before.x);
      }

      // Conditions from rest: the bar expands with the drawer, focus on Conditions there, and closing the drawer rests it again.
      await setUp(pat, PHONES[0]);
      const thorn = await openBar(pat, run.thorn);
      await thorn.locator("[data-rest-row]").getByRole("button", { name: "Conditions", exact: true }).tap();
      await thorn.getByRole("group", { name: "Conditions" }).waitFor();
      await collapseButton(thorn).waitFor();
      const focused = () =>
        pat.evaluate(() => {
          const el = (globalThis as unknown as PageGlobals).document.activeElement;
          return { name: el?.textContent?.trim() ?? "", pressed: el?.getAttribute("aria-pressed") ?? null, inRow: el?.closest("[data-rest-row]") !== null };
        });
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "true", inRow: false }, "focus on the expanded bar's Conditions, pressed");
      await shots.take(pat, "br-c-1-conditions-from-rest");
      await thorn.getByRole("button", { name: "Conditions", exact: true }).tap();
      await expandButton(thorn).waitFor();
      assert.equal(await thorn.getByRole("group", { name: "Conditions" }).count(), 0, "the drawer closed");
      assert.deepEqual(await focused(), { name: "Conditions", pressed: "false", inRow: true }, "focus back on the strip's Conditions");

      // The group's strip: "3 selected", the group's entry as the lead, then Conditions, Roll, Multi-select and Hidden for the DM.
      await setUp(dm, PHONES[0]);
      const goblin = await openBar(dm, run.goblin1);
      await press(goblin, "Multi-select");
      await tapToken(dm, run.goblin2, "2 selected tokens");
      const group = await tapToken(dm, run.thorn, "3 selected tokens");
      if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
      // The header's title: its first line names the group, the status line under it.
      assert.equal(((await group.locator("strong > span").first().textContent()) ?? "").trim(), "3 selected");
      const groupRow = await fitsByWidth(group, "the DM's group at 390 x 844");
      assert.deepEqual(groupRow.ids, ["mode", "conditions", "roll", "multiSelect", "hidden"]);
      assert.equal(await said(group), "Goblin 1, Goblin 2, Thorn");
      await shots.take(dm, "br-c-1-group-dm");
      assert.deepEqual(await alignmentOf(dm, group, "the DM's group strip at 390 x 844"), []);
      await closeBars(dm);
      // Pat's group leaves out the goblins, and the status line says so.
      const patThorn = await openBar(pat, run.thorn);
      await press(patThorn, "Multi-select");
      await tapToken(pat, run.goblin1, "2 selected tokens");
      const patGroup = await tapToken(pat, run.goblin2, "3 selected tokens");
      if ((await collapseButton(patGroup).count()) > 0) await collapseButton(patGroup).tap();
      assert.deepEqual((await quickRow(patGroup)).ids, ["mode", "multiSelect"]);
      assert.equal(await said(patGroup), "Leaves out Goblin 1, Goblin 2: you cannot change their HP.");
      await shots.take(pat, "br-c-1-group-pat");
      await closeBars(pat);
      await press(await openBar(pat, run.thorn), "Multi-select");
      await closeBars(pat);

      // At 375 x 667 the row fits by drawn widths, and with the strip's letters drawn wider, Roll drops and Conditions stays.
      await setUp(pat, PHONES[1]);
      await fitsByWidth(await openBar(pat, run.thorn), "Pat at 375 x 667");
      const wide = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, bypassCSP: true, storageState: await patContext.storageState() });
      try {
        const page = await wide.newPage();
        await page.goto(`${server.origin}/r/${run.roomId}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await page.addStyleTag({ content: "[data-rest-row] button { letter-spacing: 1.5px !important; }" });
        const { pagePoint: point } = await harness();
        const t = patSocket.state!.tokens[run.thorn.id]!;
        const p = await point(page, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
        await page.touchscreen.tap(p.x, p.y);
        const bar = barOf(page, "Thorn");
        await bar.waitFor();
        const row = await fitsByWidth(bar, "Pat at 375 x 667 with wider letters");
        assert.ok(row.shown.includes("conditions") && !row.shown.includes("roll"), `Roll drops by the drawn widths, Conditions kept: ${row.shown.join(", ")}`);
        await shots.take(page, "br-c-1-wider-letters-375");
      } finally {
        await wide.close();
      }

      // Alignment of Pat's strip on Thorn at the alignment sizes.
      for (const view of [PHONES[0], { width: 390, height: 844, scale: 1.3 }, { width: 320, height: 568, scale: 1 }, PHONES[3]]) {
        await setUp(pat, view);
        const bar = await openBar(pat, run.thorn);
        assert.deepEqual(await alignmentOf(pat, bar, `Pat's strip on Thorn at ${view.width} x ${view.height} at ${view.scale * 100}%`), []);
      }
      await closeBars(pat);
    });

    /** Thorn's HP and death saves as the DM's copy holds them. */
    const thornHp = () => dmSocket.state?.characters[run.thorn.characterId]?.actor;

    /** Thorn at 0 HP, dying, his saves cleared, or whole again at 24. */
    async function thornAt(cur: 0 | 24): Promise<void> {
      if (cur === 24) await ops.send({ t: "actor.life", target: { tokenId: run.thorn.id }, life: "alive" });
      await ops.send({ t: "actor.hp", target: { tokenId: run.thorn.id }, change: { kind: "set", cur } });
      if (cur === 0) await ops.send({ t: "actor.deathSave", target: { tokenId: run.thorn.id }, ok: 0, fail: 0 });
      await waitFor(`Thorn at ${cur}`, () => thornHp()?.hp?.cur === cur && (cur > 0 || thornHp()?.life === "dying"));
    }

    test("br-c-2. the HP entry in the strip: the toggle, a mode kept from the expanded bar, invalid input, a refusal, Crit on a dying creature, a kept Crit at 320 x 568 at 130%, a group's left-out creatures and a dead line", async () => {
      await setUp(dm, PHONES[0]);
      let thorn = await openBar(dm, run.thorn);
      const row = () => thorn.locator("[data-rest-row]");
      const field = () => row().getByRole("textbox", { name: "HP change" });
      const toggle = () => row().locator("[data-rest-mode]");
      const apply = () => row().getByRole("button", { name: "Apply", exact: true });
      const mode = async () => ({ name: await toggle().getAttribute("aria-label"), sign: ((await toggle().textContent()) ?? "").trim() });

      // The toggle names its mode and draws its sign, and a tap switches Damage and Heal (D-261024-10).
      assert.deepEqual(await mode(), { name: "Damage", sign: "−" });
      await toggle().tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await toggle().tap();
      await field().fill("10");
      assert.equal(await said(thorn), "10 damage");
      await apply().tap();
      await waitFor("Thorn at 14", () => thornHp()?.hp?.cur === 14);
      assert.equal(await said(thorn), "AC 14 · HP 14/24");

      // Heal picked in the expanded bar is kept as the bar rests: the toggle shows +, and Apply heals.
      await expandButton(thorn).tap();
      await thorn.getByRole("radiogroup", { name: "What the number does" }).getByRole("radio", { name: "Heal" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.deepEqual(await mode(), { name: "Heal", sign: "+" });
      await field().fill("7");
      assert.equal(await said(thorn), "Heal 7");
      await apply().tap();
      await waitFor("Thorn at 21", () => thornHp()?.hp?.cur === 21);
      await shots.take(dm, "br-c-2-heal-kept");

      // Invalid input: the error in the status line, in the error tone and said once, and focus kept in the field.
      await field().fill("abc");
      await field().press("Enter");
      assert.equal(await said(thorn), "Use a number, such as -7, +5, =20 or t5.");
      assert.equal(((await thorn.locator('[role="status"]').filter({ hasText: "Use a number" }).count()) > 0), true, "the error is said");
      assert.equal(await field().evaluate((el) => (globalThis as unknown as PageGlobals).document.activeElement === (el as unknown as PageEl)), true, "focus stays in the field");
      await shots.take(dm, "br-c-2-error");
      await field().fill("");

      // Crit on a dying creature: in the row where it fits, pressed, and the damage counts two failed saves.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      const dying = await fitsByWidth(thorn, "the DM on a dying Thorn at 390 x 844");
      assert.ok(dying.ids.includes("crit"), "Crit is a candidate at 0 HP");
      assert.ok(dying.shown.includes("crit"), `Crit fits at 390 x 844: ${dying.shown.join(", ")}`);
      const crit = row().getByRole("button", { name: "Critical Hit (two failed Death Saves)" });
      await crit.tap();
      assert.equal(await crit.getAttribute("aria-pressed"), "true");
      await field().fill("7");
      // Its own control shows it, so the line does not name it.
      assert.equal(await said(thorn), "7 damage");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      await shots.take(dm, "br-c-2-crit-dying");

      // A kept Crit with valid text at 320 x 568 at 130%, where Crit does not fit: the status line names it, and Apply counts it.
      await thornAt(0);
      await setUp(dm, PHONES[3]);
      thorn = await openBar(dm, run.thorn);
      const small = await fitsByWidth(thorn, "the DM on a dying Thorn at 320 x 568 at 130%");
      assert.deepEqual(small.shown, ["mode"], "the lead alone");
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      assert.equal(await said(thorn), "Critical Hit");
      await field().fill("7");
      assert.equal(await said(thorn), "7 damage, Critical Hit");
      await shots.take(dm, "br-c-2-crit-kept-320");
      await apply().tap();
      await waitFor("two failed saves", () => thornHp()?.deathSaves?.fail === 2);
      // Kept into Heal, it is never sent, so never named.
      await thornAt(0);
      thorn = await openBar(dm, run.thorn);
      await expandButton(thorn).tap();
      await thorn.getByRole("checkbox", { name: "Critical Hit (two failed Death Saves)" }).check({ force: true });
      await collapseButton(thorn).tap();
      await toggle().tap();
      await field().fill("5");
      assert.equal(await said(thorn), "Heal 5");
      await field().fill("");
      await thornAt(24);

      // A refusal: with "players apply damage", Pat's =20 on a goblin, Apply disabled.
      await ops.send({ t: "room.update", settings: { playersApplyDamage: true } });
      try {
        await setUp(pat, PHONES[0]);
        const goblin = await openBar(pat, run.goblin1);
        const goblinField = goblin.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" });
        await goblinField.fill("=20");
        assert.equal(await said(goblin), "You can only deal damage to or heal this creature.");
        assert.equal(await goblin.locator("[data-rest-row]").getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        await shots.take(pat, "br-c-2-refusal");
        await goblinField.fill("");
      } finally {
        await ops.send({ t: "room.update", settings: { playersApplyDamage: false } });
      }

      // A group's left-out creatures: Pat's Thorn and two goblins, 7 typed, at 390 x 844 and in the note at 320 x 568 at 130%.
      for (const view of [PHONES[0], PHONES[3]]) {
        await setUp(pat, view);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await tapToken(pat, run.goblin1, "2 selected tokens");
        const group = await tapToken(pat, run.goblin2, "3 selected tokens");
        if ((await collapseButton(group).count()) > 0) await collapseButton(group).tap();
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("7");
        assert.equal(await said(group), "7 damage, not Goblin 1, Goblin 2", `${view.width} x ${view.height}`);
        // One line holds it at 390, and at 320 x 568 at 130% it needs the title's two lines or the note, by its drawn width.
        const place = await group.locator("[data-rest-status]").getAttribute("data-rest-place");
        if (view.scale > 1) assert.ok(place === "title" || place === "note", `the sentence needs more than the line: ${place}`);
        else assert.equal(place, null, "the line holds it");
        await shots.take(pat, `br-c-2-group-left-out-${view.width}`);
        await group.locator("[data-rest-row]").getByRole("textbox", { name: "HP change" }).fill("");
        await closeBars(pat);
        await press(await openBar(pat, run.thorn), "Multi-select");
        await closeBars(pat);
      }

      // A dead line: the DM heals a dead goblin, with healing bringing back the dead and without.
      await setUp(dm, PHONES[0]);
      await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "dead" });
      try {
        const goblin = await openBar(dm, run.goblin2);
        const goblinToggle = goblin.locator("[data-rest-row] [data-rest-mode]");
        await goblinToggle.tap();
        assert.equal(await goblinToggle.getAttribute("aria-label"), "Heal");
        assert.equal(await said(goblin), "Brings back 1 dead creature.");
        await ops.send({ t: "room.update", settings: { healRevives: false } });
        await waitFor("the dead line", async () => (await said(goblin)) === "Healing does nothing while Goblin 2 is dead. Revive first.");
        await shots.take(dm, "br-c-2-dead-line");
      } finally {
        await ops.send({ t: "room.update", settings: { healRevives: true } });
        await ops.send({ t: "actor.life", target: { tokenId: run.goblin2.id }, life: "alive" });
      }
      await closeBars(dm);
    });

    test("br-c-3. the scrolling strip at F of 210 and 148 and at 375 x 667 with a roll card: every control whole and on top when scrolled to, Scroll for more, and the DM's alerts back up at its header", async () => {
      /** Every control below the header, each scrolled into view: whole in the scroller, and the top thing at its middle and 2 px in from each corner. */
      const sweep = (bar: Locator) =>
        bar.evaluate((el) => {
          type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
          type Node = {
            getBoundingClientRect(): Rect;
            scrollIntoView(o: { block: string }): void;
            contains(n: unknown): boolean;
            getAttribute(n: string): string | null;
            textContent: string | null;
            parentElement: Node | null;
            scrollHeight: number;
            clientHeight: number;
            scrollTop: number;
            querySelector(s: string): Node | null;
            querySelectorAll(s: string): Iterable<Node>;
          };
          const frame = el as unknown as Node;
          const { document, getComputedStyle } = globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null }; getComputedStyle(n: Node): { overflowY: string; visibility: string } };
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          if (!scroller) return { scrolls: false, misses: ["no scroller"], count: 0 };
          // The header, the row the title stands in, scrolls too: its own controls are the frame's, not the content's.
          const header = scroller.querySelector("strong")?.parentElement ?? null;
          const misses: string[] = [];
          // What the strip draws: a candidate the quick row skipped is no control of the strip's.
          const controls = [...scroller.querySelectorAll("button, input, select, textarea, [role='checkbox'], [role='radio']")].filter(
            (c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden" && !(header?.contains(c) ?? false),
          );
          for (const c of controls) {
            c.scrollIntoView({ block: "nearest" });
            const r = c.getBoundingClientRect();
            const s = scroller.getBoundingClientRect();
            const name = c.getAttribute("aria-label") ?? c.textContent?.trim() ?? "?";
            if (r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) misses.push(`${name}: not whole`);
            for (const [x, y] of [[(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]] as const) {
              const top = document.elementFromPoint(x, y);
              if (!top || !(c.contains(top) || top.contains(c))) misses.push(`${name}: covered at ${Math.round(x)},${Math.round(y)}`);
            }
          }
          scroller.scrollTop = 0;
          return { scrolls: true, misses, count: controls.length };
        });
      const scrollerTop = (bar: Locator) =>
        bar.evaluate((el) => {
          type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
          const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
          const frame = el as unknown as Node;
          const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1);
          return scroller ? { top: scroller.scrollTop, window: scroller.clientHeight } : null;
        });

      const windows = [
        { view: { width: 320, height: 440, scale: 1.3 }, page: dm, label: "320 x 440 at 130%, F = 210" },
        { view: { width: 320, height: 360, scale: 1.3 }, page: dm, label: "320 x 360 at 130%, F = 148" },
        { view: PHONES[1], page: pat, label: "375 x 667 with a roll card, F = 237" },
      ];
      const card = randomUUID();
      try {
        for (const w of windows) {
          await setUp(w.page, w.view);
          if (w.page === pat) {
            await ops.send({ t: "roll.ask", request: { id: card, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
            await pat.getByText("The DM asks for a Dexterity saving throw.").first().waitFor();
            // The card stands over the map's foot, so Thorn is panned above it first, as a player would.
            const { pagePoint, touchSwipe } = await harness();
            const cardTop = (await pat.getByRole("dialog", { name: "The DM asks for a roll" }).boundingBox())!.y;
            const t = patSocket.state!.tokens[run.thorn.id]!;
            const at = await pagePoint(pat, BOUNDS, { x: t.x + 0.5, y: t.y + 0.5 });
            if (at.y > cardTop - 60) await touchSwipe(patCdp, { x: 24, y: cardTop - 8 }, { x: 24, y: cardTop - 8 - (at.y - cardTop + 120) }, { steps: 12, everyMs: 20 });
          }
          const bar = await openBar(w.page, run.thorn);
          assert.equal(await expandButton(bar).count(), 0, `${w.label}: Expand is not offered`);
          const more = bar.getByRole("button", { name: "Scroll for more", exact: true });
          await more.waitFor();
          const swept = await sweep(bar);
          assert.ok(swept.scrolls && swept.count > 0, `${w.label}: the strip scrolls`);
          assert.deepEqual(swept.misses, [], `${w.label}`);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, top`), []);
          // "Scroll for more" moves one window less 44, so the row at its foot comes to its top.
          const before = (await scrollerTop(bar))!;
          await more.tap();
          await waitFor(`${w.label}: scrolled one window less 44`, async () => Math.abs((await scrollerTop(bar))!.top - (before.top + before.window - 44)) <= 1);
          assert.deepEqual(await alignmentOf(w.page, bar, `the scrolling strip at ${w.label}, middle`), []);
          await shots.take(w.page, `br-c-3-${w.view.width}x${w.view.height}`);
          await closeBars(w.page);
        }
      } finally {
        await ops.send({ t: "roll.close", rollIds: [card] });
      }

      // The DM's alerts from the strip's foot: a concentration check stands, its summary in the header, reached by scrolling back up.
      const caster = run.goblinLeft.id;
      await ops.send({ t: "actor.effect.add", target: { tokenId: caster }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
      await setUp(dm, { width: 320, height: 360, scale: 1.3 });
      await ops.send({ t: "actor.hp", target: { tokenId: caster }, change: { kind: "damage", amount: 1 } });
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      const bar = await openBar(dm, run.thorn);
      await bar.evaluate((el) => {
        type Node = { scrollHeight: number; clientHeight: number; scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
        const { getComputedStyle } = globalThis as unknown as { getComputedStyle(n: Node): { overflowY: string } };
        const frame = el as unknown as Node;
        const scroller = [frame, ...frame.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY));
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      const summary = bar.getByRole("button", { name: /^Concentration save/ });
      assert.equal(await summary.isVisible() && (await (await harness()).wholeInReach(summary)), false, "the header's summary scrolled away at the strip's foot");
      await bar.evaluate((el) => {
        type Node = { scrollTop: number; querySelectorAll(s: string): Iterable<Node> };
        for (const n of [el as unknown as Node, ...(el as unknown as Node).querySelectorAll("*")]) n.scrollTop = 0;
      });
      assert.ok(await (await harness()).wholeInReach(summary), "a scroll back up brings the summary's button in the header");
      await shots.take(dm, "br-c-3-alerts-back-up");
      await closeBars(dm);
    });
  });
});
