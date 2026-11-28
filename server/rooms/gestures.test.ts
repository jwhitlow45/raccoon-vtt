import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { uuidv7 } from "#shared/ids.ts";
import { clientMessageSchema, ephCaps, ephEventOutSchema, expandGroup, loneEphSchema, MAX_EPH_BYTES, outboundEph, rosterOf, type EphEvent, type GroupFrame } from "#shared/protocol.ts";
import { serializedBytes } from "#shared/limits.ts";
import { MAX_HELD_BYTES, MAX_HELD_BYTES_OFF, MAX_HELD_FRAMES, MAX_ROOM_HELD_SENDS, MEMBER_HELD_SHARE } from "./actor.ts";
import { FULL_ALLOWANCE_BYTES, OFF_ALLOWANCE_BYTES } from "./budgets.ts";
import { CANCEL_SENDS, GESTURE_STALE_MS, GestureVersions, heldCharge, heldForm, heldSends, holdFrame, HONEST_MEMBER_SENDS, MAX_VERSION_BYTES, MAX_VERSIONS, NEED_EVERY_MS, routedForm, versionCharge, WIDEST_EVENTS, type HeldFrame } from "./gestures.ts";

/** A frame as the socket layer hands it over, through the client schema. */
function frame(e: unknown): GroupFrame | EphEvent {
  const r = clientMessageSchema.safeParse({ t: "eph", sceneId: "s1", e });
  assert.ok(r.success && r.data.t === "eph", JSON.stringify(r.error?.issues));
  return r.data.e;
}
const group = (e: unknown) => frame(e) as GroupFrame;
const members = (n: number, tag = "m") => Array.from({ length: n }, (_, i) => ({ tokenId: `${tag}${i}`, x: i, y: 0 }));
const start = (g: number, n: number, tag = "m") => group({ k: "dragStart", tokenId: "p", g, x: 0, y: 0, with: members(n, tag), from: { x: 0, y: 0 } });
const move = (g: number, x = 1) => group({ k: "dragMove", tokenId: "p", g, x, y: 0 });

describe("a gesture's roster versions", () => {
  test("a frame binds the open version, a roster makes a new one, and an end closes them, each freed once nothing waits on it", () => {
    const v = new GestureVersions();
    const first = v.arrive(start(1, 3), 0);
    assert.ok(first && first !== "refused");
    assert.deepEqual(first.ids, ["m0", "m1", "m2"]);
    const later = v.arrive(move(1), 10);
    assert.equal(later, first, "a frame without a roster binds the open one");
    assert.deepEqual(v.retained, { versions: 1, bytes: versionCharge(3) });
    const end = v.arrive(group({ k: "groupEnd", tokenId: "p", g: 1, at: [null, null, null, null] }), 20);
    assert.equal(end, first, "an end binds the open version too");
    assert.equal(v.arrive(move(1), 30), null, "and closes it for the frames after it");
    // Three frames hold it: freed once the last lets go.
    v.release(first);
    v.release(later as typeof first);
    assert.equal(v.retained.versions, 1);
    v.release(end as typeof first);
    assert.deepEqual(v.retained, { versions: 0, bytes: 0 });
  });

  test("a new roster closes the one it replaces, which is freed once its frames are gone", () => {
    const v = new GestureVersions();
    const first = v.arrive(start(1, 3), 0);
    const second = v.arrive(group({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 0, with: members(2, "n"), from: { x: 0, y: 0 } }), 10);
    assert.ok(first && first !== "refused" && second && second !== "refused" && second !== first);
    assert.deepEqual(v.retained, { versions: 2, bytes: versionCharge(3) + versionCharge(2) }, "the first still waits on its frame");
    v.release(first);
    assert.deepEqual(v.retained, { versions: 1, bytes: versionCharge(2) });
    assert.equal(v.arrive(move(1, 2), 20), second);
  });

  test("floors A to B to A: the old floor's cancel closes only the rosters before it, and the return's roster stays open", () => {
    const v = new GestureVersions();
    const a1 = v.arrive(start(1, 2), 0);
    v.release(a1 as never);
    // The old floor's cancel and the new floor's first frame, with its roster again, in one flush.
    const cancelA = v.arrive(group({ k: "dragCancel", tokenId: "p", g: 1 }), 33);
    const b = v.arrive(group({ k: "dragMove", tokenId: "p", g: 1, x: 1, y: 0, with: members(2), from: { x: 0, y: 0 } }), 33);
    const cancelB = v.arrive(group({ k: "dragCancel", tokenId: "p", g: 1 }), 66);
    const a2 = v.arrive(group({ k: "dragMove", tokenId: "p", g: 1, x: 2, y: 0, with: members(2), from: { x: 0, y: 0 } }), 66);
    assert.equal(cancelA, a1);
    assert.equal(cancelB, b);
    assert.ok(a2 && a2 !== "refused" && a2 !== a1 && a2 !== b);
    for (const held of [cancelA, b, cancelB]) v.release(held as never);
    assert.equal(v.arrive(move(1, 3), 99), a2, "the return's roster binds the frames after it");
    assert.equal(v.retained.versions, 1);
  });

  test("past 24 versions the least recently framed one no frame pins goes, open or closed, and when every one is pinned the new roster is refused", () => {
    const v = new GestureVersions();
    const pinned: unknown[] = [];
    // 40 roster messages of 40 gestures while their tick is not covered: every one stays pinned.
    let refused = 0;
    for (let g = 1; g <= 40; g++) {
      const bound = v.arrive(start(g, 99, `g${g}-`), g);
      if (bound === "refused") refused++;
      else pinned.push(bound);
      assert.ok(v.retained.versions <= MAX_VERSIONS && v.retained.bytes <= MAX_VERSION_BYTES, JSON.stringify(v.retained));
    }
    assert.equal(pinned.length, MAX_VERSIONS);
    assert.equal(refused, 40 - MAX_VERSIONS);
    // The first five route. Their versions stay open, and now the least recently framed of them goes first.
    for (const held of pinned.slice(0, 5)) v.release(held as never);
    v.arrive(move(3), 100);
    v.release(v.arrive(move(3), 101) as never);
    const before = v.retained.versions;
    const fresh = v.arrive(start(41, 99, "g41-"), 102);
    assert.ok(fresh && fresh !== "refused");
    assert.equal(v.retained.versions, before, "one went to make room");
    assert.equal(v.arrive(move(1), 103), null, "gesture 1, framed least recently, lost its roster");
    assert.notEqual(v.arrive(move(3), 104), null, "gesture 3, framed since, kept its");
    // A gesture that lost its roster asks for it again, at most once a second.
    assert.equal(v.mayAsk(1, 103), true);
    assert.equal(v.mayAsk(1, 103 + NEED_EVERY_MS - 1), false);
    assert.equal(v.mayAsk(1, 103 + NEED_EVERY_MS), true);
  });

  test("a gesture with no frame for 10 s gives up its rosters at the sweep, and a socket's close takes them all", () => {
    const v = new GestureVersions();
    v.release(v.arrive(start(1, 4), 0) as never);
    v.release(v.arrive(start(2, 4), 5_000) as never);
    v.sweep(GESTURE_STALE_MS - 1);
    assert.equal(v.retained.versions, 2);
    v.sweep(GESTURE_STALE_MS);
    assert.equal(v.retained.versions, 1);
    assert.equal(v.arrive(move(1), GESTURE_STALE_MS), null);
    v.clear();
    assert.deepEqual(v.retained, { versions: 0, bytes: 0 });
  });

  test("ids escaped or plain, one length or another, a roster is charged by its count alone", () => {
    const plain = new GestureVersions();
    const escaped = new GestureVersions();
    const verdicts = (store: GestureVersions, id: (i: number) => string) =>
      Array.from({ length: 30 }, (_, g) => {
        const bound = store.arrive(group({ k: "dragStart", tokenId: id(999), g, x: 0, y: 0, with: Array.from({ length: 50 }, (_, i) => ({ tokenId: id(g * 100 + i), x: i, y: 0 })), from: { x: 0, y: 0 } }), g);
        return bound === "refused" ? "refused" : bound === null ? "none" : "bound";
      });
    const a = verdicts(plain, (i) => `t${i}`);
    const b = verdicts(escaped, (i) => `\u0001 "\\${i}`.padEnd(64, "\u0002"));
    assert.deepEqual(a, b);
    assert.deepEqual(plain.retained, escaped.retained);
  });
});

describe("a held frame's kept form", () => {
  test("gives back the frame the router reads, and expands as the frame did", () => {
    const cases: unknown[] = [
      { k: "dragMove", tokenId: "p", g: 2, x: 1.5, y: -2, free: true, fts: [3, null, -1e300], lead: { i: 1, x: 4, y: 5, path: [1, 2, 3, 4], ft: 7, squeeze: true } },
      { k: "dragMove", tokenId: "p", g: 2, x: 1.5, y: -2, path: [0, 0, 1, 1], ft: 0, squeeze: true },
      { k: "dragMove", tokenId: "p", g: 2, x: 1.5, y: -2, lead: { i: 0 } },
      { k: "groupEnd", tokenId: "p", g: 2, at: [{ x: 1, y: 2, squeeze: true }, null, { x: -3, y: 4 }] },
      { k: "dragStart", tokenId: "p", g: 2, x: 9, y: 9 },
      { k: "dragCancel", tokenId: "p", g: 2 },
      { k: "ruler", id: "r é", points: [{ x: 1.5, y: 1.5, tokenId: "t一" }, { x: 2.5, y: 1.5, z: 10 }] },
      { k: "dragMove", tokenId: "v", x: 1, y: 2, path: [1, 2, 3.5, 4], ft: 10, free: true },
      { k: "aoe", id: "a", shape: "cone", origin: { x: 1, y: 2, z: 0 }, yaw: 45, size: 15 },
    ];
    const roster = rosterOf(group({ k: "dragStart", tokenId: "p", g: 2, x: 0, y: 0, with: members(3), from: { x: 0, y: 0 } }));
    for (const e of cases) {
      const sent = frame(e);
      const back = routedForm(heldForm(sent));
      assert.deepEqual(back, sent, JSON.stringify(e));
      if ("g" in sent) assert.deepEqual(expandGroup(back as GroupFrame, roster), expandGroup(sent, roster));
    }
  });

  test("is charged by its kind alone", () => {
    assert.equal(heldCharge(frame({ k: "dragMove", tokenId: "p", g: 1, x: 0, y: 0 })), ephCaps.charges.move);
    assert.equal(heldCharge(frame({ k: "dragMove", tokenId: "p", x: 0, y: 0 })), ephCaps.charges.move);
    assert.equal(heldCharge(frame({ k: "groupEnd", tokenId: "p", g: 1, at: [null] })), ephCaps.charges.move);
    assert.equal(heldCharge(frame({ k: "ruler", id: "r", points: [{ x: 0, y: 0 }] })), ephCaps.charges.measure);
    assert.equal(heldCharge(frame({ k: "aoe", id: "a", shape: "cone", origin: { x: 1, y: 2, z: 0 }, yaw: 45, size: 15 })), ephCaps.charges.measure);
    for (const e of [{ k: "dragStart", tokenId: "p", g: 1, x: 0, y: 0, with: members(99), from: { x: 0, y: 0 } }, { k: "ping", x: 1, y: 1 }, { k: "rulerEnd", id: "r" }]) assert.equal(heldCharge(frame(e)), ephCaps.charges.other);
  });
});

/*
 * Each charge against the bytes the build keeps (design 7.6): heap and
 * array buffers, with a garbage collection on both sides, per object over
 * many, each at its widest. An id of 64 two-byte units is the widest a
 * string keeps, and every number its widest finite form.
 */
describe("what the server keeps, measured against its charges", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  /**
   * Bytes kept per object. One run of a slow runner can read high or low (a
   * collector that has not finished, a sweep that lands mid-run), so this
   * takes the median of several runs. A real growth past a charge moves every
   * run, so the median still shows it. `lastRuns` holds the runs for a message.
   */
  let lastRuns: number[] = [];
  const RUNS = 5;
  function once(n: number, make: (i: number) => unknown): number {
    const keep: unknown[] = new Array(n).fill(null);
    gc();
    gc();
    const before = process.memoryUsage();
    for (let i = 0; i < n; i++) keep[i] = make(i);
    gc();
    gc();
    const after = process.memoryUsage();
    assert.equal(keep.length, n);
    return (after.heapUsed - before.heapUsed + (after.arrayBuffers - before.arrayBuffers)) / n;
  }
  function perObject(n: number, make: (i: number) => unknown): number {
    lastRuns = Array.from({ length: RUNS }, () => once(n, make)).sort((a, b) => a - b);
    return lastRuns[RUNS >> 1]!;
  }
  const runs = () => `runs ${lastRuns.map((b) => b.toFixed(1)).join(", ")}`;
  const wide = (i: number, j: number) => String.fromCharCode(0x4e00 + (i % 500), 0x4e00 + (j % 500), 0x4e00 + Math.floor(i / 500)) + "一".repeat(61);
  const N = -1.2345678901234567e-100;
  const nums = (count: number) => Array.from({ length: count }, (_, i) => N * (i + 1));
  const held = (e: GroupFrame | EphEvent, i: number): HeldFrame => holdFrame("s1", e, null, i, i, i);

  test("a roster version and each member it stores", () => {
    const noise: string[] = [];
    const measured = (m: number, n: number) => {
      const texts = Array.from({ length: n }, (_, i) => JSON.stringify({ k: "dragStart", tokenId: wide(i, 999), g: 1, x: N, y: N, with: Array.from({ length: m }, (_, j) => ({ tokenId: wide(i, j), x: N * j, y: N })), from: { x: N, y: N } }));
      const frames = texts.map((t) => JSON.parse(t) as unknown);
      const empty = perObject(n, () => new GestureVersions());
      const emptyRuns = runs();
      const one = perObject(n, (i) => {
        const store = new GestureVersions();
        store.arrive(group(frames[i]), 0);
        return store;
      });
      noise.push(`${m} members: empty ${emptyRuns}, held ${runs()}`);
      return one - empty;
    };
    const base = measured(0, 4_000);
    const full = measured(99, 400);
    assert.ok(base <= ephCaps.charges.version, `a version: ${base} bytes (${noise.join("; ")})`);
    assert.ok((full - base) / 99 <= ephCaps.charges.member, `a member: ${(full - base) / 99} bytes (${noise.join("; ")})`);
    assert.ok(full <= versionCharge(99), `a full version: ${full} bytes (${noise.join("; ")})`);
  });

  for (const [name, make, charge] of [
    ["a move whose lead is a member", (i: number) => ({ k: "dragMove", tokenId: wide(i, 1), g: Number.MAX_SAFE_INTEGER, x: N, y: N, free: true, fts: nums(99).map((v, j) => (j % 3 ? v : null)), lead: { i: 98, x: N, y: N, path: nums(200), ft: N, squeeze: true } }), ephCaps.charges.move],
    ["a move of the pressed token's own route", (i: number) => ({ k: "dragMove", tokenId: wide(i, 1), g: 1, x: N, y: N, path: nums(200), ft: N, squeeze: true, free: true, fts: nums(99) }), ephCaps.charges.move],
    ["a group end", (i: number) => ({ k: "groupEnd", tokenId: wide(i, 1), g: 1, at: Array.from({ length: 100 }, (_, j) => ({ x: N * (j + 1), y: N, squeeze: true })) }), ephCaps.charges.move],
    ["a lone move", (i: number) => ({ k: "dragMove", tokenId: wide(i, 1), x: -999.1234567890123, y: -999.1234567890123, path: Array.from({ length: 200 }, (_, j) => -999.125 + j / 8), ft: 99_999.12345678901, squeeze: true, free: true }), ephCaps.charges.move],
    ["a ruler at its wire cap", (i: number) => ({ k: "ruler", id: `r${i}`, points: Array.from({ length: 50 }, (_, j) => ({ x: -999.1234567890123 + j / 7, y: 2.5, tokenId: `${"t".repeat(26)}${String(i).padStart(6, "0")}${String(j).padStart(2, "0")}` })), shared: true }), ephCaps.charges.measure],
    ["a ruler of two-byte ids", (i: number) => ({ k: "ruler", id: `r${i}`, points: Array.from({ length: 40 }, (_, j) => ({ x: -9.1234567890123 + j / 7, y: 2.5, tokenId: `${"ā".repeat(25)}${String(j).padStart(2, "0")}` })), shared: true }), ephCaps.charges.measure],
    ["an area", (i: number) => ({ k: "aoe", id: wide(i, 3), shape: "cone", origin: { x: -999.12345678901, y: -999.12345678901, z: -99_999 }, yaw: -359.123456789, pitch: -89.12345678, size: 1_000, width: 1_000, height: 1_000, shared: true }), ephCaps.charges.measure],
    ["a group start", (i: number) => ({ k: "dragStart", tokenId: wide(i, 4), g: Number.MAX_SAFE_INTEGER, x: N, y: N }), ephCaps.charges.other],
    ["a tagged cancel", (i: number) => ({ k: "dragCancel", tokenId: wide(i, 4), g: Number.MAX_SAFE_INTEGER }), ephCaps.charges.other],
    ["a lone end", (i: number) => ({ k: "dragEnd", tokenId: wide(i, 4), x: -999.1234567890123, y: -999.1234567890123, squeeze: true }), ephCaps.charges.other],
    ["a camera", () => ({ k: "view", x: -999.1234567890123, y: -999.1234567890123, w: 1_999.123456789012, h: 1_999.123456789012, iso: { turn: 3, vw: 1_999.123456789012, vh: 1_999.123456789012 } }), ephCaps.charges.other],
    ["a ruler's end", (i: number) => ({ k: "rulerEnd", id: wide(i, 5) }), ephCaps.charges.other],
  ] as const) {
    test(`${name}, held`, () => {
      const frames = Array.from({ length: 3_000 }, (_, i) => frame(JSON.parse(JSON.stringify(make(i)))));
      if ((frames[0] as { k: string }).k === "ruler") assert.ok(serializedBytes(frames[0]) > 0.98 * MAX_EPH_BYTES || name.includes("two-byte"), `${serializedBytes(frames[0])} bytes`);
      const bytes = perObject(frames.length, (i) => held(frames[i]!, i));
      assert.ok(bytes <= charge, `${bytes} bytes against ${charge} (${runs()})`);
    });
  }

  test("each limit sits above the honest worst in 2 s (design 7.6), and a full allowance is the held cap and the rosters' cap", () => {
    // The one moving source at 30 a second and the new slots beside it, each at the most a kind is charged, then the rest.
    const moving = 80 * Math.max(ephCaps.charges.move, ephCaps.charges.measure);
    const keepalives = 4 * ephCaps.charges.measure;
    const others = 56 * ephCaps.charges.other;
    assert.ok(140 <= MAX_HELD_FRAMES);
    assert.ok(moving + keepalives + others <= MAX_HELD_BYTES, `${(moving + keepalives + others) / 1024} KiB`);
    // 14 rosters in RETAIN_MS and 2 open, each of a full roster.
    assert.ok(16 <= MAX_VERSIONS && 16 * versionCharge(99) <= MAX_VERSION_BYTES);
    assert.ok(MAX_VERSIONS * versionCharge(99) <= MAX_VERSION_BYTES, "the count cap binds first");
    assert.equal(FULL_ALLOWANCE_BYTES, MAX_HELD_BYTES + MAX_VERSION_BYTES);
    // An off socket's camera, focus, laser and pings in 2 s: 60 laser, 34 camera and 20 ping frames.
    assert.ok(114 * ephCaps.charges.other <= MAX_HELD_BYTES_OFF && MAX_HELD_BYTES_OFF === OFF_ALLOWANCE_BYTES);
  });
});

describe("what a held frame may send one receiver, at its widest (D-261126-265)", () => {
  /** An id of 64 units JSON escapes to 6 characters each, apart for each `i`: unpaired surrogates and a control character. */
  const escaped = (i: number) => String.fromCharCode(0xdc00 + (i % 1024), 0xdc00 + Math.floor(i / 1024)) + "\u0001".repeat(62);
  const scene = "\u0002".repeat(64);
  const C = -0.0000012345678901234567;
  const FT = 0.0000012345678901234567;
  const ids = Array.from({ length: 100 }, (_, i) => escaped(i));
  const roster = { with: ids.slice(1).map((tokenId) => ({ tokenId, x: C, y: C })), from: { x: C, y: C } };
  const route = Array.from({ length: 200 }, () => C);

  /** What a DM receiver is sent for the frame's tokens, each a lone frame that stands, with the widest scene id and a member id. */
  function sentToOne(e: GroupFrame, by: GroupFrame): number {
    let bytes = 0;
    for (const lone of expandGroup(e, rosterOf(by))) {
      if (!loneEphSchema.safeParse(lone).success) continue;
      bytes += Buffer.byteLength(JSON.stringify({ t: "eph", from: uuidv7(), sceneId: scene, e: outboundEph(lone) }));
    }
    return bytes;
  }

  test("each widest event names every field its kind's schema takes, at the widest id and number", () => {
    const options = (ephEventOutSchema as unknown as { options: { shape: Record<string, { value?: string; unwrap?: () => { shape: object } }> }[] }).options;
    for (const [k, e] of Object.entries(WIDEST_EVENTS)) {
      const shape = options.find((o) => o.shape.k!.value === k)!.shape;
      // A move's route is counted on its own.
      assert.deepEqual(Object.keys(e).sort(), Object.keys(shape).filter((key) => !(k === "dragMove" && key === "path")).sort(), k);
    }
    const iso = (options.find((o) => o.shape.k!.value === "view")!.shape.iso!.unwrap!()).shape;
    assert.deepEqual(Object.keys(WIDEST_EVENTS.view.iso).sort(), Object.keys(iso).sort());
    assert.equal(JSON.stringify(WIDEST_EVENTS.dragStart.x).length, ephCaps.numberChars);
    assert.equal(Buffer.byteLength(JSON.stringify(WIDEST_EVENTS.dragStart.tokenId)), ephCaps.idBytes);
    assert.equal(uuidv7().length, 36, "the member ids the server mints");
  });

  test("a 100-token frame of escaped ids sends one receiver within its charge, kind by kind, and close to it", () => {
    const start = group({ k: "dragStart", tokenId: ids[0], g: 1, x: C, y: C, ...roster });
    const frames: [string, GroupFrame, GroupFrame][] = [
      ["a start", start, start],
      ["a move whose lead is a member", group({ k: "dragMove", tokenId: ids[0], g: 1, x: C, y: C, free: true, fts: ids.slice(1).map(() => FT), lead: { i: 0, x: C, y: C, path: route, ft: FT, squeeze: true } }), start],
      ["a move of the pressed token's own route", group({ k: "dragMove", tokenId: ids[0], g: 1, x: C, y: C, path: route, ft: FT, squeeze: true, free: true, fts: ids.slice(1).map(() => FT) }), start],
      ["an end that lands every token", group({ k: "groupEnd", tokenId: ids[0], g: 1, at: ids.map(() => ({ x: C, y: C, squeeze: true })) }), start],
      ["an end that lands none", group({ k: "groupEnd", tokenId: ids[0], g: 1, at: ids.map(() => null) }), start],
      ["a tagged cancel", group({ k: "dragCancel", tokenId: ids[0], g: 1 }), start],
    ];
    for (const [name, e, by] of frames) {
      const sent = sentToOne(e, by);
      assert.ok(sent <= heldSends(e), `${name}: ${sent} bytes against ${heldSends(e)}`);
      assert.ok(sent > 0.9 * heldSends(e), `${name}: ${sent} bytes against ${heldSends(e)}`);
    }
    // A preview's cancels, which a frame's routing may send on top: each at most the widest cancel.
    for (const e of [{ k: "dragCancel", tokenId: ids[1] }, { k: "rulerEnd", id: ids[1] }, { k: "aoeEnd", id: ids[1] }]) {
      assert.ok(Buffer.byteLength(JSON.stringify({ t: "eph", from: uuidv7(), sceneId: scene, e })) <= CANCEL_SENDS);
    }
  });

  test("a member's share sits above an honest member's devices through a stall, and two members' shares leave a third its drag's start and move", () => {
    assert.ok(HONEST_MEMBER_SENDS <= MEMBER_HELD_SHARE, `${HONEST_MEMBER_SENDS} against ${MEMBER_HELD_SHARE}`);
    const drag = heldSends(start(1, 0)) + heldSends(move(1));
    assert.ok(2 * MEMBER_HELD_SHARE + drag <= MAX_ROOM_HELD_SENDS);
  });
});
