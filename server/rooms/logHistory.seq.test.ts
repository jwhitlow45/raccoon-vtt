import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import type { LogEntry, Member, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { IN_Q, seqTwins } from "#shared/seqTestutil.ts";
import { captureView, compareIds, LogHistory, type HistoryView } from "./logHistory.ts";
import { LogScanBudget } from "./logScanBudget.ts";
import { lineAccess, storedKey } from "./persistence.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/**
 * A log read takes the room count it captured as its bound (logHistory.ts
 * HistoryView `through`): the lines a commit writes are numbered above the count
 * it captured, whatever the storage seq has reached through the room's own
 * work, so a page read while a batch commits returns none of that batch's
 * lines, even once they reach the archive before the read scans it. The
 * archive here is in memory, answering the statements both readers send,
 * as server/http/logHistory.test.ts answers them.
 */

const KEY = /(\(split_part\(id, ':', 1\)::bigint, split_part\(id, ':', 2\)::int\)|\(seq, line_no\)) (>=|<=|>|<) \(\$(\d+)::bigint, \$(\d+)::int\)/g;

function keyOf(id: string): [bigint, number] {
  const at = id.indexOf(":");
  return [BigInt(id.slice(0, at)), Number(id.slice(at + 1))];
}

function cmp(a: [bigint, number], b: [bigint, number]): number {
  return a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] - b[1];
}

/** The bounds a statement's text and parameters name, as a filter on a key. */
function boundsOf(text: string, params: unknown[]): (k: [bigint, number]) => boolean {
  const tests: ((k: [bigint, number]) => boolean)[] = [];
  for (const m of text.matchAll(KEY)) {
    const b: [bigint, number] = [BigInt(String(params[Number(m[3]) - 1])), Number(params[Number(m[4]) - 1])];
    const op = m[2]!;
    tests.push((k) => {
      const c = cmp(k, b);
      return op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
    });
  }
  return (k) => tests.every((t) => t(k));
}

/** One room's archive, every row with its metadata, and connections that answer both readers' SQL against it. */
class Archive {
  rows: LogEntry[] = [];
  access(): { stream: string; member: string; seq: string; line: number; id: string }[] {
    return this.rows.flatMap((entry) => {
      const key = storedKey(entry.id);
      if (!key) return [];
      return lineAccess(entry).map((a) => ({ stream: a.stream, member: a.memberId, seq: key.seq, line: key.line, id: entry.id }));
    });
  }
  connect = () => Promise.resolve(new FakeClient(this) as never);
}

class FakeClient extends EventEmitter {
  processID = 1;
  #archive: Archive;
  #cursor: string[] = [];

  constructor(archive: Archive) {
    super();
    this.#archive = archive;
  }

  query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.startsWith("begin") || t === "rollback" || t === "commit") return Promise.resolve({ rows: [] });
    if (t.startsWith("select exists")) return Promise.resolve({ rows: [{ incomplete: false }] });
    if (t.startsWith("declare")) {
      const maxSeq = BigInt(Number(params[1]));
      const within = boundsOf(t, params);
      const desc = / desc$/.test(t);
      this.#cursor = this.#archive.rows
        .map((r) => r.id)
        .filter((id) => keyOf(id)[0] <= maxSeq && within(keyOf(id)))
        .sort((a, b) => cmp(keyOf(a), keyOf(b)) * (desc ? -1 : 1));
      return Promise.resolve({ rows: [] });
    }
    if (t.startsWith("fetch")) {
      const n = Number(/^fetch (\d+)/.exec(t)![1]);
      return Promise.resolve({ rows: this.#cursor.splice(0, n).map((id) => ({ id })) });
    }
    if (t.startsWith("select id, entry from room_log")) {
      const ids = new Set(params[1] as string[]);
      return Promise.resolve({ rows: this.#archive.rows.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, entry: r })) });
    }
    if (t.startsWith("select id, seq::text as seq_text, line_no from room_log_access")) {
      const [, stream, memberId, maxSeq] = params as [string, string, string, number];
      const within = boundsOf(t, params);
      const desc = / desc limit \$\d+$/.test(t);
      const limit = Number(params[params.length - 1]);
      const rows = this.#archive
        .access()
        .filter((a) => a.stream === stream && a.member === memberId && (!t.includes("seq <= $4") || BigInt(a.seq) <= BigInt(maxSeq)) && within([BigInt(a.seq), a.line]))
        .sort((a, b) => cmp([BigInt(a.seq), a.line], [BigInt(b.seq), b.line]) * (desc ? -1 : 1))
        .slice(0, limit)
        .map((a) => ({ id: a.id, seq_text: a.seq, line_no: a.line }));
      return Promise.resolve({ rows });
    }
    return Promise.reject(new Error(`the fake archive does not know: ${t.slice(0, 80)}`));
  }

  release(): void {}
}

const numberOf = (id: string) => Number(id.slice(0, id.indexOf(":")));

describe("a log read is bounded by the room count it captured", () => {
  test("C17: a page read while a batch commits returns no line above the count, though the storage seq is past it", async (t) => {
    const w = seqTwins();
    const db = new StoredRoomDb(w.door);
    const h = await storedActor(t, db);
    const member = (id: string) => h.actor.committed.state.members[id] as Member;
    const dm = await ScopeClient.open(h.actor, member("dm1"), "dm");
    const p1 = await ScopeClient.open(h.actor, member("p1"), "player");
    const p2 = await ScopeClient.open(h.actor, member("p2"), "player");
    await p1.apply({ t: "log.chat", text: "before" });
    // P2 walks in room Q, so the room explores and remembers there: rows that move the storage seq and not the count.
    await dm.apply({ t: "token.move", tokenId: "b", x: IN_Q.x, y: IN_Q.y });
    for (const [x, y] of [[23, 6], [24, 8], [20, 4]] as const) await p2.apply({ t: "token.move", tokenId: "b", x, y });
    await dm.apply({ t: "log.chat", text: "the DM's" });

    // P1's chat commits and is held at its COMMIT, while each viewer's read captures the room.
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    db.beforeCommit = async () => {
      db.beforeCommit = undefined;
      enter();
      await held;
    };
    const chat = p1.apply({ t: "log.chat", text: "during" } as Op);
    await entered;
    const viewers: Viewer[] = [{ memberId: "p1", role: "player" }, { memberId: "p2", role: "player" }, { memberId: "dm1", role: "dm" }];
    const views = viewers.map((viewer) => captureView(h.actor.committed, "UNDOSCOPE", viewer));
    release();
    await chat;

    const view = views[0]!;
    assert.ok(view.seq > view.through, `the room's own work moved the storage seq past the count (${view.seq} against ${view.through})`);
    const during = h.actor.committed.state.log.find((line) => line.kind === "chat" && line.text === "during");
    assert.ok(during && numberOf(during.id) === view.through + 1, "the held batch's line takes the count's next number");
    assert.ok(numberOf(during.id) <= view.seq, "and a number at or below the storage seq the read captured");

    // The commit landed before the read scans: the archive holds every line, the held batch's too.
    const archive = new Archive();
    archive.rows = [...h.actor.committed.state.log].sort((a, b) => compareIds(a.id, b.id));
    const budget = new LogScanBudget();
    t.after(() => budget.close());
    const readers = { raw: new LogHistory({ pool: archive }), indexed: new LogHistory({ pool: archive, metadata: { ready: true, want: () => undefined } }) };
    const read = async (history: LogHistory, v: HistoryView) => {
      const scan = budget.open({ pool: "page", roomId: v.roomId, memberId: v.viewer.memberId });
      try {
        const back = await history.page(v, { limit: 100 }, scan);
        const forward = await history.page(v, { after: "0:0", limit: 100 }, scan);
        const sessions = await history.sessions(v, { limit: 50 }, scan);
        return { back: back.entries.map((e) => e.id), forward: forward.entries.map((e) => e.id), lines: sessions.lines };
      } finally {
        scan.close();
      }
    };
    for (const [name, history] of Object.entries(readers)) {
      for (const v of views) {
        const got = await read(history, v);
        const who = `${name}, ${v.viewer.role} ${v.viewer.memberId}`;
        assert.ok(got.back.length > 0, `${who}: the read returns lines`);
        assert.deepEqual(got.forward, got.back, `${who}: both directions read the same lines`);
        for (const id of got.back) assert.ok(numberOf(id) <= v.through, `${who}: ${id} is at or below the count ${v.through}`);
        assert.ok(!got.back.includes(during.id), `${who}: the held batch's line is not read`);
        assert.equal(got.lines, got.back.length, `${who}: the sessions count the same lines`);
      }
    }
  });
});
