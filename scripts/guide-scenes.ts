/**
 * Replays the DM guide's scenes and takes most of its pictures
 * (docs/dm-guide.md), from the real server on the production build, so
 * they show the app as it is. It makes a room called Guide examples, then runs
 * every step in scripts/guide-scenes/ in order, in one browser, each step
 * building on what the steps before it left in the room (c.state). A step
 * saves its raw shots to GUIDE_WORK/raw with c.shot, and the pictures at the
 * end are those raw shots written as webp, named by scripts/guide-scenes/pictures.ts.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3198 node scripts/guide-scenes.ts
 *
 * GUIDE_WORK    folder for the raw shots and the files the steps make
 *               (default: a new folder in the temp directory, kept).
 * GUIDE_OUT     where the webp pictures go (default: GUIDE_WORK/out). Point it at
 *               docs/dm-guide to replace the guide's pictures in place.
 * GUIDE_ONLY    comma list of picture names to write (default: all).
 * GUIDE_FROM    first step number to run and GUIDE_TO the last (default: all).
 *               Steps build on each other, so a later start needs the room
 *               an earlier run kept: use GUIDE_ONLY on the whole run instead.
 *
 * GUIDE_WAIT   when set, a failing step does not end the run. The run waits
 *               for a file named `go` in GUIDE_WORK (touch it), then runs
 *               the step again from its file as it is on disk, so a step
 *               can be fixed with the room and the browser as they are. A file
 *               named probe.ts there is run once with the same context, and its
 *               result goes to probe.out.
 * GUIDE_VERBOSE when set, prints what each step returns (the start of it).
 * GUIDE_SKIP    comma list of step names (such as s22) to leave out.
 *
 * s10 and s33 may fail, as they always have. Any other failing step stops the run.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";
import * as harness from "../e2e/harness.ts";
import { PICTURES, QUALITY, VARIES } from "./guide-scenes/pictures.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3198);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const WORK = process.env.GUIDE_WORK ?? mkdtempSync(path.join(tmpdir(), "raccoon-guide-scenes-"));
const RAW = path.join(WORK, "raw");
const OUT = process.env.GUIDE_OUT ?? path.join(WORK, "out");
const ONLY = process.env.GUIDE_ONLY === undefined ? null : new Set(process.env.GUIDE_ONLY.split(",").map((n) => n.trim()));
const FROM = Number(process.env.GUIDE_FROM ?? 0);
const TO = Number(process.env.GUIDE_TO ?? Infinity);
const VERBOSE = process.env.GUIDE_VERBOSE !== undefined;
const WAIT = process.env.GUIDE_WAIT !== undefined;
const SKIP = new Set((process.env.GUIDE_SKIP ?? "").split(",").filter((n) => n !== ""));
/** Raw shots that show the turn card on purpose. A step can also hold it open with c.state.keepTurnCard. */
const KEEP_TURN_CARD = new Set(["final-boss-recharge", "final-regeneration"]);
const MAY_FAIL = new Set(["s10", "s33"]);
const STEPS_DIR = path.join(harness.ROOT, "scripts", "guide-scenes");

mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

/** s2 before s10, s69 before s69b, s156 before s156b. */
function stepOrder(file: string): [number, string] {
  const m = /^s(\d+)([a-z]?)-/.exec(file);
  return [Number(m?.[1] ?? 0), file];
}

const steps = readdirSync(STEPS_DIR)
  .filter((f) => /^s\d+[a-z]?-.*\.ts$/.test(f))
  .sort((a, b) => stepOrder(a)[0] - stepOrder(b)[0] || a.localeCompare(b))
  .filter((f) => stepOrder(f)[0] >= FROM && stepOrder(f)[0] <= TO);

// The server rolls and mints ids from a fixed stream (guide-scenes/seed.ts), so a second run gives the same pictures.
const inheritedOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = `${inheritedOptions ?? ""} --import ${path.join(STEPS_DIR, "seed.ts")}`.trim();
const server = await harness.startServer({ port: PORT, assetDir: path.join(WORK, "assets"), databaseUrl: DATABASE_URL });
if (inheritedOptions === undefined) delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = inheritedOptions;
const launched = await chromium.launch({ channel: "chrome", headless: true });
// Every context starts with the roll animation off, so no picture catches dice mid-throw.
const browser = new Proxy(launched, {
  get(target, key) {
    if (key === "newContext") {
      return async (opts: Parameters<typeof target.newContext>[0]) => {
        const context = await target.newContext(opts);
        // Many steps press a button that may not be there (a Close, a Dismiss), and each would wait the usual 30 s.
        context.setDefaultTimeout(10_000);
        await context.addInitScript(() => {
          try {
            localStorage.setItem("rvtt.rollAnimation", "off");
          } catch {}
          // New ids (uuidv7: a time, then 74 random bits) take their random part from a counter, so creatures made in
          // the same millisecond keep the order they were made in, and the table numbers them the same way every run.
          // The dice a device rolls draw 32-bit numbers, which come from a fixed stream, as the server's do (seed.ts).
          let counter = 0;
          let state = 0x1badb002;
          const next = () => {
            state = (state + 0x6d2b79f5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return (t ^ (t >>> 14)) >>> 0;
          };
          const real = crypto.getRandomValues.bind(crypto);
          crypto.getRandomValues = ((array: ArrayBufferView) => {
            if (array instanceof Uint8Array && array.length === 16) {
              array.fill(0);
              for (let n = ++counter, i = 15; n > 0 && i >= 9; i--, n >>>= 8) array[i] = n & 255;
              return array;
            }
            if (array instanceof Uint32Array) {
              for (let i = 0; i < array.length; i++) array[i] = next();
              return array;
            }
            return real(array as Uint8Array);
          }) as typeof crypto.getRandomValues;
        });
        return context;
      };
    }
    const v = Reflect.get(target, key);
    return typeof v === "function" ? v.bind(target) : v;
  },
});
// The turn card opens over the map as a turn starts, where a step is about to tap a token, so a tap clears it first.
const stepHarness = {
  ...harness,
  async tapCell(page: Parameters<typeof harness.tapCell>[0], bounds: Parameters<typeof harness.tapCell>[1], cell: Parameters<typeof harness.tapCell>[2]) {
    const card = page.getByRole("button", { name: /^Dismiss .*'s turn$/ });
    if (ctx.state.keepTurnCard !== true && (await card.count()) > 0) {
      await card.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    return harness.tapCell(page, bounds, cell);
  },
};
const ctx = {
  origin: server.origin,
  browser,
  harness: stepHarness,
  RAW,
  WORK,
  state: {} as Record<string, unknown>,
  async shot(page: Page, name: string, opts: Record<string, unknown> = {}) {
    // The turn card hangs over the map for a while after a turn starts, so a picture clears it unless the card is the point.
    const card = page.getByRole("button", { name: /^Dismiss .*'s turn$/ });
    if (!KEEP_TURN_CARD.has(name) && ctx.state.keepTurnCard !== true && (await card.count()) > 0) {
      await card.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    // A notice such as "Saved. Undo in Setup history." goes after a few seconds, and a picture waits for it.
    await page.locator("[data-toast]").first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    const file = path.join(RAW, `${name}.png`);
    await page.screenshot({ path: file, ...opts });
    return file;
  },
};

// A step's stray promise that rejects later, such as a download it stopped waiting for, is logged
// and does not end the run and every page it holds.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection in a step:", err instanceof Error ? err.message : String(err));
});

let failed: string | null = null;
try {
  for (const file of steps) {
    const name = file.replace(/\.ts$/, "");
    if (SKIP.has(name.split("-")[0]!)) continue;
    for (;;) {
      const started = Date.now();
      try {
        const mod = (await import(`${path.join(STEPS_DIR, file)}?t=${Date.now()}`)) as { default: (c: typeof ctx) => Promise<unknown> };
        const result = await mod.default(ctx);
        console.log(`== ${name}: OK ${Math.round((Date.now() - started) / 1000)}s`);
        if (VERBOSE && result !== undefined) console.log(String(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 500));
        break;
      } catch (err) {
        console.log(`== ${name}: ERROR ${err instanceof Error ? (err.stack ?? err.message).slice(0, 1500) : String(err)}`);
        if (MAY_FAIL.has(name.split("-")[0]!)) break;
        if (!WAIT) {
          failed = name;
          break;
        }
        const go = path.join(WORK, "go");
        console.log(`waiting for ${go}`);
        // A file named probe.ts in GUIDE_WORK is run the same way, and its result or error goes to probe.out,
        // for looking at the page a step failed on before fixing the step.
        const probe = path.join(WORK, "probe.ts");
        while (!existsSync(go)) {
          if (existsSync(probe)) {
            let text: string;
            try {
              const mod = (await import(`${probe}?t=${Date.now()}`)) as { default: (c: typeof ctx) => Promise<unknown> };
              const result = await mod.default(ctx);
              text = `OK\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`;
            } catch (e) {
              text = `ERROR\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
            }
            rmSync(probe);
            writeFileSync(path.join(WORK, "probe.out"), text);
          }
          await harness.sleep(500);
        }
        rmSync(go);
      }
    }
    if (failed !== null) break;
  }
  if (failed === null) {
    let total = 0;
    for (const [name, raw] of Object.entries(PICTURES)) {
      if (ONLY !== null ? !ONLY.has(name) : VARIES.has(name)) continue;
      const from = path.join(RAW, `${raw}.png`);
      if (!existsSync(from)) {
        console.log(`${name}.webp: no ${raw}.png, skipped`);
        continue;
      }
      const to = path.join(OUT, `${name}.webp`);
      const info = await sharp(from).webp({ quality: QUALITY[name] ?? 78, effort: 6 }).toFile(to);
      total += statSync(to).size;
      console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(statSync(to).size / 1024)} KB`);
    }
    console.log(`total ${Math.round(total / 1024)} KB, in ${OUT}`);
  }
} finally {
  await browser.close();
  await server.stop();
  console.log(`work folder ${WORK}`);
}
if (failed !== null) {
  console.log(`stopped at ${failed}`);
  process.exitCode = 1;
}
