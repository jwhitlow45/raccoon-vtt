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

/** The groups whose arrow and Page keys move their own choice, value or tab. */
const NAVIGATES = '[role="radiogroup"], [role="slider"], [role="tablist"], [role="listbox"]';

/**
 * Whether focus is on a control that answers the arrow and Page keys
 * itself: a native radio (Segmented, Swatches, design 2.3), a range
 * slider, or anything inside a radio group, slider, tab list or list box.
 * There the keys choose, so the map's shortcuts on the same keys stand
 * aside: with a token selected, ArrowRight on the HP modes moved the token
 * and left the mode as it was. A tab list says the arrows switch its
 * tabs, so a screen reader user pressing one there must never move a
 * token every player sees.
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
    run: (env) => env.ui.setTool(id),
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
 * Every change to a key or a pointer behavior in the room updates
 * SHORTCUTS or BEHAVIORS here, and FEATURES.md's Shortcuts tables, in the
 * same change (the project owner's standing rule, 2026-10-16). A key or
 * gesture that works only inside one surface, such as a window or the
 * handout viewer, goes in that surface's section. shortcuts.test.ts fails
 * when FEATURES.md and these tables disagree.
 */

/**
 * Where a behavior works: with a mouse or trackpad, on a touch screen, with
 * either, or (`keys`) a key SHORTCUTS does not hold, such as Escape or a
 * key that works inside one surface.
 */
export type BehaviorDevice = "mouse" | "touch" | "both" | "keys";

/** The surfaces whose own keys and gestures get a section of the sheet, in the sheet's order. */
export const SURFACES = [
  "Side panel tabs",
  "Handout viewer",
  "Token action bar",
  "Initiative",
  "Label, pin and light panes",
  "Windows",
  "Choose an image",
  "Crop the image",
  "Toolbar",
] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * One behavior the sheet lists beside the keys: a click, a drag, a pinch,
 * or a key that only works inside one surface. Only the words live here.
 * The behavior itself lives in the code each row cites, which is what to
 * read again when either changes.
 */
export type Behavior = {
  id: string;
  /** What you do, as the sheet and FEATURES.md write it: "Shift or Ctrl+click a token (Cmd on a Mac)". */
  input: string;
  /** For a behavior on both devices, the words on a touch screen where they differ: "Tap a token" for "Click a token". */
  touchInput?: string;
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

/** Every behavior beside the keys, in the order the sheet lists them. */
export const BEHAVIORS: readonly Behavior[] = [
  // The whole room: lib/escape.ts, pages/RoomChrome.tsx useEscape, lib/backClose.ts.
  {
    id: "escape",
    input: "Escape",
    does: "Close a sheet or the token's action bar. With neither open, let go of the selection and end Select several",
    roles: EVERYONE,
    device: "keys",
  },
  { id: "back", input: "Android's Back button", does: "Close what opened last, such as a sheet, a window, a handout or the action bar", roles: EVERYONE, device: "touch" },

  // The Select tool: canvas/Stage.tsx, canvas/TokenNode.tsx, state/selection.ts.
  {
    id: "select",
    input: "Click a token",
    touchInput: "Tap a token",
    does: "Select it and open its action bar",
    roles: EVERYONE,
    when: "with the Select tool and Select several off",
    device: "both",
  },
  {
    id: "selectAdd",
    input: "Shift or Ctrl+click a token (Cmd on a Mac)",
    does: "Add it to the selection, or take it out",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "mouse",
  },
  {
    id: "selectMenu",
    input: "Right-click a token",
    does: "Select it alone and open its action bar",
    roles: EVERYONE,
    when: "with the Select tool and Select several off",
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
  { id: "multiTap", input: "Click a token", touchInput: "Tap a token", does: "Add it to the group, or take it out", roles: EVERYONE, when: "with Select several on", device: "both" },
  { id: "multiBox", input: "Drag on empty map", does: "Draw a box that adds the tokens in it to the group", roles: EVERYONE, when: "with Select several on", device: "both" },
  {
    id: "multiAway",
    input: "Click empty map",
    touchInput: "Tap empty map",
    does: "Hide the group's action bar and keep the group",
    roles: EVERYONE,
    when: "with Select several on",
    device: "both",
  },
  {
    id: "dragToken",
    input: "Drag a token",
    does: "Move it, and the rest of the selection with it when it is selected",
    roles: EVERYONE,
    when: "with the Select tool, on tokens you may move",
    device: "both",
  },
  { id: "pan", input: "Drag on empty map", does: "Move the map", roles: EVERYONE, when: "with the Select tool and Select several off", device: "both" },
  {
    id: "letGo",
    input: "Click empty map",
    touchInput: "Tap empty map",
    does: "Let go of the selection",
    roles: EVERYONE,
    when: "with the Select tool and Select several off",
    device: "both",
  },
  // features/pings/PingLayer.tsx useHoldToPing.
  { id: "holdPing", input: "Press and hold on the map", does: "Ping that spot", roles: EVERYONE, when: "with the Select tool, off any token", device: "both" },
  // features/doors/tap.ts, features/builder/heights/tap.ts, features/pins/PinLayer.tsx, features/builder/labelEdit.ts.
  {
    id: "door",
    input: "Click a door",
    touchInput: "Tap a door",
    does: "Show its buttons, such as Open or Close",
    roles: EVERYONE,
    when: "with the Select tool and Select several off",
    device: "both",
  },
  {
    id: "ground",
    input: "Click raised or lowered ground",
    touchInput: "Tap raised or lowered ground",
    does: "Show its height",
    roles: EVERYONE,
    when: "with the Select tool and Select several off",
    device: "both",
  },
  { id: "pinPage", input: "Click a pin", touchInput: "Tap a pin", does: "Open its journal page, or show its label", roles: EVERYONE, when: "with the Select tool", device: "both" },
  {
    id: "mapLabel",
    input: "Click a map label",
    touchInput: "Tap a map label",
    does: "Open it to change its text and size, or delete it",
    roles: DM,
    when: "with the Select tool and Select several off, or the Builder's Label",
    device: "both",
  },
  { id: "hover", input: "Point at a token", does: "Show its whole name", roles: EVERYONE, device: "mouse" },

  // The camera, whatever the tool: canvas/Stage.tsx, lib/camera.ts wheelZoomFactor.
  {
    id: "wheel",
    input: "Wheel, or two fingers on a trackpad",
    does: "Zoom in or out at the pointer. Ctrl+wheel zooms faster",
    roles: EVERYONE,
    when: "with any tool",
    device: "mouse",
  },
  { id: "buttonPan", input: "Drag with the right or middle button", does: "Move the map", roles: EVERYONE, when: "with any tool", device: "mouse" },
  { id: "spacePan", input: "Space+drag", does: "Move the map", roles: EVERYONE, when: "with any tool, while no field or button has focus", device: "mouse" },
  { id: "twoFingers", input: "Drag with two fingers", does: "Move the map", roles: EVERYONE, when: "with any tool", device: "touch" },
  { id: "pinch", input: "Pinch", does: "Zoom in or out", roles: EVERYONE, when: "with any tool", device: "touch" },

  // The Ruler: features/measure/RulerTool.tsx, ruler.ts.
  { id: "rulerDrag", input: "Drag on the map", does: "Measure. A drag from the ruler's end adds a leg", roles: EVERYONE, when: "with the Ruler", device: "both" },
  { id: "rulerTap", input: "Click the map", touchInput: "Tap the map", does: "Add a waypoint", roles: EVERYONE, when: "with the Ruler", device: "both" },
  {
    id: "rulerKeep",
    input: "Double-click the map",
    touchInput: "Double tap the map",
    does: "Keep the ruler on the map",
    roles: EVERYONE,
    when: "with the Ruler",
    device: "both",
  },

  // The Area tool: features/areas/AreaTool.tsx.
  {
    id: "areaToken",
    input: "Click a token",
    touchInput: "Tap a token",
    does: "Cast the area from it, or center a sphere or cylinder on it",
    roles: EVERYONE,
    when: "with the Area tool",
    device: "both",
  },
  {
    id: "areaAim",
    input: "Drag on the map",
    does: "Aim a cone, line or cube, or move the area's point. Place saves it",
    roles: EVERYONE,
    when: "with the Area tool",
    device: "both",
  },
  {
    id: "areaPick",
    input: "Click a placed area",
    touchInput: "Tap a placed area",
    does: "Pick it to change it, then drag to move or turn it",
    roles: EVERYONE,
    when: "with the Area tool, on areas you may change",
    device: "both",
  },

  // The Fog tool: features/fog/tool.tsx.
  { id: "fogDrag", input: "Drag on the map", does: "Clear or add fog with the Rectangle or the Brush", roles: DM, when: "with the Fog tool", device: "both" },
  {
    id: "fogPolygon",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Add a corner. The first corner again closes the shape",
    roles: DM,
    when: "with the Fog tool's Polygon",
    device: "both",
  },
  {
    id: "fogRoom",
    input: "Click a builder room",
    touchInput: "Tap a builder room",
    does: "Clear or add fog in the whole room",
    roles: DM,
    when: "with the Fog tool's Builder room",
    device: "both",
  },

  // The Draw tool: features/drawings/DrawTool.tsx.
  { id: "drawDrag", input: "Drag on the map", does: "Draw with the Pen, or a Line, Arrow, Box or Circle", roles: EVERYONE, when: "with the Draw tool", device: "both" },
  {
    id: "drawTap",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Add a Shape's corner, or start a Text there. The first corner again closes the shape",
    roles: EVERYONE,
    when: "with the Draw tool",
    device: "both",
  },
  { id: "drawErase", input: "Drag over drawings", does: "Erase them. A player erases only their own", roles: EVERYONE, when: "with the Draw tool's Eraser", device: "both" },

  // The Ping tool: features/pings/PingTool.tsx.
  { id: "pingTap", input: "Click the map", touchInput: "Tap the map", does: "Ping that spot", roles: EVERYONE, when: "with the Ping tool", device: "both" },
  { id: "laser", input: "Drag on the map", does: "Draw a laser trail that fades", roles: EVERYONE, when: "with the Ping tool", device: "both" },
  {
    id: "lookHere",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Ping it and move every player's view there",
    roles: DM,
    when: "with the Ping tool and Look here on",
    device: "both",
  },

  // Add token: features/tokens/placeTool.tsx.
  {
    id: "place",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Place the chosen token or monsters there, then go back to Select",
    roles: DM,
    when: "with Add token",
    device: "both",
  },

  // The Pin tool: features/pins/PinTool.tsx.
  { id: "pinPlace", input: "Click the map", touchInput: "Tap the map", does: "Place a pin and open its pane", roles: DM, when: "with the Pin tool", device: "both" },
  { id: "pinOpen", input: "Click a pin", touchInput: "Tap a pin", does: "Open its pane", roles: DM, when: "with the Pin tool", device: "both" },
  { id: "pinDrag", input: "Drag a pin", does: "Move it", roles: DM, when: "with the Pin tool", device: "both" },

  // The Builder: features/builder/tool.tsx, heights/pointer.ts, stamps/pointer.ts, features/lights/pointer.ts.
  {
    id: "buildStroke",
    input: "Drag on the map",
    does: "Paint or erase as you go",
    roles: DM,
    when: "with the Builder's Brush, Erase, or Heights and stairs with a brush",
    device: "both",
  },
  {
    id: "buildRect",
    input: "Drag on the map",
    does: "Fill or clear a rectangle from corner to corner",
    roles: DM,
    when: "with the Builder's Rectangle room, Erase area, or Heights and stairs with Area",
    device: "both",
  },
  {
    id: "buildShape",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Add a room's corner. The first corner again closes the room",
    roles: DM,
    when: "with the Builder's Shape room",
    device: "both",
  },
  { id: "buildRun", input: "Drag along a grid line", does: "Draw a run of the chosen wall, door or window", roles: DM, when: "with the Builder's Walls and doors", device: "both" },
  {
    id: "buildEdge",
    input: "Click a square's edge",
    touchInput: "Tap a square's edge",
    does: "Set it to the chosen kind, or clear it when it is that kind already. With Door chosen, a door steps through closed, open and locked",
    roles: DM,
    when: "with the Builder's Walls and doors",
    device: "both",
  },
  {
    id: "buildPlace",
    input: "Click the map",
    touchInput: "Tap the map",
    does: "Place a label, a light or a stamp",
    roles: DM,
    when: "with the Builder's Label, Lights or Stamp",
    device: "both",
  },
  {
    id: "buildOpen",
    input: "Click a label or a light",
    touchInput: "Tap a label or a light",
    does: "Open it to change or delete it",
    roles: DM,
    when: "with the Builder's Label or Lights",
    device: "both",
  },
  { id: "buildStamp", input: "Click a stamp", touchInput: "Tap a stamp", does: "Select it, to turn, resize, tint or delete it", roles: DM, when: "with the Builder's Stamp", device: "both" },
  { id: "buildMove", input: "Drag a label, a light or a stamp", does: "Move it", roles: DM, when: "with the Builder's Label, Lights or Stamp", device: "both" },
  { id: "buildHandle", input: "Drag a selected stamp's handle", does: "Turn or resize it", roles: DM, when: "with the Builder's Stamp", device: "both" },
  { id: "buildRepeat", input: "Press and hold − or +", does: "Step the height quickly", roles: DM, when: "with the Builder's Heights and stairs", device: "both" },

  // Line up grid: features/grid/tool.tsx.
  { id: "gridCorner", input: "Drag a corner of the box", does: "Resize the box", roles: DM, when: "with Line up grid", device: "both" },
  { id: "gridMove", input: "Drag inside the box", does: "Move the box", roles: DM, when: "with Line up grid", device: "both" },
  { id: "gridNew", input: "Drag elsewhere on the map", does: "Draw a new box", roles: DM, when: "with Line up grid", device: "both" },
  {
    id: "gridTap",
    input: "Click outside the box",
    touchInput: "Tap outside the box",
    does: "Move the box there, keeping its size",
    roles: DM,
    when: "with Line up grid",
    device: "both",
  },

  // The side panel's tabs: pages/Room.tsx, lib/a11y.ts tabKeyIndex, components/ScrollStrip.tsx.
  { id: "tabsSide", input: "Left, Right", does: "Switch to the tab beside it, wrapping around at the ends", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  { id: "tabsEnds", input: "Home, End", does: "Switch to the first or the last tab", roles: EVERYONE, device: "keys", surface: "Side panel tabs" },
  {
    id: "tabsWheel",
    input: "Wheel over the tabs",
    does: "Scroll them sideways",
    roles: EVERYONE,
    when: "on a short screen, where they make one row",
    device: "mouse",
    surface: "Side panel tabs",
  },

  // The handout viewer: features/handouts/HandoutViewer.tsx, zoom.ts viewerKey.
  { id: "viewerZoom", input: "+, -", does: "Zoom in, zoom out", roles: EVERYONE, device: "keys", surface: "Handout viewer" },
  { id: "viewerReset", input: "0", does: "Reset the zoom", roles: EVERYONE, device: "keys", surface: "Handout viewer" },
  {
    id: "viewerArrows",
    input: "Arrow keys",
    does: "Move the zoomed picture",
    roles: EVERYONE,
    when: "while it is larger than the viewer",
    device: "keys",
    surface: "Handout viewer",
  },
  { id: "viewerWheel", input: "Wheel", does: "Zoom in or out at the pointer", roles: EVERYONE, device: "mouse", surface: "Handout viewer" },
  { id: "viewerPinch", input: "Pinch", does: "Zoom in or out", roles: EVERYONE, device: "touch", surface: "Handout viewer" },
  { id: "viewerDouble", input: "Double-click", touchInput: "Double tap", does: "Zoom in there, or back to fit", roles: EVERYONE, device: "both", surface: "Handout viewer" },
  {
    id: "viewerDrag",
    input: "Drag",
    does: "Move the zoomed picture",
    roles: EVERYONE,
    when: "while it is larger than the viewer",
    device: "both",
    surface: "Handout viewer",
  },

  // The token action bar: canvas/TokenActionBar.tsx, canvas/barDock.ts.
  {
    id: "barDrag",
    input: "Drag its header",
    does: "Move it to another corner of the map",
    roles: EVERYONE,
    when: "where it sits in a corner of the map",
    device: "both",
    surface: "Token action bar",
  },
  { id: "barEscape", input: "Escape", does: "Put it back where it was", roles: EVERYONE, when: "while you drag its header", device: "keys", surface: "Token action bar" },

  // The initiative tracker: panels/TrackerPanel.tsx, features/encounter/Row.tsx, ValueEntry.tsx.
  { id: "initGrip", input: "Drag a row's grip", does: "Reorder creatures tied on initiative", roles: DM, when: "on tied rows", device: "both", surface: "Initiative" },
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

  // The map panes: features/builder/LabelPane.tsx, features/pins/PinPane.tsx, features/lights/LightPane.tsx.
  {
    id: "paneEnter",
    input: "Enter",
    does: "Finish the text, as Done does, or save a light's name",
    roles: DM,
    device: "keys",
    surface: "Label, pin and light panes",
  },
  { id: "paneEscape", input: "Escape", does: "Close the pane", roles: DM, device: "keys", surface: "Label, pin and light panes" },

  // Every window: components/Dialog.tsx, lib/modalDialog.ts, features/journal/JournalEditor.tsx.
  { id: "windowEscape", input: "Escape", does: "Close it. A journal page with unsaved changes asks first", roles: EVERYONE, device: "keys", surface: "Windows" },
  { id: "windowTab", input: "Tab, Shift+Tab", does: "Move through its controls without leaving it", roles: EVERYONE, device: "keys", surface: "Windows" },
  { id: "windowOutside", input: "Click outside it", touchInput: "Tap outside it", does: "Close it, except a handout", roles: EVERYONE, device: "both", surface: "Windows" },

  // The image picker and the crop: features/images/ImagePicker.tsx, CropEditor.tsx.
  {
    id: "pickerPaste",
    input: "Ctrl+V",
    does: "Paste an image to upload it, or an https link to import it",
    roles: EVERYONE,
    when: "with focus outside a text field",
    device: "keys",
    surface: "Choose an image",
  },
  { id: "cropDrag", input: "Drag the picture", does: "Move it in the frame", roles: EVERYONE, device: "both", surface: "Crop the image" },
  { id: "cropWheel", input: "Wheel", does: "Zoom in or out", roles: EVERYONE, device: "mouse", surface: "Crop the image" },
  { id: "cropPinch", input: "Pinch", does: "Zoom in or out", roles: EVERYONE, device: "touch", surface: "Crop the image" },

  // The toolbar: components/ScrollStrip.tsx.
  { id: "toolbarWheel", input: "Wheel over the toolbar", does: "Scroll it sideways", roles: EVERYONE, when: "where its tools do not all fit", device: "mouse", surface: "Toolbar" },
];

/**
 * A behavior as each device words it. One on both devices whose words
 * differ there (`touchInput`) is two: the mouse's words, and the touch
 * screen's.
 */
export type BehaviorEntry = Omit<Behavior, "touchInput">;

export function behaviorEntries(b: Behavior): BehaviorEntry[] {
  const { touchInput, ...entry } = b;
  if (b.device !== "both" || touchInput === undefined) return [entry];
  return [
    { ...entry, id: `${b.id}:mouse`, device: "mouse" },
    { ...entry, id: `${b.id}:touch`, device: "touch", input: touchInput },
  ];
}

/** One row of the sheet, from either table. `keys` writes the input as keys on a keyboard. */
export type SheetRow = { id: string; input: string; does: string; when?: string; keys: boolean };

export type SheetSection = { title: string; intro?: string; rows: SheetRow[] };

/** The pointers a device has: a mouse or trackpad (`fine`), a touch screen (`coarse`), or both. */
export type PointerKinds = { fine: boolean; coarse: boolean };

/** The sheet's Keys intro, which FEATURES.md repeats. */
export const KEYS_INTRO = "On any device with a keyboard. They do nothing while you type in a field or a window is open. On a Mac, Cmd works where Ctrl is written.";

/** A line under a surface's heading, where its rows do not say where it is. */
const SURFACE_INTRO: Partial<Record<Surface, string>> = {
  "Side panel tabs": "On a screen 900 px or wider, with a tab focused. There, and on a focused choice or slider, the arrow and Page keys never move a token.",
  "Handout viewer": "A handout the DM shows, or a picture opened from the Library.",
};

function sheetRow(e: BehaviorEntry): SheetRow {
  return { id: e.id, input: e.input, does: e.does, ...(e.when ? { when: e.when } : {}), keys: e.device === "keys" };
}

/**
 * The sheet's sections for a role on a device, in order: Keys, Mouse,
 * Touch, then each surface. Mouse shows on a device with a mouse or
 * trackpad, Touch on one with a touch screen, and keys everywhere, as the
 * Keys section always has. A section with no row for the role and the
 * device is left out.
 */
export function sheetSections(role: "dm" | "player", kinds: PointerKinds): SheetSection[] {
  const entries = BEHAVIORS.filter((b) => b.roles.includes(role)).flatMap(behaviorEntries);
  const mouse = (e: BehaviorEntry) => kinds.fine && (e.device === "mouse" || e.device === "both");
  const touch = (e: BehaviorEntry) => kinds.coarse && (e.device === "touch" || e.device === "both");
  const room = entries.filter((e) => e.surface === undefined);
  const sections: SheetSection[] = [
    {
      title: "Keys",
      intro: KEYS_INTRO,
      rows: [...shortcutsFor(role).map((s) => ({ id: s.id, input: s.keys, does: s.does, keys: true })), ...room.filter((e) => e.device === "keys").map(sheetRow)],
    },
    { title: "Mouse", rows: room.filter(mouse).map(sheetRow) },
    { title: "Touch", rows: room.filter(touch).map(sheetRow) },
    ...SURFACES.map((surface) => ({
      title: surface,
      ...(SURFACE_INTRO[surface] ? { intro: SURFACE_INTRO[surface] } : {}),
      rows: entries.filter((e) => e.surface === surface && (e.device === "keys" || mouse(e) || touch(e))).map(sheetRow),
    })),
  ];
  return sections.filter((s) => s.rows.length > 0);
}

/** Who has a behavior, as FEATURES.md's tables write it: "everyone, with the Select tool". */
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
