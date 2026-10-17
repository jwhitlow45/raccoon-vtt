import { useEffect, useRef } from "react";
import type { Token } from "#shared/model.ts";
import { drawsAllowed } from "#shared/permissions.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { fitSlot } from "../canvas/fitSlot.ts";
import { ownsEntry, sortedEntries, turnOp, turnStatus } from "../features/encounter/logic.ts";
import { tokenAccess } from "../features/tokens/access.ts";
import { PLACE_TOOL_ID } from "../features/tokens/placement.ts";
import { displayName } from "../lib/scene.ts";
import { scopeSlot, type RoomScope } from "./scope.ts";
import { tuckEvent } from "./toolbar.ts";
import type { RoomUi } from "./store.ts";
import type { RoomActions, RoomView } from "./types.ts";
import { useRoomActions, useRoomStore, useRoomUi } from "./view.ts";

/**
 * The room's keyboard shortcuts (features 13, docs/design-v1-dm-tools.md
 * 3.14): one table of key, roles, condition and action, and one window
 * listener the Room page mounts. Undo and redo are two rows of it.
 *
 * A shortcut never fires:
 * - while focus is in a field (isTextField), where the keys are typing,
 * - while a modal dialog is open (Escape stays the dialog's own),
 * - inside "view as a player", where every key but Escape is ignored. The
 *   preview mounts a second Room page, and Ctrl+Z there used to undo the
 *   DM's real last change through the DM's page behind it, whose listener
 *   now finds a modal dialog open and does nothing,
 * - with Ctrl, Cmd or Alt held, so the browser's own shortcuts stay, except
 *   for undo and redo, which are Ctrl or Cmd with Z,
 * - on a held key's repeats: undo waits for the server, and a held arrow
 *   would queue a dozen moves before the first answer showed.
 *
 * Letters match as undo always has: by `key` when it is a Latin letter, so a
 * French or German layout's letters work where they are printed, and by
 * `code` only otherwise, so a Cyrillic or Greek layout still reaches them.
 * Symbols match by `key` alone, with Shift allowed, since their keys differ
 * between layouts and `?` takes Shift on most of them.
 */

/** The parts of a keydown event the shortcut reads, so the rule can be tested without a DOM. */
export type KeyPress = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  target: unknown;
};

/** Input types that take no typing, where Ctrl+Z has nothing of its own to undo. */
const NOT_TYPED = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/** Whether focus is somewhere the keys belong to the field: a text field, or a select box, which picks by typed letters. */
export function isTextField(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NOT_TYPED.has(typeof el.type === "string" ? el.type.toLowerCase() : "text");
}

/** The groups whose arrow and Page keys move their own choice, value, tab or item, and the split's bar, whose grip is a separator they move (docs/design-v1-split-panel.md 9.1). */
const NAVIGATES = '[role="radiogroup"], [role="slider"], [role="tablist"], [role="listbox"], [role="menu"], [role="separator"]';

/**
 * Whether focus is on a control that answers the arrow and Page keys
 * itself: a native radio (Segmented, Swatches, design 2.3), a range
 * slider, or anything inside a radio group, slider, tab list, list box or
 * menu. There the keys choose, so the map's shortcuts on the same keys stand
 * aside: with a token selected, ArrowRight on the HP modes moved the token
 * and left the mode as it was. A tab list says the arrows switch its
 * tabs, so a screen reader user pressing one there must never move a
 * token every player sees. A menu (components/Menu.tsx) leaves Left and
 * Right alone in a list, and those must not move a token either.
 */
export function ownsNavigationKeys(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; type?: unknown; closest?: (selector: string) => unknown };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
  if (tag === "INPUT" && (type === "radio" || type === "range")) return true;
  return typeof el.closest === "function" && el.closest(NAVIGATES) != null;
}

/** The Latin letter a press means, lowercase, or null: by `key`, or by `code` when the key types another script. */
export function letterOf(e: Pick<KeyPress, "key" | "code">): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  if ([...e.key].length === 1 && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return null;
}

/**
 * Ctrl+Z or Cmd+Z undoes, and with Shift redoes (features 13). They do
 * nothing while typing in a text field, where the field's own undo is the
 * one meant.
 */
export function undoShortcut(e: KeyPress): "undo" | "redo" | null {
  if (e.defaultPrevented || e.repeat || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  if (letterOf(e) !== "z" || isTextField(e.target)) return null;
  return e.shiftKey ? "redo" : "undo";
}

/** What a shortcut works with: the Room page's state, actions and its own scope. */
export type ShortcutEnv = {
  role: "dm" | "player";
  /** The toolbar's tools for the role (features/tools.ts toolsFor), passed in so this table loads without them. */
  tools: readonly { id: string }[];
  getState(): RoomView;
  actions: RoomActions;
  ui: RoomUi;
  scope: RoomScope;
};

export type Shortcut = {
  id: string;
  /** How the shortcut sheet writes the key. */
  keys: string;
  /** What it does, for the sheet. */
  does: string;
  roles: readonly ("dm" | "player")[];
  /** Ctrl or Cmd with the key: undo and redo only. */
  modifier?: true;
  match(e: KeyPress): boolean;
  /** Whether it applies now. Left out, whenever the role has it. */
  when?(env: ShortcutEnv): boolean;
  /** Arrow or Page keys, which a focused choice group or slider keeps for itself (ownsNavigationKeys). */
  navigation?: true;
  run(env: ShortcutEnv, e: KeyPress): void;
};

/**
 * The map canvas's part (canvas/Stage.tsx): moving the selection a square
 * and zooming about the middle, which need the camera and the drop rules
 * it holds. Per Room page, as the canvas is.
 */
export const stageKeysSlot = scopeSlot(() => ({
  nudge: null as ((dx: number, dy: number) => void) | null,
  zoom: null as ((factor: number) => void) | null,
}));

/**
 * The side panel's S (docs/design-v1-layout-hierarchy.md 4.1): the Room
 * page sets `toggle` while its layout is 900 px or wider, where there is a
 * side panel, and clears it below, so S does nothing on a phone.
 */
export const sidePanelKeysSlot = scopeSlot(() => ({ toggle: null as (() => void) | null }));

/**
 * O between the side panel's two panels (docs/design-v1-split-panel.md
 * 9.4): the Room page sets `other` while two show and clears it otherwise,
 * so O does nothing with one panel or on a phone.
 */
export const splitKeysSlot = scopeSlot(() => ({ other: null as (() => void) | null }));

/** The outliner's search takes focus when it next shows, after `/` (features/outliner). */
export const outlinerSearchSlot = scopeSlot(() => ({ focusNext: false, listeners: new Set<() => void>() }));

/** The shortcut sheet's open state, which `?` and Menu, This device both set (features/device). */
export const shortcutSheetSlot = scopeSlot(() => ({ open: false, listeners: new Set<() => void>() }));

export function setShortcutSheet(scope: RoomScope, open: boolean): void {
  const sheet = scope.get(shortcutSheetSlot);
  if (sheet.open === open) return;
  sheet.open = open;
  for (const listener of sheet.listeners) listener();
}

const letter = (l: string) => (e: KeyPress) => letterOf(e) === l;
const keyIs =
  (...keys: string[]) =>
  (e: KeyPress) =>
    keys.includes(e.key);

function selectedTokens(env: ShortcutEnv): Token[] {
  const s = env.getState();
  return s.local.selectedIds.flatMap((id) => {
    const t = s.view?.tokens[id];
    return t && t.sceneId === s.sceneId ? [t] : [];
  });
}

function toolShortcut(id: string, key: string, does: string, roles: Shortcut["roles"]): Shortcut {
  return {
    id: `tool:${id}`,
    keys: key.toUpperCase(),
    does,
    roles,
    match: letter(key),
    when: (env) => {
      if (!env.tools.some((t) => t.id === id)) return false;
      if (id !== "draw" || env.role === "dm") return true;
      // The Draw tool's own rule (docs/design-v1-dm-tools.md 3.9).
      const s = env.getState();
      return drawsAllowed(s.view?.meta.settings ?? {}, s.you?.memberId ?? "");
    },
    // The key of the tool in use shows its tucked options again, and never tucks them, so a held or repeated key never hides them (docs/design-v1-tool-options.md 5.5).
    run: (env) => {
      if (env.getState().local.tool === id) tuckEvent(env.scope, id, { kind: "show", tool: id });
      else env.ui.setTool(id);
    },
  };
}

/** Sends ops for several tokens as one undo step. */
function dispatchAll(env: ShortcutEnv, ops: readonly ClientOp[]): void {
  const group = ops.length > 1 ? env.actions.newId() : undefined;
  for (const op of ops) env.actions.dispatch(op, group ? { group } : undefined);
}

/** A selection over the protocol's 100 tokens a many-op goes out in batches. */
function batches<T>(list: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const withSelection = (env: ShortcutEnv) => selectedTokens(env).length > 0;

/** One press of +, and of - the other way. */
export const ZOOM_STEP = 1.25;

function elevatable(env: ShortcutEnv): Token[] {
  const s = env.getState();
  return selectedTokens(env).filter((t) => tokenAccess({ role: env.role, memberId: s.you?.memberId, view: s.view, token: t }).canEditToken("elevation"));
}

/** "Deleted Goblin 2. Ctrl+Z brings it back." or "Deleted 3 tokens. Ctrl+Z brings them back." */
export function deletedText(names: readonly string[]): string {
  return names.length === 1 ? `Deleted ${names[0]}. Ctrl+Z brings it back.` : `Deleted ${names.length} tokens. Ctrl+Z brings them back.`;
}

/** Every shortcut, one per line, in the order the sheet lists them. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "undo",
    keys: "Ctrl+Z",
    does: "Undo your last change",
    roles: ["dm", "player"],
    modifier: true,
    match: (e) => letterOf(e) === "z" && !e.shiftKey,
    run: (env) => env.actions.undo(),
  },
  {
    id: "redo",
    keys: "Ctrl+Shift+Z",
    does: "Redo what you undid",
    roles: ["dm", "player"],
    modifier: true,
    match: (e) => letterOf(e) === "z" && e.shiftKey,
    run: (env) => env.actions.redo(),
  },
  toolShortcut("select", "v", "Select", ["dm", "player"]),
  toolShortcut("ruler", "r", "Ruler", ["dm", "player"]),
  toolShortcut("area", "a", "Area", ["dm", "player"]),
  toolShortcut("draw", "d", "Draw", ["dm", "player"]),
  toolShortcut("ping", "p", "Ping", ["dm", "player"]),
  toolShortcut(PLACE_TOOL_ID, "t", "Add token", ["dm"]),
  toolShortcut("pin", "m", "Pin", ["dm"]),
  toolShortcut("fog", "f", "Fog", ["dm"]),
  toolShortcut("build", "b", "Builder", ["dm"]),
  toolShortcut("grid", "g", "Grid", ["dm"]),
  {
    id: "nudge",
    keys: "Arrow keys",
    does: "Move the selected tokens one square",
    roles: ["dm", "player"],
    match: keyIs("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"),
    navigation: true,
    when: withSelection,
    run: (env, e) => {
      const [dx, dy] = e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : e.key === "ArrowLeft" ? [-1, 0] : [1, 0];
      env.scope.get(stageKeysSlot).nudge?.(dx, dy);
    },
  },
  {
    id: "elevation",
    keys: "Page Up, Page Down",
    does: "Raise or lower the selected tokens 5 ft",
    roles: ["dm", "player"],
    match: keyIs("PageUp", "PageDown"),
    navigation: true,
    when: (env) => elevatable(env).length > 0,
    run: (env, e) => {
      const step = e.key === "PageUp" ? 5 : -5;
      dispatchAll(
        env,
        elevatable(env).map((t) => ({ t: "token.update", tokenId: t.id, patch: { elevation: (t.elevation ?? 0) + step } })),
      );
    },
  },
  {
    id: "hide",
    keys: "H",
    does: "Hide or show the selected tokens",
    roles: ["dm"],
    match: letter("h"),
    when: withSelection,
    run: (env) => {
      const tokens = selectedTokens(env);
      const visibility = tokens.every((t) => t.visibility === "dm") ? "all" : "dm";
      dispatchAll(env, batches(tokens.map((t) => t.id)).map((tokenIds) => ({ t: "token.updateMany", tokenIds, patch: { visibility } })));
    },
  },
  {
    id: "lock",
    keys: "L",
    does: "Lock or unlock the selected tokens",
    roles: ["dm"],
    match: letter("l"),
    when: withSelection,
    run: (env) => {
      const tokens = selectedTokens(env);
      const locked = !tokens.every((t) => t.locked);
      dispatchAll(env, batches(tokens.map((t) => t.id)).map((tokenIds) => ({ t: "token.updateMany", tokenIds, patch: { locked } })));
    },
  },
  {
    id: "delete",
    keys: "Delete, Backspace",
    does: "Delete the selected tokens",
    roles: ["dm"],
    match: keyIs("Delete", "Backspace"),
    when: withSelection,
    run: (env) => {
      const tokens = selectedTokens(env);
      dispatchAll(env, batches(tokens.map((t) => t.id)).map((tokenIds) => ({ t: "token.deleteMany", tokenIds })));
      env.ui.select(null);
      env.ui.notify(deletedText(tokens.map((t) => displayName(t))));
    },
  },
  {
    id: "turn",
    keys: "N",
    does: "Next turn, or End turn on your own turn",
    roles: ["dm", "player"],
    match: letter("n"),
    when: (env) => {
      const s = env.getState();
      const encounter = s.view?.encounter;
      if (!encounter || encounter.entries.length === 0) return false;
      if (env.role === "dm") return true;
      const you = s.you?.memberId ?? "";
      const view = { tokens: s.view?.tokens ?? {}, characters: s.view?.characters ?? {} };
      return turnStatus({ entries: sortedEntries(encounter.entries), activeEntryId: encounter.activeEntryId, mine: (row) => ownsEntry(view, you, row) }) === "yours";
    },
    run: (env) => env.actions.dispatch(turnOp("encounter.next", env.getState())),
  },
  {
    id: "zoomIn",
    keys: "+",
    does: "Zoom in",
    roles: ["dm", "player"],
    // `=` is the same key unshifted on many layouts.
    match: keyIs("+", "="),
    run: (env) => env.scope.get(stageKeysSlot).zoom?.(ZOOM_STEP),
  },
  {
    id: "zoomOut",
    keys: "-",
    does: "Zoom out",
    roles: ["dm", "player"],
    match: keyIs("-"),
    run: (env) => env.scope.get(stageKeysSlot).zoom?.(1 / ZOOM_STEP),
  },
  {
    id: "fit",
    keys: "0",
    does: "Fit the map",
    roles: ["dm", "player"],
    match: keyIs("0"),
    run: (env) => env.scope.get(fitSlot).fit?.(),
  },
  {
    id: "outliner",
    keys: "/",
    does: "Search the scene in the outliner",
    roles: ["dm"],
    match: keyIs("/"),
    run: (env) => {
      const search = env.scope.get(outlinerSearchSlot);
      search.focusNext = true;
      env.ui.openPanel("outliner");
      for (const listener of search.listeners) listener();
    },
  },
  {
    id: "sidePanel",
    keys: "S",
    does: "Hide or show the side panel",
    roles: ["dm", "player"],
    match: letter("s"),
    when: (env) => env.scope.get(sidePanelKeysSlot).toggle !== null,
    run: (env) => env.scope.get(sidePanelKeysSlot).toggle?.(),
  },
  {
    id: "otherPanel",
    keys: "O",
    does: "Go to the other panel, with two in the side panel",
    roles: ["dm", "player"],
    match: letter("o"),
    when: (env) => env.scope.get(splitKeysSlot).other !== null,
    run: (env) => env.scope.get(splitKeysSlot).other?.(),
  },
  {
    id: "sheet",
    keys: "?",
    does: "Show these shortcuts",
    roles: ["dm", "player"],
    match: keyIs("?"),
    run: (env) => setShortcutSheet(env.scope, true),
  },
];

/** The shortcuts a role has, for the sheet. */
export function shortcutsFor(role: "dm" | "player"): Shortcut[] {
  return SHORTCUTS.filter((s) => s.roles.includes(role));
}

// ------------------------------------------------------------ the rest of the sheet

/*
 * The sheet holds keys, and keys or a mouse button other than the left
 * one with a click, a drag or the wheel (the project owner, 2026-10-16). A
 * plain click, tap, drag or pinch is described with its feature in
 * FEATURES.md instead. Every change to a key or a key-plus-pointer
 * combination updates SHORTCUTS or BEHAVIORS here, and FEATURES.md's
 * Shortcuts tables, in the same change. A key that works only inside one
 * surface, such as a dialog or the handout viewer, goes in that surface's
 * section. shortcuts.test.ts fails when FEATURES.md and these tables
 * disagree.
 */

/**
 * Where a row applies: keys on a keyboard that SHORTCUTS does not hold
 * (Escape, or the keys inside one surface), a key or a button with the
 * mouse, or Android's Back button.
 */
export type BehaviorDevice = "keys" | "mouse" | "android";

/** The surfaces whose own keys get a section of the sheet, in the sheet's order. */
export const SURFACES = [
  "Toolbar",
  "Tool options",
  "Side panel tabs",
  "Two panels",
  "Handout viewer",
  "Token window",
  "Initiative",
  "Dice",
  "Roll requests",
  "Token and character fields",
  "Label, pin and light panes",
  "Dialogs",
  "Choose an image",
] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * One row the sheet lists beside SHORTCUTS. Only the words live here. The
 * behavior itself lives in the code each row cites, which is what to read
 * again when either changes.
 */
export type Behavior = {
  id: string;
  /** What you do, as the sheet and FEATURES.md write it: "Shift or Ctrl+click a token (Cmd on a Mac)". */
  input: string;
  /** What it does. */
  does: string;
  roles: readonly ("dm" | "player")[];
  /** Any condition beyond the role, in lowercase, as FEATURES.md writes it after the role: "with the Select tool". */
  when?: string;
  device: BehaviorDevice;
  /** The surface it works in, which names its section. Left out, the map or the whole room. */
  surface?: Surface;
};

const EVERYONE = ["dm", "player"] as const;
const DM = ["dm"] as const;
const PLAYER = ["player"] as const;

/** Every row beside the keys, in the order the sheet lists them. */
export const BEHAVIORS: readonly Behavior[] = [
  // The whole room: components/Popover.tsx, which takes the key first, then lib/escape.ts, pages/RoomChrome.tsx useEscape, state/selection.ts dismissal and barDismiss.
  {
    id: "escape",
    input: "Escape",
    does: "Close an open pop-up first, then a sheet, else the token's action bar, else let go of the selection and end Multi-select. While the token's panel shows one token, the bar closes and keeps it. While the panel is open, a group whose bar is hidden stays until Done. A field outside the pop-up keeps its Escape",
    roles: EVERYONE,
    device: "keys",
  },
  // lib/backClose.ts. Only Android has the button.
  { id: "back", input: "Back button", does: "Close what opened last, such as a pop-up, a sheet, a dialog, a handout or the action bar", roles: EVERYONE, device: "android" },

  // The map with a key or another button: canvas/Stage.tsx, canvas/TokenNode.tsx, state/selection.ts addsToSelection.
  {
    id: "selectAdd",
    input: "Shift or Ctrl+click a token (Cmd on a Mac)",
    does: "Add it to the selection, or take it out, as Multi-select does",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "mouse",
  },
  {
    id: "box",
    input: "Shift or Ctrl+drag on empty map (Cmd on a Mac)",
    does: "Draw a box that adds the tokens in it to the selection",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "mouse",
  },
  // Stage.tsx interaction.menu, which no tool takes over.
  {
    id: "selectMenu",
    input: "Right-click a token",
    does: "Select it alone, whatever the tool. With the Select tool its action bar opens too",
    roles: EVERYONE,
    when: "with Multi-select off",
    device: "mouse",
  },
  { id: "buttonPan", input: "Drag with the right or middle button", does: "Move the map", roles: EVERYONE, when: "with any tool", device: "mouse" },
  // pages/mapFocus.ts spaceMovesMap.
  { id: "spacePan", input: "Space+drag", does: "Move the map", roles: EVERYONE, when: "with any tool, while nothing has focus or the map does", device: "mouse" },
  // lib/camera.ts wheelZoomFactor: a trackpad's pinch arrives as the wheel with Ctrl.
  {
    id: "ctrlWheel",
    input: "Ctrl+wheel, or a pinch on a trackpad",
    does: "Zoom in or out at the pointer, faster than the wheel alone",
    roles: EVERYONE,
    when: "with any tool",
    device: "mouse",
  },
  // features/handouts/HandoutViewer.tsx's own wheel listener, which also keeps the browser from zooming the page. A surface lists only keys, so this row is the room's.
  {
    id: "viewerCtrlWheel",
    input: "Ctrl+wheel, or a pinch on a trackpad",
    does: "Zoom the picture or the pages in or out at the pointer, down to a whole page",
    roles: EVERYONE,
    when: "in the handout viewer",
    device: "mouse",
  },

  // The toolbar: state/shortcuts.ts toolShortcut, components/Menu.tsx in Setup and the tool menu (pages/Room.tsx Toolbar).
  // Keys are drawn whole on one line in the sheet, so a row's key stays short and its condition goes in `when`.
  { id: "toolKeyShow", input: "The tool's key", does: "Show its hidden options again. It never hides them", roles: EVERYONE, when: "for the tool in use", device: "keys", surface: "Toolbar" },
  {
    id: "toolMenuKeys",
    input: "Arrow keys, Home, End",
    does: "Move to a tool, as a letter does to one whose name starts with it. Enter or Space picks it, or on the tool in use hides or shows its options. Escape closes the menu, and Tab closes it and moves on",
    roles: EVERYONE,
    when: "in Setup or the tool menu",
    device: "keys",
    surface: "Toolbar",
  },

  // A tool's options row and its pop-ups: components/Popover.tsx, features/measure/controls.tsx ValueChip and PickCloses.
  {
    id: "optionsOpenKey",
    input: "Enter, Space",
    does: "Open its pop-up with the keyboard in it",
    roles: EVERYONE,
    when: "on a button that shows a value, or on More options",
    device: "keys",
    surface: "Tool options",
  },
  {
    id: "optionsChoiceKeys",
    input: "Arrow keys",
    does: "Change the choice and keep the pop-up open. Enter or Space picks it and closes the pop-up",
    roles: EVERYONE,
    when: "in a pop-up's choice",
    device: "keys",
    surface: "Tool options",
  },

  // The side panel's tabs and More's list: pages/SideTabs.tsx, pages/tabFit.ts, components/Menu.tsx and menuKeys.ts, components/Popover.tsx, lib/a11y.ts tabKeyIndex.
  {
    id: "tabsSide",
    input: "Left, Right",
    does: "Switch to the tab beside it, wrapping around at the ends. On More, or on the panel open below, stop there and switch nothing",
    roles: EVERYONE,
    device: "keys",
    surface: "Side panel tabs",
  },
  { id: "tabsEnds", input: "Home, End", does: "Go to the first tab, or to More, the last, switching as Left and Right do", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  { id: "tabsMoreKeys", input: "Enter, Space, Down, Up on More", does: "Open the list, at the open panel or the first, or with Up the last", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  { id: "tabsListMove", input: "Up, Down, Home, End in the list", does: "Move through it, wrapping around at the ends", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  { id: "tabsListType", input: "Letters in the list", does: "Go to the next panel whose name starts with them", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  {
    id: "tabsListPick",
    input: "Enter, Space in the list",
    does: "Open the panel, or turn Two panels on or off, and close the list. More then shows the panel's name",
    roles: EVERYONE,
    device: "keys",
    surface: "Side panel tabs",
  },
  {
    id: "tabsListLeave",
    input: "Tab, Shift+Tab in the list",
    does: "Close it. Tab goes on to the next control, Shift+Tab back to More",
    roles: EVERYONE,
    device: "keys",
    surface: "Side panel tabs",
  },
  { id: "tabsListEscape", input: "Escape in the list", does: "Close it, back to More", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },

  // Two panels in the side panel: pages/SplitBar.tsx, pages/splitPanes.ts gripStep, components/Menu.tsx and menuKeys.ts for its list.
  { id: "splitGripKeys", input: "Up, Down", does: "Move the bar 8 px, or 64 px with Shift", roles: EVERYONE, when: "with its grip focused", device: "keys", surface: "Two panels" },
  { id: "splitDragEscape", input: "Escape", does: "Put the bar back where it was", roles: EVERYONE, when: "while you drag it", device: "keys", surface: "Two panels" },
  {
    id: "splitNameKeys",
    input: "Enter, Space, Down, Up on the bottom panel's name",
    does: "Open its list of panels, at the one open or the first, or with Up the last. The list takes More's list keys",
    roles: EVERYONE,
    device: "keys",
    surface: "Two panels",
  },

  // The handout viewer: features/handouts/HandoutViewer.tsx, zoom.ts viewerKey.
  { id: "viewerZoom", input: "+, -", does: "Zoom in, zoom out", roles: EVERYONE, device: "keys", surface: "Handout viewer" },
  { id: "viewerReset", input: "0", does: "Reset the zoom", roles: EVERYONE, device: "keys", surface: "Handout viewer" },
  {
    id: "viewerArrows",
    input: "Arrow keys",
    does: "Move the zoomed picture, or a handout's pages",
    roles: EVERYONE,
    when: "while it is larger than the viewer",
    device: "keys",
    surface: "Handout viewer",
  },
  {
    id: "viewerScreen",
    input: "Page Down, Page Up",
    does: "Scroll down or up about a screen",
    roles: EVERYONE,
    when: "on a handout of pages taller than the viewer",
    device: "keys",
    surface: "Handout viewer",
  },
  {
    id: "viewerSpace",
    input: "Space, Shift+Space",
    does: "Scroll down or up about a screen, as Page Down and Page Up do",
    roles: EVERYONE,
    when: "on a handout of pages taller than the viewer, with focus on the viewer rather than a button",
    device: "keys",
    surface: "Handout viewer",
  },
  {
    id: "viewerEnds",
    input: "Home, End",
    does: "Go to the top of the first page or the end of the last",
    roles: EVERYONE,
    when: "on a handout of pages taller than the viewer",
    device: "keys",
    surface: "Handout viewer",
  },

  // The token window, the action bar where it docks: canvas/TokenActionBar.tsx BarFrame.
  { id: "barEscape", input: "Escape", does: "Put it back where it was", roles: EVERYONE, when: "while you drag its header or resize it", device: "keys", surface: "Token window" },
  { id: "windowMoveKeys", input: "Arrow keys", does: "Move it 8 px, or 64 px with Shift", roles: EVERYONE, when: "with its grip focused", device: "keys", surface: "Token window" },
  { id: "windowResizeKeys", input: "Arrow keys", does: "Resize it 8 px, or 64 px with Shift", roles: EVERYONE, when: "with its corner handle focused, on a computer", device: "keys", surface: "Token window" },

  // The initiative tracker: features/encounter/Row.tsx, ValueEntry.tsx.
  { id: "initEnter", input: "Enter", does: "Save the initiative you typed", roles: EVERYONE, when: "in a row's initiative box", device: "keys", surface: "Initiative" },
  { id: "initEscape", input: "Escape", does: "Drop the initiative you typed", roles: EVERYONE, when: "in a row's initiative box", device: "keys", surface: "Initiative" },
  {
    id: "initSeveral",
    input: "Enter",
    does: "Go to the next box, and save after the last",
    roles: DM,
    when: "while typing several values",
    device: "keys",
    surface: "Initiative",
  },

  // The Dice panel's formula field: features/dice/Roller.tsx. The field's own keys, so the room's shortcuts stand aside there.
  { id: "diceEnter", input: "Enter", does: "Roll what the field holds", roles: EVERYONE, when: "in the Dice panel's formula field", device: "keys", surface: "Dice" },
  {
    id: "diceHistory",
    input: "Up, Down",
    does: "Go back through the formulas this device rolled, newest first, or forward again to what was being typed",
    roles: EVERYONE,
    when: "in the formula field",
    device: "keys",
    surface: "Dice",
  },

  // Request a roll's fields: features/rolls/RequestSheet.tsx, one form whose submit is Send (docs/design-v1-roll-request.md 8).
  { id: "rollAskEnter", input: "Enter", does: "Send the request", roles: DM, when: "in Request a roll's DC or note field", device: "keys", surface: "Roll requests" },
  // The player's roll card: features/rolls/PlayerRolls.tsx. Send always took Enter in the Total field, and the sheet now lists it.
  { id: "rollCardSend", input: "Enter", does: "Send the total you typed", roles: PLAYER, when: "in a roll card's Total field", device: "keys", surface: "Roll requests" },
  { id: "rollCardRoll", input: "Enter", does: "Roll, with the bonus and extra dice you typed", roles: PLAYER, when: "in a roll card's Bonus or Extra dice field", device: "keys", surface: "Roll requests" },

  // The token's and characters' one-line fields: features/tokens/ui.tsx TextField and NumberField.
  { id: "fieldEnter", input: "Enter", does: "Save the field and leave it", roles: EVERYONE, when: "in a one-line field", device: "keys", surface: "Token and character fields" },
  { id: "fieldEscape", input: "Escape", does: "Drop what you typed and leave the field", roles: EVERYONE, when: "in a one-line field", device: "keys", surface: "Token and character fields" },

  // The map panes: features/builder/LabelPane.tsx, features/pins/PinPane.tsx, features/lights/LightPane.tsx.
  { id: "paneEnter", input: "Enter", does: "Finish the text, as Done does, or save a light's name", roles: DM, device: "keys", surface: "Label, pin and light panes" },
  { id: "paneEscape", input: "Escape", does: "Close the pane", roles: DM, device: "keys", surface: "Label, pin and light panes" },

  // Every dialog: components/Dialog.tsx, lib/modalDialog.ts, features/journal/JournalEditor.tsx, features/monsters/MonsterEditor.tsx.
  { id: "dialogEscape", input: "Escape", does: "Close it. A journal page or a monster with unsaved changes asks first", roles: EVERYONE, device: "keys", surface: "Dialogs" },
  { id: "dialogTab", input: "Tab, Shift+Tab", does: "Move through its controls without leaving it", roles: EVERYONE, device: "keys", surface: "Dialogs" },

  // The image picker: features/images/ImagePicker.tsx.
  {
    id: "pickerPaste",
    input: "Ctrl+V (Cmd+V on a Mac)",
    does: "Paste an image to upload it, or an https link to import it",
    roles: EVERYONE,
    when: "with focus outside a text field",
    device: "keys",
    surface: "Choose an image",
  },
];

/** One row of the sheet, from either table. `keys` writes the input as keys on a keyboard. */
export type SheetRow = { id: string; input: string; does: string; when?: string; keys: boolean };

export type SheetSection = { title: string; intro?: string; rows: SheetRow[] };

/** What the device has that decides which rows show: a mouse or trackpad, and Android's Back button. */
export type SheetDevice = { mouse: boolean; android: boolean };

/** The heading of the mouse rows' section. */
export const MOUSE_SECTION = "Mouse with keys";

/** The sheet's Keys intro, which FEATURES.md repeats. */
export const KEYS_INTRO = "On any device with a keyboard. They do nothing while you type in a field or a dialog is open. On a Mac, Cmd works where Ctrl is written.";

/** A line under a surface's heading, where its rows do not say where it is. */
const SURFACE_INTRO: Partial<Record<Surface, string>> = {
  Toolbar: "Each tool key picks its tool, also one behind Setup or the tool menu.",
  "Tool options": "A tool's options row, its More options and the pop-ups its buttons open.",
  "Side panel tabs":
    "On a screen 900 px or wider, with a tab or More's list focused. There, and on a focused choice or slider, the arrow and Page keys never move a token, and in the list a letter goes to a panel instead of running a shortcut.",
  "Two panels": "On a screen 900 px or wider, with two panels in the side panel. With the bar's grip focused, the arrow keys move the bar and never move a token.",
  "Handout viewer": "A handout the DM shows, or a picture or a PDF opened from the Library.",
  "Token window": "Where the action bar opens as a window: on a screen 600 px or wider, or a phone on its side. With its grip or corner handle focused, the arrow keys move or resize it and never move a token.",
};

function sheetRow(b: Behavior): SheetRow {
  return { id: b.id, input: b.input, does: b.does, ...(b.when ? { when: b.when } : {}), keys: b.device === "keys" };
}

/**
 * The sheet's sections for a role on a device, in order: Keys, the mouse
 * with keys where there is a mouse or trackpad, Android's Back button on
 * Android, then each surface's keys. A section with no row for the role
 * and the device is left out.
 */
export function sheetSections(role: "dm" | "player", device: SheetDevice): SheetSection[] {
  const mine = BEHAVIORS.filter((b) => b.roles.includes(role));
  const room = mine.filter((b) => b.surface === undefined);
  const sections: SheetSection[] = [
    {
      title: "Keys",
      intro: KEYS_INTRO,
      rows: [...shortcutsFor(role).map((s) => ({ id: s.id, input: s.keys, does: s.does, keys: true })), ...room.filter((b) => b.device === "keys").map(sheetRow)],
    },
    { title: MOUSE_SECTION, rows: device.mouse ? room.filter((b) => b.device === "mouse").map(sheetRow) : [] },
    { title: "Android", rows: device.android ? room.filter((b) => b.device === "android").map(sheetRow) : [] },
    ...SURFACES.map((surface) => ({
      title: surface,
      ...(SURFACE_INTRO[surface] ? { intro: SURFACE_INTRO[surface] } : {}),
      rows: mine.filter((b) => b.surface === surface).map(sheetRow),
    })),
  ];
  return sections.filter((s) => s.rows.length > 0);
}

/** Who has a row, as FEATURES.md's tables write it: "everyone, with the Select tool". */
export function whoText(b: Pick<Behavior, "roles" | "when">): string {
  const who = b.roles.length === 2 ? "everyone" : b.roles[0] === "dm" ? "DM" : "players";
  return b.when ? `${who}, ${b.when}` : who;
}

/** Where a press lands: whether a modal dialog is open, and whether this Room page is a "view as a player" preview. */
export type ShortcutGates = { dialogOpen: boolean; preview: boolean };

/** The shortcut a press runs, or null. Pure but for the conditions, which read `env`. */
export function shortcutFor(e: KeyPress, env: ShortcutEnv, gates: ShortcutGates): Shortcut | null {
  if (e.defaultPrevented || e.repeat || gates.preview || gates.dialogOpen || e.altKey || isTextField(e.target)) return null;
  const modifier = e.ctrlKey || e.metaKey;
  const shortcut = SHORTCUTS.find((s) => s.roles.includes(env.role) && (s.modifier === true) === modifier && s.match(e));
  if (!shortcut) return null;
  if (shortcut.navigation && ownsNavigationKeys(e.target)) return null;
  return !shortcut.when || shortcut.when(env) ? shortcut : null;
}

/**
 * The one window listener, mounted by the Room page. A "view as a player"
 * preview's page passes `preview`, so it answers no key at all.
 */
export function useShortcuts(input: { role: "dm" | "player"; tools: readonly { id: string }[]; scope: RoomScope; preview: boolean }): void {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { role, tools, scope, preview } = latest.current;
      const env: ShortcutEnv = { role, tools, getState: () => store.getState(), actions, ui, scope };
      const dialogOpen = document.querySelector('[aria-modal="true"]') !== null;
      const shortcut = shortcutFor(e, env, { dialogOpen, preview });
      if (!shortcut) return;
      e.preventDefault();
      shortcut.run(env, e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, actions, ui]);
}
