import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { uuidv7 } from "#shared/ids.ts";
import type { ImageRef, ModelRef, Token } from "../shared/model.ts";
import { binaryStl, box, figure, Glb, zUp } from "../client/features/models/fixtures.testutil.ts";
import { frameFor } from "../client/features/models/frames.ts";
import type { Turn } from "../client/lib/view.ts";
import { openGroup } from "./helpers/groups.ts";
import { setupHistory } from "./helpers/undoScope.ts";
import { barControl, ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * 3D models on token pictures (docs/design/design-v1-token-models.md 3, 6
 * and 10), under the app's own CSP: the DM adds a generated STL and a
 * textured GLB through the 3D model sheet, sees each stand in Isometric by
 * its pixels, turns the view and the facing and sees the frame follow,
 * and taps a model's clear corner to pick the creature behind. Pat, on a
 * phone, adds one to his own token. Remove model takes two taps, and the
 * DM's Undo brings it back. Every place that changes a picture keeps its
 * model, a Wild Shape swap swaps it, and a group under Picture's color
 * draws one sheet per picture. Every socket frame Pat's page receives and
 * every asset it fetches is recorded, and none names the hidden
 * creature's sheet.
 *
 * Test models are made here from primitives and flat colors, never art
 * (client/features/models/fixtures.testutil.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 41;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-models-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script, as only a test sets it: it installs the iso test hook (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 14, h: 10 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat") };
/** Every URL Pat's page asked for, the model worker's included. */
const patRequests: string[] = [];

const run = {
  roomId: "",
  roomName: `E2E models ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thornChar: uuidv7(),
  knight: uuidv7(),
  behind: uuidv7(),
  wolf: uuidv7(),
  thorn: uuidv7(),
  lurker: uuidv7(),
  /** A picture the knight and the group wear, a flat color. */
  face: "",
  lurkerSheet: "",
  lurkerFace: "",
  g1: uuidv7(),
  g2: uuidv7(),
  g3: uuidv7(),
  red: "",
  blue: "",
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

function tokenOp(id: string, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", disposition: "hostile", kind: "monster", actor: { inline: actor() }, ...extra } };
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** An image uploaded as `kind` from the DM's browser context, by its new asset id. */
async function upload(kind: "token" | "model", data: Buffer, type = "image/png"): Promise<string> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": type }, data });
  assert.ok(res.ok(), `the ${kind} upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

/** A flat color picture, 256 px. */
function flat(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

/** A sheet laid out as the worker lays one out, drawn from flat shapes: 8 frames of 512 px, each a block inside its drawn box [30, 20, 70, 90]. */
function flatSheet(hue: number): Promise<Buffer> {
  const parts: string[] = [];
  for (let f = 0; f < 8; f++) {
    const ox = (f % 4) * 512;
    const oy = Math.floor(f / 4) * 512;
    parts.push(`<rect x="${ox + 174}" y="${oy + 184}" width="164" height="256" fill="hsl(${hue},60%,45%)"/>`);
  }
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024">${parts.join("")}</svg>`)).png().toBuffer();
}

const FLAT_BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, () => [30, 20, 70, 90]);

/** The knight: a mini on a round base, Z up as an STL stands. */
const knightStl = () => Buffer.from(binaryStl(zUp(figure(32))));

/**
 * A textured box on a base, Y up as a GLB stands, its sides tiled with a
 * red and blue checker, so its pixels show the texture was read.
 */
async function texturedGlb(): Promise<Buffer> {
  const size = 32;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const red = ((x >> 3) + (y >> 3)) % 2 === 0;
      raw.set(red ? [220, 30, 30] : [30, 40, 220], (y * size + x) * 3);
    }
  const png = new Uint8Array(await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
  const t = box([-0.35, 0, -0.3], [0.35, 1.2, 0.3]);
  const uv: number[] = [];
  for (let i = 0; i < t.length; i += 3) uv.push((t[i]! + t[i + 2]! + 0.7) * 1.5, t[i + 1]! * 1.5);
  const g = new Glb();
  g.json.images = [{ bufferView: g.view(png), mimeType: "image/png" }];
  g.json.textures = [{ source: 0 }];
  g.json.samplers = [{}];
  g.json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }];
  const mesh = g.meshOf(t, { material: 0, attributes: { TEXCOORD_0: g.floats(uv, "VEC2") } });
  g.node({ mesh });
  return Buffer.from(g.build());
}

const bar = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions` });
/** The token's panel: the side panel's Token tab from 900 px up, the Token sheet below. */
const tokenPanel = (page: Page) => page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true }));
const modelSheet = (page: Page) => page.getByRole("dialog", { name: "3D model", exact: true });

async function tapAt(page: Page, at: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: at.x + 0.5, y: at.y + 0.5 });
  await page.mouse.click(p.x, p.y);
}

/** A token's panel from a tap on it and Details in its bar, its Image group open. */
async function imageGroup(page: Page, at: { x: number; y: number }, name: string): Promise<Locator> {
  await page.keyboard.press("Escape");
  await tapAt(page, at);
  const b = bar(page, name);
  await b.waitFor();
  await (await barControl(b, "Details")).click();
  const panel = tokenPanel(page);
  await panel.getByRole("heading", { name, exact: true }).first().waitFor();
  await openGroup(panel, "Image");
  return panel;
}

/** Reads a file into the open 3D model sheet and waits for its preview. */
async function readModel(page: Page, name: string, bytes: Buffer): Promise<Locator> {
  const sheet = modelSheet(page);
  await sheet.waitFor();
  await sheet.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
  await sheet.locator("[data-model-options]").waitFor({ timeout: 30_000 });
  return sheet;
}

const tokenOf = (socket: SocketWatch, id: string): Token | undefined => socket.state?.tokens[id];

/** The creatures standing as their models on the page's board: each one's token id, the frame its crop shows and its drawn box on the page. */
type Standing = { id: string; frame: number; box: { x: number; y: number; width: number; height: number } };
function standing(page: Page): Promise<Standing[]> {
  return page.evaluate(() => {
    type Node = { findAncestor(s: string): { id(): string } | undefined; crop(): { x: number; y: number }; image(): { width: number }; getClientRect(): { x: number; y: number; width: number; height: number }; getStage(): { container(): { getBoundingClientRect(): { x: number; y: number } } } };
    const konva = (globalThis as unknown as { Konva: { stages: { width(): number; find(s: string): Node[] }[] } }).Konva;
    const out: { id: string; frame: number; box: { x: number; y: number; width: number; height: number } }[] = [];
    for (const stage of konva.stages) {
      if (stage.width() === 0) continue;
      for (const n of stage.find(".standeeModel")) {
        const side = n.image().width / 4;
        const crop = n.crop();
        const at = n.getStage().container().getBoundingClientRect();
        const r = n.getClientRect();
        out.push({ id: n.findAncestor(".token")?.id() ?? "", frame: Math.floor(crop.x / side) + 4 * Math.floor(crop.y / side), box: { x: at.x + r.x, y: at.y + r.y, width: r.width, height: r.height } });
      }
    }
    return out;
  });
}

async function standingAs(page: Page, id: string): Promise<Standing> {
  return waitFor(`${id} standing as its model`, async () => (await standing(page)).find((s) => s.id === id) ?? null, 20_000);
}

async function pickView(page: Page, view: "isometric" | "topDown"): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
}

async function turnTo(page: Page, turn: Turn): Promise<void> {
  await page.evaluate((t) => (globalThis as unknown as { __rvttIsoHook: { turn(t: number): void } }).__rvttIsoHook.turn(t), turn);
}

/** How many of a box's pixels on the page are near `match`. */
async function pixelsLike(page: Page, clip: Standing["box"], match: (r: number, g: number, b: number) => boolean): Promise<number> {
  const png = await page.screenshot({ clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.max(1, clip.width), height: Math.max(1, clip.height) } });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) if (match(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!)) n++;
  return n;
}

/** The model a token's image carries in a socket's copy. */
const modelOf = (socket: SocketWatch, id: string): ModelRef | undefined => tokenOf(socket, id)?.image?.model;

/** A sheet's mean color over its opaque pixels, from its thumbnail. */
async function sheetColor(context: BrowserContext, assetId: string): Promise<[number, number, number]> {
  const res = await context.request.get(`${server.origin}/api/assets/${assetId}/thumb`);
  assert.ok(res.ok(), `the sheet ${assetId} answered ${res.status()}`);
  const { data, info } = await sharp(await res.body()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * 4 + 3]! < 250) continue;
    for (let k = 0; k < 3; k++) sum[k]! += data[i * 4 + k]!;
    n++;
  }
  assert.ok(n > 0, `the sheet ${assetId} has no opaque pixel`);
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** The Konva node of a token's standee, its box on the page. */
function tokenBox(page: Page, id: string): Promise<Standing["box"] | null> {
  return page.evaluate((tokenId) => {
    type Node = { getClientRect(o?: unknown): { x: number; y: number; width: number; height: number }; getStage(): { container(): { getBoundingClientRect(): { x: number; y: number } } } };
    const konva = (globalThis as unknown as { Konva: { stages: { width(): number; findOne(s: string): Node | undefined }[] } }).Konva;
    for (const stage of konva.stages) {
      if (stage.width() === 0) continue;
      const n = stage.findOne(`#${tokenId}`);
      if (!n) continue;
      const at = n.getStage().container().getBoundingClientRect();
      const r = n.getClientRect({ skipShadow: true, skipStroke: true });
      return { x: at.x + r.x, y: at.y + r.y, width: r.width, height: r.height };
    }
    return null;
  }, id);
}

/** A texture of flat colors side by side, left to right, as PNG or WebP. */
async function stripes(colors: [number, number, number][], format: "png" | "webp" = "png"): Promise<Uint8Array> {
  const w = 16 * colors.length;
  const raw = Buffer.alloc(w * 16 * 3);
  for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) raw.set(colors[Math.floor(x / 16)]!, (y * w + x) * 3);
  const img = sharp(raw, { raw: { width: w, height: 16, channels: 3 } });
  return new Uint8Array(await (format === "png" ? img.png() : img.webp({ lossless: true })).toBuffer());
}

/** A plane facing +Z, two triangles wound counterclockwise seen from the front, from x0 to x1 and 0 up to h. */
function plane(x0: number, x1: number, h: number): number[] {
  return [x0, 0, 0, x1, 0, 0, x1, h, 0, x0, 0, 0, x1, h, 0, x0, h, 0];
}

/** A box's triangles moved along X, Y up. */
const boxAt = (x: number, w = 0.24, h = 0.9) => box([x - w / 2, 0, -w / 2], [x + w / 2, h, w / 2]);

/** The same value for each of a triangle list's corners, `n` floats each. */
const each = (t: number[], value: number[]) => Array.from({ length: t.length / 3 }, () => value).flat();

/** Parts drawn by material: a part masked out, one masked in, a see-through one, vertex colors, and one without them beside it. */
function materialsGlb(): Buffer {
  const g = new Glb();
  const meshes = g.json.meshes as unknown[];
  const add = (t: number[], material: number, attributes: Record<string, number> = {}) => {
    const mesh = g.meshOf(t, { material, attributes });
    g.node({ mesh });
    return meshes.length;
  };
  g.json.materials = [
    { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.3], metallicFactor: 0 }, alphaMode: "MASK", alphaCutoff: 0.5 },
    { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 0.9], metallicFactor: 0 }, alphaMode: "MASK", alphaCutoff: 0.5 },
    { pbrMetallicRoughness: { baseColorFactor: [1, 1, 0, 0.5], metallicFactor: 0 }, alphaMode: "BLEND" },
    { pbrMetallicRoughness: { baseColorFactor: [0, 1, 1, 1], metallicFactor: 0 } },
  ];
  add(boxAt(-0.6), 0);
  add(boxAt(-0.3), 1);
  add(boxAt(0, 0.24, 1.2), 2);
  const painted = boxAt(0.3);
  add(painted, 3, { COLOR_0: g.floats(each(painted, [1, 0, 1, 1]), "VEC4") });
  add(boxAt(0.6), 3);
  return Buffer.from(g.build());
}

/** Textured parts: a second UV set, tiled coordinates, a texture transform, KTX2 with a PNG fallback, and a WebP source. */
async function texturesGlb(): Promise<Buffer> {
  const g = new Glb();
  const ORANGE: [number, number, number] = [240, 140, 20];
  const PURPLE: [number, number, number] = [120, 40, 220];
  const GREEN: [number, number, number] = [30, 200, 40];
  const MAGENTA: [number, number, number] = [220, 30, 200];
  const YELLOW: [number, number, number] = [230, 220, 30];
  const CYAN: [number, number, number] = [30, 210, 220];
  const ktx2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
  g.json.images = [
    { bufferView: g.view(await stripes([ORANGE, PURPLE])), mimeType: "image/png" },
    { bufferView: g.view(await stripes([GREEN, MAGENTA])), mimeType: "image/png" },
    { bufferView: g.view(await stripes([YELLOW, CYAN])), mimeType: "image/png" },
    { bufferView: g.view(ktx2), mimeType: "image/ktx2" },
    { bufferView: g.view(await stripes([[220, 30, 30]])), mimeType: "image/png" },
    { bufferView: g.view(await stripes([[30, 50, 230]], "webp")), mimeType: "image/webp" },
  ];
  g.json.textures = [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 4, extensions: { KHR_texture_basisu: { source: 3 } } }, { extensions: { EXT_texture_webp: { source: 5 } } }];
  g.json.extensionsUsed = ["KHR_texture_basisu", "EXT_texture_webp", "KHR_texture_transform"];
  g.json.samplers = [{}];
  const textured = (index: number, extra: Record<string, unknown> = {}) => ({ pbrMetallicRoughness: { baseColorTexture: { index, ...extra }, metallicFactor: 0 } });
  g.json.materials = [
    textured(0, { texCoord: 1 }),
    textured(1),
    textured(2, { extensions: { KHR_texture_transform: { offset: [0.5, 0] } } }),
    textured(3),
    textured(4),
  ];
  const part = (t: number[], material: number, attributes: Record<string, number>) => g.node({ mesh: g.meshOf(t, { material, attributes }) });
  // The second set lands on orange, the first on purple, so purple means the wrong set.
  const a = boxAt(-0.6);
  part(a, 0, { TEXCOORD_0: g.floats(each(a, [0.75, 0.5]), "VEC2"), TEXCOORD_1: g.floats(each(a, [0.25, 0.5]), "VEC2") });
  // Coordinates from 1.1 to 2.9 only: repeated they cross both colors, clamped they would all be magenta.
  const b = boxAt(-0.3);
  const bu: number[] = [];
  for (let i = 0; i < b.length; i += 3) bu.push(1.1 + ((b[i]! + 0.42) / 0.24) * 1.8, 0.5);
  part(b, 1, { TEXCOORD_0: g.floats(bu, "VEC2") });
  // Yellow under no transform, cyan once it is moved half the texture across.
  const c = boxAt(0);
  part(c, 2, { TEXCOORD_0: g.floats(each(c, [0.25, 0.5]), "VEC2") });
  const d = boxAt(0.3);
  part(d, 3, { TEXCOORD_0: g.floats(each(d, [0.5, 0.5]), "VEC2") });
  const e = boxAt(0.6);
  part(e, 4, { TEXCOORD_0: g.floats(each(e, [0.5, 0.5]), "VEC2") });
  return Buffer.from(g.build());
}

/** Planes facing the front, drawn one side only but one: double-sided red, a green one under a mirroring scale, and a blue strip. */
function sidesGlb(): Buffer {
  const g = new Glb();
  g.json.materials = [
    { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0 }, doubleSided: true },
    { pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1], metallicFactor: 0 } },
    { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1], metallicFactor: 0 } },
  ];
  g.node({ mesh: g.meshOf(plane(-0.75, -0.3, 1.2), { material: 0 }) });
  // Mirrored in X, it still faces the front, wound the other way: only a reader that reverses it draws it from the front.
  g.node({ mesh: g.meshOf(plane(-0.2, 0.2, 1.2), { material: 1 }), scale: [-1, 1, 1] });
  // A strip of four corners, bottom left, bottom right, top left, top right.
  const strip = [0.3, 0, 0, 0.75, 0, 0, 0.3, 1.2, 0, 0.75, 1.2, 0];
  const pos = g.floats(strip, "VEC3");
  (g.json.meshes as unknown[]).push({ primitives: [{ mode: 5, material: 2, attributes: { POSITION: pos } }] });
  g.node({ mesh: (g.json.meshes as unknown[]).length - 1 });
  return Buffer.from(g.build());
}

type Hue = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "magenta";

/** How many of a stored sheet's frame's pixels show each hue, opaque or see-through, from its full copy. */
async function frameHues(context: BrowserContext, assetId: string, frame: number): Promise<{ opaque: Record<Hue, number>; clear: Record<Hue, number> }> {
  const res = await context.request.get(`${server.origin}/api/assets/${assetId}/full`);
  assert.ok(res.ok(), `the sheet ${assetId} answered ${res.status()}`);
  const side = 512;
  const { data } = await sharp(await res.body())
    .extract({ left: (frame % 4) * side, top: Math.floor(frame / 4) * side, width: side, height: side })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const zero = (): Record<Hue, number> => ({ red: 0, orange: 0, yellow: 0, green: 0, cyan: 0, blue: 0, purple: 0, magenta: 0 });
  const out = { opaque: zero(), clear: zero() };
  const bands: [Hue, number, number][] = [["red", 345, 375], ["orange", 18, 42], ["yellow", 48, 70], ["green", 95, 150], ["cyan", 170, 200], ["blue", 215, 250], ["purple", 258, 282], ["magenta", 292, 330]];
  for (let i = 0; i < side * side; i++) {
    const a = data[i * 4 + 3]!;
    if (a < 40) continue;
    const [r, g, b] = [data[i * 4]! / 255, data[i * 4 + 1]! / 255, data[i * 4 + 2]! / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 0.25 || max - min < 0.45 * max) continue;
    const d = max - min;
    let h = max === r ? ((g - b) / d) * 60 : max === g ? ((b - r) / d) * 60 + 120 : ((r - g) / d) * 60 + 240;
    if (h < 0) h += 360;
    const band = bands.find(([, lo, hi]) => (h >= lo && h < hi) || (h + 360 >= lo && h + 360 < hi));
    if (band) (a > 230 ? out.opaque : out.clear)[band[0]]++;
  }
  return out;
}

/** Reads `bytes` into a token's 3D model sheet and saves it, answering the token's new model. */
async function saveModel(page: Page, at: { x: number; y: number }, name: string, id: string, file: string, bytes: Buffer): Promise<ModelRef> {
  const before = modelOf(dmSocket, id)?.assetId;
  const panel = await imageGroup(page, at, name);
  await panel.getByRole("button", { name: "3D model", exact: true }).click();
  const sheet = await readModel(page, file, bytes);
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  const model = await waitFor(`${name}'s new model`, () => {
    const m = modelOf(dmSocket, id);
    return m && m.assetId !== before ? m : null;
  });
  await sheet.waitFor({ state: "detached" });
  return model;
}

describe("3D models on token pictures", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESKTOP });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) await c.addInitScript(HOOK_FLAG);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    patContext.on("request", (req) => patRequests.push(req.url()));
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("md-0. the DM's room on a computer and Pat's on a phone: a knight with a picture, a creature behind it, a wolf with none, Pat's Thorn, and a hidden lurker wearing a model", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.patId = await join(patContext, "Pat", "#30a46c");
    run.face = await upload("token", await flat(200, 160, 40));
    run.lurkerFace = await upload("token", await flat(90, 20, 120));
    run.lurkerSheet = await upload("model", await flatSheet(280));
    const lurkerImage: ImageRef = { assetId: run.lurkerFace, crop: { cx: 0.5, cy: 0.5, zoom: 1 }, model: { assetId: run.lurkerSheet, side: 1.4, anchorY: 0.85, boxes: FLAT_BOXES } };
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send(tokenOp(run.knight, { name: "Knight", x: 5, y: 5, image: { assetId: run.face, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } }));
    await ops.send(tokenOp(run.behind, { name: "Sentry", x: 5, y: 4, image: { assetId: run.face, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } }));
    await ops.send(tokenOp(run.wolf, { name: "Wolf", x: 9, y: 5 }));
    await ops.send(tokenOp(run.thorn, { kind: "pc", name: "Thorn", x: 2, y: 7, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tokenOp(run.lurker, { name: "Lurker", x: 11, y: 2, visibility: "dm", image: lurkerImage, altImages: [lurkerImage] }));
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => tokenOf(patSocket, run.thorn));
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    assert.equal(tokenOf(patSocket, run.lurker), undefined, "the hidden lurker reached Pat");
  });

  test("md-1. the DM reads a generated STL into the knight's 3D model sheet: it reads, draws its 8 views, turns with Turn right and the arrow keys, and Save puts it on the picture", async () => {
    const panel = await imageGroup(dm, { x: 5, y: 5 }, "Knight");
    await panel.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = modelSheet(dm);
    await sheet.getByText("Stands in Isometric in place of the picture. STL, OBJ or GLB.").waitFor();
    assert.equal(await sheet.getByRole("button", { name: "Choose a file", exact: true }).evaluate((el) => el === (el.ownerDocument as unknown as { activeElement: unknown }).activeElement), true, "Choose a file takes the first focus");
    await shots.take(dm, "md-1-sheet-empty");
    await readModel(dm, "knight.stl", knightStl());
    const preview = sheet.getByRole("img", { name: /^The model, seen from / });
    assert.equal(await preview.getAttribute("aria-label"), "The model, seen from the front");
    await sheet.getByRole("button", { name: "Turn right", exact: true }).click();
    assert.equal(await preview.getAttribute("aria-label"), "The model, seen from the front left");
    await preview.focus();
    await dm.keyboard.press("ArrowRight");
    assert.equal(await preview.getAttribute("data-frame"), "2");
    await dm.keyboard.press("ArrowLeft");
    await dm.keyboard.press("ArrowLeft");
    assert.equal(await preview.getAttribute("data-frame"), "0");
    for (const words of ["Color", "Stand it up", "Turn its front", "Size"]) assert.ok((await sheet.getByText(words, { exact: true }).count()) > 0, words);
    await shots.take(dm, "md-1-sheet-preview");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    const image = await waitFor("the knight's model", () => tokenOf(dmSocket, run.knight)?.image?.model);
    assert.equal(image.boxes.length, 8);
    assert.ok(image.side >= 0.25 && image.side <= 4);
    const knight = tokenOf(dmSocket, run.knight)!.image!;
    assert.ok("assetId" in knight && knight.assetId === run.face, "the knight keeps its own picture");
    await modelSheet(dm).waitFor({ state: "detached" });
  });

  test("md-2. in Isometric the knight stands as its model, by its pixels, and its frame follows each view turn and each press of Facing", async () => {
    await dm.keyboard.press("Escape");
    await pickView(dm, "isometric");
    const knight = await standingAs(dm, run.knight);
    // Stone: an unpainted grey, lit from the upper left.
    const grey = await pixelsLike(dm, knight.box, (r, g, b) => Math.abs(r - g) < 18 && Math.abs(g - b) < 22 && r > 60 && r < 230);
    assert.ok(grey > (knight.box.width * knight.box.height) / 10, `the knight's drawn box shows ${grey} grey pixels`);
    await shots.take(dm, "md-2-knight-in-isometric");
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      await turnTo(dm, turn);
      const facing = tokenOf(dmSocket, run.knight)!.rotation ?? 0;
      await waitFor(`frame at turn ${turn}`, async () => ((await standingAs(dm, run.knight)).frame === frameFor(turn, facing) ? true : null), 5000);
    }
    await turnTo(dm, 0);
    for (const rotation of [45, 90, 135]) {
      await ops.send({ t: "token.update", tokenId: run.knight, patch: { rotation } });
      await waitFor(`frame at facing ${rotation}`, async () => ((await standingAs(dm, run.knight)).frame === frameFor(0, rotation) ? true : null), 5000);
    }
    await ops.send({ t: "token.update", tokenId: run.knight, patch: { rotation: 0 } });
  });
  test("md-3. a tap on a clear corner of the knight's frame, over the sentry standing behind it, picks the sentry", async () => {
    const knight = await standingAs(dm, run.knight);
    const model = modelOf(dmSocket, run.knight)!;
    const box = model.boxes[knight.frame]!;
    // The frame's square from its drawn box: the box is its [x0, y0, x1, y1] in hundredths of the square.
    const k = knight.box.width / (box[2] - box[0]);
    const art = { x0: knight.box.x - box[0] * k, y0: knight.box.y - box[1] * k, side: 100 * k };
    const sentry = await waitFor("the sentry's standee", () => tokenBox(dm, run.behind));
    const x0 = Math.max(knight.box.x + knight.box.width + 2, sentry.x);
    const x1 = Math.min(art.x0 + art.side, sentry.x + sentry.width);
    const y0 = Math.max(art.y0, sentry.y) + 4;
    const y1 = Math.min(knight.box.y + knight.box.height, sentry.y + sentry.height * 0.6);
    assert.ok(x1 - x0 > 4 && y1 - y0 > 4, `the knight's clear corner meets the sentry: x ${x0} to ${x1}, y ${y0} to ${y1}`);
    await dm.keyboard.press("Escape");
    await dm.mouse.click((x0 + x1) / 2, (y0 + y1) / 2);
    await bar(dm, "Sentry").waitFor();
    assert.equal(await bar(dm, "Knight").count(), 0, "the knight took the tap on its clear corner");
    await dm.keyboard.press("Escape");
  });

  test("md-4. Remove model takes two taps, armed as Tap again to remove, and moves focus to Choose a file, and the DM's Undo setup brings the model back", async () => {
    await pickView(dm, "topDown");
    const before = modelOf(dmSocket, run.knight)!;
    const panel = await imageGroup(dm, { x: 5, y: 5 }, "Knight");
    // The picture's own Remove asks twice once it carries a model, its line saying what goes.
    const removeBoth = panel.getByRole("button", { name: "Remove", exact: true });
    await panel.getByText("Removes the picture and its 3D model.").waitFor();
    assert.equal(await removeBoth.getAttribute("aria-describedby") !== null, true, "Remove names what it takes");
    await removeBoth.click();
    await panel.getByRole("button", { name: "Remove both?", exact: true }).waitFor();
    assert.ok(tokenOf(dmSocket, run.knight)!.image, "one tap took the picture");
    await panel.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = modelSheet(dm);
    const preview = sheet.getByRole("img", { name: /^The model, seen from / });
    await preview.waitFor();
    assert.equal(await preview.evaluate((el) => el === (el.ownerDocument as unknown as { activeElement: unknown }).activeElement), true, "the stored views take the first focus");
    await sheet.getByText("To change its color, size or which way is up, choose the file again.").waitFor();
    await sheet.getByRole("button", { name: "Remove model", exact: true }).click();
    const armed = sheet.getByRole("button", { name: "Tap again to remove", exact: true }).or(sheet.getByRole("button", { name: "Click again to remove", exact: true }));
    await armed.waitFor();
    assert.deepEqual(modelOf(dmSocket, run.knight), before, "one tap took the model");
    await shots.take(dm, "md-4-remove-armed");
    await armed.click();
    await waitFor("the knight without its model", () => (tokenOf(dmSocket, run.knight)?.image && !modelOf(dmSocket, run.knight) ? true : null));
    const knight = tokenOf(dmSocket, run.knight)!.image!;
    assert.ok("assetId" in knight && knight.assetId === run.face, "the picture stays");
    const choose = sheet.getByRole("button", { name: "Choose a file", exact: true });
    await waitFor("focus on Choose a file", () => choose.evaluate((el) => (el === (el.ownerDocument as unknown as { activeElement: unknown }).activeElement ? true : null)));
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    const { sheet: history } = await setupHistory(dm);
    await history.getByRole("button", { name: "Undo setup", exact: true }).click();
    await waitFor("the knight's model back", () => (modelOf(dmSocket, run.knight)?.assetId === before.assetId ? true : null));
    await dm.keyboard.press("Escape");
  });

  test("md-5. Crop, an icon and a new picture from the library each keep the knight's model", async () => {
    const model = modelOf(dmSocket, run.knight)!;
    const rev = tokenOf(dmSocket, run.knight)!.rev;
    const panel = await imageGroup(dm, { x: 5, y: 5 }, "Knight");
    await panel.getByRole("button", { name: "Crop", exact: true }).click();
    const crop = dm.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor();
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    await crop.waitFor({ state: "detached" });
    await waitFor("the crop saved", () => ((tokenOf(dmSocket, run.knight)?.rev ?? 0) > rev ? true : null));
    assert.deepEqual(modelOf(dmSocket, run.knight), model, "Crop kept the model");
    await panel.getByRole("button", { name: "Change image", exact: true }).click();
    const picker = dm.getByRole("dialog").filter({ has: dm.getByRole("tab", { name: "Icons" }) });
    await picker.getByRole("tab", { name: "Icons", exact: true }).click();
    await picker.getByLabel("Search icons").fill("knight");
    await picker.getByRole("list", { name: "Icons" }).getByRole("button").first().click();
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    await waitFor("the icon on the knight", () => (tokenOf(dmSocket, run.knight)?.image && "icon" in tokenOf(dmSocket, run.knight)!.image! ? true : null));
    assert.deepEqual(modelOf(dmSocket, run.knight), model, "an icon kept the model");
    await panel.getByRole("button", { name: "Change image", exact: true }).click();
    await picker.getByRole("tab", { name: "Library", exact: true }).click();
    await picker.locator(`img[src*="${run.face}"]`).first().click();
    const crop2 = dm.getByRole("dialog", { name: "Crop the image" });
    await crop2.waitFor();
    await crop2.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("the face back on the knight", () => {
      const image = tokenOf(dmSocket, run.knight)?.image;
      return image && "assetId" in image && image.assetId === run.face ? true : null;
    });
    assert.deepEqual(modelOf(dmSocket, run.knight), model, "a new picture kept the model");
  });

  test("md-6. a pasted picture for the selected knight keeps its model", async () => {
    const model = modelOf(dmSocket, run.knight)!;
    await dm.keyboard.press("Escape");
    await tapAt(dm, { x: 5, y: 5 });
    await bar(dm, "Knight").waitFor();
    await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
    const swatch = (await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 160, b: 90 } } }).png().toBuffer()).toString("base64");
    const taken = await dm.evaluate((base64) => {
      type G = {
        document: { activeElement: { dispatchEvent(e: unknown): boolean } | null; body: { dispatchEvent(e: unknown): boolean } };
        DataTransfer: new () => { items: { add(file: File): void } };
        ClipboardEvent: new (type: string, init: { clipboardData: unknown; bubbles: boolean; cancelable: boolean }) => { defaultPrevented: boolean };
      };
      const g = globalThis as unknown as G;
      const dt = new g.DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "green.png", { type: "image/png" }));
      const ev = new g.ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      (g.document.activeElement ?? g.document.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    }, swatch);
    assert.equal(taken, true, "the room's offer took the paste");
    const offer = dm.getByRole("dialog", { name: "Use the pasted image" });
    await offer.getByRole("button", { name: "Picture for Knight", exact: true }).click();
    const crop = dm.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor({ timeout: 30_000 });
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("the pasted picture on the knight", () => {
      const image = tokenOf(dmSocket, run.knight)?.image;
      return image && "assetId" in image && image.assetId !== run.face ? true : null;
    });
    assert.deepEqual(modelOf(dmSocket, run.knight), model, "the paste kept the model");
    await dm.keyboard.press("Escape");
  });

  test("md-7. a monster's page: its 3D model goes on the Goblin's shipped icon, an icon picked there keeps it, and Apply carries it to the Goblin's tokens", async () => {
    const goblin = uuidv7();
    await ops.send(tokenOp(goblin, { name: "Goblin Warrior", x: 8, y: 8, actor: { inline: actor({ srdId: "goblin-warrior" }) } }));
    await waitFor("the goblin in the DM's view", () => tokenOf(dmSocket, goblin));
    const { openSideTab, sideTabName } = await import("./harness.ts");
    await openSideTab(dm, "Monsters");
    const monsters = dm.getByRole("tabpanel", { name: sideTabName("Monsters") });
    await monsters.getByRole("searchbox", { name: "Search monsters" }).fill("goblin warrior");
    await monsters.getByRole("button", { name: /^Goblin Warrior/ }).first().click();
    await monsters.getByRole("button", { name: "3D model", exact: true }).click();
    await readModel(dm, "knight.stl", knightStl());
    await modelSheet(dm).getByRole("button", { name: "Save", exact: true }).click();
    const set = await waitFor("the Goblin's default with a model", () => dmSocket.state?.srdImages["goblin-warrior"]?.image);
    assert.ok("icon" in set && set.model, "the model rides on the shipped icon");
    await monsters.getByRole("button", { name: "Change image", exact: true }).click();
    const picker = dm.getByRole("dialog").filter({ has: dm.getByRole("tab", { name: "Icons" }) });
    await picker.getByRole("tab", { name: "Icons", exact: true }).click();
    await picker.getByLabel("Search icons").fill("orc");
    await picker.getByRole("list", { name: "Icons" }).getByRole("button").first().click();
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    const changed = await waitFor("the Goblin's new icon", () => {
      const image = dmSocket.state?.srdImages["goblin-warrior"]?.image;
      return image && "icon" in image && image.icon !== ("icon" in set ? set.icon : "") ? image : null;
    });
    assert.deepEqual(changed.model, set.model, "the icon picked on the page kept the model");
    await monsters.getByRole("button", { name: /^Apply to 1 token on this scene$/ }).click();
    await waitFor("the goblin wearing the default", () => (modelOf(dmSocket, goblin)?.assetId === set.model!.assetId ? true : null));
    assert.deepEqual(tokenOf(dmSocket, goblin)!.image, changed, "Apply carried the picture with its model");
    // A picture from the library, through the crop editor, keeps it too.
    await monsters.getByRole("button", { name: "Change image", exact: true }).click();
    await picker.getByRole("tab", { name: "Library", exact: true }).click();
    await picker.locator(`img[src*="${run.face}"]`).first().click();
    const crop = dm.getByRole("dialog", { name: "Crop the image" });
    await crop.waitFor();
    await crop.getByRole("button", { name: "Save", exact: true }).click();
    const cropped = await waitFor("the Goblin's new picture", () => {
      const image = dmSocket.state?.srdImages["goblin-warrior"]?.image;
      return image && "assetId" in image ? image : null;
    });
    assert.deepEqual(cropped.model, set.model, "a picture cropped on the page kept the model");
    await ops.send({ t: "token.delete", tokenId: goblin });
  });

  test("md-8. a textured GLB on the wolf, which has no picture: it takes the front view as its picture, and its texture shows in Isometric", async () => {
    const panel = await imageGroup(dm, { x: 9, y: 5 }, "Wolf");
    await panel.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = await readModel(dm, "wolf.glb", await texturedGlb());
    // Its parts carry a texture, so it offers no Color.
    assert.equal(await sheet.getByRole("combobox", { name: "Color" }).count(), 0, "a textured file offers Color");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    const image = await waitFor("the wolf's picture and model", () => tokenOf(dmSocket, run.wolf)?.image);
    assert.ok("assetId" in image && image.model && image.assetId !== image.model.assetId, "a front view picture and a sheet");
    await dm.keyboard.press("Escape");
    await pickView(dm, "isometric");
    const wolf = await standingAs(dm, run.wolf);
    const red = await pixelsLike(dm, wolf.box, (r, g, b) => r > 120 && g < 90 && b < 90);
    const blue = await pixelsLike(dm, wolf.box, (r, g, b) => b > 120 && r < 90 && g < 110);
    assert.ok(red > 20 && blue > 20, `the wolf's texture shows: ${red} red and ${blue} blue pixels`);
    await shots.take(dm, "md-8-wolf-textured-in-isometric");
    await pickView(dm, "topDown");
  });

  test("md-9. a group of three different pictures under Picture's color draws one sheet each, each token wearing its own picture's", async () => {
    run.red = await upload("token", await flat(210, 40, 40));
    run.blue = await upload("token", await flat(40, 60, 210));
    const crop = { cx: 0.5, cy: 0.5, zoom: 1 };
    await ops.send(tokenOp(run.g1, { name: "Red", x: 1, y: 1, image: { assetId: run.red, crop } }));
    await ops.send(tokenOp(run.g2, { name: "Blue", x: 3, y: 1, image: { assetId: run.blue, crop } }));
    await ops.send(tokenOp(run.g3, { name: "Green", x: 5, y: 1, image: { icon: "lorc/wolf-head", color: "#30a46c" } }));
    await waitFor("the group in the DM's view", () => tokenOf(dmSocket, run.g3));
    await dm.keyboard.press("Escape");
    await tapAt(dm, { x: 1, y: 1 });
    await bar(dm, "Red").waitFor();
    await dm.keyboard.down("Shift");
    await tapAt(dm, { x: 3, y: 1 });
    await tapAt(dm, { x: 5, y: 1 });
    await dm.keyboard.up("Shift");
    const group = dm.getByRole("dialog", { name: "3 selected tokens", exact: true });
    await group.waitFor();
    await (await barControl(group, "More")).click();
    const more = dm.getByRole("dialog", { name: "3 tokens", exact: true });
    await more.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = await readModel(dm, "knight.stl", knightStl());
    await sheet.getByRole("combobox", { name: "Color" }).selectOption("picture");
    // Save waits for the drawing in the red picture's color.
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    const models = await waitFor("each token's own model", () => {
      const m = [run.g1, run.g2, run.g3].map((id) => modelOf(dmSocket, id));
      return m.every(Boolean) ? (m as ModelRef[]) : null;
    });
    assert.equal(new Set(models.map((m) => m.assetId)).size, 3, "three sheets");
    const pictures = [run.g1, run.g2, run.g3].map((id) => tokenOf(dmSocket, id)!.image!);
    assert.ok("assetId" in pictures[0]! && pictures[0].assetId === run.red && "assetId" in pictures[1]! && pictures[1].assetId === run.blue && "icon" in pictures[2]!, "each keeps its own picture");
    const [red, blue, green] = await Promise.all(models.map((m) => sheetColor(dmContext, m.assetId)));
    assert.ok(red![0] > red![2] + 30, `the red token's sheet is red: ${red}`);
    assert.ok(blue![2] > blue![0] + 30, `the blue token's sheet is blue: ${blue}`);
    assert.ok(green![1] > green![0] + 15, `the green token's sheet is green: ${green}`);
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("Escape");
  });

  test("md-10. Pat, on a phone, adds a model to his own Thorn in a bottom sheet, and Thorn, who had no picture, wears its front view", async () => {
    await tapAt(pat, { x: 2, y: 7 });
    const b = bar(pat, "Thorn");
    await b.waitFor();
    await (await barControl(b, "Details")).click();
    const panel = tokenPanel(pat);
    await panel.getByRole("heading", { name: "Thorn", exact: true }).first().waitFor();
    await openGroup(panel, "Image");
    await panel.getByRole("button", { name: "3D model", exact: true }).click();
    const sheet = await readModel(pat, "knight.stl", knightStl());
    const card = await sheet.boundingBox();
    assert.ok(card && Math.abs(card.y + card.height - PHONE.height) <= 1, "a bottom sheet on an upright phone");
    await shots.take(pat, "md-10-pat-sheet-preview");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("Thorn's model", () => modelOf(patSocket, run.thorn));
    const image = tokenOf(patSocket, run.thorn)!.image!;
    assert.ok("assetId" in image && image.model && image.assetId !== image.model.assetId, "Thorn had no picture, so he wears the front view");
    await modelSheet(pat).waitFor({ state: "detached" });
    await pat.keyboard.press("Escape");
  });

  test("md-11. Wild Shape: wearing Thorn's other image swaps in its model, and wearing his own again swaps it back", async () => {
    const own = tokenOf(patSocket, run.thorn)!.image!;
    const wolfSheet = await upload("model", await flatSheet(30));
    const wolfImage: ImageRef = { assetId: run.red, crop: { cx: 0.5, cy: 0.5, zoom: 1 }, model: { assetId: wolfSheet, side: 1.2, anchorY: 0.85, boxes: FLAT_BOXES } };
    await ops.send({ t: "token.update", tokenId: run.thorn, patch: { altImages: [wolfImage] } });
    await waitFor("Thorn's other image on Pat's copy", () => tokenOf(patSocket, run.thorn)?.altImages?.length || null);
    const panel = tokenPanel(pat);
    if (!(await panel.isVisible())) {
      await tapAt(pat, { x: 2, y: 7 });
      await (await barControl(bar(pat, "Thorn"), "Details")).click();
    }
    await openGroup(panel, "Image");
    await panel.getByRole("button", { name: "Wear image 1", exact: true }).click();
    await waitFor("Thorn wearing the wolf", () => (modelOf(patSocket, run.thorn)?.assetId === wolfSheet ? true : null));
    assert.deepEqual(tokenOf(patSocket, run.thorn)!.altImages, [own], "his own image and model wait as the other image");
    await panel.getByRole("button", { name: "Wear image 1", exact: true }).click();
    await waitFor("Thorn himself again", () => (modelOf(patSocket, run.thorn)?.assetId === own.model?.assetId ? true : null));
    await pat.keyboard.press("Escape");
  });

  test("md-12. Pat's page never asked for the hidden lurker's sheet nor heard its id, while it did fetch the sheets it may see", async () => {
    await pickView(pat, "isometric");
    await standingAs(pat, run.thorn);
    await standingAs(pat, run.knight);
    const fetched = (id: string) => patRequests.some((url) => url.includes(`/assets/${id}/`));
    assert.ok(fetched(modelOf(patSocket, run.knight)!.assetId), "Pat's page fetched the knight's sheet, so the recording sees sheets");
    assert.equal(fetched(run.lurkerSheet), false, "Pat's page asked for the hidden lurker's sheet");
    assert.equal(patSocket.everSaw(run.lurkerSheet), false, "a frame to Pat named the hidden lurker's sheet");
    assert.equal(patSocket.everSaw(run.lurker), false, "a frame to Pat named the hidden lurker");
    // The DM's own board draws it: the sheet is there to be asked for.
    await pickView(dm, "isometric");
    await standingAs(dm, run.lurker);
    await pickView(dm, "topDown");
    await pickView(pat, "topDown");
  });

  test("md-14. GLB materials drawn as glTF says, by the stored sheet's pixels: a part masked out, one masked in, a see-through one, vertex colors on the material's, and a part without them beside it", async () => {
    const model = await saveModel(dm, { x: 5, y: 4 }, "Sentry", run.behind, "materials.glb", materialsGlb());
    const { opaque, clear } = await frameHues(dmContext, model.assetId, 0);
    assert.ok(opaque.red < 20, `the part masked out shows: ${opaque.red} red pixels`);
    assert.ok(opaque.green > 300, `the part masked in is missing: ${opaque.green} green pixels`);
    assert.ok(clear.yellow > 300 && opaque.yellow < clear.yellow / 4, `the see-through part: ${clear.yellow} see-through and ${opaque.yellow} opaque yellow pixels`);
    assert.ok(opaque.blue > 300, `cyan times its magenta vertex colors is blue: ${opaque.blue} blue pixels`);
    assert.ok(opaque.cyan > 300, `the part without vertex colors keeps its cyan: ${opaque.cyan} cyan pixels`);
  });

  test("md-15. GLB textures drawn as glTF says, under the CSP: a second UV set, tiled coordinates, a texture transform, KTX2's PNG fallback and a WebP source", async () => {
    const model = await saveModel(dm, { x: 5, y: 4 }, "Sentry", run.behind, "textures.glb", await texturesGlb());
    const { opaque } = await frameHues(dmContext, model.assetId, 0);
    assert.ok(opaque.orange > 300 && opaque.purple < 20, `the second UV set: ${opaque.orange} orange, ${opaque.purple} purple`);
    assert.ok(opaque.green > 100 && opaque.magenta > 100, `tiled coordinates repeat: ${opaque.green} green, ${opaque.magenta} magenta`);
    assert.ok(opaque.cyan > 300 && opaque.yellow < 20, `the texture transform: ${opaque.cyan} cyan, ${opaque.yellow} yellow`);
    assert.ok(opaque.red > 300, `KTX2's PNG fallback: ${opaque.red} red`);
    assert.ok(opaque.blue > 300, `the WebP texture: ${opaque.blue} blue`);
  });

  test("md-16. GLB sides and winding in the 8 frames: a double-sided plane shows from behind, and a mirrored plane and a strip face out the front only", async () => {
    const model = await saveModel(dm, { x: 5, y: 4 }, "Sentry", run.behind, "sides.glb", sidesGlb());
    const front = (await frameHues(dmContext, model.assetId, 0)).opaque;
    const back = (await frameHues(dmContext, model.assetId, 4)).opaque;
    assert.ok(front.red > 300 && front.green > 300 && front.blue > 300, `all three from the front: ${JSON.stringify(front)}`);
    assert.ok(back.red > 300, `the double-sided plane from behind: ${back.red} red`);
    assert.ok(back.green < 20 && back.blue < 20, `the one-sided planes from behind: ${back.green} green, ${back.blue} blue`);
    for (const frame of [1, 7]) {
      const seen = (await frameHues(dmContext, model.assetId, frame)).opaque;
      assert.ok(seen.green > 100 && seen.blue > 100, `frame ${frame} sees the mirrored plane and the strip from the front: ${JSON.stringify(seen)}`);
    }
    for (const frame of [3, 5]) {
      const seen = (await frameHues(dmContext, model.assetId, frame)).opaque;
      assert.ok(seen.green < 20 && seen.blue < 20 && seen.red > 100, `frame ${frame} sees only the double-sided plane: ${JSON.stringify(seen)}`);
    }
  });

  test("md-17. no page logged an error", () => {
    assert.deepEqual(consoles.dm.errors, []);
    assert.deepEqual(consoles.pat.errors, []);
  });
});
