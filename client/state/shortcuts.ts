import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Token } from "#shared/model.ts";
import { drawsAllowed } from "#shared/permissions.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { HistoryScope } from "#shared/undoContract.ts";
import { placedOnHex, tokenRefHex, type PlacedToken } from "#shared/rules/footprint.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { fitSlot } from "../canvas/fitSlot.ts";
import { popoverSlot } from "../components/popoverRules.ts";
import { keyChanges, useKeyChanges } from "../features/device/settings.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ownsEntry, sortedEntries, turnOp, turnStatus } from "../features/encounter/logic.ts";
import { tokenAccess } from "../features/tokens/access.ts";
import { shownRowOps } from "../features/tokens/groupEdit.ts";
import { PLACE_TOOL_ID } from "../features/tokens/placement.ts";
import { cycleStep, type ToolCycle } from "../features/toolChoices.ts";
import { isoOffered, kindSaid, otherViewPress, sayView, topDownTool, turnRefused } from "../features/view/choice.ts";
import { pickView, readView, shownView, turnView, viewKey } from "../features/view/store.ts";
import { hasKeyboard, noteKeyboard, subscribeKeyboard } from "../lib/device.ts";
import { fullscreenSupported, toggleFullscreen } from "../lib/fullscreen.ts";
import { displayName } from "../lib/scene.ts";
import { turned } from "../lib/view.ts";
import { keyLabel, keysInEffect, pressKeys, sameKey, UNBOUND, type KeyChanges, type KeyMap } from "./keyBindings.ts";
import { scopeSlot, type RoomScope } from "./scope.ts";
import { sayTool, tuckEvent } from "./toolbar.ts";
import type { RoomUi } from "./store.ts";
import type { RoomActions, RoomView } from "./types.ts";
import { useRoomActions, useRoomRoleIfAny, useRoomStore, useRoomUi } from "./view.ts";

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
 *
 * Every single key here can be moved on this device, from the shortcut
 * sheet (state/keyBindings.ts): such a row names its default `key`, and a
 * press finds the row by the key in effect. The rows with Ctrl or Cmd, and
 * the arrow, Page, Delete and Backspace keys, keep their own `match`.
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

/**
 * Where an arrow key's step takes a token on a hex scene
 * (docs/design-v1-hex-grids.md HX-D15): its reference hex moves one along
 * the lattice's own numbering. On hex rows Left and Right go along the row,
 * and Up and Down take the same column's hex in the next row, which lies
 * right of straight from an even row and left of it from an odd one, so
 * presses zigzag and keep to one column. Hex columns mirror it. `step` is
 * the Top-down step the view gives (canvas/boardPick.ts nudgeStep).
 */
export function hexNudge(g: HexGrid, token: PlacedToken, step: readonly [number, number]): { x: number; y: number } {
  const ref = tokenRefHex(g, token);
  return placedOnHex(g, token, { col: ref.col + step[0], row: ref.row + step[1] });
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

/** Only the focused history sheet owns these keys. Its text fields keep native Undo. */
export function setupHistoryShortcut(e: KeyPress, gates: { focused: boolean; dm: boolean; preview: boolean; confirming: boolean; scope: HistoryScope }): "undo" | "redo" | null {
  return gates.scope === "setup" && gates.focused && gates.dm && !gates.preview && !gates.confirming ? undoShortcut(e) : null;
}

/** A tool as the table needs it: its id, and for the status the name and the main choice its key moves through. */
export type ShortcutTool = { id: string; label?: string; cycle?: ToolCycle };

/** What a shortcut works with: the Room page's state, actions and its own scope. */
export type ShortcutEnv = {
  role: "dm" | "player";
  /** The toolbar's tools for the role (features/tools.ts toolsFor), passed in so this table loads without them, with each one's main choice. */
  tools: readonly ShortcutTool[];
  getState(): RoomView;
  actions: RoomActions;
  ui: RoomUi;
  scope: RoomScope;
};

export type Shortcut = {
  id: string;
  /** How the shortcut sheet writes the default key, which FEATURES.md lists. */
  keys: string;
  /** What it does, for the sheet. */
  does: string;
  roles: readonly ("dm" | "player")[];
  /** Ctrl or Cmd with the key: undo and redo only. */
  modifier?: true;
  /** Whether it applies now. Left out, whenever the role has it. */
  when?(env: ShortcutEnv): boolean;
  /** Arrow or Page keys, which a focused choice group or slider keeps for itself (ownsNavigationKeys). */
  navigation?: true;
  run(env: ShortcutEnv, e: KeyPress): void;
} & (
  | {
      /** The single key it has by default, a binding (state/keyBindings.ts) this device may change. */
      key: string;
      /** What the sheet calls it where another row asks for its key: "Already Fog". */
      name: string;
      match?: never;
    }
  | { key?: never; name?: never; match(e: KeyPress): boolean }
);

/**
 * The map canvas's part (canvas/Stage.tsx): moving the selection a square
 * and zooming about the middle, which need the camera and the drop rules
 * it holds. Per Room page, as the canvas is.
 */
export const stageKeysSlot = scopeSlot(() => ({
  nudge: null as ((dx: number, dy: number) => void) | null,
  zoom: null as ((factor: number) => void) | null,
  /** Whether the active tool follows a pointer on the map now, a drag or a press not yet lifted, which a tool's key leaves alone. */
  busy: null as (() => boolean) | null,
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

/** A row's default single key, and how the sheet writes it. */
const single = (key: string) => ({ key, keys: keyLabel(key) });

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
    ...single(key),
    name: does,
    does,
    roles,
    when: (env) => {
      if (!env.tools.some((t) => t.id === id)) return false;
      if (id !== "draw" || env.role === "dm") return true;
      // The Draw tool's own rule (docs/design-v1-dm-tools.md 3.9).
      const s = env.getState();
      return drawsAllowed(s.view?.meta.settings ?? {}, s.you?.memberId ?? "");
    },
    run: (env, e) => {
      if (env.getState().local.tool !== id) {
        env.ui.setTool(id);
        return;
      }
      // The key of the tool in use shows its tucked options again, and never tucks them, so a held or repeated key never hides them (docs/design-v1-tool-options.md 5.5).
      tuckEvent(env.scope, id, { kind: "show", tool: id });
      cycleTool(env, id, e.shiftKey && hasCase(shortcutKeys()[`tool:${id}`] ?? key));
    },
  };
}

/**
 * Whether a binding is a letter with case, where Shift goes back. A digit
 * or a symbol may need Shift just to be typed on this layout (`?`, a French
 * keyboard's digits), so there every press goes forward
 * (docs/design-v1-tool-cycle.md 2.3).
 */
function hasCase(binding: string): boolean {
  return binding.toUpperCase() !== binding;
}

/**
 * A second press of the tool's key moves to the next option of its main
 * choice (docs/design-v1-tool-cycle.md 4.1). It moves nothing while the
 * tool's state shows no choice or a drag on the map is under way, and says
 * why instead where a move would lose work. A move closes any open
 * popover first, as a tool change does, and says where it landed.
 */
function cycleTool(env: ShortcutEnv, id: string, back: boolean): void {
  const tool = env.tools.find((t) => t.id === id);
  const choice = tool?.cycle?.now(env);
  if (!tool?.cycle || !choice) return;
  if (env.scope.get(stageKeysSlot).busy?.()) return;
  if (choice.held) {
    sayTool(env.scope, choice.held);
    return;
  }
  const next = cycleStep(choice.options, choice.value, back);
  if (next === null) return;
  env.scope.get(popoverSlot).closeOpen("state");
  tool.cycle.pick(env, next);
  sayTool(env.scope, `${tool.label ?? id}: ${choice.options.find((o) => o.value === next)?.label ?? next}`);
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

/** The scene this page shows, with what the view keys read of it. */
function viewScene(env: ShortcutEnv) {
  const s = env.getState();
  const scene = s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
  if (!scene) return null;
  const key = viewKey(s.roomId);
  return { key, sceneId: scene.id, suggested: scene.suggestedView, tool: s.local.tool, stored: readView(key) };
}

/**
 * Q and E turn the view, on this scene only and never as a pick
 * (docs/design-v1-isometric-view.md 6.5). Where the board shows Top-down
 * they say why they did nothing, which no change on the board would.
 */
function turnKey(env: ShortcutEnv, by: 1 | -1): void {
  const at = viewScene(env);
  if (!at) return;
  const shown = shownView({ stored: at.stored, sceneId: at.sceneId, suggested: at.suggested, forcedTopDown: topDownTool(at.tool) !== null, ready: isoOffered });
  if (shown.kind === "isometric") turnView(at.key, at.sceneId, turned(shown.turn, by));
  else env.ui.notify(turnRefused(at.stored, at.suggested, at.tool));
}

/**
 * I, Q and E (docs/design-v1-isometric-view.md 6.5), for everyone, in the
 * table only once Isometric is offered (features/view/choice.ts isoOffered),
 * so neither the sheet nor FEATURES.md lists a key that does nothing.
 */
export const VIEW_SHORTCUTS: readonly Shortcut[] = [
  {
    id: "view",
    ...single("i"),
    name: "Switch view",
    does: "Switch between top-down and isometric",
    roles: ["dm", "player"],
    when: (env) => viewScene(env) !== null,
    run: (env) => {
      const at = viewScene(env);
      if (!at) return;
      const press = otherViewPress(at.stored, at.suggested, at.tool);
      pickView(at.key, press.pick);
      // The status says a change the board shows. While a tool shows Top-down the board shows none, so the key says it.
      if (press.toast) env.ui.notify(press.toast);
      else if (topDownTool(at.tool) !== null) sayView(env.scope, kindSaid(press.pick));
    },
  },
  {
    id: "turnLeft",
    ...single("q"),
    name: "Turn left",
    does: "Turn the isometric view left",
    roles: ["dm", "player"],
    when: (env) => viewScene(env) !== null,
    run: (env) => turnKey(env, -1),
  },
  {
    id: "turnRight",
    ...single("e"),
    name: "Turn right",
    does: "Turn the isometric view right",
    roles: ["dm", "player"],
    when: (env) => viewScene(env) !== null,
    run: (env) => turnKey(env, 1),
  },
];

/** Every shortcut, one per line, in the order the sheet lists them. */
export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "undo",
    keys: "Ctrl+Z",
    does: "Undo your last play or board change",
    roles: ["dm", "player"],
    modifier: true,
    match: (e) => letterOf(e) === "z" && !e.shiftKey,
    run: (env) => env.actions.undo(),
  },
  {
    id: "redo",
    keys: "Ctrl+Shift+Z",
    does: "Redo your last play or board change",
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
  toolShortcut("trap", "x", "Trap", ["dm"]),
  toolShortcut("fog", "f", "Fog", ["dm"]),
  toolShortcut("build", "b", "Builder", ["dm"]),
  toolShortcut("grid", "g", "Grid", ["dm"]),
  {
    id: "nudge",
    keys: "Arrow keys",
    does: "Move the selected tokens one square, or one hex on a hex scene",
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
    ...single("h"),
    name: "Hide or show",
    does: "Hide or show the selected tokens",
    roles: ["dm"],
    when: withSelection,
    run: (env) => {
      const tokens = selectedTokens(env);
      const visibility = tokens.every((t) => t.visibility === "dm") ? "all" : "dm";
      const ids = tokens.map((t) => t.id);
      const rows = visibility === "all" ? shownRowOps(env.getState().view?.encounter, ids) : [];
      dispatchAll(env, [...batches(ids).map((tokenIds): ClientOp => ({ t: "token.updateMany", tokenIds, patch: { visibility } })), ...rows]);
    },
  },
  {
    id: "lock",
    ...single("l"),
    name: "Lock or unlock",
    does: "Lock or unlock the selected tokens",
    roles: ["dm"],
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
    ...single("n"),
    name: "Next turn",
    does: "Next turn, or End turn on your own turn",
    roles: ["dm", "player"],
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
    // `=` too, the same key without Shift on many layouts (keyBindings.ts sameKey).
    ...single("+"),
    name: "Zoom in",
    does: "Zoom in",
    roles: ["dm", "player"],
    run: (env) => env.scope.get(stageKeysSlot).zoom?.(ZOOM_STEP),
  },
  {
    id: "zoomOut",
    ...single("-"),
    name: "Zoom out",
    does: "Zoom out",
    roles: ["dm", "player"],
    run: (env) => env.scope.get(stageKeysSlot).zoom?.(1 / ZOOM_STEP),
  },
  {
    id: "fit",
    ...single("0"),
    name: "Fit the map",
    does: "Fit the map",
    roles: ["dm", "player"],
    run: (env) => env.scope.get(fitSlot).fit?.(),
  },
  ...(isoOffered ? VIEW_SHORTCUTS : []),
  {
    id: "outliner",
    ...single("/"),
    name: "Search the scene",
    does: "Search the scene in the outliner",
    roles: ["dm"],
    run: (env) => {
      const search = env.scope.get(outlinerSearchSlot);
      search.focusNext = true;
      env.ui.openPanel("outliner");
      for (const listener of search.listeners) listener();
    },
  },
  {
    id: "sidePanel",
    ...single("s"),
    name: "Side panel",
    does: "Hide or show the side panel",
    roles: ["dm", "player"],
    when: (env) => env.scope.get(sidePanelKeysSlot).toggle !== null,
    run: (env) => env.scope.get(sidePanelKeysSlot).toggle?.(),
  },
  {
    id: "otherPanel",
    ...single("o"),
    name: "Other panel",
    does: "Go to the other panel, with two in the side panel",
    roles: ["dm", "player"],
    when: (env) => env.scope.get(splitKeysSlot).other !== null,
    run: (env) => env.scope.get(splitKeysSlot).other?.(),
  },
  {
    // F is the DM's Fog, and Shift+F too, since a letter matches with Shift, so the letter is one no role has. A keydown is a user gesture, which the browser asks of a request.
    id: "fullscreen",
    ...single("w"),
    name: "Full screen",
    does: "Enter or leave full screen, where the browser can",
    roles: ["dm", "player"],
    when: () => fullscreenSupported(),
    run: () => void toggleFullscreen(),
  },
  {
    id: "sheet",
    ...single("?"),
    name: "Shortcuts",
    does: "Show these shortcuts",
    roles: ["dm", "player"],
    run: (env) => setShortcutSheet(env.scope, true),
  },
];

/** The shortcuts a role has, for the sheet. */
export function shortcutsFor(role: "dm" | "player"): Shortcut[] {
  return SHORTCUTS.filter((s) => s.roles.includes(role));
}

/** Each rebindable shortcut's default key, by id. */
export const DEFAULT_KEYS: KeyMap = Object.fromEntries(SHORTCUTS.flatMap((s) => (s.key === undefined ? [] : [[s.id, s.key]])));

let inEffect: { changes: KeyChanges; keys: KeyMap } | null = null;

/** The keys this device's shortcuts have now: its changes over the defaults (state/keyBindings.ts keysInEffect). */
export function shortcutKeys(changes: KeyChanges = keyChanges()): KeyMap {
  if (inEffect?.changes !== changes) inEffect = { changes, keys: keysInEffect(DEFAULT_KEYS, changes) };
  return inEffect.keys;
}

/** The keys in effect, followed as the sheet changes one, so every place that writes a key writes the new one at once. */
export function useShortcutKeys(): KeyMap {
  return shortcutKeys(useKeyChanges());
}

/** How the sheet, a tooltip or a line of help writes a shortcut's key on this device: "F", or a fixed row's own words. */
export function keyText(id: string, keys: KeyMap = shortcutKeys()): string {
  const key = keys[id];
  return key === undefined ? (SHORTCUTS.find((s) => s.id === id)?.keys ?? "") : keyLabel(key);
}

/**
 * A control's key (D-261028-09): `text` as the sheet writes it, for the
 * control's tooltip ("Fog (F)") or its words ("Turn left (Q)"), and `aria`
 * for its `aria-keyshortcuts`, in that attribute's own key names. Every
 * control that does what a shortcut does takes its key from here, so none
 * writes a key of its own that could drift from the sheet.
 */
export type KeyHint = { text: string; aria: string };

/** The fixed rows' keys in `aria-keyshortcuts` names, one entry per key the sheet lists, so `part` can pick one. */
const FIXED_ARIA: Readonly<Record<string, readonly string[]>> = {
  undo: ["Control+Z Meta+Z"],
  redo: ["Control+Shift+Z Meta+Shift+Z"],
  elevation: ["PageUp", "PageDown"],
  delete: ["Delete", "Backspace"],
};

/** A single key's `aria-keyshortcuts` name. The attribute joins keys with `+` and lists shortcuts with spaces, so those two have names. */
function ariaKey(key: string): string {
  if (key === "+") return "Plus";
  if (key === " ") return "Space";
  return keyLabel(key);
}

/**
 * The key of shortcut `id` for a control, or null where pressing it would
 * do nothing for this role or no key is set: a shortcut the role lacks, a
 * row the table does not hold now (the view's keys while Isometric is not
 * offered), or a key this device moved away (keyBindings.ts UNBOUND).
 * `part` picks one key of a fixed row that lists two, as Elevation's
 * Page Up for its Up 5 feet.
 */
export function keyHint(id: string, role: "dm" | "player", keys: KeyMap = shortcutKeys(), part?: number): KeyHint | null {
  const row = SHORTCUTS.find((s) => s.id === id);
  if (!row || !row.roles.includes(role)) return null;
  if (row.key !== undefined) {
    const key = keys[id];
    return key ? { text: keyLabel(key), aria: ariaKey(key) } : null;
  }
  const aria = FIXED_ARIA[id];
  if (!aria) return null;
  if (part === undefined) return { text: row.keys, aria: aria.join(" ") };
  const text = row.keys.split(", ")[part];
  const one = aria[part];
  return text !== undefined && one !== undefined ? { text, aria: one } : null;
}

/** What follows a control's name for its key, " (F)", or nothing without one: drawn after words that already name the action, hidden from screen readers, which hear `aria-keyshortcuts`. */
export function keySuffix(hint: KeyHint | null): string {
  return hint ? ` (${hint.text})` : "";
}

/** A control's name with its key, "Fog (F)", or the name alone without one. */
export function withKey(name: string, hint: KeyHint | null): string {
  return name + keySuffix(hint);
}

/**
 * keyHint for the controls on this page, following the sheet's changes, for
 * a component that draws several, such as the toolbar. None where no key
 * can be pressed: on a touch screen that has shown no keyboard
 * (lib/device.ts hasKeyboard), in "view as a player", which answers no key
 * but Escape, on a table display, which has no shortcuts, and outside a
 * room.
 */
export function useKeyHints(): (id: string, part?: number) => KeyHint | null {
  const keys = useShortcutKeys();
  const room = useRoomRoleIfAny();
  const preview = usePreview() !== null;
  const keyboard = useHasKeyboard();
  const role = room && !room.display && !preview && keyboard ? room.role : null;
  return (id, part) => (role ? keyHint(id, role, keys, part) : null);
}

/** lib/device.ts hasKeyboard, followed: a touch screen's first key shows every control's key at once, with nothing mounted again. */
function useHasKeyboard(): boolean {
  return useSyncExternalStore(subscribeKeyboard, hasKeyboard, hasKeyboard);
}

/**
 * The keys of a surface's own buttons: fixed rows of BEHAVIORS, which no
 * device moves, kept apart from the room's rebindable keys. Each lists its
 * `aria-keyshortcuts` names, one entry per key the sheet's row lists, so
 * `part` picks one. The handout viewer's are features/handouts/zoom.ts
 * viewerKey's, where `=` zooms in as `+` does.
 */
const SURFACE_ARIA: Readonly<Record<string, readonly string[]>> = {
  viewerZoom: ["Plus =", "-"],
  viewerReset: ["0"],
  setupUndo: ["Control+Z Meta+Z"],
  setupRedo: ["Control+Shift+Z Meta+Shift+Z"],
};

/** The key of a surface's fixed row for one of its buttons, as the sheet writes it: the handout viewer's "+" for Zoom in. Null for a row this table does not hold. */
export function surfaceKeyHint(id: string, part = 0): KeyHint | null {
  const text = BEHAVIORS.find((b) => b.id === id)?.input.split(", ")[part];
  const aria = SURFACE_ARIA[id]?.[part];
  return text !== undefined && aria !== undefined ? { text, aria } : null;
}

/** surfaceKeyHint on this device: none on a touch screen that has shown no keyboard. A surface's keys work for every role and in "view as a player". */
export function useSurfaceKeyHint(id: string, part?: number): KeyHint | null {
  return useHasKeyboard() ? surfaceKeyHint(id, part) : null;
}

/** keyHint for one control on this page (useKeyHints). */
export function useKeyHint(id: string, part?: number): KeyHint | null {
  return useKeyHints()(id, part);
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
export type BehaviorDevice = "keys" | "mouse" | "android" | "pointer";

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
  "Adding an image",
  "Setup history",
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

/**
 * The isometric view's row beside its keys (docs/design-v1-isometric-view.md
 * 6.2: the standees' tap, in canvas/Stage.tsx and state/selection.ts), in
 * the table only once Isometric is offered, as VIEW_SHORTCUTS are.
 */
export const VIEW_BEHAVIORS: readonly Behavior[] = [{ id: "tapAgain", input: "Tap a standee again", does: "Pick the one behind it, in isometric", roles: EVERYONE, device: "pointer" }];

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
  // A paste no image entry took: features/images/pasteRouter.ts, and the offer in features/images/RoomPaste.tsx. The app hears the paste, never the key, so it is not rebound.
  {
    id: "roomPaste",
    input: "Ctrl+V (Cmd+V on a Mac)",
    does: "Use a copied image as a new scene, the selected token's picture, a stamp or a handout",
    roles: DM,
    when: "with nothing open that takes it",
    device: "keys",
  },

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

  // Dragging attached tokens, with a mouse or a finger alike (docs/design-v1-attach.md 4.2 and 4.6): canvas/Stage.tsx and features/attach/groups.ts dragLead, dragNamed.
  {
    id: "dragHolder",
    input: "Drag a token that carries others",
    does: "Move it with what it carries, and what those carry. A press in its middle takes it, even on a small token it carries or one that token carries",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "pointer",
  },
  {
    id: "dragRider",
    input: "Drag the rider of a controlled mount",
    does: "Move the mount, the rider riding. So does a drag of a rider that covers its whole mount",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "pointer",
  },
  {
    id: "dragCarried",
    input: "Drag any other carried token",
    does: "Move it alone, from nearer its holder's edge than its middle. Dropped on its holder, or within 5 ft of the creature dragging it, it stays attached, and anywhere else it comes loose",
    roles: EVERYONE,
    when: "with the Select tool",
    device: "pointer",
  },
  ...(isoOffered ? VIEW_BEHAVIORS : []),

  // A roll button's one-roll options (docs/design-v1-roll-mode-menu.md 3): features/dice/useRollModeMenu.tsx and rollPress.ts. The keys are each surface's own, below.
  {
    id: "rollOptionsRight",
    input: "Right-click a roll button",
    does: "Open its one-roll options, such as Advantage or Secret, without rolling. Right-click it again to close them",
    roles: EVERYONE,
    device: "mouse",
  },
  { id: "rollOptionsHold", input: "Hold a roll button", does: "Open its one-roll options after half a second, without rolling. Tap a choice to roll once that way", roles: EVERYONE, device: "pointer" },
  { id: "rollOptionsReader", input: "Double-tap and hold a roll button with a screen reader", does: "Open its one-roll options. A plain double-tap still rolls", roles: EVERYONE, device: "pointer" },
  // The fight's cards have no surface of their own: features/encounter/CardRoll.tsx for concentration, save-ends and death-save cards.
  {
    id: "cardRollOptions",
    input: "ContextMenu, Shift+F10",
    does: "Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before",
    roles: EVERYONE,
    when: "on a fight card's focused Roll",
    device: "keys",
  },
  { id: "cardRollOptionsKeys", input: "Up, Down, Home, End", does: "Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on", roles: EVERYONE, when: "in a fight card's roll options", device: "keys" },

  // The toolbar: state/shortcuts.ts toolShortcut, components/Menu.tsx in Setup and the tool menu (pages/Room.tsx Toolbar).
  // Keys are drawn whole on one line in the sheet, so a row's key stays short and its condition goes in `when`.
  {
    id: "toolKeyShow",
    input: "The tool's key",
    does: "Show its hidden options and go to its next main choice, such as Area's next shape. With Shift on a letter key, the one before. It never hides them",
    roles: EVERYONE,
    when: "for the tool in use",
    device: "keys",
    surface: "Toolbar",
  },
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
  { id: "initEnter", input: "Enter", does: "Save the Initiative you typed", roles: EVERYONE, when: "in a row's Initiative box", device: "keys", surface: "Initiative" },
  { id: "initEscape", input: "Escape", does: "Drop the Initiative you typed", roles: EVERYONE, when: "in a row's Initiative box", device: "keys", surface: "Initiative" },
  {
    id: "initSeveral",
    input: "Enter",
    does: "Go to the next box, and save after the last",
    roles: DM,
    when: "while typing several values",
    device: "keys",
    surface: "Initiative",
  },
  // A roll's one-roll options in the tracker: features/encounter/Row.tsx and AutoInitiative.tsx.
  {
    id: "initRollOptions",
    input: "ContextMenu, Shift+F10",
    does: "Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before",
    roles: EVERYONE,
    when: "on a focused Roll or Auto Initiative",
    device: "keys",
    surface: "Initiative",
  },
  {
    id: "initRollOptionsKeys",
    input: "Up, Down, Home, End",
    does: "Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on",
    roles: EVERYONE,
    when: "in roll options",
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
  // A throw of your own dice: features/dice/throw/store.ts, through DicePanel.tsx's capture-phase listeners (docs/design-v1-roll-animation.md 3.5). A tap is listed with the key, as the two do the same.
  {
    id: "diceThrowEnd",
    input: "Any tap or key",
    does: "Show the result at once, then do its own job",
    roles: EVERYONE,
    when: "in the Dice panel while your dice are in the air",
    device: "keys",
    surface: "Dice",
  },
  // The group save's damage field: features/dice/groupSave/GroupSave.tsx (docs/design-v1-roll-options.md 14).
  { id: "groupDamageEnter", input: "Enter", does: "Roll the parts, or take the typed numbers", roles: DM, when: "in the group save's damage field", device: "keys", surface: "Dice" },
  // A player's creature tabs: features/dice/RollOptions.tsx CreatureTabs, lib/a11y.ts tabKeyIndex (docs/design-v1-dice-pass.md 6.6).
  { id: "diceTabs", input: "Left, Right, Home, End", does: "Pick another creature to roll for", roles: EVERYONE, when: "in the Dice panel's creature tabs", device: "keys", surface: "Dice" },
  // A roll button's one-roll options: features/dice/useRollModeMenu.tsx, components/Menu.tsx and menuKeys.ts for its list (docs/design-v1-roll-mode-menu.md 3.3).
  {
    id: "diceRollOptions",
    input: "ContextMenu, Shift+F10",
    does: "Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before",
    roles: EVERYONE,
    when: "on a focused roll button",
    device: "keys",
    surface: "Dice",
  },
  {
    id: "diceRollOptionsKeys",
    input: "Up, Down, Home, End",
    does: "Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on",
    roles: EVERYONE,
    when: "in roll options",
    device: "keys",
    surface: "Dice",
  },

  // Request a roll's fields: features/rolls/RequestSheet.tsx, one form whose submit is Send (docs/design-v1-roll-request.md 8).
  { id: "rollAskEnter", input: "Enter", does: "Send the request", roles: DM, when: "in Request a roll's DC or note field", device: "keys", surface: "Roll requests" },
  // The player's roll card: features/rolls/PlayerRolls.tsx. Send always took Enter in the Total field, and the sheet now lists it.
  { id: "rollCardSend", input: "Enter", does: "Send the total you typed", roles: PLAYER, when: "in a roll card's Total field", device: "keys", surface: "Roll requests" },
  { id: "rollCardRoll", input: "Enter", does: "Roll, with the bonus and extra dice you typed", roles: PLAYER, when: "in a roll card's Bonus or Extra dice field", device: "keys", surface: "Roll requests" },
  // A request's Roll, the player's card and the DM's waiting row: features/rolls/PlayerRolls.tsx and DmDesk.tsx.
  {
    id: "rollCardRollOptions",
    input: "ContextMenu, Shift+F10",
    does: "Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before",
    roles: EVERYONE,
    when: "on a request's focused Roll",
    device: "keys",
    surface: "Roll requests",
  },
  {
    id: "rollCardRollOptionsKeys",
    input: "Up, Down, Home, End",
    does: "Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on",
    roles: EVERYONE,
    when: "in roll options",
    device: "keys",
    surface: "Roll requests",
  },

  // The token's and characters' one-line fields: features/tokens/ui.tsx TextField and NumberField.
  { id: "fieldEnter", input: "Enter", does: "Save the field and leave it", roles: EVERYONE, when: "in a one-line field", device: "keys", surface: "Token and character fields" },
  { id: "fieldEscape", input: "Escape", does: "Drop what you typed and leave the field", roles: EVERYONE, when: "in a one-line field", device: "keys", surface: "Token and character fields" },
  // HP's Death Save Roll, in the token's bar and panel and the character sheet: features/tokens/HpSection.tsx.
  {
    id: "fieldRollOptions",
    input: "ContextMenu, Shift+F10",
    does: "Open the roll's one-roll options, the first choice focused. Enter and Space still roll as before",
    roles: EVERYONE,
    when: "on a focused Death Save Roll in HP",
    device: "keys",
    surface: "Token and character fields",
  },
  {
    id: "fieldRollOptionsKeys",
    input: "Up, Down, Home, End",
    does: "Move through the choices. Enter or Space rolls once that way, Escape closes them back on the roll button, and Tab closes them and moves on",
    roles: EVERYONE,
    when: "in roll options",
    device: "keys",
    surface: "Token and character fields",
  },

  // The map panes: features/builder/LabelPane.tsx, features/pins/PinPane.tsx, features/lights/LightPane.tsx.
  { id: "paneEnter", input: "Enter", does: "Finish the text, as Done does, or save a light's name", roles: DM, device: "keys", surface: "Label, pin and light panes" },
  { id: "paneEscape", input: "Escape", does: "Close the pane", roles: DM, device: "keys", surface: "Label, pin and light panes" },

  // Every dialog: components/Dialog.tsx, lib/modalDialog.ts, features/journal/JournalEditor.tsx, features/monsters/MonsterEditor.tsx.
  { id: "dialogEscape", input: "Escape", does: "Close it. A journal page or a monster with unsaved changes asks first", roles: EVERYONE, device: "keys", surface: "Dialogs" },
  { id: "dialogTab", input: "Tab, Shift+Tab", does: "Move through its controls without leaving it", roles: EVERYONE, device: "keys", surface: "Dialogs" },

  { id: "setupUndo", input: "Ctrl+Z (Cmd+Z on a Mac)", does: "Undo the next setup step", roles: DM, device: "keys", surface: "Setup history" },
  { id: "setupRedo", input: "Ctrl+Shift+Z (Cmd+Shift+Z on a Mac)", does: "Redo the next setup step", roles: DM, device: "keys", surface: "Setup history" },
  { id: "setupEscape", input: "Escape", does: "Close the sheet and return focus to its opener", roles: DM, device: "keys", surface: "Setup history" },
  { id: "historyDoubleClick", input: "Double click or tap on Undo or Redo", does: "Take back or restore one step. A second tap in the same double-click sequence never takes the following step", roles: EVERYONE, device: "pointer" },

  // Every image entry: features/images/pasteRouter.ts, which picks the one a paste lands in (docs/design-v1-paste.md 1.3).
  {
    id: "pickerPaste",
    input: "Ctrl+V (Cmd+V on a Mac)",
    does: "Paste a copied image there. Choose an image also takes an https link",
    roles: EVERYONE,
    device: "keys",
    surface: "Adding an image",
  },
];

/**
 * One row of the sheet, from either table. `keys` writes the input as keys
 * on a keyboard. `rebind` marks a key this device may change, and says
 * whether it differs from its default.
 */
export type SheetRow = { id: string; input: string; does: string; when?: string; keys: boolean; rebind?: { name: string; changed: boolean } };

export type SheetSection = { title: string; intro?: string; rows: SheetRow[] };

/** What the device has that decides which rows show: a mouse or trackpad, and Android's Back button. */
export type SheetDevice = { mouse: boolean; android: boolean };

/** The heading of the mouse rows' section. */
export const MOUSE_SECTION = "Mouse with keys";

/** The heading of the rows a plain drag gives on every device, a mouse's or a finger's. */
export const POINTER_SECTION = "Mouse and touch";

/** The sheet's Keys intro, which FEATURES.md repeats. */
export const KEYS_INTRO = "On any device with a keyboard. They do nothing while you type in a field or a dialog is open. On a Mac, Cmd works where Ctrl is written.";

/** A line under a surface's heading, where its rows do not say where it is. */
const POINTER_INTRO = "On any device. A token that carries others, such as a rider's mount or a holder of a torch, drags as a group.";

const SURFACE_INTRO: Partial<Record<Surface, string>> = {
  "Setup history": "While this sheet has focus, outside text fields. Separate key presses wait for the next step. Held keys do not repeat.",
  Toolbar: "Each tool key picks its tool, also one behind Setup or the tool menu.",
  "Tool options": "A tool's options row, its More options and the pop-ups its buttons open.",
  "Side panel tabs":
    "On a screen 900 px or wider, with a tab or More's list focused. There, and on a focused choice or slider, the arrow and Page keys never move a token, and in the list a letter goes to a panel instead of running a shortcut.",
  "Two panels": "On a screen 900 px or wider, with two panels in the side panel. With the bar's grip focused, the arrow keys move the bar and never move a token.",
  "Handout viewer": "A handout the DM shows, or a picture or a PDF opened from the Library.",
  "Token window": "Where the action bar opens as a window: on a screen 600 px or wider, or a phone on its side. With its grip or corner handle focused, the arrow keys move or resize it and never move a token.",
  "Adding an image":
    "Choose an image, the stamp picker, New scene's Map image, Show a handout, and a scene's Map image or Add a phase with focus there. In a text field, only a copied image with no text.",
};

/** What the sheet writes for a row whose default key another row's change took (keyBindings.ts UNBOUND). */
export const NO_KEY = "No key";

function keyRow(s: Shortcut, keys: KeyMap): SheetRow {
  if (s.key === undefined) return { id: s.id, input: s.keys, does: s.does, keys: true };
  const key = keys[s.id] ?? s.key;
  const rebind = { name: s.name, changed: key !== s.key };
  return key === UNBOUND ? { id: s.id, input: NO_KEY, does: s.does, keys: false, rebind } : { id: s.id, input: keyLabel(key), does: s.does, keys: true, rebind };
}

function sheetRow(b: Behavior): SheetRow {
  return { id: b.id, input: b.input, does: b.does, ...(b.when ? { when: b.when } : {}), keys: b.device === "keys" };
}

/**
 * The sheet's sections for a role on a device, in order: Keys, the mouse
 * with keys where there is a mouse or trackpad, the drags every device
 * has, Android's Back button on Android, then each surface's keys. A section with no row for the role
 * and the device is left out. Each key is the one in effect on this device.
 */
export function sheetSections(role: "dm" | "player", device: SheetDevice, keys: KeyMap = shortcutKeys()): SheetSection[] {
  const mine = BEHAVIORS.filter((b) => b.roles.includes(role));
  const room = mine.filter((b) => b.surface === undefined);
  const sections: SheetSection[] = [
    {
      title: "Keys",
      intro: KEYS_INTRO,
      rows: [...shortcutsFor(role).map((s) => keyRow(s, keys)), ...room.filter((b) => b.device === "keys").map(sheetRow)],
    },
    { title: MOUSE_SECTION, rows: device.mouse ? room.filter((b) => b.device === "mouse").map(sheetRow) : [] },
    { title: POINTER_SECTION, intro: POINTER_INTRO, rows: room.filter((b) => b.device === "pointer").map(sheetRow) },
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

/**
 * The shortcut a press runs, or null. Pure but for the conditions, which
 * read `env`, and the keys in effect, which are this device's unless given.
 * A single key is found by the character it types first, and only then by
 * the Latin letter of its place (keyBindings.ts pressKeys).
 */
export function shortcutFor(e: KeyPress, env: ShortcutEnv, gates: ShortcutGates, keys: KeyMap = shortcutKeys()): Shortcut | null {
  if (e.defaultPrevented || e.repeat || gates.preview || gates.dialogOpen || e.altKey || isTextField(e.target)) return null;
  const modifier = e.ctrlKey || e.metaKey;
  const mine = SHORTCUTS.filter((s) => s.roles.includes(env.role) && (s.modifier === true) === modifier);
  const bound = (k: string) => mine.find((s) => s.key !== undefined && sameKey(keys[s.id] ?? s.key, k));
  const shortcut = (modifier ? undefined : pressKeys(e).map(bound).find((s) => s !== undefined)) ?? mine.find((s) => s.match?.(e) === true);
  if (!shortcut) return null;
  if (shortcut.navigation && ownsNavigationKeys(e.target)) return null;
  return !shortcut.when || shortcut.when(env) ? shortcut : null;
}

/**
 * The one window listener, mounted by the Room page. A "view as a player"
 * preview's page passes `preview`, so it answers no key at all.
 */
export function useShortcuts(input: { role: "dm" | "player"; tools: readonly ShortcutTool[]; scope: RoomScope; preview: boolean }): void {
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTextField(e.target)) noteKeyboard(e.key);
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
