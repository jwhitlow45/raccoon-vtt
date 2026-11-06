import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { member, room } from "#shared/testutil.ts";
import { RoomScope, type ScopeSlot } from "../state/scope.ts";
import {
  createFolds,
  DM_PANEL_FOLDS,
  dmPanelFoldsSlot,
  foldRoomOf,
  foldsSlot,
  panelIsOpen,
  SCENES_FOLDS,
  SCENES_SECTIONS,
  scenesFoldsSlot,
  SOUND_FOLDS,
  SOUND_SECTIONS,
  soundFoldsSlot,
  THIS_DEVICE_FOLDS,
  THIS_DEVICE_SECTIONS,
  thisDeviceFoldsSlot,
  writeFold,
  type FoldRoom,
  type FoldsStore,
  type FoldSurface,
} from "./folds.ts";

/*
 * The folds of Sound, the DM panel, Scenes and This device
 * (docs/design/design-v1-panel-groups.md 6.1, 6.2, 10,
 * docs/design/design-v1-sound-layout.md 4.3): their starts, what a device
 * remembers, reveals, the starts that read the room and when they are held,
 * and a surface as useFolds draws it.
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
const SCENES: FoldRoom = { clock: false, scenes: true };
const NO_SCENE: FoldRoom = { clock: false, scenes: false };

type PairSection = "start" | "play";

/*
 * Two sections for the store's own rules, which every surface shares: a
 * `start` that reads the room as New scene's does, open while the room has
 * no scene, and a `play` section open everywhere. Ambiance's surface, which
 * these tests used, went with its panel (docs/design/design-v1-sound-layout.md
 * 3.3).
 */
const PAIR: FoldSurface<PairSection> = {
  key: "rvtt.testPairFolds",
  sections: ["start", "play"],
  starts: (_width, room) => ({ start: !room.scenes, play: true }),
};
const KEY = PAIR.key;
const pairFoldsSlot = foldsSlot(PAIR);

describe("where each surface starts with nothing stored (6.1, 6.2)", () => {
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

  // docs/design/design-v1-sound-layout.md 4.3: open, Up next pushes Effects below the first screen.
  test("Sound: Up next folded on every width and with or without a clock", () => {
    assert.deepEqual(SOUND_SECTIONS, ["upnext"]);
    for (const width of [320, 390, 899, 900, 1440, 2560]) {
      assert.deepEqual(SOUND_FOLDS.starts(width, CLOCK), { upnext: false }, `${width} with a clock`);
      assert.deepEqual(SOUND_FOLDS.starts(width, NO_CLOCK), { upnext: false }, `${width} with no clock`);
    }
    for (const width of [390, 1440]) assert.deepEqual(createFolds(SOUND_FOLDS, storage()).get(width, CLOCK), { upnext: false }, `nothing stored at ${width}`);
  });

  test("Sound: a tap on Up next is remembered across a reload, and storage that throws opens it with taps for the page", () => {
    const s = storage();
    createFolds(SOUND_FOLDS, s).tap("upnext", true);
    assert.equal(s.getItem("rvtt.soundFolds"), JSON.stringify({ upnext: true }));
    assert.deepEqual(createFolds(SOUND_FOLDS, s).get(1440, CLOCK), { upnext: true }, "reloaded: open");
    const blocked = createFolds(SOUND_FOLDS, storage({}, true));
    assert.deepEqual(blocked.get(390, CLOCK), { upnext: true }, "storage that throws opens it");
    blocked.tap("upnext", false);
    assert.deepEqual(blocked.get(390, CLOCK), { upnext: false }, "a tap folds it for the page");
  });

  test("one key per surface, the scene settings' kept, and Ambiance's surface gone with its panel", async () => {
    assert.deepEqual(
      [SOUND_FOLDS.key, DM_PANEL_FOLDS.key, SCENES_FOLDS.key, THIS_DEVICE_FOLDS.key],
      ["rvtt.soundFolds", "rvtt.dmPanelFolds", "rvtt.sceneSettingsFolds", "rvtt.thisDeviceFolds"],
    );
    assert.deepEqual(SCENES_SECTIONS, ["light", "sound", "players", "map", "walls", "scene", "new"]);
    const exported = Object.keys(await import("./folds.ts"));
    assert.deepEqual(
      exported.filter((name) => /ambiance/i.test(name)),
      [],
      "rvtt.ambianceFolds is left in storage, read by nothing (docs/design/design-v1-sound-layout.md 3.3)",
    );
  });

  test("each surface's slot holds its own store, apart per Room page", () => {
    const a = new RoomScope();
    const b = new RoomScope();
    const slots: ScopeSlot<FoldsStore<string>>[] = [soundFoldsSlot, dmPanelFoldsSlot, scenesFoldsSlot, thisDeviceFoldsSlot] as never;
    assert.deepEqual(
      slots.map((slot) => a.get(slot).surface.key),
      ["rvtt.soundFolds", "rvtt.dmPanelFolds", "rvtt.sceneSettingsFolds", "rvtt.thisDeviceFolds"],
    );
    assert.notEqual(a.get(soundFoldsSlot), b.get(soundFoldsSlot));
  });
});

describe("what a device remembers (6.1)", () => {
  test("a stored value wins over its start, and the rest follow their starts", () => {
    const folds = createFolds(PAIR, storage({ [KEY]: JSON.stringify({ play: false }) }));
    assert.deepEqual(folds.get(390, SCENES), { start: false, play: false });
  });

  test("a stored fold wins over a start that reads the room: folded by hand with no scene, it stays folded", () => {
    const folds = createFolds(PAIR, storage({ [KEY]: JSON.stringify({ start: false }) }));
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(1440, NO_SCENE).start, false);
  });

  test("a value that is no boolean, or a key no section has, is passed over", () => {
    const folds = createFolds(PAIR, storage({ [KEY]: JSON.stringify({ start: "yes", play: 1, chip: true }) }));
    assert.deepEqual(folds.get(390, SCENES), { start: false, play: true });
  });

  test("storage that cannot be read opens every section, and taps still fold for the page", () => {
    for (const [why, s] of [
      ["storage that throws", storage({}, true)],
      ["a value that is no JSON", storage({ [KEY]: "{not json" })],
      ["a list", storage({ [KEY]: "[true]" })],
      ["null", storage({ [KEY]: "null" })],
    ] as const) {
      const folds = createFolds(PAIR, s);
      assert.deepEqual(folds.get(390, SCENES), { start: true, play: true }, why);
      assert.doesNotThrow(() => folds.tap("play", false));
      assert.equal(folds.get(390, SCENES).play, false, `${why}: the tap folds for the page`);
    }
    assert.deepEqual(createFolds(PAIR, null).get(390, SCENES), { start: true, play: true }, "no storage");
  });

  test("a tap stores its section beside the others stored, and drops what no section is", () => {
    const s = storage({ [KEY]: JSON.stringify({ start: true, chip: true, play: "yes" }) });
    const folds = createFolds(PAIR, s);
    folds.tap("play", false);
    assert.deepEqual(s.json(KEY), { start: true, play: false });
    assert.deepEqual(folds.get(390, SCENES), { start: true, play: false });
  });

  test("a tap writes beside what another tab stored after this page read it", () => {
    const s = storage();
    const folds = createFolds(PAIR, s);
    folds.get(390, SCENES);
    s.items.set(KEY, JSON.stringify({ start: true }));
    folds.tap("play", false);
    assert.deepEqual(s.json(KEY), { start: true, play: false });
  });

  test("fold a section, reload: folded", () => {
    const s = storage();
    createFolds(PAIR, s).tap("play", false);
    assert.equal(createFolds(PAIR, s).get(390, SCENES).play, false);
  });

  test("a tap that asks not to write (a preview) folds for the page and stores nothing", () => {
    const s = storage();
    const folds = createFolds(PAIR, s);
    folds.tap("play", false, false);
    assert.equal(folds.get(390, SCENES).play, false);
    assert.equal(s.writes(), 0);
    assert.equal(createFolds(PAIR, s).get(390, SCENES).play, true);
  });

  test("writeFold over storage that throws or is missing takes the tap without a throw", () => {
    assert.doesNotThrow(() => writeFold(storage({}, true), PAIR, "start", true));
    assert.doesNotThrow(() => writeFold(null, PAIR, "start", true));
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
    const s = storage({ [KEY]: JSON.stringify({ play: false }) });
    const folds = createFolds(PAIR, s);
    folds.follow(true, SCENES);
    folds.reveal("play");
    assert.equal(folds.get(390, SCENES).play, true);
    assert.equal(s.writes(), 0);
    assert.deepEqual(s.json(KEY), { play: false });
  });

  test("it ends as its panel goes from open to closed, and the stored fold shows again", () => {
    const folds = createFolds(PAIR, storage());
    folds.follow(true, SCENES);
    folds.reveal("start");
    folds.follow(true, SCENES);
    assert.equal(folds.get(390, SCENES).start, true, "still open while the panel is");
    folds.follow(false, SCENES);
    assert.equal(folds.get(390, SCENES).start, false);
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
    const folds = createFolds(PAIR, s);
    folds.follow(true, SCENES);
    folds.reveal("start");
    folds.tap("start", false);
    assert.equal(folds.get(390, SCENES).start, false);
    assert.deepEqual(s.json(KEY), { start: false });
    folds.tap("start", true);
    folds.follow(false, SCENES);
    assert.equal(folds.get(390, SCENES).start, true, "the tap, not a reveal, so closing keeps it");
  });

  test("endReveals ends every reveal at once", () => {
    const folds = createFolds(PAIR, storage({ [KEY]: JSON.stringify({ play: false }) }));
    folds.reveal("play");
    folds.reveal("start");
    folds.endReveals();
    assert.deepEqual(folds.get(390, SCENES), { start: false, play: false });
  });

  test("every change tells the page, and a listener that stopped hears nothing", () => {
    const folds = createFolds(PAIR, storage());
    let heard = 0;
    const stop = folds.subscribe(() => heard++);
    folds.follow(true, SCENES);
    folds.reveal("start");
    folds.tap("play", false);
    folds.follow(false, SCENES);
    assert.equal(heard, 4, "the hold, the reveal, the tap and the close");
    stop();
    folds.reveal("start");
    assert.equal(heard, 4);
  });
});

describe("starts that read the room (6.1, D-261102-765, D-261102-767)", () => {
  test("the room's last scene deleted on another device while Scenes is open opens nothing until it closes", () => {
    const folds = createFolds(SCENES_FOLDS, storage());
    folds.follow(true, SCENES);
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(390, NO_SCENE).new, false);
    folds.follow(false, NO_SCENE);
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(390, NO_SCENE).new, true);
  });

  test("the hold lives in the store, so a remount across 900 px, which reads it anew at another width, keeps New scene open", () => {
    const scope = new RoomScope();
    const store = scope.get(scenesFoldsSlot);
    store.follow(true, NO_SCENE);
    assert.equal(store.get(390, NO_SCENE).new, true);
    store.follow(true, SCENES);
    assert.equal(scope.get(scenesFoldsSlot).get(1440, SCENES).new, true, "the other tree reads the same store");
  });

  test("a panel open as the page loads follows the room live until the snapshot, then holds: scenes in the snapshot fold New scene", () => {
    const folds = createFolds(SCENES_FOLDS, storage());
    folds.follow(true, null);
    assert.equal(folds.get(390, NO_SCENE).new, true, "before the snapshot, the start read live");
    folds.follow(true, SCENES);
    assert.equal(folds.get(390, SCENES).new, false, "the snapshot's scenes fold it");
    folds.follow(true, NO_SCENE);
    assert.equal(folds.get(390, NO_SCENE).new, false, "held from the snapshot on");
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
    const folds = createFolds(SCENES_FOLDS, storage());
    assert.equal(folds.get(390, NO_SCENE).new, true);
    assert.equal(folds.get(390, SCENES).new, false);
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
    const local = { panel: "dm", tab: "time", below: "scenes" };
    assert.equal(panelIsOpen(local, "time", true), true);
    assert.equal(panelIsOpen(local, "scenes", true), true);
    assert.equal(panelIsOpen(local, "dm", true), false);
    assert.equal(panelIsOpen(local, "dm", false), true);
    assert.equal(panelIsOpen(local, "time", false), false);
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

/** Draws a component that reads the pair's folds as a group would, in a Room with scenes or none, as a preview or not, its stores made over `s`. */
function drawn(options: { scenes: boolean; preview?: boolean; storage?: ReturnType<typeof storage> }) {
  return withStorage(options.storage ?? storage(), () => draw(options));
}

function draw(options: { scenes: boolean; preview?: boolean }) {
  const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  if (!options.scenes) view.scenes = {};
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  const scope = new RoomScope();
  const seen: Record<string, { open: boolean; onToggle(): void }> = {};
  function Probe() {
    const fold = useFolds(pairFoldsSlot);
    for (const s of PAIR.sections) seen[s] = fold(s);
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
  return { seen: seen as Record<PairSection, { open: boolean; onToggle(): void }>, scope };
}

describe("useFolds, as a surface's groups read it", () => {
  test("it reads the room's scenes for a start that reads the room", () => {
    assert.equal(drawn({ scenes: true }).seen.start.open, false);
    assert.equal(drawn({ scenes: false }).seen.start.open, true);
  });

  test("onToggle flips its section in the Room's store", () => {
    const { seen, scope } = drawn({ scenes: true });
    seen.play.onToggle();
    assert.equal(scope.get(pairFoldsSlot).get(390, SCENES).play, false);
  });

  test("in a preview a tap folds for its page and writes nothing", () => {
    const s = storage();
    const preview = drawn({ scenes: true, preview: true, storage: s });
    preview.seen.play.onToggle();
    assert.equal(preview.scope.get(pairFoldsSlot).get(390, SCENES).play, false);
    assert.equal(s.writes(), 0, "a preview writes nothing");
    const own = drawn({ scenes: true, storage: s });
    own.seen.play.onToggle();
    assert.equal(s.writes(), 1, "the DM's own page writes its tap");
  });

  test("it reads what the device stored", () => {
    assert.equal(drawn({ scenes: true, storage: storage({ [KEY]: JSON.stringify({ start: true }) }) }).seen.start.open, true);
  });
});

describe("the store through any order of events (property)", () => {
  type Event =
    | { t: "open" }
    | { t: "close" }
    | { t: "snapshot" }
    | { t: "scenes"; on: boolean }
    | { t: "tap"; section: PairSection; open: boolean; write: boolean }
    | { t: "reveal"; section: PairSection }
    | { t: "read"; width: number };
  const section = fc.constantFrom(...PAIR.sections);
  const event: fc.Arbitrary<Event> = fc.oneof(
    fc.constant({ t: "open" } as const),
    fc.constant({ t: "close" } as const),
    fc.constant({ t: "snapshot" } as const),
    fc.boolean().map((on) => ({ t: "scenes", on }) as const),
    fc.record({ section, open: fc.boolean(), write: fc.boolean() }).map((e) => ({ t: "tap", ...e }) as const),
    section.map((s) => ({ t: "reveal", section: s }) as const),
    fc.constantFrom(320, 899, 900, 1440).map((width) => ({ t: "read", width }) as const),
  );

  test("named invariants hold through 1,000 random sequences", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), fc.option(fc.constantFrom(JSON.stringify({ start: true }), JSON.stringify({ play: false }), "{bad"), { nil: null }), (events, initial) => {
        const s = storage(initial === null ? {} : { [KEY]: initial });
        const folds = createFolds(PAIR, s);
        let open = false;
        let loaded = false;
        let scenes = false;
        let width = 390;
        const revealed = new Set<PairSection>();
        const tapped = new Map<PairSection, boolean>();
        let written = 0;
        let prev = folds.get(width, { clock: false, scenes });
        for (const e of events) {
          let changedBy: PairSection | null = null;
          if (e.t === "open") open = true;
          if (e.t === "close") {
            // Only a change from open to closed ends the reveals.
            if (open) revealed.clear();
            open = false;
          }
          if (e.t === "snapshot") loaded = true;
          if (e.t === "scenes") scenes = e.on;
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
          const live: FoldRoom = { clock: false, scenes };
          // Room's effect runs after each change, as useEndRevealsOnClose's does.
          folds.follow(open, loaded ? live : null);
          const now = folds.get(width, live);
          for (const r of revealed) assert.equal(now[r], true, "a revealed section shows open until a tap or a close");
          for (const [t, v] of tapped) if (!revealed.has(t)) assert.equal(now[t], v, "a tapped section shows its last tap");
          assert.equal(s.writes(), written, "only a tap that writes touches storage, never a reveal, a hold or a close");
          // While the panel stays open with the snapshot in, nothing moves under the DM's finger but what was tapped or revealed.
          if (open && loaded && e.t !== "open" && e.t !== "close" && e.t !== "snapshot") {
            for (const x of PAIR.sections) if (x !== changedBy) assert.equal(now[x], prev[x], `${x} held while open after ${JSON.stringify(e)}`);
          }
          if (e.t === "read") assert.equal(now, prev, "a read at another width refolds nothing");
          prev = now;
        }
      }),
      { numRuns: 1000 },
    );
  });
});
