import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import fc from "fast-check";
import type { MapVideo } from "#shared/model.ts";
import {
  boardVideoStatus,
  decoderLeases,
  leaseDecoder,
  MOVING,
  resetDecoderForTests,
  resetServerAnimatedMapsForTests,
  serverAnimatedMaps,
  serverAnimatedMapsNow,
  stillFor,
  type DecoderLease,
  type DecoderUser,
} from "./status.ts";

const VIDEO: MapVideo = { assetId: "v1", widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4_000 };

describe("the board's live status", () => {
  test("readers hear a change of video or reason, and nothing else", () => {
    const status = boardVideoStatus();
    let heard = 0;
    status.subscribe(() => heard++);
    status.set(null);
    assert.equal(heard, 0);
    status.set({ assetId: "v1", playback: MOVING });
    status.set({ assetId: "v1", playback: { play: true, reason: "moving" } });
    assert.equal(heard, 1);
    status.set({ assetId: "v1", playback: stillFor("lowPower") });
    status.set({ assetId: "v2", playback: stillFor("lowPower") });
    status.set(null);
    assert.equal(heard, 4);
    assert.equal(status.get(), null);
  });
});

describe("the server's switch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetServerAnimatedMapsForTests();
  });

  function answer(body: unknown, status = 200): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return () => calls;
  }

  test("on only when the config says so, asked once", async () => {
    const calls = answer({ turnstileSiteKey: null, searchEnabled: true, animatedMaps: true });
    assert.equal(await serverAnimatedMaps(), true);
    assert.equal(await serverAnimatedMaps(), true);
    assert.equal(calls(), 1);
  });

  test("off when the config says off or leaves it out", async () => {
    answer({ turnstileSiteKey: null, searchEnabled: true, animatedMaps: false });
    assert.equal(await serverAnimatedMaps(), false);
    resetServerAnimatedMapsForTests();
    answer({ turnstileSiteKey: null, searchEnabled: true });
    assert.equal(await serverAnimatedMaps(), false);
  });

  test("unknown until the server answers, then on or off", async () => {
    resetServerAnimatedMapsForTests();
    assert.equal(serverAnimatedMapsNow(), null);
    answer({ animatedMaps: true });
    await serverAnimatedMaps();
    assert.equal(serverAnimatedMapsNow(), true);
  });

  test("a failed read is off, and asked again next time", async () => {
    const failed = answer({ error: "internal" }, 500);
    assert.equal(await serverAnimatedMaps(), false);
    assert.equal(failed(), 1);
    answer({ animatedMaps: true });
    assert.equal(await serverAnimatedMaps(), true);
  });
});

/** An element that holds a src while granted, and clears it when asked, now or later. */
type Element = { lease: DecoderLease; user: DecoderUser; src: boolean; grants: number; yields: number; yieldAsked: boolean };

function owner(user: DecoderUser, onYield: (el: Element) => void = (el) => clearAndRelease(el)): Element {
  const el = { user, src: false, grants: 0, yields: 0, yieldAsked: false } as Element;
  el.lease = leaseDecoder(user, {
    onGrant(lease) {
      assert.equal(lease, el.lease ?? lease);
      el.grants++;
      el.src = true;
    },
    onYield() {
      el.yields++;
      el.yieldAsked = true;
      onYield(el);
    },
  });
  return el;
}

function clearAndRelease(el: Element): void {
  el.src = false;
  el.lease.release();
}

describe("one decoder per window (5.2)", () => {
  afterEach(resetDecoderForTests);

  test("a lease is granted at once when nothing holds the decoder", () => {
    const board = owner("board");
    assert.equal(board.grants, 1);
    assert.equal(board.lease.granted(), true);
    assert.deepEqual(decoderLeases(), [{ user: "board", granted: true }]);
  });

  test("the viewer waits for the board to clear its src, and the board waits for the viewer to close", () => {
    const board = owner("board", () => {});
    const viewer = owner("viewer");
    assert.equal(board.yields, 1);
    assert.equal(viewer.grants, 0, "the viewer sets no src while the board's is set");
    clearAndRelease(board);
    assert.equal(viewer.grants, 1);
    const again = owner("board");
    assert.equal(viewer.yields, 0, "the board never takes the decoder from the viewer");
    assert.equal(again.grants, 0);
    clearAndRelease(viewer);
    assert.equal(again.grants, 1);
  });

  test("replacing a map that plays clears the old src before the new one is set", () => {
    const old = owner("board", () => {});
    const next = owner("board");
    assert.equal(old.yields, 1);
    assert.equal(next.grants, 0);
    clearAndRelease(old);
    assert.equal(next.grants, 1);
  });

  test("a waiting lease asked to yield withdraws, and releasing twice does nothing", () => {
    const viewer = owner("viewer");
    const board = owner("board", (el) => el.lease.release());
    assert.equal(board.yields, 0, "the board waits behind the viewer without being asked anything");
    const second = owner("viewer");
    assert.equal(board.yields, 1, "a new viewer page asks the waiting board to give up too");
    assert.equal(viewer.yields, 1);
    clearAndRelease(viewer);
    viewer.lease.release();
    assert.equal(second.grants, 1);
    assert.equal(board.grants, 0, "a withdrawn lease is never granted");
    assert.deepEqual(decoderLeases(), [{ user: "viewer", granted: true }]);
  });

  test("a lease released while waiting is never granted", () => {
    const board = owner("board", () => {});
    const viewer = owner("viewer");
    viewer.lease.release();
    clearAndRelease(board);
    assert.equal(viewer.grants, 0);
    assert.deepEqual(decoderLeases(), []);
  });

  test("random sequences keep at most one src per window, and never stall (state machine rule)", () => {
    type Step = { t: "ask"; user: DecoderUser; prompt: boolean } | { t: "clear"; pick: number } | { t: "close"; pick: number };
    const step = fc.oneof(
      fc.record({ t: fc.constant("ask" as const), user: fc.constantFrom<DecoderUser>("board", "viewer"), prompt: fc.boolean() }),
      fc.record({ t: fc.constant("clear" as const), pick: fc.nat() }),
      fc.record({ t: fc.constant("close" as const), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps: Step[]) => {
        resetDecoderForTests();
        const live: Element[] = [];
        const released = new Set<Element>();
        const check = () => {
          // At most one element holds a src, and only a granted lease's.
          const holding = live.filter((el) => el.src);
          assert.ok(holding.length <= 1, "two elements hold a src");
          for (const el of holding) assert.ok(el.lease.granted());
          for (const el of live) assert.ok(el.grants <= 1 && el.yields <= 1);
          for (const el of released) assert.equal(el.lease.granted(), false);
          // Liveness: nothing held while something waits means a grant was missed.
          const leases = decoderLeases();
          if (leases.length > 0) assert.ok(leases.some((l) => l.granted), "a lease waits with nothing holding the decoder");
        };
        for (const s of steps) {
          if (s.t === "ask") {
            // A prompt owner clears and releases as soon as it is asked. A slow one clears on a later `clear` step.
            live.push(owner(s.user, s.prompt ? clearAndRelease : () => {}));
          } else {
            const candidates = s.t === "clear" ? live.filter((el) => el.yieldAsked) : live;
            const el = candidates[s.pick % Math.max(1, candidates.length)];
            if (el) {
              clearAndRelease(el);
              released.add(el);
              live.splice(live.indexOf(el), 1);
            }
          }
          check();
        }
        // Every owner asked to yield clears in the end, and the newest viewer, else the oldest board, then holds it.
        for (const el of live.filter((e) => e.yieldAsked)) {
          clearAndRelease(el);
          released.add(el);
        }
        check();
      }),
      { numRuns: 2_000 },
    );
  });
});
