import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { markRan, ranIntervals, type BrowserRun, type V8Function } from "../scripts/coverage.ts";

/**
 * Chrome's JavaScript coverage of the client during a browser test run, for `pnpm coverage
 * --e2e` (scripts/coverage.ts, docs/development.md "Coverage"). harness.ts turns it on only
 * when E2E_COVERAGE_DIR names a folder, and each test process saves into it which
 * characters of each dist/ chunk ran.
 *
 * V8's coverage starts on each page before the test sends it anywhere. Chrome drops a
 * document's coverage once the page leaves it, and holds back DevTools commands while a
 * navigation is under way, so the coverage must be taken before the navigation starts:
 * before each goto, reload, goBack and goForward the test calls, and before a page, its
 * context or its browser closes. A navigation the page starts itself, such as a link or
 * location.reload(), loses what that document ran since the last take, so the figure can
 * come out low from it but never high. A popup is covered from when the test first sees it,
 * and a Web Worker not at all.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** A take that has not answered by then is given up, as on a page held by a dialog. */
const TAKE_TIMEOUT_MS = 10_000;

const chunks = new Map<string, Uint8Array>();
const sessions = new WeakMap<Page, Promise<CDPSession | null>>();
let outFile: string | null = null;

/** The chunk a script URL loads, as dist/ names it, or null for anything else such as an inline script. */
function chunkOf(url: string): string | null {
  try {
    const { protocol, pathname } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && /^\/assets\/[^/]+\.js$/.test(pathname) ? pathname.slice(1) : null;
  } catch {
    return null;
  }
}

function record(scripts: readonly { url: string; functions: V8Function[] }[]): void {
  for (const script of scripts) {
    const chunk = chunkOf(script.url);
    if (chunk === null) continue;
    // The script's own top-level range spans all of it.
    let length = 0;
    for (const f of script.functions) for (const r of f.ranges) length = Math.max(length, r.endOffset);
    let ran = chunks.get(chunk);
    if (ran === undefined || ran.length < length) {
      const grown = new Uint8Array(length);
      if (ran !== undefined) grown.set(ran);
      chunks.set(chunk, (ran = grown));
    }
    markRan(ran, script.functions);
  }
}

/** Writes everything this process has seen so far, over its own earlier save. */
function save(): void {
  if (outFile === null || chunks.size === 0) return;
  const run: BrowserRun = { scripts: {} };
  for (const [chunk, ran] of chunks) run.scripts[chunk] = { length: ran.length, ran: ranIntervals(ran) };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(run));
}

async function take(page: Page): Promise<void> {
  const cdp = await sessions.get(page);
  if (!cdp) return;
  // Cleared in finally: a rejected take would otherwise leave the timer holding the process open.
  let timer: NodeJS.Timeout | undefined;
  try {
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TAKE_TIMEOUT_MS)));
    const taken = await Promise.race([cdp.send("Profiler.takePreciseCoverage"), late]);
    if (taken) record(taken.result);
  } catch {
    // The page closed or crashed, and what it ran since the last take is lost.
  } finally {
    clearTimeout(timer);
  }
}

/** Starts a page's coverage once, and takes it before each navigation the test starts and before the page closes. */
function cover(page: Page): Promise<CDPSession | null> {
  const known = sessions.get(page);
  if (known) return known;
  const started = (async () => {
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.startPreciseCoverage", { callCount: false, detailed: true });
      return cdp;
    } catch {
      return null;
    }
  })();
  sessions.set(page, started);
  for (const name of ["goto", "reload", "goBack", "goForward", "close"] as const) {
    const original = page[name].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      await take(page);
      if (name === "close") save();
      return original(...args);
    };
  }
  return started;
}

async function takeAll(pages: readonly Page[]): Promise<void> {
  await Promise.all(pages.map(take));
  save();
}

export async function coverContext(context: BrowserContext, dir: string): Promise<void> {
  if (outFile === null) {
    outFile = path.join(path.resolve(ROOT, dir), `${process.pid}-${randomUUID().slice(0, 8)}.json`);
    // A run the test runner ends early still keeps what its last take saw.
    process.on("exit", save);
  }
  context.on("page", (page) => void cover(page));
  await Promise.all(context.pages().map(cover));
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    await cover(page);
    return page;
  };
  const close = context.close.bind(context);
  context.close = async (...args) => {
    await takeAll(context.pages());
    return close(...args);
  };
}

export function coverBrowser(browser: Browser, dir: string): void {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    await coverContext(context, dir);
    return context;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    await takeAll(browser.contexts().flatMap((c) => c.pages()));
    return close(...args);
  };
}
