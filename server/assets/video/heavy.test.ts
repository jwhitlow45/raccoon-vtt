import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { checkVideo, checkVideoBytes } from "./check.ts";
import { Budget } from "./window.ts";
import { allEbml, bx, defaultVideoTrack, encodeWebm, mp4File, segmentOf, webmTree, type Ebml } from "./videoTestutil.ts";
import { EBML_ID as I } from "./webm.ts";

/**
 * Files at the parser's caps, in the shapes the reviewers measured
 * (AMBUILD-ASTRA-01, AMBUILD-SOL-001, AM-R1-01), check well inside the
 * 5 s budget. Before, the media-edit guard compared every edit with every
 * media range and the MP4 walk tried every `mdat` for every sample: these
 * files took 3.6 to 52 s and blocked the server's event loop meanwhile.
 */

/** Half the budget, in CPU time, which the old quadratic work, at ten times this or more, never came near. */
const WELL_INSIDE_MS = VIDEO_LIMITS.parseBudgetMs / 2;

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
 * of `soundMs` each and `offList` elements spread between the blocks.
 */
function capsWebm(o: { soundMs: 10 | 20; offList: number }): Buffer {
  const frames = Array.from({ length: 36_000 }, (_, i) => Math.round((i * 1000) / 60));
  const toc = o.soundMs === 10 ? OPUS_10MS : OPUS_20MS;
  const blocks = Array.from({ length: 600_000 / o.soundMs }, (_, i) => ({ ms: i * o.soundMs, tocs: [toc] }));
  const tree = webmTree({ frameMs: frames, frameBytes: 1, durationMs: 600_000, sound: { blocks } });
  let left = o.offList;
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

/** The whole check on a file on disk, in its worker, the edits included, timed. */
async function timedCheck(name: string, bytes: Buffer): Promise<{ ms: number; stored: Buffer }> {
  const path = join(dir, name);
  await writeFile(path, bytes);
  const ms = await cpuMs(() => checkVideo(path, { budgetMs: ROOMY_MS }));
  return { ms, stored: await readFile(path) };
}

describe("files at the parser's caps check well inside the budget", () => {
  test("a WebM with 180,002 edits and 96,000 media ranges (AMBUILD-ASTRA-01)", async () => {
    const bytes = capsWebm({ soundMs: 10, offList: 90_000 });
    const { facts, edits, zeroed } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(edits.writes.length + edits.zeroes.length, 180_002);
    assert.equal(edits.protected.length, 96_000);
    assert.equal(facts.durationMs, 600_000);
    const { ms, stored } = await timedCheck("astra.webm", bytes);
    assert.ok(ms < WELL_INSIDE_MS, `the check took ${Math.round(ms)} ms of CPU`);
    assert.ok(stored.equals(zeroed), "the file on disk holds the same edits as the bytes in memory");
  });

  test("a WebM with 190,000 off-list elements between 66,000 blocks (AM-R1-01)", async () => {
    const bytes = capsWebm({ soundMs: 20, offList: 190_000 });
    const { edits } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(edits.protected.length, 66_000);
    const { ms, stored } = await timedCheck("opus.webm", bytes);
    assert.ok(ms < WELL_INSIDE_MS, `the check took ${Math.round(ms)} ms of CPU`);
    assert.equal(stored.includes(encodeWebm([OFF_LIST])), false, "an off-list element survived");
  });

  test("an MP4 whose 36,000 samples sit behind 190,000 empty mdat boxes (AM-R1-01)", async () => {
    const empties = Array.from({ length: 190_000 }, () => bx("mdat"));
    const bytes = mp4File({ beforeMoov: empties, tracks: [defaultVideoTrack({ frames: 36_000, delta: 256 })] });
    const { facts } = await checkVideoBytes(bytes, { budget: roomy() });
    assert.equal(facts.durationMs, 600_000);
    const { ms } = await timedCheck("mdats.mp4", bytes);
    assert.ok(ms < WELL_INSIDE_MS, `the check took ${Math.round(ms)} ms of CPU`);
  });
});
