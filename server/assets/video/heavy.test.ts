import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { checkVideo, checkVideoBytes } from "./check.ts";
import { Budget } from "./window.ts";
import { allEbml, assertNearLinear, bx, defaultVideoTrack, encodeWebm, GROWTH_SCALE, mp4File, segmentOf, webmTree, type Ebml } from "./videoTestutil.ts";
import { EBML_ID as I } from "./webm.ts";

/**
 * Files at the parser's caps, in the shapes the reviewers measured
 * (AMBUILD-ASTRA-01, AMBUILD-SOL-001, AM-R1-01), check in time that grows
 * near linearly with the file. Before, the media-edit guard compared every
 * edit with every media range and the MP4 walk tried every `mdat` for every
 * sample: these files took 3.6 to 52 s and blocked the server's event loop
 * meanwhile.
 */

/** Twice the budget, in CPU time: only a backstop, since a CI runner took 2.9 s for a file a quick computer checks in 1. */
const BACKSTOP_MS = VIDEO_LIMITS.parseBudgetMs * 2;

/**
 * Each check runs with a wall-clock budget no busy machine reaches, and is
 * measured in CPU time, every thread counted: a test machine shared with
 * other runs stretches the wall clock many times over, never the work.
 */
const ROOMY_MS = 120_000;
const roomy = () => new Budget(ROOMY_MS);

async function cpuMs(run: () => Promise<unknown>): Promise<number> {
  const before = process.cpuUsage();
  await run();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/** An element off every list, one byte of payload: the check turns each into a Void, a write and a zero. */
const OFF_LIST: Ebml = { id: 0xc0, data: Buffer.from("A") };

/** A CELT packet of 10 ms (configuration 30, code 0) and of 20 ms (31). */
const OPUS_10MS = 0xf0;
const OPUS_20MS = 0xf8;

/**
 * Ten minutes at 60 fps, the most frames a file may hold, with sound blocks
 * of `soundMs` each and `offList` elements spread between the blocks, or
 * 1/`scale` of each.
 */
function capsWebm(o: { soundMs: 10 | 20; offList: number; scale?: number }): Buffer {
  const scale = o.scale ?? 1;
  const durationMs = 600_000 / scale;
  const frames = Array.from({ length: 36_000 / scale }, (_, i) => Math.round((i * 1000) / 60));
  const toc = o.soundMs === 10 ? OPUS_10MS : OPUS_20MS;
  const blocks = Array.from({ length: durationMs / o.soundMs }, (_, i) => ({ ms: i * o.soundMs, tocs: [toc] }));
  const tree = webmTree({ frameMs: frames, frameBytes: 1, durationMs, sound: { blocks } });
  let left = o.offList / scale;
  for (const cluster of allEbml(segmentOf(tree), I.Cluster)) {
    const kids: Ebml[] = [];
    for (const kid of cluster.kids!) {
      kids.push(kid);
      if (kid.id !== I.SimpleBlock) continue;
      for (let k = 0; k < 3 && left > 0; k++, left--) kids.push(OFF_LIST);
    }
    cluster.kids = kids;
  }
  assert.equal(left, 0, "the blocks hold every off-list element");
  return encodeWebm(tree);
}

const dir = await mkdtemp(join(tmpdir(), "rvtt-heavy-"));
after(() => rm(dir, { recursive: true, force: true }));

/** The whole check on a file on disk, in its worker, the edits included, in ms of CPU. */
async function timedCheck(name: string, bytes: Buffer): Promise<number> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return cpuMs(() => checkVideo(path, { budgetMs: ROOMY_MS }));
}

/**
 * The check's growth is read in memory, where nothing but the check runs: a
 * worker's start costs the same at any size, and at an eighth it hid most
 * of a sample-against-every-mdat walk. The check on disk, in its worker,
 * then runs once at the caps under the backstop.
 */
async function checksInNearLinearTime(name: string, whole: Buffer, eighth: Buffer): Promise<Buffer> {
  await assertNearLinear("the check in memory", (scale) => cpuMs(() => checkVideoBytes(scale === 1 ? whole : eighth, { budget: roomy() })), BACKSTOP_MS);
  const ms = await timedCheck(name, whole);
  assert.ok(ms < BACKSTOP_MS, `the check on disk took ${Math.round(ms)} ms of CPU, over the ${BACKSTOP_MS} ms backstop`);
  return readFile(join(dir, name));
}

describe("files at the parser's caps check in near-linear time", () => {
  test("a WebM with 180,002 edits and 96,000 media ranges (AMBUILD-ASTRA-01)", async () => {
    const bytes = capsWebm({ soundMs: 10, offList: 90_000 });
    const { facts, edits, zeroed } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(edits.writes.length + edits.zeroes.length, 180_002);
    assert.equal(edits.protected.length, 96_000);
    assert.equal(facts.durationMs, 600_000);
    const stored = await checksInNearLinearTime("astra.webm", bytes, capsWebm({ soundMs: 10, offList: 90_000, scale: GROWTH_SCALE }));
    assert.ok(stored.equals(zeroed), "the file on disk holds the same edits as the bytes in memory");
  });

  test("a WebM with 190,000 off-list elements between 66,000 blocks (AM-R1-01)", async () => {
    const bytes = capsWebm({ soundMs: 20, offList: 190_000 });
    const { edits } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(edits.protected.length, 66_000);
    const stored = await checksInNearLinearTime("opus.webm", bytes, capsWebm({ soundMs: 20, offList: 190_000, scale: GROWTH_SCALE }));
    assert.equal(stored.includes(encodeWebm([OFF_LIST])), false, "an off-list element survived");
  });

  test("an MP4 whose 36,000 samples sit behind 190,000 empty mdat boxes (AM-R1-01)", async () => {
    const mdats = (scale: number) => {
      const empties = Array.from({ length: 190_000 / scale }, () => bx("mdat"));
      return mp4File({ beforeMoov: empties, tracks: [defaultVideoTrack({ frames: 36_000 / scale, delta: 256 })] });
    };
    const bytes = mdats(1);
    const { facts } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(facts.durationMs, 600_000);
    await checksInNearLinearTime("mdats.mp4", bytes, mdats(GROWTH_SCALE));
  });
});
