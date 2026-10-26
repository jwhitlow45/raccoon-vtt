/*
 * Which focus opens the on-screen keyboard, apart from the keyboard's
 * place (lib/keyboardInset.ts), so the layout's size (features/device/
 * layout.ts) can ask without importing what places surfaces.
 */

/** The parts of an element that say whether focus on it opens the on-screen keyboard. */
export type FocusTarget = { tagName: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean; inputMode?: string };

/** The input types that type text. Buttons, boxes, sliders and pickers open no keyboard. */
const TYPED = new Set(["", "text", "search", "number", "email", "tel", "url", "password"]);

/** Whether focus on `el` opens the on-screen keyboard: a text field, a text area, or editable text. */
export function opensKeyboard(el: FocusTarget | null): boolean {
  if (!el || el.inputMode === "none") return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return el.readOnly !== true && el.disabled !== true;
  if (tag !== "input") return false;
  return TYPED.has((el.type ?? "").toLowerCase()) && el.readOnly !== true && el.disabled !== true;
}

/** Whether the page's focus is in a field that opens the on-screen keyboard now. */
export function typingNow(): boolean {
  return typeof document !== "undefined" && opensKeyboard(document.activeElement as FocusTarget | null);
}
