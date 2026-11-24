import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { acceptedOf, keptWork, MOST_CHANGED } from "#shared/accepted.ts";
import { seatWork } from "#shared/limits.ts";
import type { Op } from "#shared/protocol.ts";
import { scene, token } from "#shared/testutil.ts";
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
 * batch. Its answer waits for the batch's close. It is handled as it
 * arrives only while the loop's clock stands (playerWork): the drain lets
 * the loop go once a turn has used DRAIN_TURN_MS on that clock, and a slow
 * machine can spend it on the DM's ops, leaving the next op queued for the
 * drain's next turn as this one returns.
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
  const loop = t.mock.method(performance, "now", () => 0);
  try {
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
  } finally {
    loop.mock.restore();
  }
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

  /*
   * The far widths read the room's facts, the widest scene id among them,
   * a hidden scene's too, so each room keeps one part for them a kind and
   * replaces it as its own facts change (shared/accepted.ts roomPart). New
   * scenes take ids of one width, so the DM moves the widest id by deleting
   * a scene with an older, wider one, or by bringing it back.
   */
  test("rooms loaded beside it with 40 sets of facts, past what a registry shared by every room would hold", async (t) => {
    const alone = await playerWork(t, hiddenRoom(), async () => []);
    const beside = await playerWork(t, hiddenRoom(), async () => {
      for (let i = 0; i < 40; i++) {
        const other = withLegacyScenes(scopeFixture(), 1, i % 20);
        other.state.meta = { ...other.state.meta, settings: { ...other.state.meta.settings, playersApplyDamage: i >= 20 } };
        await scopeActor(t, other.state);
      }
      return [];
    });
    assert.deepEqual(beside, alone);
  });

  test("another room's DM narrowing its widest scene id again and again", async (t) => {
    const alone = await playerWork(t, hiddenRoom(), async () => []);
    const other = withLegacyScenes(scopeFixture(), LEGACY);
    const h = await scopeActor(t, other.state);
    const elsewhere = await h.connect(other.dm);
    const beside = await playerWork(t, hiddenRoom(), async () => {
      for (let i = 0; i < LEGACY; i++) await elsewhere.apply({ t: "scene.delete", sceneId: legacyId(i) });
      return [];
    });
    assert.deepEqual(beside, alone);
  });

  test("the DM's deletions of hidden scenes, each narrowing the widest id, before the player's walk", async (t) => {
    const works: Work[] = [];
    const counts = [0, 1, 3, 8, LEGACY];
    for (const n of counts) {
      works.push(
        await playerWork(t, withLegacyScenes(hiddenRoom(), LEGACY), async (dm) => {
          // The scenes left over are as many in every case: those past n go before the room loads.
          for (let i = 0; i < n; i++) await dm.apply({ t: "scene.delete", sceneId: legacyId(i) });
          return [];
        }),
      );
    }
    for (const [i, work] of works.entries()) assert.deepEqual(work, works[0], `after the DM deleted ${counts[i]} hidden scenes`);
  });

  test("a hidden scene with the widest id deleted and brought back before the player's walk", async (t) => {
    const alone = await playerWork(t, withLegacyScenes(hiddenRoom(), 1), async () => []);
    const after = await playerWork(t, withLegacyScenes(hiddenRoom(), 1), async (dm) => {
      await dm.apply({ t: "scene.delete", sceneId: legacyId(0) });
      // A scene's deletion is the DM's setup, and its Undo is there.
      await dm.restore("setup");
      assert.ok(dm.actor.committed.state.scenes[legacyId(0)], "the scene is back");
      return [];
    });
    assert.deepEqual(after, alone);
  });
});

/** How many hidden scenes with older, wider ids a room may hold. */
const LEGACY = 20;

/** A hidden scene's id from before ids took one width, wider than any new one's, the first widest. */
function legacyId(i: number): string {
  return `legacy${String(i).padStart(2, "0")}`.padEnd(60 - i, "x");
}

/** The fixture with `count` hidden scenes of legacy ids, from the `from`th widest. */
function withLegacyScenes<F extends ReturnType<typeof scopeFixture>>(f: F, count: number, from = 0): F {
  for (let i = from; i < from + count; i++) f.state.scenes[legacyId(i)] = scene(legacyId(i), { order: 5 + i });
  return f;
}

describe("what a room keeps lets go of the parts it drops", () => {
  test("an unchanged token and template record, through 50 changes of the room's widths facts, as many as the room's op rate lets the DM send at once, holds only the parts the room keeps", async (t) => {
    const f = withLegacyScenes(scopeFixture(), 1);
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const { tokens, templates } = dm.actor.committed.state;
    const parts: WeakRef<object>[] = [];
    let last: object[] = [];
    const note = () => {
      const named = acceptedOf(dm.actor.committed.state)!.named;
      const now = ["widths:tokens", "widths:templates"].map((name) => named.get(name)!.part);
      for (const [i, part] of now.entries()) if (part !== last[i]) parts.push(new WeakRef(part));
      last = now;
    };
    note();
    for (let i = 0; i < 25; i++) {
      await dm.apply({ t: "scene.delete", sceneId: legacyId(0) });
      note();
      await dm.restore("setup");
      note();
    }
    assert.equal(dm.actor.committed.state.tokens, tokens, "the token record is the one the room loaded");
    assert.equal(dm.actor.committed.state.templates, templates, "the template record is the one the room loaded");
    assert.equal(parts.length, 102, "each change of facts made the room new parts");
    assert.equal(await kept(parts), 2, "only the room's two widths parts are kept");
  });
});

/** How many of `parts` are still held once garbage is collected, which may take a few rounds. */
async function kept(parts: readonly WeakRef<object>[]): Promise<number> {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  let live = parts.length;
  for (let round = 0; round < 10 && live > 2; round++) {
    // A WeakRef read in this turn holds its object until the turn ends.
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    live = parts.filter((ref) => ref.deref() !== undefined).length;
  }
  return live;
}
