import { chance, int, pick, rng } from "#shared/testutil.ts";
import { Handoff, LAPSE_MS, TAKEOVER_MS, type HandoffAudio, type HandoffPost, type LockApi, type PageKind } from "./handoff.ts";

/*
 * A browser's pages of one room for handoff.random.test.ts: a world of fake
 * time runs every page's timers, the channel's posts and the lock manager's
 * grants as tasks on each page's main thread, which a stall holds back and
 * a freeze stops, while each page's audio renders on by its own clock.
 * A hidden page's timers wake only when its browser's throttling lets them
 * (`Browser`). A stall may start between any two of a page's tasks
 * (`stallSoon`), and releases the tasks that waited in one of the orders a
 * browser may run them (`Release`). A page hears its own posts (`echo`).
 * HANDOFF_TRACE=1 prints what happens, for a failing seed.
 */

/**
 * Whose rules wake a hidden page's timers.
 * - chrome: a hidden page silent for 30 s has its timers checked once a
 *   second, and once hidden 5 minutes, a timer 5 or more deep in a chain
 *   once a minute (developer.chrome.com/blog/timer-throttling-in-chrome-88).
 * - safari: WebKit aligns only a timer nested 10 deep (one-shot) on a
 *   hidden page, to whole seconds while it sounds, otherwise to a grid that
 *   grows with the time it has been hidden (Document::domTimerAlignmentInterval,
 *   Page::updateDOMTimerAlignmentInterval). The growth is an embedder
 *   setting, so this takes the worst case and caps it at 32 s.
 * - firefox: a tab with an AudioContext is not throttled (MDN, setTimeout),
 *   and a page that takes part here always has one.
 */
export type Browser = "chrome" | "safari" | "firefox";

/**
 * The order a stall releases the tasks that waited: "creation" by when
 * each was made (the old world), "ready" by when each became ready, or
 * "posts" or "timers" first, each kind then by when it became ready.
 */
export type Release = "creation" | "ready" | "posts" | "timers";
const RELEASES: readonly Release[] = ["ready", "posts", "timers"];

type Task = {
  at: number;
  seq: number;
  page: number;
  run: () => void;
  timer: boolean;
  grant?: true;
  /** For a timer: when it asked to run, and its nesting (0 when set outside a timer, one more than the timer it was set in). */
  due: number;
  nest: number;
  /** A timer past its throttled wake-up, which waits only for its page's main thread. */
  woke?: true;
  /** When a task that waited out a stall first became ready, for its page's release order. */
  readyAt?: number;
};

type Gate = { on: boolean; until: number };

export class SimPage {
  readonly id: number;
  readonly name: string;
  readonly kind: PageKind;
  handoff!: Handoff;
  stalledUntil = 0;
  /** How the current stall releases what waited. */
  release: Release = "creation";
  frozen = false;
  gone: "closed" | "crashed" | null = null;
  /** The context really running, and whether the page has heard so. */
  running = true;
  seenRunning = true;
  enabled = true;
  shown = false;
  /** Whether the browser shows the page, which changes before the page hears of it, and since when it is hidden. */
  visible = false;
  hiddenSince = 0;
  lastAudibleAt = -Infinity;
  wasAudible = false;
  audioTime = 0;
  gate: Gate = { on: false, until: Infinity };
  /** The lease's deadline in this page's audio time, or null. */
  lease: number | null = null;
  heard = new Set<string>();
  /** When the page last processed a post from each peer, for the lease check. */
  heardAt = new Map<string, number>();
  /** Tasks held while frozen. */
  held: Task[] = [];
  holdsLock = false;
  freezing: Task | null = null;
  /** A stall that starts once the page has run this many more tasks, as a long task may start between any two. */
  stallAfter: { tasks: number; ms: number } | null = null;
  constructor(id: number, kind: PageKind) {
    this.id = id;
    this.kind = kind;
    this.name = `p${String(id).padStart(2, "0")}`;
  }
  eligible(): boolean {
    return this.enabled && this.seenRunning;
  }
  audible(): boolean {
    if (this.gone || !this.running || !this.gate.on) return false;
    if (this.audioTime >= this.gate.until) return false;
    if (this.lease !== null && this.audioTime >= this.lease) return false;
    return true;
  }
}

type Request = { page: SimPage; signal: AbortSignal; granted: (release: () => void) => void };

export class World {
  now = 1_000_000;
  seq = 0;
  tasks: Task[] = [];
  pages: SimPage[] = [];
  failures: string[] = [];
  readonly locks: boolean;
  readonly r: () => number;
  holder: SimPage | null = null;
  queue: Request[] = [];
  /** Peers each page heard while they owned unarmed and then crashed: their claims may keep the rest quiet. */
  keptClaims = new Set<string>();
  /** A fixed delay for every post, for a test that needs one order. */
  delay: number | null = null;
  /** How every stall releases what waited, or null for one of RELEASES at random per stall. */
  release: Release | null = "creation";
  /** A page hears its own posts too, behind what reached it first, as the engine's second object on the channel does (HandoffEnv.echo). */
  echo = true;
  readonly browser: Browser;
  /** Where the throttled wake-ups fall: a browser's grid has its own phase against `Date.now()`. */
  phase = 0;
  /** The task running now, for a timer's nesting. */
  #running: Task | null = null;

  constructor(locks: boolean, r: () => number, browser: Browser = "firefox") {
    this.locks = locks;
    this.r = r;
    this.browser = browser;
  }

  fail(why: string): void {
    if (this.failures.length < 5) this.failures.push(`t=${this.now - 1_000_000}: ${why}`);
    this.log(`FAIL ${why}`);
  }

  /** HANDOFF_TRACE=1 prints what happens, for a failing seed. */
  log(what: string): void {
    if (process.env.HANDOFF_TRACE) console.log(`${String(this.now - 1_000_000).padStart(7)} ${what}`);
  }

  later(page: SimPage, ms: number, run: () => void, timer = false): Task {
    const at = this.now + Math.max(0, ms);
    const running = this.#running;
    const nest = timer && running?.timer ? running.nest + 1 : 0;
    const task: Task = { at, seq: this.seq++, page: page.id, run, timer, due: at, nest };
    this.tasks.push(task);
    return task;
  }

  /** Where a task runs among those due at once: what waited out a stall first, in its page's release order, then by creation. */
  #rank(t: Task): [number, number, number] {
    const release = this.pages[t.page]!.release;
    if (t.readyAt === undefined || release === "creation") return [1, 0, t.seq];
    const kind = release === "ready" ? 0 : (release === "timers") === t.timer ? 0 : 1;
    return [0, kind * 1e15 + t.readyAt, t.seq];
  }

  #before(a: Task, b: Task): boolean {
    if (a.at !== b.at) return a.at < b.at;
    const ra = this.#rank(a);
    const rb = this.#rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]!;
    return false;
  }

  /** Advances time to `until`, running every task due, checking between. */
  runUntil(until: number): void {
    for (;;) {
      let next: Task | null = null;
      for (const t of this.tasks) if (next === null || this.#before(t, next)) next = t;
      const stepTo = Math.min(next?.at ?? Infinity, until, this.now + 50);
      this.advance(stepTo);
      if (next && next.at <= this.now) {
        if (this.#throttled(next)) continue;
        this.tasks.splice(this.tasks.indexOf(next), 1);
        this.runTask(next);
        this.check();
        continue;
      }
      this.check();
      if (this.now >= until) return;
    }
  }

  /** The grid a hidden page's timer wakes on, by `browser`, or null when it runs when due. */
  wakeGrid(page: SimPage, task: Task): number | null {
    if (page.visible || page.gone) return null;
    switch (this.browser) {
      case "chrome":
        if (this.now - page.lastAudibleAt < 30_000) return null;
        return this.now - page.hiddenSince >= 300_000 && task.nest >= 5 ? 60_000 : 1_000;
      case "safari": {
        if (task.nest < 10) return null;
        if (page.audible()) return 1_000;
        // Hidden and silent, the grid grows to the time since that began, stepping up each time a grid's length has passed.
        const throttledFor = this.now - Math.max(page.hiddenSince, page.lastAudibleAt);
        return Math.min(32_000, Math.max(1_000, 2 ** Math.floor(Math.log2(Math.max(1, throttledFor / 1_000))) * 1_000));
      }
      case "firefox":
        return null;
    }
  }

  /** Moves a timer that came due on a throttled page to its wake-up, or marks it woken. */
  #throttled(task: Task): boolean {
    if (!task.timer || task.woke) return false;
    const page = this.pages[task.page]!;
    const grid = this.wakeGrid(page, task);
    if (grid !== null) {
      const wake = Math.ceil((task.at - this.phase) / grid) * grid + this.phase;
      if (wake > task.at) {
        task.at = wake;
        return true;
      }
    }
    task.woke = true;
    return false;
  }

  advance(to: number): void {
    const dt = to - this.now;
    if (dt <= 0) return;
    for (const p of this.pages) if (!p.gone && p.running) p.audioTime += dt;
    this.now = to;
  }

  runTask(task: Task): void {
    const page = this.pages[task.page]!;
    if (page.gone) return;
    if (page.frozen) {
      page.held.push(task);
      return;
    }
    if (page.stalledUntil > this.now) {
      task.readyAt ??= this.now;
      task.at = page.stalledUntil;
      this.tasks.push(task);
      return;
    }
    this.#running = task;
    try {
      task.run();
    } finally {
      this.#running = null;
    }
    if (page.stallAfter && --page.stallAfter.tasks <= 0) {
      const { ms } = page.stallAfter;
      page.stallAfter = null;
      this.stall(page, ms);
    }
  }

  /** Throttling eased (the page is shown, or sounds): a timer waiting for a later wake-up runs when due. */
  rewake(page: SimPage): void {
    for (const t of [...this.tasks, ...page.held]) if (t.page === page.id && t.timer && !t.woke) t.at = Math.max(this.now, t.due);
  }

  check(): void {
    for (const p of this.pages) {
      const audible = p.audible();
      if (audible && !p.wasAudible) this.rewake(p);
      p.wasAudible = audible;
      if (audible) p.lastAudibleAt = this.now;
    }
    const sounding = this.pages.filter((p) => p.audible());
    if (this.locks) for (const p of sounding) if (!p.holdsLock) this.fail(`${p.name} sounds without the lock`);
    if (sounding.length > 1) {
      for (let i = 0; i < sounding.length; i++) {
        for (let j = i + 1; j < sounding.length; j++) {
          const a = sounding[i]!;
          const b = sounding[j]!;
          const excused = !this.locks && ((!a.heard.has(b.name) && b.stalledUntil > this.now - 1_000) || (!b.heard.has(a.name) && a.stalledUntil > this.now - 1_000));
          if (!excused) this.fail(`${a.name} and ${b.name} sound at once`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- the browser's parts

  /** When the last post from one page to another lands: a channel keeps each sender's posts in order. */
  #lastDelivery = new Map<string, number>();

  post(from: SimPage, msg: HandoffPost): void {
    for (const to of this.pages) {
      if ((to === from && !this.echo) || to.gone) continue;
      const pair = `${from.id}>${to.id}`;
      const at = Math.max(this.now + (this.delay ?? int(this.r, 0, 15)), this.#lastDelivery.get(pair) ?? 0);
      this.#lastDelivery.set(pair, at);
      this.later(to, at - this.now, () => {
        this.log(`${to.name} <- ${msg.page} ${msg.bye ? "bye" : `${msg.owns ? "owns " : ""}${msg.wants ? "wants " : ""}${msg.armed ? "armed " : ""}${msg.eligible ? "eligible" : "ineligible"} shown@${msg.shownAt - 1_000_000}`}`);
        to.heard.add(msg.page);
        to.heardAt.set(msg.page, this.now);
        to.handoff.receive(msg);
      });
    }
  }

  lockApi(page: SimPage): LockApi {
    return {
      request: (_name, signal, granted) => {
        if (signal.aborted) return;
        const request = { page, signal, granted };
        this.queue.push(request);
        signal.addEventListener("abort", () => {
          const at = this.queue.indexOf(request);
          if (at >= 0) this.queue.splice(at, 1);
        });
        this.grant();
      },
    };
  }

  grant(): void {
    if (this.holder !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    const page = next.page;
    this.holder = page;
    page.holdsLock = true;
    let released = false;
    // The grant runs as a task on the page's main thread, which a stall holds back while the lock is held already.
    const task = this.later(page, 0, () => {
      next.granted(() => {
        if (released) return;
        released = true;
        this.freeLock(page);
      });
    });
    task.grant = true;
  }

  freeLock(page: SimPage): void {
    if (this.holder !== page) return;
    this.holder = null;
    page.holdsLock = false;
    this.grant();
  }

  audio(page: SimPage): HandoffAudio {
    return {
      play: () => {
        this.log(`${page.name} PLAY`);
        page.gate = { on: true, until: Infinity };
        page.lease = null;
      },
      fadeOut: (ms) => {
        this.log(`${page.name} fade`);
        if (page.gate.on) page.gate = { on: true, until: Math.min(page.gate.until, page.audioTime + ms) };
        page.lease = null;
      },
      hold: () => {
        if (page.gate.on) this.log(`${page.name} HOLD`);
        page.gate = { on: false, until: Infinity };
        page.lease = null;
      },
      lease: (ms) => {
        if (ms !== null) {
          let other = false;
          for (const [peer, at] of page.heardAt) if (this.now - at < LAPSE_MS + 50 && peer !== page.name) other = true;
          if (!other) this.fail(`${page.name} armed its lease with no other page heard`);
        }
        page.lease = ms === null ? null : page.audioTime + ms;
      },
    };
  }

  open(kind: PageKind, shown: boolean): SimPage {
    const page = new SimPage(this.pages.length, kind);
    this.log(`${page.name} opens ${kind} ${shown ? "shown" : "hidden"}`);
    this.pages.push(page);
    page.shown = shown;
    page.visible = shown;
    page.hiddenSince = this.now;
    page.handoff = new Handoff({
      room: "R",
      page: page.name,
      kind,
      now: () => this.now,
      setTimer: (ms, fn) => this.later(page, ms, fn, true),
      clearTimer: (handle) => {
        const at = this.tasks.indexOf(handle as Task);
        if (at >= 0) this.tasks.splice(at, 1);
        const held = page.held.indexOf(handle as Task);
        if (held >= 0) page.held.splice(held, 1);
      },
      post: (msg) => this.post(page, msg),
      echo: this.echo,
      locks: this.locks ? this.lockApi(page) : null,
      audio: this.audio(page),
    });
    page.handoff.start(shown);
    page.handoff.setEligible(page.eligible());
    return page;
  }

  // ---------------------------------------------------------------- what happens to pages

  onPage(page: SimPage, run: () => void): void {
    this.later(page, 0, run);
  }

  close(page: SimPage): void {
    this.onPage(page, () => {
      this.log(`${page.name} closes`);
      page.handoff.close();
      page.gone = "closed";
      this.dropLock(page);
    });
  }

  crash(page: SimPage): void {
    if (page.gone) return;
    this.log(`${page.name} crashes`);
    if (!this.locks && page.gate.on) {
      // Without Web Locks a crashed owner's last post decides: unarmed, others that heard it keep its claim.
      if (!page.handoff.armed) this.keptClaims.add(page.name);
    }
    page.gone = "crashed";
    this.tasks = this.tasks.filter((t) => t.page !== page.id);
    this.dropLock(page);
  }

  dropLock(page: SimPage): void {
    this.queue = this.queue.filter((q) => q.page !== page);
    this.freeLock(page);
  }

  stall(page: SimPage, ms: number): void {
    if (page.stalledUntil <= this.now) page.release = this.release ?? pick(this.r, RELEASES);
    this.log(`${page.name} stalls ${ms}, releasing in ${page.release} order`);
    page.stalledUntil = Math.max(page.stalledUntil, this.now + ms);
  }

  /** Stalls the page right after its next `tasks` tasks, such as between a task and the 0 ms timer it sets. */
  stallSoon(page: SimPage, tasks: number, ms: number): void {
    page.stallAfter = { tasks, ms };
  }

  freeze(page: SimPage): void {
    const task = this.later(page, 0, () => {
      page.freezing = null;
      // A grant queued before the freeze runs before it, so the freeze can let that lock go too.
      for (const grant of this.tasks.filter((t) => t.page === page.id && t.grant)) {
        this.tasks.splice(this.tasks.indexOf(grant), 1);
        grant.run();
      }
      this.log(`${page.name} freezes`);
      page.handoff.freeze();
      page.frozen = true;
    });
    page.freezing = task;
  }

  thaw(page: SimPage): void {
    if (page.freezing) {
      // A freeze still queued behind a stall, or held by an earlier freeze, never comes.
      for (const list of [this.tasks, page.held]) {
        const at = list.indexOf(page.freezing);
        if (at >= 0) list.splice(at, 1);
      }
      page.freezing = null;
    }
    if (!page.frozen || page.gone) return;
    page.frozen = false;
    this.log(`${page.name} thaws`);
    this.later(page, 0, () => page.handoff.resume());
    for (const t of page.held.splice(0)) {
      t.at = this.now;
      this.tasks.push(t);
    }
  }

  show(page: SimPage, shown: boolean): void {
    // The browser stops or starts throttling at once, and the page hears of it as a task.
    if (shown && !page.visible) this.rewake(page);
    if (!shown && page.visible) page.hiddenSince = this.now;
    page.visible = shown;
    // The page reads the state as it is when the event runs, as the engine reads document.visibilityState.
    this.onPage(page, () => {
      this.log(`${page.name} ${page.visible ? "shown" : "hidden"}`);
      page.shown = page.visible;
      page.handoff.setShown(page.visible);
    });
  }

  enable(page: SimPage, on: boolean): void {
    this.onPage(page, () => {
      this.log(`${page.name} ${on ? "enabled" : "disabled"}`);
      page.enabled = on;
      page.handoff.setEligible(page.eligible());
    });
  }

  /** The context leaves `running`: the audio stops at once, and the page hears of it as a task. */
  suspend(page: SimPage): void {
    if (!page.running) return;
    page.running = false;
    this.log(`${page.name} context stops`);
    this.onPage(page, () => {
      page.seenRunning = false;
      page.handoff.contextLeft();
    });
  }

  /** The context runs again by itself: rendering resumes at once, before the page hears of it. */
  recover(page: SimPage): void {
    if (page.running) return;
    page.running = true;
    this.log(`${page.name} context runs`);
    this.later(page, int(this.r, 0, 400), () => {
      if (!page.running) return;
      page.seenRunning = true;
      page.handoff.setEligible(page.eligible());
    });
  }

  live(): SimPage[] {
    return this.pages.filter((p) => !p.gone);
  }
}

export function settleAndCheck(world: World, label: string): SimPage | null {
  // Every stall over, none still to start, then long enough for a lapse, a takeover by time, a listen window and a claim, and for three of a hidden page's once-a-second wake-ups along the way.
  for (const p of world.pages) p.stallAfter = null;
  const stalls = Math.max(world.now, ...world.pages.map((p) => p.stalledUntil));
  world.runUntil(stalls + LAPSE_MS + TAKEOVER_MS + 4_000 + (world.browser === "firefox" ? 0 : 3_000));
  const live = world.live().filter((p) => !p.frozen);
  const eligible = live.filter((p) => p.eligible());
  const sounding = world.pages.filter((p) => p.audible());
  const quietAllowed = !world.locks && live.some((p) => [...world.keptClaims].some((c) => p.heard.has(c)));
  if (eligible.length === 0) {
    if (sounding.length > 0) world.fail(`${label}: ${sounding[0]!.name} sounds with no page eligible`);
    return null;
  }
  if (sounding.length === 0) {
    if (!quietAllowed) world.fail(`${label}: no page sounds, ${eligible.length} eligible`);
    return null;
  }
  if (sounding.length > 1) world.fail(`${label}: ${sounding.length} pages sound`);
  const owner = sounding[0]!;
  if (eligible.some((p) => p.kind === "display") && owner.kind !== "display" && !quietAllowed) world.fail(`${label}: ${owner.name}, a member, sounds beside an eligible display`);
  return owner;
}

type Step = "open" | "close" | "crash" | "stall" | "freeze" | "thaw" | "show" | "hide" | "enable" | "disable" | "suspend" | "recover" | "wait";
const STEPS: readonly Step[] = ["open", "close", "crash", "stall", "freeze", "thaw", "show", "hide", "enable", "disable", "suspend", "recover", "wait", "wait", "show", "hide"];

export function randomRun(seed: number, locks: boolean): string[] {
  const r = rng(seed);
  const world = new World(locks, r, chance(r, 0.5) ? "chrome" : pick(r, ["safari", "firefox"] as const));
  world.phase = int(r, 0, 999);
  world.release = null;
  world.open(chance(r, 0.2) ? "display" : "member", chance(r, 0.7));
  const steps = int(r, 4, 40);
  for (let i = 0; i < steps; i++) {
    const live = world.live();
    const step = live.length === 0 ? "open" : pick(r, STEPS);
    const page = live.length > 0 ? pick(r, live) : null;
    switch (step) {
      case "open":
        if (world.pages.length < 6) world.open(chance(r, 0.25) ? "display" : "member", chance(r, 0.6));
        break;
      case "close":
        if (page) world.close(page);
        break;
      case "crash":
        if (page && chance(r, 0.5)) world.crash(page);
        break;
      case "stall":
        if (page) {
          const ms = pick(r, [300, 1_500, 4_000, 6_500, 8_000, 12_000, 31_000]);
          // A stall between runs falls only between tasks due at different times, so half start right after one of the page's next few tasks.
          if (chance(r, 0.5)) world.stallSoon(page, int(r, 1, 6), ms);
          else world.stall(page, ms);
        }
        break;
      case "freeze":
        if (page) world.freeze(page);
        break;
      case "thaw":
        for (const p of live) if (p.frozen && chance(r, 0.7)) world.thaw(p);
        break;
      case "show":
      case "hide":
        if (page) world.show(page, step === "show");
        break;
      case "enable":
      case "disable":
        if (page) world.enable(page, step === "enable");
        break;
      case "suspend":
        if (page && page.stalledUntil <= world.now) world.suspend(page);
        break;
      case "recover":
        if (page) world.recover(page);
        break;
      case "wait":
        break;
    }
    world.runUntil(world.now + pick(r, [10, 100, 400, 1_000, 2_100, 5_000, 7_500]));
    if (chance(r, 0.15)) {
      // A quiet stretch: everything thawed and running, then settled, then tab switches alone.
      for (const p of world.live()) world.thaw(p);
      for (const p of world.live()) world.recover(p);
      const owner = settleAndCheck(world, "settled");
      if (owner) {
        for (let k = 0; k < 6; k++) {
          const p = pick(r, world.live());
          world.show(p, !p.visible);
          world.runUntil(world.now + pick(r, [50, 500, 2_500]));
          if (!owner.audible()) world.fail(`${owner.name} stopped through tab switches`);
        }
      }
    }
  }
  for (const p of world.live()) world.thaw(p);
  for (const p of world.live()) world.recover(p);
  settleAndCheck(world, "at the end");
  return world.failures;
}

