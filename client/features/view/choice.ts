import { createStore, type StoreApi } from "zustand/vanilla";
import type { Scene } from "#shared/model.ts";
import type { Turn, View, ViewKind } from "../../lib/view.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import { FOLLOW_THE_SCENE, isoReady, type StoredView, type ViewPick } from "./store.ts";

/*
 * The view choice's rules and words (docs/design-v1-isometric-view.md 7
 * and 8): what the View button, its menu, the keys I, Q and E, a scene's
 * Suggested view and the table display's rows say and do. The pick itself
 * is stored by store.ts. The components are ViewMenu.tsx's.
 */

/** The global an end-to-end test sets before the app's first script runs, so the choice can be built and tested before Isometric is ready. */
export const ISO_TEST_FLAG = "__rvttIsoTest";

/**
 * Whether this page offers the isometric view at all: the View button and
 * its menu, a scene's Suggested view, the display's rows and the keys. Once
 * `isoReady` is on, everywhere. Until then only on a page an end-to-end test
 * opened with ISO_TEST_FLAG set (e2e/iso.e2e.ts), so a user sees nothing
 * new: no control, stored value or address sets it. Read once, as the page
 * loads.
 */
export const isoOffered: boolean = isoReady || (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true;

/** What the menu's radio group holds: the pick, with Follow the scene for none. */
export type ViewChoice = "follow" | ViewKind;

/** The menu's rows, in order. */
export const VIEW_CHOICES: readonly ViewChoice[] = ["follow", "topDown", "isometric"];

export const choiceOf = (pick: ViewPick): ViewChoice => pick ?? "follow";
export const pickOf = (choice: ViewChoice): ViewPick => (choice === "follow" ? null : choice);

/** The view a scene suggests, Top-down where it suggests none. */
export const suggestedKind = (suggested: Scene["suggestedView"]): ViewKind => (suggested === "isometric" ? "isometric" : "topDown");

/** The view the user wants on this scene, before any tool shows Top-down: the pick, else the scene's suggestion. */
export const wantedKind = (stored: StoredView, suggested: Scene["suggestedView"]): ViewKind => stored.pick ?? suggestedKind(suggested);

// ---------------------------------------------------------------- the tools that show Top-down

/**
 * The tools that show Top-down while in use (section 6.4), by tool id, with
 * their line's subject. "Traps" takes "work", the others "works".
 */
const TOP_DOWN_TOOLS: Readonly<Record<string, string>> = {
  build: "The map builder works",
  fog: "Fog works",
  grid: "Line up grid works",
  trap: "Traps work",
};

/** The tool in use when it shows Top-down, else null. */
export function topDownTool(tool: string | null | undefined): string | null {
  return tool !== null && tool !== undefined && Object.hasOwn(TOP_DOWN_TOOLS, tool) ? tool : null;
}

/** The line the menu and the tool's options show while a tool shows Top-down: "The map builder works top-down. Isometric comes back when you switch tools." */
export function topDownLine(tool: string | null | undefined): string | null {
  const id = topDownTool(tool);
  return id === null ? null : `${TOP_DOWN_TOOLS[id]} top-down. Isometric comes back when you switch tools.`;
}

/**
 * The tool's line as the menu shows it: only while the tool hides the
 * Isometric the user wants, since a user who wants Top-down gets no
 * Isometric back when they switch tools.
 */
export function menuLine(choice: { forcedBy: string | null; wanted: ViewKind }): string | null {
  return choice.wanted === "isometric" ? topDownLine(choice.forcedBy) : null;
}

// ---------------------------------------------------------------- the words

export const VIEW_NAMES: Readonly<Record<ViewKind, string>> = { topDown: "Top-down", isometric: "Isometric" };

/** A row's words in the menu and on the display. */
export const choiceWords = (c: ViewChoice): string => (c === "follow" ? "Follow the scene" : VIEW_NAMES[c]);

/** The View button's name, from the view the board shows. */
export const viewButtonLabel = (shown: View): string => `View: ${VIEW_NAMES[shown.kind]}`;

/** The View button's tooltip. */
export const VIEW_TIP = "Change the view";

/** The menu's group, and the display's. */
export const VIEW_GROUP = "View";

/** The help under Follow the scene. */
export const suggestionHelp = (suggested: Scene["suggestedView"]): string => `This scene suggests ${VIEW_NAMES[suggestedKind(suggested)]}.`;

/** Scene settings' row. */
export const SUGGESTED_VIEW = "Suggested view";
export const SUGGESTED_VIEW_HELP = "Devices that follow the scene show this view.";

/** The turn buttons' names are their words, and their descriptions say what turns (D-261026-11). */
export const TURN_LEFT = "Turn left";
export const TURN_RIGHT = "Turn right";
export const TURN_LEFT_DESCRIPTION = "Turn the map left";
export const TURN_RIGHT_DESCRIPTION = "Turn the map right";

/** Q or E while the board shows Top-down. */
export const TURN_NEEDS_ISOMETRIC = "Turning needs the isometric view.";

/** Why the popover's turn buttons are disabled in Top-down. */
export const TURNING_WORKS_IN_ISOMETRIC = "Turning works in Isometric.";

/** Where the map's top edge faces at each turn (section 4.1's table). */
const FACES: Readonly<Record<Turn, string>> = { 0: "up and to the right", 1: "down and to the right", 2: "down and to the left", 3: "up and to the left" };

export const kindSaid = (kind: ViewKind): string => (kind === "isometric" ? "Isometric view." : "Top-down view.");
export const followSaid = (kind: ViewKind): string => `Following the scene: ${kind === "isometric" ? "isometric" : "top-down"}.`;
export const turnedSaid = (by: 1 | -1, turn: Turn): string => `Turned ${by === 1 ? "right" : "left"}. The map's top edge faces ${FACES[turn]}.`;

// ---------------------------------------------------------------- what the status says

/** What the polite status compares from one render to the next. */
export type ViewState = {
  sceneId: string | null;
  shown: View;
  pick: ViewPick;
  /** The view the user wants here, before a tool shows Top-down. */
  wanted: ViewKind;
  /** The tool in use that shows Top-down, else null. */
  forcedBy: string | null;
};

/**
 * What the polite status says for a change (section 8), or null: the
 * tool's line once per tool choice that hides Isometric, "Following the
 * scene: ..." when the user picks it again, "Isometric view." or
 * "Top-down view." when the board changes view, and the turn's line when
 * it turns. A new scene has a turn of its own, which is no turn of the
 * map, so it says only a change of view.
 */
export function viewSaid(before: ViewState, after: ViewState): string | null {
  if (after.forcedBy !== null && after.forcedBy !== before.forcedBy && after.wanted === "isometric") return topDownLine(after.forcedBy);
  if (after.pick === null && before.pick !== null) return followSaid(after.wanted);
  if (after.shown.kind !== before.shown.kind) return kindSaid(after.shown.kind);
  if (after.sceneId !== before.sceneId || after.shown.kind !== "isometric" || before.shown.kind !== "isometric" || after.shown.turn === before.shown.turn) return null;
  // One step each way, as the buttons and keys turn: three steps right is one left.
  return turnedSaid((after.shown.turn - before.shown.turn + 4) % 4 === 3 ? -1 : 1, after.shown.turn);
}

/**
 * Why the popover's turns are disabled, or null while the board is
 * Isometric and they turn it: the tool's line while a tool hides the
 * Isometric wanted, else that turning works in Isometric (D-261026-12).
 */
export function turnsReason(choice: { shown: View; forcedBy: string | null; wanted: ViewKind }): string | null {
  return choice.shown.kind === "isometric" ? null : (menuLine(choice) ?? TURNING_WORKS_IN_ISOMETRIC);
}

/**
 * What I does (section 6.5): picks the other view than the one wanted. A
 * tool that shows Top-down keeps it showing, so the key says the tool's
 * line where the pick is Isometric. The view's own change is said by the
 * status as the board changes, so `toast` is only for a press the board
 * does not show.
 */
export function otherViewPress(stored: StoredView, suggested: Scene["suggestedView"], tool: string | null | undefined): { pick: ViewKind; toast: string | null } {
  const pick: ViewKind = wantedKind(stored, suggested) === "isometric" ? "topDown" : "isometric";
  return { pick, toast: pick === "isometric" ? topDownLine(tool) : null };
}

/**
 * What Q or E says where it cannot turn: the tool's line while a tool
 * hides the Isometric the user wants, else that turning needs Isometric.
 */
export function turnRefused(stored: StoredView, suggested: Scene["suggestedView"], tool: string | null | undefined): string {
  return (wantedKind(stored, suggested) === "isometric" ? topDownLine(tool) : null) ?? TURN_NEEDS_ISOMETRIC;
}

// ---------------------------------------------------------------- the room's slots

/**
 * The status's words, per Room page. A slot of its own, so a change
 * re-renders the status alone. `key` is new each time, so words that
 * repeat are said again.
 */
export const viewVoiceSlot = scopeSlot<StoreApi<{ key: number; text: string }>>(() => createStore(() => ({ key: 0, text: "" })));

export function sayView(scope: RoomScope, text: string): void {
  const voice = scope.get(viewVoiceSlot);
  voice.setState({ key: voice.getState().key + 1, text });
}

/**
 * "View as a player" keeps a view of its own, never saved, as nothing in
 * it is (features/dm/PlayerPreview.tsx): the preview's Room page holds its
 * pick and turns here, in its own scope, and leaves the DM's pick, turns and
 * this device's storage as they were (ISO5-ASTRA-02). It starts following
 * the scene, as a player's new device does.
 */
export const previewViewSlot = scopeSlot<StoreApi<StoredView>>(() => createStore<StoredView>(() => FOLLOW_THE_SCENE));

/**
 * Whether a gesture on the map is under way: a drag, a pinch or a ruler
 * held. The board sets it (canvas/Stage.tsx), and a new suggestion or a
 * turn waits for it to end (ISO-D3, store.ts settledView).
 */
export const viewGestureSlot = scopeSlot<StoreApi<{ active: boolean }>>(() => createStore(() => ({ active: false })));
