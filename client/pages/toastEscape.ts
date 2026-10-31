import { popoverTakesEscape } from "../components/Popover.tsx";

type EscapeKey = Pick<KeyboardEvent, "key" | "defaultPrevented" | "preventDefault">;

/** A popover that will consume Escape owns it before the toast, regardless of listener order. */
export function toastEscape(event: EscapeKey, target: unknown, shrink: () => void): void {
  if (event.key !== "Escape" || event.defaultPrevented || popoverTakesEscape(target)) return;
  event.preventDefault();
  shrink();
}
