import { useSyncExternalStore } from "react";

/*
 * The page's own full screen (the Fullscreen API), for the Room page and
 * the table display. It is always the whole page, the document's root:
 * sheets, dialogs, toasts and tooltips are portaled to the body or the top
 * layer, and a smaller element in full screen would leave them behind it.
 *
 * Older Safari on iPad and Mac (before 16.4) has only the webkit forms.
 * iPhone Safari has neither for a page, so `fullscreenSupported` is false
 * there and no control for it shows.
 *
 * On a Mac, Chrome and Safari move a window in full screen to a Space of
 * its own, as the green button does. Firefox does too or not by its own
 * setting. The page asks for nothing different on any system.
 *
 * Escape: a browser leaves full screen on Escape, which the room also
 * uses to close what is open. Where Keyboard Lock exists (Chrome and
 * Edge), Escape is locked while the page is in full screen, so it keeps
 * closing things in the app, and holding it leaves full screen, as the
 * browser's own notice says. Elsewhere Escape leaves full screen first,
 * which is the browser's rule and no page can change.
 *
 * A request can be refused, or come without a user gesture. Then the state
 * stays off and nothing shows broken.
 */

/** The parts of `document` this reads, so the rules can be tested without a browser. */
export type FullscreenDocument = {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  documentElement: {
    requestFullscreen?: (options?: { navigationUI?: "auto" | "hide" | "show" }) => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** `navigator.keyboard` in Chrome and Edge: Keyboard Lock, which the DOM's types do not have. */
export type KeyboardLock = {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
};

const CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

function browserDocument(): FullscreenDocument | null {
  return typeof document === "undefined" ? null : (document as unknown as FullscreenDocument);
}

function browserKeyboard(): KeyboardLock | null {
  return typeof navigator === "undefined" ? null : ((navigator as unknown as { keyboard?: KeyboardLock }).keyboard ?? null);
}

/** The standard form, which a browser with both forms takes. */
function standard(doc: FullscreenDocument): boolean {
  return doc.fullscreenEnabled === true && typeof doc.documentElement.requestFullscreen === "function";
}

/** Whether this page can go full screen here: false on iPhone Safari, and in a frame that does not allow it. */
export function fullscreenSupported(doc: FullscreenDocument | null = browserDocument()): boolean {
  if (!doc) return false;
  return standard(doc) || (doc.webkitFullscreenEnabled === true && typeof doc.documentElement.webkitRequestFullscreen === "function");
}

/**
 * Whether the page is in its own full screen. The browser's own full
 * screen (F11, or the green button on a Mac) is not this, and leaves it
 * false: the page cannot leave that one, so a "Leave full screen" there
 * would do nothing.
 */
export function isFullscreen(doc: FullscreenDocument | null = browserDocument()): boolean {
  if (!doc) return false;
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
}

/** The documents whose changes lock and unlock Escape already. */
const followed = new WeakSet<FullscreenDocument>();

/** Escape is locked while the page is in full screen, and let go when it leaves, by whatever way it leaves. */
function followForEscape(doc: FullscreenDocument, keyboard: KeyboardLock | null): void {
  if (!keyboard?.lock || followed.has(doc)) return;
  followed.add(doc);
  // A browser may fire both forms' events for one change.
  let locked = false;
  const onChange = () => {
    const full = isFullscreen(doc);
    if (full === locked) return;
    locked = full;
    if (full) void keyboard.lock?.(["Escape"]).catch(() => {});
    else keyboard.unlock?.();
  };
  for (const type of CHANGE_EVENTS) doc.addEventListener(type, onChange);
}

/** Asks for the whole page in full screen. True when the page is in full screen afterwards, or will be, with the webkit form. */
export async function enterFullscreen(doc: FullscreenDocument | null = browserDocument(), keyboard: KeyboardLock | null = browserKeyboard()): Promise<boolean> {
  if (!doc || !fullscreenSupported(doc)) return false;
  if (isFullscreen(doc)) return true;
  followForEscape(doc, keyboard);
  try {
    // `hide` asks a phone's browser to drop its own bars too.
    if (standard(doc)) await doc.documentElement.requestFullscreen!({ navigationUI: "hide" });
    else doc.documentElement.webkitRequestFullscreen!();
    return true;
  } catch {
    return false;
  }
}

/** Leaves the page's full screen. Nothing happens when it is not in one. */
export async function exitFullscreen(doc: FullscreenDocument | null = browserDocument()): Promise<void> {
  if (!doc || !isFullscreen(doc)) return;
  try {
    if ((doc.fullscreenElement ?? null) !== null && typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } catch {
    // Already left, by Escape or the browser, in the meantime.
  }
}

/** Enters full screen when the page is not in it, and leaves it when it is. */
export function toggleFullscreen(doc: FullscreenDocument | null = browserDocument(), keyboard: KeyboardLock | null = browserKeyboard()): Promise<void> {
  return isFullscreen(doc) ? exitFullscreen(doc) : enterFullscreen(doc, keyboard).then(() => {});
}

/** Calls `listener` on each change of full screen, in both forms. Returns the unsubscribe. */
export function subscribeFullscreen(listener: () => void, doc: FullscreenDocument | null = browserDocument()): () => void {
  if (!doc) return () => {};
  for (const type of CHANGE_EVENTS) doc.addEventListener(type, listener);
  return () => {
    for (const type of CHANGE_EVENTS) doc.removeEventListener(type, listener);
  };
}

const subscribe = (listener: () => void) => subscribeFullscreen(listener);
const snapshot = () => isFullscreen();
const serverSnapshot = () => false;

/** Whether the page is in its own full screen, following every change, Escape and the browser's own controls included. */
export function useFullscreen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
