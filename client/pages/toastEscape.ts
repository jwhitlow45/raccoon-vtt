import { popoverTakesEscape } from "../components/Popover.tsx";

type EscapeKey = Pick<KeyboardEvent, "key" | "defaultPrevented" | "preventDefault">;

/** A popover that will consume Escape owns it before the toast, regardless of listener order. */
export function toastEscape(event: EscapeKey, target: unknown, shrink: () => void): void {
  if (event.key !== "Escape" || event.defaultPrevented || popoverTakesEscape(target)) return;
  event.preventDefault();
  shrink();
}

/** Capture runs before the room's Escape listener, while the shared predicate preserves popover ownership. */
export function listenToastEscape(shrink: () => void): () => void {
  const onKey = (event: KeyboardEvent) => toastEscape(event, event.target, shrink);
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
