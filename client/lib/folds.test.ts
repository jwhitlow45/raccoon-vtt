import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { member, room } from "#shared/testutil.ts";
import { RoomScope, type ScopeSlot } from "../state/scope.ts";
import {
  AMBIANCE_FOLDS,
  AMBIANCE_SECTIONS,
  ambianceFoldsSlot,
  createFolds,
  DM_PANEL_FOLDS,
  dmPanelFoldsSlot,
  foldRoomOf,
  panelIsOpen,
  SCENES_FOLDS,
  SCENES_SECTIONS,
  scenesFoldsSlot,
  THIS_DEVICE_FOLDS,
  THIS_DEVICE_SECTIONS,
  thisDeviceFoldsSlot,
  writeFold,
  type AmbianceSection,
  type FoldRoom,
  type FoldsStore,
} from "./folds.ts";

/*
 * The folds of Ambiance, the DM panel, Scenes and This device
 * (docs/design/design-v1-panel-groups.md 6.1, 6.2, 10): their starts, what a
 * device remembers, reveals, the starts that read the room and when they are
 * held, and a surface as useFolds draws it.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScopeProvider } = await import("../state/scope.ts");
const { PreviewContext } = await import("../features/dm/previewContext.ts");
const { useFolds } = await import("./folds.ts");

/** A device's localStorage, or one that throws as a private window's or blocked site data's does. */
function storage(initial: Record<string, string> = {}, throws = false) {
  const items = new Map(Object.entries(initial));
  let writes = 0;
  return {
    items,
    writes: () => writes,
    json: (key: string) => JSON.parse(items.get(key) ?? "null") as unknown,
    getItem(key: string) {
      if (throws) throw new Error("blocked");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (throws) throw new Error("blocked");
      writes++;
      items.set(key, value);
    },
  };
}

const CLOCK: FoldRoom = { clock: true, scenes: true };
const NO_CLOCK: FoldRoom = { clock: false, scenes: true };
const NO_SCENE: FoldRoom = { clock: false, scenes: false };
const AMB = AMBIANCE_FOLDS.key;

describe("where each surface starts with nothing stored (6.1, 6.2)", () => {
  test("Ambiance, compact on every width: Time folded once a clock runs and open without one, Sound open", () => {
    for (const width of [320, 390, 899, 900, 1440]) {
      assert.deepEqual(AMBIANCE_FOLDS.starts(width, CLOCK), { time: false, sound: true }, `${width} with a clock`);
      assert.deepEqual(AMBIANCE_FOLDS.starts(width, NO_CLOCK), { time: true, sound: true }, `${width} with no clock`);
    }
  });

  test("the DM panel: Handouts and Players' screens open everywhere, the setup sections open from 900 px and folded at 899", () => {
    assert.deepEqual(DM_PANEL_FOLDS.starts(899, CLOCK), { handouts: true, screens: true, check: false, link: false, display: false });
    assert.deepEqual(DM_PANEL_FOLDS.starts(900, CLOCK), { handouts: true, screens: true, check: true, link: true, display: true });
  });

  test("Scenes (scenes-reorg 3): Light and weather open everywhere, Scene sound, Fog and vision and the setup groups by the width, New scene too and open while the room has no scene", () => {
    for (const width of [320, 390, 899]) {
      assert.deepEqual(SCENES_FOLDS.starts(width, CLOCK), { light: true, sound: false, players: false, map: false, walls: false, scene: false, new: false }, `${width}`);
    }
    for (const width of [900, 1440]) {
      assert.deepEqual(SCENES_FOLDS.starts(width, CLOCK), { light: true, sound: true, players: true, map: true, walls: true, scene: true, new: true }, `${width}`);
    }
    assert.equal(SCENES_FOLDS.starts(390, NO_SCENE).new, true);
    assert.equal(SCENES_FOLDS.starts(390, NO_SCENE).map, false, "only New scene reads the room");
    assert.equal(SCENES_FOLDS.starts(390, NO_SCENE).light, true);
  });

  test("This device: every section is setup, folded at 899 and open at 900", () => {
    assert.ok(THIS_DEVICE_SECTIONS.every((s) => THIS_DEVICE_FOLDS.starts(899, CLOCK)[s] === false));
    assert.ok(THIS_DEVICE_SECTIONS.every((s) => THIS_DEVICE_FOLDS.starts(900, CLOCK)[s] === true));
  });

  test("one key per surface, the scene settings' kept", () => {
    assert.deepEqual(
      [AMBIANCE_FOLDS.key, DM_PANEL_FOLDS.key, SCENES_FOLDS.key, THIS_DEVICE_FOLDS.key],
      ["rvtt.ambianceFolds", "rvtt.dmPanelFolds", "rvtt.sceneSettingsFolds", "rvtt.thisDeviceFolds"],
    );
    assert.deepEqual(AMBIANCE_SECTIONS, ["time", "sound"], "Weather is a row that opens Scenes, never a fold (scenes-reorg 4.2)");
    assert.deepEqual(SCENES_SECTIONS, ["light", "sound", "players", "map", "walls", "scene", "new"]);
  });

  test("each surface's slot holds its own store, apart per Room page", () => {
    const a = new RoomScope();
    const b = new RoomScope();
    const slots: ScopeSlot<FoldsStore<string>>[] = [ambianceFoldsSlot, dmPanelFoldsSlot, scenesFoldsSlot, thisDeviceFoldsSlot] as never;
    assert.deepEqual(
      slots.map((slot) => a.get(slot).surface.key),
      ["rvtt.ambianceFolds", "rvtt.dmPanelFolds", "rvtt.sceneSettingsFolds", "rvtt.thisDeviceFolds"],
    );
    assert.notEqual(a.get(ambianceFoldsSlot), b.get(ambianceFoldsSlot));
  });
});

describe("what a device remembers (6.1)", () => {
  test("a stored value wins over its start, and the rest follow their starts", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage({ [AMB]: JSON.stringify({ sound: false }) }));
    assert.deepEqual(folds.get(390, CLOCK), { time: false, sound: false });
  });

  test("a stored fold wins over a start that reads the room: Time folded by hand with no clock stays folded", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage({ [AMB]: JSON.stringify({ time: false }) }));
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(1440, NO_CLOCK).time, false);
  });

  test("a value that is no boolean, or a key no section has, is passed over", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage({ [AMB]: JSON.stringify({ time: "yes", sound: 1, chip: true }) }));
    assert.deepEqual(folds.get(390, CLOCK), { time: false, sound: true });
  });

  test("a Weather fold a device stored before Weather became a row is passed over, and dropped at the next tap", () => {
    const s = storage({ [AMB]: JSON.stringify({ weather: true, time: true }) });
    const folds = createFolds(AMBIANCE_FOLDS, s);
    assert.deepEqual(folds.get(390, CLOCK), { time: true, sound: true });
    folds.tap("sound", false);
    assert.deepEqual(s.json(AMB), { time: true, sound: false });
  });

  test("storage that cannot be read opens every section, and taps still fold for the page", () => {
    for (const [why, s] of [
      ["storage that throws", storage({}, true)],
      ["a value that is no JSON", storage({ [AMB]: "{not json" })],
      ["a list", storage({ [AMB]: "[true]" })],
      ["null", storage({ [AMB]: "null" })],
    ] as const) {
      const folds = createFolds(AMBIANCE_FOLDS, s);
      assert.deepEqual(folds.get(390, CLOCK), { time: true, sound: true }, why);
      assert.doesNotThrow(() => folds.tap("sound", false));
      assert.equal(folds.get(390, CLOCK).sound, false, `${why}: the tap folds for the page`);
    }
    assert.deepEqual(createFolds(AMBIANCE_FOLDS, null).get(390, CLOCK), { time: true, sound: true }, "no storage");
  });

  test("a tap stores its section beside the others stored, and drops what no section is", () => {
    const s = storage({ [AMB]: JSON.stringify({ time: true, chip: true, sound: "yes" }) });
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.tap("sound", false);
    assert.deepEqual(s.json(AMB), { time: true, sound: false });
    assert.deepEqual(folds.get(390, CLOCK), { time: true, sound: false });
  });

  test("a tap writes beside what another tab stored after this page read it", () => {
    const s = storage();
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.get(390, CLOCK);
    s.items.set(AMB, JSON.stringify({ time: true }));
    folds.tap("sound", false);
    assert.deepEqual(s.json(AMB), { time: true, sound: false });
  });

  test("fold Sound, reload: folded", () => {
    const s = storage();
    createFolds(AMBIANCE_FOLDS, s).tap("sound", false);
    assert.equal(createFolds(AMBIANCE_FOLDS, s).get(390, CLOCK).sound, false);
  });

  test("a tap that asks not to write (a preview) folds for the page and stores nothing", () => {
    const s = storage();
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.tap("sound", false, false);
    assert.equal(folds.get(390, CLOCK).sound, false);
    assert.equal(s.writes(), 0);
    assert.equal(createFolds(AMBIANCE_FOLDS, s).get(390, CLOCK).sound, true);
  });

  test("writeFold over storage that throws or is missing takes the tap without a throw", () => {
    assert.doesNotThrow(() => writeFold(storage({}, true), AMBIANCE_FOLDS, "time", true));
    assert.doesNotThrow(() => writeFold(null, AMBIANCE_FOLDS, "time", true));
  });

  test("the first read's width decides the starts, so a turn across 900 px refolds nothing", () => {
    const folds = createFolds(DM_PANEL_FOLDS, storage());
    const phone = folds.get(390, CLOCK);
    assert.equal(phone.check, false);
    assert.equal(folds.get(1440, CLOCK), phone, "the same folds, the same object");
  });

  test("a tap before the first read keeps the width of that read", () => {
    const folds = createFolds(DM_PANEL_FOLDS, storage());
    folds.tap("link", false);
    assert.deepEqual(folds.get(1440, CLOCK), { handouts: true, screens: true, check: true, link: false, display: true });
  });

  /**
   * How the scene settings read their folds before they moved onto this
   * store (features/scenes/settingsFolds.ts at 6ae1693e), kept here as the
   * rule the store must read a device's stored values by.
   */
  function resolveSceneFolds(storage: Pick<Storage, "getItem">, width: number): { map: boolean; walls: boolean; scene: boolean } {
    const wide = width >= 900;
    let from: unknown;
    try {
      const raw = storage.getItem(SCENES_FOLDS.key);
      from = raw === null ? {} : JSON.parse(raw);
    } catch {
      from = null;
    }
    if (typeof from !== "object" || from === null || Array.isArray(from)) return { map: true, walls: true, scene: true };
    const stored = from as Record<string, unknown>;
    const pick = (key: string, start: boolean) => (typeof stored[key] === "boolean" ? (stored[key] as boolean) : start);
    return { map: pick("map", wide), walls: pick("walls", wide), scene: pick("scene", wide) };
  }

  test("the scene folds' stored values read as the scene settings read them, Fog and vision on What players see's key and now on the setup rule", () => {
    // Fog and vision's fold with this stored value, at a phone's width and a computer's: a stored boolean wins, unreadable storage opens it, else the setup rule.
    const cases: [raw: string | null, players: { phone: boolean; wide: boolean }][] = [
      [null, { phone: false, wide: true }],
      [JSON.stringify({ scene: false }), { phone: false, wide: true }],
      [JSON.stringify({ players: false, map: true }), { phone: false, wide: false }],
      [JSON.stringify({ players: true }), { phone: true, wide: true }],
      [JSON.stringify({ map: "yes", grid: false }), { phone: false, wide: true }],
      ["{not json", { phone: true, wide: true }],
      ["[true]", { phone: true, wide: true }],
    ];
    for (const [raw, players] of cases) {
      for (const width of [390, 899, 900, 1440]) {
        const s = storage(raw === null ? {} : { [SCENES_FOLDS.key]: raw });
        const now = createFolds(SCENES_FOLDS, s).get(width, CLOCK);
        const before = resolveSceneFolds(s, width);
        assert.deepEqual({ map: now.map, walls: now.walls, scene: now.scene }, { map: before.map, walls: before.walls, scene: before.scene }, `${raw} at ${width}`);
        assert.equal(now.players, width >= 900 ? players.wide : players.phone, `Fog and vision, ${raw} at ${width}`);
      }
    }
  });

  test("a device that unfolded What players see on a phone finds Fog and vision open, and Light and weather stays open whatever else it stored", () => {
    const s = storage({ [SCENES_FOLDS.key]: JSON.stringify({ players: true, map: false }) });
    const now = createFolds(SCENES_FOLDS, s).get(390, CLOCK);
    assert.equal(now.players, true);
    assert.equal(now.light, true);
    assert.equal(now.sound, false, "Scene sound is setup");
  });

  test("a scene tap keeps the scene settings' stored values beside New scene's", () => {
    const s = storage({ [SCENES_FOLDS.key]: JSON.stringify({ map: true, walls: false }) });
    const folds = createFolds(SCENES_FOLDS, s);
    folds.tap("new", false);
    folds.tap("light", false);
    folds.tap("sound", true);
    assert.deepEqual(s.json(SCENES_FOLDS.key), { light: false, sound: true, map: true, walls: false, new: false });
  });
});

describe("reveals (6.1)", () => {
  test("a reveal opens a folded section and writes nothing", () => {
    const s = storage({ [AMB]: JSON.stringify({ sound: false }) });
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.follow(true, CLOCK);
    folds.reveal("sound");
    assert.equal(folds.get(390, CLOCK).sound, true);
    assert.equal(s.writes(), 0);
    assert.deepEqual(s.json(AMB), { sound: false });
  });

  test("it ends as its panel goes from open to closed, and the stored fold shows again", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    folds.follow(true, CLOCK);
    folds.reveal("time");
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, true, "still open while the panel is");
    folds.follow(false, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, false);
  });

  test("made while the panel is closed, it waits for the panel to open and ends when it next closes", () => {
    const folds = createFolds(DM_PANEL_FOLDS, storage({ [DM_PANEL_FOLDS.key]: JSON.stringify({ handouts: false }) }));
    folds.follow(false, CLOCK);
    folds.reveal("handouts");
    folds.follow(false, CLOCK);
    assert.equal(folds.get(390, CLOCK).handouts, true, "a closed panel staying closed ends nothing");
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).handouts, true, "shown revealed as the panel opens");
    folds.follow(false, CLOCK);
    assert.equal(folds.get(390, CLOCK).handouts, false, "folded again once it closes");
  });

  test("a tap on its header ends it and is written as any tap", () => {
    const s = storage();
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.follow(true, CLOCK);
    folds.reveal("time");
    folds.tap("time", false);
    assert.equal(folds.get(390, CLOCK).time, false);
    assert.deepEqual(s.json(AMB), { time: false });
    folds.tap("time", true);
    folds.follow(false, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, true, "the tap, not a reveal, so closing keeps it");
  });

  test("endReveals ends every reveal at once", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage({ [AMB]: JSON.stringify({ sound: false }) }));
    folds.reveal("sound");
    folds.reveal("time");
    folds.endReveals();
    assert.deepEqual(folds.get(390, CLOCK), { time: false, sound: false });
  });

  test("every change tells the page, and a listener that stopped hears nothing", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    let heard = 0;
    const stop = folds.subscribe(() => heard++);
    folds.follow(true, CLOCK);
    folds.reveal("time");
    folds.tap("sound", false);
    folds.follow(false, CLOCK);
    assert.equal(heard, 4, "the hold, the reveal, the tap and the close");
    stop();
    folds.reveal("time");
    assert.equal(heard, 4);
  });
});

describe("starts that read the room (6.1, D-261102-765, D-261102-767)", () => {
  test("no clock: Time open on its start form. The DM starts the clock from it: Time stays open until Ambiance closes, then folded", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(390, NO_CLOCK).time, true);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, true, "held open while Ambiance stays open");
    folds.follow(false, CLOCK);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).time, false, "the next opening reads the room again");
  });

  test("a clock stopped on another device while Ambiance is open opens nothing until it closes", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    folds.follow(true, CLOCK);
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(1440, NO_CLOCK).time, false);
    folds.follow(false, NO_CLOCK);
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(1440, NO_CLOCK).time, true);
  });

  test("the hold lives in the store, so a remount across 900 px, which reads it anew at another width, keeps Time open", () => {
    const scope = new RoomScope();
    const store = scope.get(ambianceFoldsSlot);
    store.follow(true, NO_CLOCK);
    assert.equal(store.get(390, NO_CLOCK).time, true);
    store.follow(true, CLOCK);
    assert.equal(scope.get(ambianceFoldsSlot).get(1440, CLOCK).time, true, "the other tree reads the same store");
  });

  test("no clock, the DM folds Time, uses Sound, closes and reopens Ambiance: Time stays folded", () => {
    const s = storage();
    const folds = createFolds(AMBIANCE_FOLDS, s);
    folds.follow(true, NO_CLOCK);
    folds.tap("time", false);
    folds.follow(false, NO_CLOCK);
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(390, NO_CLOCK).time, false);
    assert.equal(createFolds(AMBIANCE_FOLDS, s).get(390, NO_CLOCK).time, false, "and after a reload");
  });

  test("a panel open as the page loads follows the room live until the snapshot, then holds: a clock in the snapshot folds Time", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    folds.follow(true, null);
    assert.equal(folds.get(1440, { clock: false, scenes: false }).time, true, "before the snapshot, the start read live");
    folds.follow(true, CLOCK);
    assert.equal(folds.get(1440, CLOCK).time, false, "the snapshot's clock folds it");
    folds.follow(true, NO_CLOCK);
    assert.equal(folds.get(1440, NO_CLOCK).time, false, "held from the snapshot on");
  });

  test("Scenes open on a phone as the page loads, the room has scenes: New scene folded", () => {
    const folds = createFolds(SCENES_FOLDS, storage());
    folds.follow(true, null);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).new, false);
  });

  test("a room with no scene: New scene open, and still open once the first scene is made until Scenes closes", () => {
    const folds = createFolds(SCENES_FOLDS, storage());
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(390, NO_SCENE).new, true);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).new, true);
    folds.follow(false, CLOCK);
    folds.follow(true, CLOCK);
    assert.equal(folds.get(390, CLOCK).new, false);
  });

  test("a room with no scene, New scene folded by hand, Scenes closed and reopened: still folded", () => {
    const folds = createFolds(SCENES_FOLDS, storage());
    folds.follow(true, NO_SCENE);
    folds.tap("new", false);
    folds.follow(false, NO_SCENE);
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(390, NO_SCENE).new, false);
  });

  test("with the panel closed, a start reads the room live", () => {
    const folds = createFolds(AMBIANCE_FOLDS, storage());
    assert.equal(folds.get(390, NO_CLOCK).time, true);
    assert.equal(folds.get(390, CLOCK).time, false);
  });
});

describe("the room and the panel as Room reads them", () => {
  test("foldRoomOf: the clock and whether any scene exists, nothing before the snapshot", () => {
    assert.deepEqual(foldRoomOf(null), { clock: false, scenes: false });
    const view = { ...room(), meta: {} } as unknown as RoomState & { meta: never };
    assert.deepEqual(foldRoomOf(view), { clock: false, scenes: true });
    assert.deepEqual(foldRoomOf({ ...view, scenes: {}, clock: { t: 0 } } as never), { clock: true, scenes: false });
    assert.deepEqual(foldRoomOf({ ...view, clock: null } as never), { clock: false, scenes: true }, "null is no clock");
  });

  test("panelIsOpen: the tab or the pane below from 900 px, the phone's sheet below it, as Room reads Time", () => {
    const local = { panel: "dm", tab: "ambiance", below: "scenes" };
    assert.equal(panelIsOpen(local, "ambiance", true), true);
    assert.equal(panelIsOpen(local, "scenes", true), true);
    assert.equal(panelIsOpen(local, "dm", true), false);
    assert.equal(panelIsOpen(local, "dm", false), true);
    assert.equal(panelIsOpen(local, "ambiance", false), false);
  });
});

/** Runs `fn` with `s` as the page's localStorage, which a Room's fold stores read as they are made. */
function withStorage<T>(s: ReturnType<typeof storage>, fn: () => T): T {
  const world = globalThis as { localStorage?: unknown };
  const before = world.localStorage;
  world.localStorage = s;
  try {
    return fn();
  } finally {
    world.localStorage = before;
  }
}

/** Draws a component that reads Ambiance's folds as a group would, in a Room with a clock or not, as a preview or not, its stores made over `s`. */
function drawn(options: { clock: boolean; preview?: boolean; storage?: ReturnType<typeof storage> }) {
  return withStorage(options.storage ?? storage(), () => draw(options));
}

function draw(options: { clock: boolean; preview?: boolean }) {
  const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  if (options.clock) (view as { clock?: unknown }).clock = { id: "c1", rev: 0, t: 0 };
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  const scope = new RoomScope();
  const seen: Record<string, { open: boolean; onToggle(): void }> = {};
  function Probe() {
    const fold = useFolds(ambianceFoldsSlot);
    for (const s of AMBIANCE_SECTIONS) seen[s] = fold(s);
    return null;
  }
  const inner = createElement(RoomProvider, {
    store: store as never,
    actions: { dispatch: () => 1, newId: () => "x" } as never,
    ui: {} as never,
    assets: { url: () => "" } as never,
    children: createElement(Probe),
  });
  renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope,
      children: options.preview ? createElement(PreviewContext.Provider, { value: { memberId: "p1", name: "Pat" }, children: inner }) : inner,
    }),
  );
  return { seen: seen as Record<AmbianceSection, { open: boolean; onToggle(): void }>, scope };
}

describe("useFolds, as a surface's groups read it", () => {
  test("it reads the room's clock for Time's start", () => {
    assert.equal(drawn({ clock: true }).seen.time.open, false);
    assert.equal(drawn({ clock: false }).seen.time.open, true);
  });

  test("onToggle flips its section in the Room's store", () => {
    const { seen, scope } = drawn({ clock: true });
    seen.sound.onToggle();
    assert.equal(scope.get(ambianceFoldsSlot).get(390, CLOCK).sound, false);
  });

  test("in a preview a tap folds for its page and writes nothing", () => {
    const s = storage();
    const preview = drawn({ clock: true, preview: true, storage: s });
    preview.seen.sound.onToggle();
    assert.equal(preview.scope.get(ambianceFoldsSlot).get(390, CLOCK).sound, false);
    assert.equal(s.writes(), 0, "a preview writes nothing");
    const own = drawn({ clock: true, storage: s });
    own.seen.sound.onToggle();
    assert.equal(s.writes(), 1, "the DM's own page writes its tap");
  });

  test("it reads what the device stored", () => {
    assert.equal(drawn({ clock: true, storage: storage({ [AMB]: JSON.stringify({ time: true }) }) }).seen.time.open, true);
  });
});

describe("the store through any order of events (property)", () => {
  type Event =
    | { t: "open" }
    | { t: "close" }
    | { t: "snapshot" }
    | { t: "clock"; on: boolean }
    | { t: "tap"; section: AmbianceSection; open: boolean; write: boolean }
    | { t: "reveal"; section: AmbianceSection }
    | { t: "read"; width: number };
  const section = fc.constantFrom(...AMBIANCE_SECTIONS);
  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.constant({ t: "open" } as const),
    fc.constant({ t: "close" } as const),
    fc.constant({ t: "snapshot" } as const),
    fc.boolean().map((on) => ({ t: "clock", on }) as const),
    fc.record({ section, open: fc.boolean(), write: fc.boolean() }).map((e) => ({ t: "tap", ...e }) as const),
    section.map((s) => ({ t: "reveal", section: s }) as const),
    fc.constantFrom(320, 899, 900, 1440).map((width) => ({ t: "read", width }) as const),
  );

  test("named invariants hold through 1,000 random sequences", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), fc.option(fc.constantFrom(JSON.stringify({ time: true }), JSON.stringify({ sound: false }), "{bad"), { nil: null }), (events, initial) => {
        const s = storage(initial === null ? {} : { [AMB]: initial });
        const folds = createFolds(AMBIANCE_FOLDS, s);
        let open = false;
        let loaded = false;
        let clock = false;
        let width = 390;
        const revealed = new Set<AmbianceSection>();
        const tapped = new Map<AmbianceSection, boolean>();
        let written = 0;
        let prev = folds.get(width, { clock, scenes: true });
        for (const e of events) {
          let changedBy: AmbianceSection | null = null;
          if (e.t === "open") open = true;
          if (e.t === "close") {
            // Only a change from open to closed ends the reveals.
            if (open) revealed.clear();
            open = false;
          }
          if (e.t === "snapshot") loaded = true;
          if (e.t === "clock") clock = e.on;
          if (e.t === "tap") {
            folds.tap(e.section, e.open, e.write);
            tapped.set(e.section, e.open);
            revealed.delete(e.section);
            if (e.write) written++;
            changedBy = e.section;
          }
          if (e.t === "reveal") {
            folds.reveal(e.section);
            revealed.add(e.section);
            changedBy = e.section;
          }
          if (e.t === "read") width = e.width;
          const live: FoldRoom = { clock, scenes: true };
          // Room's effect runs after each change, as useEndRevealsOnClose's does.
          folds.follow(open, loaded ? live : null);
          const now = folds.get(width, live);
          for (const r of revealed) assert.equal(now[r], true, "a revealed section shows open until a tap or a close");
          for (const [t, v] of tapped) if (!revealed.has(t)) assert.equal(now[t], v, "a tapped section shows its last tap");
          assert.equal(s.writes(), written, "only a tap that writes touches storage, never a reveal, a hold or a close");
          // While the panel stays open with the snapshot in, nothing moves under the DM's finger but what was tapped or revealed.
          if (open && loaded && e.t !== "open" && e.t !== "close" && e.t !== "snapshot") {
            for (const x of AMBIANCE_SECTIONS) if (x !== changedBy) assert.equal(now[x], prev[x], `${x} held while open after ${JSON.stringify(e)}`);
          }
          if (e.t === "read") assert.equal(now, prev, "a read at another width refolds nothing");
          prev = now;
        }
      }),
      { numRuns: 1000 },
    );
  });
});
