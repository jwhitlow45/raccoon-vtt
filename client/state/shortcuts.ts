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
