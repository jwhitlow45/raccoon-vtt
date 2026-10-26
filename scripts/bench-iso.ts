/**
 * The isometric view's bench (docs/design-v1-isometric-view.md 10 and 11):
 * each kind of frame timed in Chrome on a phone-sized page, its CPU slowed 4
 * times to stand in for a mid phone, by the main thread's busy time
 * (Performance.getMetrics TaskDuration), as bench-height-pills.ts reads it.
 * Every row runs in both views, so a gate compares a frame with the same
 * frame in Top-down.
 *
 * Three rooms, each one scene, built by ops through a socket of the DM's:
 *
 * - typical: 40 by 30 cells of stone and wood rooms walled by their floors,
 *   three 10 ft platforms, a 10 ft pit and stairs, 12 tokens
 *   (4 of them the party's), a ranged scout with two range rings and an
 *   aura, and 6 labels.
 * - caps: the largest scene, 200 by 200, with a hundred walled rooms and
 *   platforms 5 to 30 ft high over a fifth of it, 40 tokens, a group of 4
 *   and a horse with its rider.
 * - crowd: 60 by 60 with 500 tokens, a scene's most.
 *
 * Rows: pan (the typical scene at 40 px, the caps at fit and at 40 px, the
 * crowd at 40 px), a local drag (each whole frame), the ringed and aura'd
 * scout dragged here and by another member, a group of 4 and the horse with
 * its rider dragged at the caps, a ping's frames, and a round trip to the
 * map builder. With `--view isometric`, also the switch, a turn, and a pan
 * with both drawing trees mounted. Isometric is out of reach until the
 * integration commit (client/features/view/store.ts isoReady), so the page
 * turns it on through the test flag Stage.tsx reads (ISO_TEST_FLAG).
 *
 * `--parity <dir>` saves the board's canvas for each scene at two cameras
 * instead of timing anything, and `--compare <dir> <dir>` says whether two
 * such sets match pixel for pixel: the Top-down check that a change to the
 * board left today's drawing as it was. With `--shots <dir>` it also saves
 * a screenshot of the whole page at each camera, to look at.
 *
 * It runs the real server on the production build, so it needs `pnpm build`
 * first and a Postgres in DATABASE_URL. It makes its rooms and deletes them
 * at the end. Run it alone, since other work on the machine skews every
 * number:
 *
 *   DATABASE_URL=postgres://... BENCH_PORT=7590 node scripts/bench-iso.ts --out before.json
 *   DATABASE_URL=postgres://... BENCH_PORT=7590 node scripts/bench-iso.ts --view isometric --out iso.json
 *   node scripts/bench-iso.ts --report before.json iso.json
 *   DATABASE_URL=postgres://... node scripts/bench-iso.ts --parity shots/before
 *   node scripts/bench-iso.ts --compare shots/before shots/after
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
import WebSocket from "ws";
import { ROOT, startServer } from "../e2e/harness.ts";

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const CPU_SLOWDOWN = 4;
const STEPS = 16;
const ROUNDS = 3;
/** The global Stage.tsx reads to show Isometric before isoReady, for tests and this bench only. */
const ISO_TEST_FLAG = "__rvttIsoTest";

type View = "topDown" | "isometric";
type Ms = { median: number; max: number; n: number };
export type BenchRow = { row: string; view: View; ms: Ms };

function stats(times: readonly number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted[sorted.length - 1] ?? 0, n: sorted.length };
}

// ---------------------------------------------------------------- the rooms

function actor(hp = 7) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 13,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 10,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

type Op = Record<string, unknown>;

/** Ids by a count, not at random, so tokens draw in the same order on every run and the parity images can match. */
let made = 0;
const benchId = (kind: string) => `bench-${kind}-${String(++made).padStart(4, "0")}`;

function token(sceneId: string, name: string, x: number, y: number, extra: Op = {}): Op {
  return { id: benchId("token"), sceneId, kind: "monster", name, size: "medium", x, y, disposition: "hostile", visibility: "all", actor: { inline: actor() }, ...extra };
}

function cells(x0: number, y0: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(`${x},${y}`);
  return out;
}

function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** What each scene holds: the ops that build it, the tokens the rows press, and where the camera stands for each zoom. */
type Built = { ops: Op[]; scout?: string; scoutAt?: { x: number; y: number }; walker: string; group?: string[]; horse?: string; rider?: string; bounds: { w: number; h: number }; at40: { x: number; y: number } };

function typical(sceneId: string, dmId: string): Built {
  const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds: { w: 40, h: 30 }, fogEnabled: true, autoWalls: "all" } }];
  for (const [x, y, w, h, terrain] of [
    [2, 2, 10, 8, "stone"],
    [16, 2, 9, 8, "wood"],
    [28, 3, 10, 10, "stone"],
    [3, 16, 12, 11, "wood"],
    [20, 15, 16, 12, "stone"],
  ] as const) {
    ops.push({ t: "build.rect", sceneId, terrain, x, y, w, h });
  }
  for (const [x, y, w, h, height] of [
    [4, 4, 3, 3, 10],
    [30, 5, 4, 3, 10],
    [22, 17, 3, 4, 10],
  ] as const) {
    ops.push({ t: "build.height", sceneId, cells: cells(x, y, w, h), height });
  }
  ops.push({ t: "build.height", sceneId, cells: cells(8, 20, 2, 2), height: -10 });
  ops.push({ t: "build.stairs", sceneId, cells: cells(7, 5, 1, 1), up: "w" });
  for (const [i, [x, y]] of [
    [6, 12],
    [14, 12],
    [26, 13],
    [33, 20],
    [10, 24],
    [18, 8],
  ].entries()) {
    ops.push({ t: "build.label", sceneId, labelId: benchId("label"), label: { x: x! + 0.5, y: y! + 0.5, text: `Room ${i + 1}`, size: 1 } });
  }
  const tokens: Op[] = [];
  for (let i = 0; i < 4; i++) tokens.push(token(sceneId, `Hero ${i + 1}`, 18 + i, 12, { kind: "npc", disposition: "ally" }));
  for (let i = 0; i < 7; i++) tokens.push(token(sceneId, `Goblin ${i + 1}`, 4 + i * 4, 9 + (i % 2) * 6));
  const scout = token(sceneId, "Scout", 24, 22, { kind: "npc", disposition: "ally", rangeRings: [30, 60] });
  tokens.push(scout);
  for (const t of tokens) ops.push({ t: "token.create", token: t });
  ops.push({
    t: "template.create",
    template: { id: benchId("area"), sceneId, shape: "emanation", size: 10, origin: { x: 24.5, y: 22.5, z: 0 }, yaw: 0, attachedTo: scout.id, includeOrigin: false, color: "#3fa7ff", ownerId: dmId, visibility: "all" },
  });
  // The walker is Hero 2, beside the camera's middle in both views, so the drag presses a token on screen.
  return { ops, scout: scout.id as string, scoutAt: { x: 24, y: 22 }, walker: tokens[1]!.id as string, bounds: { w: 40, h: 30 }, at40: { x: 20, y: 15 } };
}

function caps(sceneId: string): Built {
  const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds: { w: 200, h: 200 }, fogEnabled: false, autoWalls: "all" } }];
  for (let ry = 0; ry < 10; ry++) for (let rx = 0; rx < 10; rx++) ops.push({ t: "build.rect", sceneId, terrain: (rx + ry) % 2 ? "stone" : "wood", x: 2 + rx * 20, y: 2 + ry * 20, w: 16, h: 16 });
  const byFeet = new Map<number, string[]>();
  let n = 0;
  for (let ry = 0; ry < 10; ry++) {
    for (let rx = 0; rx < 10; rx++) {
      const feet = [5, 10, 15, 20, 25, 30][n++ % 6]!;
      byFeet.set(feet, [...(byFeet.get(feet) ?? []), ...cells(4 + rx * 20, 4 + ry * 20, 9, 9)]);
    }
  }
  for (const [height, list] of byFeet) for (const part of chunked(list, 2000)) ops.push({ t: "build.height", sceneId, cells: part, height });
  const tokens: Op[] = [];
  for (let i = 0; i < 34; i++) tokens.push(token(sceneId, `Guard ${i + 1}`, 15 + (i % 17) * 10, 18 + Math.floor(i / 17) * 100));
  const group = [0, 1, 2, 3].map((i) => token(sceneId, `Squad ${i + 1}`, 98 + i, 99, { kind: "npc", disposition: "ally" }));
  const horse = token(sceneId, "Horse", 96, 103, { kind: "npc", disposition: "ally", size: "large" });
  const rider = token(sceneId, "Rider", 96, 103, { kind: "npc", disposition: "ally" });
  for (const t of [...tokens, ...group, horse, rider]) ops.push({ t: "token.create", token: t });
  ops.push({ t: "token.attach", tokenId: rider.id, to: horse.id, kind: "ride", x: 96.5, y: 103.5, elevation: 0 });
  return { ops, walker: tokens[16]!.id as string, group: group.map((t) => t.id as string), horse: horse.id as string, rider: rider.id as string, bounds: { w: 200, h: 200 }, at40: { x: 100, y: 101 } };
}

function crowd(sceneId: string): Built {
  const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds: { w: 60, h: 60 }, fogEnabled: false } }];
  const tokens: Op[] = [];
  for (let i = 0; i < 500; i++) tokens.push(token(sceneId, `Rat ${i + 1}`, 5 + (i % 25) * 2, 5 + Math.floor(i / 25) * 2.5 - ((i % 25) % 2) * 0.5));
  for (const t of tokens) ops.push({ t: "token.create", token: t });
  return { ops, walker: tokens[262]!.id as string, bounds: { w: 60, h: 60 }, at40: { x: 30, y: 30 } };
}

// ---------------------------------------------------------------- the page

/** A room socket of an existing session, for ops and for another member's ephemeral events. */
class Socket {
  sceneId = "";
  memberId = "";
  private n = 1;
  private readonly waiting = new Map<number, (err: Error | null) => void>();
  private readonly sent = new Map<number, Op>();
  private readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { t?: string; n?: number; acks?: number[]; rejects?: { n: number; code: string; message: string }[] };
      // A busy room asks for the op again: send it again in a moment, under its own number.
      if (msg.t === "retry" && msg.n !== undefined) {
        const op = this.sent.get(msg.n);
        if (op) setTimeout(() => this.ws.send(JSON.stringify({ t: "op", n: msg.n, op })), 250);
        return;
      }
      if (msg.t !== "ev") return;
      for (const a of msg.acks ?? []) this.waiting.get(a)?.(null);
      for (const r of msg.rejects ?? []) this.waiting.get(r.n)?.(new Error(`refused: ${r.code}: ${r.message}`));
    });
  }
  static async open(origin: string, roomId: string, cookie: string): Promise<Socket> {
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?room=${roomId}`, { headers: { Origin: origin, Cookie: cookie } });
    const snapshot = await new Promise<{ state: { meta: { playerSceneId: string } }; you: { memberId: string } }>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1 })));
      ws.on("message", function first(data) {
        const msg = JSON.parse(String(data)) as { t?: string };
        if (msg.t !== "snapshot") return;
        ws.off("message", first);
        resolve(msg as never);
      });
      ws.on("error", reject);
    });
    const socket = new Socket(ws);
    socket.sceneId = snapshot.state.meta.playerSceneId;
    socket.memberId = snapshot.you.memberId;
    return socket;
  }
  op(op: Op): Promise<void> {
    const n = this.n++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`op ${String(op.t)} got no answer`)), 60_000);
      this.sent.set(n, op);
      this.waiting.set(n, (err) => {
        clearTimeout(timer);
        this.waiting.delete(n);
        this.sent.delete(n);
        if (err) reject(err);
        else resolve();
      });
      this.ws.send(JSON.stringify({ t: "op", n, op }));
    });
  }
  eph(sceneId: string, e: Op): void {
    this.ws.send(JSON.stringify({ t: "eph", sceneId, e }));
  }
  close(): void {
    this.ws.close(1000);
  }
}

/** Resolves once the page has drawn `frames` frames. */
function frames(page: Page, n = 4): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const raf = (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame;
        let i = 0;
        const step = () => (++i < count ? raf(step) : setTimeout(resolve, 0));
        raf(step);
      }),
    n,
  );
}

async function busy(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
}

/** The main thread's busy time of each step, a step being one action and the frames it draws. */
async function timed(page: Page, cdp: CDPSession, steps: number, act: (i: number) => Promise<void>, settleFrames = 4): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    const before = await busy(cdp);
    await act(i);
    await frames(page, settleFrames);
    out.push((await busy(cdp)) - before);
  }
  return out;
}

/**
 * A point on a token on the page, in whichever stage on screen holds its
 * node: across its middle, `down` of the way from its top. It must lie
 * inside the canvas, or a row would press nothing and time an idle page.
 */
async function tokenPoint(page: Page, id: string, down = 0.75): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(([tokenId, depth]) => {
    type Node = { getClientRect(): { x: number; y: number; width: number; height: number } };
    type Stage = { findOne(sel: string): Node | undefined; width(): number; height(): number; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    for (const stage of konva.stages) {
      if (stage.width() === 0) continue;
      const node = stage.findOne(`#${tokenId}`);
      if (!node) continue;
      const r = node.getClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height * depth;
      if (x < 0 || y < 0 || x > stage.width() || y > stage.height()) return { off: true as const };
      const box = stage.container().getBoundingClientRect();
      // Nothing over the canvas there, such as the action bar, may take the press.
      const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null } }).document;
      if (!doc.elementFromPoint(box.left + x, box.top + y)?.closest(".konvajs-content")) return { off: true as const };
      return { x: box.left + x, y: box.top + y };
    }
    return null;
  }, [id, down] as const);
  if (!p) throw new Error(`token ${id} is not on the board`);
  if ("off" in p) throw new Error(`token ${id} is off the screen or under the chrome`);
  return p;
}

/** Where a token's node stands on the canvas, on screen or not, to check that a drag moved it. */
function nodeAt(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((tokenId) => {
    type Stage = { width(): number; findOne(sel: string): { absolutePosition(): { x: number; y: number } } | undefined };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    for (const stage of konva.stages) {
      const node = stage.width() > 0 ? stage.findOne(`#${tokenId}`) : undefined;
      if (node) return node.absolutePosition();
    }
    return { x: NaN, y: NaN };
  }, id);
}

/** The camera of the board on screen, to check that a pan moved it. */
function stageAt(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    type Stage = { width(): number; x(): number; y(): number; listening(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    // The isometric board's ground stage never listens, and its main stage holds the same camera.
    const stage = konva.stages.find((s) => s.width() > 0 && s.listening());
    return stage ? { x: stage.x(), y: stage.y() } : { x: NaN, y: NaN };
  });
}

/** The page's box of the board on screen, Top-down's stage or the isometric board's main stage. */
async function boardBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  for (const el of await page.locator(".konvajs-content").all()) {
    const box = await el.boundingBox();
    if (box && box.width > 0 && box.height > 0) return box;
  }
  throw new Error("no canvas on screen");
}

/** Where the scene opens: fitted, or at `zoom` px a cell around a point, as its saved starting view (the page reopens it after). */
function startAt(dm: Socket, world: { x: number; y: number }, zoom: number | "fit"): Promise<void> {
  return dm.op({ t: "scene.update", sceneId: dm.sceneId, patch: { defaultView: zoom === "fit" ? null : { x: world.x, y: world.y, zoom } } });
}

async function touchPan(page: Page, cdp: CDPSession, steps: number): Promise<number[]> {
  const box = await boardBox(page);
  // An empty spot on screen: the middle of the canvas's left edge, with no token under it at every camera here.
  const start = { x: box.x + 30, y: box.y + box.height * 0.45 };
  const before = await stageAt(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 0 }] });
  await frames(page, 2);
  const out = await timed(page, cdp, steps, (i) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (i + 1) * 9, y: start.y + (i + 1) * 4, id: 0 }] }).then(() => {}));
  const moved = await stageAt(page);
  // Back where it started, so every round, and the rows after, see the same camera.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...start, id: 0 }] });
  await frames(page, 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page, 4);
  if (!(Math.abs(moved.x - before.x) > 20)) throw new Error("the pan did not move the map");
  return out;
}

async function touchDrag(page: Page, cdp: CDPSession, id: string, steps: number, opts: { keepSelection?: boolean; down?: number } = {}): Promise<number[]> {
  // A token selected by an earlier row opens its bar, which can cover the next one: start each lone drag with none.
  if (!opts.keepSelection) {
    await page.keyboard.press("Escape");
    await frames(page, 8);
  }
  const from = await tokenPoint(page, id, opts.down);
  // Toward the canvas's middle, so the token stays on screen.
  const box = await boardBox(page);
  const sx = from.x < box.x + box.width / 2 ? 1 : -1;
  const sy = from.y < box.y + box.height / 2 ? 1 : -1;
  const start = await nodeAt(page, id);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 0 }] });
  await frames(page, 2);
  const out = await timed(page, cdp, steps, (i) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + sx * (i + 1) * 7, y: from.y + sy * (i + 1) * 3, id: 0 }] }).then(() => {}));
  // The token must have followed the finger, or the row timed nothing.
  const mid = await nodeAt(page, id);
  if (!(Math.hypot(mid.x - start.x, mid.y - start.y) > 20)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    throw new Error(`the drag did not move token ${id}`);
  }
  // Back where it started, so the drop moves nothing and every round starts alike.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...from, id: 0 }] });
  await frames(page, 2);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page, 8);
  return out;
}

type Room = { roomId: string; name: string };

async function createRoom(page: Page, name: string): Promise<Room> {
  await page.goto(`${new URL(page.url()).origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  if (!match) throw new Error(`The DM link looks wrong: ${link}`);
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  return { roomId: match[1]!.replace("-", ""), name };
}

/** A press held on empty map until it pings (features/pings/hold.ts), then let go. */
async function holdPing(page: Page, cdp: CDPSession): Promise<void> {
  const box = await boardBox(page);
  const at = { x: box.x + 40, y: box.y + box.height * 0.4, id: 0 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function openView(context: BrowserContext, page: Page, view: View, roomId: string): Promise<void> {
  if (view === "isometric") {
    await context.addInitScript(
      ({ flag, key }) => {
        (globalThis as unknown as Record<string, boolean>)[flag] = true;
        try {
          localStorage.setItem(key, JSON.stringify({ v: 1, pick: "isometric", turns: {} }));
        } catch {
          // No storage: the bench has nothing to time then.
        }
      },
      { flag: ISO_TEST_FLAG, key: `rvtt.view.${roomId}` },
    );
  }
  await page.goto(`${new URL(page.url()).origin}/r/${roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await frames(page, 30);
}

// ---------------------------------------------------------------- the run

export async function runBench(view: View, opts: { parity?: string; shots?: string } = {}): Promise<BenchRow[]> {
  if (!existsSync(path.join(ROOT, "dist/index.html"))) throw new Error("No production build in dist/. Run `pnpm build` first.");
  const port = Number(process.env.BENCH_PORT ?? 7590);
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
  const work = mkdtempSync(path.join(tmpdir(), "raccoon-bench-iso-"));
  const server = await startServer({ port, assetDir: path.join(work, "assets"), databaseUrl });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const rooms: Room[] = [];
  const rows: BenchRow[] = [];
  const sockets: Socket[] = [];
  const stamp = new Date().toISOString().slice(0, 19);
  try {
    await page.goto(`${server.origin}/`);
    const built: Record<string, { room: Room; scene: Built; dm: Socket }> = {};
    for (const [kind, make] of [
      ["typical", typical],
      ["caps", caps],
      ["crowd", crowd],
    ] as const) {
      const room = await createRoom(page, `Bench iso ${kind} ${stamp}`);
      rooms.push(room);
      const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const dm = await Socket.open(server.origin, room.roomId, cookie);
      sockets.push(dm);
      const scene = make(dm.sceneId, dm.memberId);
      for (const op of scene.ops) await dm.op(op);
      built[kind] = { room, scene, dm };
    }

    if (opts.parity) {
      mkdirSync(opts.parity, { recursive: true });
      for (const [kind, { room, scene, dm }] of Object.entries(built)) {
        // Fixed cameras: a fit follows the bars over the map as they measure, which can land a fraction of a pixel apart from run to run.
        for (const [shot, zoom] of [
          ["far", Math.max(4, 400 / scene.bounds.w)],
          ["40px", 40],
        ] as const) {
          await startAt(dm, scene.at40, zoom);
          await openView(context, page, view, room.roomId);
          await frames(page, 30);
          const pngs = await page.evaluate(() => {
            const konva = (globalThis as unknown as { Konva: { stages: { width(): number; toDataURL(o: { pixelRatio: number }): string }[] } }).Konva;
            return konva.stages.filter((s) => s.width() > 0).map((s) => s.toDataURL({ pixelRatio: 2 }));
          });
          pngs.forEach((data, i) => writeFileSync(path.join(opts.parity!, `${kind}-${shot}-${i}.png`), Buffer.from(data.split(",")[1]!, "base64")));
          // The whole page as a person sees it, both stages and the chrome, for looking at rather than comparing.
          if (opts.shots) {
            mkdirSync(opts.shots, { recursive: true });
            await page.screenshot({ path: path.join(opts.shots, `${view}-${kind}-${shot}.png`) });
          }
        }
      }
      return [];
    }

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    const add = (row: string, times: number[]) => rows.push({ row, view, ms: stats(times) });
    /** Each round's steps, a first round warming the engine up and not counted. */
    const rounds = async (run: () => Promise<number[]>) => {
      await run();
      const all: number[] = [];
      for (let r = 0; r < ROUNDS; r++) all.push(...(await run()));
      return all;
    };
    const throttled = async <T>(run: () => Promise<T>) => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      try {
        return await run();
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    };
    const open = async (kind: string, zoom: number | "fit") => {
      const { room, scene, dm } = built[kind]!;
      await startAt(dm, scene.at40, zoom);
      await openView(context, page, view, room.roomId);
    };

    // The typical scene.
    {
      const { room, scene } = built.typical!;
      await open("typical", 40);
      add("pan, typical, 40 px", await throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      add("local drag, whole frame, typical, 40 px", await throttled(() => rounds(() => touchDrag(page, cdp, scene.walker, STEPS))));
      add("local drag of a token with two range rings and an aura, typical", await throttled(() => rounds(() => touchDrag(page, cdp, scene.scout!, STEPS))));
      // Another device of the DM's drags it: the page draws that as another member's drag (RemoteDrags.tsx).
      const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const other = await Socket.open(server.origin, room.roomId, cookie);
      sockets.push(other);
      const at = scene.scoutAt!;
      add(
        "remote drag of the ringed and aura'd token, typical",
        await throttled(() =>
          rounds(async () => {
            other.eph(other.sceneId, { k: "dragStart", tokenId: scene.scout, x: at.x, y: at.y });
            const out = await timed(page, cdp, STEPS, async (i) => other.eph(other.sceneId, { k: "dragMove", tokenId: scene.scout, x: at.x + (i + 1) * 0.25, y: at.y }));
            other.eph(other.sceneId, { k: "dragCancel", tokenId: scene.scout });
            await frames(page, 30);
            return out;
          }),
        ),
      );
      add(
        "ping, each frame of its animation, typical",
        await throttled(() =>
          rounds(async () => {
            await holdPing(page, cdp);
            const out = await timed(page, cdp, 30, async () => {}, 1);
            await frames(page, 90);
            return out;
          }),
        ),
      );
      add(
        "a round trip to the map builder, each way, typical",
        await throttled(() => rounds(() => timed(page, cdp, 2, (i) => page.keyboard.press(i === 0 ? "b" : "v"), 8))),
      );
    }

    // The caps.
    {
      const { scene } = built.caps!;
      await open("caps", "fit");
      add("pan, caps, fit", await throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await open("caps", 40);
      add("pan, caps, 40 px", await throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await select(page, scene.group!);
      add("group drag of 4, caps, 40 px", await throttled(() => rounds(() => touchDrag(page, cdp, scene.group![0]!, STEPS, { keepSelection: true }))));
      await page.keyboard.press("Escape");
      await frames(page, 8);
      // Pressed near its foot, clear of the rider on its back, which a press would lift off it.
      add("a horse with its rider dragged, caps, 40 px", await throttled(() => rounds(() => touchDrag(page, cdp, scene.horse!, STEPS, { down: 0.92 }))));
    }

    // The crowd.
    {
      const { scene } = built.crowd!;
      await open("crowd", 40);
      add("pan, 500 tokens, 40 px", await throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      add("local drag, whole frame, 500 tokens, 40 px", await throttled(() => rounds(() => touchDrag(page, cdp, scene.walker, STEPS))));
    }

    if (view === "isometric") {
      await open("caps", 40);
      // Stage.tsx's hook beside the test flag: a pick or a turn as the View menu will make them.
      const hook = (call: "turn" | "pick", arg: unknown) =>
        page.evaluate(([c, a]) => (globalThis as unknown as { __rvttIsoHook?: Record<string, (a: unknown) => void> }).__rvttIsoHook?.[c]?.(a), [call, arg] as const);
      add("turn, caps, 40 px", await throttled(() => rounds(() => timed(page, cdp, 4, async (i) => void (await hook("turn", (i + 1) % 4)), 4))));
      add("switch, caps, 40 px, both trees mounted", await throttled(() => rounds(() => timed(page, cdp, 2, async (i) => void (await hook("pick", i === 0 ? "topDown" : "isometric")), 4))));
      add("pan, caps, 40 px, both trees mounted", await throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
    }
    return rows;
  } finally {
    for (const s of sockets) s.close();
    for (const room of rooms) {
      const res = await context.request.delete(`${server.origin}/api/rooms/${room.roomId}`, { headers: { Origin: server.origin }, data: { name: room.name } }).catch(() => null);
      if (!res?.ok()) console.error(`Could not delete the bench room ${room.roomId}`);
    }
    await browser.close();
    await server.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Selects tokens as a desktop does, a Shift click on each, so a drag of one moves them all. */
async function select(page: Page, ids: readonly string[]): Promise<void> {
  await page.keyboard.down("Shift");
  try {
    for (const id of ids) {
      const p = await tokenPoint(page, id);
      await page.mouse.click(p.x, p.y);
      await frames(page, 4);
    }
  } finally {
    await page.keyboard.up("Shift");
  }
}

// ---------------------------------------------------------------- reports

/** Section 11's gates: every frame at most max(16 ms, 1.75 times Top-down's same frame), a turn at the caps at most 150 ms whole. */
export function gate(row: string, iso: number, topDown: number | undefined): string {
  if (row.startsWith("turn")) return iso <= 150 ? "ok" : "OVER 150 ms";
  if (topDown === undefined) return "";
  const budget = Math.max(16, 1.75 * topDown);
  return iso <= budget ? `ok (budget ${budget.toFixed(1)})` : `OVER (budget ${budget.toFixed(1)})`;
}

export function formatReport(sets: readonly BenchRow[][]): string {
  const lines = ["row | view | ms (median / max, n) | gate", "--- | --- | --- | ---"];
  const topDown = new Map<string, number>();
  for (const set of sets) for (const r of set) if (r.view === "topDown") topDown.set(r.row, r.ms.median);
  for (const set of sets) {
    for (const r of set) {
      const g = r.view === "isometric" ? gate(r.row, r.ms.median, topDown.get(r.row)) : "";
      lines.push(`${r.row} | ${r.view} | ${r.ms.median.toFixed(1)} / ${r.ms.max.toFixed(1)}, ${r.ms.n} | ${g}`);
    }
  }
  return lines.join("\n");
}

/** Whether two parity sets hold the same images pixel for pixel: the names of those that differ, with how many pixels. */
export async function comparePngs(a: string, b: string): Promise<string[]> {
  const out: string[] = [];
  const names = new Set([...readdirSync(a), ...readdirSync(b)].filter((n) => n.endsWith(".png")));
  for (const name of [...names].sort()) {
    const pa = path.join(a, name);
    const pb = path.join(b, name);
    if (!existsSync(pa) || !existsSync(pb)) {
      out.push(`${name}: only in ${existsSync(pa) ? a : b}`);
      continue;
    }
    const [ra, rb] = await Promise.all([sharp(pa).raw().toBuffer({ resolveWithObject: true }), sharp(pb).raw().toBuffer({ resolveWithObject: true })]);
    if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
      out.push(`${name}: ${ra.info.width}x${ra.info.height} against ${rb.info.width}x${rb.info.height}`);
      continue;
    }
    let differ = 0;
    for (let i = 0; i < ra.data.length; i += ra.info.channels) {
      for (let c = 0; c < ra.info.channels; c++) {
        if (ra.data[i + c] !== rb.data[i + c]) {
          differ++;
          break;
        }
      }
    }
    if (differ > 0) out.push(`${name}: ${differ} pixels differ`);
  }
  return out;
}

const argv = process.argv;
if (argv[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--compare")) {
    const i = argv.indexOf("--compare");
    const diffs = await comparePngs(argv[i + 1]!, argv[i + 2]!);
    console.log(diffs.length === 0 ? "every image matches pixel for pixel" : diffs.join("\n"));
    process.exitCode = diffs.length === 0 ? 0 : 1;
  } else if (argv.includes("--report")) {
    const files = argv.slice(argv.indexOf("--report") + 1);
    console.log(formatReport(files.map((f) => JSON.parse(readFileSync(f, "utf8")) as BenchRow[])));
  } else {
    const view: View = arg("--view") === "isometric" ? "isometric" : "topDown";
    const parity = arg("--parity");
    const shots = arg("--shots");
    const rows = await runBench(view, parity ? { parity, ...(shots ? { shots } : {}) } : {});
    const out = arg("--out");
    if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
    if (!parity) console.log(formatReport([rows]));
  }
}
