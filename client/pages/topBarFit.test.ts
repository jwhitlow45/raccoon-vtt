import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { STRIP_FACES_FEW, STRIP_NAME_MIN_PX, STRIP_NAME_PX, STRIP_NAME_YOURS_PX } from "../features/encounter/band.ts";
import { fitKey, fitStep, sameRecord, shapeOf, stepsFor, WIDE_STEPS, type BarContent, type BarShape, type FitRecord } from "./topBarFit.ts";
import { FLOOR_NAME_MAX_PX } from "../features/floors/bar.ts";

/*
 * The top bar's give-way (docs/design/design-v1-qol.md 4, C6 and The give-way): after
 * any run of content changes and widths, the bar shows what a page opened
 * now shows for the same content and width. The row here is a model of
 * TopBar's flex row in whole layout px. Search and Now playing are
 * modelled by their forms' widths, as features/search/SearchSheet.tsx
 * (BAR_FIELD_PX and its 44 px icon) and features/sound/mini/NowChip.tsx
 * draw them, and the speaker by its 44 px (features/sound/device/Speaker.tsx).
 */

/** The widths a bar's words and parts take, which the content's `words` stand for. */
type Words = {
  room: number;
  youName: number;
  clock: number;
  phase: number;
  turnName: number;
  nowPlaying: number;
  timer: number;
  /** The shown floor's name on Floor (features/floors/FloorButton.tsx), before its cap. */
  floor?: number;
};

type Bar = { content: BarContent; words: Words; fight: boolean };

const GAP = { wide: 12, wideTight: 6, phone: 6, phoneTight: 2 };

/** The row as TopBar draws `shape`: its parts' widths, those that shrink with their least, and the turn chip's name as drawn. */
function drawn(bar: Bar, shape: BarShape): { parts: { w: number; min: number }[]; name: number | null } {
  const { content: c, words } = bar;
  const dm = c.role === "dm";
  const fixed = (w: number) => ({ w, min: w });
  const parts = [fixed(10), { w: words.room, min: Math.min(words.room, 40) }];
  const stripInRow = c.strip === "bar" || (c.strip === "movable" && !shape.band);
  if (dm) parts.push(fixed(shape.eye ? (shape.eyeSlim ? 32 : 40) : shape.dmDot ? 32 : 72));
  else if (c.role === "player") {
    // A phone's player chip keeps its dot while the strip is in the row (Room.tsx chipDot).
    const dot = c.phone ? stripInRow : c.words[2]!.endsWith("true");
    parts.push(dot ? fixed(32) : { w: words.youName, min: 32 });
  }
  if (shape.blackout) parts.push(fixed(149));
  if (shape.search === "field") parts.push(fixed(240));
  if (shape.search === "icon") parts.push(fixed(44));
  parts.push(fixed(0));
  if (shape.nowPlaying === "full") parts.push(fixed(words.nowPlaying));
  if (shape.nowPlaying === "compact") parts.push(fixed(44));
  if (shape.volume) parts.push(fixed(44));
  if (shape.clock) parts.push(fixed(words.clock));
  if (dm) parts.push(fixed(88));
  if (shape.phase) parts.push(fixed(words.phase));
  let name: number | null = null;
  if (stripInRow) {
    const yours = c.yourTurn;
    const cap = Math.min(yours ? STRIP_NAME_YOURS_PX : STRIP_NAME_PX, shape.nameCap ?? Infinity);
    name = shape.nameCap === 0 ? null : Math.min(words.turnName, cap);
    const timer = c.timerOver ? (shape.timerShort ? 40 : 104) : words.timer;
    const faces = shape.faces > 0 ? shape.faces * 22 + (shape.faces - 1) * 6 : 0;
    const inside = [20, 26, name ?? 0, yours && shape.yourTurn ? 70 : 0, timer, faces].filter((w) => w > 0);
    const chip = 24 + inside.reduce((a, b) => a + b, 0) + 6 * (inside.length - 1);
    parts.push(fixed(chip + 8 + (dm ? 72 : yours ? 91 : 0)));
  }
  if (c.role === "player") parts.push(fixed(44));
  // Floor: its icon and the floor's name up to FLOOR_NAME_MAX_PX, inside 8 px each side, or the 44 px icon.
  if (shape.floor === "name") parts.push(fixed(16 + 20 + 6 + Math.min(words.floor ?? 0, FLOOR_NAME_MAX_PX)));
  if (shape.floor === "icon") parts.push(fixed(44));
  if (c.view && !shape.viewFold) parts.push(fixed(44));
  parts.push(fixed(44));
  if (shape.fullscreen) parts.push(fixed(44));
  return { parts, name };
}

/** What the row overflows its width by, after its shrinking parts have shrunk as far as they go. */
function measure(bar: Bar, shape: BarShape, width: number) {
  const { parts, name } = drawn(bar, shape);
  const gap = bar.content.phone ? (shape.tight ? GAP.phoneTight : GAP.phone) : shape.tight ? GAP.wideTight : GAP.wide;
  const gaps = gap * (parts.length - 1);
  const natural = parts.reduce((a, p) => a + p.w, 0) + gaps;
  const least = parts.reduce((a, p) => a + p.min, 0) + gaps;
  return { width, overflow: natural <= width ? 0 : Math.max(0, least - width), name };
}

/** Measures and steps until the record stops changing, as TopBar's layout effects do, and how many renders that took. */
function settle(bar: Bar, width: number, start: FitRecord | null): { record: FitRecord | null; shape: BarShape; renders: number } {
  const key = fitKey(bar.content);
  const steps = stepsFor(bar.content);
  let record = start;
  for (let renders = 1; renders < 60; renders++) {
    const m = measure(bar, shapeOf(bar.content, key, record), width);
    const next = fitStep(record, key, m, steps);
    if (sameRecord(next, record)) return { record, shape: shapeOf(bar.content, key, record), renders };
    record = next;
  }
  throw new Error("the bar never settled");
}

const words: fc.Arbitrary<Words> = fc.record({
  room: fc.integer({ min: 40, max: 360 }),
  youName: fc.integer({ min: 40, max: 160 }),
  clock: fc.integer({ min: 100, max: 160 }),
  phase: fc.integer({ min: 100, max: 220 }),
  turnName: fc.integer({ min: 20, max: 260 }),
  nowPlaying: fc.integer({ min: 140, max: 250 }),
  timer: fc.integer({ min: 30, max: 48 }),
  floor: fc.integer({ min: 30, max: 220 }),
});

/** A bar's content as TopBar builds it, Search and Now playing among the parts. */
const bars: fc.Arbitrary<Bar> = fc
  .record({
    phone: fc.boolean(),
    landscape: fc.boolean(),
    role: fc.constantFrom<"dm" | "player">("dm", "player"),
    search: fc.boolean(),
    nowPlaying: fc.boolean(),
    // Off only in View as a player, whose bar has no speaker.
    speaker: fc.boolean(),
    clock: fc.boolean(),
    blackout: fc.boolean(),
    fullscreen: fc.boolean(),
    phase: fc.boolean(),
    iso: fc.boolean(),
    canFit: fc.boolean(),
    floors: fc.boolean(),
    fight: fc.boolean(),
    faces: fc.integer({ min: 0, max: 5 }),
    timer: fc.constantFrom("none", "running", "over"),
    yours: fc.boolean(),
    chipDot: fc.boolean(),
    words,
  })
  .map((r): Bar => {
    const dm = r.role === "dm";
    const shown: Words = { ...r.words, timer: r.timer === "running" ? r.words.timer : 0 };
    const strip = !r.fight ? "none" : !r.phone ? "bar" : r.landscape ? "movable" : "none";
    const content: BarContent = {
      phone: r.phone,
      role: r.role,
      search: r.search,
      nowPlaying: dm && r.nowPlaying,
      clock: !r.phone && r.clock,
      blackout: dm && r.blackout,
      fullscreen: !r.phone && r.fullscreen,
      phase: !r.phone && dm && r.phase,
      gaps: r.iso,
      view: r.iso && r.canFit,
      volume: r.speaker,
      floor: r.canFit && r.floors,
      strip,
      faces: strip !== "none" && dm ? r.faces : 0,
      timerOver: strip !== "none" && r.timer === "over",
      yourTurn: strip !== "none" && !dm && r.yours,
      // What the words' widths stand for, as Room.tsx keys them: any change to one is new content.
      words: [JSON.stringify(shown), String(r.canFit), dm ? "" : `you:${r.phone ? "" : r.chipDot}`],
    };
    return { content, words: shown, fight: r.fight };
  });

/** The row's width in layout px: a phone's whole window, or a computer's map beside the side panel. */
const widthFor = (bar: Bar) => (bar.content.phone ? fc.integer({ min: 240, max: 899 }) : fc.integer({ min: 380, max: 1500 }));

/** A run of bars and widths: each event changes the content, the width, or both. */
const runs = fc.array(fc.tuple(bars, fc.integer({ min: 240, max: 1500 }), fc.constantFrom("content", "width", "both")), { minLength: 1, maxLength: 12 });

describe("the top bar's give-way (topBarFit)", () => {
  test("after any run of content changes and widths, the bar shows what a fresh page shows", () => {
    fc.assert(
      fc.property(bars, runs, (first, events) => {
        let bar = first;
        let width = bar.content.phone ? 390 : 1080;
        let record = settle(bar, width, null).record;
        for (const [next, w, what] of events) {
          // A phone stays a phone and a computer a computer within a run's widths, as the layout width decides both.
          if (what !== "width") bar = next;
          if (what !== "content") width = w;
          width = bar.content.phone ? Math.min(899, Math.max(240, width)) : Math.max(380, width);
          const now = settle(bar, width, record);
          const fresh = settle(bar, width, null);
          assert.deepEqual(now.shape, fresh.shape);
          // React stops a page past 50 renders in a row: the steps and a start over stay well under that.
          assert.ok(now.renders <= stepsFor(bar.content).length + 4, `${now.renders} renders`);
          record = now.record;
        }
      }),
      { numRuns: 2000 },
    );
  });

  test("the bar takes the fewest steps that fit, in order, and keeps Search from 900 px up", () => {
    fc.assert(
      fc.property(
        bars.chain((bar) => fc.tuple(fc.constant(bar), widthFor(bar))),
        ([bar, width]) => {
          const key = fitKey(bar.content);
          const steps = stepsFor(bar.content);
          const { record, shape } = settle(bar, width, null);
          const taken = record?.taken ?? 0;
          const m = measure(bar, shape, width);
          assert.ok(m.overflow <= 0 || taken === steps.length, `overflows ${m.overflow} with ${taken} of ${steps.length} steps`);
          if (taken > 0 && steps[taken - 1] !== "turnName") {
            const fewer = { ...record!, taken: taken - 1, nameCap: steps.slice(0, taken - 1).includes("turnName") ? record!.nameCap : null };
            assert.ok(measure(bar, shapeOf(bar.content, key, fewer), width).overflow > 0, `fits with one step fewer than ${steps[taken - 1]}`);
          }
          if (!bar.content.phone && bar.content.search) assert.ok(shape.search === "field" || shape.search === "icon");
          // Each step changes what the bar draws, so none costs a render for nothing.
          for (let i = 0; i < steps.length; i++) {
            const before = shapeOf(bar.content, key, { key, width, taken: i, nameCap: null });
            const after = shapeOf(bar.content, key, { key, width, taken: i + 1, nameCap: 50 });
            assert.notDeepEqual(before, after, `${steps[i]} draws nothing new`);
          }
          if (shape.nameCap !== null && shape.nameCap > 0) assert.ok(shape.nameCap >= STRIP_NAME_MIN_PX);
        },
      ),
      { numRuns: 3000 },
    );
  });

  test("the speaker leaves the bar only once every step before it is taken, View and Floor folded first, and while it is on the bar the turn chip keeps its name (docs/design/design-v1-volume.md 3, D-261108-362)", () => {
    fc.assert(
      fc.property(
        bars.chain((bar) => fc.tuple(fc.constant(bar), widthFor(bar))),
        ([bar, width]) => {
          const c = bar.content;
          const steps = stepsFor(c);
          const { record, shape } = settle(bar, width, null);
          const taken = steps.slice(0, record?.taken ?? 0);
          const fold = steps.indexOf("volumeFold");
          if (!c.volume) {
            assert.equal(fold, -1, "no speaker, no step for it");
            assert.equal(shape.volume, false);
            return;
          }
          assert.ok(fold >= 0);
          assert.equal(shape.volume, !taken.includes("volumeFold"), "on the bar unless its step is taken");
          if (!shape.volume) {
            for (const step of steps.slice(0, fold)) assert.ok(taken.includes(step), `${step} before the speaker`);
            // In the bar's own terms, so a step moved past the speaker in either list fails here too.
            if (c.view || c.floor) assert.equal(shape.viewFold, true, "View and Floor fold before the speaker");
            if (c.gaps) assert.equal(shape.tight, true, "the gaps tighten before the speaker");
            if (c.search) assert.equal(shape.search, c.phone ? "panels" : "icon", "Search gives way before the speaker");
            if (c.role === "dm" && c.nowPlaying) assert.equal(shape.nowPlaying, "off", "Now playing leaves before the speaker");
          } else {
            assert.equal(shape.nameCap, null, "the turn name gives way only after the speaker");
            assert.equal(shape.timerShort, false);
            assert.equal(shape.yourTurn, c.yourTurn);
            assert.equal(shape.eyeSlim, false);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  test("the speaker is on the bar at first, for the DM and players alike, and none is drawn without one", () => {
    const at: BarContent = { phone: false, role: "player", search: true, nowPlaying: false, clock: false, blackout: false, fullscreen: true, phase: false, gaps: true, view: true, volume: true, floor: true, strip: "none", faces: 0, timerOver: false, yourTurn: false, words: [] };
    for (const c of [at, { ...at, role: "dm" as const }, { ...at, phone: true, fullscreen: false }]) {
      const steps = stepsFor(c);
      assert.equal(shapeOf(c, fitKey(c), null).volume, true);
      // Folding takes exactly that step: the record that takes it draws the speaker off, the one before it on.
      const key = fitKey(c);
      const fold = steps.indexOf("volumeFold");
      assert.equal(steps[fold - 1], "viewFold", "right after View");
      assert.equal(shapeOf(c, key, { key, width: 0, taken: fold, nameCap: null }).volume, true);
      assert.equal(shapeOf(c, key, { key, width: 0, taken: fold + 1, nameCap: null }).volume, false);
    }
    const preview = { ...at, volume: false };
    assert.equal(shapeOf(preview, fitKey(preview), null).volume, false, "View as a player draws none");
    assert.ok(!stepsFor(preview).includes("volumeFold"));
  });

  test("on a short landscape phone in a fight the speaker alone never sends the turn strip to the band: the DM chip's dot and Search's move to the Panels field give its 50 px first (D-261108-442)", () => {
    fc.assert(
      fc.property(
        bars.filter((b) => b.content.strip === "movable" && b.content.search && b.content.volume),
        fc.integer({ min: 240, max: 899 }),
        (bar, width) => {
          // Only rows that held the strip with nothing given way before the speaker came.
          const without = settle({ ...bar, content: { ...bar.content, volume: false } }, width, null);
          fc.pre((without.record?.taken ?? 0) === 0);
          const { shape } = settle(bar, width, null);
          assert.equal(shape.band, false, "the strip keeps the row");
          assert.equal(shape.volume, true);
        },
      ),
      { numRuns: 3000 },
    );
  });

  test("a fight in a blackout at 1440 takes the clock, and both ending, or a narrowing to 900 and back, brings it back (CHIPS-GIVEWAY-1)", () => {
    const content = (fight: boolean, blackout: boolean): BarContent => ({
      phone: false,
      role: "dm",
      search: false,
      nowPlaying: false,
      clock: true,
      blackout,
      fullscreen: true,
      phase: true,
      gaps: true,
      view: true,
      volume: true,
      floor: false,
      strip: fight ? "bar" : "none",
      faces: fight ? 5 : 0,
      timerOver: false,
      yourTurn: false,
      words: ["The Sunless Citadel", "Day 4, 8:00 PM", "Day\nNight", fight ? "Belak" : ""],
    });
    const w: Words = { room: 150, youName: 60, clock: 135, phase: 130, turnName: 120, nowPlaying: 200, timer: 40 };
    const bar = (fight: boolean, blackout: boolean): Bar => ({ content: content(fight, blackout), words: w, fight });
    let record = settle(bar(false, false), 1080, null).record;
    assert.equal(record?.taken ?? 0, 0, "at rest everything fits");
    const both = settle(bar(true, true), 1080, record);
    assert.equal(both.shape.clock, false, "the fight in a blackout takes the clock");
    record = both.record;
    const after = settle(bar(false, false), 1080, record);
    assert.equal(after.shape.clock, true, "the clock comes back once both end");
    const narrow = settle(bar(false, false), 540, after.record);
    assert.equal(narrow.shape.clock, false);
    assert.equal(settle(bar(false, false), 1080, narrow.record).shape.clock, true, "and once the row is wide again");
  });

  test("the turn chip's name gives way by what the row lacks, down to 40 px, then leaves, and only then the timer and a player's Your turn", () => {
    const w: Words = { room: 300, youName: 60, clock: 135, phase: 130, turnName: 260, nowPlaying: 200, timer: 40 };
    const player = (over: boolean): Bar => ({
      content: {
        phone: false,
        role: "player",
        search: true,
        nowPlaying: false,
        clock: false,
        blackout: false,
        fullscreen: true,
        phase: false,
        gaps: true,
        view: true,
        volume: true,
        floor: false,
        strip: "bar",
        faces: 0,
        timerOver: over,
        yourTurn: true,
        words: [String(over), "true", "you:true"],
      },
      words: w,
      fight: true,
    });
    const steps = stepsFor(player(true).content);
    assert.deepEqual(steps, ["searchIcon", "fullscreenOff", "tightGaps", "viewFold", "volumeFold", "turnName", "timerShort", "yourTurnOff"]);
    // A row 30 px short once the steps before the name's are taken: the name's cap is what it showed (120 on the player's turn) less 30.
    const running = player(false);
    const key = fitKey(running.content);
    const least = measure(running, shapeOf(running.content, key, { key, width: 0, taken: steps.indexOf("turnName"), nameCap: null }), 0).overflow;
    const short30 = settle(running, least - 30, null);
    assert.equal(short30.shape.nameCap, STRIP_NAME_YOURS_PX - 30);
    assert.equal(short30.shape.timerShort, false);
    assert.equal(measure(running, short30.shape, least - 30).overflow, 0);
    // Short by more than the name can give: it leaves, and the row fits without the next step.
    const short90 = settle(running, least - 90, null);
    assert.equal(short90.shape.nameCap, 0);
    assert.equal(short90.shape.yourTurn, true);
    // Short of everything the name gives, it leaves, then the timer shortens, then Your turn drops.
    const tight = settle(player(true), 300, null);
    assert.equal(tight.shape.nameCap, 0);
    assert.equal(tight.shape.timerShort, true);
    assert.equal(tight.shape.yourTurn, false);
    assert.equal(tight.shape.search, "icon", "Search stays as its icon");
  });

  test("a DM's 320 x 568 phone at 130% in a blackout with a long room name fits: last, the crossed eye slims to the dot's width (QC-B)", () => {
    const content: BarContent = { phone: true, role: "dm", search: true, nowPlaying: false, clock: false, blackout: true, fullscreen: false, phase: false, gaps: true, view: true, volume: true, floor: false, strip: "none", faces: 0, timerOver: false, yourTurn: false, words: ["The Sunless Citadel and the Gulthias Tree"] };
    const bar: Bar = { content, words: { room: 330, youName: 60, clock: 0, phase: 0, turnName: 0, nowPlaying: 0, timer: 0 }, fight: false };
    const key = fitKey(content);
    const steps = stepsFor(content);
    assert.deepEqual(steps, ["blackoutFold", "searchPanels", "tightGaps", "viewFold", "volumeFold", "eyeSlim"]);
    // What the bar needs with every step but the last. There, a 222 px row (320 px over 130%, less the bar's 12 px each side) came up 1 px short in the browser. The model leaves out the 8 px Fit tucks into the bar's padding, so its widths run higher.
    const need = measure(bar, shapeOf(content, key, { key, width: 0, taken: steps.length - 1, nameCap: null }), 0).overflow;
    const short = need - 1;
    const settled = settle(bar, short, null);
    assert.deepEqual([settled.record?.taken, settled.shape.eye, settled.shape.eyeSlim], [steps.length, true, true]);
    assert.equal(measure(bar, settled.shape, short).overflow, 0);
    // The slim eye gives back the whole 8 px it costs over the dot.
    assert.equal(measure(bar, settled.shape, need - 8).overflow, 0);
    assert.ok(measure(bar, settled.shape, need - 9).overflow > 0);
    // Where the row has the pixel, the eye keeps its caret.
    assert.deepEqual([settle(bar, need, null).shape.eye, settle(bar, need, null).shape.eyeSlim], [true, false]);
  });

  test("the next faces go from five to three, then none, the DM's alone", () => {
    const base: BarContent = { phone: false, role: "dm", search: false, nowPlaying: false, clock: false, blackout: false, fullscreen: false, phase: false, gaps: false, view: false, volume: false, floor: false, strip: "bar", faces: 5, timerOver: false, yourTurn: false, words: [] };
    assert.deepEqual(stepsFor(base), ["facesThree", "dmDot", "facesNone", "turnName"]);
    const record = (taken: number): FitRecord => ({ key: fitKey(base), width: 500, taken, nameCap: null });
    assert.equal(shapeOf(base, fitKey(base), null).faces, 5);
    assert.equal(shapeOf(base, fitKey(base), record(1)).faces, STRIP_FACES_FEW);
    assert.equal(shapeOf(base, fitKey(base), record(3)).faces, 0);
    assert.deepEqual(stepsFor({ ...base, faces: 3 }), ["dmDot", "facesNone", "turnName"], "three faces skip the first faces step");
    assert.equal(shapeOf({ ...base, phone: true, strip: "movable" }, "k", null).faces, STRIP_FACES_FEW, "a phone's bar shows three");
  });

  test("the order is design-v1-qol.md 4's give-way, Search's step first, a player's Your turn last", () => {
    assert.deepEqual(WIDE_STEPS, [
      "searchIcon",
      "facesThree",
      "clockOff",
      "nowPlayingCompact",
      "blackoutFold",
      "dmDot",
      "nowPlayingOff",
      "fullscreenOff",
      "phaseOff",
      "floorIcon",
      "facesNone",
      "tightGaps",
      "viewFold",
      "volumeFold",
      "turnName",
      "timerShort",
      "yourTurnOff",
      "eyeSlim",
    ]);
    const phone: BarContent = { phone: true, role: "dm", search: true, nowPlaying: true, clock: false, blackout: true, fullscreen: false, phase: false, gaps: true, view: true, volume: true, floor: false, strip: "movable", faces: 4, timerOver: false, yourTurn: false, words: [] };
    assert.deepEqual(stepsFor(phone), ["blackoutFold", "searchPanels", "band", "nowPlayingOff", "tightGaps", "viewFold", "volumeFold", "eyeSlim"]);
    assert.deepEqual(stepsFor({ ...phone, blackout: false }), ["dmDot", "searchPanels", "band", "nowPlayingOff", "tightGaps", "viewFold", "volumeFold"], "the dot is already its width");
    assert.ok(!stepsFor({ ...phone, role: "player", blackout: false }).includes("eyeSlim"), "a player has no eye");
    const shape = shapeOf(phone, fitKey(phone), null);
    assert.equal(shape.search, "icon", "a phone's Search starts as its icon");
    assert.equal(shape.nowPlaying, "compact", "and Now playing as its compact form");
  });

  test("Floor shows its name, then its icon right after the Phase menu leaves, then folds with View into the Menu panel, and a phone starts at its icon (docs/design/design-v1-floors.md 18.6)", () => {
    const w: Words = { room: 150, youName: 60, clock: 135, phase: 130, turnName: 120, nowPlaying: 200, timer: 40, floor: 90 };
    const dm: BarContent = { phone: false, role: "dm", search: true, nowPlaying: false, clock: true, blackout: false, fullscreen: true, phase: true, gaps: true, view: true, volume: true, floor: true, strip: "none", faces: 0, timerOver: false, yourTurn: false, words: ["Tower", "Upper floor:3"] };
    const steps = stepsFor(dm);
    assert.deepEqual(steps, ["searchIcon", "clockOff", "dmDot", "fullscreenOff", "phaseOff", "floorIcon", "tightGaps", "viewFold", "volumeFold"]);
    const bar: Bar = { content: dm, words: w, fight: false };
    assert.equal(settle(bar, 1440, null).shape.floor, "name", "a wide bar has room for the floor's name");
    // Narrower and narrower, each form in its turn, never one with the next part's step taken first.
    const forms = [1440, 900, 760, 700, 640, 600, 560, 520, 480, 440, 400, 360, 320, 280, 240].map((width) => settle(bar, width, null).shape);
    const order = forms.map((f) => f.floor);
    assert.deepEqual([...new Set(order)], ["name", "icon", "menu"]);
    for (const f of forms) if (f.floor !== "name") assert.equal(f.phase, false, "the floor's name leaves only after the Phase menu");
    for (const f of forms) if (f.phase) assert.equal(f.floor, "name", "and never before it");
    for (const f of forms) assert.equal(f.floor === "menu", f.viewFold, "Floor folds with View, at one step");
    const phone: BarContent = { ...dm, phone: true, clock: false, fullscreen: false, phase: false };
    assert.deepEqual(stepsFor(phone), ["dmDot", "searchPanels", "tightGaps", "viewFold", "volumeFold"], "a phone's list gains only the fold");
    assert.equal(shapeOf(phone, fitKey(phone), null).floor, "icon", "a phone starts at the icon");
    assert.equal(shapeOf({ ...dm, floor: false }, fitKey({ ...dm, floor: false }), null).floor, null, "one floor held, no Floor");
    // Without View on the bar, Floor still folds into the Menu panel at the last step.
    const alone: BarContent = { ...phone, view: false, gaps: false };
    assert.deepEqual(stepsFor(alone), ["dmDot", "searchPanels", "viewFold", "volumeFold"]);
    // The floor's name is part of the bar's words, so a switch to a longer one is new content, measured again.
    assert.notEqual(fitKey(dm), fitKey({ ...dm, words: ["Tower", "The long gallery above the hall:3"] }));
  });

  test("a record for other content draws the first shape, and a wider row starts over before it measures", () => {
    const c: BarContent = { phone: false, role: "dm", search: true, nowPlaying: false, clock: true, blackout: false, fullscreen: true, phase: false, gaps: false, view: false, volume: false, floor: false, strip: "none", faces: 0, timerOver: false, yourTurn: false, words: ["a"] };
    const stale: FitRecord = { key: "other", width: 600, taken: 3, nameCap: null };
    assert.equal(shapeOf(c, fitKey(c), stale).search, "field");
    const drawnRecord: FitRecord = { key: fitKey(c), width: 600, taken: 2, nameCap: null };
    assert.deepEqual(fitStep(drawnRecord, fitKey(c), { width: 700, overflow: 0, name: null }, stepsFor(c)), { key: fitKey(c), width: 700, taken: 0, nameCap: null });
    assert.deepEqual(fitStep(drawnRecord, fitKey(c), { width: 580, overflow: 10, name: null }, stepsFor(c)), { key: fitKey(c), width: 580, taken: 3, nameCap: null }, "a narrower row keeps its steps and takes the next");
  });

  test("a pixel's rounding left over cuts the name again, at the same width", () => {
    const c: BarContent = { phone: false, role: "dm", search: false, nowPlaying: false, clock: false, blackout: false, fullscreen: false, phase: false, gaps: false, view: false, volume: false, floor: false, strip: "bar", faces: 0, timerOver: false, yourTurn: false, words: [] };
    const key = fitKey(c);
    const capped: FitRecord = { key, width: 500, taken: 2, nameCap: 90 };
    assert.deepEqual(stepsFor(c), ["dmDot", "turnName"]);
    const again = fitStep(capped, key, { width: 500, overflow: 1, name: 90.4 }, stepsFor(c));
    assert.deepEqual(again, { key, width: 500, taken: 2, nameCap: 89 });
    assert.equal(sameRecord(again, capped), false, "a new cap alone is a change");
  });
});
