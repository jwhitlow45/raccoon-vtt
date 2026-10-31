import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareLogIds } from "#shared/keys.ts";
import { mergeLog } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { ApiError } from "../lib/api.ts";
import { HISTORY_ROWS, HistoryWindow, type HistoryPage, type HistoryState, type PageAsk } from "./historyWindow.ts";

/**
 * The Log panel's history window (docs/design-v1-log-history.md 5.3 and
 * 5.5): bounded, never merged from a stale or foreign answer, and an empty
 * page never takes a readable window away.
 */

function line(id: string): LogEntry {
  return { id, at: "2026-10-30T19:00:00.000Z", kind: "chat", from: "m1", text: id };
}

/** A server's GET /log over `archive`, by design 2.2's table: exclusive bounds, oldest first. */
function serve(archive: readonly LogEntry[], ask: PageAsk, limit: number): HistoryPage {
  let got: LogEntry[];
  let forward = false;
  if (ask.after !== undefined) {
    forward = true;
    got = archive.filter((e) => compareLogIds(e.id, ask.after!) > 0).slice(0, limit);
  } else {
    const older = ask.before === undefined ? [...archive] : archive.filter((e) => compareLogIds(e.id, ask.before!) < 0);
    got = older.slice(Math.max(0, older.length - limit));
  }
  if (got.length === 0) return { entries: [], nextBefore: null, nextAfter: null };
  const full = got.length === limit;
  const lo = got[0]!.id;
  const hi = got[got.length - 1]!.id;
  return forward ? { entries: got, nextBefore: lo, nextAfter: full ? hi : null } : { entries: got, nextBefore: full ? lo : null, nextAfter: hi };
}

type Call = { ask: PageAsk; signal: AbortSignal; key: string; resolve(page: HistoryPage): void; reject(err: unknown): void; page: HistoryPage };

/** A seeded PRNG (mulberry32), so a failing seed replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the Log panel's history window", () => {
  test("a randomized run of pages, live lines, aborts, late answers and viewer changes keeps every invariant", async () => {
    // What the runs met, so a change that stops them meeting a case fails here rather than passing on nothing.
    const met = { parted: 0, jumped: 0, late: 0, empty: 0, held: 0, dropped: 0, start: 0, end: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      // Each viewer reads its own lines of one room's stream, so a reply for one never fits another.
      const viewers = [
        { key: "room|dm|dm|s1|", reads: () => true, ring: 1 + Math.floor(random() * 620) },
        { key: "room|p1|player||", reads: (seq: number) => seq % 3 !== 0, ring: 1 + Math.floor(random() * 220) },
        { key: "room|dm|dm||p1", reads: (seq: number) => seq % 5 === 0, ring: 1 + Math.floor(random() * 60) },
      ].map((v) => ({ ...v, archive: [] as LogEntry[], place: new Map<string, number>() }));
      type Viewer = (typeof viewers)[number];
      const limit = pick([1, 3, 50, 50, 100]);
      let seq = 0;
      const grow = (ops: number) => {
        for (let i = 0; i < ops; i++) {
          seq++;
          const n = random() < 0.2 ? 1 + Math.floor(random() * 3) : 1;
          for (let j = 0; j < n; j++) {
            const entry = line(`${seq}:${j}`);
            for (const v of viewers) {
              if (!v.reads(seq)) continue;
              v.place.set(entry.id, v.archive.length);
              v.archive.push(entry);
            }
          }
        }
      };
      grow(Math.floor(random() * 1800));
      const liveOf = (v: Viewer) => v.archive.slice(Math.max(0, v.archive.length - v.ring));

      let viewer = viewers[0]!;
      const calls: Call[] = [];
      let moves = 0;
      const win = new HistoryWindow({
        key: viewer.key,
        beforeMove: (why) => {
          if (why === "page") moves++;
        },
        fetch: (ask, signal) => {
          assert.equal(calls.filter((c) => !c.signal.aborted).length, 0, `seed ${seed}: a second page while one is on its way`);
          // The server reads at the moment it is asked, for whoever asked.
          const page = serve(viewer.archive, ask, limit);
          return new Promise<HistoryPage>((resolve, reject) => calls.push({ ask, signal, key: viewer.key, resolve, reject, page }));
        },
      });
      let main = liveOf(viewer);
      let extra = 0;
      const sync = () => win.sync(viewer.key, main, main.length + extra);
      sync();

      const shown = (s: HistoryState) => (s.mode === "live" ? mergeLog(s.rows, main) : [...s.rows]);
      const check = (step: number, what: string) => {
        const s = win.state;
        const at = `seed ${seed} step ${step} (${what})`;
        assert.equal(s.key, viewer.key, `${at}: window for another viewer`);
        const ids = s.rows.map((e) => e.id);
        for (let i = 1; i < ids.length; i++) assert.ok(compareLogIds(ids[i - 1]!, ids[i]!) < 0, `${at}: rows out of order or twice: ${ids[i - 1]} ${ids[i]}`);
        if (s.mode === "history") assert.ok(s.rows.length <= HISTORY_ROWS, `${at}: ${s.rows.length} rows held`);
        else {
          assert.ok(s.rows.length + main.length + extra <= Math.max(HISTORY_ROWS, main.length + extra), `${at}: ${s.rows.length} rows above ${main.length + extra} live`);
          const live = new Set(main.map((e) => e.id));
          assert.ok(s.rows.every((e) => !live.has(e.id)), `${at}: a row held twice beside the live log`);
        }
        // Everything drawn is one unbroken run of this viewer's readable lines: no stale or foreign page merged in.
        const drawn = shown(s);
        const places = drawn.map((e) => viewer.place.get(e.id) ?? -1);
        assert.ok(places.every((p) => p >= 0), `${at}: a line this viewer cannot read`);
        for (let i = 1; i < places.length; i++) {
          if (places[i] !== places[i - 1]! + 1) assert.fail(`${at}: a gap between ${drawn[i - 1]!.id} and ${drawn[i]!.id}`);
        }
        // The start is said only where it is: the oldest line this viewer may read is drawn.
        if (s.start) assert.equal(places[0], 0, `${at}: "This is the start of the log." with older lines readable`);
        if (s.mode === "history") {
          assert.equal(s.before, s.rows[0]?.id, `${at}: older edge`);
          assert.equal(s.after, s.rows[s.rows.length - 1]?.id, `${at}: newer edge`);
        }
      };

      for (let step = 0; step < 400; step++) {
        const r = random();
        let what: string;
        if (r < 0.2) {
          what = "older";
          win.older();
        } else if (r < 0.32) {
          what = "newer";
          win.newer();
        } else if (r < 0.36) {
          what = "latest";
          win.latest();
        } else if (r < 0.4) {
          what = "viewer";
          viewer = pick(viewers);
          main = liveOf(viewer);
          sync();
        } else if (r < 0.58) {
          // New lines, now and then more than the ring holds at once, as after a long time offline.
          const n = random() < 0.04 ? viewer.ring + 1 + Math.floor(random() * 40) : 1 + Math.floor(random() * 3);
          what = `grow ${n}`;
          const was = win.state;
          grow(n);
          main = liveOf(viewer);
          sync();
          if (was.mode === "live" && win.state.mode === "history") met.jumped++;
          if (was.mode === "live" && win.state.before !== was.before && was.before !== null) met.dropped++;
        } else if (r < 0.62) {
          what = "trap lines";
          extra = Math.floor(random() * 6);
          sync();
        } else if (calls.length > 0) {
          const i = Math.floor(random() * calls.length);
          const call = calls.splice(i, 1)[0]!;
          if (random() < 0.15) {
            what = `fail ${JSON.stringify(call.ask)}`;
            call.reject(random() < 0.5 ? new ApiError(429, "busy", "busy", 1000) : new ApiError(0, "x", "network", null));
            await flush();
          } else {
            // A late answer still arrives: an aborted fetch whose reply was already on its way.
            what = `answer ${JSON.stringify(call.ask)}${call.signal.aborted ? " late" : ""}${call.key !== viewer.key ? " foreign" : ""}`;
            const was = win.state;
            const dir = call.ask.after !== undefined ? "newer" : "older";
            const edge = dir === "older" ? shown(was)[0]?.id : was.rows[was.rows.length - 1]?.id;
            const movedBefore = moves;
            call.resolve(call.page);
            await flush();
            const now = win.state;
            if (call.signal.aborted) met.late++;
            if (call.page.entries.length === 0 && !call.signal.aborted) met.empty++;
            if (was.mode === "live" && now.mode === "history") met.parted++;
            if (now.rows.length === HISTORY_ROWS) met.held++;
            if (!was.start && now.start) met.start++;
            if (!was.end && now.end) met.end++;
            if (moves > movedBefore && edge !== undefined) {
              // The row the reader was on, where the window grew, is still drawn.
              assert.ok(shown(now).some((e) => e.id === edge), `seed ${seed} step ${step}: lost the anchor ${edge}`);
            }
            if (call.page.entries.length === 0) {
              assert.equal(now.rows, was.rows, `seed ${seed} step ${step}: an empty page changed the window`);
              assert.equal(now.mode, was.mode, `seed ${seed} step ${step}: an empty page changed the mode`);
            }
            if (call.signal.aborted || call.key !== viewer.key) assert.equal(now.rows, was.rows, `seed ${seed} step ${step}: a late or foreign answer merged`);
          }
        } else what = "idle";
        check(step, what);
      }
      win.dispose();
    }
    for (const [name, n] of Object.entries(met)) assert.ok(n > 0, `the runs never met "${name}": ${JSON.stringify(met)}`);
  });

  test("an empty older page keeps the rows and the way back, and ends only that direction", async () => {
    const archive = Array.from({ length: 12 }, (_, i) => line(`${i + 1}:0`));
    const main = archive.slice(-2);
    const answers: { resolve(page: HistoryPage): void; ask: PageAsk }[] = [];
    const win = new HistoryWindow({ key: "k", fetch: (ask) => new Promise((resolve) => answers.push({ resolve, ask })) });
    win.sync("k", main, 2);
    win.older();
    assert.deepEqual(answers[0]!.ask, { before: "11:0" });
    answers[0]!.resolve(serve(archive, answers[0]!.ask, 10));
    await flush();
    assert.equal(win.state.rows.length, 10);
    assert.equal(win.state.start, false, "a full page offers another");
    win.older();
    assert.deepEqual(answers[1]!.ask, { before: "1:0" });
    const rows = win.state.rows;
    answers[1]!.resolve({ entries: [], nextBefore: null, nextAfter: null });
    await flush();
    assert.equal(win.state.rows, rows);
    assert.equal(win.state.start, true);
    assert.equal(win.state.said, "You reached the start of the log.");
  });

  test("an empty live log asks for the newest page", async () => {
    const archive = Array.from({ length: 5 }, (_, i) => line(`${i + 1}:0`));
    const asks: PageAsk[] = [];
    const win = new HistoryWindow({ key: "k", fetch: async (ask) => (asks.push(ask), serve(archive, ask, 3)) });
    win.sync("k", [], 0);
    win.older();
    await flush();
    assert.deepEqual(asks, [{}]);
    assert.deepEqual(win.state.rows.map((e) => e.id), ["3:0", "4:0", "5:0"]);
    win.older();
    await flush();
    assert.deepEqual(asks[1], { before: "3:0" });
    assert.deepEqual(win.state.rows.map((e) => e.id), ["1:0", "2:0", "3:0", "4:0", "5:0"]);
    assert.equal(win.state.start, true, "a short page is the start");
  });

  test("the window holds 500 rows, parts from the live log past them, and pages newer and back", async () => {
    const archive = Array.from({ length: 1200 }, (_, i) => line(`${i + 1}:0`));
    const main = archive.slice(-100);
    const win = new HistoryWindow({ key: "k", fetch: async (ask) => serve(archive, ask, 100) });
    win.sync("k", main, 100);
    for (let i = 0; i < 4; i++) {
      win.older();
      await flush();
    }
    assert.equal(win.state.mode, "live", "400 rows over 100 live still fit");
    assert.equal(win.state.rows.length, 400);
    win.older();
    await flush();
    assert.equal(win.state.mode, "history", "one more page parts the window from the live log");
    assert.equal(win.state.rows.length, HISTORY_ROWS);
    assert.equal(win.state.rows[0]!.id, "601:0");
    assert.equal(win.state.after, "1100:0", "its newest 100 rows went");
    for (let i = 0; i < 3; i++) {
      win.older();
      await flush();
    }
    assert.equal(win.state.rows.length, HISTORY_ROWS);
    assert.deepEqual([win.state.before, win.state.after], ["301:0", "800:0"]);
    win.newer();
    await flush();
    assert.deepEqual([win.state.before, win.state.after], ["401:0", "900:0"]);
    assert.equal(win.state.start, false);
    win.latest();
    assert.equal(win.state.mode, "live");
    assert.equal(win.state.rows.length, 0);
  });

  test("a short newer page ends that direction, and Show newer then asks nothing", async () => {
    const archive = Array.from({ length: 700 }, (_, i) => line(`${i + 1}:0`));
    const asks: PageAsk[] = [];
    const win = new HistoryWindow({ key: "k", fetch: async (ask) => (asks.push(ask), serve(archive, ask, 100)) });
    win.sync("k", archive.slice(-450), 450);
    win.older();
    await flush();
    assert.equal(win.state.mode, "history");
    assert.equal(win.state.after, "650:0");
    win.newer();
    await flush();
    assert.equal(win.state.end, true, "50 lines of 100 asked is the end");
    assert.equal(win.state.after, "700:0");
    const n = asks.length;
    win.newer();
    assert.equal(asks.length, n);
  });

  test("a page for another viewer, or one answered after Back to latest, never merges", async () => {
    const archive = Array.from({ length: 30 }, (_, i) => line(`${i + 1}:0`));
    const answers: { resolve(page: HistoryPage): void; signal: AbortSignal }[] = [];
    const win = new HistoryWindow({ key: "a", fetch: (_ask, signal) => new Promise((resolve) => answers.push({ resolve, signal })) });
    win.sync("a", archive.slice(-5), 5);
    win.older();
    win.sync("b", archive.slice(-3), 3);
    assert.equal(answers[0]!.signal.aborted, true, "a new viewer aborts the old one's page");
    answers[0]!.resolve(serve(archive, { before: "26:0" }, 10));
    await flush();
    assert.equal(win.state.rows.length, 0);
    assert.equal(win.state.loading, null);
  });

  test("a page the live log outran is dropped and the button armed again", async () => {
    const archive = Array.from({ length: 700 }, (_, i) => line(`${i + 1}:0`));
    const answers: { resolve(page: HistoryPage): void }[] = [];
    const win = new HistoryWindow({ key: "k", fetch: () => new Promise((resolve) => answers.push({ resolve })) });
    let main = archive.slice(0, 450);
    win.sync("k", main, 450);
    win.older();
    win.older();
    assert.equal(answers.length, 1, "one page at a time");
    // 60 new lines over a ring of 450 push the kept rows past the 500 the panel holds.
    main = archive.slice(60, 510);
    win.sync("k", main, 450);
    assert.equal(win.state.before, "11:0");
    answers[0]!.resolve({ entries: [], nextBefore: null, nextAfter: null });
    await flush();
    assert.equal(win.state.start, false, "an answer from an edge that moved ends nothing");
    assert.equal(win.state.loading, null);
  });

  test("a page asked while the live log drops lines off its front still lands, beside the lines it dropped", async () => {
    const archive = Array.from({ length: 40 }, (_, i) => line(`${i + 1}:0`));
    const answers: { resolve(page: HistoryPage): void; ask: PageAsk }[] = [];
    const win = new HistoryWindow({ key: "k", fetch: (ask) => new Promise((resolve) => answers.push({ resolve, ask })) });
    let main = archive.slice(20, 30);
    win.sync("k", main, 10);
    win.older();
    main = archive.slice(25, 35);
    win.sync("k", main, 10);
    answers[0]!.resolve(serve(archive, answers[0]!.ask, 5));
    await flush();
    assert.deepEqual(
      mergeLog(win.state.rows, main).map((e) => e.id),
      archive.slice(15, 35).map((e) => e.id),
    );
  });

  test("an empty newer page keeps the window, and the start goes once newer rows push the oldest out", async () => {
    const archive = Array.from({ length: 700 }, (_, i) => line(`${i + 1}:0`));
    const win = new HistoryWindow({ key: "k", fetch: async (ask) => serve(archive, ask, 100) });
    win.sync("k", archive.slice(-450), 450);
    while (!win.state.start) {
      win.older();
      await flush();
    }
    assert.equal(win.state.mode, "history");
    assert.deepEqual([win.state.before, win.state.after], ["1:0", "500:0"]);
    win.newer();
    await flush();
    assert.equal(win.state.start, false, "the first line is no longer held");
    win.newer();
    await flush();
    assert.equal(win.state.after, "700:0");
    assert.equal(win.state.end, false, "a full page offers another");
    const rows = win.state.rows;
    win.newer();
    await flush();
    assert.equal(win.state.rows, rows);
    assert.equal(win.state.mode, "history");
    assert.equal(win.state.end, true);
    assert.equal(win.state.said, "No newer messages.");
  });

  test("lines a page strays past its bound with, and lines the live log took back, are held once", async () => {
    const archive = Array.from({ length: 30 }, (_, i) => line(`${i + 1}:0`));
    const answers: { resolve(page: HistoryPage): void }[] = [];
    const win = new HistoryWindow({ key: "k", fetch: () => new Promise((resolve) => answers.push({ resolve })) });
    win.sync("k", archive.slice(20), 10);
    win.older();
    // A page with its bound and a line past it, as a server whose bounds were inclusive would send.
    answers[0]!.resolve({ entries: [...archive.slice(15, 21), line("99:0")], nextBefore: "16:0", nextAfter: null });
    await flush();
    assert.deepEqual(win.state.rows.map((e) => e.id), ["16:0", "17:0", "18:0", "19:0", "20:0"]);
    // A fresh snapshot whose live log reaches further back than the page asked from.
    win.older();
    const main = archive.slice(12);
    win.sync("k", main, main.length);
    answers[1]!.resolve(serve(archive, { before: "16:0" }, 5));
    await flush();
    const held = new Set(main.map((e) => e.id));
    assert.ok(win.state.rows.every((e) => !held.has(e.id)), "a row the live log holds is held twice");
    assert.deepEqual(mergeLog(win.state.rows, main).map((e) => e.id), archive.slice(10).map((e) => e.id));

    // A window apart from the live log never takes a stray line from past its other end.
    const long = Array.from({ length: 800 }, (_, i) => line(`${i + 1}:0`));
    const later: { resolve(page: HistoryPage): void }[] = [];
    const apart = new HistoryWindow({ key: "k", fetch: () => new Promise((resolve) => later.push({ resolve })) });
    apart.sync("k", long.slice(-490), 490);
    apart.older();
    later[0]!.resolve(serve(long, { before: "311:0" }, 50));
    await flush();
    assert.equal(apart.state.mode, "history");
    apart.older();
    later[1]!.resolve({ entries: [long[200]!, long[790]!], nextBefore: "201:0", nextAfter: "791:0" });
    await flush();
    assert.deepEqual([apart.state.before, apart.state.after, apart.state.rows.length], ["201:0", "759:0", 500]);
  });

  test("a failure keeps the rows, and 404 says the server has no archive route", async () => {
    const win = new HistoryWindow({ key: "k", fetch: async () => Promise.reject(new ApiError(404, "Not found.", undefined, null)) });
    win.sync("k", [line("5:0")], 1);
    win.older();
    await flush();
    assert.equal(win.state.unavailable, true);
    const busy = new HistoryWindow({ key: "k", fetch: async () => Promise.reject(new ApiError(429, "x", "busy", 1000)) });
    busy.sync("k", [line("5:0")], 1);
    busy.older();
    await flush();
    assert.equal(busy.state.failed?.dir, "older");
    assert.equal(busy.state.loading, null);
  });
});
