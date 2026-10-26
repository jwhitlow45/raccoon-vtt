/**
 * The room's single keys, moved per device (the project owner, 2026-10-18):
 * what a press binds, which keys stay as they are, which bindings a press
 * reaches, and which of a device's saved changes still hold. Pure, so it is
 * tested without a DOM. The table the bindings belong to is
 * state/shortcuts.ts, and the store that keeps a device's changes is
 * features/device/settings.ts.
 *
 * A binding is the one character a key types, as the room's letters always
 * matched: a Latin letter in lowercase, reached by `key`, or by the letter
 * of its `code` on a layout of another script, so a Cyrillic layout still
 * reaches it. Anything else (a digit, a symbol, a letter with no Latin
 * place) is reached by `key` alone, with Shift allowed, since `?` takes
 * Shift on most layouts.
 *
 * Keys with Ctrl, Cmd or Alt stay the browser's and undo's. The arrow and
 * Page keys, Delete and Backspace, Enter, Tab and Space stay too: they move,
 * raise and delete tokens, work buttons and pan the map, and a device that
 * moved one could be left with no way to do that by keyboard.
 */

/** A device's changes from the default keys, by shortcut id. Only the changes, so a new default reaches every device that never changed that key. */
export type KeyChanges = Readonly<Record<string, string>>;

/** Each rebindable shortcut's key, by shortcut id. */
export type KeyMap = Readonly<Record<string, string>>;

/** The parts of a keydown a binding reads. */
export type KeyEvent = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean };

/** The stored form's version. A store of another version reads as no changes, so a device that went back a version gets the defaults. */
export const KEYS_VERSION = 1;

const LATIN = /^[a-z]$/;

/** Whether a key, typed or stored, can be a binding: one printable character other than a space, in lowercase. */
export function bindable(key: string): boolean {
  return [...key].length === 1 && key === key.toLowerCase() && !/[\s\p{C}]/u.test(key);
}

/** How the sheet and the tooltips write a binding: "F", "/", "0". */
export function keyLabel(key: string): string {
  return key.toUpperCase();
}

/**
 * Whether two bindings are one key. `+` and `=` are, since `=` is the same
 * key without Shift on many layouts, and Zoom in has always taken both.
 */
export function sameKey(a: string, b: string): boolean {
  return a === b || (a === "+" && b === "=") || (a === "=" && b === "+");
}

/** What a press asks for while the sheet waits for a key. `wait` is a press that is not the key yet: Shift on its own, or a held key's repeat. */
export type Captured = { t: "key"; key: string } | { t: "cancel" } | { t: "refused"; reason: string } | { t: "wait" };

const ALONE = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock", "Symbol", "SymbolLock"]);

const MOVES = "The arrow and Page keys stay for moving and raising tokens.";
const BUTTONS = "Enter and Tab stay for buttons and moving between them.";
const DELETES = "Delete and Backspace stay for deleting tokens.";

/** The keys that stay as they are, and why, as the sheet says it when one is pressed. */
const KEPT: Readonly<Record<string, string>> = {
  " ": "Space stays for moving the map with a drag.",
  ArrowUp: MOVES,
  ArrowDown: MOVES,
  ArrowLeft: MOVES,
  ArrowRight: MOVES,
  PageUp: MOVES,
  PageDown: MOVES,
  Delete: DELETES,
  Backspace: DELETES,
  Enter: BUTTONS,
  Tab: BUTTONS,
};

export const WITH_MODIFIER = "Keys with Ctrl, Cmd or Alt stay as they are.";
export const NOT_A_KEY = "Only a letter, a digit or a symbol can be a shortcut.";

/** The binding a press makes: its Latin letter, by `key` or on another script's layout by `code`, else the character it types. */
export function bindingOf(e: Pick<KeyEvent, "key" | "code">): string | null {
  if ([...e.key].length !== 1) return null;
  const typed = e.key.toLowerCase();
  if (LATIN.test(typed)) return typed;
  if (/^\p{L}$/u.test(typed) && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return bindable(typed) ? typed : null;
}

/** What a press means while the sheet waits for a key: Escape cancels, a key that stays as it is is refused with the reason. */
export function captureKey(e: KeyEvent): Captured {
  if (e.key === "Escape") return { t: "cancel" };
  if (e.repeat || ALONE.has(e.key)) return { t: "wait" };
  if (e.ctrlKey || e.metaKey || e.altKey) return { t: "refused", reason: WITH_MODIFIER };
  const kept = KEPT[e.key];
  if (kept) return { t: "refused", reason: kept };
  const key = bindingOf(e);
  return key === null ? { t: "refused", reason: NOT_A_KEY } : { t: "key", key };
}

/**
 * The bindings a press reaches, best first: the character it types, then
 * the Latin letter of its `code` where it types another character. So a
 * binding a layout prints where another layout has a letter, such as `,`
 * where QWERTY has M on a French keyboard, wins over the letter there.
 */
export function pressKeys(e: Pick<KeyEvent, "key" | "code">): string[] {
  if ([...e.key].length !== 1) return [];
  const typed = e.key.toLowerCase();
  return !LATIN.test(typed) && /^Key[A-Z]$/.test(e.code) ? [typed, e.code.slice(3).toLowerCase()] : [typed];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A device's stored changes, or none for anything it cannot read: nothing stored, another version, or not JSON. An entry that is no binding is left out. */
export function parseKeyChanges(raw: string | null): KeyChanges {
  if (raw === null) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(data) || data.v !== KEYS_VERSION || !isRecord(data.keys)) return {};
  const changes: Record<string, string> = {};
  for (const [id, key] of Object.entries(data.keys)) if (typeof key === "string" && bindable(key)) changes[id] = key;
  return changes;
}

export function formatKeyChanges(changes: KeyChanges): string {
  return JSON.stringify({ v: KEYS_VERSION, keys: changes });
}

/** A row with no key on this device: its default is another row's change. */
export const UNBOUND = "";

/**
 * The key each shortcut has on this device: its change where that still
 * makes sense, else its default. A change for a shortcut the table no
 * longer has is ignored, and so are changes that share one key with each
 * other: each of those rows takes its default back. A change that meets
 * another row's default wins, and that row is left UNBOUND (D-261026-12):
 * a key someone chose stays theirs when a new default comes along, as I,
 * Q and E did. Unbinding moves no change and no default, so one pass ends
 * it, and the defaults never share a key (shortcuts.test.ts).
 */
export function keysInEffect(defaults: KeyMap, changes: KeyChanges): KeyMap {
  const keys: Record<string, string> = { ...defaults };
  const changed = new Set<string>();
  for (const [id, key] of Object.entries(changes)) {
    if (!Object.hasOwn(defaults, id) || !bindable(key) || key === defaults[id]) continue;
    keys[id] = key;
    changed.add(id);
  }
  const sharing = (id: string) => [...changed].some((other) => other !== id && sameKey(keys[other]!, keys[id]!));
  for (const id of [...changed].filter(sharing)) {
    keys[id] = defaults[id]!;
    changed.delete(id);
  }
  for (const id of Object.keys(keys)) if (!changed.has(id) && sharing(id)) keys[id] = UNBOUND;
  return keys;
}

/** The shortcut other than `id` that has this key, or null. No row holds UNBOUND. */
export function holder(keys: KeyMap, id: string, key: string): string | null {
  if (key === UNBOUND) return null;
  for (const [other, k] of Object.entries(keys)) if (other !== id && sameKey(k, key)) return other;
  return null;
}

/** The changes that give these keys: the rows that differ from their defaults. */
function changesFrom(defaults: KeyMap, keys: KeyMap): KeyChanges {
  const changes: Record<string, string> = {};
  // An unbound row is no change of its own: it gets its key back once the change on it goes.
  for (const [id, key] of Object.entries(keys)) if (Object.hasOwn(defaults, id) && key !== defaults[id] && key !== UNBOUND) changes[id] = key;
  return changes;
}

export type ChangeResult = { t: "done"; changes: KeyChanges } | { t: "taken"; by: string };

/** Gives a shortcut a key, or says which shortcut has it already. */
export function changeKey(defaults: KeyMap, changes: KeyChanges, id: string, key: string): ChangeResult {
  const keys = keysInEffect(defaults, changes);
  if (!Object.hasOwn(defaults, id) || !bindable(key)) return { t: "done", changes: changesFrom(defaults, keys) };
  const by = holder(keys, id, key);
  return by === null ? { t: "done", changes: changesFrom(defaults, { ...keys, [id]: key }) } : { t: "taken", by };
}

/** Gives a shortcut a key, and the shortcut that had it the key this one had. */
export function swapKey(defaults: KeyMap, changes: KeyChanges, id: string, key: string): KeyChanges {
  const keys = keysInEffect(defaults, changes);
  if (!Object.hasOwn(defaults, id) || !bindable(key)) return changesFrom(defaults, keys);
  const by = holder(keys, id, key);
  return changesFrom(defaults, { ...keys, [id]: key, ...(by === null ? {} : { [by]: keys[id]! }) });
}

/**
 * Gives a shortcut its default key back. Where another shortcut has taken
 * that key since, the two swap, so the other keeps a key of its own and
 * shows its Reset in turn.
 */
export function resetKey(defaults: KeyMap, changes: KeyChanges, id: string): KeyChanges {
  return Object.hasOwn(defaults, id) ? swapKey(defaults, changes, id, defaults[id]!) : changesFrom(defaults, keysInEffect(defaults, changes));
}
