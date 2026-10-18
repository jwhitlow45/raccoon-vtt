/*
 * Whether the viewer last used a pointer or keys, kept on `<html>` as
 * `data-rvtt-input="pointer"` or `"keys"` for globals.css's focus rings.
 *
 * The rings draw on `:focus-visible`, which leaves to the browser whether
 * focus came from the keyboard. Chrome judges focus the app moves itself
 * with focus() by the input before it, but iOS Safari draws a ring on most
 * of it after a tap too: the DM guide's heading after a Contents pick, a
 * sheet's opener as the sheet closes. So while a pointer was last, only
 * text fields draw their focus look, and any key press brings the rings
 * back at once, on whatever has focus.
 *
 * A bare modifier is no key press here: Shift or Cmd alone, as before a
 * click or on the way to another app, says nothing about how focus moves.
 * Neither is typing into a text field, which a phone's on-screen keyboard
 * sends as key presses too. Tab and Escape still count there, since they
 * leave the field, as does a key with Ctrl or Cmd, a shortcut.
 */

export type InputModality = "pointer" | "keys";

export const INPUT_ATTR = "data-rvtt-input";

const POINTER_EVENTS = ["pointerdown", "mousedown", "touchstart"] as const;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock", "Symbol", "SymbolLock"]);

/** The input types that take no text, whose focus look follows the rings. */
const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** The parts of an input event this reads, so the rules can be tested without a browser. */
export type InputEventLike = { type: string; key?: string; ctrlKey?: boolean; metaKey?: boolean; target?: unknown };

/** The parts of an element `isTextField` reads. */
type FieldLike = { tagName?: unknown; type?: unknown; isContentEditable?: unknown };

/** Whether `el` takes typed text: a text-like input, a textarea, or an editable element. */
export function isTextField(el: unknown): boolean {
  if (typeof el !== "object" || el === null) return false;
  const f = el as FieldLike;
  if (f.isContentEditable === true) return true;
  const tag = typeof f.tagName === "string" ? f.tagName.toLowerCase() : "";
  if (tag === "textarea") return true;
  return tag === "input" && !NOT_TEXT.has(typeof f.type === "string" ? f.type : "text");
}

/** The modality after `e`, or `now` when the event says nothing new. */
export function modalityAfter(now: InputModality | null, e: InputEventLike): InputModality | null {
  if ((POINTER_EVENTS as readonly string[]).includes(e.type)) return "pointer";
  if (e.type !== "keydown") return now;
  const key = e.key ?? "";
  if (MODIFIERS.has(key)) return now;
  const shortcut = e.ctrlKey === true || e.metaKey === true;
  if (!shortcut && key !== "Tab" && key !== "Escape" && isTextField(e.target)) return now;
  return "keys";
}

/** The parts of `window` and `<html>` the tracker uses. */
export type ModalityHost = {
  addEventListener(type: string, listener: (e: InputEventLike) => void, options: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: InputEventLike) => void, options: AddEventListenerOptions): void;
};
export type ModalityRoot = { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void };

/**
 * Keeps `root`'s attribute current from `host`'s events, once at app start.
 * It listens in the capture phase on the window, so it hears an event
 * before any handler that stops it, and before a key's own handler moves
 * focus, which then draws its ring. Returns a stop for tests.
 */
export function trackInputModality(host: ModalityHost, root: ModalityRoot): () => void {
  const options: AddEventListenerOptions = { capture: true, passive: true };
  const onInput = (e: InputEventLike) => {
    const now = root.getAttribute(INPUT_ATTR);
    const next = modalityAfter(now === "pointer" || now === "keys" ? now : null, e);
    if (next !== null && next !== now) root.setAttribute(INPUT_ATTR, next);
  };
  const types = [...POINTER_EVENTS, "keydown"];
  for (const type of types) host.addEventListener(type, onInput, options);
  return () => {
    for (const type of types) host.removeEventListener(type, onInput, options);
  };
}

/** Starts tracking for the page. A phone or tablet starts as a pointer, so focus the app moves before the first tap draws no ring either. */
export function startInputModality(): void {
  const root = document.documentElement;
  if (window.matchMedia?.("(pointer: coarse)").matches) root.setAttribute(INPUT_ATTR, "pointer");
  trackInputModality(window, root);
}

/**
 * Whether focus on a control came from the keyboard, for a look that, like
 * the ring, shows only then (a tooltip, the sheet's Expand sheet button):
 * never while a pointer was last, else as the browser judges
 * `:focus-visible`.
 */
export function keyboardFocus(el: Element): boolean {
  if (el.ownerDocument.documentElement.getAttribute(INPUT_ATTR) === "pointer") return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    // A browser without the selector: every focus counts, as before it existed.
    return true;
  }
}
