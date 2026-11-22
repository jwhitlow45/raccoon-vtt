import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { keptWork, MOST_CHANGED } from "#shared/accepted.ts";
import { seatWork } from "#shared/limits.ts";
import type { Op } from "#shared/protocol.ts";
import { token } from "#shared/testutil.ts";
import { scopeActor, scopeFixture, until, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * What a room keeps over its accepted state (shared/accepted.ts) moves
 * only with the ops the room accepts, each as it is accepted, so a
 * player's op costs its own writes: the same work whatever the DM did out
 * of their sight before it in the batch, had refused, or deleted without a
 * far check, and whatever another room did. The work is counted, never
 * timed: the keys and entries the kept parts read, and the seats' id
 * comparisons and things read.
 */

const HIDDEN = 150;
const pad = (i: number) => String(i).padStart(4, "0");
const shade = (i: number) => `shade${pad(i)}`;

/** The scoped fixture with HIDDEN of the DM's hidden creatures on the players' scene, and `extra` more past them. */
function hiddenRoom(extra = 0) {
  const f = scopeFixture();
  for (let i = 0; i < HIDDEN + extra; i++) f.state.tokens[shade(i)] = token(shade(i), { sceneId: f.sceneId, name: "Shade", visibility: "dm", x: 20 + (i % 40), y: 20 + Math.floor(i / 40) });
  return f;
}

type Work = { keys: number; entries: number; compared: number; read: number };

function counted(): Work {
  return { keys: keptWork.keys, entries: keptWork.entries, compared: seatWork.compared, read: seatWork.read };
}

/**
 * Sends an op into the open batch: the actor handles it as it arrives, and
 * no timer runs before the next op sent the same way, so they share the
 * batch. Its answer waits for the batch's close.
 */
async function into(client: ScopeClient, op: Op): Promise<number> {
  await client.actor.op(client.conn, ++client.n, op);
  return client.n;
}

/** The batch number of the frame that answered op `n`. */
async function answered(client: ScopeClient, n: number): Promise<number> {
  const frame = await until(() => client.sent.find((m) => m.t === "ev" && (m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))), `the answer to ${n}`);
  return (frame as { seq: number }).seq;
}

/**
 * The player's walk, a square east, and what handling it cost, after
 * `before`: the DM's work in earlier batches, and through `into` in the
 * player's batch, whose op numbers `before` gives back.
 */
async function playerWork(t: TestContext, f: ReturnType<typeof hiddenRoom>, before: (dm: ScopeClient) => Promise<number[]>, options: Parameters<typeof scopeActor>[2] = {}): Promise<Work> {
  const h = await scopeActor(t, f.state, options);
  const dm = await h.connect(f.dm);
  const player = await h.connect(f.player, "player");
  const shared = await before(dm);
  const was = counted();
  const n = await into(player, { t: "token.move", tokenId: f.pc, x: 9, y: 0 });
  const now = counted();
  const batch = await answered(player, n);
  for (const m of shared) assert.equal(await answered(dm, m), batch, "the DM's op shares the player's batch");
  assert.ok(!player.sent.some((m) => m.t === "ev" && m.rejects?.some((r) => r.n === n)), "the player's walk is taken");
  refusedOf.set(dm, shared.filter((m) => dm.sent.some((e) => e.t === "ev" && e.rejects?.some((r) => r.n === m))).length);
  return { keys: now.keys - was.keys, entries: now.entries - was.entries, compared: now.compared - was.compared, read: now.read - was.read };
}

/** How many of the DM's ops in the player's batch the room refused, by the DM's client. */
const refusedOf = new Map<ScopeClient, number>();

/** The k counts each case reads, across the cut-off past which a part is worked out whole. */
const KS = [0, 1, MOST_CHANGED - 1, MOST_CHANGED, MOST_CHANGED + 1, 100];

const moves = (k: number): Op => ({ t: "token.moveMany", moves: Array.from({ length: k }, (_, i) => ({ tokenId: shade(i), x: 20 + (i % 40), y: 30 + Math.floor(i / 40) })) }) as Op;

function alike(works: readonly Work[], what: (k: number) => string): void {
  assert.ok(works[0]!.keys > 0 && works[0]!.entries > 0, "the player's op reads what the room keeps");
  for (const [i, work] of works.entries()) assert.deepEqual(work, works[0], what(KS[i]!));
}

describe("a player's op costs its own writes, whatever hidden work came before it", () => {
  test("the DM's hidden moves earlier in the same batch", async (t) => {
    const works: Work[] = [];
    for (const k of KS) works.push(await playerWork(t, hiddenRoom(), async (dm) => (k > 0 ? [await into(dm, moves(k))] : [])));
    alike(works, (k) => `after the DM moved ${k} hidden creatures`);
  });

  test("a DM's op on hidden creatures, read and then refused", async (t) => {
    const works: Work[] = [];
    // The room's line at a byte, so the DM's growing op is read and then refused there. A player's op meets no such line.
    const grow = (k: number): Op => ({ t: "token.updateMany", tokenIds: Array.from({ length: k }, (_, i) => shade(i)), patch: { w: 2, h: 2 } }) as Op;
    const refused: number[] = [];
    for (const k of KS) {
      let client: ScopeClient | null = null;
      works.push(await playerWork(t, hiddenRoom(), async (dm) => ((client = dm), k > 0 ? [await into(dm, grow(k))] : []), { sizeLimits: { stateLimit: 1 } }));
      refused.push(refusedOf.get(client!) ?? 0);
    }
    assert.deepEqual(refused, KS.map((k) => (k > 0 ? 1 : 0)), "every DM op was refused");
    alike(works, (k) => `after a refused op on ${k} hidden creatures`);
  });

  test("the DM's deletions of hidden creatures, which meet no far check", async (t) => {
    const works: Work[] = [];
    for (const k of KS) {
      // 100 more than the rest: 100 - k go in an earlier batch and k in the player's, so the room holds as many at the player's op.
      const before = async (dm: ScopeClient) => {
        if (k < 100) await dm.apply({ t: "token.deleteMany", tokenIds: Array.from({ length: 100 - k }, (_, i) => shade(HIDDEN + i)) });
        return k > 0 ? [await into(dm, { t: "token.deleteMany", tokenIds: Array.from({ length: k }, (_, i) => shade(HIDDEN + 100 - k + i)) } as Op)] : [];
      };
      works.push(await playerWork(t, hiddenRoom(100), before));
    }
    alike(works, (k) => `after the DM deleted ${k} hidden creatures in the player's batch`);
  });

  test("another room's work beside the player's op", async (t) => {
    const alone = await playerWork(t, hiddenRoom(), async () => []);
    const other = hiddenRoom();
    const h = await scopeActor(t, other.state);
    const elsewhere = await h.connect(other.dm);
    const beside = await playerWork(t, hiddenRoom(), async () => {
      await into(elsewhere, moves(100));
      await into(elsewhere, { t: "token.deleteMany", tokenIds: [shade(140), shade(141)] } as Op);
      return [];
    });
    assert.deepEqual(beside, alone);
  });
});
