import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { runSettings } from "#shared/propertyTestutil.ts";
import { AssetError } from "../errors.ts";
import { checkVideoBytes } from "./check.ts";
import { assertNearLinear, bx, GROWTH_SCALE, mp4File } from "./videoTestutil.ts";
import { Budget, BufferSource, EditIntoMediaError, Edits, FileWindow, Tally, WINDOW_BYTES } from "./window.ts";

/** The header check's reads and edits (docs/design/design-v1-animated-maps.md 10). */

const badVideo = (err: unknown) => err instanceof AssetError && err.code === "bad_video";

test("no edit may reach into the media data, whatever the parser asked for", () => {
  const edits = new Edits();
  edits.protect(10, 20);
  edits.zero(0, 10);
  edits.put(20, Buffer.from([1, 2]));
  assert.deepEqual([...edits.applyTo(Buffer.alloc(30, 9)).subarray(8, 23)], [0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1, 2, 9]);
  edits.zero(19, 21);
  assert.throws(() => edits.applyTo(Buffer.alloc(30)), EditIntoMediaError);
  const put = new Edits();
  put.protect(10, 20);
  put.put(8, Buffer.from([1, 2, 3]));
  assert.throws(() => put.applyTo(Buffer.alloc(30)), EditIntoMediaError);
});

test("edits land in a file in place, zeroes first, keeping its length", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const path = join(dir, "v");
    await writeFile(path, Buffer.alloc(WINDOW_BYTES * 2 + 5, 7));
    const edits = new Edits();
    edits.zero(3, WINDOW_BYTES * 2);
    edits.put(3, Buffer.from([0xec, 0x81]));
    await edits.applyToFile(path);
    const after = await readFile(path);
    assert.equal(after.length, WINDOW_BYTES * 2 + 5);
    assert.deepEqual([...after.subarray(0, 6)], [7, 7, 7, 0xec, 0x81, 0]);
    assert.ok(after.subarray(5, WINDOW_BYTES * 2).every((b) => b === 0));
    assert.ok(after.subarray(WINDOW_BYTES * 2).every((b) => b === 7));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read past the end, or longer than a window, is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const path = join(dir, "v");
    await writeFile(path, Buffer.alloc(WINDOW_BYTES + 100, 1));
    const window = await FileWindow.open(path, new Budget());
    try {
      assert.equal((await window.read(WINDOW_BYTES, 100)).length, 100);
      await assert.rejects(window.read(WINDOW_BYTES, 101), badVideo);
      await assert.rejects(window.read(-1, 1), badVideo);
      await assert.rejects(window.read(0, WINDOW_BYTES + 1), /one window/);
      assert.equal((await window.readAll(0, WINDOW_BYTES + 100)).length, WINDOW_BYTES + 100);
    } finally {
      await window.close();
    }
    await assert.rejects(new BufferSource(Buffer.alloc(4)).read(2, 3), badVideo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const { seed, runs } = runSettings(process.env);

/** The guard as first written: every edit against every media range. The sweep must agree with it on every input. */
function naiveReachesMedia(edits: Edits): boolean {
  return edits.touched().some((t) => edits.protected.some((p) => t.start < p.end && p.start < t.end));
}

/** Edits and media ranges anywhere in a small file, overlapping each other or not. */
const editPlan = fc.record({
  zeroes: fc.array(fc.tuple(fc.nat(300), fc.nat(40)), { maxLength: 12 }),
  writes: fc.array(fc.tuple(fc.nat(300), fc.integer({ min: 1, max: 8 })), { maxLength: 12 }),
  media: fc.array(fc.tuple(fc.nat(300), fc.integer({ min: 1, max: 40 })), { maxLength: 12 }),
});

function editsOf(plan: { zeroes: [number, number][]; writes: [number, number][]; media: [number, number][] }): Edits {
  const edits = new Edits();
  for (const [at, n] of plan.zeroes) edits.zero(at, at + n);
  for (const [i, [at, n]] of plan.writes.entries()) edits.put(at, Buffer.alloc(n, 0x10 + i));
  for (const [at, n] of plan.media) edits.protect(at, at + n);
  return edits;
}

test("the sorted sweep agrees with every edit checked against every media range (AMBUILD-ASTRA-01)", () => {
  let reached = 0;
  fc.assert(
    fc.property(editPlan, (plan) => {
      const edits = editsOf(plan);
      let threw = false;
      try {
        edits.assertOutsideMedia();
      } catch (err) {
        assert.ok(err instanceof EditIntoMediaError);
        threw = true;
      }
      assert.equal(threw, naiveReachesMedia(edits));
      if (threw) reached++;
    }),
    { seed, numRuns: runs ?? 2000 },
  );
  assert.ok(reached > 100, `only ${reached} plans reached the media`);
});

test("edits written a window at a time leave the file as applying each in turn would (AM-R1-01)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const size = WINDOW_BYTES * 3 + 77;
    const original = Buffer.alloc(size);
    for (let i = 0; i < size; i++) original[i] = (i * 31 + 7) & 0xff;
    const place = fc.nat(size - 1);
    const plan = fc.record({
      zeroes: fc.array(fc.tuple(place, fc.oneof(fc.nat(64), fc.nat(WINDOW_BYTES * 2))), { maxLength: 30 }),
      writes: fc.array(fc.tuple(place, fc.integer({ min: 1, max: 9 })), { maxLength: 30 }),
    });
    await fc.assert(
      fc.asyncProperty(plan, async ({ zeroes, writes }) => {
        const edits = new Edits();
        for (const [at, n] of zeroes) edits.zero(at, Math.min(size, at + n));
        // The check never writes the same byte twice, so the plan keeps its writes apart.
        let after = -1;
        for (const [i, [at, n]] of [...writes].sort((a, b) => a[0] - b[0]).entries()) {
          if (at <= after || at + n > size) continue;
          edits.put(at, Buffer.alloc(n, 0x80 + i));
          after = at + n - 1;
        }
        const path = join(dir, "v");
        await writeFile(path, original);
        await edits.applyToFile(path);
        assert.ok((await readFile(path)).equals(edits.applyTo(original)));
      }),
      { seed, numRuns: runs ?? 150 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two writes over one byte are the check's own bug", () => {
  const edits = new Edits();
  edits.put(4, Buffer.from([1, 2]));
  edits.put(5, Buffer.from([3]));
  assert.throws(() => edits.applyTo(Buffer.alloc(10)), /two video edits write at 5/);
});

/**
 * The reviewers' shape (AMBUILD-ASTRA-01, AMBUILD-SOL-001): 180,002 edits
 * between 96,000 media ranges, as a WebM with a void element after each of
 * its blocks makes, or 1/`scale` of each. Every edit against every range
 * took 10 to 14 s.
 */
function reviewersEdits(scale: number): { edits: Edits; length: number } {
  const edits = new Edits();
  let at = 0;
  for (let i = 0; i < 96_000 / scale; i++) {
    edits.protect(at, at + 9);
    at += 9;
    if (i < 90_001 / scale) {
      edits.put(at, Buffer.from([0xec, 0x81]));
      edits.zero(at + 2, at + 3);
      at += 3;
    }
  }
  return { edits, length: at };
}

test("180,002 edits between 96,000 media ranges check and land in near-linear time", async () => {
  // CPU time, with a wall-clock budget no busy machine reaches: a shared test machine stretches the wall clock, never the work.
  const roomy = () => new Budget(120_000);
  const cpuMs = async (run: () => unknown) => {
    const since = process.cpuUsage();
    await run();
    const used = process.cpuUsage(since);
    return (used.user + used.system) / 1000;
  };
  const sizes = new Map([1, GROWTH_SCALE].map((scale) => [scale, reviewersEdits(scale)]));
  const at = (scale: number) => sizes.get(scale)!;
  assert.equal(at(1).edits.writes.length + at(1).edits.zeroes.length, 180_002);
  // The guard sorts the edits and the media ranges and passes over each once, so on any machine it costs about what those sorts cost there: every edit against every range cost a thousand times that. Sorting slows past the cache, which an eighth's growth would read as noise. One run first, warming the code, holds a backstop no runner comes near. Then each reading is the least of five, each of ten runs, well above the clock's grain.
  const { edits } = at(1);
  const firstMs = await cpuMs(() => edits.assertOutsideMedia(roomy()));
  assert.ok(firstMs < 2_000, `the guard took ${Math.round(firstMs)} ms of CPU, over the 2000 ms backstop`);
  const byStart = (a: { start: number }, b: { start: number }) => a.start - b.start;
  const least = async (run: () => void) => {
    let ms = Infinity;
    for (let k = 0; k < 5; k++) ms = Math.min(ms, await cpuMs(() => { for (let i = 0; i < 10; i++) run(); }));
    return ms;
  };
  const sortMs = await least(() => { edits.touched().sort(byStart); [...edits.protected].sort(byStart); });
  const guardMs = await least(() => edits.assertOutsideMedia(roomy()));
  assert.ok(guardMs < 10 * sortMs, `the guard took ${(guardMs / 10).toFixed(1)} ms of CPU, ${(guardMs / sortMs).toFixed(1)} times the sorts it needs`);
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const path = (scale: number) => join(dir, `v${scale}`);
    const original = (scale: number) => Buffer.alloc(at(scale).length, 0x55);
    // Only a backstop, at twice what a CI runner took (3.6 s): the growth is the check.
    await assertNearLinear("the writes", async (scale) => {
      await writeFile(path(scale), original(scale));
      return cpuMs(() => at(scale).edits.applyToFile(path(scale), roomy()));
    }, 7_500);
    assert.ok((await readFile(path(1))).equals(at(1).edits.applyTo(original(1))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the guard and the writes stop at a spent budget", async () => {
  const edits = new Edits();
  for (let i = 0; i < 5_000; i++) edits.zero(i * 4, i * 4 + 2);
  let now = 0;
  const budget = new Budget(5_000, () => now);
  now = 6_000;
  assert.throws(() => edits.assertOutsideMedia(budget), badVideo);
  await assert.rejects(edits.applyToFile("never-opened", budget), badVideo);
});

test("a spent budget and a count past its cap refuse with their codes", () => {
  let now = 0;
  const budget = new Budget(5_000, () => now);
  budget.check();
  now = 5_001;
  assert.throws(() => budget.check(), badVideo);
  const frames = new Tally(2, "video_fps");
  frames.add(2);
  assert.throws(() => frames.add(), (err: unknown) => err instanceof AssetError && err.code === "video_fps");
});

/** A file handle that records where each write lands, standing in for `open` (AMBUILD-SOL-007). */
function recording(spans: Array<{ start: number; end: number }>) {
  return async (path: string, flags: string) => {
    const handle = await open(path, flags);
    const write = handle.write.bind(handle) as (buf: Buffer, offset: number, length: number, position: number) => Promise<unknown>;
    return Object.assign(handle, {
      write: (buf: Buffer, offset: number, length: number, position: number) => {
        spans.push({ start: position, end: position + length });
        return write(buf, offset, length, position);
      },
    }) as typeof handle;
  };
}

const crosses = (spans: ReadonlyArray<{ start: number; end: number }>, media: ReadonlyArray<{ start: number; end: number }>) =>
  spans.filter((s) => media.some((m) => s.start < m.end && m.start < s.end));

test("no write the edits make spans media data, though edits lie on both sides of it within a window (AMBUILD-SOL-007)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    // The reviewer's shape: ftyp's minor version before a small mdat, and padding after it, all inside one window.
    const bytes = mp4File({ afterMdat: [bx("free", Buffer.from("free box after the media"))] });
    const { edits } = await checkVideoBytes(bytes);
    const path = join(dir, "v.mp4");
    await writeFile(path, bytes);
    const spans: Array<{ start: number; end: number }> = [];
    await edits.applyToFile(path, undefined, recording(spans));
    assert.ok(spans.length >= 2, `the writes were recorded: ${JSON.stringify(spans)}`);
    assert.deepEqual(crosses(spans, edits.protected), []);
    assert.ok((await readFile(path)).equals(edits.applyTo(bytes)));

    // Any layout of edits and media ranges a window apart or less.
    const piece = fc.record({ kind: fc.constantFrom("zero", "write", "media", "gap"), length: fc.integer({ min: 1, max: 900 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { minLength: 1, maxLength: 40 }), async (pieces) => {
        const e = new Edits();
        let at = 0;
        for (const [i, p] of pieces.entries()) {
          if (p.kind === "zero") e.zero(at, at + p.length);
          else if (p.kind === "write") e.put(at, Buffer.alloc(Math.min(p.length, 9), 0x40 + (i % 60)));
          else if (p.kind === "media") e.protect(at, at + p.length);
          at += p.length;
        }
        const original = Buffer.alloc(at, 0x33);
        await writeFile(path, original);
        const seen: Array<{ start: number; end: number }> = [];
        await e.applyToFile(path, undefined, recording(seen));
        assert.deepEqual(crosses(seen, e.protected), []);
        assert.ok((await readFile(path)).equals(e.applyTo(original)));
      }),
      { seed, numRuns: runs ?? 200 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
