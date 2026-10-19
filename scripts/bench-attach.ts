/**
 * Attached tokens on a phone (docs/design-v1-attach.md section 11): the
 * group rules and the link pass at the room's cap of 500 tokens, with one
 * holder carrying a full group of 20 at the deepest chain the limits allow.
 * Each row runs on a fresh copy of the tokens, so the children index is
 * built again every time, as after any change to the tokens:
 *
 * - `carriedGroup`, `moveGroups` of a 20-token selection, `publicMembers`
 *   and `checkSet`, each one pass over the scene's tokens;
 * - `planMove` of the holder's move;
 * - the whole reducer op for the holder's move, link pass and turn
 *   settling included, beside the same move of a token that holds nothing,
 *   so the difference is what attached tokens add to an op;
 * - an attach and a Get off.
 *
 * Run it alone on the machine being measured, since parallel load skews it:
 *
 *   node scripts/bench-attach.ts
 *   node scripts/bench-attach.ts --chrome   (also in headless Chrome, its CPU 4 times slower)
 */
import type { RoomState } from "../shared/model.ts";
import type { Op } from "../shared/protocol.ts";
import { applyOp } from "../shared/reducer.ts";
import { carriedGroup, checkSet, moveGroups, publicMembers } from "../shared/rules/attach.ts";
import { planMove } from "../shared/rules/moveLeg.ts";

type Ms = { median: number; max: number };
export type AttachRow = { row: string; ms: Ms };

const DM = { memberId: "dm1", role: "dm" as const };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** The same room with a fresh tokens record, so nothing cached per record carries over. */
function fresh(state: RoomState): RoomState {
  return { ...state, tokens: { ...state.tokens } };
}

function time(runs: number, setup: () => RoomState, body: (state: RoomState) => unknown): Ms {
  const times: number[] = [];
  for (let r = 0; r < runs + 3; r++) {
    const state = setup();
    const t = performance.now();
    body(state);
    // The first runs warm the engine up.
    if (r >= 3) times.push(performance.now() - t);
  }
  return stats(times);
}

/**
 * The rows, on a room the caller built (benchRoom), so the browser run
 * takes the room as plain data and bundles only the rules and the reducer.
 */
export function runAttachRows(room: RoomState, runs = 25): AttachRow[] {
  const env = { seq: 1000, at: "2026-10-12T20:00:00.000Z" };
  const named = ["h", ...Array.from({ length: 19 }, (_, i) => `t${i * 20}`)];
  const seen = () => true;
  const holderMove: Op = { t: "token.move", tokenId: "h", x: 30, y: 30 };
  const loneMove: Op = { t: "token.move", tokenId: "t1", x: 30, y: 31 };
  const apply = (op: Op) => (state: RoomState) => {
    const r = applyOp(state, op, DM, env);
    if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
  };
  return [
    { row: "carriedGroup of the holder", ms: time(runs, () => fresh(room), (s) => carriedGroup(s.tokens, "h")) },
    { row: "moveGroups of 20 named tokens", ms: time(runs, () => fresh(room), (s) => moveGroups(s.tokens, named)) },
    { row: "publicMembers and checkSet", ms: time(runs, () => fresh(room), (s) => [publicMembers(s.tokens, "h", seen), checkSet(s.tokens, "h", new Set(["h"]), seen)]) },
    { row: "planMove of the holder's move", ms: time(runs, () => fresh(room), (s) => planMove(holderMove, s, DM, {})) },
    { row: "the holder's move, whole op", ms: time(runs, () => fresh(room), apply(holderMove)) },
    { row: "a lone token's move, whole op", ms: time(runs, () => fresh(room), apply(loneMove)) },
    { row: "an attach (a ride)", ms: time(runs, () => fresh(room), apply({ t: "token.attach", tokenId: "rider", to: "ogre", kind: "ride", steer: true, x: 25, y: 20, elevation: 0 })) },
    { row: "a Get off", ms: time(runs, () => fresh(room), apply({ t: "token.detach", tokenId: "imp", x: 24, y: 23 })) },
  ];
}

export function formatAttachRows(rows: readonly AttachRow[], where = "laptop"): string {
  const lines = [`500 tokens, a group of 20 (${where}) | ms (median / max)`, "--- | ---"];
  for (const r of rows) lines.push(`${r.row} | ${r.ms.median.toFixed(3)} / ${r.ms.max.toFixed(3)}`);
  return lines.join("\n");
}

/**
 * 500 tokens: a Gargantuan holder `h` at 20,20 carrying 20 in all, three
 * deep (7 crates and an imp under it, 8 under the first crate, 3 under the
 * first of those), a creature `rider` beside an ogre, and 478 others spread over the
 * scene, a few dragging each other. Built with the test helpers, so only
 * the Node run loads it.
 */
async function benchRoom(): Promise<RoomState> {
  // A specifier Vite leaves alone, so the browser bundle never takes in the Node-only test helpers.
  const helpers = "../shared/testutil.ts";
  const { room, token, actor } = (await import(/* @vite-ignore */ helpers)) as typeof import("../shared/testutil.ts");
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 120, h: 120 } };
  state.tokens.h = token("h", { name: "Roc", kind: "npc", size: "gargantuan", x: 20, y: 20, actor: { inline: actor({ speeds: { walk: 80 } }) } });
  state.tokens.rider = token("rider", { name: "Bree", kind: "pc", x: 24, y: 20 });
  state.tokens.ogre = token("ogre", { name: "Ogre", size: "large", x: 25, y: 20 });
  const seat = (i: number) => ({ x: 20 + (i % 4), y: 20 + Math.floor(i / 4) });
  for (let i = 0; i < 7; i++) state.tokens[`c${i}`] = token(`c${i}`, { name: `Crate ${i}`, kind: "object", size: "small", ...seat(i), attached: { to: "h", kind: "carry" } });
  state.tokens.imp = token("imp", { name: "Imp", size: "tiny", ...seat(7), attached: { to: "h", kind: "perch" } });
  for (let i = 0; i < 8; i++) state.tokens[`d${i}`] = token(`d${i}`, { name: `Sack ${i}`, kind: "object", size: "tiny", x: 20, y: 20, attached: { to: "c0", kind: "carry" } });
  for (let i = 0; i < 3; i++) state.tokens[`e${i}`] = token(`e${i}`, { name: `Coin ${i}`, kind: "object", size: "tiny", x: 20, y: 20, attached: { to: "d0", kind: "carry" } });
  for (let i = 0; Object.keys(state.tokens).length < 500; i++) {
    const x = 40 + (i % 60);
    const y = 2 + Math.floor(i / 60) * 2;
    // Every tenth token drags the one before it, so the link pass has links to judge.
    state.tokens[`t${i}`] = token(`t${i}`, { name: `Goblin ${i}`, x, y, ...(i % 10 === 9 ? { attached: { to: `t${i - 1}`, kind: "drag" as const } } : {}) });
  }
  return state;
}

const CPU_SLOWDOWN = 4;

/** The rows in headless Chrome with its CPU throttled 4 times, standing in for a phone, the room passed in as data. */
async function runChrome(state: RoomState): Promise<string> {
  const vite = await import("vite");
  const { chromium } = await import("playwright-core");
  const here = new URL(import.meta.url).pathname;
  const entry = "\0bench-attach-entry";
  const out = await vite.build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "bench-attach-entry",
        resolveId: (id: string) => (id === entry ? id : null),
        load: (id: string) => (id === entry ? `import { runAttachRows } from ${JSON.stringify(here)}; globalThis.__runAttachRows = runAttachRows;` : null),
      },
    ],
    build: { write: false, minify: false, rollupOptions: { input: entry, external: ["vite", "playwright-core"], output: { format: "es" } } },
  });
  const output = (Array.isArray(out) ? out[0] : out) as { output: { type: string; code?: string; isEntry?: boolean }[] };
  const code = output.output.find((o) => o.type === "chunk" && o.isEntry === true)?.code;
  if (!code) throw new Error("Vite gave no bundle");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => typeof (globalThis as { __runAttachRows?: unknown }).__runAttachRows === "function");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
    const rows = (await page.evaluate((room) => (globalThis as unknown as { __runAttachRows: (r: unknown, runs: number) => AttachRow[] }).__runAttachRows(room, 25), JSON.parse(JSON.stringify(state)))) as AttachRow[];
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    return formatAttachRows(rows, `headless Chrome, ${CPU_SLOWDOWN}x slower CPU`);
  } finally {
    await browser.close();
  }
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  const state = await benchRoom();
  console.log(formatAttachRows(runAttachRows(state)));
  if (argv.includes("--chrome")) {
    console.log("");
    console.log(await runChrome(state));
  }
}
