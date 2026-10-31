type EscapeKey = Pick<KeyboardEvent, "key" | "defaultPrevented" | "preventDefault">;
type FocusedElement = Pick<Element, "closest">;

/** The focused popover owns Escape before the toast, regardless of listener order. */
export function toastEscape(event: EscapeKey, focused: FocusedElement | null, shrink: () => void): void {
  if (event.key !== "Escape" || event.defaultPrevented || focused?.closest("[data-rvtt-popover]") != null) return;
  event.preventDefault();
  shrink();
}
