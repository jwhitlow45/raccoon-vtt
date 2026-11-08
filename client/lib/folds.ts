import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { layoutWidth } from "../features/device/layout.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { scopeSlot, useScoped, type ScopeSlot } from "../state/scope.ts";
import type { LocalUi, RoomView } from "../state/types.ts";
import { useRoomView } from "../state/view.ts";
import { theme } from "./theme.ts";

/*
 * The folding sections of four surfaces, Sound, the DM panel, Scenes and
 * This device (docs/design/design-v1-panel-groups.md 6.1,
 * docs/design/design-v1-sound-layout.md 4.3): which sections show
 * open, as this device last left them, with the scene settings' rule
 * (features/scenes/settingsFolds.ts) made general. One store per surface, in
 * the Room scope, so the sheet and the side panel, which draw in separate
 * trees, read the same folds, and a turn across 900 px, which remounts the
 * panel in the other tree, never refolds anything. The Token and Dice
 * panels keep their own stores: this rule is for these surfaces alone.
 *
 * What a section shows, in order of strength:
 * 1. A reveal: open for now, never written (a request, a paste, a waiting
 *    upload). It lasts until its panel goes from open to closed, or a tap on
 *    that header.
 * 2. The device's own tap, stored per surface.
 * 3. The start, at the layout width of the page's first read. A start
 *    may read the room, as New scene's does (open with no scene): read as
 *    the panel opens and held until it closes, and held only once the room's
 *    snapshot is in (D-261102-765, D-261102-767).
 * Storage that cannot be read opens every section, so a setting is never
 * hidden behind a fold this device cannot keep. Taps still fold for the page.
 */

/** What a start may read of the room: whether a clock runs, and whether the room holds any scene. */
export type FoldRoom = { readonly clock: boolean; readonly scenes: boolean };

/** Whether each section shows open. */
export type FoldValues<S extends string> = Readonly<Record<S, boolean>>;

export type FoldSurface<S extends string> = {
  /** The localStorage key: one per surface, so a bad value spoils one surface only. */
  readonly key: string;
  readonly sections: readonly S[];
  /** Where each section starts with nothing stored, at a layout width and for the room. */
  starts(width: number, room: FoldRoom): FoldValues<S>;
};

export type FoldStorage = Pick<Storage, "getItem" | "setItem">;

export type FoldsStore<S extends string> = {
  readonly surface: FoldSurface<S>;
  /**
   * The folds now. The width counts at the first read alone, so a turn
   * across 900 px refolds nothing. `room` is the room as it is now: a start
   * that reads it uses the room held while the panel is open, else this.
   */
  get(width: number, room: FoldRoom): FoldValues<S>;
  /** The viewer's tap on a header. It ends that section's reveal and is stored, except where `write` is false: "view as a player" folds for its page alone. */
  tap(section: S, open: boolean, write?: boolean): void;
  /** Opens a section for now, writing nothing (6.1). A reveal made while the panel is closed waits for it to open. */
  reveal(section: S): void;
  /** Ends every reveal. Room does this as the panel closes (`follow`). */
  endReveals(): void;
  /**
   * Room's part (useEndRevealsOnClose): whether the panel is open, and the
   * room once its snapshot is in, else null. Closed to open holds the
   * room's starts, or the first call after the snapshot does while the panel
   * stays open. Open to closed lets the hold go and ends every reveal.
   */
  follow(open: boolean, room: FoldRoom | null): void;
  subscribe(listener: () => void): () => void;
};

/** The setup rule outside Sound (6.1): open from 900 px of layout width, folded below it, as the scene settings' groups start. */
function wideAt(width: number): boolean {
  return width >= theme.layout.wideMinWidth;
}

/** What storage holds: an object, nothing (no key yet), or null when it cannot be read (no storage, a throw, or a value that is no object). */
function stored(storage: Pick<Storage, "getItem"> | null, key: string): Record<string, unknown> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Stores one section's fold beside what is already stored, so a section never tapped keeps following its start. A key no section has is dropped. */
export function writeFold<S extends string>(storage: FoldStorage | null, surface: FoldSurface<S>, section: S, open: boolean): void {
  try {
    if (!storage) return;
    const from = stored(storage, surface.key) ?? {};
    const next: Record<string, boolean> = {};
    for (const s of surface.sections) if (typeof from[s] === "boolean") next[s] = from[s] as boolean;
    next[section] = open;
    storage.setItem(surface.key, JSON.stringify(next));
  } catch {
    // Private mode or storage full: the fold lasts for this Room, which is all a blocked storage allows.
  }
}

function deviceStorage(): FoldStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createFolds<S extends string>(surface: FoldSurface<S>, storage: FoldStorage | null = deviceStorage()): FoldsStore<S> {
  const listeners = new Set<() => void>();
  // Read from storage at the first read or tap, then kept: this page's taps change it, and other tabs' do not.
  let values: Partial<Record<S, boolean>> | null = null;
  let readable = true;
  let width: number | null = null;
  let held: FoldRoom | null = null;
  let wasOpen = false;
  const revealed = new Set<S>();
  // The last answer, kept while nothing in it changes: useSyncExternalStore needs the same object back.
  let last: FoldValues<S> | null = null;

  const load = (): Partial<Record<S, boolean>> => {
    if (values) return values;
    const from = stored(storage, surface.key);
    readable = from !== null;
    values = {};
    for (const s of surface.sections) {
      const value = from?.[s];
      if (typeof value === "boolean") values[s] = value;
    }
    return values;
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    surface,
    get(at, room) {
      const taps = load();
      width ??= at;
      const starts = surface.starts(width, held ?? room);
      const next = {} as Record<S, boolean>;
      for (const s of surface.sections) next[s] = revealed.has(s) || (taps[s] ?? (readable ? starts[s] : true));
      if (last && surface.sections.every((s) => last![s] === next[s])) return last;
      last = next;
      return next;
    },
    tap(section, open, write = true) {
      load()[section] = open;
      revealed.delete(section);
      if (write) writeFold(storage, surface, section, open);
      notify();
    },
    reveal(section) {
      revealed.add(section);
      notify();
    },
    endReveals() {
      if (revealed.size === 0) return;
      revealed.clear();
      notify();
    },
    follow(open, room) {
      const was = wasOpen;
      wasOpen = open;
      if (open) {
        // Closed to open, or the snapshot's first arrival while open: the start is read now and kept until the panel closes.
        if (held === null && room !== null) {
          held = room;
          notify();
        }
        return;
      }
      if (!was) return;
      held = null;
      revealed.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A surface's store for each Room page (state/scope.ts), so a "view as a player" preview folds apart from the DM's own page. */
export function foldsSlot<S extends string>(surface: FoldSurface<S>): ScopeSlot<FoldsStore<S>> {
  return scopeSlot(() => createFolds(surface));
}

/* The surfaces (6.2). A play section starts open everywhere, a setup section by wideAt, and Sound's Up next folded everywhere. */

/*
 * Ambiance's surface went with its panel (docs/design/design-v1-sound-layout.md
 * 3.3). `rvtt.ambianceFolds` stays in storage unread: two booleans no other
 * key reads, so clearing them would be code for nothing.
 */

/** The Sound panel's one fold, Up next under the player (docs/design/design-v1-sound-layout.md 4.3). */
export const SOUND_SECTIONS = ["upnext"] as const;
export type SoundSection = (typeof SOUND_SECTIONS)[number];

/**
 * Up next starts folded on every width: open on a 12-track playlist it
 * pushes Effects, used in every scene, below the side panel's first screen
 * at 1440 x 900, and folded it still names the next track in its summary.
 */
export const SOUND_FOLDS: FoldSurface<SoundSection> = {
  key: "rvtt.soundFolds",
  sections: SOUND_SECTIONS,
  starts: () => ({ upnext: false }),
};
export const soundFoldsSlot = foldsSlot(SOUND_FOLDS);

/** Join requests is never a fold, so it has no key. */
export const DM_PANEL_SECTIONS = ["handouts", "screens", "check", "link", "display"] as const;
export type DmPanelSection = (typeof DM_PANEL_SECTIONS)[number];

export const DM_PANEL_FOLDS: FoldSurface<DmPanelSection> = {
  key: "rvtt.dmPanelFolds",
  sections: DM_PANEL_SECTIONS,
  starts: (width) => {
    const wide = wideAt(width);
    return { handouts: true, screens: true, check: wide, link: wide, display: wide };
  },
};
export const dmPanelFoldsSlot = foldsSlot(DM_PANEL_FOLDS);

/**
 * The scene settings' six groups (docs/design/design-v1-scenes-reorg.md 3):
 * Floors (`floors`, last in the list so a device's stored folds keep their
 * order and a new key reads as the start), Light and weather (`light`), Scene sound (`sound`), Fog and vision
 * (`players`, What players see's key, so a device's fold of it carries
 * over), Map and grid (`map`), Walls and movement (`walls`) and Size and
 * view (`scene`), and New scene. All scenes, the scene's name and Export
 * never fold.
 */
export const SCENES_SECTIONS = ["light", "sound", "players", "map", "walls", "scene", "new", "floors"] as const;
export type ScenesSection = (typeof SCENES_SECTIONS)[number];

/**
 * The key the scene settings' folds have always had, so a device's folds
 * carry over. Light and weather is the one group used in play, so it opens
 * everywhere (D-261102-862). Fog and vision is setup now that Light has
 * left it: in play the DM changes fog with the Fog tool. New scene starts
 * open while the room has no scene to set up.
 */
export const SCENES_FOLDS: FoldSurface<ScenesSection> = {
  key: "rvtt.sceneSettingsFolds",
  sections: SCENES_SECTIONS,
  starts: (width, room) => {
    const wide = wideAt(width);
    return { light: true, sound: wide, players: wide, map: wide, walls: wide, scene: wide, new: wide || !room.scenes, floors: wide };
  },
};
export const scenesFoldsSlot = foldsSlot(SCENES_FOLDS);

export const THIS_DEVICE_SECTIONS = ["size", "theme", "screen", "battery", "mapDetail", "weather", "sounds", "rolls", "shortcuts", "handle", "tabRow"] as const;
export type ThisDeviceSection = (typeof THIS_DEVICE_SECTIONS)[number];

/** Every section of This device is setup. */
export const THIS_DEVICE_FOLDS: FoldSurface<ThisDeviceSection> = {
  key: "rvtt.thisDeviceFolds",
  sections: THIS_DEVICE_SECTIONS,
  starts: (width) => {
    const wide = wideAt(width);
    return { size: wide, theme: wide, screen: wide, battery: wide, mapDetail: wide, weather: wide, sounds: wide, rolls: wide, shortcuts: wide, handle: wide, tabRow: wide };
  },
};
export const thisDeviceFoldsSlot = foldsSlot(THIS_DEVICE_FOLDS);

/** What the starts read of a view: a DM's holds the clock whole and every scene. */
export function foldRoomOf(view: RoomView["view"]): FoldRoom {
  return { clock: !!view?.clock, scenes: Object.keys(view?.scenes ?? {}).length > 0 };
}

function useFoldRoom(): FoldRoom {
  const clock = useRoomView((s) => foldRoomOf(s.view).clock);
  const scenes = useRoomView((s) => foldRoomOf(s.view).scenes);
  return useMemo(() => ({ clock, scenes }), [clock, scenes]);
}

/**
 * A section's fold for its `Group`, `open` and `onToggle`, kept up to date
 * with every tap, reveal and change of the room. In "view as a player" a
 * tap folds for the preview's page and writes nothing.
 */
export function useFolds<S extends string>(slot: ScopeSlot<FoldsStore<S>>): (section: S) => { open: boolean; onToggle(): void } {
  const store = useScoped(slot);
  const write = usePreview() === null;
  const room = useFoldRoom();
  const read = () => store.get(layoutWidth(), room);
  // The same reader serves a render to markup, so a render test can draw a surface.
  const folds = useSyncExternalStore(store.subscribe, read, read);
  return (section) => ({ open: folds[section], onToggle: () => store.tap(section, !read()[section], write) });
}

/**
 * Whether a panel is open for its folds: the side panel's tab or the pane
 * below from 900 px up, else the phone's sheet, a hidden side panel or
 * sheet included, as Room reads Time's (pages/Room.tsx). `panel` and `tab`
 * do not change as the layout crosses 900 px, so neither does this.
 */
export function panelIsOpen(local: Pick<LocalUi, "panel" | "tab" | "below">, id: string, wide: boolean): boolean {
  return wide ? local.tab === id || local.below === id : local.panel === id;
}

/**
 * Room's part for a surface's panel (6.1): ends its reveals and lets its
 * held starts go when the panel goes from open to closed, and holds the
 * starts on closed to open, or at the snapshot's arrival while it is open.
 * In Room rather than the panel, since the panel remounts in the other tree
 * when the layout crosses 900 px, and a reveal raised while the panel is
 * closed must wait for it. `wide` is Room's own.
 */
export function useEndRevealsOnClose<S extends string>(panelId: string, slot: ScopeSlot<FoldsStore<S>>, wide: boolean): void {
  const store = useScoped(slot);
  const open = useRoomView((s) => panelIsOpen(s.local, panelId, wide));
  const loaded = useRoomView((s) => s.view !== null);
  const room = useFoldRoom();
  useLayoutEffect(() => store.follow(open, loaded ? room : null), [store, open, loaded, room]);
}
