import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

/**
 * The dice chunk's check, after `pnpm build` (docs/design-v1-roll-animation.md 6).
 * three.js hardly tree-shakes, so one stray import would put all of it in
 * a chunk every member loads. The source scan
 * (client/features/dice/throw/lazyThree.test.ts) holds the imports, and
 * this reads what the build made of them: exactly one chunk holds three's
 * renderer, and it is none of the entry, Room, room and Dice panel chunks,
 * nor any chunk they import. It prints that chunk's size and the room's
 * first load, so a change to either shows in CI's log.
 *
 * `node scripts/three-chunk.ts [dist]` exits 1 when the rule breaks.
 */

export type Chunk = { file: string; code: string; sources: string[]; imports: string[] };

/** The chunks a chunk imports by a static `import` or `export … from`, never by `import()`. */
export function staticImports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+\s*from\s*)?["']\.\/([^"']+\.js)["']/g)) out.add(m[1]!);
  return [...out];
}

/** dist's chunks, with the modules each one's source map names. */
export function readChunks(dist: string): { entry: string; chunks: Map<string, Chunk> } {
  const assets = path.join(dist, "assets");
  const chunks = new Map<string, Chunk>();
  for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(path.join(assets, file), "utf8");
    const map = path.join(assets, `${file}.map`);
    const sources = existsSync(map) ? ((JSON.parse(readFileSync(map, "utf8")) as { sources?: string[] }).sources ?? []) : [];
    chunks.set(file, { file, code, sources: sources.map((s) => s.replace(/\\/g, "/")), imports: staticImports(code) });
  }
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1] ?? "";
  return { entry, chunks };
}

/** Every chunk these load with them: themselves and all they import statically, however deep. */
export function closure(chunks: ReadonlyMap<string, Chunk>, from: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...from];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of chunks.get(file)?.imports ?? []) if (chunks.has(next)) stack.push(next);
  }
  return seen;
}

const THREE = /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?three\/build\/three\.module\.js$/;
const NAMED = { Room: /client\/pages\/Room\.tsx$/, room: /client\/canvas\/Stage\.tsx$/, "Dice panel": /client\/features\/dice\/DicePanel\.tsx$/ } as const;

export type Check = { problems: string[]; stage: string | null; firstLoad: Set<string> };

export function checkThree(build: { entry: string; chunks: ReadonlyMap<string, Chunk> }): Check {
  const { chunks, entry } = build;
  const problems: string[] = [];
  const holding = [...chunks.values()].filter((c) => c.sources.some((s) => THREE.test(s))).map((c) => c.file);
  if (holding.length !== 1) problems.push(`three's renderer is in ${holding.length} chunks, not one: ${holding.join(", ") || "none"}`);
  const named: [string, string][] = [["entry", entry]];
  for (const [name, re] of Object.entries(NAMED)) {
    const chunk = [...chunks.values()].find((c) => c.sources.some((s) => re.test(s)));
    if (chunk) named.push([name, chunk.file]);
    else problems.push(`no ${name} chunk found`);
  }
  const loaded = closure(
    chunks,
    named.map(([, file]) => file),
  );
  for (const file of holding) if (loaded.has(file)) problems.push(`three's chunk ${file} loads with the ${named.find(([, f]) => f === file)?.[0] ?? "entry, Room, room or Dice panel"} chunks`);
  const firstLoad = closure(chunks, [entry, ...named.filter(([n]) => n === "Room" || n === "room").map(([, f]) => f)]);
  return { problems, stage: holding.length === 1 ? holding[0]! : null, firstLoad };
}

function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

if (import.meta.main) {
  const dist = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../dist", import.meta.url)));
  const build = readChunks(dist);
  const result = checkThree(build);
  if (result.stage) {
    const code = Buffer.from(build.chunks.get(result.stage)!.code);
    console.log(`three's chunk: ${result.stage}, ${kb(code.length)} minified, ${kb(gzipSync(code, { level: 9 }).length)} gzip, ${kb(brotliCompressSync(code).length)} brotli`);
  }
  const first = [...result.firstLoad].reduce((n, file) => n + gzipSync(Buffer.from(build.chunks.get(file)!.code), { level: 9 }).length, 0);
  console.log(`The room's first load: ${result.firstLoad.size} chunks, ${kb(first)} gzip`);
  for (const p of result.problems) console.error(p);
  process.exit(result.problems.length > 0 ? 1 : 0);
}
