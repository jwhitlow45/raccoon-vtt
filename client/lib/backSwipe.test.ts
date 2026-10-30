import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TAP_SLOP_PX } from "./gestures.ts";
import { REPEAT_DELAY_MS } from "./holdRepeat.ts";
import { backDistance, backEnd, BackSession, BackSwipe, EDGE_ZONE_PX, inEdgeZone, ownsSideways, SIDEWAYS_ATTR, type BackHost, type BackMove, type BackStart, type SidewaysNode, type SidewaysStyle } from "./backSwipe.ts";
import { FLICK_SPEED, SLIDE_MS, UNSAVED_FOLLOW } from "./sheetSwipe.ts";

function start(over: Partial<BackStart> = {}): BackStart {
  return { owned: false, fingers: 1, at: 0, width: 375, scale: 1, ...over };
}

function move(dx: number, dy: number, at: number, over: Partial<BackMove> = {}): BackMove {
  return { dx, dy, at, cancelable: true, taken: false, ...over };
}

/** Moves right by each step, 30 ms apart, as the e2e's slow drag, with `dy` drifting alongside. */
function drag(swipe: BackSwipe, dxs: readonly number[], opts: { dy?: number; every?: number; from?: number; cancelable?: boolean } = {}) {
  const every = opts.every ?? 30;
  let at = opts.from ?? 0;
  return dxs.map((dx) => {
    at += every;
    return swipe.move(move(dx, opts.dy ?? 0, at, { cancelable: opts.cancelable ?? true }));
  });
}

function ramp(to: number, step = 10): number[] {
  const out: number[] = [];
  const sign = Math.sign(to);
  for (let d = step; d < Math.abs(to); d += step) out.push(sign * d);
  out.push(to);
  return out;
}

// ------------------------------------------------------------ 1. the lock

describe("1. the first move past the slop locks the axis", () => {
  test("inside the slop nothing moves, and a lift there is a tap", () => {
    const s = new BackSwipe();
    assert.equal(s.start(start()), true);
    for (const step of drag(s, [2, 5, TAP_SLOP_PX])) assert.deepEqual(step, { cancel: false, position: null, press: false });
    assert.deepEqual(s.end(120), { end: "tap", cancel: false });
  });

  test("more right than up or down claims at once, and the page starts from its place", () => {
    const s = new BackSwipe();
    s.start(start());
    const [first] = drag(s, [12], { dy: 11 });
    assert.deepEqual(first, { cancel: true, position: 12 - TAP_SLOP_PX, press: true });
    assert.equal(s.phase, "claimed");
  });

  test("a tie goes to the vertical side, the sheet's own, and so does a start more up or down", () => {
    for (const [dx, dy] of [
      [10, 10],
      [10, -10],
      [6, 9],
      [3, -12],
    ] as const) {
      const s = new BackSwipe();
      s.start(start());
      assert.deepEqual(s.move(move(dx, dy, 30)), { cancel: false, position: null, press: false }, `${dx}, ${dy}`);
      assert.equal(s.phase, "free", `${dx}, ${dy}`);
    }
  });

  test("a vertical start stays vertical for the whole touch, however far right it then goes", () => {
    const s = new BackSwipe();
    s.start(start());
    drag(s, [0, 0], { dy: 12 });
    for (const step of drag(s, ramp(300), { from: 60 })) assert.equal(step.cancel, false);
    assert.equal(s.end(400).end, null);
  });

  test("a start to the left is never a back, however far right it then goes", () => {
    const s = new BackSwipe();
    s.start(start());
    s.move(move(-12, 0, 30));
    for (const step of drag(s, ramp(300), { from: 30 })) assert.equal(step.cancel, false);
    assert.equal(s.end(400).end, null);
  });

  test("a move the browser can no longer cancel, as once it scrolls, leaves the touch to it", () => {
    const s = new BackSwipe();
    s.start(start());
    assert.equal(drag(s, [20], { cancelable: false })[0]!.cancel, false);
    assert.equal(drag(s, ramp(300), { from: 30 }).some((step) => step.cancel), false);
    assert.equal(s.end(400).end, null);
  });

  test(`a press held still for ${REPEAT_DELAY_MS} ms before it moves is a hold, never a swipe`, () => {
    const s = new BackSwipe();
    s.start(start());
    s.move(move(3, 0, REPEAT_DELAY_MS - 50));
    assert.equal(s.move(move(30, 0, REPEAT_DELAY_MS)).cancel, false);
    assert.equal(s.end(REPEAT_DELAY_MS + 100).end, null);
    const quick = new BackSwipe();
    quick.start(start());
    assert.equal(quick.move(move(30, 0, REPEAT_DELAY_MS - 1)).press, true);
  });

  test("an owned start, or two fingers, is never followed", () => {
    for (const over of [{ owned: true }, { fingers: 2 }]) {
      const s = new BackSwipe();
      assert.equal(s.start(start(over)), false);
      assert.equal(drag(s, ramp(300)).some((step) => step.cancel), false);
      assert.equal(s.end(400).end, null);
    }
  });

  test("a move another listener cancelled first, as a roll button's fired hold does, takes the finger for good", () => {
    const s = new BackSwipe();
    s.start(start());
    assert.deepEqual(s.move(move(20, 0, 600, { taken: true })), { cancel: false, position: null, press: false });
    assert.equal(drag(s, ramp(300), { from: 600 }).some((step) => step.cancel), false);
    assert.equal(s.end(1000).end, null);
  });
});

// ------------------------------------------------------------ 2. following and the release

describe("2. the page follows the finger, and the release decides", () => {
  test("it follows the finger's travel past the slop, never left of its place, and up and down never move it", () => {
    const s = new BackSwipe();
    s.start(start());
    drag(s, [20]);
    assert.equal(s.move(move(100, 80, 60)).position, 100 - TAP_SLOP_PX);
    assert.equal(s.move(move(-50, -40, 90)).position, 0);
  });

  test("unsaved input follows at half, and never goes back", () => {
    const s = new BackSwipe();
    s.start(start());
    drag(s, [20]);
    assert.equal(s.claimed(true), (20 - TAP_SLOP_PX) * UNSAVED_FOLLOW);
    drag(s, ramp(330), { from: 30 });
    assert.equal(s.position, (330 - TAP_SLOP_PX) * UNSAVED_FOLLOW);
    assert.deepEqual(s.end(400), { end: "rest", cancel: true });
  });

  test("a slow release goes back past half the panel's width, and springs back short of it", () => {
    const width = 375;
    const half = backDistance(width, 1);
    assert.equal(half, width / 2);
    for (const [to, end] of [
      [half + TAP_SLOP_PX + 1, "back"],
      [half + TAP_SLOP_PX - 1, "rest"],
    ] as const) {
      const s = new BackSwipe();
      s.start(start({ width }));
      drag(s, ramp(to));
      assert.deepEqual(s.end(30 * ramp(to).length + 1), { end, cancel: true }, `${to}`);
    }
  });

  test("never for less than one touch target at the interface size, on a narrow panel", () => {
    assert.equal(backDistance(60, 1), 44);
    assert.equal(backDistance(60, 1.3), 44 * 1.3);
    assert.equal(backEnd({ position: 43, speed: 0, width: 60, scale: 1, unsaved: false }), "rest");
    assert.equal(backEnd({ position: 44, speed: 0, width: 60, scale: 1, unsaved: false }), "back");
  });

  test("a flick right goes back once past half a touch target, and a flick left springs back from anywhere", () => {
    assert.equal(backEnd({ position: 22, speed: FLICK_SPEED, width: 375, scale: 1, unsaved: false }), "back");
    assert.equal(backEnd({ position: 21, speed: 5, width: 375, scale: 1, unsaved: false }), "rest");
    assert.equal(backEnd({ position: 300, speed: -FLICK_SPEED, width: 375, scale: 1, unsaved: false }), "rest");
    assert.equal(backEnd({ position: 300, speed: 5, width: 375, scale: 1, unsaved: true }), "rest");
    // The finger's own flick, 10 px every 2 ms.
    const s = new BackSwipe();
    s.start(start());
    drag(s, ramp(50), { every: 2 });
    assert.equal(s.end(12).end, "back");
  });

  test("a flick back to the left at the end of a long drag springs back", () => {
    const s = new BackSwipe();
    s.start(start());
    let at = 0;
    for (const dx of ramp(300)) s.move(move(dx, 0, (at += 30)));
    for (const dx of [280, 260, 240, 220]) s.move(move(dx, 0, (at += 2)));
    assert.equal(s.end(at + 1).end, "rest");
  });

  test("a cancel ends nothing, and a claimed touch's later moves and lift stay cancelled", () => {
    const s = new BackSwipe();
    s.start(start());
    drag(s, ramp(300));
    assert.equal(s.cancel(), true);
    assert.equal(s.move(move(310, 0, 400)).cancel, true);
    assert.deepEqual(s.end(500), { end: null, cancel: true });
  });
});

// ------------------------------------------------------------ 3. the session

class FakePage {
  backs = 0;
  keeps = false;
  presses = 0;
  watching = false;
  unsavedNow = false;
  last: { x: number | null; ease: boolean } | null = null;
  xs: number[] = [];
  eased = 0;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  private now = 0;
  readonly host: BackHost;

  constructor(opts: { reduced?: boolean } = {}) {
    this.host = {
      place: (x, ease) => {
        this.last = { x, ease };
        if (x !== null) this.xs.push(x);
        if (ease) this.eased++;
      },
      watch: (on) => {
        assert.notEqual(this.watching, on, "a watch asked twice");
        this.watching = on;
      },
      takePress: () => void this.presses++,
      later: (ms, fn) => {
        const timer = { at: this.now + ms, fn, live: true };
        this.timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
      back: () => {
        this.backs++;
        return !this.keeps;
      },
      reducedMotion: () => opts.reduced ?? false,
      unsaved: () => this.unsavedNow,
    };
  }

  tick(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      this.now = next.at;
      next.fn();
    }
    this.now = until;
    this.timers = this.timers.filter((t) => t.live);
  }

  settle(): void {
    for (let i = 0; i < 20 && this.pending; i++) this.tick(SLIDE_MS);
  }

  get pending(): boolean {
    return this.timers.some((t) => t.live);
  }

  get atRest(): boolean {
    return this.last === null || this.last.x === null;
  }
}

/** One touch through a session: down, right by `to` in 10 px steps, up. */
function stroke(session: BackSession, to: number, opts: { every?: number; over?: Partial<BackStart> } = {}): boolean {
  const every = opts.every ?? 30;
  if (!session.begin(start(opts.over))) return false;
  let at = 0;
  for (const dx of ramp(to)) session.move(move(dx, 0, (at += every)));
  session.end(at + 1);
  return true;
}

describe("3. the session slides, goes back and springs back", () => {
  test("past the distance it slides out to the panel's width, then goes back once and rests", () => {
    const page = new FakePage();
    const session = new BackSession(page.host);
    stroke(session, 250);
    assert.equal(page.presses, 1, "the claim cancels the press under the finger");
    assert.deepEqual(page.last, { x: 375, ease: true });
    assert.equal(page.backs, 0, "it goes back only once the slide is over");
    page.tick(SLIDE_MS);
    assert.equal(page.backs, 1);
    assert.ok(page.atRest);
    page.settle();
    assert.equal(page.backs, 1);
  });

  test("short of it the page springs back, going nowhere", () => {
    const page = new FakePage();
    const session = new BackSession(page.host);
    stroke(session, 100);
    assert.deepEqual(page.last, { x: 0, ease: true });
    page.settle();
    assert.equal(page.backs, 0);
    assert.ok(page.atRest);
  });

  test("with reduced motion it goes back or rests at the lift, with no slide", () => {
    const page = new FakePage({ reduced: true });
    const session = new BackSession(page.host);
    stroke(session, 250);
    assert.equal(page.backs, 1);
    assert.ok(page.atRest);
    assert.equal(page.pending, false);
    stroke(session, 100);
    assert.equal(page.backs, 1);
    assert.ok(page.atRest);
  });

  test("a page its owner keeps, asking Discard changes? first, springs back", () => {
    const page = new FakePage();
    page.keeps = true;
    const session = new BackSession(page.host);
    stroke(session, 250);
    page.tick(SLIDE_MS);
    assert.equal(page.backs, 1);
    assert.deepEqual(page.last, { x: 0, ease: true });
    page.settle();
    assert.ok(page.atRest);
  });

  test("a new touch during the slide out goes back at once and is not followed, and one during a spring back rests and is", () => {
    const page = new FakePage();
    const session = new BackSession(page.host);
    stroke(session, 250);
    assert.equal(session.begin(start()), false);
    assert.equal(page.backs, 1);
    assert.ok(page.atRest);
    assert.equal(page.pending, false);
    stroke(session, 100);
    assert.equal(session.begin(start()), true);
    assert.ok(page.atRest);
    assert.equal(page.backs, 1);
  });

  test("a new page mid-slide, or mid-drag, stops it at rest and drops the back", () => {
    const page = new FakePage();
    const session = new BackSession(page.host);
    stroke(session, 250);
    session.stop();
    page.settle();
    assert.equal(page.backs, 0);
    assert.ok(page.atRest);
    session.begin(start());
    session.move(move(100, 0, 30));
    session.stop();
    assert.ok(page.atRest);
    assert.equal(session.move(move(200, 0, 60)), true, "the claimed touch's moves stay cancelled");
    session.end(90);
    page.settle();
    assert.equal(page.backs, 0);
  });

  test("a second finger, or a move taken from under the claim, springs it back and goes nowhere", () => {
    for (const how of ["cancel", "taken"] as const) {
      const page = new FakePage();
      const session = new BackSession(page.host);
      session.begin(start());
      let at = 0;
      for (const dx of ramp(250)) session.move(move(dx, 0, (at += 30)));
      if (how === "cancel") session.cancel();
      else session.move(move(260, 0, (at += 30), { taken: true }));
      assert.deepEqual(page.last, { x: 0, ease: true }, how);
      session.end(at + 1);
      page.settle();
      assert.equal(page.backs, 0, how);
      assert.ok(page.atRest, how);
    }
  });

  test("the document is watched from a followed press until the last finger lifts", () => {
    const page = new FakePage();
    const session = new BackSession(page.host);
    assert.equal(session.begin(start({ owned: true })), false);
    assert.equal(page.watching, false);
    session.begin(start());
    assert.equal(page.watching, true);
    session.end(10);
    session.lifted();
    assert.equal(page.watching, false);
  });
});

// ------------------------------------------------------------ 4. the DOM reads

type Fake = SidewaysNode & { style: { touchAction: string; overflowX: string }; attrs: Map<string, string> };

function el(tag: string, parent: Fake | null, opts: Partial<Pick<Fake, "scrollLeft" | "scrollWidth" | "clientWidth" | "isContentEditable">> & { attrs?: Record<string, string>; touchAction?: string; overflowX?: string } = {}): Fake {
  const attrs = new Map(Object.entries(opts.attrs ?? {}));
  return {
    tagName: tag.toUpperCase(),
    parentElement: parent,
    hasAttribute: (name: string) => attrs.has(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    isContentEditable: opts.isContentEditable,
    scrollLeft: opts.scrollLeft ?? 0,
    scrollWidth: opts.scrollWidth ?? 100,
    clientWidth: opts.clientWidth ?? 100,
    style: { touchAction: opts.touchAction ?? "auto", overflowX: opts.overflowX ?? "visible" },
    attrs,
  };
}

const css: SidewaysStyle = (n) => (n as Fake).style;

describe("4. what takes a sideways drag itself", () => {
  const surface = el("dialog", null, { touchAction: "none" });
  const page = el("section", surface);
  const header = el("header", page, { touchAction: "pinch-zoom" });
  const back = el("button", header);
  const body = el("div", page, { overflowX: "auto", scrollWidth: 340, clientWidth: 340 });
  const row = el("button", body);

  test("plain content, the header and its buttons are the panel's: the walk stops below the surface", () => {
    for (const n of [page, header, back, body, row]) assert.equal(ownsSideways(n, surface, css), false, n.tagName);
    assert.equal(ownsSideways(null, surface, css), false);
  });

  test("a scroller that can scroll left keeps the swipe, and one at its left edge hands it over", () => {
    for (const [left, owns] of [
      [0, false],
      [0.5, false],
      [-3, false],
      [1, true],
      [120, true],
    ] as const) {
      const strip = el("div", body, { overflowX: "auto", scrollWidth: 600, clientWidth: 340, scrollLeft: left });
      const chip = el("button", el("span", strip));
      assert.equal(ownsSideways(chip, surface, css), owns, `scrollLeft ${left}`);
    }
    // One that scrolls but has nothing more to show, or clips without scrolling, is not a scroller.
    assert.equal(ownsSideways(el("div", body, { overflowX: "auto", scrollWidth: 340, clientWidth: 340, scrollLeft: 5 }), surface, css), false);
    assert.equal(ownsSideways(el("div", body, { overflowX: "hidden", scrollWidth: 600, clientWidth: 340, scrollLeft: 40 }), surface, css), false);
    assert.equal(ownsSideways(el("div", body, { overflowX: "scroll", scrollWidth: 600, clientWidth: 340, scrollLeft: 40 }), surface, css), true);
  });

  test("fields own their touches, a checkbox does not", () => {
    for (const [n, owns] of [
      [el("input", body, { attrs: { type: "range" } }), true],
      [el("input", body, { attrs: { type: "text" } }), true],
      [el("input", body), true],
      [el("input", body, { attrs: { type: "number" } }), true],
      [el("textarea", body), true],
      [el("select", body), true],
      [el("div", body, { isContentEditable: true }), true],
      [el("input", body, { attrs: { type: "checkbox" } }), false],
      [el("input", body, { attrs: { type: "button" } }), false],
    ] as const) {
      assert.equal(ownsSideways(n, surface, css), owns, `${n.tagName} ${n.getAttribute("type")}`);
    }
  });

  test("a handle that reads its own moves, a sideways-only pan, a mark and a roll's mode menu own them", () => {
    for (const [n, owns] of [
      [el("div", body, { touchAction: "none" }), true],
      [el("div", body, { touchAction: "pan-x" }), true],
      [el("div", body, { touchAction: "pan-x pinch-zoom" }), true],
      [el("div", body, { touchAction: "pan-y" }), false],
      [el("div", body, { touchAction: "pan-x pan-y" }), false],
      [el("div", body, { touchAction: "manipulation" }), false],
      [el("div", body, { attrs: { [SIDEWAYS_ATTR]: "" } }), true],
      [el("div", body, { attrs: { "data-roll-mode-menu": "" } }), true],
    ] as const) {
      assert.equal(ownsSideways(el("span", n), surface, css), owns, `${n.style.touchAction} ${[...n.attrs.keys()].join(" ")}`);
    }
  });

  test("the system's edge zone is the first 24 px from the screen's left edge", () => {
    assert.equal(EDGE_ZONE_PX, 24);
    assert.equal(inEdgeZone(0), true);
    assert.equal(inEdgeZone(23.5), true);
    assert.equal(inEdgeZone(24), false);
    assert.equal(inEdgeZone(200), false);
  });
});

// ------------------------------------------------------------ 5. randomized

/** A small seeded generator, so a failure names a sequence that can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("5. randomized touches", () => {
  test("the invariants hold after every event of many random sequences", () => {
    const RUNS = 2000;
    // What the sequences reached, so a generator that stopped reaching an end fails rather than passing on nothing.
    const reached = { backs: 0, flickBacks: 0, rests: 0, taps: 0, claims: 0, kept: 0, cutShort: 0, stoppedSlides: 0, taken: 0, cancels: 0, holds: 0, vertical: 0, owned: 0, scrolls: 0 };
    for (let run = 1; run <= RUNS; run++) {
      const rnd = random(run);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const reduced = rnd() < 0.15;
      const page = new FakePage({ reduced });
      page.keeps = rnd() < 0.1;
      const session = new BackSession(page.host);
      const where = `run ${run}`;
      /** Backs by the touch whose release started them: the last touch to end. */
      const backsBy = new Map<number, number>();
      /** Touches whose release may go back, by every rule below. */
      const mayBack = new Set<number>();
      let owner = -1;
      let backsSeen = 0;
      const tally = () => {
        if (page.backs === backsSeen) return false;
        backsBy.set(owner, (backsBy.get(owner) ?? 0) + page.backs - backsSeen);
        assert.ok(mayBack.has(owner), `${where}: touch ${owner} went back though it could not`);
        backsSeen = page.backs;
        return true;
      };
      for (let touchNo = 0; touchNo < 8; touchNo++) {
        const s = start({ owned: rnd() < 0.15, fingers: rnd() < 0.08 ? 2 : 1, width: pick([320, 375, 390, 430]), scale: pick([0.85, 1, 1.3]) });
        page.unsavedNow = rnd() < 0.15;
        const pressesBefore = page.presses;
        const followed = session.begin(s);
        // A touch that lands as a slide out ends goes back with it, onto what that leaves: never followed on the page that went.
        if (tally() && !page.keeps) assert.equal(followed, false, `${where}: a touch on a page that went back was followed`);
        if (s.owned) reached.owned++;
        let at = 0;
        let dx = 0;
        let dy = 0;
        let firstPast: "right" | "other" | null = null;
        let heldFirst = false;
        let claimedAt: number | null = null;
        let unsavedAtClaim = false;
        /** The browser scrolled: it had a move past the slop that the page did not cancel, or could not, and something under the finger to scroll. */
        let scrolled = false;
        const scrollable = rnd() < 0.7;
        let spoiled = false;
        const steps = 1 + Math.floor(rnd() * 25);
        const drift = pick([-12, -3, 3, 12, 20]);
        const every = pick([2, 5, 16, 30]);
        for (let i = 0; i < steps; i++) {
          const roll = rnd();
          if (roll < 0.03) {
            session.cancel();
            spoiled = true;
            reached.cancels++;
          } else if (roll < 0.05) {
            session.stop();
            spoiled = true;
          } else if (roll < 0.07) {
            page.unsavedNow = !page.unsavedNow;
          } else {
            at += rnd() < 0.05 ? pick([120, 450]) : every;
            dx += Math.round((rnd() - 0.4) * pick([4, 16, 60]) + drift);
            dy += Math.round((rnd() - 0.5) * pick([2, 10, 40, 120]));
            const taken = rnd() < 0.03;
            if (taken) {
              spoiled = true;
              reached.taken++;
            }
            // As a browser does: once it scrolls, no later move can be cancelled. Before that a move may come uncancelable, as a fling's can.
            const cancelable = !scrolled && (claimedAt !== null || rnd() < 0.9);
            const presses = page.presses;
            const cancel = session.move(move(dx, dy, at, { cancelable, taken }));
            if (page.presses > presses) {
              claimedAt = i;
              unsavedAtClaim = page.unsavedNow;
            }
            if (cancel && claimedAt === null) assert.fail(`${where}: a move was cancelled before the claim`);
            if (!followed) assert.equal(cancel, false, `${where}: a touch that may not swipe cancelled a move`);
            if (firstPast === null && Math.hypot(dx, dy) > TAP_SLOP_PX) {
              firstPast = dx > 0 && dx > Math.abs(dy) ? "right" : "other";
              heldFirst = at >= REPEAT_DELAY_MS;
              if (firstPast === "other") reached.vertical++;
              if (heldFirst) reached.holds++;
            }
            if (scrollable && firstPast !== null && !taken && (!cancel || !cancelable)) {
              if (!scrolled) reached.scrolls++;
              scrolled = true;
            }
          }
          // Never left of its place.
          for (const x of page.xs) assert.ok(x >= 0, `${where}: shown left of its place at ${x}`);
          page.xs = [];
          if (rnd() < 0.05) page.tick(pick([1, SLIDE_MS / 2, SLIDE_MS]));
          tally();
        }
        if (claimedAt !== null) reached.claims++;
        assert.equal(page.presses - pressesBefore, claimedAt === null ? 0 : 1, `${where}: the press under the finger is cancelled once, at the claim`);
        // The rules, each from what the touch did rather than from what the machine answered: never both a scroll and a back, never from a vertical or left start, an owned start, two fingers, a hold, a taken finger, a cancel, a new page or unsaved input.
        const blocked = s.owned || s.fingers > 1 || firstPast !== "right" || heldFirst || scrolled || spoiled || unsavedAtClaim;
        if (!blocked) mayBack.add(touchNo);
        const lift = at + pick([0, 1, 5, 60]);
        session.end(lift);
        owner = touchNo;
        if (session.touch.phase !== "idle") assert.fail(`${where}: the touch was left ${session.touch.phase}`);
        if (rnd() < 0.7) session.lifted();
        tally();
        if (claimedAt === null && firstPast === null && followed) reached.taps++;
        // A new page during the slide drops its back.
        if (rnd() < 0.05) {
          if (session.sliding) reached.stoppedSlides++;
          session.stop();
          mayBack.delete(touchNo);
        }
        const wait = pick([0, 1, SLIDE_MS / 2, SLIDE_MS, SLIDE_MS * 2]);
        if (wait > 0) page.tick(wait);
        else if (session.sliding) reached.cutShort++;
        tally();
      }
      session.lifted();
      page.settle();
      tally();
      // At most one back per touch.
      for (const [touchNo, n] of backsBy) assert.ok(n <= 1, `${where}: touch ${touchNo} went back ${n} times`);
      reached.backs += page.backs;
      if (page.keeps) reached.kept += page.backs;
      // Reduced motion never slides.
      if (reduced) assert.equal(page.eased, 0, `${where}: a slide under reduced motion`);
      // Nothing left pending: no slide, no transform, no watch.
      assert.equal(page.pending, false, `${where}: a slide was left running`);
      assert.ok(page.atRest, `${where}: the page was left off its place`);
      assert.equal(page.watching, false, `${where}: the document was left watched`);
      assert.equal(session.sliding, false, `${where}: the session was left sliding`);
    }
    // Whole strokes, slow and flicked, for the end rule's own cases: a flick goes back short of the slow distance, half of 375 px, and a slow stroke short of it rests.
    for (let run = 1; run <= 300; run++) {
      const rnd = random(run * 31);
      const page = new FakePage();
      const session = new BackSession(page.host);
      const flick = rnd() < 0.5;
      const to = 30 + Math.floor(rnd() * 300);
      stroke(session, to, { every: flick ? 2 : 30 });
      page.settle();
      const short = to - TAP_SLOP_PX < 375 / 2;
      assert.equal(page.backs, flick || !short ? 1 : 0, `stroke ${run}: ${to} px, ${flick ? "flicked" : "slow"}`);
      if (flick && short) reached.flickBacks++;
      if (!flick && short) reached.rests++;
    }
    for (const [name, n] of Object.entries(reached)) assert.ok(n > 0, `the sequences never reached ${name}`);
  });
});
