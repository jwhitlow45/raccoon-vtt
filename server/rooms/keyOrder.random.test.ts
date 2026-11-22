import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { reordered } from "#shared/keyOrderTestutil.ts";
import { DM, P1, P2, env, randomOp, randomState, rng } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { exploreOp } from "./explore.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";

/**
 * Many random rooms, each with a twin that holds the same values with every
 * object's keys in another order at every depth (as making order, a delete
 * put back and a room read back from storage each leave them) and each
 * chunk's free walls in another order. Both take the same random batches,
 * the explore step after each, published by `publishBatch` to P1, P2, a
 * table display and a DM's view as P1, with joins, resyncs and the twin
 * read back in yet another order between batches. Checked after every step:
 *
 * - the twins' copies for each of those viewers hold the same values;
 * - every socket of one twin was sent exactly the text its counterpart was,
 *   byte for byte, snapshots and batches alike.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

type Socket = { label: string; conn: Connection; texts: string[] };

class Twin {
  state: RoomState;
  readonly sockets: Socket[] = [];

  constructor(state: RoomState) {
    this.state = state;
  }

  /** A socket's first snapshot, sent as the actor sends it. */
  open(label: string, viewer: Viewer, grant: { display?: boolean; previewOf?: string } = {}): void {
    const texts: string[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => texts.push(text), close: () => undefined, terminate: () => undefined };
    const conn = new Connection(socket as never, { sessionId: `s-${label}`, roomId: "KEYORDER", memberId: viewer.memberId, role: viewer.role, ...grant }, "203.0.113.31");
    this.sockets.push({ label, conn, texts });
    this.snapshot(conn);
  }

  snapshot(conn: Connection): void {
    const snapshot = buildSnapshot(this.state, 1, conn, 0);
    conn.send(snapshot.message);
    conn.held = snapshot.held;
  }

  /** The texts every socket was sent since `from`, by socket. */
  since(from: Map<string, number>): string[] {
    return this.sockets.map((s) => `${s.label} ${s.texts.slice(from.get(s.label) ?? 0).join("\n")}`);
  }

  marks(): Map<string, number> {
    return new Map(this.sockets.map((s) => [s.label, s.texts.length]));
  }
}

type Tally = { batches: number; frames: number; joins: number; resyncs: number; readBacks: number; apartAsWritten: number };

const VIEWERS: Array<{ label: string; viewer: Viewer; grant?: { display?: boolean; previewOf?: string } }> = [
  { label: "p1", viewer: P1 },
  { label: "p2", viewer: P2 },
  { label: "display", viewer: DISPLAY, grant: { display: true } },
  { label: "preview", viewer: { memberId: "dm1", role: "dm" }, grant: { previewOf: "p1" } },
];

function sameCopies(a: RoomState, b: RoomState, where: string): void {
  for (const viewer of [P1, P2, DISPLAY]) {
    assert.equal(stableStringify(projectState(b, viewer, { sceneId: null })), stableStringify(projectState(a, viewer, { sceneId: null })), `${where}: ${viewer.memberId}'s copies hold the same values`);
  }
}

function run(seed: number, batches: number, tally: Tally): void {
  const r = rng(seed);
  const start = randomState(r);
  const pair = [new Twin(start), new Twin(reordered(start, rng(seed + 7_000)))] as const;
  for (const { label, viewer, grant } of VIEWERS) for (const twin of pair) twin.open(label, viewer, grant);
  const asWritten = (state: RoomState) => JSON.stringify(projectState(state, P1, { sceneId: null }));
  if (asWritten(pair[0].state) !== asWritten(pair[1].state)) tally.apartAsWritten++;
  sameCopies(pair[0].state, pair[1].state, `seed ${seed} at the start`);
  assert.deepEqual(pair[1].since(new Map()), pair[0].since(new Map()), `seed ${seed}: the first snapshots`);
  let seq = 100;
  let joined = 0;
  for (let b = 0; b < batches; b++) {
    const where = `seed ${seed} batch ${b}`;
    const marks = pair.map((twin) => twin.marks());
    const ops: Array<{ op: Op; who: Viewer }> = [];
    const size = 1 + Math.floor(r() * 3);
    for (let i = 0; i < size; i++) {
      const who = (b + i) % 5 === 4 ? ((b + i) % 2 === 0 ? P1 : P2) : DM;
      const parsed = opSchema.safeParse(randomOp(r, pair[0].state, who));
      assert.ok(parsed.success);
      ops.push({ op: parsed.data, who });
    }
    const before = pair.map((twin) => twin.state);
    const batch = pair.map((twin) => {
      const touched: EntityKey[] = [];
      let global = false;
      let n = seq;
      const answers: string[] = [];
      for (const { op, who } of ops) {
        const result = applyOp(twin.state, op, who, env(++n));
        answers.push(result.ok ? "taken" : `${result.code}: ${result.message}`);
        if (!result.ok) continue;
        twin.state = result.state;
        touched.push(...result.touched);
        global ||= result.global;
      }
      const explore = exploreOp(twin.state);
      if (explore) {
        const result = applyOp(twin.state, explore, { memberId: "server", role: "dm" }, env(++n));
        assert.ok(result.ok, result.ok ? "" : result.message);
        twin.state = result.state;
        touched.push(...result.touched);
        global ||= result.global;
      }
      return { touched, global, answers, n };
    });
    assert.deepEqual(batch[1]!.answers, batch[0]!.answers, `${where}: both twins answer each op alike`);
    seq = batch[0]!.n;
    sameCopies(pair[0].state, pair[1].state, where);
    pair.forEach((twin, i) => {
      if (twin.state === before[i]) return;
      publishBatch({ pub: seq, before: before[i]!, after: twin.state, touched: batch[i]!.touched, global: batch[i]!.global, acks: new Map(), rejects: new Map(), restored: new Map() }, twin.sockets.map((s) => s.conn), () => undefined);
    });
    if (pair[0].state !== before[0]) tally.batches++;
    const roll = r();
    if (roll < 0.1) {
      const k = Math.floor(r() * pair[0].sockets.length);
      for (const twin of pair) twin.snapshot(twin.sockets[k]!.conn);
      tally.resyncs++;
    } else if (roll < 0.2) {
      const { viewer, grant } = VIEWERS[Math.floor(r() * VIEWERS.length)]!;
      const label = `join${++joined}`;
      for (const twin of pair) twin.open(label, viewer, grant);
      tally.joins++;
    } else if (roll < 0.3) {
      pair[1].state = reordered(pair[1].state, rng(seed * 1_000 + b));
      tally.readBacks++;
    }
    const sent = pair.map((twin, i) => twin.since(marks[i]!));
    tally.frames += sent[0]!.filter((line) => line.includes(" {")).length;
    assert.deepEqual(sent[1], sent[0], `${where}: every socket is sent the same text in both twins`);
  }
}

describe("rooms alike but for key order send every player socket the same text", () => {
  test("random batches with joins, resyncs and rooms read back in another order", () => {
    const tally: Tally = { batches: 0, frames: 0, joins: 0, resyncs: 0, readBacks: 0, apartAsWritten: 0 };
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed++) run(seed, 30, tally);
    assert.ok(tally.batches > 600, `only ${tally.batches} batches`);
    assert.ok(tally.frames > 1_500, `only ${tally.frames} frames compared`);
    assert.ok(tally.joins > 50 && tally.resyncs > 50 && tally.readBacks > 50, JSON.stringify(tally));
    assert.equal(tally.apartAsWritten, seeds, "JSON.stringify writes every twin's first copy for P1 apart");
  });
});
