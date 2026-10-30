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
 * - areas: the typical scene with four areas standing as their real shapes
 *   around the camera (docs/design-v1-iso-area-shapes.md 6): a 20 ft sphere
 *   10 ft up, a 30 ft cone aimed 40 degrees up, a 10 by 40 ft cylinder and a
 *   15 ft emanation on a creature, and four fliers among them, 16 tokens.
 * - cap: 200 areas, a scene's most, over an 80 by 80 scene.
 * - giant: a 200 by 200 hex rows scene where a 500 ft emanation comes in.
 *
 * Rows: pan (the typical scene at 40 px, the caps at fit and at 40 px, the
 * crowd at 40 px), a local drag (each whole frame), the ringed and aura'd
 * scout dragged here and by another member, a group of 4 and the horse with
 * its rider dragged at the caps, a ping's frames, a round trip to the map
 * builder, and a brush stroke's steps and a map image's coming and going,
 * each arriving from another device. With `--view isometric`, also the
 * ground stage's draws while the scout crosses cells, here and by another
 * member, a count that must be none, the switch, a turn, and a pan with
 * both drawing trees mounted, and the brush stroke and the map image run
 * back in Top-down with the isometric tree mounted and hidden. On the area
 * rooms: a pan and a drag among the four areas, a sphere aimed with the
 * Area tool (each move, then each frame once the finger rests), each frame
 * of a first view and a pan at the cap, a turn there, and each frame while
 * the 500 ft emanation builds. `--only`
 * times just the rows named. The page stores Isometric as its pick before
 * it loads, and sets the test flag (client/features/view/choice.ts
 * ISO_TEST_FLAG) for the hook that turns without the menu.
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
 *   node scripts/bench-iso.ts --tether
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
import WebSocket from "ws";
import { pickOption, pickTool, ROOT, startServer } from "../e2e/harness.ts";

/** A low-zoom diagonal tether across the largest map. This CPU row needs no browser or database. */
export async function tetherWork(length = 200): Promise<{ candidates: number; visited: number }> {
  // Keep browser-only canvas types out of the server tools' compilation.
  const { strokeSubcells } = await import(new URL("../client/canvas/relief/stand.ts", import.meta.url).href) as {
    strokeSubcells(a: { x: number; y: number }, b: { x: number; y: number }, r: number, visit: (x: number, y: number) => boolean): number;
  };
  let visited = 0;
  const candidates = strokeSubcells({ x: 0, y: 0 }, { x: length, y: length }, 1 / 12, () => { visited++; return true; });
  return { candidates, visited };
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const CPU_SLOWDOWN = 4;
const STEPS = 16;
const ROUNDS = 3;
/** The global that installs the test hook, which picks and turns without the View menu (client/canvas/relief/isoTest.ts), for tests and this bench only. */
const ISO_TEST_FLAG = "__rvttIsoTest";

type View = "topDown" | "isometric";
/** A row's median and largest frame, and for a build's frames every one, as the gate holds each (section 6). */
type Ms = { median: number; max: number; n: number; frames?: number[] };
export type BenchRow = { row: string; view: View; ms: Ms };

function stats(times: readonly number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted[sorted.length - 1] ?? 0, n: sorted.length };
}

/** A build's frames, each kept for the gate, in the order they came. */
function frameStats(times: readonly number[]): Ms {
  return { ...stats(times), frames: [...times] };
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
type Built = { ops: Op[]; scout?: string; scoutAt?: { x: number; y: number }; walker: string; aura?: string; group?: string[]; horse?: string; rider?: string; bounds: { w: number; h: number }; at40: { x: number; y: number } };

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

function template(sceneId: string, dmId: string, t: Op): Op {
  return { t: "template.create", template: { id: benchId("area"), sceneId, yaw: 0, includeOrigin: true, color: "#3fa7ff", ownerId: dmId, visibility: "all", ...t } };
}

/** The typical scene with the four areas of the design's cost section round the camera, and four fliers among them. */
function areas(sceneId: string, dmId: string): Built {
  const base = typical(sceneId, dmId);
  const ops = [...base.ops];
  const guardian = token(sceneId, "Guardian", 18, 13, { kind: "npc", disposition: "ally" });
  const fliers = [token(sceneId, "Bat 1", 20, 15, { elevation: 10 }), token(sceneId, "Bat 2", 21, 17, { elevation: 25 }), token(sceneId, "Bat 3", 17, 16, { elevation: 15 }), guardian];
  for (const t of fliers) ops.push({ t: "token.create", token: t });
  ops.push(template(sceneId, dmId, { shape: "sphere", size: 20, origin: { x: 20.5, y: 15.5, z: 10 } }));
  ops.push(template(sceneId, dmId, { shape: "cone", size: 30, origin: { x: 17, y: 18, z: 0 }, yaw: 315, pitch: 40, color: "#e5484d" }));
  ops.push(template(sceneId, dmId, { shape: "cylinder", size: 10, height: 40, origin: { x: 23.5, y: 13.5, z: 0 }, color: "#30a46c" }));
  ops.push(template(sceneId, dmId, { shape: "emanation", size: 15, origin: { x: 18.5, y: 13.5, z: 0 }, attachedTo: guardian.id, includeOrigin: false, color: "#f38400" }));
  return { ...base, ops, aura: guardian.id as string };
}

/** 200 areas, a scene's most, of every shape over an 80 by 80 scene. */
function cap(sceneId: string, dmId: string): Built {
  const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds: { w: 80, h: 80 }, fogEnabled: false } }];
  const shapes: Op[] = [
    { shape: "sphere", size: 20 },
    { shape: "cylinder", size: 10, height: 20 },
    { shape: "cone", size: 30, pitch: 20 },
    { shape: "cube", size: 15 },
    { shape: "line", size: 60, width: 5, pitch: 10 },
  ];
  for (let i = 0; i < 200; i++) {
    const x = 4 + (i % 20) * 3.6;
    const y = 4 + Math.floor(i / 20) * 7.2;
    ops.push(template(sceneId, dmId, { ...shapes[i % shapes.length]!, origin: { x, y, z: 5 * (i % 4) }, yaw: (i * 37) % 360, color: ["#3fa7ff", "#e5484d", "#30a46c", "#f38400"][i % 4] }));
  }
  const walker = token(sceneId, "Scout", 40, 40);
  ops.push({ t: "token.create", token: walker });
  return { ops, walker: walker.id as string, bounds: { w: 80, h: 80 }, at40: { x: 40, y: 40 } };
}

/** A 200 by 200 hex rows scene; the 500 ft emanation comes in by its row (GIANT_ROW). */
function giant(sceneId: string): Built {
  const walker = token(sceneId, "Scout", 100, 100);
  return { ops: [{ t: "scene.update", sceneId, patch: { bounds: { w: 200, h: 200 }, fogEnabled: false, gridShape: "hexRows" } }, { t: "token.create", token: walker }], walker: walker.id as string, bounds: { w: 200, h: 200 }, at40: { x: 100, y: 100 } };
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
 * The main thread's busy time of each frame from `act` on until `done`
 * holds, and how long that took: a build's frames and none of the idle
 * ones after it. Frames are timed back to back, so a frame drawn between
 * two looks is still counted, with the look at `done` in the frame after
 * it. `done` is asked from the `from`th frame on, as a board can report
 * what stood before the act for a frame or two.
 */
export async function timedUntil(page: Page, cdp: CDPSession, act: () => Promise<void>, done: () => Promise<boolean>, from = 3, max = 3000): Promise<{ frames: number[]; ms: number }> {
  const out: number[] = [];
  const start = Date.now();
  let last = await busy(cdp);
  await act();
  for (let i = 1; i <= max; i++) {
    await frames(page, 1);
    const now = await busy(cdp);
    out.push(now - last);
    last = now;
    if (i >= from && (await done())) return { frames: out, ms: Date.now() - start };
  }
  throw new Error(`still building after ${max} frames`);
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

/**
 * Starts counting the isometric ground stage's draws: its one layer's draw,
 * which the board's frame scheduler calls (relief/scheduler.ts), wrapped in
 * an own property that counts. `groundDraws` reads the count.
 */
function countGroundDraws(page: Page): Promise<void> {
  return page.evaluate(() => {
    type Layer = { draw(): unknown; __benchDraws?: number };
    type Stage = { width(): number; visible(): boolean; listening(): boolean; getLayers(): Layer[] };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const ground = konva.stages.find((s) => s.width() > 0 && s.visible() && !s.listening())?.getLayers()[0];
    if (!ground) throw new Error("no isometric ground stage on screen");
    if (ground.__benchDraws === undefined) {
      const draw = ground.draw.bind(ground);
      ground.draw = () => {
        ground.__benchDraws = (ground.__benchDraws ?? 0) + 1;
        return draw();
      };
    }
    ground.__benchDraws = 0;
  });
}

function groundDraws(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Layer = { __benchDraws?: number };
    type Stage = { width(): number; visible(): boolean; listening(): boolean; getLayers(): Layer[] };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    return konva.stages.find((s) => s.width() > 0 && s.visible() && !s.listening())?.getLayers()[0]?.__benchDraws ?? -1;
  });
}

/**
 * A touch drag of a token: `steps` moves toward the canvas's middle, each
 * timed, then back and up. With `watch`, one untimed move goes first, so
 * the drag has begun and what leaves the ground for it has left, and
 * `watch` is told when the timed moves start and end.
 */
async function touchDrag(page: Page, cdp: CDPSession, id: string, steps: number, opts: { keepSelection?: boolean; down?: number; watch?: { start(): Promise<void>; stop(): Promise<void> } } = {}): Promise<number[]> {
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
  if (opts.watch) {
    // Past Konva's drag distance (8 px for touch), so the drag has started, and its marks left the ground stage, before the count starts.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + sx * 10, y: from.y + sy * 4, id: 0 }] });
    await frames(page, 8);
    await opts.watch.start();
  }
  const out = await timed(page, cdp, steps, (i) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + sx * (i + 1) * 7, y: from.y + sy * (i + 1) * 3, id: 0 }] }).then(() => {}));
  await opts.watch?.stop();
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

/**
 * Reloads the page and waits past the room's own loads after it: the
 * panels and the icon index it preloads 2 s in (RoomChrome.tsx
 * PRELOAD_DELAY_MS), whose frames would otherwise land among a build's.
 */
async function reloaded(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
}

/** A session flag the bench sets for a first view's reload, which the view's init script then leaves as picked. */
const KEEP_PICK = "rvtt.bench.keepPick";

async function openView(context: BrowserContext, page: Page, view: View, roomId: string): Promise<void> {
  if (view === "isometric") {
    await context.addInitScript(
      ({ flag, key, keep }) => {
        (globalThis as unknown as Record<string, boolean>)[flag] = true;
        try {
          // A reload for a first view keeps the pick of Top-down, so the board first shows, and builds, when the row picks it.
          if (sessionStorage.getItem(keep) !== "1") localStorage.setItem(key, JSON.stringify({ v: 1, pick: "isometric", turns: [] }));
        } catch {
          // No storage: the bench has nothing to time then.
        }
      },
      { flag: ISO_TEST_FLAG, key: `rvtt.view.${roomId}`, keep: KEEP_PICK },
    );
  }
  await page.goto(`${new URL(page.url()).origin}/r/${roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await frames(page, 30);
}

// ---------------------------------------------------------------- the run

export async function runBench(view: View, opts: { parity?: string; shots?: string; only?: readonly string[] } = {}): Promise<BenchRow[]> {
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
    // The rooms for areas come last, so the others keep their ids and the parity images of before still match.
    for (const [kind, make] of [
      ["typical", typical],
      ["caps", caps],
      ["crowd", crowd],
      ["areas", areas],
      ["cap", cap],
      ["giant", giant],
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
    /** Times a row, unless `only` names others. */
    const add = async (row: string, run: () => Promise<number[]>) => {
      if (opts.only && !opts.only.some((o) => row.includes(o))) return;
      rows.push({ row, view, ms: stats(await run()) });
    };
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
      await add("pan, typical, 40 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await add("local drag, whole frame, typical, 40 px", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.walker, STEPS))));
      await add("local drag of a token with two range rings and an aura, typical", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.scout!, STEPS))));
      // Another device of the DM's drags it: the page draws that as another member's drag (RemoteDrags.tsx).
      const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      const other = await Socket.open(server.origin, room.roomId, cookie);
      sockets.push(other);
      const at = scene.scoutAt!;
      await add(
        "remote drag of the ringed and aura'd token, typical",
        () => throttled(() =>
          rounds(async () => {
            other.eph(other.sceneId, { k: "dragStart", tokenId: scene.scout, x: at.x, y: at.y });
            const out = await timed(page, cdp, STEPS, async (i) => other.eph(other.sceneId, { k: "dragMove", tokenId: scene.scout, x: at.x + (i + 1) * 0.25, y: at.y }));
            other.eph(other.sceneId, { k: "dragCancel", tokenId: scene.scout });
            await frames(page, 30);
            return out;
          }),
        ),
      );
      if (view === "isometric" && (!opts.only || opts.only.some((o) => GROUND_LOCAL_ROW.includes(o)))) {
        // A drag across cells moves the token's rings, aura and tethers on the overlay, and redraws nothing on the ground stage (ISO2-RANGERING, design 5.1).
        let local = 0;
        await touchDrag(page, cdp, scene.scout!, STEPS, { watch: { start: () => countGroundDraws(page), stop: async () => void (local = await groundDraws(page)) } });
        rows.push({ row: GROUND_LOCAL_ROW, view, ms: { median: local, max: local, n: 1 } });
        other.eph(other.sceneId, { k: "dragStart", tokenId: scene.scout, x: at.x, y: at.y });
        other.eph(other.sceneId, { k: "dragMove", tokenId: scene.scout, x: at.x + 0.25, y: at.y });
        await frames(page, 30);
        await countGroundDraws(page);
        for (let i = 0; i < STEPS; i++) {
          other.eph(other.sceneId, { k: "dragMove", tokenId: scene.scout, x: at.x + (i + 2) * 0.25, y: at.y });
          await frames(page, 4);
        }
        const remote = await groundDraws(page);
        other.eph(other.sceneId, { k: "dragCancel", tokenId: scene.scout });
        await frames(page, 30);
        rows.push({ row: GROUND_REMOTE_ROW, view, ms: { median: remote, max: remote, n: 1 } });
      }
      await add(
        "ping, each frame of its animation, typical",
        () => throttled(() =>
          rounds(async () => {
            await holdPing(page, cdp);
            const out = await timed(page, cdp, 30, async () => {}, 1);
            await frames(page, 90);
            return out;
          }),
        ),
      );
      await add(
        "a round trip to the map builder, each way, typical",
        () => throttled(() => rounds(() => timed(page, cdp, 2, (i) => page.keyboard.press(i === 0 ? "b" : "v"), 8))),
      );
    }

    // A map image for the caps, set and taken away by the map row.
    const capsMap = !opts.only || opts.only.some((o) => MAP_ROW.includes(o)) ? await uploadMap(context, server.origin, built.caps!.room.roomId) : null;

    // The caps.
    {
      const { scene } = built.caps!;
      await open("caps", "fit");
      await add("pan, caps, fit", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await open("caps", 40);
      await add("pan, caps, 40 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await select(page, scene.group!);
      await add("group drag of 4, caps, 40 px", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.group![0]!, STEPS, { keepSelection: true }))));
      await page.keyboard.press("Escape");
      await frames(page, 8);
      // Pressed near its foot, clear of the rider on its back, which a press would lift off it.
      await add("a horse with its rider dragged, caps, 40 px", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.horse!, STEPS, { down: 0.92 }))));
      // In Isometric this row runs last, in Top-down with the isometric tree mounted and hidden.
      if (view === "topDown") await add(BRUSH_ROW, () => throttled(() => rounds(() => brushStrokes(page, cdp, built.caps!.dm))));
      if (view === "topDown") await add(MAP_ROW, () => throttled(() => rounds(() => mapSwaps(page, cdp, built.caps!.dm, capsMap!))));
    }

    // The crowd.
    {
      const { scene } = built.crowd!;
      await open("crowd", 40);
      await add("pan, 500 tokens, 40 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await add("local drag, whole frame, 500 tokens, 40 px", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.walker, STEPS))));
    }

    // Areas standing as their real shapes (docs/design-v1-iso-area-shapes.md 6).
    {
      const { scene } = built.areas!;
      await open("areas", 40);
      await add("pan, typical with four areas, 40 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await add("local drag of the Guardian with its aura, whole frame, typical with four areas, 40 px", () => throttled(() => rounds(() => touchDrag(page, cdp, scene.aura!, STEPS, { down: 0.9 }))));
      if (!opts.only || opts.only.some((o) => AIM_MOVE_ROW.includes(o) || AIM_REST_ROW.includes(o))) {
        const moves: number[] = [];
        const rest: number[] = [];
        const restStood: number[] = [];
        let round = 0;
        await throttled(() =>
          rounds(async () => {
            const got = await aimSphere(page, cdp, view);
            // The first round warms the engine up: its steps are left out, as `rounds` leaves them.
            if (round++ > 0) {
              moves.push(...got.moves);
              rest.push(...got.rest);
              if (got.restMs !== null) restStood.push(got.restMs);
            }
            return got.moves;
          }),
        );
        rows.push({ row: AIM_MOVE_ROW, view, ms: stats(moves) });
        rows.push({ row: AIM_REST_ROW, view, ms: view === "isometric" ? frameStats(rest) : stats(rest) });
        if (view === "isometric") rows.push({ row: AIM_REST_STOOD_ROW, view, ms: stats(restStood) });
      }
    }
    {
      await open("cap", 12);
      await add("pan, 200 areas, 12 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      await open("cap", 40);
      await add("pan, 200 areas, 40 px", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
    }
    if (!opts.only || opts.only.some((o) => GIANT_ROW.includes(o))) {
      const { dm } = built.giant!;
      await open("giant", 40);
      let made: Op | null = null;
      const arrivals: number[] = [];
      const builds: number[] = [];
      const frames = await throttled(() =>
        rounds(async () => {
          // A new one each round, so each builds from nothing.
          if (made) await dm.op({ t: "template.delete", templateId: (made.template as { id: string }).id });
          made = template(dm.sceneId, dm.memberId, { shape: "emanation", size: 500, origin: { x: 100.5, y: 100.5, z: 0 } });
          // The frame it lands in holds the rules' coverage of 40,000 hexes, the same work in either view, so it is a row of its own.
          arrivals.push(...(await timed(page, cdp, 1, () => dm.op(made!), 1)));
          // Top-down has nothing to build: its frames for as long.
          if (view === "topDown") return timed(page, cdp, 90, async () => undefined, 1);
          const got = await timedUntil(page, cdp, async () => undefined, () => stoodNow(page));
          builds.push(got.ms);
          return got.frames;
        }),
      );
      rows.push({ row: GIANT_ARRIVAL_ROW, view, ms: stats(arrivals.slice(1)) });
      rows.push({ row: GIANT_ROW, view, ms: frameStats(frames) });
      if (view === "isometric") rows.push({ row: GIANT_STOOD_ROW, view, ms: stats(builds.slice(1)) });
    }

    if (view === "isometric") {
      // The cap's first view: the board shown from Top-down with its 200 areas in view, each frame while they stand, nearest the middle first.
      const hook = (call: "turn" | "pick" | "layout", arg?: unknown) =>
        page.evaluate(([c, a]) => (globalThis as unknown as { __rvttIsoHook?: Record<string, (a: unknown) => unknown> }).__rvttIsoHook?.[c]?.(a), [call, arg] as const);
      if (!opts.only || opts.only.some((o) => CAP_FIRST_ROW.includes(o) || CAP_TURN_ROW.includes(o) || CAP_FIRST_TURN_ROW.includes(o))) {
        await open("cap", 12);
        const first: number[] = [];
        const stood: number[] = [];
        for (let r = 0; r <= ROUNDS; r++) {
          await hook("pick", "topDown");
          await frames(page, 30);
          // A reload empties every kept volume, so each round's first view builds them all. It opens in Top-down, or the board would show and build them before the row picks it.
          await page.evaluate((keep) => sessionStorage.setItem(keep, "1"), KEEP_PICK);
          await reloaded(page);
          await page.evaluate((keep) => sessionStorage.removeItem(keep), KEEP_PICK);
          const before = await volumesNow(page);
          if (before !== null) throw new Error("the first view's board was mounted before it was picked");
          await frames(page, 30);
          const got = await throttled(() => timedUntil(page, cdp, () => hook("pick", "isometric").then(() => {}), () => stoodNow(page)));
          if (r > 0) first.push(...got.frames);
          if (r > 0) stood.push(got.ms);
        }
        rows.push({ row: CAP_FIRST_ROW, view, ms: frameStats(first) });
        rows.push({ row: CAP_STOOD_ROW, view, ms: stats(stood) });
        // A turn's first visit: each frame while its bands are made, the areas flat until then (design 6).
        const firstTurn: number[] = [];
        const turnStood: number[] = [];
        for (let r = 0; r <= ROUNDS; r++) {
          await reloaded(page);
          await hook("pick", "isometric");
          await hook("turn", 0);
          await frames(page, 4);
          await waitStood(page);
          const got = await throttled(() => timedUntil(page, cdp, () => hook("turn", 1).then(() => {}), () => stoodNow(page)));
          if (r > 0) firstTurn.push(...got.frames);
          if (r > 0) turnStood.push(got.ms);
        }
        rows.push({ row: CAP_FIRST_TURN_ROW, view, ms: frameStats(firstTurn) });
        rows.push({ row: CAP_FIRST_TURN_STOOD_ROW, view, ms: stats(turnStood) });
        // Each turn's bands, once made, are kept: every turn visited and stood first, then the turns timed.
        for (const t of [2, 3, 0] as const) {
          await hook("turn", t);
          await frames(page, 4);
          await waitStood(page);
        }
        await add(CAP_TURN_ROW, () => throttled(() => rounds(() => timed(page, cdp, 4, async (i) => void (await hook("turn", (i + 1) % 4)), 4))));
      }
      await open("caps", 40);
      await add("turn, caps, 40 px", () => throttled(() => rounds(() => timed(page, cdp, 4, async (i) => void (await hook("turn", (i + 1) % 4)), 4))));
      await add("switch, caps, 40 px, both trees mounted", () => throttled(() => rounds(() => timed(page, cdp, 2, async (i) => void (await hook("pick", i === 0 ? "topDown" : "isometric")), 4))));
      await add("pan, caps, 40 px, both trees mounted", () => throttled(() => rounds(() => touchPan(page, cdp, STEPS))));
      // Back in Top-down, as the builder will force it (ISO-4): a stroke must cost what it does with no isometric tree.
      await hook("pick", "topDown");
      await frames(page, 30);
      await add(BRUSH_ROW, () => throttled(() => rounds(() => brushStrokes(page, cdp, built.caps!.dm))));
      if (capsMap) {
        // The map first drawn while Isometric shows, so the hidden tree holds its side tints when Top-down takes it away.
        await hook("pick", "isometric");
        await built.caps!.dm.op({ t: "scene.setMap", sceneId: built.caps!.dm.sceneId, map: capsMap });
        await page.waitForTimeout(1000);
        await frames(page, 30);
        await hook("pick", "topDown");
        await frames(page, 30);
      }
      await add(MAP_ROW, () => throttled(() => rounds(() => mapSwaps(page, cdp, built.caps!.dm, capsMap!))));
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

const BRUSH_ROW = "a brush stroke's step from another device of the DM's, caps, 40 px";
const AIM_MOVE_ROW = "a sphere aimed with the Area tool, each move, typical with four areas";
const AIM_REST_ROW = "a sphere aimed with the Area tool, each frame once the finger rests until its shape stands, typical with four areas";
export const CAP_FIRST_ROW = "first view, 200 areas, 12 px, each frame while it stands";
const CAP_FIRST_TURN_ROW = "a turn's first visit, 200 areas, 12 px, each frame while it stands";
const CAP_TURN_ROW = "turn, 200 areas, 12 px, each turn visited before";
/** Not a frame: how long until every area in view stands, reported beside the frames (the design's 7 s estimate). */
const CAP_STOOD_ROW = "first view, 200 areas, 12 px, until every area stands (ms whole, not a frame)";
const CAP_FIRST_TURN_STOOD_ROW = "a turn's first visit, 200 areas, 12 px, until every area stands (ms whole, not a frame)";
/** Each frame while a 500 ft emanation of 142,000 faces builds in slices (review ISOA1-GC: its collector pauses). */
const GIANT_ROW = "a 500 ft emanation coming in on hex rows, each frame while it builds, 40 px";
const GIANT_STOOD_ROW = "a 500 ft emanation coming in on hex rows, until it stands (ms whole, not a frame)";
const AIM_REST_STOOD_ROW = "a sphere aimed with the Area tool, once the finger rests until its shape stands (ms whole, not a frame)";
const GIANT_ARRIVAL_ROW = "a 500 ft emanation coming in on hex rows, the frame it lands in, 40 px";

/**
 * A sphere aimed with the Area tool by touch: Sphere picked, a tap on open
 * map places the draft, then a drag moves it, each move timed, and once it
 * rests each frame while its fine shape stands, then Escape lets it go.
 */
async function aimSphere(page: Page, cdp: CDPSession, view: View): Promise<{ moves: number[]; rest: number[]; restMs: number | null }> {
  await pickTool(page, "Area");
  await pickOption(page, "Area", "Shape", "Sphere");
  const box = await boardBox(page);
  const at = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.3 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...at, id: 0 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page, 8);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...at, id: 0 }] });
  await frames(page, 2);
  const moves = await timed(page, cdp, STEPS, (i) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + (i + 1) * 6, y: at.y + (i + 1) * 3, id: 0 }] }).then(() => {}));
  // The finger rests: the preview refines (areas/store.ts REST_MS) and the fine shape stands in the depth list, timed until it does. Top-down stands nothing, so its frames for as long.
  let rest: number[];
  let restMs: number | null = null;
  if (view === "isometric") {
    const before = (await volumesNow(page))?.standing ?? 0;
    const got = await timedUntil(page, cdp, async () => {}, async () => {
      const v = await volumesNow(page);
      return !!v && !v.waiting && v.standing > before;
    });
    rest = got.frames;
    restMs = got.ms;
  } else rest = await timed(page, cdp, 30, async () => {}, 1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frames(page, 4);
  await page.keyboard.press("Escape");
  await frames(page, 8);
  await pickTool(page, "Select");
  await frames(page, 8);
  return { moves, rest, restMs };
}

/** How many areas the board on screen stands and whether one waits to (relief/isoTest.ts volumes), read without the depth list. */
function volumesNow(page: Page): Promise<{ standing: number; waiting: boolean } | null> {
  return page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { volumes?(): { standing: number; waiting: boolean } | null } }).__rvttIsoHook?.volumes?.() ?? null);
}

/** Whether the board on screen has areas standing and none waiting to. */
async function stoodNow(page: Page): Promise<boolean> {
  const v = await volumesNow(page);
  return !!v && !v.waiting && v.standing > 0;
}

/** Waits until the board's areas all stand, and says when. */
async function waitStood(page: Page): Promise<number> {
  for (const until = Date.now() + 60_000; Date.now() < until; ) {
    if (await stoodNow(page)) return Date.now();
    await page.waitForTimeout(50);
  }
  throw new Error("the areas never all stood");
}
/** In Isometric's pass it runs back in Top-down with the isometric tree mounted and hidden, whose side tints read the map (ISO2-OPUS-12). */
const MAP_ROW = "a map image set and taken away from another device of the DM's, caps, 40 px";

type MapRef = { assetId: string; widthPx: number; heightPx: number; cellPx: number; originPx: { x: number; y: number } };

/** A plain map image as big as the caps at 8 px a cell, uploaded to its room. */
async function uploadMap(context: BrowserContext, origin: string, roomId: string): Promise<MapRef> {
  const data = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: { r: 120, g: 110, b: 90 } } }).png().toBuffer();
  const res = await context.request.put(`${origin}/api/rooms/${roomId}/assets?kind=map`, { headers: { Origin: origin, "content-type": "image/png" }, data });
  if (!res.ok()) throw new Error(`the map upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number };
  return { assetId: row.id, widthPx: row.width, heightPx: row.height, cellPx: 8, originPx: { x: 0, y: 0 } };
}

/** Each step sets the map image or takes it away, from another device of the DM's, and waits for the page to load and draw what follows. */
async function mapSwaps(page: Page, cdp: CDPSession, dm: Socket, map: MapRef): Promise<number[]> {
  return timed(page, cdp, 4, async (i) => {
    await dm.op({ t: "scene.setMap", sceneId: dm.sceneId, map: i % 2 === 0 ? map : null });
    await page.waitForTimeout(400);
  }, 30);
}
/** Counts, not times: the ground stage's draws while the ringed and aura'd scout crosses cells, which must be none. */
const GROUND_LOCAL_ROW = "ground stage draws while the ringed and aura'd token is dragged here across cells, typical (draws, not ms)";
const GROUND_REMOTE_ROW = "ground stage draws while another member drags the ringed and aura'd token across cells, typical (draws, not ms)";

/** Each step paints a 2 by 2 patch of the caps in one terrain or another, as a builder stroke on another device does, and the page draws what arrives. */
async function brushStrokes(page: Page, cdp: CDPSession, dm: Socket): Promise<number[]> {
  return timed(page, cdp, STEPS, async (i) => {
    await dm.op({ t: "build.rect", sceneId: dm.sceneId, terrain: i % 2 ? "stone" : "wood", x: 96 + (i % 4) * 2, y: 98, w: 2, h: 2 });
  });
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
export function gate(row: string, ms: Ms, topDown: number | undefined): string {
  const iso = ms.median;
  if (row.startsWith("turn")) return iso <= 150 ? "ok" : "OVER 150 ms";
  if (row.includes("(ms whole, not a frame)")) return "(reported, no gate)";
  if (row.startsWith("ground stage draws")) return iso === 0 ? "ok (none)" : `OVER: ${iso} ground draws`;
  // A build's every frame is held, not its median: most of a build's frames are short slices, and the gate is on each frame.
  if (ms.frames) {
    const budget = Math.max(16, 1.75 * (topDown ?? 0));
    const over = ms.frames.filter((f) => f > budget);
    return over.length === 0 ? `ok, every frame (budget ${budget.toFixed(1)})` : `OVER: ${over.length} of ${ms.frames.length} frames past ${budget.toFixed(1)}, the largest ${ms.max.toFixed(1)}`;
  }
  // A frame Top-down has no counterpart for gets the floor of the gate.
  if (topDown === undefined && row.includes("each frame")) return iso <= 16 ? "ok (budget 16.0)" : "OVER (budget 16.0)";
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
      const g = r.view === "isometric" ? gate(r.row, r.ms, topDown.get(r.row)) : "";
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
  if (argv.includes("--tether")) {
    await tetherWork();
    const start = performance.now();
    const work = await tetherWork();
    console.log(JSON.stringify({ row: "long diagonal tether, 200 cells, 12 px", ...work, ms: performance.now() - start }));
  } else if (argv.includes("--compare")) {
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
    // `--only a,b` times just the rows whose names hold one of those words, for a quick look at a change.
    const only = arg("--only")?.split(",");
    const rows = await runBench(view, parity ? { parity, ...(shots ? { shots } : {}) } : only ? { only } : {});
    const out = arg("--out");
    if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
    if (!parity) console.log(formatReport([rows]));
  }
}
