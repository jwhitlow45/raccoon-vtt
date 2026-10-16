import { scopeSlot } from "../state/scope.ts";

/**
 * The shared popover base's rules (docs/design-v1-tool-options.md 7.1),
 * as pure functions and one small store, so they are tested without a
 * page. components/Popover.tsx holds the component and the listeners that
 * feed them. Every non-modal popover and menu in the room follows them:
 * the tool options' popovers, Setup and Tools, and the side panel's More.
 * A consumer adds its own role, look, keys and contents, never rules.
 */

/** How a popover was opened: by a key on its anchor (focus goes in), or by a pointer (focus stays on the anchor). `from` is "last" for Up on a menu's anchor. */
export type OpenHow = { readonly by: "key" | "pointer"; readonly from: "first" | "last" };

/**
 * Where focus goes as a popover opens. Only a key open moves it inside:
 * Enter or Space on the anchor (a click with no pointer, `detail` 0), or
 * Down or Up on a menu's anchor. A pointer open puts it on the anchor
 * itself, never inside. Safari does not focus a pressed button by itself,
 * so the base does it, and every browser ends the same way: focus on the
 * anchor, ready for Escape, Tab or a key to go in.
 */
export function openFocus(how: OpenHow): "inside" | "anchor" {
  return how.by === "key" ? "inside" : "anchor";
}

/** Why a popover closed, which decides where focus goes (focusOnClose). */
export type CloseReason =
  /** A press on its anchor. */
  | "anchor"
  /** A press outside it and its anchor, on anything but the map, as the press starts. */
  | "press"
  /** A press on the map that ended as one pointer. */
  | "map"
  | "escape"
  /** Android's Back, or the browser's. */
  | "back"
  /** Tab out past its end, or at once in a menu: focus moves on as Tab from the anchor would. */
  | "tab"
  /** Shift+Tab out before its start, or at once in a menu. */
  | "shiftTab"
  /** A pick that closes it: a menu item, a choice. */
  | "pick"
  /** Focus moved to an element outside it and its anchor. */
  | "focus"
  /** Another popover in the room opened. */
  | "replaced"
  /** Its anchor left the page or its surface hid. */
  | "gone"
  /** Its consumer closed it for a change of state: a tool change, a sheet opening, a scene change. */
  | "state";

/** Where focus is as a popover closes, against it and its anchor. "page" is no element: the body, or nothing. */
export type FocusAt = "inside" | "anchor" | "page" | "outside";

/**
 * Where focus goes as a popover closes: on its anchor, or left where it
 * is (null). Escape, Shift+Tab and a pick put it on the anchor, from the
 * page too, since focus that fell to the page leaves a keyboard nowhere.
 * Any other close does so only while focus is inside or on the anchor.
 * Tab moves on, a press leaves focus where the press put it, and focus
 * that moved away stays where it went.
 */
export function focusOnClose(reason: CloseReason, at: FocusAt): "anchor" | null {
  if (reason === "tab" || reason === "focus" || reason === "press" || reason === "map" || reason === "replaced") return null;
  if (reason === "escape" || reason === "shiftTab" || reason === "pick") return at === "outside" ? null : "anchor";
  return at === "inside" || at === "anchor" ? "anchor" : null;
}

/** Whether focus arriving somewhere closes an open popover: only an element outside it and its anchor. Focus that falls to the page is not a move away. */
export function focusMoveCloses(to: FocusAt): boolean {
  return to === "outside";
}

/**
 * Whether Escape closes the open popover, and so is marked used. It does
 * from inside the popover, from its anchor, from the map and from the
 * page, but not under a modal dialog it is not in, and not from a text
 * field or a select outside it and its anchor, which keeps its own
 * Escape: a DM typing a journal page in the side panel keeps Escape
 * there, while Escape in the popover's own spell field, or in the field it
 * hangs from, closes it.
 */
export function escapeCloses(input: { textField: boolean; inside: boolean; modalOver: boolean }): boolean {
  if (input.modalOver) return false;
  return input.inside || !input.textField;
}

/**
 * What Tab does inside an open popover. "anchor": Shift+Tab leaves, so
 * the key is used, focus goes to the anchor and the popover closes.
 * "onward": Tab leaves, and the browser moves focus on as Tab from the
 * anchor would, since the popover stands right after its anchor in the
 * page. Null stays inside. In a menu both leave at once. In a dialog,
 * Tab leaves from its last stop and Shift+Tab from its first, or from the
 * box itself (index -1), which a press on its blank part focuses.
 */
export function tabOut(input: { kind: "dialog" | "menu"; shift: boolean; index: number; count: number }): "anchor" | "onward" | null {
  if (input.kind === "menu") return input.shift ? "anchor" : "onward";
  if (input.shift) return input.index <= 0 ? "anchor" : null;
  return input.count === 0 || input.index === input.count - 1 ? "onward" : null;
}

/** Which stop a key open focuses in a dialog popover: its chosen option, else its first control. -1 with none. */
export function openingStop(checked: readonly boolean[]): number {
  const chosen = checked.indexOf(true);
  return chosen !== -1 ? chosen : checked.length > 0 ? 0 : -1;
}

/**
 * Where focus goes when the focused control leaves an open popover (Fog's
 * Discard, a stamp's Done): the next control in the order the popover had
 * before it left, else the one before it, else null for the anchor.
 * Focus never falls to the page.
 */
export function focusAfterLeave<T>(before: readonly T[], left: T, alive: (control: T) => boolean): T | null {
  const at = before.indexOf(left);
  if (at === -1) return null;
  for (let i = at + 1; i < before.length; i++) if (alive(before[i]!)) return before[i]!;
  for (let i = at - 1; i >= 0; i--) if (alive(before[i]!)) return before[i]!;
  return null;
}

/** Konva's own element around the map's canvases (canvas/Stage.tsx). A press there is a press on the map, and the panes over it are chrome. */
const MAP_SURFACE = ".konvajs-content";

export function isMapTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return typeof el?.closest === "function" && el.closest(MAP_SURFACE) != null;
}

/** Where a press lands against the open popover. */
export type PressWhere = "inside" | "anchor" | "map" | "elsewhere";

/**
 * A press on the map that began while a popover was open: the pointers
 * down in it, and whether it still closes the popover when they lift.
 * Null while no such press is under way.
 */
export type MapPress = { readonly pointers: readonly number[]; readonly close: boolean } | null;

export type PressEvent =
  /** `pan` is a mouse press that moves the map whatever the tool: the right or middle button, or the left with Space held. */
  | { readonly type: "down"; readonly pointerId: number; readonly where: PressWhere; readonly open: boolean; readonly pan: boolean }
  | { readonly type: "up" | "cancel"; readonly pointerId: number }
  | { readonly type: "wheel" };

export type PressStep = {
  state: MapPress;
  /** "now" closes the popover as the press starts. "end" closes it as the press ends as one pointer. */
  close: "now" | "end" | null;
  /** The map's tool does nothing with this event. */
  suppress: boolean;
};

/**
 * The map press rule (7.1, 7.4) over pointer events. A press outside the
 * popover and its anchor, on anything but the map, closes it at once and
 * goes on to its target. A press on the map does nothing but close it:
 * the tool does nothing with it from its first event, and the popover
 * closes only once the press ends as one pointer. A second touch before
 * the first lifts makes it a pinch or a two-finger pan, which leaves the
 * popover open for that whole gesture, also after one finger lifts first.
 * A drag that pans the map whatever the tool (pan) and the wheel never
 * close it, and the map handles them as usual. A pointer cancelled by
 * the browser ends the press without closing.
 */
export function pressStep(state: MapPress, e: PressEvent): PressStep {
  if (e.type === "wheel") return { state, close: null, suppress: false };
  if (e.type === "down") {
    if (state !== null) return { state: { pointers: [...state.pointers, e.pointerId], close: false }, close: null, suppress: true };
    if (!e.open || e.where === "inside" || e.where === "anchor") return { state: null, close: null, suppress: false };
    if (e.where === "elsewhere") return { state: null, close: "now", suppress: false };
    if (e.pan) return { state: null, close: null, suppress: false };
    return { state: { pointers: [e.pointerId], close: true }, close: null, suppress: true };
  }
  if (state === null || !state.pointers.includes(e.pointerId)) return { state, close: null, suppress: state !== null };
  const pointers = state.pointers.filter((id) => id !== e.pointerId);
  if (pointers.length > 0) return { state: { pointers, close: state.close }, close: null, suppress: true };
  return { state: null, close: e.type === "up" && state.close ? "end" : null, suppress: true };
}

/** The one open popover as the room's listeners see it. */
export type PopoverEntry = {
  readonly key: string;
  /** Where a press target lands against this popover. */
  where(target: unknown): PressWhere;
  /** Closes it by the focus rule (focusOnClose), then releases it. */
  close(reason: CloseReason): void;
};

/**
 * The room's one open popover (7.1, "One open popover in the room"), and
 * the map press it is closing. Per Room page through the scope, since
 * "view as a player" draws a second room with popovers of its own.
 * Opening any popover closes the one that was open, whichever consumer
 * owns it: More closes a tool popover, and Setup closes More.
 */
export class PopoverRoom {
  #open: PopoverEntry | null = null;
  readonly #listeners = new Set<() => void>();
  #press: MapPress = null;
  /** The last pointer of a suppressed press lifted, and its event is still being dispatched to the map. */
  #ending = false;
  #detach: (() => void) | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  current(): PopoverEntry | null {
    return this.#open;
  }

  /** Makes `entry` the open popover. The one open before closes, with focus left to the new one's opener. */
  open(entry: PopoverEntry): void {
    const before = this.#open;
    this.#open = entry;
    this.#notify();
    if (before && before.key !== entry.key) before.close("replaced");
  }

  /** Clears the open popover if it is still `key`'s. */
  release(key: string): void {
    if (this.#open?.key !== key) return;
    this.#open = null;
    this.#notify();
  }

  /** Runs one pointer event through the map press rule. The caller closes the popover as the step says. */
  press(e: PressEvent): PressStep {
    if (e.type === "down" && this.#press === null) this.#ending = false;
    const step = pressStep(this.#press, e);
    if (this.#press !== null && step.state === null) this.#ending = true;
    this.#press = step.state;
    return step;
  }

  /**
   * Whether the map's tool does nothing with the pointer event it is
   * handling now: from the first down of a press that began on the map
   * with a popover open until its last pointer's event has reached the
   * map (settle), whether or not the popover is still open.
   */
  suppressesTool(): boolean {
    return this.#press !== null || this.#ending;
  }

  /** The last pointer's event of a suppressed press has been dispatched. */
  settle(): void {
    this.#ending = false;
  }

  attached(): boolean {
    return this.#detach !== null;
  }

  /** Keeps the cleanup of the room's window listeners (Popover.tsx), which dispose runs. */
  attach(detach: () => void): void {
    this.#detach?.();
    this.#detach = detach;
  }

  dispose(): void {
    this.#detach?.();
    this.#detach = null;
    this.#press = null;
    this.#ending = false;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

export const popoverSlot = scopeSlot(
  () => new PopoverRoom(),
  (room) => room.dispose(),
);
