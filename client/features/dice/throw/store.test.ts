import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { DiceRoll, LogEntry } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { FakeClock } from "../../../state/testing.ts";
import type { OnAnswer } from "../../../state/types.ts";
import { sendRoll, type RollSender } from "../send.ts";
import { createDicePanel, type DiceState } from "../useDicePanel.ts";
import { ReceiptTracker, type ReceiptState } from "../useReceipt.ts";
import type { DieKind } from "./layout.ts";
import type { LoadState } from "./probe.ts";
import { DISPOSE_MS, GONE_MS, LAND_MS, LATE_MS, PAINT_MS, ThrowStore, type PanelHost, type Stage, type StagedThrow, type StageEvents, type StageModule, type ThrowOrigin, type TrayHost } from "./store.ts";

/**
 * The throw's store (docs/design-v1-roll-animation.md 3 to 7), with a fake
 * tracker, loader, stage, clock and idle queue, so every rule runs under
 * plain Node: which commits throw, the 1 s timer, the interruptions, the
 * warm-up, a lost context and the renderer's disposal.
 */

/** The stage's own loop runs this long after a throw starts, then stops. */
const LOOP_MS = 1150;

class FakeTracker {
  states = new Map<string, ReceiptState>();
  #listeners = new Set<() => void>();
  state = (tag: string): ReceiptState | null => this.states.get(tag) ?? null;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(tag: string, state: ReceiptState): void {
    this.states.set(tag, state);
    for (const l of [...this.#listeners]) l();
  }
  /** The results the store handed to the toasts, unseen. */
  unseenTags: string[] = [];
  unseen = (tag: string): void => {
    this.unseenTags.push(tag);
  };
}

class FakeLoader {
  module: StageModule | null = null;
  current: LoadState = "waiting";
  #listeners = new Set<() => void>();
  loaded = () => this.module;
  state = () => this.current;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  finish(module: StageModule | null): void {
    this.module = module;
    this.current = module ? "ready" : "failed";
    for (const l of [...this.#listeners]) l();
  }
}

/** Idle callbacks wait until the test runs them, or until their own deadline passes on the clock. */
class FakeIdle {
  queue: { cb: () => void; id: number }[] = [];
  #id = 0;
  idle = (cb: () => void) => {
    const id = ++this.#id;
    this.queue.push({ cb, id });
    return () => {
      this.queue = this.queue.filter((q) => q.id !== id);
    };
  };
  runAll(): void {
    const due = this.queue;
    this.queue = [];
    for (const q of due) q.cb();
  }
}

/** A warm-up the test finishes when it likes: a promise-like whose callbacks run at once when told. */
class Warmup {
  done: (() => void)[] = [];
  failed: (() => void)[] = [];
  promise = { then: (ok?: () => void, fail?: () => void) => (this.done.push(ok ?? (() => undefined)), this.failed.push(fail ?? (() => undefined))) } as unknown as Promise<void>;
  finish(ok: boolean): void {
    for (const cb of ok ? this.done : this.failed) cb();
    this.done = [];
    this.failed = [];
  }
}

class FakeStage implements Stage {
  plays: StagedThrow[] = [];
  playing: { tag: string; at: number; reduced: boolean } | null = null;
  disposed = false;
  warmups: Warmup[] = [];
  /** The set each warm-up was asked for. */
  warmSets: string[] = [];
  /** A play that throws, as a texture drawn with no 2D context does. */
  failPlay = false;
  /** How long a play's setup blocks the page: the clock moves on, and no timer fires meanwhile. */
  setupMs = 0;
  readonly clock: FakeClock;
  readonly events: StageEvents;
  /** Checked as each throw starts, so the test sees the store's state at that moment. */
  onPlay: ((t: StagedThrow) => void) | null = null;
  onDispose: (() => void) | null = null;

  constructor(clock: FakeClock, events: StageEvents) {
    this.clock = clock;
    this.events = events;
  }

  warm(_kinds: readonly DieKind[], set: string): Promise<void> {
    assert.equal(this.playing, null, "never warmed over a throw on screen");
    const w = new Warmup();
    this.warmups.push(w);
    this.warmSets.push(set);
    return w.promise;
  }

  play(t: StagedThrow): void {
    assert.equal(this.disposed, false, "a disposed stage never plays");
    assert.ok(!this.looping(), "never two throws at once");
    if (this.failPlay) throw new TypeError("Cannot read properties of null (reading 'fillRect')");
    this.plays.push(t);
    this.playing = { tag: t.tag, at: this.clock.now() - t.elapsed, reduced: t.reduced };
    this.onPlay?.(t);
    this.clock.t += this.setupMs;
  }

  stop(): void {
    this.playing = null;
  }

  looping(): boolean {
    return this.playing !== null && !this.playing.reduced && this.clock.now() < this.playing.at + LOOP_MS;
  }

  dispose(): void {
    this.onDispose?.();
    this.disposed = true;
    this.playing = null;
    // forceContextLoss fires the context's own loss, which the stage reports as its own doing.
    this.events.lost(true);
  }
}

function line(tag: string, rolls: DiceRoll[]): LogEntry {
  return { id: `${tag}:0`, at: "2026-10-18T20:00:00.000Z", kind: "event", data: { type: "dice", by: "p1", to: "all", rolls, tag } };
}

const D20: DiceRoll = { formula: "1d20+5", faces: [17], total: 22, tokenId: "t1", label: "Stealth" };
const GEOMETRY = { width: 356, height: 300, zoom: 1, from: { x: 100, y: 250 } };

function harness() {
  const clock = new FakeClock();
  const tracker = new FakeTracker();
  const loader = new FakeLoader();
  const idle = new FakeIdle();
  const page = { hidden: false };
  const stages: FakeStage[] = [];
  let makeStage = true;
  let setupMs = 0;
  const module: StageModule = {
    createStage(events) {
      if (!makeStage) return null;
      const stage = new FakeStage(clock, events);
      stage.setupMs = setupMs;
      stages.push(stage);
      return stage;
    },
  };
  const store = new ThrowStore();
  store.bind({ clock, idle: idle.idle, tracker, loader, hidden: () => page.hidden });
  let shortPane = false;
  const panel: PanelHost = { kinds: (): DieKind[] => ["d20", "d6"] };
  const tray: TrayHost = { measure: () => (shortPane ? null : GEOMETRY), parent: null };
  /** The panel and its header line's tray, mounted together as the panel opens after a roll. */
  const open = () => {
    const unmount = store.mount(panel);
    const detach = store.attach(tray);
    return () => {
      detach();
      unmount();
    };
  };
  let tags = 0;
  const h = {
    clock,
    tracker,
    loader,
    idle,
    page,
    stages,
    store,
    open,
    panel,
    tray,
    module,
    noStage() {
      makeStage = false;
    },
    /** Every stage made from now on takes this long to set up each throw. */
    setup(ms: number) {
      setupMs = ms;
    },
    short(on: boolean) {
      shortPane = on;
    },
    stage: () => stages.at(-1) ?? null,
    /** The chunk arrives, the panel opens and the warm-up ends: from here a panel roll throws. */
    ready(): () => void {
      loader.finish(module);
      const unmount = open();
      idle.runAll();
      h.stage()?.warmups.at(-1)?.finish(true);
      return unmount;
    },
    tap(origin: Partial<ThrowOrigin> | null = {}): string {
      const tag = `tag-${++tags}`;
      tracker.set(tag, { state: "sending" });
      if (origin) store.register(tag, { surface: "dice", element: null, tapAt: clock.now(), ...origin });
      return tag;
    },
    commit(tag: string, rolls: DiceRoll[] = [D20]): void {
      tracker.set(tag, { state: "committed", lines: [line(tag, rolls)] });
    },
  };
  return h;
}

describe("the throw's store", () => {
  test("a panel roll throws, holds its result for 1 s, and the dice go after they fade", () => {
    const h = harness();
    h.ready();
    const tag = h.tap();
    h.clock.advance(80);
    h.commit(tag);
    assert.equal(h.stage()?.plays.length, 1);
    assert.equal(h.store.held(tag), true);
    assert.equal(h.store.view().rolling, false, "a quick answer never says Rolling");
    h.clock.advance(LAND_MS - 1);
    assert.equal(h.store.held(tag), true);
    h.clock.advance(1);
    assert.equal(h.store.held(tag), false, "landed");
    assert.ok(h.store.view().shown, "the dice stay to fade");
    h.clock.advance(GONE_MS - LAND_MS);
    assert.equal(h.store.view().shown, null);
  });

  test("a slow setup never delays the result: the deadlines count from the answer", () => {
    const h = harness();
    h.setup(200);
    h.ready();
    const tag = h.tap();
    h.commit(tag);
    assert.equal(h.stage()?.plays[0]?.elapsed, 0, "the stage is told how long ago the answer came");
    assert.equal(h.clock.now(), 200, "the setup took 200 ms");
    h.clock.advance(LAND_MS - 200 - 1);
    assert.equal(h.store.held(tag), true);
    h.clock.advance(1);
    assert.equal(h.store.held(tag), false, "landed 1 s after the answer, setup included");
    h.clock.advance(GONE_MS - LAND_MS);
    assert.equal(h.store.view().shown, null, "gone 2.1 s after the answer");
  });

  test("a dice set changed mid-flight waits for the throw to end before it warms up", () => {
    const h = harness();
    h.ready();
    const stage = h.stage()!;
    const tag = h.tap();
    h.commit(tag);
    h.store.setInputs({ set: "ruby" });
    h.idle.runAll();
    assert.deepEqual(stage.warmSets, ["ivory"], "nothing relabels the dice in the air");
    h.clock.advance(GONE_MS);
    h.idle.runAll();
    assert.deepEqual(stage.warmSets, ["ivory", "ruby"], "the new set warms up once the dice are gone");
  });

  test("turning the dice off or Low power on lets the renderer go and stops a warm-up on its way", () => {
    const h = harness();
    h.ready();
    const stage = h.stage()!;
    h.store.setInputs({ on: false });
    assert.equal(stage.disposed, true);
    assert.equal(h.store.lostContexts, 0, "a deliberate disposal");
    h.store.setInputs({ on: true });
    h.store.setInputs({ lowPower: true });
    h.idle.runAll();
    assert.equal(h.stages.length, 1, "the warm-up queued before Low power made no renderer");
    h.store.setInputs({ lowPower: false });
    h.idle.runAll();
    assert.equal(h.stages.length, 2, "and one comes once the dice are allowed again");
  });

  test("the picker gets no stage while its context is lost, and no previews after two losses or with no stage", () => {
    const h = harness();
    h.ready();
    const stage = h.stage()!;
    assert.equal(h.store.stage, stage);
    assert.equal(h.store.previewsAllowed, true);
    stage.events.lost(false);
    assert.equal(h.store.stage, null);
    assert.equal(h.store.previewsAllowed, false);
    stage.events.restored();
    assert.equal(h.store.stage, stage);
    stage.events.lost(false);
    stage.events.restored();
    assert.equal(h.store.previewsAllowed, false, "two losses end the dice for the session");
    const none = harness();
    none.noStage();
    none.ready();
    assert.equal(none.store.previewsAllowed, false);
  });

  test("an answer 200 ms or more after its tap keeps Rolling… until the dice land", () => {
    const h = harness();
    h.ready();
    const tag = h.tap();
    h.clock.advance(250);
    h.commit(tag);
    assert.equal(h.store.view().rolling, true);
    h.clock.advance(LAND_MS);
    assert.equal(h.store.view().rolling, false);
  });

  test("no throw: the switch off, Low power, a preview, no chunk, no warm-up, a hidden page or a short pane", () => {
    const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
      ["the switch off", (h) => h.store.setInputs({ on: false })],
      ["Low power", (h) => h.store.setInputs({ lowPower: true })],
      ["a preview", (h) => h.store.setInputs({ preview: true })],
      ["a hidden page", (h) => (h.page.hidden = true)],
      ["a pane too short", (h) => h.short(true)],
    ];
    for (const [why, stop] of cases) {
      const h = harness();
      h.ready();
      stop(h);
      const tag = h.tap();
      h.commit(tag);
      assert.equal(h.store.held(tag), false, why);
      assert.equal(h.stage()?.plays.length ?? 0, 0, why);
    }
    const early = harness();
    early.open();
    const before = early.tap();
    early.commit(before);
    assert.equal(early.store.held(before), false, "the chunk not here yet");
    early.loader.finish(early.module);
    const cold = early.tap();
    early.commit(cold);
    assert.equal(early.store.held(cold), false, "the warm-up not run yet");
    early.idle.runAll();
    const warming = early.tap();
    early.commit(warming);
    assert.equal(early.store.held(warming), false, "the warm-up not finished");
    early.stage()!.warmups[0]!.finish(true);
    const later = early.tap();
    early.commit(later);
    assert.equal(early.store.held(later), true, "later rolls throw");
  });

  test("no throw for several creatures, a bare line, a refusal, unknown, a lookup, a late answer or a commit before the panel mounted", () => {
    const h = harness();
    const unmount = h.ready();
    const several = h.tap();
    h.commit(several, [D20, { ...D20, tokenId: "t2" }]);
    assert.equal(h.store.held(several), false, "several creatures");
    const bare = h.tap();
    h.commit(bare, []);
    assert.equal(h.store.held(bare), false, "a bare line");
    const refused = h.tap();
    h.tracker.set(refused, { state: "refused", code: "invalid", message: "No.", text: "No." });
    h.commit(refused);
    assert.equal(h.store.held(refused), false, "a refusal, even if its lines later show");
    const unknown = h.tap();
    h.tracker.set(unknown, { state: "checking" });
    h.tracker.set(unknown, { state: "unknown" });
    assert.equal(h.store.held(unknown), false);
    const looked = h.tap();
    h.tracker.set(looked, { state: "checking" });
    h.commit(looked);
    assert.equal(h.store.held(looked), false, "settled by a lookup");
    const late = h.tap();
    h.clock.advance(LATE_MS + 1);
    h.commit(late);
    assert.equal(h.store.held(late), false, "an answer more than 3 s after its tap");
    const elsewhere = h.tap(null);
    h.commit(elsewhere);
    assert.equal(h.store.held(elsewhere), false, "a roll from outside the panel");
    unmount();
    const closed = h.tap();
    h.open();
    h.commit(closed);
    assert.equal(h.store.held(closed), false, "tapped before this mount");
    assert.equal(h.stage()!.plays.length, 0);
  });

  test("a pointer down takes the dice, and its click shows the result after the browser has chosen its target", () => {
    const h = harness();
    h.ready();
    const tag = h.tap();
    h.commit(tag);
    h.store.pointerDown();
    assert.equal(h.store.view().shown, null, "the dice go at once");
    assert.equal(h.store.held(tag), true, "the result waits for the click");
    h.store.click();
    assert.equal(h.store.held(tag), false);
    const dragged = h.tap();
    h.commit(dragged);
    h.store.pointerDown();
    h.store.pointerUp();
    h.clock.advance(299);
    assert.equal(h.store.held(dragged), true);
    h.clock.advance(1);
    assert.equal(h.store.held(dragged), false, "no click after the pointer up: a scroll");
    const keyed = h.tap();
    h.commit(keyed);
    h.store.keyDown();
    assert.equal(h.store.held(keyed), false);
    assert.equal(h.store.view().shown, null);
  });

  test("a newer roll ends the throw, and a commit with a newer tap on its way shows at once", () => {
    const h = harness();
    h.ready();
    const first = h.tap();
    h.commit(first);
    const second = h.tap();
    assert.equal(h.store.held(first), false, "the newer roll ended it");
    const third = h.tap();
    h.commit(second);
    assert.equal(h.store.held(second), false, "a newer tap would end it at once");
    h.commit(third);
    assert.equal(h.store.held(third), true);
    assert.deepEqual(
      h.stage()!.plays.map((p) => p.tag),
      [first, third],
    );
  });

  test("reduced motion draws the dice once at rest and shows the result at once", () => {
    const h = harness();
    h.ready();
    h.store.setInputs({ reducedMotion: true });
    const tag = h.tap();
    h.commit(tag);
    assert.equal(h.store.held(tag), false);
    assert.equal(h.stage()!.plays[0]?.reduced, true);
    assert.ok(h.store.view().shown);
  });

  test("a real lost context ends the throw, a second ends throws for the session, and a deliberate one never counts", () => {
    const h = harness();
    const unmount = h.ready();
    const stage = h.stage()!;
    const tag = h.tap();
    h.commit(tag);
    stage.events.lost(false);
    assert.equal(h.store.held(tag), false);
    const meanwhile = h.tap();
    h.commit(meanwhile);
    assert.equal(h.store.held(meanwhile), false, "nothing throws on a lost context");
    stage.events.restored();
    h.idle.runAll();
    stage.warmups.at(-1)!.finish(true);
    const back = h.tap();
    h.commit(back);
    assert.equal(h.store.held(back), true, "warmed up again after the restore");
    unmount();
    h.clock.advance(DISPOSE_MS);
    assert.equal(stage.disposed, true, "disposed 30 s after the panel closed");
    assert.equal(h.store.lostContexts, 1, "the disposal's own loss never counts");
    h.open();
    h.idle.runAll();
    const second = h.stage()!;
    assert.notEqual(second, stage);
    second.warmups.at(-1)!.finish(true);
    second.events.lost(false);
    second.events.restored();
    h.idle.runAll();
    second.warmups.at(-1)?.finish(true);
    const after = h.tap();
    h.commit(after);
    assert.equal(h.store.held(after), false, "two real losses: no throws for the session");
  });

  test("a hidden page throws nothing and lets the renderer go, and showing it warms up again", () => {
    const h = harness();
    h.ready();
    const stage = h.stage()!;
    h.page.hidden = true;
    h.store.visibility(true);
    assert.equal(stage.disposed, true);
    h.page.hidden = false;
    h.store.visibility(false);
    h.idle.runAll();
    h.stage()!.warmups.at(-1)!.finish(true);
    const tag = h.tap();
    h.commit(tag);
    assert.equal(h.store.held(tag), true);
  });
});

/**
 * Every way a Dice panel control rolls, through the panel's own actions
 * (createDicePanel) and the real receipt tracker: each that carries the
 * panel's origin throws, and the tracker's Roll, which carries none, does
 * not, even with Dice open beside it.
 */
describe("every way a panel control rolls", () => {
  function setup() {
    const clock = new FakeClock();
    const idle = new FakeIdle();
    const log: LogEntry[] = [];
    const tracker = new ReceiptTracker();
    tracker.env = { lookup: async () => ({ parts: [] }), log: () => log };
    const waiting: { op: ClientOp; answer: OnAnswer | undefined }[] = [];
    const sender: RollSender = {
      dispatch: (op, opts) => (waiting.push({ op, answer: opts?.onAnswer }), waiting.length),
      connected: () => true,
      receipts: tracker,
    };
    const loader = new FakeLoader();
    let stage: FakeStage | null = null;
    const store = new ThrowStore();
    store.bind({ clock, idle: idle.idle, tracker, loader, hidden: () => false });
    loader.finish({ createStage: (events) => (stage = new FakeStage(clock, events)) });
    const unmount = store.mount({ kinds: () => ["d20"] });
    const detach = store.attach({ parent: null, measure: () => GEOMETRY });
    idle.runAll();
    stage!.warmups[0]!.finish(true);
    const choices = createStore<DiceState>(() => ({ adv: false, dis: false, secret: null, version: 0, last: null }));
    const panel = createDicePanel({ store: choices, sender, secretStart: () => false, registerThrow: (tag, origin) => store.register(tag, origin) });
    /** The server's answer to everything sent: each op's line in the log, then its ack. */
    const answerAll = () => {
      for (const { op, answer } of waiting.splice(0)) {
        const tag = (op as { tag: string }).tag;
        const roll: DiceRoll = { formula: "1d20+4", faces: [12], total: 16, characterId: "thorn" };
        log.push(op.t === "roll.dice" ? { id: `${log.length + 1}:0`, at: "", kind: "event", data: { type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "thorn", total: 16, dice: roll, tag } } : line(tag, [roll]));
        answer?.("taken");
      }
    };
    const origin = () => store.origin();
    /** The Dice panel closes: its header line's tray, then the panel, as React cleans them up. */
    const close = () => {
      detach();
      unmount();
    };
    return { store, panel, sender, answerAll, origin, stage: () => stage!, tracker, close, clock };
  }

  const ROLL = { formula: "1d20+4", label: "Stealth", creature: { characterId: "thorn" } };

  test("the formula's Roll and a roll option throw", () => {
    const h = setup();
    const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
    h.answerAll();
    assert.equal(h.store.held(tag), true);
    const option = h.panel.roll([{ ...ROLL, label: "Longsword", critOn: 19 }], { origin: h.origin() })!;
    h.answerAll();
    assert.equal(h.store.held(option), true);
  });

  test("the header line's Again and Recent rolls' Again throw", () => {
    const h = setup();
    const header = h.panel.again([{ formula: "1d20+4" }], "all", h.origin())!;
    h.answerAll();
    assert.equal(h.store.held(header), true);
    const row = h.panel.again([{ formula: "2d6+3" }], "dm", h.origin())!;
    h.answerAll();
    assert.equal(h.store.held(row), true);
  });

  test("an answer to a request and a death save sent from the panel throw", () => {
    const h = setup();
    for (const op of [
      { t: "roll.dice", tag: "answer-1", rollId: "q1", target: { characterId: "thorn" } },
      { t: "actor.deathRoll", tag: "death-1", target: { characterId: "thorn" } },
    ] as const) {
      sendRoll(h.sender, op as never);
      h.panel.noted(op.tag, op.t === "roll.dice" ? "Dexterity save" : "Death save", h.origin());
      h.answerAll();
      assert.equal(h.store.held(op.tag), true, op.t);
    }
  });

  test("a stage that throws as it plays shows the result at once, goes for the session, and the tracker's other listeners still run", () => {
    const h = setup();
    h.stage().failPlay = true;
    let told = 0;
    h.tracker.subscribe(() => told++);
    const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
    told = 0;
    h.answerAll();
    assert.equal(h.store.held(tag), false, "the result shows");
    assert.ok(told > 0, "a listener after the store's still heard the answer");
    assert.equal(h.stage().disposed, true, "the stage is let go");
    assert.equal(h.store.lostContexts, 0);
    assert.equal(h.store.stage, null);
    const next = h.panel.roll([ROLL], { origin: h.origin() })!;
    h.answerAll();
    assert.equal(h.store.held(next), false, "no throws for the session");
  });

  test("a result still in the air as the panel closes goes to the toasts, in either cleanup order", () => {
    for (const order of ["panel first", "header line first"] as const) {
      const h = setup();
      const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
      // The header line shows the tag while it is mounted, and calls it told as it goes (useReceipt).
      const unwatch = h.tracker.watch(tag);
      h.answerAll();
      assert.equal(h.store.held(tag), true);
      const lastResultGoes = () => {
        unwatch();
        h.tracker.announced(tag);
      };
      const before = h.tracker.version();
      if (order === "panel first") {
        h.close();
        lastResultGoes();
      } else {
        lastResultGoes();
        h.close();
      }
      assert.ok(h.tracker.version() > before, `${order}: the toasts are told to look again`);
      assert.deepEqual(
        h.tracker.unannounced().map((u) => u.tag),
        [tag],
        `${order}: the own roll's toast`,
      );
    }
  });

  test("a result in the air as the panel closed, shown again before its toast, is no toast", () => {
    const h = setup();
    const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
    const unwatch = h.tracker.watch(tag);
    h.answerAll();
    h.close();
    unwatch();
    h.tracker.announced(tag);
    // The panel opens again at once, and its header line shows the result.
    const again = h.tracker.watch(tag);
    assert.deepEqual(h.tracker.unannounced(), []);
    again();
    h.tracker.announced(tag);
    assert.deepEqual(h.tracker.unannounced(), []);
  });

  test("a result that landed and painted before the panel closed is no toast", () => {
    for (const end of ["landing", "click", "key"] as const) {
      const h = setup();
      const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
      const unwatch = h.tracker.watch(tag);
      h.answerAll();
      if (end === "landing") h.clock.advance(LAND_MS);
      else if (end === "click") h.store.click();
      else h.store.keyDown();
      assert.equal(h.store.held(tag), false);
      h.clock.advance(PAINT_MS);
      h.close();
      unwatch();
      h.tracker.announced(tag);
      assert.deepEqual(h.tracker.unannounced(), [], end);
    }
  });

  test("Escape lets the result go and closes the sheet in the same event: the result never painted, so it goes to the toasts", () => {
    for (const end of ["key", "click"] as const) {
      const h = setup();
      const tag = h.panel.roll([ROLL], { origin: h.origin() })!;
      const unwatch = h.tracker.watch(tag);
      h.answerAll();
      // The panel's capture listener sees the key first, then the room's Escape closes the sheet in the same tick.
      if (end === "key") h.store.keyDown();
      else h.store.click();
      h.close();
      unwatch();
      h.tracker.announced(tag);
      assert.deepEqual(
        h.tracker.unannounced().map((u) => u.tag),
        [tag],
        end,
      );
    }
  });

  test("the tracker's Roll, which carries no origin, never throws", () => {
    const h = setup();
    const tag = h.panel.roll([ROLL])!;
    h.answerAll();
    assert.equal(h.store.held(tag), false);
    assert.equal(h.stage().plays.length, 0);
  });
});

describe("the throw's store, randomized", () => {
  test("2,000 random sequences keep its promises", () => {
    for (let seed = 1; seed <= 2_000; seed++) run(seed);
  });
});

/**
 * One random sequence of taps, answers, refusals, unknowns, chunk loads,
 * warm-ups, context losses and restores, panel taps and keys, mounts,
 * closes and resizes, page hides and shows, setting changes and clock
 * steps, with the invariants checked after every step. The model beside
 * the store knows only what the test did, never the store's own state.
 */
function run(seed: number): void {
  const r = rng(seed);
  const h = harness();
  const { store, clock, tracker } = h;
  /** What the sequence did, for a failure's message. */
  const trace: string[] = [];
  const did = (what: string) => trace.push(`${clock.now()} ${what}`);
  const at = (what: string) => `seed ${seed}, ${what}, after: ${trace.slice(-10).join("; ")}`;

  type Tap = { tag: string; mount: number | null; tapAt: number; panel: boolean; checked: boolean; settled: boolean };
  const taps: Tap[] = [];
  let mount: number | null = null;
  let mounts = 0;
  let unmount: (() => void) | null = null;
  let closedAt: number | null = null;
  let stageAtClose: FakeStage | null = null;
  const inputs = { on: true, lowPower: false, reducedMotion: false, preview: false };
  let realLosses = 0;
  let contextLost = false;
  /** A stage threw as it played: no throws for the session. */
  let broken = false;
  // Some sequences take a while to set up each throw, which the deadlines count.
  h.setup(pick(r, [0, 0, 30, 200]));
  let short = false;
  /** The group save page shows in place of the header line and its tray. */
  let groupSave = false;
  let detachTray: (() => void) | null = null;
  /** A warm-up finished on the current stage since anything made it cold. */
  let warm = false;
  /** The warm-ups that still count: one asked since nothing made it cold. */
  let counting = new Set<Warmup>();
  type Play = { tag: string; at: number; reduced: boolean; interrupted: boolean };
  // Set inside the stage's callback, which TypeScript cannot follow from here.
  let play = null as Play | null;

  const chill = () => {
    warm = false;
    counting = new Set();
  };
  const watchStage = (stage: FakeStage) => {
    if ((stage as { watched?: true }).watched) return;
    (stage as { watched?: true }).watched = true;
    stage.onPlay = (t) => {
      const tap = taps.find((x) => x.tag === t.tag);
      assert.ok(tap && tap.panel && tap.mount !== null && tap.mount === mount, at(`only a panel tap under this mount throws (${t.tag})`));
      assert.equal(tap.checked, false, at("never a roll a lookup settled"));
      assert.equal(tracker.states.get(t.tag)?.state, "committed", at("only a committed roll throws"));
      play = { tag: t.tag, at: clock.now(), reduced: t.reduced, interrupted: false };
    };
    stage.onDispose = () => {
      assert.equal(store.view().shown, null, at("never disposed while a throw runs"));
      if (stage === h.stage()) chill();
    };
  };
  const interrupted = () => {
    if (play) play.interrupted = true;
  };
  const shownNow = () => {
    assert.equal(store.view().held, null, at("the result shows at once after an interruption"));
  };

  // Most sequences start with the dice ready, so throws happen often enough to break.
  if (chance(r, 0.75)) {
    h.loader.finish(h.module);
    unmount = store.mount(h.panel);
    detachTray = store.attach(h.tray);
    h.idle.runAll();
    h.stage()?.warmups.at(-1)?.finish(true);
    mount = ++mounts;
    warm = h.stage() !== null;
  }
  const steps = int(r, 20, 80);
  for (let step = 0; step < steps; step++) {
    const stage = h.stage();
    if (stage) watchStage(stage);
    const k = r();
    let committed: Tap | null = null;
    let committedAt = 0;
    let eligible = false;
    if (k < 0.18) {
      // A tap: in the panel (with an origin), or elsewhere, such as the tracker's Roll. With the panel closed, a panel tap is a stale one.
      const panel = chance(r, mount === null ? 0.2 : 0.8);
      const tag = h.tap(panel ? {} : null);
      did(`tap ${tag}${panel ? "" : " elsewhere"}`);
      taps.push({ tag, mount: panel && mount !== null ? mounts : null, tapAt: clock.now(), panel, checked: false, settled: false });
      if (panel) {
        interrupted();
        shownNow();
      }
    } else if (k < 0.4) {
      const open = taps.filter((t) => !t.settled);
      if (open.length === 0) continue;
      // Mostly the newest, as answers come in order, sometimes an older one.
      const tap = chance(r, 0.7) ? open.at(-1)! : pick(r, open);
      const how = r();
      if (how < 0.65) {
        const rolls = chance(r, 0.1) ? [D20, { ...D20, tokenId: "t9" }] : chance(r, 0.05) ? [] : [D20];
        // Every condition the design names, from the test's own record.
        const later = taps.some((t) => t !== tap && !t.settled && t.panel && taps.indexOf(t) > taps.indexOf(tap));
        eligible =
          tap.panel &&
          tap.mount !== null &&
          tap.mount === mount &&
          !tap.checked &&
          clock.now() - tap.tapAt <= LATE_MS &&
          inputs.on &&
          !inputs.lowPower &&
          !inputs.preview &&
          h.loader.current === "ready" &&
          !h.page.hidden &&
          warm &&
          !contextLost &&
          realLosses < 2 &&
          !short &&
          !groupSave &&
          !later &&
          !broken &&
          rolls.length === 1;
        // An eligible commit on a stage that throws as it plays shows at once, and ends the dice for the session.
        if (eligible && h.stage()?.failPlay) {
          eligible = false;
          broken = true;
          chill();
        }
        tap.settled = true;
        committed = tap;
        did(`commit ${tap.tag}${eligible ? " (eligible)" : ""}`);
        committedAt = clock.now();
        h.commit(tap.tag, rolls);
      } else if (how < 0.8) {
        tap.settled = true;
        did(`refuse ${tap.tag}`);
        tracker.set(tap.tag, { state: "refused", code: "invalid", message: "No.", text: "No." });
      } else if (how < 0.9) {
        tap.checked = true;
        did(`check ${tap.tag}`);
        tracker.set(tap.tag, { state: "checking" });
      } else {
        tap.settled = true;
        did(`unknown ${tap.tag}`);
        tracker.set(tap.tag, { state: "unknown" });
      }
    } else if (k < 0.42) {
      if (h.loader.current === "waiting") {
        if (chance(r, 0.15)) h.loader.finish(null);
        else {
          if (chance(r, 0.05)) h.noStage();
          h.loader.finish(h.module);
        }
      }
    } else if (k < 0.48) {
      did("idle");
      const before = new Set(h.stages.flatMap((st) => st.warmups));
      h.idle.runAll();
      const made = h.stage();
      if (made) {
        watchStage(made);
        // A warm-up asked for now counts until something makes the stage cold.
        for (const w of made.warmups) if (!before.has(w)) counting.add(w);
      }
    } else if (k < 0.54) {
      const s = h.stage();
      const w = s?.warmups.find((x) => x.done.length > 0);
      if (w) {
        const ok = chance(r, 0.9);
        if (ok && counting.has(w)) warm = true;
        counting.delete(w);
        did(`warm-up ${ok ? "done" : "failed"}`);
        w.finish(ok);
      }
    } else if (k < 0.57) {
      const s = h.stage();
      if (s && !s.disposed) {
        if (chance(r, 0.6) && !contextLost) {
          realLosses++;
          contextLost = true;
          chill();
          interrupted();
          did("context lost");
          s.events.lost(false);
          shownNow();
        } else if (contextLost) {
          contextLost = false;
          did("context restored");
          s.events.restored();
        }
      }
    } else if (k < 0.68) {
      const e = pick(r, ["down", "click", "up", "cancel", "key"] as const);
      did(e);
      if (e === "down") {
        store.pointerDown();
        assert.equal(store.view().shown, null, at("a pointer down takes the dice"));
        if (play) play.interrupted = true;
      } else if (e === "click") {
        // A click or a cancel always ends a press in the panel, even one that began before the throw.
        interrupted();
        store.click();
        shownNow();
      } else if (e === "up") store.pointerUp();
      else if (e === "cancel") {
        interrupted();
        store.pointerCancel();
        shownNow();
      } else {
        interrupted();
        store.keyDown();
        shownNow();
      }
    } else if (k < 0.74) {
      // The panel opens again soon after it closes, as it does at a table.
      if (mount !== null && chance(r, 0.5)) continue;
      if (mount === null) {
        mount = ++mounts;
        did("mount");
        unmount = store.mount(h.panel);
        detachTray = store.attach(h.tray);
        groupSave = false;
        closedAt = null;
        stageAtClose = null;
      } else {
        interrupted();
        did("unmount");
        detachTray?.();
        detachTray = null;
        unmount!();
        mount = null;
        // A warm-up still under way stops counting when the panel closes.
        counting = new Set();
        closedAt = clock.now();
        stageAtClose = h.stage();
        shownNow();
      }
    } else if (k < 0.77) {
      interrupted();
      did("resize");
      store.resized();
      shownNow();
    } else if (k < 0.81) {
      if (!h.page.hidden && chance(r, 0.5)) continue;
      h.page.hidden = !h.page.hidden;
      if (h.page.hidden) interrupted();
      did(h.page.hidden ? "hide" : "show");
      store.visibility(h.page.hidden);
      if (h.page.hidden) {
        chill();
        contextLost = false;
        shownNow();
      }
    } else if (k < 0.86) {
      if (chance(r, 0.15)) {
        // Another dice set: its textures are drawn ahead, and nothing stops.
        const set = pick(r, ["ivory", "ruby", "gold"]);
        did(`set ${set}`);
        store.setInputs({ set });
        continue;
      }
      const key = pick(r, ["on", "lowPower", "reducedMotion", "preview"] as const);
      // A setting that stops the dice is turned back soon, so throws keep coming.
      const stopping = key === "on" ? !inputs.on : inputs[key];
      if (!stopping && chance(r, 0.5)) continue;
      inputs[key] = !inputs[key];
      const stops = key === "on" ? !inputs.on : inputs[key];
      if (stops) interrupted();
      did(`${key} ${inputs[key]}`);
      store.setInputs({ [key]: inputs[key] });
      if (stops) shownNow();
      // Turning the dice off, Low power on or a preview lets the renderer go: the next one starts cold, on a fresh context.
      if (stops && key !== "reducedMotion") {
        chill();
        contextLost = false;
      }
    } else if (k < 0.88) {
      short = !short;
      h.short(short);
    } else if (k < 0.9) {
      // The group save page opens in the panel, or closes and the header line's tray comes back.
      if (mount === null) continue;
      if (groupSave) {
        did("group save closes");
        detachTray = store.attach(h.tray);
        groupSave = false;
      } else {
        did("group save opens");
        interrupted();
        detachTray?.();
        detachTray = null;
        groupSave = true;
        shownNow();
      }
    } else if (k < 0.905) {
      const s = h.stage();
      if (s && !s.disposed && !s.failPlay) {
        did("the stage breaks");
        s.failPlay = true;
      }
    } else {
      const ms = chance(r, 0.05) ? DISPOSE_MS : pick(r, [16, 100, 250, 400, 700, 999, 1_000, 1_500, 2_500]);
      did(`wait ${ms}`);
      clock.advance(ms);
    }

    // ---------------------------------------------------------- invariants
    const view = store.view();
    const now = clock.now();
    if (committed && eligible) assert.equal(play?.tag, committed.tag, at(`an eligible commit throws (${committed.tag})`));
    if (committed && !eligible) assert.notEqual(play?.tag === committed.tag && play.at === committedAt, true, at(`an ineligible commit never throws (${committed.tag})`));
    if (broken) assert.equal(view.held, null, at("a stage that threw never holds a result"));
    if (view.held !== null) {
      assert.ok(play && play.tag === view.held && !play.reduced, at("only a throw holds its result"));
      assert.ok(now < play.at + LAND_MS, at("a result shows by t0 + 1,000 ms"));
    }
    if (play && !play.interrupted && !play.reduced && now < play.at + LAND_MS) assert.equal(view.held, play.tag, at("a throw holds its result until the dice land"));
    if (view.shown === null) assert.ok(!h.stage()?.looping(), at("no loop after a throw ends"));
    assert.equal(store.lostContexts, realLosses, at("a deliberate disposal never counts as a lost context"));
    if (closedAt !== null && stageAtClose && now - closedAt >= DISPOSE_MS) assert.equal(stageAtClose.disposed, true, at("the renderer goes within 30 s of the panel closing"));
  }
}
