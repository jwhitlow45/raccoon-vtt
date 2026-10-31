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
 * - hexRows and hexColumns: a fully raised 40 by 40 hex scene on each
 *   orientation (docs/design-v1-iso-hex-relief.md 9): a terrace,
 *   alternating heights, pits and a seeded field over the whole height
 *   range, a wall across levels, 40 creatures of mixed sizes and four
 *   areas, with pans at 40 px, 12 px and fit, a local drag, a warm turn
 *   and a 40 ft cube on alternating hex heights coming in: the frame it
 *   lands in, in both views, then each frame until it stands and the
 *   whole time from its sending until it first stands. In Isometric the
 *   pans at 40 px and 12 px are counted too, on an untimed pan of their
 *   own: the canvas's fills, clips, image copies and patterns and the
 *   ground stage's draws, each a frame.
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
import { hexCenter, sceneHexes } from "../shared/rules/hex.ts";

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
type Ms = { median: number; max: number; n: number; frames?: number[]; rounds?: number[] };
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

/**
 * A fully raised 40 by 40 hex scene on one orientation
 * (docs/design-v1-iso-hex-relief.md 9), or the same on squares
 * (docs/design-v1-relief-pan.md 9): its 1,778 hexes all off the
 * ground, a flat-topped 10 ft terrace over its west third, hexes
 * alternating 5 ft and 15 ft over the middle so every side shows, a
 * mixed field of pits, and a seeded field from -100 ft to 200 ft in the
 * east. On it, a wall across several levels, 40 creatures of mixed sizes
 * and the four areas of the area design's cost section.
 */
export function hexRelief(orient: "rows" | "columns" | "squares") {
  return (sceneId: string, dmId: string): Built => {
    const G = orient === "squares" ? null : ({ shape: "hex", orient } as const);
    const bounds = { w: 40, h: 40 };
    const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds, fogEnabled: false, ...(G ? { gridShape: orient === "rows" ? "hexRows" : "hexColumns" } : {}) } }];
    let seed = orient === "rows" ? 0x40 : orient === "columns" ? 0x41 : 0x42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const byFeet = new Map<number, string[]>();
    // On squares the same rule over every square, by its middle (docs/design-v1-relief-pan.md 9).
    const cellsOf = G ? sceneHexes(G, bounds) : cells(0, 0, bounds.w, bounds.h).map((k) => ({ col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) }));
    for (const h of cellsOf) {
      const c = G ? hexCenter(G, h) : { x: h.col + 0.5, y: h.row + 0.5 };
      const feet = c.x < 13 ? 10 : c.x < 26 ? ((h.col + h.row) % 2 === 0 ? 5 : 15) : c.y < 14 ? -5 * (1 + Math.floor(rand() * 4)) : 5 * (Math.floor(rand() * 61) - 20) || 5;
      byFeet.set(feet, [...(byFeet.get(feet) ?? []), `${h.col},${h.row}`]);
    }
    for (const [height, list] of byFeet) for (const part of chunked(list, 2000)) ops.push({ t: "build.height", sceneId, cells: part, height });
    // A wall across the terrace's edge and the alternating hexes, in runs a free wall may hold.
    for (let i = 0; i < 4; i++) ops.push({ t: "build.walls", sceneId, put: [{ id: `hxbenchw${String(i).padStart(4, "0")}`, a: [8 + i * 6, 20], b: [14 + i * 6, 20.5], f: { kind: "wall" } }] });
    const tokens: Op[] = [];
    const sizes = ["medium", "medium", "small", "large", "medium", "huge", "medium", "gargantuan"] as const;
    for (let i = 0; i < 40; i++) tokens.push(token(sceneId, `Creature ${i + 1}`, 3 + (i % 10) * 3.6, 4 + Math.floor(i / 10) * 8, { size: sizes[i % sizes.length] }));
    for (const t of tokens) ops.push({ t: "token.create", token: t });
    ops.push(template(sceneId, dmId, { shape: "sphere", size: 20, origin: { x: 20.5, y: 15.5, z: 10 } }));
    ops.push(template(sceneId, dmId, { shape: "cone", size: 30, origin: { x: 17, y: 18, z: 0 }, yaw: 315, pitch: 40, color: "#e5484d" }));
    ops.push(template(sceneId, dmId, { shape: "cylinder", size: 10, height: 40, origin: { x: 23.5, y: 13.5, z: 0 }, color: "#30a46c" }));
    ops.push(template(sceneId, dmId, { shape: "emanation", size: 15, origin: { x: 18.5, y: 13.5, z: 0 }, attachedTo: tokens[13]!.id, includeOrigin: false, color: "#f38400" }));
    // The walker is a Medium at (17.4, 20), near the camera, so it stays on a phone's screen in every view.
    return { ops, walker: tokens[24]!.id as string, bounds, at40: { x: 20, y: 20 } };
  };
}

/** The 40 ft cube the hex relief rows bring in over the alternating hexes, and the row names. */
const HEX_CUBE = { shape: "cube", size: 40, origin: { x: 16, y: 26, z: 20 }, yaw: 0 };

/**
 * A 200 by 200 square scene sunk 100 ft, one pit: at 12 px a cell the
 * floors by the screen's top show ground from past the ground canvas's top
 * edge, so a pan repairs many toned cells (docs/design-v1-relief-pan.md
 * 5.3, review HXPERF2B-OPUS-05, where 1,250 were counted). A smaller scene
 * fits the screen at 12 px and tones none.
 */
function pits(sceneId: string): Built {
  const deep = cells(0, 0, 200, 200);
  const ops: Op[] = [{ t: "scene.update", sceneId, patch: { bounds: { w: 200, h: 200 }, fogEnabled: false } }];
  for (const part of chunked(deep, 2000)) ops.push({ t: "build.height", sceneId, cells: part, height: -100 });
  const walker = token(sceneId, "Walker", 100.5, 100.5);
  ops.push({ t: "token.create", token: walker });
  return { ops, walker: walker.id as string, bounds: { w: 200, h: 200 }, at40: { x: 100, y: 100 } };
}
const hexRow = (orient: string, what: string) => `${what}, hex relief ${orient}`;

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

type Timer = (page: Page, cdp: CDPSession, steps: number, act: (i: number) => Promise<void>) => Promise<number[]>;

/** What a frame did, read from the test hook (relief/isoTest.ts), which a build before the kept picture lacks. */
export type FrameParts = { ms: number; whole: boolean; sliced: boolean; rendered: boolean };

type HookCounts = { whole: number; slices: number; boardCommits: number };

function hookCounts(page: Page): Promise<HookCounts | null> {
  return page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { kept?(): HookCounts | null } }).__rvttIsoHook?.kept?.() ?? null);
}

/**
 * Like `timed`, but each frame after a step on its own, with what it did.
 * Background work runs in the frames after a move, so a move's frames
 * summed would hold several slices against one frame's budget. The hook is
 * read between frames, outside the busy time counted.
 */
function timedEachFrame(parts: FrameParts[], settleFrames = 4): Timer {
  return async (page, cdp, steps, act) => {
    const out: number[] = [];
    let counts = await hookCounts(page);
    for (let i = 0; i < steps; i++) {
      let last = await busy(cdp);
      await act(i);
      for (let f = 0; f < settleFrames; f++) {
        await frames(page, 1);
        const ms = (await busy(cdp)) - last;
        out.push(ms);
        const next = await hookCounts(page);
        if (counts && next) parts.push({ ms, whole: next.whole > counts.whole, sliced: next.slices > counts.slices, rendered: next.boardCommits > counts.boardCommits });
        counts = next;
        last = await busy(cdp);
      }
    }
    return out;
  };
}

/** The parts of the frames past `over` ms: how many there were, and how many of them repainted whole, ran a background slice or rendered the board. */
export function partsPast(parts: readonly FrameParts[], over: number): { frames: number; whole: number; sliced: number; rendered: number; slicedAll: number } {
  const past = parts.filter((p) => p.ms > over);
  return { frames: past.length, whole: past.filter((p) => p.whole).length, sliced: past.filter((p) => p.sliced).length, rendered: past.filter((p) => p.rendered).length, slicedAll: parts.filter((p) => p.sliced).length };
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

/** The first point down the canvas's left edge, from its middle outward, where a press meets only the canvas and no shape that listens. The middle if none is clear. */
function emptySpot(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((b) => {
    type Stage = { width(): number; listening(): boolean; getIntersection(p: { x: number; y: number }): unknown };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document;
    const stage = konva.stages.find((s) => s.width() > 0 && s.listening());
    for (const f of [0.45, 0.35, 0.55, 0.25, 0.65, 0.15, 0.75]) {
      const p = { x: b.x + 30, y: b.y + b.height * f };
      if (doc.elementFromPoint(p.x, p.y)?.tagName !== "CANVAS") continue;
      if (stage && stage.getIntersection({ x: p.x - b.x, y: p.y - b.y })) continue;
      return p;
    }
    return { x: b.x + 30, y: b.y + b.height * 0.45 };
  }, box);
}

async function touchPan(page: Page, cdp: CDPSession, steps: number, time: Timer = timed): Promise<number[]> {
  const box = await boardBox(page);
  // An empty spot by the canvas's left edge, so the press pans rather than picks a creature, as one does at fit in Isometric on the hex fixtures.
  const start = await emptySpot(page, box);
  const before = await stageAt(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 0 }] });
  await frames(page, 2);
  const out = await time(page, cdp, steps, (i) => cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (i + 1) * 9, y: start.y + (i + 1) * 4, id: 0 }] }).then(() => {}));
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

/**
 * The canvas calls a pan makes, each a frame, counted on an untimed pan of
 * its own: the 2D context's fills and strokes, its clips and image copies,
 * the patterns it makes, and the ground stage's draws. The counting comes
 * off again before the next timed row, so it slows none.
 */
async function canvasCalls(page: Page, cdp: CDPSession, steps: number): Promise<{ fills: number; cuts: number; patterns: number; ground: number; kept: Record<string, number> | null }> {
  await countGroundDraws(page);
  const keptNow = () => page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { kept?(): Record<string, number> | null } }).__rvttIsoHook?.kept?.() ?? null);
  // The painted shares cost the scroll its unions, so they are measured on this untimed pan only (kept.ts KeptRelief.measure).
  const measure = (on: boolean) => page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook?: { measure?(on: boolean): void } }).__rvttIsoHook?.measure?.(v), on);
  await measure(true);
  const before = await keptNow();
  await page.evaluate(() => {
    type Proto = Record<string, (...a: unknown[]) => unknown>;
    const g = globalThis as unknown as { CanvasRenderingContext2D: { prototype: Proto }; __benchCanvas?: { n: Record<string, number>; kept: Proto } };
    const proto = g.CanvasRenderingContext2D.prototype;
    const n: Record<string, number> = { fill: 0, stroke: 0, clip: 0, drawImage: 0, createPattern: 0 };
    const kept: Proto = {};
    for (const k of Object.keys(n)) {
      const f = proto[k]!;
      kept[k] = f;
      proto[k] = function (this: unknown, ...a: unknown[]) {
        n[k]!++;
        return f.apply(this, a);
      };
    }
    g.__benchCanvas = { n, kept };
  });
  await touchPan(page, cdp, steps);
  const n = await page.evaluate(() => {
    type Proto = Record<string, (...a: unknown[]) => unknown>;
    const g = globalThis as unknown as { CanvasRenderingContext2D: { prototype: Proto }; __benchCanvas?: { n: Record<string, number>; kept: Proto } };
    const { n, kept } = g.__benchCanvas!;
    Object.assign(g.CanvasRenderingContext2D.prototype, kept);
    delete g.__benchCanvas;
    return n;
  });
  await measure(false);
  const ground = await groundDraws(page);
  const per = (v: number) => Math.round((10 * v) / steps) / 10;
  // The kept picture's counts (relief/isoTest.ts kept): absent on a build before it. A pan's two return moves count with the timed ones.
  const after = await keptNow();
  let kept: Record<string, number> | null = null;
  if (before && after) {
    const moves = steps + 2;
    const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
    const scrolls = Math.max(1, d("scrolls"));
    const share = (k: string) => Math.round((1000 * d(k)) / scrolls) / 10;
    kept = {
      "whole repaints": Math.round((100 * d("whole")) / moves) / 100,
      "scroll strips, % of the canvas": share("bands"),
      "ground-edge repair, % of the canvas": share("repair"),
      "strips and repair together, % of the canvas": share("union"),
      "toned boxes": Math.round((10 * d("toned")) / Math.max(1, d("whole") + d("scrolls"))) / 10,
      "board renders": Math.round((100 * d("boardCommits")) / moves) / 100,
      "map stage renders": Math.round((100 * d("mapCommits")) / moves) / 100,
      "slices in a frame that repainted whole": d("slicesInWhole"),
    };
  }
  return { fills: per(n.fill! + n.stroke!), cuts: per(n.clip! + n.drawImage!), patterns: per(n.createPattern!), ground: per(ground), kept };
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

type Room = { roomId: string; name: string; password: string };

async function createRoom(page: Page, name: string): Promise<Room> {
  await page.goto(`${new URL(page.url()).origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  // A player joins some rooms (docs/design-v1-relief-pan.md 9), with the password the form offers.
  const password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  if (!match) throw new Error(`The DM link looks wrong: ${link}`);
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  return { roomId: match[1]!.replace("-", ""), name, password };
}

/** Joins a room as a player in a context of the player's own, through the join API as e2e/areas.e2e.ts does. Returns the member id. */
async function joinAs(context: BrowserContext, origin: string, room: Room, name: string): Promise<string> {
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await context.request.post(`${origin}/api/rooms/${room.roomId}/join`, { headers, data: { password: room.password } });
  if (!joined.ok()) throw new Error(`joining ${room.roomId} answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${origin}/api/rooms/${room.roomId}/join/complete`, { headers, data: { ticket, name, color: "#30a46c" } });
  if (!done.ok()) throw new Error(`completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
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
    const cookieNow = async () => (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    /*
     * One DM socket at a time beside the page's: the server lets a session hold
     * eight (server/rooms/budgets.ts DEFAULT_SOCKET_CAPS), fewer than the rooms.
     * A room's socket closes once its scene is built, and the room being timed
     * opens a new one (`dmOf`).
     */
    let live: string | null = null;
    const dmOf = async (kind: string): Promise<Socket> => {
      const b = built[kind]!;
      if (live === kind) return b.dm;
      if (live !== null) built[live]!.dm.close();
      b.dm = await Socket.open(server.origin, b.room.roomId, await cookieNow());
      sockets.push(b.dm);
      live = kind;
      return b.dm;
    };
    // The rooms for areas come last, so the others keep their ids and the parity images of before still match.
    for (const [kind, make] of [
      ["typical", typical],
      ["caps", caps],
      ["crowd", crowd],
      ["areas", areas],
      ["cap", cap],
      ["giant", giant],
      ["hexRows", hexRelief("rows")],
      ["hexColumns", hexRelief("columns")],
      ["squares", hexRelief("squares")],
      ["pits", pits],
    ] as const) {
      const room = await createRoom(page, `Bench iso ${kind} ${stamp}`);
      rooms.push(room);
      const dm = await Socket.open(server.origin, room.roomId, await cookieNow());
      const scene = make(dm.sceneId, dm.memberId);
      for (const op of scene.ops) await dm.op(op);
      dm.close();
      built[kind] = { room, scene, dm };
    }

    if (opts.parity) {
      mkdirSync(opts.parity, { recursive: true });
      for (const [kind, { room, scene }] of Object.entries(built)) {
        const dm = await dmOf(kind);
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
    /** A pan row: its moves, and each counted round's largest move, which the largest-move gate pairs with Top-down's (D-261030-538). */
    const addPan = async (row: string, run: () => Promise<number[]>) => {
      if (opts.only && !opts.only.some((o) => row.includes(o))) return;
      const maxes: number[] = [];
      const all = await throttled(async () => {
        await run();
        const out: number[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const got = await run();
          maxes.push(Math.max(...got));
          out.push(...got);
        }
        return out;
      });
      rows.push({ row, view, ms: { ...stats(all), rounds: maxes } });
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
      const { room, scene } = built[kind]!;
      const dm = await dmOf(kind);
      await startAt(dm, scene.at40, zoom);
      await openView(context, page, view, room.roomId);
      return dm;
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
      // The caps at 12 px, its largest move reported, not gated (D-261030-538).
      await open("caps", 12);
      await addPan("pan, caps, 12 px", () => touchPan(page, cdp, STEPS));
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
      const dm = await open("giant", 40);
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

    // The fully raised scenes, each hex orientation and squares: pans at the zooms around the threshold and at fit, a local drag, and in Isometric a turn and a 40 ft cube coming in.
    for (const orient of ["rows", "columns", "squares"] as const) {
      const kind = orient === "rows" ? "hexRows" : orient === "columns" ? "hexColumns" : "squares";
      const { scene } = built[kind]!;
      for (const zoom of [40, 12, "fit", 24, 23] as const) {
        // 23 and 24 px are Low power's: heights lie flat below 24 px a cell there and stand from it. The page reloads with the setting on.
        const low = zoom === 23 || zoom === 24;
        await page.evaluate((on) => (on ? localStorage.setItem("rvtt.lowPower", "on") : localStorage.removeItem("rvtt.lowPower")), low);
        await open(kind, zoom);
        const pan = hexRow(orient, `pan, ${zoom === "fit" ? "fit" : `${zoom} px`}${low ? ` in Low power, ${zoom === 24 ? "standing" : "flat"}` : ""}`);
        await addPan(pan, () => touchPan(page, cdp, STEPS));
        if (view === "isometric" && (zoom === 40 || zoom === 12) && (!opts.only || opts.only.some((o) => pan.includes(o)))) {
          const c = await throttled(() => canvasCalls(page, cdp, STEPS));
          const count = (what: string, v: number) => rows.push({ row: hexRow(orient, `pan, ${zoom} px, ${what} a frame (calls, not ms)`), view, ms: { median: v, max: v, n: STEPS } });
          count("fills and strokes", c.fills);
          count("clips and image copies", c.cuts);
          count("patterns made", c.patterns);
          count("ground stage draws", c.ground);
          if (c.kept) for (const [what, v] of Object.entries(c.kept)) count(what, v);
        }
      }
      await page.evaluate(() => localStorage.removeItem("rvtt.lowPower"));
      if (orient === "rows") {
        // With the walker's action bar showing, as the DM's page shows it: the bar renders with the camera the canvas last drew, each move.
        for (const zoom of [12, 40] as const) {
          await open(kind, zoom);
          const p = await tokenPoint(page, scene.walker);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p, id: 0 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await frames(page, 12);
          await addPan(hexRow(orient, `pan, ${zoom} px, with the walker's action bar shown`), () => touchPan(page, cdp, STEPS));
          await page.keyboard.press("Escape");
        }
        // Across two cull steps among the four areas, each step restarting their build: every frame held, as a build's frames are, and the slow ones named by what they did.
        const building = hexRow(orient, "pan across two cull steps among the four areas, 40 px, each frame held");
        if (!opts.only || opts.only.some((o) => building.includes(o))) {
          await open(kind, 40);
          if (view === "isometric") await waitStood(page);
          const parts: FrameParts[] = [];
          const all = await throttled(async () => {
            await touchPan(page, cdp, 40);
            const out: number[] = [];
            for (let r = 0; r < ROUNDS; r++) out.push(...(await touchPan(page, cdp, 40, timedEachFrame(parts))));
            return out;
          });
          rows.push({ row: building, view, ms: frameStats(all) });
          if (view === "isometric" && parts.length > 0) {
            const p = partsPast(parts, 16);
            const counted = (what: string, n: number) => rows.push({ row: `${building}: ${what} (calls, not ms)`, view, ms: { median: n, max: n, n: parts.length } });
            counted("frames past 16 ms", p.frames);
            counted("of those, frames that repainted whole", p.whole);
            counted("of those, frames that ran a background slice", p.sliced);
            counted("of those, frames that rendered the board", p.rendered);
            counted("frames that ran a background slice, of every frame", p.slicedAll);
          }
        }
      }
      const dm = await open(kind, 40);
      await add(hexRow(orient, "local drag, whole frame, 40 px"), () => throttled(() => rounds(() => touchDrag(page, cdp, scene.walker, STEPS))));
      const hexRows = !opts.only || opts.only.some((o) => "hex relief".includes(o) || o.includes("hex relief"));
      if (view === "isometric" && hexRows) {
        const hook = (call: "turn" | "pick", arg?: unknown) => page.evaluate(([c, a]) => (globalThis as unknown as { __rvttIsoHook?: Record<string, (a: unknown) => unknown> }).__rvttIsoHook?.[c]?.(a), [call, arg] as const);
        // A turn keeps still the point a press at the middle meets, here a column up to 200 ft tall at the scene's near corner, so the
        // camera would walk off toward it turn by turn. The selected walker is the point it keeps instead (boardPick.ts heldPoint).
        await select(page, [scene.walker]);
        for (const t of [1, 2, 3, 0] as const) {
          await hook("turn", t);
          await frames(page, 6);
          await waitStood(page);
        }
        await add(`turn, hex relief ${orient}, 40 px, each turn visited before`, () => throttled(() => rounds(() => timed(page, cdp, 4, async (i) => void (await hook("turn", (i + 1) % 4)), 4))));
      }
      if (hexRows) {
        /*
         * The 40 ft cube comes in from another device of the DM's, as the 500 ft
         * emanation does. The frame it lands in holds what any new area costs
         * either view (the store, the rules' coverage its flat drawing reads,
         * a layout), so it is a row of its own, timed in both. Then each frame
         * until it stands, Top-down's for as long having nothing to build, and
         * in Isometric the whole time from the op's sending until the board
         * first says it stands: one more area standing than the scene's own,
         * read each round once the cube before it is gone, so that cube is
         * never read as this one.
         */
        let made: Op | null = null;
        const arrivals: number[] = [];
        const builds: number[] = [];
        let others = -1;
        const standing = async () => (await volumesNow(page))?.standing ?? 0;
        const frames2 = await throttled(() =>
          rounds(async () => {
            if (made) {
              const had = view === "isometric" ? await standing() : 0;
              await dm.op({ t: "template.delete", templateId: (made.template as { id: string }).id });
              if (view === "isometric") for (const until = Date.now() + 10_000; Date.now() < until && (await standing()) >= had; ) await page.waitForTimeout(20);
            }
            // Read again each round, once the cube before is gone: what else stands can change between rounds.
            if (view === "isometric") {
              if (others < 0) await waitStood(page);
              others = await standing();
            }
            made = template(dm.sceneId, dm.memberId, HEX_CUBE);
            const sent = Date.now();
            arrivals.push(...(await timed(page, cdp, 1, () => dm.op(made!), 1)));
            if (view === "topDown") return timed(page, cdp, 3, async () => undefined, 1);
            const got = await timedUntil(
              page,
              cdp,
              async () => undefined,
              async () => {
                const v = await volumesNow(page);
                return !!v && !v.waiting && v.standing > others;
              },
              1,
            );
            builds.push(Date.now() - sent);
            return got.frames;
          }),
        );
        rows.push({ row: hexRow(orient, "a 40 ft cube on alternating hex heights, the frame it lands in, 40 px"), view, ms: stats(arrivals.slice(1)) });
        rows.push({ row: hexRow(orient, "a 40 ft cube on alternating hex heights, each frame while it builds, 40 px"), view, ms: frameStats(frames2) });
        if (view === "isometric") rows.push({ row: hexRow(orient, "a 40 ft cube on alternating hex heights, from its sending until it stands (ms whole, not a frame)"), view, ms: stats(builds.slice(1)) });
      }
    }

    // A scene sunk 100 ft: a pan repairs many toned cells, in rows past a few (kept.ts repairRegions), and counted in Isometric.
    if (!opts.only || opts.only.some((o) => PITS_ROW.includes(o))) {
      // No areas stand on this scene, so nothing waits to stand.
      await open("pits", 12);
      await frames(page, 30);
      await addPan(PITS_ROW, () => touchPan(page, cdp, STEPS));
      if (view === "isometric") {
        const c = await throttled(() => canvasCalls(page, cdp, STEPS));
        const count = (what: string, v: number) => rows.push({ row: `${PITS_ROW}: ${what} a frame (calls, not ms)`, view, ms: { median: v, max: v, n: STEPS } });
        count("fills and strokes", c.fills);
        if (c.kept) for (const [what, v] of Object.entries(c.kept)) count(what, v);
      }
    }

    // About 30 pin labels round the camera with the four area names: the pills the drag and overlay layers slide through a pan (5.8).
    const pinIds = Array.from({ length: 30 }, (_, i) => `bench-pin-${String(i + 1).padStart(4, "0")}`);
    const putPins = async (dm: Socket) => {
      for (const [i, id] of pinIds.entries()) {
        await dm.op({ t: "pin.put", pin: { id, sceneId: dm.sceneId, x: 8.5 + (i % 6) * 4.5, y: 9.5 + Math.floor(i / 6) * 5, color: "#f7df00", label: `Pin ${i + 1}`, visibility: "all" } });
      }
    };
    const removePins = async (dm: Socket) => {
      for (const id of pinIds) await dm.op({ t: "pin.remove", pinId: id });
    };
    if (!opts.only || opts.only.some((o) => PILLS_ROW.includes(o) || HIDDEN_PILLS_ROW.includes(o))) {
      const dm = await open("hexRows", 12);
      await putPins(dm);
      await frames(page, 30);
      if (view === "isometric") await waitStood(page);
      await addPan(PILLS_ROW, () => touchPan(page, cdp, STEPS));
      if (view === "isometric") {
        // Back in Top-down with the isometric tree kept and hidden: its pills hear no camera (review HXPERF2B-ASTRA-01).
        const pills = () => page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { kept?(): { pillCommits?: number } | null } }).__rvttIsoHook?.kept?.()?.pillCommits ?? null);
        await page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { pick(p: string): void } }).__rvttIsoHook?.pick("topDown"));
        await frames(page, 30);
        const before = await pills();
        await touchPan(page, cdp, STEPS);
        const after = await pills();
        // A build before the lane counts no pills: no row then.
        if (before !== null && after !== null) {
          const v = Math.round((100 * (after - before)) / (STEPS + 2)) / 100;
          rows.push({ row: HIDDEN_PILLS_ROW, view, ms: { median: v, max: v, n: STEPS + 2 } });
        }
        await page.evaluate(() => (globalThis as unknown as { __rvttIsoHook?: { pick(p: string): void } }).__rvttIsoHook?.pick("isometric"));
        await frames(page, 30);
      }
      await removePins(dm);
    }

    // Pat on a phone of her own (design 9): her page's pans with her action bar shown, and a fog tile revealed on her board each step.
    const patRows = [patBarRow(12), patBarRow(40), PAT_FOG_HEX_ROW, PAT_FOG_GIANT_ROW];
    if (!opts.only || opts.only.some((o) => patRows.some((r) => r.includes(o)))) {
      const patContext = await browser.newContext(PHONE);
      const pat = await patContext.newPage();
      await pat.goto(`${server.origin}/`);
      const patCdp = await patContext.newCDPSession(pat);
      await patCdp.send("Performance.enable", { timeDomain: "timeTicks" });
      const patThrottled = async <T>(run: () => Promise<T>) => {
        await patCdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
        try {
          return await run();
        } finally {
          await patCdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        }
      };
      const patPan = async (row: string) => {
        if (opts.only && !opts.only.some((o) => row.includes(o))) return;
        const maxes: number[] = [];
        const all = await patThrottled(async () => {
          await touchPan(pat, patCdp, STEPS);
          const out: number[] = [];
          for (let r = 0; r < ROUNDS; r++) {
            const got = await touchPan(pat, patCdp, STEPS);
            maxes.push(Math.max(...got));
            out.push(...got);
          }
          return out;
        });
        rows.push({ row, view, ms: { ...stats(all), rounds: maxes } });
      };
      /** Opens the room on Pat's page at the scene's saved view, in this run's view. */
      const patOpen = async (kind: string, zoom: number) => {
        const { room, scene } = built[kind]!;
        await startAt(await dmOf(kind), scene.at40, zoom);
        await openView(patContext, pat, view, room.roomId);
        if (view === "isometric") await waitStood(pat);
      };
      // Bree, Pat's PC, in each room Pat joins, near the camera.
      const bree: Record<string, string> = {};
      for (const kind of ["hexRows", "giant"] as const) {
        const b = built[kind]!;
        const dm = await dmOf(kind);
        const patId = await joinAs(patContext, server.origin, b.room, "Pat");
        const charId = benchId("character");
        await dm.op({ t: "character.create", character: { id: charId, name: "Bree", size: "medium", ownerIds: [patId], actor: actor() } });
        const t = token(dm.sceneId, "Bree", b.scene.at40.x - 0.5, b.scene.at40.y + 1.5, { kind: "pc", disposition: "ally", actor: { ref: charId } });
        await dm.op({ t: "token.create", token: t });
        bree[kind] = t.id as string;
      }
      for (const zoom of [12, 40] as const) {
        if (opts.only && !opts.only.some((o) => patBarRow(zoom).includes(o))) continue;
        await patOpen("hexRows", zoom);
        const p = await tokenPoint(pat, bree.hexRows!);
        await patCdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...p, id: 0 }] });
        await patCdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await frames(pat, 12);
        await patPan(patBarRow(zoom));
        await pat.keyboard.press("Escape");
      }
      /*
       * A fog tile revealed each step on Pat's board. An area stands only on
       * ground Pat has seen, so the scene starts revealed but for the tiles
       * the steps reveal, which lie off every area's plan: past the four
       * areas on the 40 by 40 scene, and in the corners the 500 ft
       * emanation's circle leaves on the 200 by 200 one.
       */
      for (const [kind, row, steps] of [
        ["hexRows", PAT_FOG_HEX_ROW, [[2, 0], [2, 1], [0, 2], [1, 2], [2, 2]]],
        // Four steps only: each costs seconds on either build.
        ["giant", PAT_FOG_GIANT_ROW, [[0, 0], [12, 0], [0, 12], [12, 12]]],
      ] as const) {
        if (opts.only && !opts.only.some((o) => row.includes(o))) continue;
        const dm = await dmOf(kind);
        const b = built[kind]!;
        const all = { kind: "rect", x: 0, y: 0, w: b.scene.bounds.w, h: b.scene.bounds.h };
        const tile = ([tx, ty]: readonly [number, number]) => ({ kind: "rect", x: tx * 16, y: ty * 16, w: 16, h: 16 });
        const reset = () => dm.op({ t: "fog.live", sceneId: dm.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: all }, ...steps.map((t) => ({ id: randomUUID(), mode: "hide", shape: tile(t) }))] });
        await dm.op({ t: "scene.update", sceneId: dm.sceneId, patch: { fogEnabled: true } });
        await reset();
        // The 200 by 200 scene's 500 ft emanation, standing on what Pat has seen.
        const emanation = kind === "giant" ? template(dm.sceneId, dm.memberId, { shape: "emanation", size: 500, origin: { x: 100.5, y: 100.5, z: 0 } }) : null;
        if (emanation) await dm.op(emanation);
        await patOpen(kind, 40);
        const tiles = await patThrottled(() =>
          rounds(async () => {
            await reset();
            await frames(pat, 30);
            if (view === "isometric") await waitStood(pat);
            return timed(pat, patCdp, steps.length, async (i) => {
              await dm.op({ t: "fog.live", sceneId: dm.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: tile(steps[i]!) }] });
            });
          }),
        );
        rows.push({ row, view, ms: stats(tiles) });
        if (emanation) await dm.op({ t: "template.delete", templateId: (emanation.template as { id: string }).id });
        await dm.op({ t: "scene.update", sceneId: dm.sceneId, patch: { fogEnabled: false } });
      }
      await patContext.close();
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
      // The page's live heap after a forced collection, the caps shown in Isometric and then hidden, beside the map row's largest step (D-261030-546).
      if (!opts.only || opts.only.some((o) => MAP_ROW.includes(o))) {
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
        const mb = Math.round(heap.usedSize / 1e5) / 10;
        rows.push({ row: "live heap after a forced collection, caps shown in Isometric then hidden (MB, not ms)", view, ms: { median: mb, max: mb, n: 1 } });
      }
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
const PITS_ROW = "pan, 12 px, a 200 by 200 square scene sunk 100 ft";
const PILLS_ROW = hexRow("rows", "pan, 12 px, with 30 pin labels and the four area names");
const HIDDEN_PILLS_ROW = hexRow("rows", "pill board views rendered a move, a Top-down pan with the isometric tree hidden, 30 pin labels (calls, not ms)");
const patBarRow = (zoom: number) => hexRow("rows", `pan, ${zoom} px, on Pat's page with her action bar shown`);
const PAT_FOG_HEX_ROW = hexRow("rows", "a fog tile revealed each step on Pat's board, the four areas standing, 40 px");
const PAT_FOG_GIANT_ROW = "a fog tile revealed each step on Pat's board, 200 by 200 hex rows with the 500 ft emanation standing, 40 px";
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
  throw new Error(`the areas never all stood: ${JSON.stringify(await volumesNow(page))}`);
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

/**
 * The largest-move gate (D-261030-538 as applied, review HXPERF2-ASTRA-09):
 * on the 40 by 40 fixtures each round's largest Isometric move against
 * max(16 ms, 1.75 times the same round's largest Top-down move), a row
 * missing when at least two of three pairs do. The caps report theirs.
 * Says the medians and the worst move apart, with the verdict.
 */
export function largestGate(row: string, iso: Ms, topDown: Ms | undefined): string {
  if (!iso.rounds) return "";
  const median = (v: readonly number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
  const raw = `largest moves ${iso.rounds.map((v) => v.toFixed(1)).join(", ")} (median ${median(iso.rounds).toFixed(1)}, worst ${iso.max.toFixed(1)})`;
  if (!topDown?.rounds) return `${raw}, no Top-down match`;
  const tds = topDown.rounds;
  const budgets = iso.rounds.map((v, i) => Math.max(16, 1.75 * (tds[i] ?? 0)));
  const misses = iso.rounds.filter((v, i) => v > budgets[i]!).length;
  const gated = /hex relief|squares/.test(row) && !row.includes("caps");
  const verdict = !gated ? "reported" : misses >= 2 ? `OVER in ${misses} of ${iso.rounds.length} pairs` : `ok in ${iso.rounds.length - misses} of ${iso.rounds.length} pairs`;
  return `${raw}; Top-down ${tds.map((v) => v.toFixed(1)).join(", ")}; budgets ${budgets.map((b) => b.toFixed(1)).join(", ")}: ${verdict}`;
}

/** Section 11's gates: every frame at most max(16 ms, 1.75 times Top-down's same frame), a turn at the caps at most 150 ms whole. */
export function gate(row: string, ms: Ms, topDown: number | undefined): string {
  const iso = ms.median;
  if (row.startsWith("turn")) return iso <= 150 ? "ok" : "OVER 150 ms";
  if (row.includes("(ms whole, not a frame)") || row.includes("(calls, not ms)") || row.includes("(MB, not ms)")) return "(reported, no gate)";
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
  const lines = ["row | view | ms (median / max, n) | gate | largest move", "--- | --- | --- | --- | ---"];
  const topDown = new Map<string, Ms>();
  for (const set of sets) for (const r of set) if (r.view === "topDown") topDown.set(r.row, r.ms);
  for (const set of sets) {
    for (const r of set) {
      const g = r.view === "isometric" ? gate(r.row, r.ms, topDown.get(r.row)?.median) : "";
      const l = r.view === "isometric" ? largestGate(r.row, r.ms, topDown.get(r.row)) : r.ms.rounds ? `largest moves ${r.ms.rounds.map((v) => v.toFixed(1)).join(", ")}` : "";
      lines.push(`${r.row} | ${r.view} | ${r.ms.median.toFixed(1)} / ${r.ms.max.toFixed(1)}, ${r.ms.n} | ${g} | ${l}`);
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
