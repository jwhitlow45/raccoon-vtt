import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Op } from "#shared/protocol.ts";
import { room } from "#shared/testutil.ts";
import { loadRoom, REPLAY_PAGE_ROWS, type Pool } from "./persistence.ts";

/*
 * A load replays its stored rows a page at a time and in turns of the event
 * loop (persistence.ts loadRoom): a long tail gives the same state as one
 * read whole, and no turn of it holds the loop long.
 */

/** A room's stored rows behind its snapshot: chats, with one that no longer applies at `broken` when given. */
function stored(count: number, broken?: number) {
  return Array.from({ length: count }, (_, i) => {
    const seq = i + 1;
    const op: Op = seq === broken ? ({ t: "token.delete", tokenId: "missing" } as Op) : { t: "log.chat", text: `line ${seq}` };
    return { seq: String(seq), at: new Date(Date.UTC(2026, 10, 10, 12, 0, 0, seq)), actor_member_id: "dm1", actor_role: "dm", op, op_version: OP_VERSION, pub: String(seq) };
  });
}

/** A database that answers the room_ops statement a page at a time, by its bounds, or whole when `paged` is false. */
function pool(rows: ReturnType<typeof stored>, paged: boolean): Pool & { pages: number } {
  const snap = { seq: "0", state: room(), schema_version: SNAPSHOT_VERSION, pub: "0" };
  const out = {
    pages: 0,
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("room_snapshots")) return { rows: [structuredClone(snap)] };
      if (sql.includes("room_log")) return { rows: [{ held: true }] };
      out.pages++;
      if (!paged) return { rows };
      const after = Number(params[1]);
      const limit = Number(params[2]);
      return { rows: rows.filter((r) => Number(r.seq) > after).slice(0, limit) };
    },
    connect: () => Promise.reject(new Error("not used")),
  };
  return out as unknown as Pool & { pages: number };
}

describe("a load's replay of a long tail", () => {
  test("25,860 rows read by pages give the state they give read whole, and no turn holds the event loop 50 ms of work", async () => {
    const rows = stored(25_860);
    const whole = await loadRoom(pool(rows, false), "R");
    const paged = pool(rows, true);
    // The work between two turns of the loop, read as the process's CPU time, so a busy machine that holds the
    // process off the CPU does not count as the replay holding the loop.
    let turns = 0;
    let longestMs = 0;
    let last = process.cpuUsage();
    let ticking = true;
    const tick = () => {
      const now = process.cpuUsage(last);
      longestMs = Math.max(longestMs, (now.user + now.system) / 1_000);
      last = process.cpuUsage();
      turns++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    const loaded = await loadRoom(paged, "R");
    ticking = false;
    assert.ok(whole && loaded);
    assert.deepEqual(loaded, whole);
    assert.equal(loaded.replayed, 25_860);
    assert.equal(loaded.pub, 25_860);
    assert.equal(paged.pages, Math.ceil(25_860 / REPLAY_PAGE_ROWS), "each page by its bounds, the last a short one");
    assert.ok(turns > 10, `the loop ran ${turns} turns during the replay`);
    assert.ok(longestMs < 50, `the longest turn took ${longestMs.toFixed(1)} ms of CPU`);
  });

  test("a replay that stops inside a page reads the rest for their numbers, as a whole read does", async () => {
    for (const broken of [3, REPLAY_PAGE_ROWS, REPLAY_PAGE_ROWS + 7]) {
      const rows = stored(REPLAY_PAGE_ROWS * 2 + 11, broken);
      const failures: number[] = [];
      const whole = await loadRoom(pool(rows, false), "R");
      const loaded = await loadRoom(pool(rows, true), "R", (seq) => failures.push(seq));
      assert.deepEqual(failures, [broken]);
      assert.ok(loaded && whole);
      assert.deepEqual(loaded, whole, `broken at ${broken}`);
      assert.equal(loaded.replayFailed, true);
      assert.equal(loaded.replayed, broken - 1);
      assert.equal(loaded.pub, rows.length, "the count takes every stored row's number");
      assert.equal(loaded.through, broken - 1);
    }
  });
});
